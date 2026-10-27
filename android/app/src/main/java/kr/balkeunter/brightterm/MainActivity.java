package kr.balkeunter.brightterm;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import androidx.webkit.WebViewAssetLoader;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;

public class MainActivity extends androidx.activity.ComponentActivity implements TerminalService.Listener, GitSync.Listener {
    private WebView web;
    private Vault vault;
    private GitSync gitSync;
    private volatile TerminalService service;
    private String transferSession, transferPath;
    private boolean transferUpload;
    private boolean ready, bound, resumed, lightTheme;
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    private final java.util.Set<CompletableFuture<Boolean>> prompts = ConcurrentHashMap.newKeySet();
    private final java.util.Set<CompletableFuture<String>> tmuxPrompts = ConcurrentHashMap.newKeySet();
    private final ServiceConnection connection = new ServiceConnection() {
        public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((TerminalService.LocalBinder)binder).service(); if (ready) service.attach(MainActivity.this);
        }
        public void onServiceDisconnected(ComponentName name) { service = null; event(eventOf("reset", "", "")); }
    };
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (web == null) { finish(); return; }
                web.evaluateJavascript("window.androidBack()", result -> { if (!"true".equals(result)) moveTaskToBack(true); });
            }
        });
        try {
            BrightTermApp app = (BrightTermApp)getApplication();
            if (app.storageError != null) throw app.storageError;
            vault = app.vault; gitSync = app.sync;
        }
        catch (Exception error) { dialogBuilder().setTitle("볼트를 열 수 없습니다").setMessage("기기 암호화 키 또는 저장 파일을 확인하세요. 데이터는 덮어쓰지 않았습니다.").setPositiveButton("닫기", (d,w) -> finish()).show(); return; }
        web = new WebView(this); web.setBackgroundColor(0xff0d1117);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setAllowFileAccess(false); web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.getSettings().setMediaPlaybackRequiresUserGesture(true);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder().addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        // WebView's built-in JS dialogs title themselves with the asset origin URL.
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                return jsDialog(message, result, false);
            }
            @Override public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                return jsDialog(message, result, true);
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse response = assets.shouldInterceptRequest(request.getUrl());
                return response != null ? response : new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", java.util.Map.of(), new ByteArrayInputStream(new byte[0]));
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
        });
        web.addJavascriptInterface(new Bridge(), "Android");
        android.widget.FrameLayout root = new android.widget.FrameLayout(this);
        root.addView(web, new android.widget.FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        // Consume system/caption/IME insets once, including DeX window decorations.
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets padding = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            view.setPadding(padding.left, padding.top, padding.right, padding.bottom);
            return WindowInsets.CONSUMED;
        });
        getWindow().setDecorFitsSystemWindows(false);
        String theme = getSharedPreferences("app-settings", MODE_PRIVATE).getString("json", "{}");
        try { theme = new JSONObject(theme).optString("theme", "dark"); } catch (JSONException error) { theme = "dark"; }
        appearance(theme.equals("light") || (theme.equals("system") && !night(getResources().getConfiguration())));
        web.loadUrl("https://appassets.androidplatform.net/assets/index.html");
        bound = bindService(new Intent(this, TerminalService.class), connection, BIND_AUTO_CREATE);
    }
    @Override public void changed(JSONObject status, boolean profilesChanged) {
        event(eventOf("git-sync", "", status.toString())); if (profilesChanged) profiles();
    }
    @Override protected void onResume() { super.onResume(); resumed = true; if (gitSync != null && ready) gitSync.foreground(true); }
    @Override protected void onPause() { resumed = false; if (gitSync != null) gitSync.foreground(false); super.onPause(); }
    private static JSONObject eventOf(String type, String id, String value) {
        try { return new JSONObject().put("type", type).put("id", id).put("value", value); }
        catch (JSONException error) { throw new IllegalStateException(error); }
    }
    @Override public void event(JSONObject event) {
        runOnUiThread(() -> { if (ready && web != null) web.evaluateJavascript("window.nativeEvent(" + event + ")", null); });
    }
    @Override public boolean trust(String host, String fingerprint) {
        CompletableFuture<Boolean> answer = new CompletableFuture<>(); prompts.add(answer);
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed() || answer.isDone()) { answer.complete(false); return; }
            AlertDialog dialog = dialogBuilder().setTitle("처음 연결하는 SSH 서버")
                .setMessage(host + "\n\n" + fingerprint + "\n\n서버 관리자가 제공한 지문과 일치할 때만 신뢰하세요.")
                .setNegativeButton("취소", (d,w) -> answer.complete(false))
                .setPositiveButton("신뢰하고 연결", (d,w) -> answer.complete(true))
                .setOnCancelListener(d -> answer.complete(false)).create();
            dialog.show();
            answer.whenComplete((value, error) -> runOnUiThread(dialog::dismiss));
        });
        try { return answer.get(90, TimeUnit.SECONDS); }
        catch (Exception error) { answer.complete(false); return false; }
        finally { prompts.remove(answer); }
    }
    @Override public String chooseTmux(String host, java.util.List<String> names, java.util.function.BooleanSupplier alive) {
        // null cancels, empty creates a new session, NUL selects a plain SSH shell.
        CompletableFuture<String> answer = new CompletableFuture<>(); tmuxPrompts.add(answer);
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed() || answer.isDone()) { answer.complete(null); return; }
            String[] choices = new String[names.size() + 2];
            for (int i = 0; i < names.size(); i++) choices[i] = "기존 세션: " + names.get(i);
            choices[names.size()] = "신규 tmux 세션 생성";
            choices[names.size() + 1] = "일반 SSH 셸 (tmux 사용 안 함)";
            int[] selected = { names.isEmpty() ? names.size() : 0 };
            AlertDialog dialog = dialogBuilder().setTitle(host + " · 접속 방식")
                .setSingleChoiceItems(choices, selected[0], (d, which) -> selected[0] = which)
                .setPositiveButton("연결", (d, which) -> answer.complete(selected[0] < names.size() ? names.get(selected[0]) : selected[0] == names.size() ? "" : "\0"))
                .setNegativeButton("취소", (d, which) -> answer.complete(null))
                .setOnCancelListener(d -> answer.complete(null)).create();
            dialog.show();
            answer.whenComplete((value, error) -> runOnUiThread(dialog::dismiss));
        });
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90);
        try {
            while (alive.getAsBoolean() && System.nanoTime() < deadline) {
                try { return answer.get(250, TimeUnit.MILLISECONDS); }
                catch (TimeoutException ignored) { }
            }
            return null;
        } catch (Exception error) { return null; }
        finally { answer.complete(null); tmuxPrompts.remove(answer); }
    }
    private void profiles() {
        storage.execute(() -> { try { event(eventOf("profiles", "", vault.publicProfiles().toString())); } catch (Exception error) { fail(error); } });
    }
    private void fail(Exception error) { event(eventOf("error", "", error.getMessage() == null ? "작업 실패" : error.getMessage())); }
    class Bridge {
        @JavascriptInterface public void ready() { runOnUiThread(() -> { ready = true; profiles(); gitSync.attach(MainActivity.this); if (resumed) gitSync.foreground(true); if (service != null) service.attach(MainActivity.this); }); }
        // App settings stay on this device; Git sync carries only servers and the vault, as on the desktop.
        @JavascriptInterface public String settings() { return getSharedPreferences("app-settings", MODE_PRIVATE).getString("json", "{}"); }
        @JavascriptInterface public void saveSettings(String json) {
            try { new JSONObject(json); getSharedPreferences("app-settings", MODE_PRIVATE).edit().putString("json", json).apply(); }
            catch (JSONException error) { fail(error); }
        }
        @JavascriptInterface public boolean nightMode() { return night(getResources().getConfiguration()); }
        @JavascriptInterface public void setAppearance(boolean light) { runOnUiThread(() -> appearance(light)); }
        @JavascriptInterface public void syncStatus() { runOnUiThread(() -> gitSync.attach(MainActivity.this)); }
        @JavascriptInterface public void configureSync(String config) { gitSync.configure(config); }
        @JavascriptInterface public void sync(String choice, String password) { gitSync.request(choice, password); }
        @JavascriptInterface public void restoreSyncBackup() { gitSync.restoreBackup(); }
        @JavascriptInterface public void importSyncKey() { runOnUiThread(() -> startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE), 13)); }
        @JavascriptInterface public void save(String json) {
            storage.execute(() -> { try { JSONObject p = new JSONObject(json); validateFields(p); vault.save(p); profiles(); } catch (Exception error) { fail(error); } });
        }
        @JavascriptInterface public void delete(String id) { storage.execute(() -> { try { vault.delete(id); profiles(); } catch (Exception error) { fail(error); } }); }
        @JavascriptInterface public void connect(String json, int cols, int rows) {
            storage.execute(() -> {
                try {
                    JSONObject request = new JSONObject(json);
                    JSONObject profile;
                    if (request.has("savedId")) profile = vault.find(request.getString("savedId"));
                    else if (request.has("inheritId")) {
                        profile = vault.find(request.getString("inheritId"));
                        for (java.util.Iterator<String> keys = request.keys(); keys.hasNext();) {
                            String key = keys.next();
                            if ((key.equals("password") || key.equals("privateKey") || key.equals("passphrase")) && request.optString(key).isEmpty()) continue;
                            profile.put(key, request.get(key));
                        }
                    } else profile = request;
                    if (!request.optString("password").isEmpty()) profile.put("password", request.getString("password"));
                    validate(profile);
                    final JSONObject selectedProfile = profile;
                    runOnUiThread(() -> {
                        if (service == null) { fail(new IllegalStateException("연결 서비스 준비 중입니다. 다시 시도하세요.")); return; }
                        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED)
                            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 10);
                        startForegroundService(new Intent(MainActivity.this, TerminalService.class));
                        service.connect(selectedProfile, Math.max(2, cols), Math.max(1, rows));
                    });
                } catch (Exception error) { fail(error); }
            });
        }
        @JavascriptInterface public void input(String id, String data) { if (service != null) service.input(id, data); }
        @JavascriptInterface public void resize(String id, int cols, int rows) { if (service != null) service.resize(id, cols, rows); }
        @JavascriptInterface public void disconnect(String id) { runOnUiThread(() -> { if (service != null) service.disconnect(id); }); }
        @JavascriptInterface public void importKey() { runOnUiThread(() -> {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(intent, 11);
        }); }
        @JavascriptInterface public void list(String id, String path) { TerminalService s = service; if (s != null) s.list(id, path); }
        @JavascriptInterface public void transfer(String id, String path, boolean upload) { runOnUiThread(() -> {
            if (path.trim().isEmpty() || path.endsWith("/")) { fail(new IllegalArgumentException("원격 파일의 전체 경로를 입력하세요.")); return; }
            transferSession = id; transferPath = path; transferUpload = upload;
            Intent intent = new Intent(upload ? Intent.ACTION_OPEN_DOCUMENT : Intent.ACTION_CREATE_DOCUMENT)
                .setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
            if (!upload) { intent.setType("application/octet-stream"); intent.putExtra(Intent.EXTRA_TITLE, path.substring(path.lastIndexOf('/') + 1)); }
            startActivityForResult(intent, 12);
        }); }
        @JavascriptInterface public void copy(String text) { runOnUiThread(() -> ((android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("BrightTerm", text))); }
        @JavascriptInterface public void paste() { runOnUiThread(() -> {
            android.content.ClipboardManager clipboard = (android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE);
            if (clipboard.hasPrimaryClip() && clipboard.getPrimaryClip() != null) event(eventOf("paste", "", clipboard.getPrimaryClip().getItemAt(0).coerceToText(MainActivity.this).toString()));
        }); }
        @JavascriptInterface public void keyboard() { runOnUiThread(() -> {
            web.requestFocus(); ((android.view.inputmethod.InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).showSoftInput(web, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
        }); }
    }
    private static void validate(JSONObject p) throws Exception {
        if (!p.optString("unsupported").isEmpty()) throw new IllegalArgumentException(p.getString("unsupported"));
        validateFields(p);
    }
    private static void validateFields(JSONObject p) throws Exception {
        if (p.optString("host").trim().isEmpty() || p.optString("username").trim().isEmpty()) throw new IllegalArgumentException("호스트와 사용자명을 입력하세요.");
        int port = p.optInt("port", 22); if (port < 1 || port > 65535) throw new IllegalArgumentException("포트는 1~65535여야 합니다.");
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 12) {
            TerminalService s = service;
            if (result == RESULT_OK && data != null && data.getData() != null && s != null && transferSession != null)
                s.transfer(transferSession, transferPath, data.getData(), transferUpload);
            transferSession = null; transferPath = null; return;
        }
        if ((request != 11 && request != 13) || result != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        storage.execute(() -> {
            try (InputStream input = getContentResolver().openInputStream(uri)) {
                if (input == null) throw new IOException("키 파일을 열 수 없습니다.");
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] chunk = new byte[4096]; int count;
                while (out.size() <= 65536 && (count = input.read(chunk)) != -1) out.write(chunk, 0, count);
                byte[] bytes = out.toByteArray();
                if (bytes.length > 65536) throw new IOException("키 파일은 64KB 이하여야 합니다.");
                String text = new String(bytes, StandardCharsets.UTF_8);
                if (!text.contains("PRIVATE KEY")) throw new IOException("PEM/OpenSSH 개인키 파일을 선택하세요.");
                event(eventOf(request == 13 ? "git-key" : "key", "", text));
            } catch (Exception error) { fail(error); }
        });
    }
    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (web != null) web.requestApplyInsets();
        event(eventOf("night", "", String.valueOf(night(configuration))));
    }
    private AlertDialog.Builder dialogBuilder() {
        return new AlertDialog.Builder(this, lightTheme ? android.R.style.Theme_Material_Light_Dialog_Alert : android.R.style.Theme_Material_Dialog_Alert);
    }
    private boolean jsDialog(String message, JsResult result, boolean cancelable) {
        if (isFinishing() || isDestroyed()) { result.cancel(); return true; }
        AlertDialog.Builder dialog = dialogBuilder().setTitle("BrightTerm").setMessage(message)
            .setPositiveButton("확인", (d, w) -> result.confirm())
            .setOnCancelListener(d -> result.cancel());
        if (cancelable) dialog.setNegativeButton("취소", (d, w) -> result.cancel());
        dialog.show();
        return true;
    }
    private static boolean night(Configuration configuration) {
        return (configuration.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }
    // Match the native window and system bar icons to the WebView's app theme.
    private void appearance(boolean light) {
        lightTheme = light;
        if (web == null) return;
        int background = light ? 0xfff5f6f8 : 0xff0d1117;
        web.setBackgroundColor(background);
        ((View)web.getParent()).setBackgroundColor(background);
        int bars = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        WindowInsetsController controller = getWindow().getInsetsController();
        if (controller != null) controller.setSystemBarsAppearance(light ? bars : 0, bars);
    }
    @Override protected void onDestroy() {
        for (CompletableFuture<String> prompt : tmuxPrompts) prompt.complete(null);
        for (CompletableFuture<Boolean> prompt : prompts) prompt.complete(false);
        if (service != null && service.listener == this) service.listener = null;
        if (gitSync != null) gitSync.detach(this);
        if (bound) unbindService(connection);
        if (web != null) { web.removeJavascriptInterface("Android"); web.destroy(); web = null; }
        storage.shutdown(); super.onDestroy();
    }
}
