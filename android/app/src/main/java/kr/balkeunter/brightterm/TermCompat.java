package kr.balkeunter.brightterm;

import org.json.JSONObject;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.*;

/** 서버별 터미널 호환 — 키 입력 코드 변환과 인코딩. 데스크톱 src/shared/terminal.ts 의 mapKeys 와 같은 규칙. */
final class TermCompat {
    private TermCompat() { }

    static String option(JSONObject keys, String name, String fallback) {
        return keys == null ? fallback : keys.optString(name, fallback);
    }

    /** SSH pty 요청의 터미널 모드 — VERASE 를 백스페이스 코드에 맞춰 서버 stty erase 를 맞춘다 */
    static byte[] terminalModes(JSONObject keys) {
        int erase = "ctrl-h".equals(option(keys, "backspace", "del")) ? 8 : 127;
        return new byte[]{3, 0, 0, 0, (byte)erase, 0};
    }

    /** 키 하나는 onData 한 번으로 오므로 정확히 일치할 때만 바꾸고, Enter 는 붙여 넣기에도 적용한다 */
    static String mapKeys(String data, JSONObject keys) {
        boolean ctrlH = "ctrl-h".equals(option(keys, "backspace", "del"));
        boolean vt220 = "vt220".equals(option(keys, "homeEnd", "xterm"));
        switch (data) {
            case "\u007f": return ctrlH ? "\b" : data;
            case "\b": return ctrlH ? "\u007f" : data;
            case "\u001b[3~": return "del".equals(option(keys, "delete", "vt220")) ? "\u007f" : data;
            case "\u001b[H": case "\u001bOH": return vt220 ? "\u001b[1~" : data;
            case "\u001b[F": case "\u001bOF": return vt220 ? "\u001b[4~" : data;
            default: break;
        }
        String enter = option(keys, "enter", "CR");
        if (enter.equals("CR") || data.indexOf('\r') < 0) return data;
        return data.replaceAll("\r(?!\n)", enter.equals("CRLF") ? "\r\n" : "\n");
    }

    static Charset charset(String encoding) {
        String[] names;
        switch (encoding == null ? "" : encoding) {
            case "euc-kr": names = new String[]{"EUC-KR"}; break;
            case "cp949": names = new String[]{"x-windows-949", "MS949", "windows-949", "EUC-KR"}; break;
            case "euc-jp": names = new String[]{"EUC-JP"}; break;
            case "shift_jis": names = new String[]{"Shift_JIS"}; break;
            case "gbk": names = new String[]{"GBK"}; break;
            case "big5": names = new String[]{"Big5"}; break;
            case "latin1": names = new String[]{"ISO-8859-1"}; break;
            case "cp1252": names = new String[]{"windows-1252"}; break;
            default: return StandardCharsets.UTF_8;
        }
        for (String name : names) try { if (Charset.isSupported(name)) return Charset.forName(name); } catch (IllegalCharsetNameException ignored) { }
        return StandardCharsets.UTF_8;
    }

    /** 서버 출력을 UTF-8 로 — 패킷 경계에서 잘린 멀티바이트 글자는 다음 조각과 합친다 */
    static final class Decoder {
        private final CharsetDecoder decoder;
        private ByteBuffer pending = ByteBuffer.allocate(0);
        Decoder(Charset charset) {
            decoder = charset == StandardCharsets.UTF_8 ? null : charset.newDecoder()
                .onMalformedInput(CodingErrorAction.REPLACE).onUnmappableCharacter(CodingErrorAction.REPLACE);
        }
        byte[] toUtf8(byte[] bytes) {
            if (decoder == null) return bytes;
            ByteBuffer in = ByteBuffer.allocate(pending.remaining() + bytes.length);
            in.put(pending).put(bytes).flip();
            CharBuffer out = CharBuffer.allocate(in.remaining() * 2 + 4);
            decoder.decode(in, out, false);
            pending = ByteBuffer.allocate(in.remaining()); pending.put(in).flip();
            out.flip();
            return out.toString().getBytes(StandardCharsets.UTF_8);
        }
    }
}
