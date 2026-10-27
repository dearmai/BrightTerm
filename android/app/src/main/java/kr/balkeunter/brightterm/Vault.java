package kr.balkeunter.brightterm;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

/** Entire profile file (including addresses and keys) is encrypted with a device-bound key. */
final class Vault {
    private final AtomicFile file;
    private final SecretKey key;
    Vault(Context context) throws Exception {
        file = new AtomicFile(new File(context.getFilesDir(), "profiles.enc"));
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        String alias = "brightterm.profiles.v1";
        if (!store.containsAlias(alias)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        key = (SecretKey) store.getKey(alias, null);
    }
    synchronized JSONArray read() throws Exception {
        if (!file.getBaseFile().exists()) return new JSONArray();
        ByteBuffer bytes = ByteBuffer.wrap(file.readFully());
        byte[] iv = new byte[12]; bytes.get(iv);
        byte[] encrypted = new byte[bytes.remaining()]; bytes.get(encrypted);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        return new JSONArray(new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8));
    }
    synchronized void write(JSONArray profiles) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] encrypted = cipher.doFinal(profiles.toString().getBytes(StandardCharsets.UTF_8));
        FileOutputStream stream = file.startWrite();
        try { stream.write(cipher.getIV()); stream.write(encrypted); file.finishWrite(stream); }
        catch (Exception error) { file.failWrite(stream); throw error; }
    }
    synchronized JSONObject find(String id) throws Exception {
        JSONArray profiles = read();
        for (int i = 0; i < profiles.length(); i++) if (profiles.getJSONObject(i).getString("id").equals(id)) return profiles.getJSONObject(i);
        throw new IllegalArgumentException("저장된 서버를 찾을 수 없습니다.");
    }
    synchronized JSONArray publicProfiles() throws Exception {
        JSONArray profiles = read();
        for (int i = 0; i < profiles.length(); i++) {
            JSONObject p = profiles.getJSONObject(i);
            p.put("hasKey", !p.optString("privateKey").isEmpty());
            p.remove("password"); p.remove("privateKey"); p.remove("passphrase");
        }
        return profiles;
    }
    synchronized void save(JSONObject profile) throws Exception {
        JSONArray profiles = read();
        for (int i = 0; i < profiles.length(); i++) {
            JSONObject old = profiles.getJSONObject(i);
            if (old.getString("id").equals(profile.getString("id"))) {
                for (String secret : new String[]{"password", "privateKey", "passphrase"})
                    if (profile.optString(secret).isEmpty()) profile.put(secret, old.optString(secret));
                profiles.put(i, profile); write(profiles); return;
            }
        }
        profiles.put(profile); write(profiles);
    }
    synchronized void delete(String id) throws Exception {
        JSONArray profiles = read();
        for (int i = profiles.length() - 1; i >= 0; i--) if (profiles.getJSONObject(i).getString("id").equals(id)) profiles.remove(i);
        write(profiles);
    }
}
