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
    /**
     * 원격 데스크톱 클립보드 — IronRDP 가 100ms 마다 읽는다. Android 12+ 는 읽을 때마다 "붙여넣음" 알림을 띄우므로
     * 클립보드가 바뀐 뒤 한 번만 실제로 읽고, 이 앱이 쓴 값은 그대로 기억한다
     */
    private volatile String clipCache = "";
    private volatile boolean clipDirty = true;
    private volatile String clipOwn;
    private android.content.ClipboardManager.OnPrimaryClipChangedListener clipListener;
    /** 원격 데스크톱 경로 열기·확인 — 네트워크를 기다리므로 저장 작업과 따로 */
    private final ExecutorService remote = Executors.newCachedThreadPool();
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
        clipListener = () -> clipDirty = true;
        ((android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).addPrimaryClipChangedListener(clipListener);
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
    @Override protected void onResume() {
        super.onResume(); resumed = true; if (gitSync != null && ready) gitSync.foreground(true);
        // 잠든 동안 끊긴 세션을 찾아 터미널에 재접속 안내를 띄운다
        if (service != null && ready) service.check();
        // 설정 앱에서 돌아오면 배터리 최적화 상태를 다시 알린다
        if (ready) event(eventOf("battery", "", String.valueOf(batteryUnrestricted())));
    }
    // 배터리 최적화 예외: 화면을 끄거나 다른 앱으로 가도 Doze 가 SSH 소켓·keepalive 를 끊지 않게 한다
    private boolean batteryUnrestricted() {
        PowerManager power = (PowerManager)getSystemService(POWER_SERVICE);
        return power != null && power.isIgnoringBatteryOptimizations(getPackageName());
    }
    private void requestBattery() {
        if (batteryUnrestricted()) { event(eventOf("battery", "", "true")); return; }
        try { startActivity(new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()))); }
        catch (ActivityNotFoundException error) {
            // 요청 창을 막은 기기(일부 제조사)는 배터리 최적화 목록을 연다
            try { startActivity(new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); }
            catch (ActivityNotFoundException ignored) { fail(new IllegalStateException("이 기기에서는 배터리 최적화 설정을 열 수 없습니다. 시스템 설정 → 앱 → BrightTerm Extended → 배터리에서 바꾸세요.")); }
        }
    }
    /** 첫 연결 때 한 번만 묻는다. 거절해도 다시 묻지 않고 설정 화면의 버튼으로 바꿀 수 있다 */
    private void askBatteryOnce() {
        SharedPreferences prefs = getSharedPreferences("app-state", MODE_PRIVATE);
        if (batteryUnrestricted() || prefs.getBoolean("battery-asked", false)) return;
        prefs.edit().putBoolean("battery-asked", true).apply();
        requestBattery();
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 10) askBatteryOnce();
    }
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
    @Override public boolean trustCertificate(String hostPort, String fingerprint, String old) {
        CompletableFuture<Boolean> answer = new CompletableFuture<>(); prompts.add(answer);
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed() || answer.isDone()) { answer.complete(false); return; }
            AlertDialog dialog = dialogBuilder().setTitle(old == null ? "처음 연결하는 원격 데스크톱" : "원격 데스크톱 인증서가 바뀌었습니다")
                .setMessage(hostPort + "\n\nRDP TLS 인증서\n" + fingerprint + (old == null ? "" : "\n\n이전 지문\n" + old) + "\n\n서버 관리자가 제공한 지문과 일치할 때만 신뢰하세요.")
                .setNegativeButton("취소", (d,w) -> answer.complete(false))
                .setPositiveButton("신뢰하고 접속", (d,w) -> answer.complete(true))
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
    /** 편집 중인(저장 전) 서버도 확인할 수 있게 — 저장된 비밀값은 저장본에서 채운다 */
    private JSONObject rdpProfile(JSONObject request) throws Exception {
        JSONObject p = request;
        String id = request.optString("id");
        if (!id.isEmpty()) {
            try {
                JSONObject saved = vault.find(id);
                for (String secret : new String[]{"password", "privateKey", "passphrase", "rdpPassword"})
                    if (p.optString(secret).isEmpty() && !saved.optString(secret).isEmpty()) p.put(secret, saved.getString(secret));
                for (String field : new String[]{"jumpHostId", "directSsh"}) if (!p.has(field) && saved.has(field)) p.put(field, saved.get(field));
            } catch (IllegalArgumentException notSaved) { }
        }
        if (p.optString("host").trim().isEmpty()) throw new IllegalArgumentException("서버 주소를 먼저 입력하세요");
        return p;
    }
    private JSONObject rdpJump(JSONObject p) throws Exception {
        String jump = p.optString("jumpHostId");
        if (jump.isEmpty() || "ssh".equals(RdpSessions.options(p).optString("route"))) return null;
        try { return vault.find(jump); }
        catch (IllegalArgumentException missing) { throw new IllegalArgumentException("점프 호스트가 Android 서버 목록에 없습니다 (SSH 서버만 가져옵니다)"); }
    }
    /** RDP 계정 — 서버 계정과 같게 / RDP 전용(Android 에서 넣은 값 또는 동기화 볼트) / 매번 묻기 */
    private JSONObject rdpCredentials(JSONObject p) throws Exception {
        JSONObject o = RdpSessions.options(p);
        String auth = o.optString("auth", "host"), password = "";
        if ("host".equals(auth)) password = p.optString("password");
        else if ("own".equals(auth)) {
            password = p.optString("rdpPassword");
            if (password.isEmpty()) password = SyncSnapshot.credentialPassword(vault.readState(), o.optString("credentialId"));
        }
        String user = o.optString("username", "").trim();
        if (user.isEmpty()) user = p.optString("username", "");
        String domain = o.optString("domain", "").trim();
        int slash = user.indexOf('\\');
        if (slash > 0) { if (domain.isEmpty()) domain = user.substring(0, slash); user = user.substring(slash + 1); }
        return new JSONObject().put("username", user).put("password", password).put("domain", domain);
    }
    private void reply(String type, String requestId, JSONObject value) { event(eventOf(type, requestId, value.toString())); }
    private static JSONObject failure(Exception error) {
        try { return new JSONObject().put("error", error.getMessage() == null ? error.toString() : error.getMessage()); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }
    class Bridge {
        // ---- 원격 데스크톱
        @JavascriptInterface public void rdpCheck(String requestId, String json) {
            remote.execute(() -> {
                try {
                    TerminalService s = service; if (s == null) throw new IllegalStateException("연결 서비스 준비 중입니다");
                    JSONObject p = rdpProfile(new JSONObject(json));
                    reply("rdp-check", requestId, s.rdp().check(p, rdpJump(p)));
                } catch (Exception error) { reply("rdp-check", requestId, failure(error)); }
            });
        }
        @JavascriptInterface public void rdpOpen(String requestId, String id) {
            // 방금 저장한 설정을 읽도록 저장 작업 뒤에 줄 세운다
            storage.execute(() -> remote.execute(() -> {
                try {
                    TerminalService s = service; if (s == null) throw new IllegalStateException("연결 서비스 준비 중입니다");
                    JSONObject p = vault.find(id);
                    if (!RdpSessions.capable(p)) throw new IllegalArgumentException("서버 OS 가 Windows 인 서버만 원격 데스크톱으로 열 수 있습니다");
                    String token = s.rdp().open(p, rdpJump(p), rdpCredentials(p), MainActivity.this::trustCertificate,
                        (t, m) -> event(eventOf("rdp-log", t, m)),
                        () -> { try { return vault.find(id); } catch (Exception e) { return null; } }, lightTheme);
                    reply("rdp-open", requestId, new JSONObject().put("token", token).put("title", p.optString("name", p.optString("host"))));
                } catch (Exception error) { reply("rdp-open", requestId, failure(error)); }
            }));
        }
        @JavascriptInterface public String rdpInfo(String token) {
            try {
                TerminalService s = service; if (s == null) throw new IllegalStateException("연결 서비스 준비 중입니다");
                String host = s.rdp().hostId(token);
                JSONObject latest = null;
                if (host != null) { latest = vault.find(host); JSONObject c = rdpCredentials(latest); s.rdp().info(token, null).put("username", c.optString("username")).put("domain", c.optString("domain")).put("password", c.optString("password")); }
                return s.rdp().info(token, latest).toString();
            } catch (Exception error) { return failure(error).toString(); }
        }
        @JavascriptInterface public void rdpClose(String token) { TerminalService s = service; if (s != null) remote.execute(() -> s.rdp().close(token)); }
        @JavascriptInterface public void rdpDepthFallback(String token) { TerminalService s = service; if (s != null) s.rdp().fallback(token); }
        /** 화면 위 설정 — 서버 설정(rdp)에 저장하고 바뀐 화면 값을 돌려준다 */
        @JavascriptInterface public String rdpSetOptions(String token, String json) {
            try {
                TerminalService s = service; if (s == null) throw new IllegalStateException("연결 서비스 준비 중입니다");
                String host = s.rdp().hostId(token); if (host == null) throw new IllegalArgumentException("원격 데스크톱 세션이 없습니다");
                JSONObject patch = new JSONObject(json);
                synchronized (vault) {
                    JSONObject p = vault.find(host);
                    JSONObject o = p.optJSONObject("rdp") == null ? new JSONObject() : p.getJSONObject("rdp");
                    String[] keys = {"scale", "dpi", "unicodeKeyboard", "clipboard", "resolution", "colorDepth", "audio", "experience"};
                    for (String k : keys) if (patch.has(k)) o.put(k, patch.get(k));
                    if (patch.has("colorDepth")) s.rdp().clearFallback(host);
                    p.put("rdp", o); vault.save(p);
                    profiles();
                    return RdpSessions.view(RdpSessions.options(p)).toString();
                }
            } catch (Exception error) { return failure(error).toString(); }
        }
        @JavascriptInterface public String clipboardText() {
            if (!clipDirty) return clipCache;
            String own = clipOwn;
            if (own != null) { clipOwn = null; clipCache = own; clipDirty = false; return own; }
            CompletableFuture<String> read = new CompletableFuture<>();
            runOnUiThread(() -> {
                try {
                    android.content.ClipboardManager clipboard = (android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE);
                    ClipData clip = clipboard.hasPrimaryClip() ? clipboard.getPrimaryClip() : null;
                    CharSequence t = clip == null || clip.getItemCount() == 0 ? null : clip.getItemAt(0).coerceToText(MainActivity.this);
                    read.complete(t == null ? "" : t.toString());
                } catch (Exception error) { read.complete(""); }
            });
            try { clipCache = read.get(2, TimeUnit.SECONDS); clipDirty = false; } catch (Exception ignored) { }
            return clipCache;
        }
        @JavascriptInterface public void rdpTestStall(boolean on) { if (BuildConfig.DEBUG) RdpGateway.testStall15 = on; }
        /** 디버그 빌드 테스트용 — 접속할 때 쓸 RDP 계정(동기화 볼트 복호화 포함) */
        @JavascriptInterface public String rdpTestCredentials(String id) {
            if (!BuildConfig.DEBUG) return "{}";
            try { return rdpCredentials(vault.find(id)).toString(); } catch (Exception error) { return failure(error).toString(); }
        }
        @JavascriptInterface public void ready() { runOnUiThread(() -> { ready = true; if (service != null) service.rdp().closeAll(); profiles(); gitSync.attach(MainActivity.this); if (resumed) gitSync.foreground(true); if (service != null) service.attach(MainActivity.this); }); }
        // App settings stay on this device; Git sync carries only servers and the vault, as on the desktop.
        @JavascriptInterface public String settings() { return getSharedPreferences("app-settings", MODE_PRIVATE).getString("json", "{}"); }
        @JavascriptInterface public void saveSettings(String json) {
            try { new JSONObject(json); getSharedPreferences("app-settings", MODE_PRIVATE).edit().putString("json", json).apply(); }
            catch (JSONException error) { fail(error); }
        }
        @JavascriptInterface public boolean nightMode() { return night(getResources().getConfiguration()); }
        @JavascriptInterface public void setAppearance(boolean light) { runOnUiThread(() -> appearance(light)); }
        @JavascriptInterface public boolean batteryUnrestricted() { return MainActivity.this.batteryUnrestricted(); }
        @JavascriptInterface public void requestBattery() { runOnUiThread(MainActivity.this::requestBattery); }
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
                        else askBatteryOnce();
                        startForegroundService(new Intent(MainActivity.this, TerminalService.class));
                        service.connect(selectedProfile, Math.max(2, cols), Math.max(1, rows));
                    });
                } catch (Exception error) { fail(error); }
            });
        }
        @JavascriptInterface public void input(String id, String data) { if (service != null) service.input(id, data); }
        @JavascriptInterface public void resize(String id, int cols, int rows) { if (service != null) service.resize(id, cols, rows); }
        @JavascriptInterface public void reconnect(String id, int cols, int rows) { runOnUiThread(() -> { if (service != null) service.reconnect(id, cols, rows); }); }
        @JavascriptInterface public String connectLog(String id) { TerminalService s = service; return s == null ? "" : s.connectLog(id); }
        @JavascriptInterface public void duplicate(String id, int cols, int rows) { runOnUiThread(() -> { if (service != null) service.duplicate(id, cols, rows); }); }
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
        @JavascriptInterface public void copy(String text) { clipOwn = text; clipCache = text; runOnUiThread(() -> ((android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("BrightTerm", text))); }
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
        AlertDialog.Builder dialog = dialogBuilder().setTitle("BrightTerm Extended").setMessage(message)
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
        if (clipListener != null) ((android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).removePrimaryClipChangedListener(clipListener);
        if (web != null) { web.removeJavascriptInterface("Android"); web.destroy(); web = null; }
        remote.shutdownNow(); storage.shutdown(); super.onDestroy();
    }
}
