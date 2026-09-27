package kr.school.screenmonitor;

import java.net.URI;
import java.util.Locale;

/** Input rules shared with the Windows client and the server. */
public final class ConnectionOptions {
    public final String url, code, grade, cls, num, name;

    public ConnectionOptions(String server, String code, String grade, String cls, String num, String name) {
        this.url = serverUrl(server);
        this.code = code.trim();
        if (!this.code.matches("[0-9]{6}")) throw new IllegalArgumentException("수업 코드는 6자리 숫자입니다.");
        this.grade = number(grade);
        this.cls = number(cls);
        this.num = number(num);
        this.name = name.trim();
        if (this.name.isEmpty() || this.name.length() > 20 || this.name.matches(".*[\\p{Cntrl}<>].*")) {
            throw new IllegalArgumentException("이름은 특수기호 없이 1~20자로 입력하세요.");
        }
    }

    private static String number(String input) {
        String value = input.trim();
        if (!value.matches("[0-9]{1,2}") || Integer.parseInt(value) < 1) {
            throw new IllegalArgumentException("학년, 반, 번호는 1~99의 숫자로 입력하세요.");
        }
        return Integer.toString(Integer.parseInt(value));
    }

    public static String ipv4Address(String[] parts) {
        if (parts == null || parts.length != 5) throw new IllegalArgumentException("IP 주소 네 칸과 포트를 입력하세요.");
        String[] normalized = new String[5];
        for (int i = 0; i < 5; i++) {
            String part = parts[i].trim();
            if (!part.matches(i == 4 ? "[0-9]{1,5}" : "[0-9]{1,3}"))
                throw new IllegalArgumentException("IP 주소는 각 칸에 0~255, 포트는 1~65535의 숫자를 입력하세요.");
            int value = Integer.parseInt(part);
            if (value < (i == 4 ? 1 : 0) || value > (i == 4 ? 65535 : 255))
                throw new IllegalArgumentException("IP 주소는 각 칸에 0~255, 포트는 1~65535의 숫자를 입력하세요.");
            normalized[i] = Integer.toString(value);
        }
        return String.join(".", normalized[0], normalized[1], normalized[2], normalized[3]) + ":" + normalized[4];
    }

    /** Preserve the previous LAN address, but never downgrade HTTPS to plain WS. */
    public static String[] splitIpv4(String value) {
        if (value == null || value.isEmpty()) return new String[] {"192", "168", "1", "", "8080"};
        String address = value.trim().replaceFirst("^(?:ws|http)://", "").replaceFirst("/(?:ws/?)?$", "");
        java.util.regex.Matcher match = java.util.regex.Pattern.compile(
                "^([0-9]{0,3})\\.([0-9]{0,3})\\.([0-9]{0,3})\\.([0-9]{0,3})(?::([0-9]{0,5}))?$").matcher(address);
        if (!match.matches()) return null;
        return new String[] {match.group(1), match.group(2), match.group(3), match.group(4),
                match.group(5) == null ? "8080" : match.group(5)};
    }

    public static String serverUrl(String input) {
        try {
            String value = input.trim();
            if (!value.contains("://")) value = "ws://" + value;
            URI uri = new URI(value);
            String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
            if (scheme.equals("http")) scheme = "ws";
            if (scheme.equals("https")) scheme = "wss";
            String path = uri.getPath();
            if ((!scheme.equals("ws") && !scheme.equals("wss")) || uri.getHost() == null
                    || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                    || !(path.isEmpty() || path.equals("/") || path.equals("/ws") || path.equals("/ws/"))) {
                throw new IllegalArgumentException();
            }
            int port = uri.getPort();
            if (port == 0 || port > 65535) throw new IllegalArgumentException();
            if (port == -1 && scheme.equals("ws")) port = 8080;
            return new URI(scheme, null, uri.getHost(), port, "/ws", null, null).toString();
        } catch (Exception error) {
            throw new IllegalArgumentException("서버 주소는 IP:포트 또는 http(s)://주소 형식으로 입력하세요.");
        }
    }

    public static int[] captureSize(int width, int height) {
        return captureSize(width, height, 1280);
    }

    public static int[] captureSize(int width, int height, int maxEdge) {
        if (width <= 0 || height <= 0) throw new IllegalArgumentException("화면 크기가 올바르지 않습니다.");
        if (maxEdge != 1280 && maxEdge != 2560) throw new IllegalArgumentException("지원하지 않는 캡처 크기입니다.");
        double scale = Math.min(1.0, (double) maxEdge / Math.max(width, height));
        return new int[] { Math.max(1, (int) Math.round(width * scale)),
                Math.max(1, (int) Math.round(height * scale)) };
    }
}
