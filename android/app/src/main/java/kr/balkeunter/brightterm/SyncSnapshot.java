package kr.balkeunter.brightterm;

import org.json.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Edits only Android-owned fields; preserves unsupported desktop hosts, groups and credentials. */
final class SyncSnapshot {
    private static final String[] SECRETS = {"password", "privateKey", "passphrase"};
    /** 서버 편집 → 터미널: 터미널 종류·인코딩·키 코드·고른 템플릿 */
    static final String[] TERMINAL = {"termType", "encoding", "keys", "terminalPreset"};
    private static void terminal(JSONObject p, JSONObject h) throws Exception {
        p.put("termType", h.optString("termType", "xterm-256color")).put("encoding", h.optString("encoding", "utf-8"));
        if (h.optJSONObject("keys") != null) p.put("keys", new JSONObject(h.getJSONObject("keys").toString()));
        if (!h.optString("terminalPreset").isEmpty()) p.put("terminalPreset", h.getString("terminalPreset"));
    }
    static JSONObject create(String password, byte[] key) throws Exception {
        JSONObject kdf = SyncCrypto.kdf(); byte[] kek = SyncCrypto.derive(password, kdf);
        try {
            JSONObject vault = new JSONObject().put("version", 1).put("kdf", kdf)
                .put("wrapped", SyncCrypto.seal(kek, key, "vault-key")).put("items", new JSONArray());
            return new JSONObject().put("version", 1).put("groups", new JSONArray()).put("hosts", new JSONArray()).put("vault", vault);
        } finally { Arrays.fill(kek, (byte)0); }
    }
    static JSONArray project(JSONObject snapshot, byte[] key) throws Exception {
        Map<String, JSONObject> credentials = new HashMap<>();
        JSONArray items = snapshot.getJSONObject("vault").getJSONArray("items");
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.getJSONObject(i);
            credentials.put(item.getString("id"), new JSONObject(new String(SyncCrypto.open(key, item, item.getString("id")), StandardCharsets.UTF_8)));
        }
        JSONArray profiles = new JSONArray(), hosts = snapshot.getJSONArray("hosts");
        for (int i = 0; i < hosts.length(); i++) {
            JSONObject h = hosts.getJSONObject(i); if (!"ssh".equals(h.getString("protocol"))) continue;
            JSONObject credential = credentials.get(h.optString("credentialId"));
            JSONObject p = new JSONObject().put("id", h.getString("id")).put("name", h.getString("alias"))
                .put("host", h.getString("host")).put("port", h.getInt("port")).put("username", h.getString("username"))
                .put("command", h.optString("startupCommand", "")).put("persist", h.optBoolean("persist", false))
                .put("persistName", h.optString("persistName", "")).put("persistMouse", h.optBoolean("persistMouse", true));
            terminal(p, h);
            if (credential != null) {
                for (String secret : SECRETS) p.put(secret, credential.optString(secret, ""));
                if (p.getString("username").isEmpty()) p.put("username", credential.optString("username", ""));
            }
            String unsupported = unsupported(h);
            if (!unsupported.isEmpty()) p.put("unsupported", unsupported);
            profiles.put(p);
        }
        return profiles;
    }
    static JSONObject build(JSONObject original, JSONArray baseline, JSONArray profiles, byte[] key) throws Exception {
        JSONObject snapshot = new JSONObject(original.toString());
        JSONArray hosts = snapshot.getJSONArray("hosts"), items = snapshot.getJSONObject("vault").getJSONArray("items");
        Map<String, JSONObject> before = indexed(baseline), current = indexed(profiles);
        for (int i = hosts.length() - 1; i >= 0; i--) {
            JSONObject host = hosts.getJSONObject(i);
            if (before.containsKey(host.getString("id")) && !current.containsKey(host.getString("id"))) hosts.remove(i);
        }
        Map<String, JSONObject> existing = indexed(hosts);
        for (int i = 0; i < profiles.length(); i++) {
            JSONObject p = profiles.getJSONObject(i), old = before.get(p.getString("id")), host = existing.get(p.getString("id"));
            boolean fresh = host == null;
            if (fresh) {
                host = new JSONObject().put("id", p.getString("id")).put("groupId", JSONObject.NULL).put("protocol", "ssh")
                    .put("authType", "ask").put("tags", new JSONArray()).put("forwards", new JSONArray())
                    .put("encoding", "utf-8").put("termType", "xterm-256color").put("keepaliveSec", 30).put("sort", hosts.length());
                hosts.put(host);
            }
            String[][] fields = {{"name", "alias"}, {"host", "host"}, {"port", "port"}, {"username", "username"}, {"command", "startupCommand"}, {"persist", "persist"}, {"persistName", "persistName"}, {"persistMouse", "persistMouse"}};
            for (String[] field : fields) if (fresh || changed(p, old, field[0])) host.put(field[1], p.opt(field[0]) == null ? (field[0].equals("persist") ? false : field[0].equals("persistMouse") ? true : "") : p.opt(field[0]));
            for (String field : TERMINAL) if (fresh || changed(p, old, field)) {
                if (p.opt(field) == null) host.remove(field); else host.put(field, p.get(field));
            }
            if (host.optString("encoding", "").isEmpty()) host.put("encoding", "utf-8");
            if (host.optString("termType", "").isEmpty()) host.put("termType", "xterm-256color");
            boolean secretsChanged = fresh;
            for (String secret : SECRETS) secretsChanged |= changed(p, old, secret);
            if (secretsChanged) {
                JSONObject secret = new JSONObject().put("username", p.optString("username", ""));
                for (String name : SECRETS) if (!p.optString(name, "").isEmpty()) secret.put(name, p.getString(name));
                // A distinct item avoids changing another host that shares a desktop credential.
                String id = UUID.randomUUID().toString();
                JSONObject item = SyncCrypto.seal(key, secret.toString().getBytes(StandardCharsets.UTF_8), id);
                item.put("id", id).put("name", p.optString("name", p.optString("host")))
                    .put("kind", p.optString("privateKey", "").isEmpty() ? "password" : "key")
                    .put("username", p.optString("username", "")).put("updatedAt", System.currentTimeMillis());
                items.put(item); host.put("credentialId", id).put("authType", item.getString("kind"));
            }
        }
        SyncCrypto.validateSnapshot(snapshot); return snapshot;
    }
    private static String unsupported(JSONObject h) throws Exception {
        return !h.isNull("jumpHostId") || !h.isNull("jump") || !h.isNull("proxy") || h.getJSONArray("forwards").length() > 0
            ? "이 서버의 점프 호스트·프록시·포워딩 설정은 Android에서 아직 지원하지 않습니다. 데스크톱 설정은 동기화에 보존됩니다." : "";
    }
    static void upgrade(Vault vault) throws Exception {
        synchronized (vault) {
            JSONObject state = vault.readState(), sync = state.optJSONObject("sync");
            JSONArray profiles = state.getJSONArray("profiles"); String oldHash = SyncCrypto.digest(profiles);
            JSONObject portable = sync == null ? null : sync.optJSONObject("portable");
            Map<String, JSONObject> hosts = portable == null ? new HashMap<>() : indexed(portable.getJSONArray("hosts"));
            boolean changed = upgradeProfiles(profiles, hosts);
            if (sync != null && sync.optJSONArray("projection") != null) changed |= upgradeProfiles(sync.getJSONArray("projection"), hosts);
            if (changed) {
                if (sync != null && oldHash.equals(sync.optString("localDigest"))) sync.put("localDigest", SyncCrypto.digest(profiles));
                vault.writeState(state);
            }
        }
    }
    private static boolean upgradeProfiles(JSONArray profiles, Map<String, JSONObject> hosts) throws Exception {
        String before = profiles.toString();
        for (int i = 0; i < profiles.length(); i++) {
            JSONObject p = profiles.getJSONObject(i), h = hosts.get(p.getString("id"));
            if (!p.has("persist")) p.put("persist", h != null && h.optBoolean("persist", false));
            if (!p.has("persistName")) p.put("persistName", h == null ? "" : h.optString("persistName", ""));
            if (!p.has("persistMouse")) p.put("persistMouse", h == null || h.optBoolean("persistMouse", true));
            if (!p.has("encoding") && h != null) terminal(p, h);
            if (h != null) { String reason = unsupported(h); if (reason.isEmpty()) p.remove("unsupported"); else p.put("unsupported", reason); }
        }
        return !before.equals(profiles.toString());
    }
    private static boolean changed(JSONObject value, JSONObject previous, String field) {
        return previous == null || !Objects.equals(value.optString(field, ""), previous.optString(field, ""));
    }
    private static Map<String, JSONObject> indexed(JSONArray array) throws Exception {
        Map<String, JSONObject> map = new HashMap<>();
        for (int i = 0; i < array.length(); i++) { JSONObject value = array.getJSONObject(i); map.put(value.getString("id"), value); }
        return map;
    }
}
