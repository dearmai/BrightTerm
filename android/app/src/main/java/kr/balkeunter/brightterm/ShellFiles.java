package kr.balkeunter.brightterm;

import com.jcraft.jsch.*;
import org.json.*;
import java.io.*;
import java.util.regex.*;

/**
 * SFTP 서브시스템이 없거나 막힌 서버용 — SSH exec 채널에서 POSIX 셸 명령(cat·ls)으로 목록·업로드·다운로드.
 * 데스크톱 src/main/shellfs.ts 와 같은 방식: GNU 전용 옵션 없이, 목록은 perl 이 있으면 perl, 없으면 ls -lan.
 */
final class ShellFiles {
    private ShellFiles() { }

    /** '-' 로 시작하는 이름이 옵션으로 읽히지 않게 */
    static String arg(String path) {
        return Tmux.quote(path.startsWith("/") || path.startsWith("./") || path.equals(".") ? path : "./" + path);
    }

    /** 명령 하나 — in 이 있으면 보내고 닫는다, 출력은 out 으로. 종료 코드가 0 이 아니면 stderr 로 실패 */
    static void run(Session session, String command, InputStream in, OutputStream out) throws Exception {
        ChannelExec channel = (ChannelExec)session.openChannel("exec");
        ByteArrayOutputStream error = new ByteArrayOutputStream();
        try {
            channel.setCommand(command);
            channel.setErrStream(error);
            InputStream output = channel.getInputStream();
            OutputStream input = channel.getOutputStream();
            channel.connect(15000);
            if (in != null) {
                byte[] buffer = new byte[32768]; int count;
                while ((count = in.read(buffer)) != -1) input.write(buffer, 0, count);
                input.flush();
            }
            input.close();
            byte[] buffer = new byte[32768]; int count;
            while ((count = output.read(buffer)) != -1) out.write(buffer, 0, count);
            while (!channel.isClosed()) Thread.sleep(20);
            if (channel.getExitStatus() != 0) {
                String[] lines = error.toString("UTF-8").trim().split("\n");
                String last = lines[lines.length - 1];
                throw new IOException(last.isEmpty() ? "명령 실패 (exit " + channel.getExitStatus() + ")" : last);
            }
        } finally { channel.disconnect(); }
    }

    static boolean available(Session session) {
        try { ByteArrayOutputStream out = new ByteArrayOutputStream(); run(session, "echo BT_OK", null, out); return out.toString("UTF-8").contains("BT_OK"); }
        catch (Exception error) { return false; }
    }

    private static final String PERL = "perl -e 'opendir(D, \".\") or exit 1; for $f (readdir D) { @s = stat($f); @s = lstat($f) unless @s; print \"$s[2]/$s[7]\\t$f\\0\" }'";
    private static final Pattern LS = Pattern.compile("^([-dlcbps])[-rwxsStT]{9}[.+@]?\\s+\\d+\\s+\\S+\\s+\\S+\\s+(\\d+),?\\s*(?:\\d+\\s+)?\\w{3}\\s+\\d{1,2}\\s+(?:\\d{1,2}:\\d{2}|\\d{4})\\s(.+)$");

    /** 목록 — {path, entries:[{name, directory, size}]} (TerminalService.list 의 SFTP 결과와 같은 모양) */
    static JSONObject list(Session session, String path) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        run(session, "cd " + arg(path) + " && pwd -P && if command -v perl >/dev/null 2>&1; then " + PERL + "; else echo BT_LS; LC_ALL=C ls -lan; fi", null, out);
        String text = out.toString("UTF-8");
        int newline = text.indexOf('\n');
        String resolved = text.substring(0, newline).replaceAll("^//", "/"), rest = text.substring(newline + 1);
        JSONArray entries = new JSONArray();
        if (rest.startsWith("BT_LS\n")) {
            for (String line : rest.substring(6).split("\n")) {
                Matcher m = LS.matcher(line);
                if (!m.matches()) continue;
                String name = m.group(1).equals("l") ? m.group(3).replaceAll(" -> .*$", "") : m.group(3);
                if (!name.equals(".")) entries.put(new JSONObject().put("name", name).put("directory", m.group(1).equals("d")).put("size", Long.parseLong(m.group(2))));
                if (entries.length() >= 2000) break;
            }
        } else {
            for (String record : rest.split("\0")) {
                int tab = record.indexOf('\t');
                if (tab < 0) continue;
                String[] stat = record.substring(0, tab).split("/");
                String name = record.substring(tab + 1);
                if (name.equals(".")) continue;
                long mode = Long.parseLong(stat[0]);
                entries.put(new JSONObject().put("name", name).put("directory", (mode & 0170000) == 0040000).put("size", Long.parseLong(stat[1])));
                if (entries.length() >= 2000) break;
            }
        }
        return new JSONObject().put("path", resolved).put("entries", entries);
    }

    static void download(Session session, String path, OutputStream out) throws Exception { run(session, "cat " + arg(path), null, out); }
    static void upload(Session session, InputStream in, String path) throws Exception { run(session, "cat > " + arg(path), in, new ByteArrayOutputStream()); }
}
