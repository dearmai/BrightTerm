package kr.balkeunter.brightterm;

import org.json.JSONObject;
import java.text.Normalizer;
import java.util.*;

/** Matches desktop persist.ts: exact session targets, startup once, reattach without restarting jobs. */
final class Tmux {
    static String quote(String text) { return "'" + text.replace("'", "'\\''") + "'"; }
    private static String slug(String text) {
        String value = Normalizer.normalize(text, Normalizer.Form.NFKD).replaceAll("[^A-Za-z0-9_-]+", "-").replaceAll("^-+|-+$", "");
        return value.substring(0, Math.min(40, value.length()));
    }
    static String name(JSONObject profile) {
        String custom = profile.optString("persistName", "").trim();
        String base = slug(custom);
        if (base.isEmpty()) base = slug(profile.optString("name", ""));
        if (base.isEmpty()) { String id = slug(profile.optString("id", "terminal")); base = id.substring(0, Math.min(8, id.length())); }
        if (base.isEmpty()) base = "terminal";
        return custom.isEmpty() ? "bt-" + base : base;
    }
    /** 자동 실행 명령을 줄 단위로 — 빈 줄과 # 주석 줄은 뺀다 (persist.ts startupLines) */
    static List<String> lines(JSONObject profile) {
        List<String> lines = new ArrayList<>();
        for (String line : profile.optString("command", "").split("\\r?\\n")) {
            String value = line.replaceAll("\\s+$", "");
            if (!value.trim().isEmpty() && !value.trim().startsWith("#")) lines.add(value);
        }
        return lines;
    }
    static List<String> startup(JSONObject profile) {
        return startup(profile, name(profile));
    }
    /** 접속 직후 셸에 입력할 줄들 (persist.ts startupPlan) — 새 tmux 세션에는 붙은 뒤 1초 간격으로 한 줄씩 넣는다 */
    static List<String> startup(JSONObject profile, String name) {
        List<String> lines = lines(profile);
        if (!profile.optBoolean("persist", false)) return lines;
        String target = quote("=" + name);
        StringBuilder typing = new StringBuilder();
        for (String line : lines) {
            if (typing.length() > 0) typing.append("; ");
            typing.append("sleep 1; tmux send-keys -t ").append(target).append(" -l ").append(quote(line)).append("; tmux send-keys -t ").append(target).append(" Enter");
        }
        String create = "tmux new-session -d -s " + quote(name) + " -c \"$PWD\" && tmux set-option -t " + quote(name) + " status off >/dev/null; " +
            (typing.length() == 0 ? "" : "{ " + typing + "; } >/dev/null 2>&1 & ");
        String inner = "tmux has-session -t " + target + " 2>/dev/null || { " + create + "}; tmux set-option -t " + target + " mouse " +
            (profile.optBoolean("persistMouse", true) ? "on" : "off") + " >/dev/null 2>&1; TMUX= exec tmux attach-session -t " + target;
        return Collections.singletonList(" if command -v tmux >/dev/null 2>&1; then sh -c " + quote(inner) + "; else printf '%s\\n' " +
            quote("BrightTerm: 서버에 tmux가 없어 일반 셸로 연결합니다. Ubuntu/Debian: sudo apt install tmux / macOS: brew install tmux") +
            (lines.isEmpty() ? "" : "; " + String.join("; ", lines)) + "; fi");
    }
}
