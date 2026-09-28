package kr.school.screenmonitor;

import org.json.JSONException;
import org.json.JSONObject;

final class StudentProtocol {
    private StudentProtocol() {}

    // 교사 서버가 새 버전 여부를 판단하도록 hello에 싣는다. 서비스가 시작할 때 설치된 앱 정보로 채운다.
    static volatile String appVersion = null;
    static volatile long appBuild = 0;

    static String hello(ConnectionOptions options) throws JSONException {
        JSONObject hello = new JSONObject().put("t", "hello").put("code", options.code)
                .put("grade", options.grade).put("cls", options.cls).put("num", options.num)
                .put("name", options.name).put("platform", "android")
                .put("highCapture", true).put("notice", true);
        if (appVersion != null) hello.put("version", appVersion).put("build", appBuild);
        return hello.toString();
    }

    /** 교사 서버가 알려 준 새 버전 받기 주소. 같은 서버의 /download/ 아래만 허용한다. {버전, 주소} 또는 null. */
    static String[] update(String wsUrl, JSONObject update) {
        if (update == null) return null;
        String version = update.optString("version", ""), path = update.optString("url", "");
        if (!version.matches("\\d+(\\.\\d+){0,3}") || !path.matches("/download/[a-z]+")) return null;
        try {
            java.net.URI server = new java.net.URI(wsUrl);
            String scheme = "wss".equalsIgnoreCase(server.getScheme()) ? "https" : "http";
            return new String[] { version,
                    new java.net.URI(scheme, null, server.getHost(), server.getPort(), path, null, null).toString() };
        } catch (java.net.URISyntaxException | NullPointerException error) {
            return null;
        }
    }

    static String hello(ConnectionOptions options, String resumeKey, boolean paused, boolean help) throws JSONException {
        return new JSONObject(hello(options)).put("resumeKey", resumeKey)
                .put("paused", paused).put("help", help).toString();
    }

    static String help(boolean on) throws JSONException {
        return new JSONObject().put("t", "help").put("on", on).toString();
    }

    static byte[] frame(boolean full, byte[] jpeg) {
        byte[] packet = new byte[jpeg.length + 1];
        packet[0] = (byte) (full ? 2 : 1);
        System.arraycopy(jpeg, 0, packet, 1, jpeg.length);
        return packet;
    }

    static byte[] capture(long requestId, byte[] jpeg) {
        if (requestId <= 0 || requestId > 0xffffffffL) throw new IllegalArgumentException("Invalid capture ID");
        return java.nio.ByteBuffer.allocate(jpeg.length + 5).put((byte) 3).putInt((int) requestId).put(jpeg).array();
    }
}
