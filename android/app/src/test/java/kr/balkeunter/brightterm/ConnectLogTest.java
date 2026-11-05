package kr.balkeunter.brightterm;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ConnectLogTest {
    @Test public void keepsHeadAndTailAndMarksTheGap() {
        ConnectLog log = new ConnectLog();
        for (int i = 0; i < 2500; i++) log.add("line " + i);
        String[] lines = log.text().split("\n");
        assertEquals(2001, lines.length);
        assertTrue(lines[0].endsWith("line 0"));
        assertTrue(lines[999].endsWith("line 999"));
        assertEquals("… 500줄 생략 …", lines[1000]);
        assertTrue(lines[1001].endsWith("line 1500"));
        assertTrue(lines[2000].endsWith("line 2499"));
    }
    @Test public void cutsVeryLongLines() {
        ConnectLog log = new ConnectLog();
        log.add("x".repeat(5000));
        assertTrue(log.text().length() < 2100);
    }
}
