package kr.balkeunter.brightterm;

import android.app.Application;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public class BrightTermApp extends Application {
    Vault vault;
    GitSync sync;
    Exception storageError;
    @Override public void onCreate() {
        super.onCreate();
        try { vault = new Vault(this); SyncSnapshot.upgrade(vault); sync = new GitSync(this, vault); provisionDebugDeployment(); }
        catch (Exception error) { storageError = error; }
    }
    /** Only adb run-as can stage this file; no exported Activity/receiver accepts credentials. */
    private void provisionDebugDeployment() {
        File pending = new File(getFilesDir(), "deploy-pending.json");
        if (!BuildConfig.DEBUG || !pending.isFile()) return;
        String id = "";
        try {
            if (pending.length() > 65536) throw new IOException("Provisioning file too large");
            byte[] encoded = java.nio.file.Files.readAllBytes(pending.toPath());
            JSONObject payload;
            try { payload = new JSONObject(new String(encoded, StandardCharsets.UTF_8)); }
            finally { Arrays.fill(encoded, (byte)0); }
            id = payload.getString("id");
            if (!id.matches("[a-f0-9-]{36}") || payload.getInt("version") != 1) throw new IOException("Invalid provisioning request");
            JSONObject config = payload.getJSONObject("config");
            GitRepository.validate(config);
            if (!config.getString("remote").startsWith("https://")) throw new IOException("HTTPS required");
            if (!pending.delete()) throw new IOException("Cannot remove transient credentials");
            final String requestId = id;
            sync.configure(config.toString(), success -> deploymentResult(requestId, success));
        } catch (Exception error) { deploymentResult(id, false); }
        finally { if (pending.exists()) pending.delete(); }
    }
    private void deploymentResult(String id, boolean success) {
        AtomicFile result = new AtomicFile(new File(getFilesDir(), "deploy-result.json"));
        FileOutputStream output = null;
        try {
            output = result.startWrite();
            output.write(new JSONObject().put("id", id).put("success", success).toString().getBytes(StandardCharsets.UTF_8));
            result.finishWrite(output);
        } catch (Exception error) { if (output != null) result.failWrite(output); }
    }
}
