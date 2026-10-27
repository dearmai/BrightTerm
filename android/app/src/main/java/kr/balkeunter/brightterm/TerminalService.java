package kr.balkeunter.brightterm;

import android.app.*;
import android.content.Intent;
import android.net.Uri;
import android.os.*;
import android.util.Base64;
import com.jcraft.jsch.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

/** Owns sockets independently of the Activity so window resize/display changes preserve sessions. */
public class TerminalService extends Service {
    interface Listener { void event(JSONObject event); boolean trust(String host, String fingerprint); String chooseTmux(String host, List<String> names, java.util.function.BooleanSupplier alive); }
    volatile Listener listener;
    final ExecutorService workers = Executors.newCachedThreadPool();
    private final Map<String, Connection> connections = new ConcurrentHashMap<>();
    private final Object trustLock = new Object();
    private final IBinder binder = new LocalBinder();
    class LocalBinder extends Binder { TerminalService service() { return TerminalService.this; } }
    static class Connection {
        String id, name, state = "connecting";
        volatile Session session;
        volatile ChannelShell shell;
        volatile OutputStream input;
        volatile boolean closed;
        final ExecutorService writes = Executors.newSingleThreadExecutor();
        int cols = 80, rows = 24;
        final ByteArrayOutputStream history = new ByteArrayOutputStream();
        synchronized void remember(byte[] bytes) {
            if (history.size() + bytes.length > 512 * 1024) {
                byte[] old = history.toByteArray(); history.reset();
                int keep = Math.min(old.length, 256 * 1024);
                history.write(old, old.length - keep, keep);
            }
            history.write(bytes, 0, bytes.length);
        }
        synchronized String replay() { return Base64.encodeToString(history.toByteArray(), Base64.NO_WRAP); }
        void close() { closed = true; writes.shutdownNow(); if (shell != null) shell.disconnect(); if (session != null) session.disconnect(); }
    }
    @Override public void onCreate() {
        super.onCreate();
        ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(
            new NotificationChannel("sessions", "SSH 연결", NotificationManager.IMPORTANCE_LOW));
    }
    @Override public IBinder onBind(Intent intent) { return binder; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "disconnect".equals(intent.getAction())) {
            for (Connection c : connections.values()) c.close(); connections.clear();
            emit("reset", "", ""); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return START_NOT_STICKY;
        }
        updateNotification(); return START_NOT_STICKY;
    }
    private void updateNotification() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, TerminalService.class).setAction("disconnect"), PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, "sessions").setSmallIcon(kr.balkeunter.brightterm.R.drawable.ic_terminal)
            .setContentTitle("BrightTerm").setContentText("SSH 세션 유지 중 · " + connections.size() + "개")
            .setContentIntent(content).setOngoing(true).addAction(new Notification.Action.Builder(null, "모두 연결 끊기", stop).build()).build();
        startForeground(1, notification);
    }
    synchronized void emit(String type, String id, String value) {
        try { Listener l = listener; if (l != null) l.event(new JSONObject().put("type", type).put("id", id).put("value", value)); }
        catch (JSONException ignored) { }
    }
    synchronized void attach(Listener l) {
        listener = l;
        for (Connection c : connections.values()) {
            emit("session", c.id, c.name); emit("data", c.id, c.replay()); emit("state", c.id, c.state);
        }
    }
    void connect(JSONObject profile, int cols, int rows) {
        Connection c = new Connection(); c.id = UUID.randomUUID().toString();
        c.name = profile.optString("name", profile.optString("host")); c.cols = cols; c.rows = rows;
        connections.put(c.id, c); emit("session", c.id, c.name); emit("state", c.id, c.state); updateNotification();
        workers.execute(() -> {
            try {
                JSch jsch = new JSch();
                File known = new File(getFilesDir(), "known_hosts");
                synchronized (trustLock) { if (!known.exists() && !known.createNewFile()) throw new IOException("호스트 키 파일 생성 실패"); jsch.setKnownHosts(known.getAbsolutePath()); }
                String privateKey = profile.optString("privateKey");
                if (!privateKey.isEmpty()) jsch.addIdentity(c.name, privateKey.getBytes(StandardCharsets.UTF_8), null, profile.optString("passphrase").getBytes(StandardCharsets.UTF_8));
                // Verify against persistent known_hosts; changed keys are always rejected.
                HostKeyRepository repository = jsch.getHostKeyRepository();
                jsch.setHostKeyRepository(new HostKeyRepository() {
                    @Override public int check(String host, byte[] key) {
                        synchronized (trustLock) {
                            int result = repository.check(host, key);
                            if (result != NOT_INCLUDED) return result;
                            try {
                                String fingerprint = "SHA256:" + Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(key), Base64.NO_WRAP | Base64.NO_PADDING);
                                Listener l = listener;
                                if (l == null || !l.trust(host, fingerprint) || c.closed) return NOT_INCLUDED;
                                repository.add(new HostKey(host, key), null); return OK;
                            } catch (Exception error) { return NOT_INCLUDED; }
                        }
                    }
                    @Override public void add(HostKey key, UserInfo ui) { synchronized (trustLock) { repository.add(key, ui); } }
                    @Override public void remove(String host, String type) { }
                    @Override public void remove(String host, String type, byte[] key) { }
                    @Override public String getKnownHostsRepositoryID() { return repository.getKnownHostsRepositoryID(); }
                    @Override public HostKey[] getHostKey() { return repository.getHostKey(); }
                    @Override public HostKey[] getHostKey(String host, String type) { return repository.getHostKey(host, type); }
                });
                c.session = jsch.getSession(profile.getString("username"), profile.getString("host"), profile.optInt("port", 22));
                c.session.setConfig("StrictHostKeyChecking", "yes");
                c.session.setConfig("PreferredAuthentications", "publickey,password,keyboard-interactive");
                String password = profile.optString("password"); c.session.setPassword(password);
                c.session.setUserInfo(new PasswordInfo(password));
                c.session.setServerAliveInterval(15000); c.session.setServerAliveCountMax(3);
                if (c.closed) return;
                c.session.connect(25000);
                if (c.closed) return;
                String command;
                if (profile.optBoolean("persist", false)) {
                    List<String> names = tmuxSessions(c);
                    Listener l = listener;
                    String choice = l == null ? null : l.chooseTmux(c.name, names, () -> !c.closed);
                    if (choice == null || c.closed) return;
                    if (choice.equals("\0")) command = profile.optString("command", "").trim();
                    else {
                        String name = choice.isEmpty() ? Tmux.name(profile) : choice;
                        if (choice.isEmpty() && names.contains(name)) name += "-" + UUID.randomUUID().toString().substring(0, 8);
                        command = Tmux.startup(profile, name);
                    }
                } else command = Tmux.startup(profile);
                if (c.closed) return;
                c.shell = (ChannelShell)c.session.openChannel("shell");
                c.shell.setPtyType("xterm-256color", c.cols, c.rows, 0, 0);
                InputStream output = c.shell.getInputStream(); c.input = c.shell.getOutputStream(); c.shell.connect(15000);
                c.state = "connected"; emit("state", c.id, c.state);
                if (!command.trim().isEmpty()) { c.input.write((command + "\r").getBytes(StandardCharsets.UTF_8)); c.input.flush(); }
                byte[] buffer = new byte[16384]; int count;
                while (!c.closed && (count = output.read(buffer)) != -1) {
                    byte[] bytes = Arrays.copyOf(buffer, count);
                    synchronized (TerminalService.this) {
                        c.remember(bytes); emit("data", c.id, Base64.encodeToString(bytes, Base64.NO_WRAP));
                    }
                }
            } catch (Exception error) {
                if (!c.closed) emit("error", c.id, error.getMessage() == null ? "SSH 연결 실패" : error.getMessage());
            } finally { c.close(); c.state = "disconnected"; emit("state", c.id, c.state); }
        });
    }
    private List<String> tmuxSessions(Connection c) throws Exception {
        ChannelExec channel = (ChannelExec)c.session.openChannel("exec");
        try {
            channel.setCommand("if command -v tmux >/dev/null 2>&1; then tmux list-sessions -F '#S' 2>/dev/null; fi");
            InputStream output = channel.getInputStream();
            channel.connect(10000);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (!c.closed) {
                while (output.available() > 0) {
                    bytes.write(output.read());
                    if (bytes.size() > 65536) throw new IOException("tmux 세션 목록이 너무 큽니다.");
                }
                if (channel.isClosed() && output.available() == 0) break;
                if (System.nanoTime() > deadline) throw new IOException("tmux 세션 조회 시간 초과");
                Thread.sleep(25);
            }
            List<String> names = new ArrayList<>();
            for (String name : bytes.toString("UTF-8").split("\n"))
                if (!name.isEmpty() && !names.contains(name)) names.add(name);
            return names;
        } finally { channel.disconnect(); }
    }
    private static class PasswordInfo implements UserInfo, UIKeyboardInteractive {
        private final String password;
        PasswordInfo(String password) { this.password = password; }
        public String getPassword() { return password; }
        public String getPassphrase() { return null; }
        public boolean promptPassword(String message) { return !password.isEmpty(); }
        public boolean promptPassphrase(String message) { return false; }
        public boolean promptYesNo(String message) { return false; }
        public void showMessage(String message) { }
        public String[] promptKeyboardInteractive(String destination, String name, String instruction, String[] prompts, boolean[] echo) {
            // Only a single password prompt; never guess OTP/challenge answers.
            return prompts.length == 1 && prompts[0].toLowerCase(Locale.ROOT).contains("password") ? new String[]{password} : null;
        }
    }
    void input(String id, String data) {
        Connection c = connections.get(id); if (c == null || c.closed) return;
        try {
            c.writes.execute(() -> { try { if (c.input != null) { c.input.write(data.getBytes(StandardCharsets.UTF_8)); c.input.flush(); } } catch (IOException error) { emit("error", id, "입력 전송 실패"); } });
        } catch (RejectedExecutionException ignored) { /* Session closed between lookup and enqueue. */ }
    }
    void resize(String id, int cols, int rows) {
        Connection c = connections.get(id); if (c == null) return;
        c.cols = Math.max(2, Math.min(cols, 500)); c.rows = Math.max(1, Math.min(rows, 300));
        workers.execute(() -> { if (c.shell != null && c.shell.isConnected()) c.shell.setPtySize(c.cols, c.rows, 0, 0); });
    }
    void disconnect(String id) {
        Connection c = connections.remove(id); if (c != null) c.close();
        if (connections.isEmpty()) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); } else updateNotification();
    }
    private ChannelSftp sftp(String id) throws Exception {
        Connection c = connections.get(id);
        if (c == null || c.closed || c.session == null || !c.session.isConnected()) throw new IOException("SSH 서버에 먼저 연결하세요.");
        ChannelSftp sftp = (ChannelSftp)c.session.openChannel("sftp");
        try { sftp.connect(15000); return sftp; }
        catch (Exception error) { sftp.disconnect(); throw error; }
    }
    void list(String id, String path) {
        workers.execute(() -> {
            ChannelSftp sftp = null;
            try {
                sftp = sftp(id); String resolved = sftp.realpath(path);
                JSONArray entries = new JSONArray();
                for (ChannelSftp.LsEntry entry : sftp.ls(resolved)) {
                    if (entry.getFilename().equals(".")) continue;
                    entries.put(new JSONObject().put("name", entry.getFilename()).put("directory", entry.getAttrs().isDir()).put("size", entry.getAttrs().getSize()));
                    if (entries.length() >= 2000) break;
                }
                emit("files", id, new JSONObject().put("path", resolved).put("entries", entries).toString());
            } catch (Exception error) { emit("error", id, "SFTP: " + error.getMessage()); }
            finally { if (sftp != null) sftp.disconnect(); }
        });
    }
    void transfer(String id, String path, Uri local, boolean upload) {
        workers.execute(() -> {
            ChannelSftp sftp = null;
            emit("transfer", id, upload ? "업로드 중…" : "다운로드 중…");
            try {
                sftp = sftp(id);
                if (upload) {
                    try (InputStream input = getContentResolver().openInputStream(local)) {
                        if (input == null) throw new IOException("파일을 열 수 없습니다.");
                        sftp.put(input, path, ChannelSftp.OVERWRITE);
                    }
                } else {
                    try (OutputStream output = getContentResolver().openOutputStream(local, "wt")) {
                        if (output == null) throw new IOException("파일을 저장할 수 없습니다.");
                        sftp.get(path, output);
                    }
                }
                emit("transfer", id, "전송 완료: " + path);
            } catch (Exception error) { emit("error", id, "SFTP 전송 실패 (일부 파일이 남을 수 있음): " + error.getMessage()); }
            finally { if (sftp != null) sftp.disconnect(); }
        });
    }
    @Override public void onDestroy() {
        listener = null; for (Connection c : connections.values()) c.close(); workers.shutdownNow(); super.onDestroy();
    }
}
