package kr.balkeunter.brightterm;

import static org.junit.Assert.*;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/** 데스크톱 test/rdp.test.mjs 와 같은 경우 — 두 구현이 같은 바이트를 만들고 읽는다 */
public class RdpTest {
    @Test public void connectionRequest() {
        byte[] b = Rdp.connectionRequest(Rdp.PROTOCOL_SSL | Rdp.PROTOCOL_HYBRID | Rdp.PROTOCOL_HYBRID_EX, null);
        assertArrayEquals(new byte[]{3, 0, 0, 19, 14, (byte)0xe0, 0, 0, 0, 0, 0, 1, 0, 8, 0, 0x0b, 0, 0, 0}, b);
        byte[] c = Rdp.connectionRequest(1, "administrator");
        assertTrue(new String(c, StandardCharsets.ISO_8859_1).contains("Cookie: mstshash=administr\r\n"));
        assertEquals(c.length, Rdp.tpktLength(c, c.length));
        assertEquals(c.length - 5, c[4]);
    }

    @Test public void confirm() {
        Rdp.Confirm s = Rdp.parseConfirm(new byte[]{3, 0, 0, 19, 14, (byte)0xd0, 0, 0, 0x12, 0x34, 0, 2, 0, 8, 0, 2, 0, 0, 0});
        assertEquals(0, s.kind); assertEquals(2, s.protocol); assertTrue(Rdp.needsTls(s));
        Rdp.Confirm f = Rdp.parseConfirm(new byte[]{3, 0, 0, 19, 14, (byte)0xd0, 0, 0, 0x12, 0x34, 0, 3, 0, 8, 0, 5, 0, 0, 0});
        assertEquals(1, f.kind); assertEquals(5, f.code);
        assertEquals(2, Rdp.parseConfirm(new byte[]{3, 0, 0, 11, 6, (byte)0xd0, 0, 0, 0, 0, 0}).kind);
        assertEquals(-1, Rdp.tpktLength(new byte[]{0x16, 3, 1, 0}, 4));
    }

    @Test public void cleanPathRoundTrip() {
        // IronRDP 가 보내는 요청 형식: SEQUENCE { [0] INTEGER 3390, [2] UTF8String, [3] UTF8String, [6] OCTET STRING }
        byte[] x224 = Rdp.connectionRequest(11, null);
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        write(body, new byte[]{(byte)0xa0, 4, 2, 2, 0x0d, 0x3e});
        write(body, ctx(2, utf8("10.0.0.5:3389"))); write(body, ctx(3, utf8("tok"))); write(body, ctx(6, tlv(0x04, x224)));
        byte[] req = tlv(0x30, body.toByteArray());
        assertEquals(req.length, Rdp.derLength(req, req.length));
        assertEquals(0, Rdp.derLength(req, 1));
        Rdp.CleanPath d = Rdp.decode(req);
        assertEquals(3390, d.version); assertEquals("10.0.0.5:3389", d.destination); assertEquals("tok", d.proxyAuth);
        assertArrayEquals(x224, d.x224);

        Rdp.CleanPath res = new Rdp.CleanPath();
        byte[] big = new byte[1500]; Arrays.fill(big, (byte)7);
        res.serverAddr = "10.0.0.5:3389"; res.x224 = new byte[]{3, 0, 0, 11, 6, (byte)0xd0, 0, 0, 0, 0, 0};
        res.certs = new ArrayList<>(List.of(big, new byte[]{1, 2}));
        byte[] enc = Rdp.encode(res);
        assertEquals(enc.length, Rdp.derLength(enc, enc.length));
        Rdp.CleanPath back = Rdp.decode(enc);
        assertEquals("10.0.0.5:3389", back.serverAddr);
        assertArrayEquals(res.x224, back.x224);
        // 오류 응답 [1] SEQUENCE { [0] code, [2] wsa, [3] tls }
        Rdp.CleanPath e = new Rdp.CleanPath(); e.errorCode = Rdp.TLS_FAILED; e.tlsAlert = 42; e.wsaError = 10061;
        byte[] err = Rdp.encode(e);
        assertEquals((byte)0xa1, err[8]);
    }

    private static byte[] tpkt(byte[] body) {
        byte[] b = new byte[7 + body.length];
        b[0] = 3; b[2] = (byte)(b.length >> 8); b[3] = (byte)b.length; b[4] = 2; b[5] = (byte)0xf0; b[6] = (byte)0x80;
        System.arraycopy(body, 0, b, 7, body.length);
        return b;
    }
    private static int coreAt;
    private static byte[] connectInitial() {
        byte[] core = new byte[216];
        put16(core, 0, 0xc001); put16(core, 2, 216); put32(core, 4, 0x00080004);
        put16(core, 140, 24); put16(core, 142, 0x0f); put16(core, 144, 0x0003);
        byte[] pre = {0x7f, 0x65, (byte)0x82, 0x01, 0x00, 0x04, 0x01, 0x01, 0x04, 0x01, 0x01, 0x01, 0x01, (byte)0xff};
        byte[] body = new byte[pre.length + core.length];
        System.arraycopy(pre, 0, body, 0, pre.length); System.arraycopy(core, 0, body, pre.length, core.length);
        coreAt = 7 + pre.length;
        return tpkt(body);
    }
    private static int flagsAt, perfAt;
    private static byte[] clientInfo() {
        ByteArrayOutputStream info = new ByteArrayOutputStream();
        byte[] user = u16le("admin"), pw = u16le("pw1"), addr = u16le("1.2"), dir = u16le("C:");
        write(info, le32(0)); write(info, le32(0x10 | 0x1 | 0x8)); write(info, le16(0)); write(info, le16(user.length - 2)); write(info, le16(pw.length - 2)); write(info, le16(0)); write(info, le16(0));
        write(info, u16le("")); write(info, user); write(info, pw); write(info, u16le("")); write(info, u16le(""));
        write(info, le16(2)); write(info, le16(addr.length)); write(info, addr); write(info, le16(dir.length)); write(info, dir); write(info, new byte[172]); write(info, le32(0)); write(info, le32(0));
        byte[] i = info.toByteArray();
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        write(body, new byte[]{0x64, 0, 6, 3, (byte)0xeb, 0x70, (byte)(0x80 | ((i.length + 4) >> 8)), (byte)(i.length + 4), 0x40, 0, 0, 0});
        write(body, i);
        flagsAt = 7 + 12 + 4; perfAt = 7 + 12 + i.length - 4;
        return tpkt(body.toByteArray());
    }

    @Test public void patchColorDepth() {
        byte[] p = connectInitial();
        assertTrue(Rdp.patchCore(p, 16));
        assertEquals(16, u16(p, coreAt + 140)); assertEquals(0x02, u16(p, coreAt + 142)); assertEquals(0, u16(p, coreAt + 144) & 2);
        assertFalse(Rdp.patchCore(clientInfo(), 16));
    }

    @Test public void patchInfo() {
        byte[] p = clientInfo();
        org.json.JSONObject off = new org.json.JSONObject();
        try { for (String k : new String[]{"wallpaper", "themes", "fontSmoothing", "composition", "windowDrag", "animations", "cursorShadow"}) off.put(k, false); } catch (Exception e) { throw new AssertionError(e); }
        assertTrue(Rdp.patchInfo(p, Rdp.perfFlags(off), "off"));
        assertEquals(0x2f, u32(p, perfAt));
        assertEquals(Rdp.INFO_NOAUDIOPLAYBACK, u32(p, flagsAt) & Rdp.INFO_NOAUDIOPLAYBACK);
        assertEquals(0x19, u32(p, flagsAt) & 0x19);
        assertTrue(Rdp.patchInfo(p, Rdp.perfFlags(null), "remote"));
        assertEquals(0x180, u32(p, perfAt));
        assertEquals(Rdp.INFO_REMOTECONSOLEAUDIO, u32(p, flagsAt) & (Rdp.INFO_NOAUDIOPLAYBACK | Rdp.INFO_REMOTECONSOLEAUDIO));
    }

    @Test public void patcherOnSplitStream() {
        byte[] credssp = {0x30, (byte)0x82, 0x00, 0x03, 1, 2, 3};
        byte[] ci = connectInitial(); int ciCore = coreAt;
        byte[] info = clientInfo(); int infoFlags = flagsAt;
        byte[] fast = {0x04, 0x05, 9, 9, 9};
        ByteArrayOutputStream all = new ByteArrayOutputStream();
        write(all, credssp); write(all, ci); write(all, tpkt(new byte[]{0x04, 1, 2})); write(all, info); write(all, fast); write(all, new byte[]{(byte)0xff, (byte)0xee});
        byte[] in = all.toByteArray();
        List<String> logs = new ArrayList<>();
        Rdp.Patcher p = new Rdp.Patcher(16, 0x2f, "off", logs::add);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int i = 0; i < in.length; i += 7) { byte[] chunk = Arrays.copyOfRange(in, i, Math.min(in.length, i + 7)); write(out, p.push(chunk, chunk.length)); }
        byte[] got = out.toByteArray();
        assertEquals(in.length, got.length);
        assertTrue(p.done());
        assertEquals(16, u16(got, credssp.length + ciCore + 140));
        int at = credssp.length + ci.length + 10;
        assertEquals(Rdp.INFO_NOAUDIOPLAYBACK, u32(got, at + infoFlags) & Rdp.INFO_NOAUDIOPLAYBACK);
        assertTrue(String.join("|", logs), logs.stream().anyMatch(l -> l.contains("색 깊이 16비트")) && logs.stream().anyMatch(l -> l.startsWith("로그온 정보")));
        // 32비트는 고치지 않는다
        byte[] keep = connectInitial(); byte[] before = keep.clone();
        new Rdp.Patcher(32, 0x180, "off", m -> { }).push(keep, keep.length);
        assertArrayEquals(before, keep);
    }

    // ---- 보조
    private static void write(ByteArrayOutputStream o, byte[] b) { o.write(b, 0, b.length); }
    private static byte[] utf8(String s) { return tlv(0x0c, s.getBytes(StandardCharsets.UTF_8)); }
    private static byte[] ctx(int n, byte[] inner) { return tlv(0xa0 | n, inner); }
    private static byte[] tlv(int tag, byte[] v) {
        ByteArrayOutputStream o = new ByteArrayOutputStream(); o.write(tag);
        if (v.length < 0x80) o.write(v.length); else if (v.length < 0x100) { o.write(0x81); o.write(v.length); } else { o.write(0x82); o.write(v.length >> 8); o.write(v.length & 0xff); }
        write(o, v); return o.toByteArray();
    }
    private static byte[] u16le(String s) { byte[] b = new byte[s.length() * 2 + 2]; for (int i = 0; i < s.length(); i++) b[i * 2] = (byte)s.charAt(i); return b; }
    private static byte[] le16(int v) { return new byte[]{(byte)v, (byte)(v >> 8)}; }
    private static byte[] le32(int v) { return new byte[]{(byte)v, (byte)(v >> 8), (byte)(v >> 16), (byte)(v >>> 24)}; }
    private static void put16(byte[] b, int i, int v) { b[i] = (byte)v; b[i + 1] = (byte)(v >> 8); }
    private static void put32(byte[] b, int i, int v) { b[i] = (byte)v; b[i + 1] = (byte)(v >> 8); b[i + 2] = (byte)(v >> 16); b[i + 3] = (byte)(v >>> 24); }
    private static int u16(byte[] b, int i) { return (b[i] & 0xff) | ((b[i + 1] & 0xff) << 8); }
    private static int u32(byte[] b, int i) { return (b[i] & 0xff) | ((b[i + 1] & 0xff) << 8) | ((b[i + 2] & 0xff) << 16) | ((b[i + 3] & 0xff) << 24); }
}
