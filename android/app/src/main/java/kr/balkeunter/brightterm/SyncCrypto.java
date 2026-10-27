package kr.balkeunter.brightterm;

import android.util.Base64;
import org.bouncycastle.crypto.generators.SCrypt;
import org.json.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.text.Normalizer;
import java.util.*;
import javax.crypto.Cipher;
import javax.crypto.spec.*;

/** Byte-compatible with src/main/vault.ts and gitSyncFormat.ts. */
final class SyncCrypto {
    static final String FORMAT = "brightterm-git-v1";
    static byte[] random(int length) { byte[] bytes = new byte[length]; new SecureRandom().nextBytes(bytes); return bytes; }
    static String b64(byte[] bytes) { return Base64.encodeToString(bytes, Base64.NO_WRAP); }
    static byte[] bytes(String value) { return Base64.decode(value, Base64.DEFAULT); }
    static String canonical(Object value) throws JSONException {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject)value; List<String> keys = new ArrayList<>();
            object.keys().forEachRemaining(keys::add); Collections.sort(keys);
            List<String> parts = new ArrayList<>();
            for (String key : keys) parts.add(JSONObject.quote(key).replace("\\/", "/") + ":" + canonical(object.get(key)));
            return "{" + String.join(",", parts) + "}";
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray)value; List<String> parts = new ArrayList<>();
            for (int i = 0; i < array.length(); i++) parts.add(canonical(array.get(i)));
            return "[" + String.join(",", parts) + "]";
        }
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof String) return JSONObject.quote((String)value).replace("\\/", "/");
        if (value instanceof Number) return JSONObject.numberToString((Number)value);
        return value.toString();
    }
    static String digest(Object value) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(canonical(value).getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(); for (byte b : bytes) hex.append(String.format(Locale.ROOT, "%02x", b & 255)); return hex.toString();
    }
    static JSONObject kdf() throws Exception {
        return new JSONObject().put("alg", "scrypt").put("N", 131072).put("r", 8).put("p", 1).put("salt", b64(random(16)));
    }
    static void validateKdf(JSONObject kdf) throws Exception {
        strings(kdf, "alg", "salt"); integers(kdf, "N", "r", "p");
        if (!"scrypt".equals(kdf.getString("alg")) || kdf.getInt("N") != 131072 || kdf.getInt("r") != 8 || kdf.getInt("p") != 1 || bytes(kdf.getString("salt")).length != 16)
            throw new IllegalArgumentException("지원하지 않는 볼트 KDF입니다.");
    }
    static void validateEnc(JSONObject e) throws Exception {
        strings(e, "iv", "tag", "ct");
        if (bytes(e.getString("iv")).length != 12 || bytes(e.getString("tag")).length != 16) throw new IllegalArgumentException("손상된 암호화 데이터입니다.");
        bytes(e.getString("ct"));
    }
    static byte[] derive(String password, JSONObject kdf) throws Exception {
        validateKdf(kdf);
        byte[] secret = Normalizer.normalize(password, Normalizer.Form.NFKC).getBytes(StandardCharsets.UTF_8);
        try { return SCrypt.generate(secret, bytes(kdf.getString("salt")), 131072, 8, 1, 32); }
        finally { Arrays.fill(secret, (byte)0); }
    }
    static JSONObject seal(byte[] key, byte[] plain, String aad) throws Exception {
        byte[] iv = random(12); Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8)); byte[] encoded = cipher.doFinal(plain);
        return new JSONObject().put("iv", b64(iv)).put("ct", b64(Arrays.copyOf(encoded, encoded.length - 16))).put("tag", b64(Arrays.copyOfRange(encoded, encoded.length - 16, encoded.length)));
    }
    static byte[] open(byte[] key, JSONObject encrypted, String aad) throws Exception {
        validateEnc(encrypted); byte[] ct = bytes(encrypted.getString("ct")), tag = bytes(encrypted.getString("tag"));
        byte[] all = Arrays.copyOf(ct, ct.length + tag.length); System.arraycopy(tag, 0, all, ct.length, tag.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, bytes(encrypted.getString("iv"))));
        cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8)); return cipher.doFinal(all);
    }
    static byte[] unlock(JSONObject envelope, String password) throws Exception {
        validateEnvelope(envelope); byte[] kek = derive(password, envelope.getJSONObject("kdf"));
        try {
            byte[] key = open(kek, envelope.getJSONObject("wrapped"), "vault-key");
            if (key.length != 32) throw new IllegalArgumentException("잘못된 볼트 키입니다."); return key;
        } finally { Arrays.fill(kek, (byte)0); }
    }
    static void validateEnvelope(JSONObject e) throws Exception {
        if (!FORMAT.equals(e.getString("format"))) throw new IllegalArgumentException("지원하지 않는 동기화 형식입니다.");
        validateKdf(e.getJSONObject("kdf")); validateEnc(e.getJSONObject("wrapped")); validateEnc(e.getJSONObject("payload"));
    }
    static JSONObject decode(JSONObject envelope, byte[] key) throws Exception {
        validateEnvelope(envelope);
        JSONObject snapshot = new JSONObject(new String(open(key, envelope.getJSONObject("payload"), FORMAT), StandardCharsets.UTF_8));
        validateSnapshot(snapshot);
        JSONObject vault = snapshot.getJSONObject("vault");
        if (!canonical(vault.get("kdf")).equals(canonical(envelope.get("kdf"))) || !canonical(vault.get("wrapped")).equals(canonical(envelope.get("wrapped"))))
            throw new IllegalArgumentException("동기화 볼트 키 정보가 일치하지 않습니다.");
        // Authenticate all credentials, including entries Android cannot currently use.
        JSONArray items = vault.getJSONArray("items");
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.getJSONObject(i);
            new JSONObject(new String(open(key, item, item.getString("id")), StandardCharsets.UTF_8));
        }
        return snapshot;
    }
    static void validateSnapshot(JSONObject snapshot) throws Exception {
        JSONObject vault = snapshot.getJSONObject("vault");
        integers(snapshot, "version"); integers(vault, "version");
        if (snapshot.getInt("version") != 1 || vault.getInt("version") != 1 || vault.has("osWrapped")) throw new IllegalArgumentException("잘못된 동기화 볼트입니다.");
        validateKdf(vault.getJSONObject("kdf")); validateEnc(vault.getJSONObject("wrapped"));
        if (vault.has("recoveryKdf")) validateKdf(vault.getJSONObject("recoveryKdf"));
        if (vault.has("recoveryWrapped")) validateEnc(vault.getJSONObject("recoveryWrapped"));
        JSONArray groups = snapshot.getJSONArray("groups"), hosts = snapshot.getJSONArray("hosts"), items = vault.getJSONArray("items");
        unique(groups); unique(hosts); unique(items);
        Map<String, JSONObject> byId = new HashMap<>();
        for (int i = 0; i < groups.length(); i++) { JSONObject g = groups.getJSONObject(i); strings(g, "name"); nullableString(g, "parentId"); byId.put(g.getString("id"), g); }
        for (JSONObject group : byId.values()) {
            Set<String> seen = new HashSet<>(); JSONObject current = group;
            while (current != null) {
                if (!seen.add(current.getString("id"))) throw new IllegalArgumentException("순환 폴더 구조입니다.");
                if (current.isNull("parentId")) break;
                current = byId.get(current.getString("parentId")); if (current == null) throw new IllegalArgumentException("상위 폴더가 없습니다.");
            }
        }
        for (int i = 0; i < hosts.length(); i++) {
            JSONObject h = hosts.getJSONObject(i);
            strings(h, "alias", "host", "username", "protocol", "authType"); nullableString(h, "groupId"); integers(h, "port");
            if (!List.of("ssh", "telnet", "serial", "local").contains(h.getString("protocol")) || !List.of("password", "key", "agent", "ask").contains(h.getString("authType")) || h.getInt("port") < 0 || h.getInt("port") > 65535)
                throw new IllegalArgumentException("잘못된 서버 정보입니다.");
            if (!h.isNull("groupId") && !byId.containsKey(h.getString("groupId"))) throw new IllegalArgumentException("서버의 폴더가 없습니다.");
            JSONArray tags = h.getJSONArray("tags"); for (int j = 0; j < tags.length(); j++) if (!(tags.get(j) instanceof String)) throw new IllegalArgumentException("잘못된 태그입니다.");
            h.getJSONArray("forwards");
        }
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.getJSONObject(i); validateEnc(item); strings(item, "name", "kind");
            if (!List.of("key", "password").contains(item.getString("kind"))) throw new IllegalArgumentException("잘못된 자격 증명입니다.");
        }
    }
    private static void strings(JSONObject value, String... fields) throws Exception {
        for (String field : fields) if (!(value.get(field) instanceof String)) throw new IllegalArgumentException("잘못된 문자열 필드: " + field);
    }
    private static void nullableString(JSONObject value, String field) throws Exception {
        if (!value.has(field) || !(value.get(field) == JSONObject.NULL || value.get(field) instanceof String)) throw new IllegalArgumentException("잘못된 폴더 참조입니다.");
    }
    private static void integers(JSONObject value, String... fields) throws Exception {
        for (String field : fields) {
            Object number = value.get(field);
            if (!(number instanceof Number) || ((Number)number).doubleValue() != ((Number)number).longValue()) throw new IllegalArgumentException("잘못된 숫자 필드: " + field);
        }
    }
    private static void unique(JSONArray array) throws Exception {
        if (array.length() > 10000) throw new IllegalArgumentException("동기화 항목이 너무 많습니다.");
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < array.length(); i++) {
            strings(array.getJSONObject(i), "id");
            String id = array.getJSONObject(i).getString("id");
            if (id.isEmpty() || !ids.add(id)) throw new IllegalArgumentException("중복되거나 빈 ID입니다.");
        }
    }
}
