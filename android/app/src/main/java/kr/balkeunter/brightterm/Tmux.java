package kr.balkeunter.brightterm;

import org.json.JSONObject;
import java.text.Normalizer;

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
    static String startup(JSONObject profile) {
        return startup(profile, name(profile));
    }
    static String startup(JSONObject profile, String name) {
        String command = profile.optString("command", "").trim();
        if (!profile.optBoolean("persist", false)) return command;
        String target = quote("=" + name);
        String create = "tmux new-session -d -s " + quote(name) + " -c \"$PWD\" && tmux set-option -t " + target + " status off >/dev/null";
        if (!command.isEmpty()) create += " && tmux send-keys -t " + target + " -l " + quote(command) + " && tmux send-keys -t " + target + " Enter";
        String inner = "tmux has-session -t " + target + " 2>/dev/null || { " + create + "; }; tmux set-option -t " + target + " mouse " +
            (profile.optBoolean("persistMouse", true) ? "on" : "off") + " >/dev/null 2>&1; TMUX= exec tmux attach-session -t " + target;
        return " if command -v tmux >/dev/null 2>&1; then sh -c " + quote(inner) + "; else printf '%s\\n' " +
            quote("BrightTerm: 서버에 tmux가 없어 일반 셸로 연결합니다. Ubuntu/Debian: sudo apt install tmux / macOS: brew install tmux") +
            (command.isEmpty() ? "" : "; " + command) + "; fi";
    }
}
