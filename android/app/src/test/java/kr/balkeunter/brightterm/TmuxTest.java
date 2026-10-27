package kr.balkeunter.brightterm;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class TmuxTest {
    @Test public void createsOnceAndReattachesWithUpdatedMouseSetting() throws Exception {
        Path root = Files.createTempDirectory("brightterm-tmux-");
        try {
            Path bin = root.resolve("tmux"), log = root.resolve("calls"), started = root.resolve("started");
            Files.write(bin, ("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$BT_LOG\"\ncase \"$1\" in\n has-session) [ -f \"$BT_SESSION\" ] ;;\n new-session) : > \"$BT_SESSION\" ;;\n send-keys|set-option|attach-session) exit 0 ;;\n *) exit 1 ;;\nesac\n").getBytes(StandardCharsets.UTF_8));
            assertTrue(bin.toFile().setExecutable(true));
            JSONObject profile = new JSONObject().put("id", "host-1").put("name", "Desktop Work").put("persist", true)
                .put("persistName", "shared").put("command", "printf 'hello'; echo $(id)");
            run(Tmux.startup(profile), root, log, started);
            profile.put("persistMouse", false); run(Tmux.startup(profile), root, log, started);
            String text = new String(Files.readAllBytes(log), StandardCharsets.UTF_8);
            assertEquals(1, text.lines().filter(line -> line.startsWith("new-session ")).count());
            assertEquals(1, text.lines().filter(line -> line.startsWith("send-keys ") && line.contains(" -l ")).count());
            assertEquals(2, text.lines().filter(line -> line.startsWith("attach-session -t =shared")).count());
            assertTrue(text.contains("mouse on")); assertTrue(text.contains("mouse off"));
            assertTrue(text.contains("-l printf 'hello'; echo $(id)"));
        } finally { remove(root); }
    }
    @Test public void missingTmuxFallsBackAndPlainModePreservesStartup() throws Exception {
        Path root = Files.createTempDirectory("brightterm-no-tmux-");
        try {
            Path marker = root.resolve("marker");
            JSONObject profile = new JSONObject().put("persist", true).put("name", "한국 서버").put("command", "printf once > " + Tmux.quote(marker.toString()));
            // Run with an empty PATH so a developer's installed tmux is not used.
            ProcessBuilder builder = new ProcessBuilder("/bin/sh", "-c", Tmux.startup(profile)); builder.environment().put("PATH", root.toString()); builder.redirectErrorStream(true);
            Process process = builder.start(); String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertEquals(0, process.waitFor()); assertTrue(output.contains("tmux")); assertEquals("once", new String(Files.readAllBytes(marker), StandardCharsets.UTF_8));
            profile.put("persist", false); assertEquals(profile.getString("command"), Tmux.startup(profile));
        } finally { remove(root); }
    }
    @Test public void selectedExistingNameIsPreservedAndShellQuoted() throws Exception {
        Path root = Files.createTempDirectory("brightterm-tmux-name-");
        try {
            Path bin = root.resolve("tmux"), log = root.resolve("calls"), started = root.resolve("started");
            Files.write(bin, ("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$BT_LOG\"\nexit 0\n").getBytes(StandardCharsets.UTF_8));
            assertTrue(bin.toFile().setExecutable(true));
            String name = "odd'quote; touch injected";
            JSONObject profile = new JSONObject().put("persist", true).put("command", "echo should-not-run");
            run(Tmux.startup(profile, name), root, log, started);
            String calls = new String(Files.readAllBytes(log), StandardCharsets.UTF_8);
            assertTrue(calls.contains("attach-session -t =" + name));
            assertFalse(calls.contains("new-session"));
            assertFalse(calls.contains("send-keys"));
            assertFalse(Files.exists(root.resolve("injected")));
        } finally { remove(root); }
    }
    @Test public void namesAndQuotingMatchDesktopRules() throws Exception {
        JSONObject p = new JSONObject().put("name", "My Prod").put("id", "host-1");
        assertEquals("bt-My-Prod", Tmux.name(p)); p.put("persistName", "a'; touch bad");
        assertEquals("a-touch-bad", Tmux.name(p));
        assertEquals("'a'\\''b'", Tmux.quote("a'b"));
    }
    private static void run(String script, Path root, Path log, Path session) throws Exception {
        ProcessBuilder builder = new ProcessBuilder("/bin/sh", "-c", script).directory(root.toFile()).redirectErrorStream(true);
        builder.environment().put("PATH", root.toString() + ":/bin"); builder.environment().put("BT_LOG", log.toString()); builder.environment().put("BT_SESSION", session.toString());
        Process process = builder.start(); String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(output, 0, process.waitFor());
    }
    private static void remove(Path root) throws Exception {
        try (java.util.stream.Stream<Path> paths = Files.walk(root)) { paths.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete()); }
    }
}
