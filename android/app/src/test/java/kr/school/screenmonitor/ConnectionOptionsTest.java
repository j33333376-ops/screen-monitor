package kr.school.screenmonitor;

import org.junit.Test;
import static org.junit.Assert.*;

public class ConnectionOptionsTest {
    @Test public void splitAddressDefaultsAndValidation() {
        String[] parts = ConnectionOptions.splitIpv4("");
        assertArrayEquals(new String[] {"192", "168", "1", "", "8080"}, parts);
        parts[3] = "28";
        assertEquals("192.168.1.28:8080", ConnectionOptions.ipv4Address(parts));
        assertEquals("10.0.2.15:80", ConnectionOptions.ipv4Address(new String[] {"010", "0", "2", "015", "80"}));
        for (String[] invalid : new String[][] {
                {"192","168","1","","8080"}, {"256","1","1","1","8080"},
                {"192","168","1","28","0"}, {"192","168","1","28","65536"},
                {"192","168","1","-1","8080"}}) {
            assertThrows(IllegalArgumentException.class, () -> ConnectionOptions.ipv4Address(invalid));
        }
    }

    @Test public void restoresSavedIpv4AndKeepsSecureUrlsInDirectMode() {
        assertArrayEquals(new String[] {"192","168","45","84","8080"},
                ConnectionOptions.splitIpv4("ws://192.168.45.84:8080/ws"));
        assertArrayEquals(new String[] {"192","168","1","","8080"},
                ConnectionOptions.splitIpv4("192.168.1.:8080"));
        assertNull(ConnectionOptions.splitIpv4("https://192.168.1.28"));
        assertNull(ConnectionOptions.splitIpv4("school.example:8080"));
    }
    @Test public void acceptsSchoolAddressesAndSecureHosts() {
        assertEquals("ws://192.168.0.10:8080/ws", ConnectionOptions.serverUrl(" 192.168.0.10 "));
        assertEquals("ws://192.168.0.10:8080/ws", ConnectionOptions.serverUrl("http://192.168.0.10:8080/"));
        assertEquals("wss://class.example/ws", ConnectionOptions.serverUrl("https://class.example"));
        assertEquals("ws://[::1]:8080/ws", ConnectionOptions.serverUrl("[::1]:8080"));
        assertEquals("wss://class.example:8443/ws", ConnectionOptions.serverUrl("wss://class.example:8443/ws/"));
    }

    @Test public void rejectsAmbiguousAndInvalidAddresses() {
        for (String input : new String[] {"", "ftp://school.local", "ws://user:pass@school.local",
                "school.local:0", "school.local:65536", "school.local:word", "school.local?code=123456",
                "school.local/student", "school.local#fragment", "not a host"}) {
            assertThrows(input, IllegalArgumentException.class, () -> ConnectionOptions.serverUrl(input));
        }
    }

    @Test public void validatesStudentInformationAndNormalizesNumbers() {
        ConnectionOptions options = new ConnectionOptions("localhost", "012345", "01", "2", "03", " 이안 ");
        assertEquals("012345", options.code);
        assertEquals("1", options.grade);
        assertEquals("3", options.num);
        assertEquals("이안", options.name);
        assertThrows(IllegalArgumentException.class, () -> new ConnectionOptions("localhost", "12345", "1", "1", "1", "a"));
        assertThrows(IllegalArgumentException.class, () -> new ConnectionOptions("localhost", "123456", "0", "1", "1", "a"));
        assertThrows(IllegalArgumentException.class, () -> new ConnectionOptions("localhost", "123456", "1", "100", "1", "a"));
        assertThrows(IllegalArgumentException.class, () -> new ConnectionOptions("localhost", "123456", "1", "1", "1", " "));
    }

    @Test public void boundsGalaxyTabletCaptureMemoryAndPreservesOrientation() {
        assertArrayEquals(new int[] {800, 1280}, ConnectionOptions.captureSize(1600, 2560));
        assertArrayEquals(new int[] {1280, 800}, ConnectionOptions.captureSize(2000, 1250));
        assertArrayEquals(new int[] {480, 320}, ConnectionOptions.captureSize(480, 320));
        assertThrows(IllegalArgumentException.class, () -> ConnectionOptions.captureSize(0, 1280));
    }

    @Test public void aiCaptureKeepsNativeTabletResolutionWithoutUpscaling() {
        assertArrayEquals(new int[] {1600, 2560}, ConnectionOptions.captureSize(1600, 2560, 2560));
        assertArrayEquals(new int[] {2000, 1200}, ConnectionOptions.captureSize(2000, 1200, 2560));
        assertArrayEquals(new int[] {2560, 1440}, ConnectionOptions.captureSize(3840, 2160, 2560));
        byte[] packet = StudentProtocol.capture(0xf1234567L, new byte[] {10, 20});
        assertArrayEquals(new byte[] {3, (byte) 0xf1, 0x23, 0x45, 0x67, 10, 20}, packet);
        assertThrows(IllegalArgumentException.class, () -> StudentProtocol.capture(-1, new byte[] {}));
    }
}
