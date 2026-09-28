package kr.school.screenmonitor;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.File;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;
import okhttp3.*;
import okio.ByteString;

/** Exercises the APK's actual wire encoder and OkHttp against the bundled server. */
public class ServerCompatibilityTest {
    private static class Peer extends WebSocketListener {
        final BlockingQueue<Object> messages = new LinkedBlockingQueue<>();
        final WebSocket ws;
        volatile byte[] captureImage;
        Peer(OkHttpClient client, String url) { ws = client.newWebSocket(new Request.Builder().url(url).build(), this); }
        @Override public void onMessage(WebSocket ws, String text) {
            try {
                JSONObject msg = new JSONObject(text);
                if (msg.optString("t").equals("capture") && captureImage != null) {
                    ws.send(ByteString.of(StudentProtocol.capture(msg.getLong("requestId"), captureImage)));
                }
                messages.add(msg);
            } catch (Exception e) { messages.add(e); }
        }
        @Override public void onMessage(WebSocket ws, ByteString bytes) { messages.add(bytes); }
        @Override public void onFailure(WebSocket ws, Throwable failure, Response response) { messages.add(failure); }
        Object await(Predicate<Object> predicate) throws Exception {
            long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(12);
            while (System.nanoTime() < until) {
                Object item = messages.poll(100, TimeUnit.MILLISECONDS);
                if (item instanceof Throwable) throw new AssertionError("Connection failed", (Throwable) item);
                if (item != null && predicate.test(item)) return item;
            }
            throw new AssertionError("Server response timed out");
        }
        JSONObject message(String type) throws Exception {
            return (JSONObject) await(o -> o instanceof JSONObject && ((JSONObject) o).optString("t").equals(type));
        }
        void send(JSONObject message) { assertTrue(ws.send(message.toString())); }
    }

    @Test public void androidAndWindowsShareAClassWithHistoryAndPdf() throws Exception {
        File root = new File(System.getProperty("screenMonitorRoot"));
        int port;
        try (ServerSocket available = new ServerSocket(0)) { port = available.getLocalPort(); }
        Path output = Files.createTempDirectory("screen-monitor-android-protocol-");
        ProcessBuilder process = new ProcessBuilder(new File(root, "server/node.exe").toString(), "server.js");
        process.directory(new File(root, "server"));
        process.environment().put("HOST", "127.0.0.1");
        process.environment().put("PORT", Integer.toString(port));
        process.environment().put("TEACHER_PASSWORD", "android-protocol-test");
        process.environment().put("SAVE_INTERVAL_SEC", "0.1");
        process.environment().put("SAVE_CAPTURES", "on");
        process.environment().put("SAVE_DIR", output.resolve("captures").toString());
        process.redirectErrorStream(true).redirectOutput(output.resolve("server.log").toFile());
        Process server = process.start();
        OkHttpClient client = new OkHttpClient.Builder().connectTimeout(1, TimeUnit.SECONDS).build();
        List<Peer> peers = new ArrayList<>();
        try {
            String base = "http://127.0.0.1:" + port;
            boolean ready = false;
            for (int i = 0; i < 60 && server.isAlive(); i++) {
                try (Response response = client.newCall(new Request.Builder().url(base).build()).execute()) {
                    ready = response.isSuccessful(); if (ready) break;
                } catch (Exception ignored) { Thread.sleep(100); }
            }
            assertTrue("Server must start", ready);
            String url = "ws://127.0.0.1:" + port + "/ws";
            Peer teacher = new Peer(client, url); peers.add(teacher);
            teacher.send(new JSONObject().put("t", "create").put("password", "android-protocol-test"));
            JSONObject created = teacher.message("created");
            ConnectionOptions options = new ConnectionOptions(base, created.getString("code"), "1", "2", "3", "태블릿테스트");
            Peer android = new Peer(client, url); peers.add(android);
            String resumeKey = "0123456789abcdef0123456789abcdef";
            assertTrue(android.ws.send(StudentProtocol.hello(options, resumeKey, false, false)));
            int studentId = android.message("ok").getInt("id");
            teacher.message("join");
            Peer windows = new Peer(client, url); peers.add(windows);
            windows.send(new JSONObject().put("t", "hello").put("code", options.code)
                    .put("grade", "1").put("cls", "2").put("num", "4").put("name", "윈도우테스트"));
            windows.message("ok"); teacher.message("join");
            teacher.send(new JSONObject().put("t", "focus").put("id", studentId));
            assertTrue(android.message("mode").getBoolean("full"));
            byte[] jpeg = Files.readAllBytes(new File(root, "server/test/capture.jpg").toPath());
            android.ws.send(ByteString.of(StudentProtocol.frame(true, jpeg)));
            ByteString frame = (ByteString) teacher.await(o -> o instanceof ByteString);
            assertEquals(2, frame.getByte(0));
            assertArrayEquals(jpeg, frame.substring(5).toByteArray());
            teacher.message("historyChanged");
            teacher.send(new JSONObject().put("t", "history").put("id", studentId).put("requestId", 1));
            JSONObject history = teacher.message("history");
            assertEquals(1, history.getJSONArray("frames").length());
            int frameId = history.getJSONArray("frames").getJSONObject(0).getInt("id");
            teacher.send(new JSONObject().put("t", "historyFrame").put("id", studentId)
                    .put("frameId", frameId).put("requestId", 2));
            assertArrayEquals(jpeg, java.util.Base64.getDecoder().decode(teacher.message("historyFrame").getString("jpeg")));
            Peer duplicate = new Peer(client, url); peers.add(duplicate);
            duplicate.ws.send(StudentProtocol.hello(options));
            assertTrue(duplicate.message("error").getBoolean("fatal"));
            android.send(new JSONObject().put("t", "pause").put("paused", true));
            assertTrue(teacher.message("join").getJSONObject("student").getBoolean("paused"));
            // Wake while the old socket still appears connected on the teacher server.
            Peer resumed = new Peer(client, url); peers.add(resumed);
            resumed.ws.send(StudentProtocol.hello(options, resumeKey, false, false));
            assertEquals(studentId, resumed.message("ok").getInt("id"));
            assertTrue(resumed.message("mode").getBoolean("full"));
            assertFalse(teacher.message("join").getJSONObject("student").getBoolean("paused"));
            // 저장 중지는 일시정지다. PDF는 수업 종료 때 학생마다 1개로 만든다.
            teacher.send(new JSONObject().put("t", "save").put("on", false));
            resumed.await(o -> o instanceof JSONObject && ((JSONObject) o).optString("t").equals("recording")
                    && !((JSONObject) o).optBoolean("on"));
            teacher.await(o -> o instanceof JSONObject && ((JSONObject) o).optString("t").equals("saveState")
                    && ((JSONObject) o).optJSONObject("save") != null
                    && ((JSONObject) o).optJSONObject("save").optBoolean("paused")
                    && !((JSONObject) o).optJSONObject("save").optBoolean("pausing"));
            try (var files = Files.walk(output)) { assertFalse(files.anyMatch(p -> p.toString().endsWith(".pdf"))); }
            // 저장을 시작한 수업은 화질을 바꿀 수 없고, 이유를 알려 준다.
            teacher.send(new JSONObject().put("t", "saveQuality").put("quality", "ai"));
            assertTrue(teacher.message("settingLocked").getString("msg").contains("화질"));
            // 선생님 메시지와 손들기가 같은 수업에서 오간다.
            teacher.send(new JSONObject().put("t", "message").put("text", "3번 문제까지 풀어 주세요"));
            assertEquals("3번 문제까지 풀어 주세요", resumed.message("notice").getString("text"));
            JSONObject sent = teacher.message("messageSent");
            assertEquals(1, sent.getInt("delivered"));
            assertEquals("구버전 앱은 받지 못한 인원으로 보고한다", 1, sent.getInt("legacy"));
            assertTrue(resumed.ws.send(StudentProtocol.help(true)));
            JSONObject raised = (JSONObject) teacher.await(o -> o instanceof JSONObject
                    && ((JSONObject) o).optString("t").equals("join")
                    && ((JSONObject) o).optJSONObject("student").optBoolean("help"));
            assertEquals(studentId, raised.getJSONObject("student").getInt("id"));
            teacher.send(new JSONObject().put("t", "clearHelp").put("id", studentId));
            assertFalse(resumed.message("help").getBoolean("on"));

            teacher.send(new JSONObject().put("t", "end"));
            resumed.message("end"); windows.message("end"); teacher.message("ended");
            try (var files = Files.walk(output)) { assertTrue(files.anyMatch(p -> p.toString().endsWith(".pdf"))); }

            // AI 분석용 고화질은 수업을 시작할 때 고른다. 서버가 요청한 원본 캡처를 태블릿이 보낸다.
            Peer aiTeacher = new Peer(client, url); peers.add(aiTeacher);
            aiTeacher.send(new JSONObject().put("t", "create").put("password", "android-protocol-test").put("quality", "ai"));
            ConnectionOptions aiOptions = new ConnectionOptions(base, aiTeacher.message("created").getString("code"),
                    "1", "2", "3", "태블릿테스트");
            Peer tablet = new Peer(client, url); peers.add(tablet);
            tablet.captureImage = Files.readAllBytes(new File(root, "server/test/high-capture.jpg").toPath());
            assertTrue(tablet.ws.send(StudentProtocol.hello(aiOptions, resumeKey, false, false)));
            JSONObject aiOk = tablet.message("ok");
            assertEquals("ai", aiOk.getString("captureQuality"));
            int tabletId = aiOk.getInt("id");
            JSONObject captureRequest = tablet.message("capture");
            assertEquals(2560, captureRequest.getInt("maxEdge"));
            assertEquals(85, captureRequest.getInt("quality"));
            JSONObject highHistory = null;
            for (int requestId = 10; requestId < 60; requestId++) {
                aiTeacher.send(new JSONObject().put("t", "history").put("id", tabletId).put("requestId", requestId));
                highHistory = aiTeacher.message("history");
                if (highHistory.getJSONArray("frames").length() > 0) break;
                Thread.sleep(100);
            }
            assertTrue("고화질 캡처가 기록된다", highHistory.getJSONArray("frames").length() > 0);
            int latestId = highHistory.getJSONArray("frames").getJSONObject(highHistory.getJSONArray("frames").length() - 1).getInt("id");
            aiTeacher.send(new JSONObject().put("t", "historyFrame").put("id", tabletId).put("frameId", latestId).put("requestId", 99));
            assertArrayEquals(tablet.captureImage, java.util.Base64.getDecoder().decode(aiTeacher.message("historyFrame").getString("jpeg")));
            aiTeacher.send(new JSONObject().put("t", "end"));
            tablet.message("end"); aiTeacher.message("ended");
            try (var files = Files.walk(output)) { assertTrue(files.anyMatch(p -> p.toString().endsWith("_AI고화질.pdf"))); }
        } finally {
            for (Peer peer : peers) peer.ws.cancel();
            client.connectionPool().evictAll(); client.dispatcher().executorService().shutdownNow();
            server.destroy();
            if (!server.waitFor(5, TimeUnit.SECONDS)) server.destroyForcibly();
        }
    }
}
