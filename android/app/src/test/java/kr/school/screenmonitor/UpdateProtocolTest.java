package kr.school.screenmonitor;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import static org.junit.Assert.*;

/** 새 버전 안내: hello에 버전을 싣고, 서버가 준 받기 주소는 같은 서버의 /download/ 아래만 믿는다. */
public class UpdateProtocolTest {
    @After public void reset() { StudentProtocol.appVersion = null; StudentProtocol.appBuild = 0; }

    @Test public void helloCarriesTheInstalledVersionOnlyWhenKnown() throws Exception {
        ConnectionOptions options = new ConnectionOptions("192.168.1.28:8080", "123456", "1", "2", "3", "학생");
        assertFalse(new JSONObject(StudentProtocol.hello(options)).has("version"));
        StudentProtocol.appVersion = "1.5.0";
        StudentProtocol.appBuild = 6;
        JSONObject hello = new JSONObject(StudentProtocol.hello(options));
        assertEquals("android", hello.getString("platform"));
        assertEquals("1.5.0", hello.getString("version"));
        assertEquals(6, hello.getLong("build"));
    }

    @Test public void updateLinkStaysOnTheTeacherServer() throws Exception {
        JSONObject update = new JSONObject().put("version", "1.6.0").put("url", "/download/android");
        assertArrayEquals(new String[] { "1.6.0", "http://192.168.1.28:8080/download/android" },
                StudentProtocol.update("ws://192.168.1.28:8080/ws", update));
        assertEquals("https://class.example/download/android",
                StudentProtocol.update("wss://class.example/ws", update)[1]);
        assertNull(StudentProtocol.update("ws://192.168.1.28:8080/ws", null));
        assertNull(StudentProtocol.update("ws://192.168.1.28:8080/ws",
                new JSONObject().put("version", "1.6.0").put("url", "https://evil.example/app.apk")));
        assertNull(StudentProtocol.update("ws://192.168.1.28:8080/ws",
                new JSONObject().put("version", "1.6.0").put("url", "/download/../x")));
        assertNull(StudentProtocol.update("ws://192.168.1.28:8080/ws",
                new JSONObject().put("version", "latest").put("url", "/download/android")));
    }
}
