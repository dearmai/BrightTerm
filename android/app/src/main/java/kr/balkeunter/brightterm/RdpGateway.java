package kr.balkeunter.brightterm;

import android.annotation.SuppressLint;
import android.util.Base64;
import com.jcraft.jsch.Session;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.*;
import java.util.concurrent.*;
import javax.net.ssl.*;

/**
 * 내장 원격 데스크톱 중계 — WebView 의 IronRDP 가 ws://127.0.0.1:<port>/rdp/<token> 으로 붙는다(RDCleanPath).
 * 데스크톱 src/main/rdp/gateway.ts·route.ts 와 같은 동작: X.224 → TLS(인증서 지문 고정) → 그대로 잇기.
 * 같은 기기의 다른 앱도 127.0.0.1 에 닿으므로 창마다 무작위 토큰과 앱 자산 출처(Origin)를 확인한다.
 */
final class RdpGateway {
    static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int CONNECT_TIMEOUT = 10000;

    interface Route {
        String label();
        /** 표시용 목적지·인증서 신뢰 키 */
        String target();
        Socket connect() throws IOException;
        void close();
    }

    static final class Target {
        final String token; final Route route; final String fingerprint; final String servername;
        /** 접속마다 다시 읽는 색 깊이·화면 효과·소리 */
        final java.util.function.Supplier<JSONObject> patch;
        final Rdp.Log log;
        Target(String token, Route route, String fingerprint, String servername, java.util.function.Supplier<JSONObject> patch, Rdp.Log log) {
            this.token = token; this.route = route; this.fingerprint = fingerprint; this.servername = servername; this.patch = patch; this.log = log;
        }
    }

    /** 디버그 빌드 테스트용 — 15비트 접속을 Connect-Initial 뒤에서 멈춘다 */
    static volatile boolean testStall15;
    private final Map<String, Target> targets = new ConcurrentHashMap<>();
    private final Map<String, Set<Socket>> live = new ConcurrentHashMap<>();
    private final ExecutorService threads = Executors.newCachedThreadPool();
    private ServerSocket server;

    synchronized int port() throws IOException {
        if (server != null && !server.isClosed()) return server.getLocalPort();
        server = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        final ServerSocket s = server;
        threads.execute(() -> {
            while (!s.isClosed()) {
                try { Socket c = s.accept(); threads.execute(() -> handle(c)); }
                catch (IOException error) { if (s.isClosed()) return; }
            }
        });
        return server.getLocalPort();
    }

    static String newToken() {
        byte[] b = new byte[24]; new SecureRandom().nextBytes(b);
        return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    void register(Target t) { targets.put(t.token, t); }

    void unregister(String token) {
        Target t = targets.remove(token);
        Set<Socket> set = live.remove(token);
        if (set != null) for (Socket s : set) closeQuietly(s);
        if (t != null) t.route.close();
    }

    void closeAll() { for (String t : new ArrayList<>(targets.keySet())) unregister(t); }

    // ------------------------------------------------------------ 경로

    static Route direct(String host, int port) {
        String target = hostPort(host, port);
        return new Route() {
            public String label() { return "직접 " + target; }
            public String target() { return target; }
            public Socket connect() throws IOException {
                Socket s = new Socket(); s.setTcpNoDelay(true);
                s.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT);
                return s;
            }
            public void close() { }
        };
    }

    /** SSH 세션의 로컬 포워딩(127.0.0.1:임의 포트 → host:port)으로 잇는다 — 점프 호스트·이 서버의 SSH 터널 */
    static Route viaSsh(Session session, String label, String host, int port, String display) throws Exception {
        int local = session.setPortForwardingL("127.0.0.1", 0, host, port);
        return new Route() {
            public String label() { return label; }
            public String target() { return display; }
            public Socket connect() throws IOException {
                Socket s = new Socket(); s.setTcpNoDelay(true);
                s.connect(new InetSocketAddress("127.0.0.1", local), CONNECT_TIMEOUT);
                return s;
            }
            public void close() { try { session.delPortForwardingL("127.0.0.1", local); } catch (Exception ignored) { } session.disconnect(); }
        };
    }

    static String hostPort(String h, int p) { return h.contains(":") ? "[" + h + "]:" + p : h + ":" + p; }

    // ------------------------------------------------------------ 협상

    static final class Negotiated {
        Socket raw; SSLSocket tls; byte[] x224; Rdp.Confirm confirm; boolean legacy;
        InputStream in() throws IOException { return tls != null ? tls.getInputStream() : raw.getInputStream(); }
        OutputStream out() throws IOException { return tls != null ? tls.getOutputStream() : raw.getOutputStream(); }
        void close() { closeQuietly(tls); closeQuietly(raw); }
    }

    private static byte[] readTpkt(InputStream in) throws IOException {
        byte[] head = readFully(in, 4);
        int len = Rdp.tpktLength(head, 4);
        if (len < 0) throw new IOException("RDP 서버가 아닙니다 (TPKT 아님)");
        if (len < 4 || len > 65535) throw new IOException("잘못된 TPKT 길이");
        byte[] all = new byte[len];
        System.arraycopy(head, 0, all, 0, 4);
        byte[] rest = readFully(in, len - 4);
        System.arraycopy(rest, 0, all, 4, rest.length);
        return all;
    }

    private static byte[] readFully(InputStream in, int n) throws IOException {
        byte[] b = new byte[n]; int o = 0;
        while (o < n) { int k = in.read(b, o, n - o); if (k < 0) throw new EOFException("서버가 연결을 끊었습니다"); o += k; }
        return b;
    }

    /** RDP 서버 인증서는 대부분 자체 서명 — 체인 검증 대신 지문을 신뢰 목록과 맞춘다(호출한 쪽) */
    @SuppressLint({"TrustAllX509TrustManager", "CustomX509TrustManager"})
    private static SSLSocketFactory trustAll() throws Exception {
        TrustManager[] tm = { new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] c, String a) { }
            public void checkServerTrusted(X509Certificate[] c, String a) { }
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        } };
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, tm, new SecureRandom());
        return ctx.getSocketFactory();
    }

    /**
     * Windows RDP 자체 서명 인증서는 keyUsage 에 digitalSignature 가 없어 BoringSSL(Conscrypt)이 ECDHE·TLS 1.3 에서 끊는다
     * (KEY_USAGE_BIT_INCORRECT) — 그러면 새 연결로 TLS 1.2 RSA 키 교환으로 맺는다
     */
    private static final String[] LEGACY = { "TLS_RSA_WITH_AES_256_GCM_SHA384", "TLS_RSA_WITH_AES_128_GCM_SHA256", "TLS_RSA_WITH_AES_256_CBC_SHA", "TLS_RSA_WITH_AES_128_CBC_SHA" };

    static Negotiated negotiate(Route route, byte[] request, String servername, Rdp.Log log) throws Exception {
        try { return once(route, request, servername, false); }
        catch (SSLException error) {
            log.add("TLS 다시 시도 (TLS 1.2 RSA 키 교환): " + error.getMessage());
            try { return once(route, request, servername, true); }
            catch (SSLException again) { throw new SSLException("서버 인증서의 키 용도(keyUsage)가 TLS 와 맞지 않습니다 — RSA 키 교환으로도 실패: " + again.getMessage()); }
        }
    }

    private static Negotiated once(Route route, byte[] request, String servername, boolean legacy) throws Exception {
        Negotiated n = new Negotiated();
        n.raw = route.connect();
        try {
            n.raw.setSoTimeout(CONNECT_TIMEOUT);
            n.raw.getOutputStream().write(request); n.raw.getOutputStream().flush();
            n.x224 = readTpkt(n.raw.getInputStream());
            n.confirm = Rdp.parseConfirm(n.x224);
            if (!Rdp.needsTls(n.confirm)) { n.raw.setSoTimeout(0); return n; }
            boolean ip = servername == null || servername.matches("[0-9.:\\[\\]]+");
            SSLSocket tls = (SSLSocket)trustAll().createSocket(n.raw, ip ? "" : servername, n.raw.getPort(), true);
            if (legacy) {
                tls.setEnabledProtocols(new String[]{"TLSv1.2"});
                List<String> supported = Arrays.asList(tls.getSupportedCipherSuites()), use = new ArrayList<>();
                for (String c : LEGACY) if (supported.contains(c)) use.add(c);
                if (!use.isEmpty()) tls.setEnabledCipherSuites(use.toArray(new String[0]));
            }
            tls.setSoTimeout(CONNECT_TIMEOUT);
            tls.startHandshake();
            tls.setSoTimeout(0);
            n.tls = tls; n.legacy = legacy;
            return n;
        } catch (Exception error) { n.close(); throw error; }
    }

    static List<byte[]> chain(SSLSocket tls) throws Exception {
        List<byte[]> out = new ArrayList<>();
        for (Certificate c : tls.getSession().getPeerCertificates()) out.add(c.getEncoded());
        return out;
    }

    static String fingerprint(byte[] der) throws Exception {
        return "SHA256:" + Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(der), Base64.NO_WRAP | Base64.NO_PADDING);
    }

    /** 오류 → 상태·문구 (데스크톱 describeError 와 같은 분류) */
    static String[] describe(Exception e) {
        String m = e.getMessage() == null ? e.toString() : e.getMessage();
        if (e instanceof ConnectException || m.contains("ECONNREFUSED") || m.toLowerCase(Locale.ROOT).contains("refused")) return new String[]{"closed", "RDP 포트가 닫혀 있습니다 — 원격 데스크톱이 꺼져 있거나 방화벽이 막고 있습니다"};
        if (e instanceof SocketTimeoutException || m.toLowerCase(Locale.ROOT).contains("timed out")) return new String[]{"timeout", "응답이 없습니다 — 방화벽이 막고 있거나 서버가 꺼져 있습니다 (" + m + ")"};
        if (e instanceof UnknownHostException) return new String[]{"error", "서버 주소를 찾을 수 없습니다 (DNS)"};
        if (e instanceof NoRouteToHostException) return new String[]{"error", "서버로 가는 네트워크 경로가 없습니다"};
        if (e instanceof EOFException || m.contains("reset")) return new String[]{"error", "서버가 연결을 끊었습니다 — RDP 가 아닌 포트이거나 접속을 제한하고 있습니다"};
        return new String[]{"error", m};
    }

    /** RDP 허용 상태 확인 — 로그인은 하지 않는다 */
    static JSONObject check(Route route, String username, String servername) throws Exception {
        long started = System.currentTimeMillis();
        JSONObject r = new JSONObject().put("route", route.label()).put("checkedAt", started);
        Negotiated n = null;
        try {
            n = negotiate(route, Rdp.connectionRequest(Rdp.PROTOCOL_SSL | Rdp.PROTOCOL_HYBRID | Rdp.PROTOCOL_HYBRID_EX, username), servername, m -> { });
            r.put("latencyMs", System.currentTimeMillis() - started);
            if (n.confirm.kind == 1) return r.put("state", "refused").put("message", Rdp.failureLabel(n.confirm.code));
            if (n.tls == null) return r.put("state", "ok").put("message", "RDP 허용됨 — 표준 RDP 보안만 지원하는 서버라 내장 연결은 쓸 수 없습니다").put("security", Rdp.protocolLabel(0));
            List<byte[]> certs = chain(n.tls);
            r.put("state", "ok").put("message", "RDP 허용됨").put("security", Rdp.protocolLabel(n.confirm.protocol) + (n.legacy ? " (TLS 1.2 RSA)" : ""));
            if (!certs.isEmpty()) r.put("fingerprint", fingerprint(certs.get(0)));
            return r;
        } catch (Exception error) {
            String[] d = describe(error);
            return r.put("state", d[0]).put("message", d[1]);
        } finally { if (n != null) n.close(); }
    }

    // ------------------------------------------------------------ WebSocket (RFC 6455, 필요한 만큼)

    private void handle(Socket c) {
        String token = null;
        try {
            c.setTcpNoDelay(true);
            InputStream in = new BufferedInputStream(c.getInputStream());
            OutputStream out = c.getOutputStream();
            String head = readHead(in);
            String[] lines = head.split("\r\n");
            String[] first = lines[0].split(" ");
            Map<String, String> h = new HashMap<>();
            for (int i = 1; i < lines.length; i++) { int k = lines[i].indexOf(':'); if (k > 0) h.put(lines[i].substring(0, k).trim().toLowerCase(Locale.ROOT), lines[i].substring(k + 1).trim()); }
            String path = first.length > 1 ? first[1] : "";
            token = path.startsWith("/rdp/") ? path.substring(5) : "";
            Target t = targets.get(token);
            String key = h.get("sec-websocket-key");
            if (t == null || key == null || !"websocket".equalsIgnoreCase(h.getOrDefault("upgrade", "")) || !ORIGIN.equals(h.get("origin"))) {
                out.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                c.close(); return;
            }
            String accept = Base64.encodeToString(MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)), Base64.NO_WRAP);
            String proto = h.get("sec-websocket-protocol");
            out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n"
                + (proto != null ? "Sec-WebSocket-Protocol: " + proto.split(",")[0].trim() + "\r\n" : "") + "\r\n").getBytes(StandardCharsets.US_ASCII));
            out.flush();
            live.computeIfAbsent(token, x -> ConcurrentHashMap.newKeySet()).add(c);
            relay(t, c, in, out);
        } catch (Exception ignored) {
        } finally {
            closeQuietly(c);
            if (token != null) { Set<Socket> set = live.get(token); if (set != null) set.remove(c); }
        }
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int s = 0, x;
        while ((x = in.read()) != -1) {
            b.write(x);
            s = (x == '\r' && (s == 0 || s == 2)) ? s + 1 : (x == '\n' && (s == 1 || s == 3)) ? s + 1 : 0;
            if (s == 4) return b.toString("ISO-8859-1");
            if (b.size() > 8192) throw new IOException("요청 머리가 너무 깁니다");
        }
        throw new EOFException();
    }

    private static final class Ws {
        final InputStream in; final OutputStream out;
        Ws(InputStream in, OutputStream out) { this.in = in; this.out = out; }
        /** 다음 데이터 프레임의 내용 — 닫히면 null. 핑에는 바로 답한다 */
        byte[] read() throws IOException {
            while (true) {
                int b0 = in.read(), b1 = in.read();
                if (b0 < 0 || b1 < 0) return null;
                int op = b0 & 0x0f; boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7f;
                if (len == 126) { byte[] l = readFully(in, 2); len = ((l[0] & 0xff) << 8) | (l[1] & 0xff); }
                else if (len == 127) { byte[] l = readFully(in, 8); len = 0; for (byte v : l) len = (len << 8) | (v & 0xff); }
                if (len > 16 * 1024 * 1024) throw new IOException("프레임이 너무 큽니다");
                byte[] mask = masked ? readFully(in, 4) : null;
                byte[] p = readFully(in, (int)len);
                if (mask != null) for (int i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
                if (op == 8) { send(8, new byte[0]); return null; }
                if (op == 9) { send(10, p); continue; }
                if (op == 10) continue;
                return p;
            }
        }
        synchronized void send(int op, byte[] p) throws IOException { send(op, p, 0, p.length); }
        synchronized void send(int op, byte[] p, int off, int n) throws IOException {
            ByteArrayOutputStream h = new ByteArrayOutputStream(10);
            h.write(0x80 | op);
            if (n < 126) h.write(n);
            else if (n < 65536) { h.write(126); h.write(n >> 8); h.write(n & 0xff); }
            else { h.write(127); for (int i = 7; i >= 0; i--) h.write((int)(((long)n >> (8 * i)) & 0xff)); }
            out.write(h.toByteArray()); out.write(p, off, n); out.flush();
        }
    }

    private static final Map<String, Integer> WSA = Map.of("refused", 10061, "timed out", 10060, "unreachable", 10065, "reset", 10054);

    private void relay(Target t, Socket client, InputStream in, OutputStream out) throws Exception {
        Ws ws = new Ws(in, out);
        Rdp.Log log = t.log;
        ByteArrayOutputStream pending = new ByteArrayOutputStream();
        byte[] raw = null;
        while (raw == null) {
            byte[] m = ws.read();
            if (m == null) return;
            pending.write(m, 0, m.length);
            byte[] all = pending.toByteArray();
            int len = Rdp.derLength(all, all.length);
            if (len > 0 && all.length >= len) {
                raw = Arrays.copyOf(all, len);
                pending.reset(); pending.write(all, len, all.length - len);
            }
        }
        Rdp.CleanPath req = Rdp.decode(raw);
        if (!t.token.equals(req.proxyAuth) || req.x224 == null) { error(ws, Rdp.GENERAL_ERROR, null, null, null); return; }
        log.add("서버에 연결 중 — " + t.route.label());
        Negotiated n;
        try { n = negotiate(t.route, req.x224, t.servername, log); }
        catch (SSLException e) { log.add("TLS 실패: " + e.getMessage()); error(ws, Rdp.TLS_FAILED, null, 40, null); return; }
        catch (Exception e) {
            log.add("연결 실패: " + describe(e)[1]);
            Integer wsa = null; String msg = String.valueOf(e.getMessage()).toLowerCase(Locale.ROOT);
            for (Map.Entry<String, Integer> w : WSA.entrySet()) if (msg.contains(w.getKey())) wsa = w.getValue();
            if (e instanceof ConnectException) wsa = 10061; else if (e instanceof SocketTimeoutException) wsa = 10060;
            error(ws, Rdp.TARGET_UNREACHABLE, wsa, null, null); return;
        }
        try {
            if (n.confirm.kind == 1) { error(ws, Rdp.NEGOTIATION_ERROR, null, null, n.x224); return; }
            List<byte[]> certs = new ArrayList<>();
            if (n.tls != null) {
                certs = chain(n.tls);
                String fp = certs.isEmpty() ? "" : fingerprint(certs.get(0));
                if (t.fingerprint != null && !t.fingerprint.equals(fp)) { log.add("서버 인증서가 확인한 것과 다릅니다 (" + fp + ")"); error(ws, Rdp.TLS_FAILED, null, 42, null); return; }
            }
            log.add("협상 완료 — " + (n.confirm.kind == 0 ? Rdp.protocolLabel(n.confirm.protocol) : "표준 RDP") + (n.tls != null ? " · " + n.tls.getSession().getProtocol() + " " + n.tls.getSession().getCipherSuite() : ""));
            Rdp.CleanPath res = new Rdp.CleanPath();
            res.serverAddr = t.route.target(); res.x224 = n.x224; res.certs = certs;
            ws.send(2, Rdp.encode(res));
            JSONObject p = t.patch.get();
            int depth = p.optInt("colorDepth", 32);
            Rdp.Patcher patcher = new Rdp.Patcher(depth, p.optInt("perf", 0x180), p.optString("audio", "off"), log);
            // 테스트용: 15비트 Connect-Initial 뒤로 멈추는 Windows 를 흉내 낸다
            boolean stall15 = depth == 15 && BuildConfig.DEBUG && testStall15;
            InputStream up = n.in(); OutputStream down = n.out();
            long[] sent = {0}, recv = {0};
            Future<?> pump = threads.submit(() -> {
                byte[] b = new byte[16384]; int k; boolean first = true;
                try {
                    while ((k = up.read(b)) != -1) {
                        recv[0] += k;
                        if (first && sent[0] > 0) { first = false; log.add("서버 응답 받는 중"); }
                        ws.send(2, b, 0, k);
                    }
                    log.add("서버가 연결을 닫았습니다 (보냄 " + sent[0] + " · 받음 " + recv[0] + " 바이트)");
                } catch (IOException ignored) { }
                closeQuietly(client);
            });
            byte[] rest = pending.toByteArray();
            boolean stalled = false;
            List<byte[]> queue = new ArrayList<>();
            if (rest.length > 0) queue.add(rest);
            while (true) {
                byte[] m = queue.isEmpty() ? ws.read() : queue.remove(0);
                if (m == null) break;
                if (stalled) continue;
                if (sent[0] == 0) log.add("인증(NLA·CredSSP) 시작");
                sent[0] += m.length;
                byte[] o = patcher.done() ? m : patcher.push(m, m.length);
                if (o.length > 0) { down.write(o); down.flush(); }
                if (stall15 && patcher.coreSeen()) stalled = true;
            }
            pump.cancel(true);
        } finally { n.close(); }
    }

    private static void error(Ws ws, int code, Integer wsa, Integer tls, byte[] x224) {
        try {
            Rdp.CleanPath e = new Rdp.CleanPath();
            e.errorCode = code; e.wsaError = wsa; e.tlsAlert = tls; e.x224 = x224;
            ws.send(2, Rdp.encode(e)); ws.send(8, new byte[0]);
        } catch (IOException ignored) { }
    }

    static void closeQuietly(Closeable c) { if (c != null) try { c.close(); } catch (IOException ignored) { } }
}
