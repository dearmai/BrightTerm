package kr.balkeunter.brightterm;

import android.content.Context;
import android.content.SharedPreferences;
import com.jcraft.jsch.Session;
import org.json.JSONObject;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 원격 데스크톱 연결 — 경로(직접 / 점프 호스트 / 이 서버의 SSH 터널) 열기, 허용 상태 확인, 인증서 신뢰, 중계 등록.
 * 데스크톱 src/main/rdp/index.ts 의 내장 연결과 같은 순서: 경로 → 확인 → 인증서 신뢰 → 토큰 → 화면.
 */
final class RdpSessions {
    interface Trust { boolean ask(String hostPort, String fingerprint, String old); }
    interface Events { void log(String token, String message); }

    final RdpGateway gateway = new RdpGateway();
    private final TerminalService service;
    private final SharedPreferences known;
    /** 토큰 → 화면에 넘길 정보(비밀번호 포함 — IronRDP 가 CredSSP 에 넣는다) */
    private final Map<String, JSONObject> infos = new ConcurrentHashMap<>();
    private final Map<String, String> hostOf = new ConcurrentHashMap<>();
    private final java.util.Set<String> opening = ConcurrentHashMap.newKeySet();
    private final java.util.Set<String> active = ConcurrentHashMap.newKeySet();

    synchronized String beginOpen() {
        String ticket = java.util.UUID.randomUUID().toString();
        opening.add(ticket); service.sessionsChanged(); return ticket;
    }
    void endOpen(String ticket) { opening.remove(ticket); service.sessionsChanged(); }
    int activeCount() { return opening.size() + active.size(); }
    synchronized boolean state(String token, boolean connected) {
        if (!infos.containsKey(token)) return false;
        if (connected) active.add(token); else active.remove(token);
        service.sessionsChanged(); return true;
    }
    /** 15비트로 멈춘 서버 — 앱을 켜 둔 동안 16비트로 */
    private final Map<String, Integer> depthFallback = new ConcurrentHashMap<>();

    RdpSessions(TerminalService service) {
        this.service = service;
        this.known = service.getSharedPreferences("rdp-known-hosts", Context.MODE_PRIVATE);
    }

    static JSONObject options(JSONObject profile) throws Exception {
        JSONObject o = new JSONObject().put("mode", "builtin").put("port", 3389).put("auth", "host").put("clipboard", true)
            .put("resolution", "window").put("route", "direct");
        JSONObject r = profile.optJSONObject("rdp");
        if (r != null) for (java.util.Iterator<String> k = r.keys(); k.hasNext();) { String key = k.next(); o.put(key, r.get(key)); }
        return o;
    }

    static boolean capable(JSONObject profile) { return "windows".equals(profile.optString("os")) && !profile.optString("host").trim().isEmpty(); }

    private static String name(JSONObject p) { String n = p.optString("name"); return n.isEmpty() ? p.optString("host") : n; }

    /** jump: 점프 호스트 프로필(없으면 null) */
    RdpGateway.Route route(JSONObject profile, JSONObject jump, Rdp.Log log) throws Exception {
        JSONObject o = options(profile);
        String host = profile.getString("host").trim();
        int port = o.optInt("port", 3389);
        String target = RdpGateway.hostPort(host, port);
        if ("ssh".equals(o.optString("route"))) {
            if (!profile.optBoolean("directSsh", true)) throw new IllegalArgumentException("이 서버의 SSH 는 점프 호스트·프록시를 거쳐야 해서 Android 에서 SSH 터널을 쓸 수 없습니다");
            Session s = service.prepareSession(profile, name(profile), log, () -> false);
            s.connect(25000);
            try { return RdpGateway.viaSsh(s, "SSH 터널 (" + name(profile) + ") → 127.0.0.1:" + port, "127.0.0.1", port, target); }
            catch (Exception e) { s.disconnect(); throw e; }
        }
        if (jump != null) {
            if (!jump.optBoolean("directSsh", true)) throw new IllegalArgumentException("점프 호스트(" + name(jump) + ")가 다시 점프 호스트를 거칩니다 — Android 는 한 단계만 지원합니다");
            Session s = service.prepareSession(jump, name(jump), log, () -> false);
            s.connect(25000);
            try { return RdpGateway.viaSsh(s, "점프 호스트 " + name(jump) + " → " + target, host, port, target); }
            catch (Exception e) { s.disconnect(); throw e; }
        }
        return RdpGateway.direct(host, port);
    }

    private static String cookieUser(JSONObject profile, JSONObject o) {
        String u = o.optString("username", "");
        return u.isEmpty() ? profile.optString("username", "") : u;
    }

    JSONObject check(JSONObject profile, JSONObject jump) throws Exception {
        RdpGateway.Route route;
        try { route = route(profile, jump, m -> { }); }
        catch (Exception e) {
            String[] d = RdpGateway.describe(e);
            return new JSONObject().put("state", d[0]).put("message", d[1]).put("route", jump != null ? "점프 호스트 " + name(jump) : "SSH 터널").put("checkedAt", System.currentTimeMillis());
        }
        try { return RdpGateway.check(route, cookieUser(profile, options(profile)), profile.optString("host")); }
        finally { route.close(); }
    }

    /** 패처 값 — 색 깊이·화면 효과·소리(내장은 이 PC 재생이 없어 원격/끔) */
    static JSONObject patchOf(JSONObject o, Integer fallback) throws Exception {
        int depth = o.optInt("colorDepth", 32);
        if (fallback != null && depth == 15) depth = fallback;
        return new JSONObject().put("colorDepth", depth).put("perf", Rdp.perfFlags(o.optJSONObject("experience")))
            .put("audio", "remote".equals(o.optString("audio")) ? "remote" : "off");
    }

    /**
     * 연결 준비 — 성공하면 토큰. creds: username·password·domain. current: 접속마다 최신 프로필을 읽는다
     */
    String open(String ticket, JSONObject profile, JSONObject jump, JSONObject creds, Trust trust, Events events, java.util.function.Supplier<JSONObject> current, boolean light) throws Exception {
        if (!opening.contains(ticket)) throw new IllegalStateException("원격 데스크톱 연결이 취소되었습니다");
        JSONObject o = options(profile);
        String id = profile.getString("id");
        RdpGateway.Route route = route(profile, jump, m -> { });
        boolean handed = false;
        try {
            JSONObject check = RdpGateway.check(route, cookieUser(profile, o), profile.optString("host"));
            if (!"ok".equals(check.optString("state"))) throw new IllegalStateException(name(profile) + ": " + check.optString("message"));
            String fp = check.optString("fingerprint");
            if (fp.isEmpty()) throw new IllegalStateException(name(profile) + ": " + check.optString("message", "내장 연결은 TLS·NLA 를 쓰는 서버만 지원합니다"));
            String key = "rdp://" + profile.getString("host").trim() + ":" + o.optInt("port", 3389);
            String old = known.getString(key, null);
            if (!fp.equals(old)) {
                if (!trust.ask(key, fp, old)) throw new IllegalStateException("서버 인증서를 신뢰하지 않아 연결을 취소했습니다");
                known.edit().putString(key, fp).apply();
            }
            String token = RdpGateway.newToken();
            int port = gateway.port();
            JSONObject info = new JSONObject()
                .put("title", name(profile)).put("hostId", id)
                .put("wsUrl", "ws://127.0.0.1:" + port + "/rdp/" + token).put("token", token)
                .put("destination", route.target())
                .put("username", creds.optString("username")).put("domain", creds.optString("domain")).put("password", creds.optString("password"))
                .put("route", route.label()).put("security", check.optString("security"))
                .put("theme", light ? "light" : "dark")
                .put("options", view(o));
            synchronized (this) {
                if (!opening.contains(ticket)) throw new IllegalStateException("원격 데스크톱 연결이 취소되었습니다");
                gateway.register(new RdpGateway.Target(token, route, fp, profile.optString("host"), () -> {
                    try {
                        JSONObject now = current.get();
                        return patchOf(options(now == null ? profile : now), depthFallback.get(id));
                    } catch (Exception e) { return new JSONObject(); }
                }, m -> events.log(token, m)));
                infos.put(token, info); hostOf.put(token, id);
                active.add(token);
                handed = true;
            }
            return token;
        } finally { if (!handed) route.close(); }
    }

    /** 화면 위 막대·설정 패널 값 */
    static JSONObject view(JSONObject o) throws Exception {
        JSONObject e = new JSONObject().put("wallpaper", true).put("themes", true).put("fontSmoothing", true).put("composition", true)
            .put("windowDrag", true).put("animations", true).put("cursorShadow", true);
        JSONObject x = o.optJSONObject("experience");
        if (x != null) for (java.util.Iterator<String> k = x.keys(); k.hasNext();) { String key = k.next(); e.put(key, x.getBoolean(key)); }
        return new JSONObject().put("scale", o.optString("scale", "fit")).put("dpi", o.optInt("dpi", 100))
            .put("unicodeKeyboard", o.optBoolean("unicodeKeyboard", false)).put("clipboard", o.optBoolean("clipboard", true))
            .put("resolution", o.optString("resolution", "window")).put("colorDepth", o.optInt("colorDepth", 32))
            .put("audio", "remote".equals(o.optString("audio")) ? "remote" : "off").put("experience", e);
    }

    JSONObject info(String token, JSONObject latest) throws Exception {
        JSONObject i = infos.get(token);
        if (i == null) throw new IllegalArgumentException("원격 데스크톱 세션이 없습니다");
        if (latest != null) {
            i.put("options", view(options(latest)));
            Integer fb = depthFallback.get(i.getString("hostId"));
            if (fb != null && options(latest).optInt("colorDepth", 32) == 15) i.put("depthFallback", fb); else i.remove("depthFallback");
        }
        return i;
    }

    String hostId(String token) { return hostOf.get(token); }
    void fallback(String token) { String h = hostOf.get(token); if (h != null) depthFallback.put(h, 16); }
    void clearFallback(String hostId) { depthFallback.remove(hostId); }

    synchronized void close(String token) { infos.remove(token); hostOf.remove(token); active.remove(token); gateway.unregister(token); service.sessionsChanged(); }
    synchronized void closeAll() { opening.clear(); active.clear(); infos.clear(); hostOf.clear(); gateway.closeAll(); service.sessionsChanged(); }
}
