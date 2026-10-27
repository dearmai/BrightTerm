package kr.balkeunter.brightterm;

import android.content.Context;
import com.jcraft.jsch.*;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.*;
import org.eclipse.jgit.revwalk.RevWalk;
import org.eclipse.jgit.storage.file.FileRepositoryBuilder;
import org.eclipse.jgit.transport.*;
import org.eclipse.jgit.treewalk.TreeWalk;
import org.eclipse.jgit.dircache.*;
import org.eclipse.jgit.util.FS;
import org.json.JSONObject;
import java.io.*;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** Git plumbing only: no checkout, shell executable, hooks or force push. */
final class GitRepository implements AutoCloseable {
    static final String FILE = "brightterm.vault.json";
    static final int MAX_BYTES = 16 * 1024 * 1024;
    interface Trust { boolean ask(String host, String fingerprint); }
    final Repository repository;
    private final JSONObject config;
    private final org.eclipse.jgit.api.TransportConfigCallback transportConfig;
    static class Remote { ObjectId head; JSONObject envelope; String hash; }
    static void validate(JSONObject config) throws Exception {
        URIish uri = new URIish(config.getString("remote").trim());
        if (!List.of("https", "ssh").contains(uri.getScheme()) && !(uri.getScheme() == null && uri.getHost() != null && uri.getUser() != null))
            throw new IllegalArgumentException("HTTPS 또는 SSH Git 주소를 사용하세요.");
        if (uri.getHost() == null || uri.getHost().isEmpty() || uri.getPath() == null || uri.getPath().isEmpty() || uri.getPass() != null || ("https".equals(uri.getScheme()) && uri.getUser() != null))
            throw new IllegalArgumentException("Git 주소에 비밀번호나 토큰을 넣지 마세요.");
        if (config.getString("remote").matches("(?s).*[\\r\\n\\u0000].*")) throw new IllegalArgumentException("잘못된 Git 주소입니다.");
        if (!Repository.isValidRefName("refs/heads/" + config.optString("branch", "main"))) throw new IllegalArgumentException("올바른 브랜치 이름을 입력하세요.");
    }
    GitRepository(Context context, JSONObject config, Trust trust) throws Exception {
        validate(config); this.config = config;
        File root = new File(context.getFilesDir(), "git-sync");
        File home = new File(root, "home"); if (!home.isDirectory() && !home.mkdirs()) throw new IOException("Git 폴더 생성 실패");
        String repoId = SyncCrypto.digest(new JSONObject().put("remote", config.getString("remote")).put("branch", config.optString("branch", "main")));
        repository = new FileRepositoryBuilder().setGitDir(new File(root, repoId)).setBare().setFS(FS.DETECTED.newInstance().setUserHome(home)).build();
        if (!repository.getObjectDatabase().exists()) repository.create(true);
        transportConfig = transport -> {
            transport.setTimeout(30);
            if (transport instanceof SshTransport) ((SshTransport)transport).setSshSessionFactory(new SshSessionFactory() {
                @Override public String getType() { return "jsch"; }
                @Override public RemoteSession getSession(URIish uri, CredentialsProvider credentials, FS fs, int timeout) throws org.eclipse.jgit.errors.TransportException {
                    try { return ssh(context, config, uri, trust); }
                    catch (Exception error) { throw new org.eclipse.jgit.errors.TransportException(uri, "Git SSH 인증 또는 호스트 키 확인 실패", error); }
                }
            });
        };
    }
    private org.eclipse.jgit.transport.CredentialsProvider credentials() {
        return new UsernamePasswordCredentialsProvider(config.optString("username", "git"), config.optString("token", ""));
    }
    Remote fetch() throws Exception {
        Remote remote = new Remote(); String branch = "refs/heads/" + config.optString("branch", "main");
        try (Git git = new Git(repository)) {
            Collection<Ref> refs = git.lsRemote().setRemote(config.getString("remote")).setHeads(true).setCredentialsProvider(credentials()).setTransportConfigCallback(transportConfig).call();
            if (refs.stream().noneMatch(ref -> branch.equals(ref.getName()))) return remote;
            git.fetch().setRemote(config.getString("remote")).setRefSpecs(new RefSpec("+" + branch + ":refs/remotes/sync/current"))
                .setTagOpt(TagOpt.NO_TAGS).setCredentialsProvider(credentials()).setTransportConfigCallback(transportConfig).call();
            remote.head = repository.resolve("refs/remotes/sync/current");
        }
        try (RevWalk walk = new RevWalk(repository); TreeWalk tree = TreeWalk.forPath(repository, FILE, walk.parseCommit(remote.head).getTree())) {
            if (tree == null) return remote;
            if (!FileMode.REGULAR_FILE.equals(tree.getFileMode(0))) throw new IOException("동기화 파일은 일반 JSON 파일이어야 합니다.");
            byte[] bytes = repository.open(tree.getObjectId(0)).getBytes(MAX_BYTES);
            remote.envelope = new JSONObject(new String(bytes, StandardCharsets.UTF_8)); SyncCrypto.validateEnvelope(remote.envelope);
            remote.hash = SyncCrypto.digest(remote.envelope); return remote;
        }
    }
    void push(Remote remote, JSONObject envelope) throws Exception {
        byte[] data = (envelope.toString(2) + "\n").getBytes(StandardCharsets.UTF_8);
        if (data.length > MAX_BYTES) throw new IOException("동기화 데이터가 16MB를 넘습니다.");
        ObjectId commitId;
        try (ObjectInserter inserter = repository.newObjectInserter(); RevWalk walk = new RevWalk(repository)) {
            DirCache index = DirCache.newInCore(); DirCacheBuilder builder = index.builder(); List<DirCacheEntry> entries = new ArrayList<>();
            if (remote.head != null) {
                try (TreeWalk tree = new TreeWalk(repository)) {
                    tree.addTree(walk.parseCommit(remote.head).getTree()); tree.setRecursive(true);
                    while (tree.next()) {
                        if (FILE.equals(tree.getPathString())) continue;
                        DirCacheEntry entry = new DirCacheEntry(tree.getRawPath()); entry.setFileMode(tree.getFileMode(0)); entry.setObjectId(tree.getObjectId(0)); entries.add(entry);
                    }
                }
            }
            DirCacheEntry synced = new DirCacheEntry(FILE); synced.setFileMode(FileMode.REGULAR_FILE); synced.setObjectId(inserter.insert(Constants.OBJ_BLOB, data)); entries.add(synced);
            entries.sort((a,b) -> compare(a.getRawPath(), b.getRawPath()));
            for (DirCacheEntry entry : entries) builder.add(entry); builder.finish();
            CommitBuilder commit = new CommitBuilder(); commit.setTreeId(index.writeTree(inserter));
            if (remote.head != null) commit.setParentId(remote.head);
            PersonIdent author = new PersonIdent("BrightTerm", "sync@brightterm.local"); commit.setAuthor(author); commit.setCommitter(author); commit.setMessage("Sync encrypted BrightTerm vault and connections\n");
            commitId = inserter.insert(commit); inserter.flush();
        }
        RefUpdate update = repository.updateRef("refs/heads/outgoing"); update.setNewObjectId(commitId); update.setForceUpdate(true); update.update();
        try (Git git = new Git(repository)) {
            Iterable<PushResult> results = git.push().setRemote(config.getString("remote")).setRefSpecs(new RefSpec("refs/heads/outgoing:refs/heads/" + config.optString("branch", "main")))
                .setCredentialsProvider(credentials()).setTransportConfigCallback(transportConfig).call();
            for (PushResult result : results) for (RemoteRefUpdate ref : result.getRemoteUpdates())
                if (ref.getStatus() != RemoteRefUpdate.Status.OK && ref.getStatus() != RemoteRefUpdate.Status.UP_TO_DATE)
                    throw new IOException("원격 브랜치가 바뀌었거나 푸시 권한이 없습니다. 다시 동기화하여 충돌을 확인하세요.");
        }
    }
    private static int compare(byte[] a, byte[] b) { for (int i=0; i<Math.min(a.length,b.length); i++) { int diff=(a[i]&255)-(b[i]&255); if(diff!=0)return diff; } return a.length-b.length; }
    private static RemoteSession ssh(Context context, JSONObject config, URIish uri, Trust trust) throws Exception {
        JSch jsch = new JSch(); File known = new File(context.getFilesDir(), "git_known_hosts");
        synchronized (GitRepository.class) { if (!known.exists() && !known.createNewFile()) throw new IOException("Git 호스트 키 파일 생성 실패"); jsch.setKnownHosts(known.getAbsolutePath()); }
        String privateKey = config.optString("privateKey", "");
        if (!privateKey.isEmpty()) jsch.addIdentity("git-sync", privateKey.getBytes(StandardCharsets.UTF_8), null, config.optString("passphrase", "").getBytes(StandardCharsets.UTF_8));
        HostKeyRepository keys = jsch.getHostKeyRepository();
        jsch.setHostKeyRepository(new HostKeyRepository() {
            public int check(String host, byte[] key) {
                synchronized (GitRepository.class) {
                    int result = keys.check(host, key); if (result != NOT_INCLUDED) return result;
                    try {
                        String fingerprint = "SHA256:" + android.util.Base64.encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(key), android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
                        if (!trust.ask(host, fingerprint)) return NOT_INCLUDED;
                        keys.add(new HostKey(host,key), null); return OK;
                    } catch(Exception error) { return NOT_INCLUDED; }
                }
            }
            public void add(HostKey key, UserInfo info) { keys.add(key,info); }
            public void remove(String host,String type) { }
            public void remove(String host,String type,byte[] key) { }
            public String getKnownHostsRepositoryID() { return keys.getKnownHostsRepositoryID(); }
            public HostKey[] getHostKey() { return keys.getHostKey(); }
            public HostKey[] getHostKey(String host,String type) { return keys.getHostKey(host,type); }
        });
        String username = uri.getUser() == null ? config.optString("username", "git") : uri.getUser();
        Session session = jsch.getSession(username, uri.getHost(), uri.getPort() <= 0 ? 22 : uri.getPort());
        session.setConfig("StrictHostKeyChecking", "yes"); session.setConfig("PreferredAuthentications", "publickey,password");
        session.setPassword(config.optString("token", "")); session.setServerAliveInterval(15000);
        try { session.connect(30000); } catch(Exception error) {session.disconnect();throw error;}
        return new RemoteSession() {
            public Process exec(String command, int timeout) throws IOException {
                try {
                    ChannelExec channel = (ChannelExec)session.openChannel("exec"); channel.setCommand(command);
                    InputStream out = channel.getInputStream(), err = channel.getErrStream(); OutputStream in = channel.getOutputStream(); channel.connect(30000);
                    return new Process() {
                        public OutputStream getOutputStream() { return in; }
                        public InputStream getInputStream() { return out; }
                        public InputStream getErrorStream() { return err; }
                        public int waitFor() throws InterruptedException { while(!channel.isClosed()) Thread.sleep(20); return channel.getExitStatus(); }
                        public int exitValue() { if(!channel.isClosed())throw new IllegalThreadStateException();return channel.getExitStatus(); }
                        public void destroy() { channel.disconnect(); }
                    };
                } catch (Exception error) { throw new IOException("Git SSH 명령 실패", error); }
            }
            public void disconnect() { session.disconnect(); }
        };
    }
    public void close() { repository.close(); }
}
