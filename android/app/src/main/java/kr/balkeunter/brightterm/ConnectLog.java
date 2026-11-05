package kr.balkeunter.brightterm;

import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** 접속 상세 로그 (src/main/connectLog.ts) — 메모리에만 두고 탭을 닫으면 사라진다. 처음 접속 과정과 최근 줄을 따로 보관한다. */
final class ConnectLog {
    private static final int HEAD_LINES = 1000, TAIL_LINES = 1000, MAX_LINE_CHARS = 2000;
    private final List<String> head = new ArrayList<>();
    private final ArrayDeque<String> tail = new ArrayDeque<>();
    private final SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.ROOT);
    private int dropped;

    synchronized void add(String message) { add(message, new Date()); }
    synchronized void add(String message, Date now) {
        String text = message.length() > MAX_LINE_CHARS ? message.substring(0, MAX_LINE_CHARS) + "…" : message;
        String line = format.format(now) + "  " + text;
        if (head.size() < HEAD_LINES) { head.add(line); return; }
        tail.addLast(line);
        if (tail.size() > TAIL_LINES) { tail.removeFirst(); dropped++; }
    }
    synchronized String text() {
        List<String> lines = new ArrayList<>(head);
        if (dropped > 0) lines.add("… " + dropped + "줄 생략 …");
        lines.addAll(tail);
        return String.join("\n", lines);
    }
}
