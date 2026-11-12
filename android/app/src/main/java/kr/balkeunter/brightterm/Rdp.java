package kr.balkeunter.brightterm;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * RDP 보조 — 데스크톱 src/shared/rdp.ts 와 같은 동작.
 * X.224 협상 PDU, RDCleanPath(IronRDP 웹 클라이언트 ↔ 중계) DER, 클라이언트 접속 PDU 의 색 깊이·화면 효과·소리 고치기.
 */
final class Rdp {
    private Rdp() {}

    static final int PROTOCOL_SSL = 1, PROTOCOL_HYBRID = 2, PROTOCOL_HYBRID_EX = 8;
    static final int RDCLEANPATH_VERSION = 3390;
    static final int GENERAL_ERROR = 1, NEGOTIATION_ERROR = 2, TARGET_UNREACHABLE = 103, TLS_FAILED = 105;

    // ------------------------------------------------------------ X.224

    static byte[] connectionRequest(int requested, String cookieUser) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        String user = cookieUser == null ? "" : cookieUser.replaceAll("[^\\x20-\\x7e]", "");
        if (user.length() > 9) user = user.substring(0, 9);
        byte[] cookie = user.isEmpty() ? new byte[0] : ("Cookie: mstshash=" + user + "\r\n").getBytes(StandardCharsets.US_ASCII);
        int li = 6 + cookie.length + 8;
        body.write(li); body.write(0xe0); body.write(0); body.write(0); body.write(0); body.write(0); body.write(0);
        body.write(cookie, 0, cookie.length);
        body.write(1); body.write(0); body.write(8); body.write(0);
        body.write(requested & 0xff); body.write((requested >> 8) & 0xff); body.write((requested >> 16) & 0xff); body.write((requested >>> 24) & 0xff);
        byte[] b = body.toByteArray();
        byte[] out = new byte[4 + b.length];
        out[0] = 3; out[1] = 0; out[2] = (byte)(out.length >> 8); out[3] = (byte)out.length;
        System.arraycopy(b, 0, out, 4, b.length);
        return out;
    }

    /** TPKT 길이 — 0: 더 받아야 함, -1: TPKT 아님 */
    static int tpktLength(byte[] b, int len) {
        if (len < 1) return 0;
        if ((b[0] & 0xff) != 3) return -1;
        if (len < 4) return 0;
        return ((b[2] & 0xff) << 8) | (b[3] & 0xff);
    }

    /** kind: 0 선택됨(protocol), 1 실패(code), 2 협상 없음 */
    static final class Confirm { int kind, protocol, code; }

    static Confirm parseConfirm(byte[] p) {
        if (p.length < 11 || (p[0] & 0xff) != 3 || (p[5] & 0xf0) != 0xd0) throw new IllegalArgumentException("X.224 Connection Confirm 이 아닙니다");
        Confirm c = new Confirm();
        if (p.length < 19) { c.kind = 2; return c; }
        int type = p[11] & 0xff;
        int value = (p[15] & 0xff) | ((p[16] & 0xff) << 8) | ((p[17] & 0xff) << 16) | ((p[18] & 0xff) << 24);
        if (type == 2) { c.kind = 0; c.protocol = value; }
        else if (type == 3) { c.kind = 1; c.code = value; }
        else c.kind = 2;
        return c;
    }

    static boolean needsTls(Confirm c) { return c.kind == 0 && (c.protocol & (PROTOCOL_SSL | PROTOCOL_HYBRID | PROTOCOL_HYBRID_EX)) != 0; }

    static String protocolLabel(int p) {
        if ((p & PROTOCOL_HYBRID_EX) != 0) return "NLA (CredSSP, Early User Auth)";
        if ((p & PROTOCOL_HYBRID) != 0) return "NLA (CredSSP)";
        if ((p & PROTOCOL_SSL) != 0) return "TLS";
        return "표준 RDP 보안";
    }

    static String failureLabel(int code) {
        switch (code) {
            case 1: return "서버가 TLS 를 요구합니다 (SSL_REQUIRED_BY_SERVER)";
            case 2: return "서버가 TLS 를 허용하지 않습니다 — 표준 RDP 보안만 씁니다 (SSL_NOT_ALLOWED_BY_SERVER)";
            case 3: return "서버에 RDP 인증서가 없습니다 (SSL_CERT_NOT_ON_SERVER)";
            case 4: return "협상 플래그가 맞지 않습니다 (INCONSISTENT_FLAGS)";
            case 5: return "서버가 NLA(CredSSP) 를 요구합니다 (HYBRID_REQUIRED_BY_SERVER)";
            case 6: return "서버가 TLS 사용자 인증서를 요구합니다 (SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER)";
            default: return "협상 실패 (코드 " + code + ")";
        }
    }

    // ------------------------------------------------------------ RDCleanPath (DER, EXPLICIT 문맥 태그)

    static final class CleanPath {
        int version = RDCLEANPATH_VERSION;
        Integer errorCode, httpStatus, wsaError, tlsAlert;
        String destination, proxyAuth, serverAuth, preconnection, serverAddr;
        byte[] x224;
        List<byte[]> certs;
    }

    /** 전체 길이 — 0: 더 받아야 함 */
    static int derLength(byte[] b, int len) {
        if (len < 2) return 0;
        if ((b[0] & 0xff) != 0x30) throw new IllegalArgumentException("RDCleanPath 가 아닙니다");
        int l = b[1] & 0xff;
        if (l < 0x80) return 2 + l;
        int n = l & 0x7f;
        if (n < 1 || n > 3) throw new IllegalArgumentException("RDCleanPath 길이 형식 오류");
        if (len < 2 + n) return 0;
        int v = 0;
        for (int i = 0; i < n; i++) v = (v << 8) | (b[2 + i] & 0xff);
        return 2 + n + v;
    }

    private static final class Der {
        final byte[] b; int i; final int end;
        Der(byte[] b, int start, int end) { this.b = b; this.i = start; this.end = end; }
        boolean more() { return i < end; }
        int tag() { return b[i++] & 0xff; }
        int len() {
            int l = b[i++] & 0xff;
            if (l < 0x80) return l;
            int n = l & 0x7f, v = 0;
            for (int k = 0; k < n; k++) v = (v << 8) | (b[i++] & 0xff);
            return v;
        }
    }

    static CleanPath decode(byte[] raw) {
        Der top = new Der(raw, 0, raw.length);
        if (top.tag() != 0x30) throw new IllegalArgumentException("RDCleanPath 가 아닙니다");
        int l = top.len();
        Der seq = new Der(raw, top.i, top.i + l);
        CleanPath p = new CleanPath();
        while (seq.more()) {
            int t = seq.tag(), n = seq.len(), start = seq.i;
            Der inner = new Der(raw, start, start + n);
            int it = inner.tag(), in = inner.len(), at = inner.i;
            byte[] v = java.util.Arrays.copyOfRange(raw, at, at + in);
            switch (t) {
                case 0xa0: p.version = intOf(v); break;
                case 0xa2: p.destination = new String(v, StandardCharsets.UTF_8); break;
                case 0xa3: p.proxyAuth = new String(v, StandardCharsets.UTF_8); break;
                case 0xa4: p.serverAuth = new String(v, StandardCharsets.UTF_8); break;
                case 0xa5: p.preconnection = new String(v, StandardCharsets.UTF_8); break;
                case 0xa6: p.x224 = v; break;
                case 0xa9: p.serverAddr = new String(v, StandardCharsets.UTF_8); break;
                default: break;
            }
            seq.i = start + n;
        }
        return p;
    }

    private static int intOf(byte[] v) { int x = 0; for (byte c : v) x = (x << 8) | (c & 0xff); return x; }

    private static byte[] tlv(int tag, byte[] value) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(tag);
        int n = value.length;
        if (n < 0x80) o.write(n);
        else if (n < 0x100) { o.write(0x81); o.write(n); }
        else if (n < 0x10000) { o.write(0x82); o.write(n >> 8); o.write(n & 0xff); }
        else { o.write(0x83); o.write(n >> 16); o.write((n >> 8) & 0xff); o.write(n & 0xff); }
        o.write(value, 0, n);
        return o.toByteArray();
    }

    private static byte[] derInt(int v) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] full = { (byte)(v >>> 24), (byte)(v >>> 16), (byte)(v >>> 8), (byte)v };
        int s = 0;
        while (s < 3 && full[s] == 0 && (full[s + 1] & 0x80) == 0) s++;
        o.write(full, s, 4 - s);
        return tlv(0x02, o.toByteArray());
    }

    private static byte[] ctx(int n, byte[] inner) { return tlv(0xa0 | n, inner); }

    static byte[] encode(CleanPath p) {
        ByteArrayOutputStream f = new ByteArrayOutputStream();
        put(f, ctx(0, derInt(p.version)));
        if (p.errorCode != null) {
            ByteArrayOutputStream e = new ByteArrayOutputStream();
            put(e, ctx(0, derInt(p.errorCode)));
            if (p.httpStatus != null) put(e, ctx(1, derInt(p.httpStatus)));
            if (p.wsaError != null) put(e, ctx(2, derInt(p.wsaError)));
            if (p.tlsAlert != null) put(e, ctx(3, derInt(p.tlsAlert)));
            put(f, ctx(1, tlv(0x30, e.toByteArray())));
        }
        if (p.x224 != null) put(f, ctx(6, tlv(0x04, p.x224)));
        if (p.certs != null) {
            ByteArrayOutputStream c = new ByteArrayOutputStream();
            for (byte[] cert : p.certs) put(c, tlv(0x04, cert));
            put(f, ctx(7, tlv(0x30, c.toByteArray())));
        }
        if (p.serverAddr != null) put(f, ctx(9, tlv(0x0c, p.serverAddr.getBytes(StandardCharsets.UTF_8))));
        return tlv(0x30, f.toByteArray());
    }

    // ------------------------------------------------------------ 화질·소리 (Connect-Initial · Client Info)

    static final int INFO_UNICODE = 0x10, INFO_REMOTECONSOLEAUDIO = 0x2000, INFO_NOAUDIOPLAYBACK = 0x00080000;

    /** 화면 효과 → performanceFlags. e: wallpaper, themes, fontSmoothing, composition, windowDrag, animations, cursorShadow */
    static int perfFlags(org.json.JSONObject e) {
        boolean wallpaper = e == null || e.optBoolean("wallpaper", true), drag = e == null || e.optBoolean("windowDrag", true);
        boolean anim = e == null || e.optBoolean("animations", true), themes = e == null || e.optBoolean("themes", true);
        boolean shadow = e == null || e.optBoolean("cursorShadow", true), font = e == null || e.optBoolean("fontSmoothing", true);
        boolean comp = e == null || e.optBoolean("composition", true);
        return (wallpaper ? 0 : 0x01) | (drag ? 0 : 0x02) | (anim ? 0 : 0x04) | (themes ? 0 : 0x08) | (shadow ? 0 : 0x20) | (font ? 0x80 : 0) | (comp ? 0x100 : 0);
    }

    private static int u16(byte[] b, int i) { return (b[i] & 0xff) | ((b[i + 1] & 0xff) << 8); }
    private static int u32(byte[] b, int i) { return (b[i] & 0xff) | ((b[i + 1] & 0xff) << 8) | ((b[i + 2] & 0xff) << 16) | ((b[i + 3] & 0xff) << 24); }
    private static void put16(byte[] b, int i, int v) { b[i] = (byte)v; b[i + 1] = (byte)(v >> 8); }
    private static void put32(byte[] b, int i, int v) { b[i] = (byte)v; b[i + 1] = (byte)(v >> 8); b[i + 2] = (byte)(v >> 16); b[i + 3] = (byte)(v >>> 24); }

    private static int mcsStart(byte[] p) {
        if (p.length < 8 || (p[0] & 0xff) != 3 || (p[4] & 0xff) != 2 || (p[5] & 0xff) != 0xf0) return -1;
        return 7;
    }

    static boolean patchCore(byte[] p, int depth) {
        int m = mcsStart(p);
        if (m < 0 || (p[m] & 0xff) != 0x7f || (p[m + 1] & 0xff) != 0x65) return false;
        for (int h = m + 2; h + 146 <= p.length; h++) {
            if ((p[h] & 0xff) != 0x01 || (p[h + 1] & 0xff) != 0xc0) continue;
            int len = u16(p, h + 2), version = u32(p, h + 4);
            if (len < 146 || h + len > p.length || (version >>> 16) != 0x0008) continue;
            int support = depth == 24 ? 0x01 : depth == 16 ? 0x02 : depth == 15 ? 0x04 : 0x08;
            if (depth == 32) { put16(p, h + 140, 24); put16(p, h + 142, u16(p, h + 142) | 0x0f); put16(p, h + 144, u16(p, h + 144) | 0x0002); }
            else { put16(p, h + 140, depth); put16(p, h + 142, support); put16(p, h + 144, u16(p, h + 144) & ~0x0002); }
            return true;
        }
        return false;
    }

    /** audio: "remote" | "off" */
    static boolean patchInfo(byte[] p, int perf, String audio) {
        int m = mcsStart(p);
        if (m < 0 || ((p[m] & 0xff) >> 2) != 25) return false;
        int i = m + 6;
        if (i >= p.length) return false;
        i += (p[i] & 0x80) != 0 ? 2 : 1;
        if (i + 4 > p.length || (u16(p, i) & 0x0040) == 0) return false;
        int info = i + 4;
        if (info + 18 > p.length) return false;
        int flags = u32(p, info + 4);
        int nul = (flags & INFO_UNICODE) != 0 ? 2 : 1;
        int j = info + 18;
        for (int k = 0; k < 5; k++) j += u16(p, info + 8 + k * 2) + nul;
        if (j + 4 > p.length) return false;
        j += 4 + u16(p, j + 2);
        if (j + 2 > p.length) return false;
        j += 2 + u16(p, j);
        int perfAt = j + 172 + 4;
        if (perfAt + 4 > p.length) return false;
        int f = flags & ~(INFO_REMOTECONSOLEAUDIO | INFO_NOAUDIOPLAYBACK);
        f |= "remote".equals(audio) ? INFO_REMOTECONSOLEAUDIO : INFO_NOAUDIOPLAYBACK;
        put32(p, info + 4, f);
        put32(p, perfAt, perf);
        return true;
    }

    interface Log { void add(String message); }

    /**
     * 클라이언트 → 서버 흐름에서 Connect-Initial·Client Info 를 고치고 접속 단계를 기록한다.
     * TPKT 만 모으고 CredSSP·빠른 경로 입력은 길이만 세며 바로 흘린다.
     */
    static final class Patcher {
        private final int depth, perf; private final String audio; private final Log log;
        private byte[] buf = new byte[0];
        private int skip, units, joins;
        private boolean core, info, confirmed, passthrough;
        Patcher(int depth, int perf, String audio, Log log) { this.depth = depth; this.perf = perf; this.audio = audio; this.log = log; }
        boolean done() { return passthrough; }
        boolean coreSeen() { return core; }

        byte[] push(byte[] chunk, int n) {
            if (passthrough) return java.util.Arrays.copyOf(chunk, n);
            byte[] all = new byte[buf.length + n];
            System.arraycopy(buf, 0, all, 0, buf.length); System.arraycopy(chunk, 0, all, buf.length, n);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            int i = 0;
            while (i < all.length) {
                if (skip > 0) { int k = Math.min(skip, all.length - i); out.write(all, i, k); skip -= k; i += k; continue; }
                int len = unit(all, i);
                if (len < 0) { stop("알 수 없는 PDU"); out.write(all, i, all.length - i); i = all.length; break; }
                if (len == 0) break;
                if ((all[i] & 0xff) != 3) { skip = len; continue; }
                if (len < 7) { stop("짧은 TPKT"); out.write(all, i, all.length - i); i = all.length; break; }
                if (i + len > all.length) break;
                byte[] u = java.util.Arrays.copyOfRange(all, i, i + len);
                inspect(u);
                out.write(u, 0, u.length);
                i += len;
                if ((core && info && confirmed) || units > 200) { passthrough = true; out.write(all, i, all.length - i); i = all.length; break; }
            }
            buf = java.util.Arrays.copyOfRange(all, i, all.length);
            return out.toByteArray();
        }

        private void inspect(byte[] u) {
            units++;
            int m = mcsStart(u);
            if (m < 0) return;
            int t = u[m] & 0xff;
            if (!core && t == 0x7f && (u[m + 1] & 0xff) == 0x65) {
                core = true;
                if (depth == 32) log.add("MCS 연결 요청 (색 깊이 그대로)");
                else log.add(patchCore(u, depth) ? "MCS 연결 요청 — 색 깊이 " + depth + "비트" : "MCS 연결 요청 (색 깊이를 바꾸지 못함)");
                return;
            }
            int kind = t >> 2;
            if (kind == 1) log.add("MCS 도메인 설정");
            else if (kind == 10) log.add("MCS 사용자 연결");
            else if (kind == 14) { if (joins++ == 0) log.add("채널 연결"); }
            else if (kind == 25) {
                if (!info && patchInfo(u, perf, audio)) { info = true; log.add("로그온 정보 — 화면 효과 0x" + Integer.toHexString(perf) + " · 소리 " + audio); return; }
                int i = m + 6;
                i += (u[i] & 0x80) != 0 ? 2 : 1;
                if (info && i + 4 <= u.length && (u16(u, i + 2) & 0x0f) == 0x03) { confirmed = true; log.add("화면 기능 교환 (Confirm Active) — 첫 화면을 기다리는 중"); }
            }
        }

        private void stop(String why) { passthrough = true; log.add("화질·소리 설정을 적용하지 못했습니다 (" + why + ")"); }

        private static int unit(byte[] b, int i) {
            int left = b.length - i;
            if (left < 2) return 0;
            int t = b[i] & 0xff;
            if (t == 0x03) return left < 4 ? 0 : ((b[i + 2] & 0xff) << 8) | (b[i + 3] & 0xff);
            if (t == 0x30) {
                int l = b[i + 1] & 0xff;
                if (l < 0x80) return 2 + l;
                int k = l & 0x7f;
                if (k < 1 || k > 3) return -1;
                if (left < 2 + k) return 0;
                int n = 0;
                for (int x = 0; x < k; x++) n = (n << 8) | (b[i + 2 + x] & 0xff);
                return 2 + k + n;
            }
            if ((t & 0x03) == 0) {
                int l = b[i + 1] & 0xff;
                if ((l & 0x80) == 0) return l;
                return left < 3 ? 0 : ((l & 0x7f) << 8) | (b[i + 2] & 0xff);
            }
            return -1;
        }
    }

    /** ByteArrayOutputStream.writeBytes 는 API 33 부터 */
    private static void put(ByteArrayOutputStream o, byte[] b) { o.write(b, 0, b.length); }

    static List<byte[]> listOf(byte[]... items) { List<byte[]> l = new ArrayList<>(); for (byte[] i : items) l.add(i); return l; }
}
