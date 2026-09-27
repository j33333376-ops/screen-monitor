package kr.school.screenmonitor;

import org.json.JSONException;
import org.json.JSONObject;

final class StudentProtocol {
    private StudentProtocol() {}

    static String hello(ConnectionOptions options) throws JSONException {
        return new JSONObject().put("t", "hello").put("code", options.code)
                .put("grade", options.grade).put("cls", options.cls).put("num", options.num)
                .put("name", options.name).put("platform", "android")
                .put("highCapture", true).put("notice", true).toString();
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
