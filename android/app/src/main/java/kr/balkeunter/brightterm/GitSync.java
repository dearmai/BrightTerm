package kr.balkeunter.brightterm;

import android.content.Context;
import org.json.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** One serialized network worker; all local apply/tracking changes commit in one encrypted file. */
final class GitSync {
    interface Listener { void changed(JSONObject status, boolean profilesChanged); boolean trust(String host, String fingerprint); }
    private final Context context;
    private final Vault vault;
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private volatile Listener listener;
    private volatile boolean foreground;
    private ScheduledFuture<?> pending;
    private volatile JSONObject status = new JSONObject();
    private String conflictLocal, conflictRemote;
    GitSync(Context context, Vault vault) {
        this.context = context; this.vault = vault;
        try {
            synchronized (vault) {
                JSONObject stored = vault.readState(), sync = sync(stored);
                if (!sync.has("config") && !BuildConfig.DEFAULT_GIT_REMOTE.isEmpty()) {
                    JSONObject preset = new JSONObject().put("enabled", false).put("remote", BuildConfig.DEFAULT_GIT_REMOTE)
                        .put("branch", "main").put("username", BuildConfig.DEFAULT_GIT_USERNAME);
                    GitRepository.validate(preset); sync.put("config", preset); vault.writeState(stored);
                }
            }
        } catch (Exception error) { update("error", "기본 Git 설정을 읽을 수 없습니다. 기존 데이터는 보존했습니다.", false); }
        vault.onChange = () -> schedule(1000);
        update("idle", "Git 동기화 설정을 확인하세요.", false);
    }
    void attach(Listener listener) { this.listener = listener; worker.execute(() -> updateCurrent(false)); }
    void detach(Listener listener) { if (this.listener == listener) this.listener = null; }
    void foreground(boolean active) { foreground = active; if (active) schedule(0); else cancelPending(); }
    synchronized void cancelPending() { if (pending != null) { pending.cancel(false); pending = null; } }
    synchronized void schedule(long delay) {
        if (!foreground) return;
        cancelPending(); pending = worker.schedule(() -> run(null, ""), delay, TimeUnit.MILLISECONDS);
    }
    void request(String choice, String password) { cancelPending(); worker.execute(() -> run(choice == null || choice.isEmpty() ? null : choice, password)); }
    void restoreBackup() {
        cancelPending(); worker.execute(() -> {
            try { vault.restoreBackup(context); conflictLocal = conflictRemote = null; update("disabled", "이전 로컬 데이터를 복원했습니다. 자동 동기화는 껐습니다.", true); }
            catch (Exception error) { update("error", "암호화된 백업을 복원할 수 없습니다. 현재 데이터는 보존했습니다.", false); }
        });
    }
    void configure(String encoded) { configure(encoded, null); }
    void configure(String encoded, java.util.function.Consumer<Boolean> completed) {
        worker.execute(() -> {
            boolean success = false;
            try {
                JSONObject requested = new JSONObject(encoded);
                synchronized (vault) {
                    JSONObject state = vault.readState(), sync = sync(state), old = sync.optJSONObject("config");
                    JSONObject config = new JSONObject().put("enabled", requested.optBoolean("enabled"))
                        .put("remote", requested.optString("remote", "").trim()).put("branch", requested.optString("branch", "main").trim())
                        .put("username", requested.optString("username", "git").trim());
                    if (config.getString("branch").isEmpty()) config.put("branch", "main");
                    for (String name : new String[]{"token", "privateKey", "passphrase"}) {
                        String value = requested.optString(name, "");
                        if (value.isEmpty() && old != null && old.optString("remote").equals(config.getString("remote")) && !requested.optBoolean("clearCredentials")) value = old.optString(name, "");
                        config.put(name, value);
                    }
                    if (config.getBoolean("enabled") || !config.getString("remote").isEmpty()) GitRepository.validate(config);
                    if (old == null || !old.optString("remote").equals(config.getString("remote")) || !old.optString("branch").equals(config.getString("branch"))) {
                        sync.remove("localDigest"); sync.remove("remoteDigest"); sync.remove("lastSync");
                    }
                    sync.put("config", config); state.put("sync", sync); vault.writeState(state);
                }
                conflictLocal = conflictRemote = null; success = true;
                update("idle", "설정을 저장했습니다.", false); schedule(0);
            } catch (Exception error) { update("error", error instanceof IllegalArgumentException ? error.getMessage() : "동기화 설정을 저장할 수 없습니다. 주소와 입력값을 확인하세요.", false); }
            finally { if (completed != null) completed.accept(success); }
        });
    }
    private JSONObject sync(JSONObject state) throws Exception {
        JSONObject sync = state.optJSONObject("sync");
        if (sync == null) { sync = new JSONObject(); state.put("sync", sync); }
        return sync;
    }
    private void updateCurrent(boolean profilesChanged) {
        try {
            JSONObject result = new JSONObject(status.toString());
            JSONObject state = vault.readState(), sync = sync(state), config = sync.optJSONObject("config");
            if (config == null) config = new JSONObject().put("enabled", false).put("remote", "").put("branch", "main").put("username", "git");
            JSONObject publicConfig = new JSONObject(config.toString());
            publicConfig.put("hasKey", !publicConfig.optString("privateKey").isEmpty());
            publicConfig.put("hasToken", !publicConfig.optString("token").isEmpty());
            publicConfig.remove("privateKey"); publicConfig.remove("token"); publicConfig.remove("passphrase");
            result.put("config", publicConfig).put("lastSync", sync.optLong("lastSync", 0));
            result.put("hasVaultKey", sync.has("vaultKey")).put("hasBackup", vault.hasBackup(context));
            if (!config.optBoolean("enabled") && !List.of("error", "disabled").contains(result.optString("state"))) result.put("state", "disabled").put("message", "Git 동기화 꺼짐");
            status = result; Listener target = listener; if (target != null) target.changed(result, profilesChanged);
        } catch (Exception error) {
            // Do not overwrite unreadable storage or expose raw configuration/credential exceptions.
            try { status = new JSONObject().put("state", "error").put("message", "암호화된 동기화 설정을 읽을 수 없습니다."); Listener target = listener; if(target != null) target.changed(status,false); }
            catch (JSONException ignored) { }
        }
    }
    private void update(String state, String message, boolean profilesChanged) {
        try { status = new JSONObject().put("state", state).put("message", message == null ? "동기화 실패" : message); updateCurrent(profilesChanged); }
        catch (JSONException ignored) { }
    }
    private void conflict(String local, String remote, String message) {
        conflictLocal = local; conflictRemote = remote; update("conflict", message, false);
    }
    private void run(String choice, String password) {
        boolean retry = false;
        try {
            JSONObject saved = vault.readState(), sync = sync(saved), config = sync.optJSONObject("config");
            if (config == null || !config.optBoolean("enabled")) { update("disabled", "Git 동기화 꺼짐", false); return; }
            if (choice != null && !List.of("local", "remote").contains(choice)) throw new IllegalArgumentException("잘못된 충돌 선택입니다.");
            if (choice != null && conflictLocal == null) throw new IllegalArgumentException("지금 동기화로 원격 상태를 먼저 확인하세요.");
            update("syncing", "Git 저장소 동기화 중…", false);
            JSONArray profiles = saved.getJSONArray("profiles"); String localHash = SyncCrypto.digest(profiles);
            try (GitRepository repository = new GitRepository(context, config, (host, fingerprint) -> { Listener target = listener; return foreground && target != null && target.trust(host, fingerprint); })) {
                GitRepository.Remote remote = repository.fetch();
                String latestLocalHash = SyncCrypto.digest(vault.read());
                if (choice != null && (!Objects.equals(conflictLocal, latestLocalHash) || !Objects.equals(conflictRemote, remote.hash))) {
                    conflict(latestLocalHash, remote.hash, "확인하는 동안 로컬 또는 원격 데이터가 바뀌었습니다. 사용할 쪽을 다시 선택하세요."); return;
                }
                boolean localChanged = !localHash.equals(sync.optString("localDigest", ""));
                boolean remoteChanged = !Objects.equals(remote.hash, sync.optString("remoteDigest", null));
                if (choice == null && remote.envelope != null && localChanged && remoteChanged) {
                    conflict(localHash, remote.hash, "로컬과 원격 데이터가 다릅니다. 원격 가져오기 또는 로컬 올리기를 선택하세요."); return;
                }
                if (choice == null && remote.envelope == null && sync.has("remoteDigest")) {
                    conflict(localHash, null, "원격 동기화 파일/브랜치가 삭제되었습니다. 로컬 내용을 다시 올릴지 선택하세요."); return;
                }
                if ("remote".equals(choice) || (choice == null && remoteChanged && remote.envelope != null)) {
                    if (remote.envelope == null) throw new IllegalArgumentException("가져올 원격 동기화 파일이 없습니다.");
                    byte[] key = null; JSONObject snapshot;
                    try {
                        key = password.isEmpty() && sync.has("vaultKey") ? SyncCrypto.bytes(sync.getString("vaultKey")) : SyncCrypto.unlock(remote.envelope, password);
                        snapshot = SyncCrypto.decode(remote.envelope, key);
                    } catch (Exception error) {
                        if (key != null) Arrays.fill(key, (byte)0);
                        JSONObject previous = sync.optJSONObject("portable");
                        if (password.isEmpty() && previous != null && SyncCrypto.canonical(previous.getJSONObject("vault").get("wrapped")).equals(SyncCrypto.canonical(remote.envelope.get("wrapped"))))
                            throw new java.io.IOException("동기화 데이터의 인증 또는 형식 검증에 실패했습니다.");
                        conflictLocal = localHash; conflictRemote = remote.hash;
                        update("password-required", "원격 볼트의 마스터 비밀번호를 입력하세요. 비밀번호가 맞다면 파일 손상 여부를 확인하세요.", false); return;
                    }
                    try {
                        JSONArray imported = SyncSnapshot.project(snapshot, key);
                        synchronized (vault) {
                            JSONObject latest = vault.readState();
                            if (!localHash.equals(SyncCrypto.digest(latest.getJSONArray("profiles")))) { conflict(SyncCrypto.digest(latest.getJSONArray("profiles")), remote.hash, "가져오는 동안 로컬 서버가 변경되었습니다. 다시 선택하세요."); return; }
                            vault.backup(context);
                            JSONObject next = sync(latest); next.put("portable", snapshot).put("projection", imported).put("vaultKey", SyncCrypto.b64(key));
                            latest.put("profiles", imported); accept(next, SyncCrypto.digest(imported), remote.hash); vault.writeState(latest);
                        }
                        conflictLocal = conflictRemote = null; update("synced", "원격 데이터를 가져왔습니다.", true);
                    } finally { if(key != null) Arrays.fill(key, (byte)0); }
                    return;
                }
                if (choice == null && !localChanged && !remoteChanged && remote.envelope != null) {
                    synchronized(vault) { JSONObject latest = vault.readState(); accept(sync(latest), localHash, remote.hash); vault.writeState(latest); }
                    conflictLocal = conflictRemote = null; update("synced", "동기화 완료", false); return;
                }
                if (!sync.has("vaultKey")) {
                    if (password.length() < 8) {
                        conflictLocal = localHash; conflictRemote = remote.hash;
                        update("password-required", "새 동기화 볼트의 마스터 비밀번호를 8자 이상으로 정하세요. 다른 기기에서 이 비밀번호로 엽니다.", false); return;
                    }
                    byte[] key = SyncCrypto.random(32);
                    try {
                        JSONObject initial = SyncSnapshot.create(password, key);
                        synchronized(vault) {
                            JSONObject latest = vault.readState(); JSONObject next = sync(latest);
                            next.put("vaultKey", SyncCrypto.b64(key)).put("portable", initial).put("projection", new JSONArray()); vault.writeState(latest);
                            sync = next;
                        }
                    } finally { Arrays.fill(key, (byte)0); }
                }
                byte[] key = SyncCrypto.bytes(sync.getString("vaultKey"));
                try {
                    JSONObject snapshot = SyncSnapshot.build(sync.getJSONObject("portable"), sync.optJSONArray("projection") == null ? new JSONArray() : sync.getJSONArray("projection"), profiles, key);
                    JSONObject portableVault = snapshot.getJSONObject("vault");
                    JSONObject envelope = new JSONObject().put("format", SyncCrypto.FORMAT).put("kdf", portableVault.get("kdf")).put("wrapped", portableVault.get("wrapped"))
                        .put("payload", SyncCrypto.seal(key, SyncCrypto.canonical(snapshot).getBytes(StandardCharsets.UTF_8), SyncCrypto.FORMAT));
                    repository.push(remote, envelope);
                    synchronized(vault) {
                        JSONObject latest = vault.readState(); JSONObject next = sync(latest);
                        next.put("portable", snapshot).put("projection", profiles); accept(next, localHash, SyncCrypto.digest(envelope)); vault.writeState(latest);
                    }
                    conflictLocal = conflictRemote = null; update("synced", "동기화 완료", false);
                } finally { Arrays.fill(key, (byte)0); }
            }
        } catch (OutOfMemoryError error) { update("error", "볼트 암호화를 위한 메모리가 부족합니다. 다른 앱을 닫고 다시 시도하세요.", false); }
        catch (LinkageError error) { update("error", "이 Android 환경에서 Git 라이브러리를 실행할 수 없습니다.", false); }
        catch (Exception error) {
            if (BuildConfig.DEBUG) {
                Throwable cause = error; while (cause.getCause() != null) cause = cause.getCause();
                android.util.Log.e("BrightTermSync", cause.getClass().getName() + " at " + (cause.getStackTrace().length > 0 ? cause.getStackTrace()[0] : "unknown"));
            }
            // Library errors can include URLs/credentials. Show a stable sanitized message.
            update("error", "Git 동기화 실패: 주소·네트워크·인증·권한 또는 동기화 파일을 확인하세요. 로컬 데이터는 보존했습니다.", false); retry = true;
        } finally {
            if (foreground && !List.of("conflict", "password-required", "disabled").contains(status.optString("state"))) {
                boolean dirty = false;
                try { JSONObject latest = vault.readState(); dirty = !SyncCrypto.digest(latest.getJSONArray("profiles")).equals(sync(latest).optString("localDigest", "")); } catch (Exception ignored) { }
                schedule(retry ? 30000 : dirty ? 1000 : 60000);
            }
        }
    }
    private static void accept(JSONObject sync, String local, String remote) throws Exception {
        sync.put("localDigest", local).put("remoteDigest", remote).put("lastSync", System.currentTimeMillis());
    }
}
