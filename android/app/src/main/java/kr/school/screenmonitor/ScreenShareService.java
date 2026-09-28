package kr.school.screenmonitor;

import android.app.Activity;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.graphics.Point;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.view.WindowManager;

import org.json.JSONException;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.TimeUnit;
import java.util.UUID;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/** All capture and connection state is confined to one worker, including callbacks. */
public class ScreenShareService extends Service {
    public static final String START = "kr.school.screenmonitor.START", STOP = "kr.school.screenmonitor.STOP",
            HELP = "kr.school.screenmonitor.HELP";
    private static final String CHANNEL = "screen_sharing", NOTICE_CHANNEL = "teacher_notice";
    private static final int NOTIFICATION_ID = 1, RESUME_ID = 2, NOTICE_ID = 3;
    public static final class State {
        public final boolean running;
        public final String message;
        public final ConnectionOptions resumeOptions;
        public final String resumeKey;
        public final String notice;      // 선생님이 마지막으로 보낸 안내 문구
        public final long noticeAt;
        public final boolean help;       // 손을 든 상태
        State(boolean running, String message) { this(running, message, null, null); }
        State(boolean running, String message, ConnectionOptions options, String key) {
            this(running, message, options, key, null, 0, false);
        }
        State(boolean running, String message, ConnectionOptions options, String key,
              String notice, long noticeAt, boolean help) {
            this.running = running; this.message = message; resumeOptions = options; resumeKey = key;
            this.notice = notice; this.noticeAt = noticeAt; this.help = help;
        }
    }
    public static volatile State state = new State(false, "대기 중 · 아직 화면을 전송하지 않습니다.");
    /** 교사 서버에 더 새로운 앱이 있으면 {버전, 받기 주소}. 앱 화면이 '새 버전 받기' 버튼으로 보여 준다. */
    public static volatile String[] update = null;
    private HandlerThread thread;
    private Handler worker;
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private Bitmap latest;
    private OkHttpClient client;
    private WebSocket socket;
    private ConnectionOptions options;
    private String resumeKey;
    private boolean paused;
    private long lastTick;
    private boolean stopping, registered, full, recording, receiverRegistered, started, help;
    private String notice;
    private long noticeAt;
    private int width, height, generation;
    private int sourceWidth, sourceHeight, captureEdge = 1280;
    private long captureRequest;
    private long lastSent;
    private final Runnable connectTask = this::connect;
    private final Runnable sendTask = new Runnable() {
        @Override public void run() {
            if (stopping) return;
            long tick = SystemClock.elapsedRealtime();
            boolean woke = lastTick > 0 && tick - lastTick > 15000;
            lastTick = tick;
            refreshScreenState(woke);
            try {
                if (!paused && reader != null && registered && socket != null) {
                    long now = SystemClock.elapsedRealtime();
                    long interval = full ? 1000 : 2000;
                    if (now - lastSent >= interval && socket.queueSize() < 1024 * 1024) {
                        updateBitmap();
                        if (latest != null) {
                            Bitmap output = latest;
                            double scale = full ? Math.min(1.0, 1280.0 / Math.max(latest.getWidth(), latest.getHeight()))
                                    : Math.min(1.0, 480.0 / latest.getWidth());
                            if (scale < 1.0) {
                                output = Bitmap.createScaledBitmap(latest, Math.max(1, (int) Math.round(latest.getWidth() * scale)),
                                        Math.max(1, (int) Math.round(latest.getHeight() * scale)), true);
                            }
                            ByteArrayOutputStream packet = new ByteArrayOutputStream();
                            boolean compressed = output.compress(Bitmap.CompressFormat.JPEG, full ? 62 : 45, packet);
                            if (output != latest) output.recycle();
                            if (compressed && !socket.send(ByteString.of(StudentProtocol.frame(full, packet.toByteArray())))) reconnect(socket);
                            lastSent = now;
                        }
                    }
                }
            } catch (RuntimeException error) {
                updateStatus("화면 복구 대기 중… 잠금 해제 후 다시 전송합니다.");
                worker.postDelayed(this, 2000);
                return;
            }
            if (!stopping) worker.postDelayed(this, 100);
        }
    };

    private final MediaProjection.Callback projectionCallback = new MediaProjection.Callback() {
        @Override public void onStop() {
            if (stopping) return;
            release();
            state = new State(false, "Android가 화면 공유 권한을 종료했습니다. ‘전송 재개’를 눌러 다시 허용해 주세요.", options, resumeKey);
            getSystemService(NotificationManager.class).notify(RESUME_ID,
                    new Notification.Builder(ScreenShareService.this, CHANNEL).setSmallIcon(R.drawable.ic_monitor)
                            .setContentTitle("화면 공유 재개 필요").setContentText("앱을 열고 전송 재개를 눌러 주세요.")
                            .setContentIntent(openApp()).setAutoCancel(true).build());
            stopSelf();
        }
        @Override public void onCapturedContentResize(int newWidth, int newHeight) {
            if (stopping || display == null) return;
            try { resize(newWidth, newHeight); }
            catch (RuntimeException error) { finish("화면 크기 변경 중 공유가 중지되었습니다. 다시 시작해 주세요."); }
        }
    };
    private final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
        @Override public void onDisplayAdded(int id) {}
        @Override public void onDisplayRemoved(int id) {}
        @Override public void onDisplayChanged(int id) {
            if (Build.VERSION.SDK_INT < 34 && !stopping && !paused && display != null) {
                try { Point size = screenSize(); resize(size.x, size.y); }
                catch (RuntimeException error) { finish("화면 회전 중 공유가 중지되었습니다. 다시 시작해 주세요."); }
            }
        }
    };
    private final BroadcastReceiver screenOff = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            worker.post(() -> refreshScreenState(false));
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        try {
            android.content.pm.PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            StudentProtocol.appVersion = info.versionName;
            StudentProtocol.appBuild = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
        } catch (android.content.pm.PackageManager.NameNotFoundException ignored) { /* 버전 없이 접속한다. */ }
        thread = new HandlerThread("screen-share");
        thread.start();
        worker = new Handler(thread.getLooper());
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(
                new NotificationChannel(CHANNEL, "화면 공유 상태", NotificationManager.IMPORTANCE_LOW));
        // 다른 앱을 쓰는 중에도 보이도록 선생님 메시지는 별도의 높은 중요도 채널을 쓴다.
        manager.createNotificationChannel(
                new NotificationChannel(NOTICE_CHANNEL, "선생님 메시지", NotificationManager.IMPORTANCE_HIGH));
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP.equals(intent.getAction())) {
            worker.post(() -> finish("전송을 멈췄습니다."));
            return START_NOT_STICKY;
        }
        if (HELP.equals(intent.getAction())) {
            // 전송 중이 아니면 손들기를 보낼 곳이 없다. 앱 화면의 버튼도 그때는 비활성이다.
            if (started) {
                boolean on = intent.getBooleanExtra("on", false);
                worker.post(() -> raiseHand(on));
            }
            return START_NOT_STICKY;
        }
        if (!START.equals(intent.getAction()) || started) return START_NOT_STICKY;
        started = true;
        state = new State(true, "화면 공유 준비 중…");
        try {
            Notification notification = notification(state.message);
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            else startForeground(NOTIFICATION_ID, notification);
            IntentFilter filter = new IntentFilter(Intent.ACTION_SCREEN_OFF);
            filter.addAction(Intent.ACTION_SCREEN_ON);
            filter.addAction(Intent.ACTION_USER_PRESENT);
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenOff, filter, Context.RECEIVER_NOT_EXPORTED);
            else registerReceiver(screenOff, filter);
            receiverRegistered = true;
            worker.post(() -> begin(intent));
        } catch (RuntimeException error) {
            worker.post(() -> finish("화면 공유 서비스를 시작하지 못했습니다. 앱을 다시 열고 허용해 주세요."));
        }
        // Never restart a capture after process death without fresh student consent.
        return START_NOT_STICKY;
    }

    private void begin(Intent intent) {
        if (stopping) return;
        try {
            options = new ConnectionOptions(intent.getStringExtra("url"), intent.getStringExtra("code"),
                    intent.getStringExtra("grade"), intent.getStringExtra("cls"),
                    intent.getStringExtra("num"), intent.getStringExtra("name"));
            resumeKey = intent.getStringExtra("resumeKey");
            if (resumeKey == null) resumeKey = UUID.randomUUID().toString();
            paused = screenUnavailable();
            getSystemService(NotificationManager.class).cancel(RESUME_ID);
            help = false; notice = null; noticeAt = 0;
            Intent data = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra("captureData", Intent.class)
                    : intent.getParcelableExtra("captureData");
            int result = intent.getIntExtra("resultCode", Activity.RESULT_CANCELED);
            if (result != Activity.RESULT_OK || data == null) throw new IllegalArgumentException();
            projection = getSystemService(MediaProjectionManager.class).getMediaProjection(result, data);
            if (projection == null) throw new IllegalStateException();
            projection.registerCallback(projectionCallback, worker);
            Point initial = screenSize();
            sourceWidth = initial.x; sourceHeight = initial.y;
            int[] size = ConnectionOptions.captureSize(initial.x, initial.y);
            width = size[0]; height = size[1];
            reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3);
            display = projection.createVirtualDisplay("Student screen", width, height,
                    getResources().getConfiguration().densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    reader.getSurface(), null, worker);
            if (display == null) throw new IllegalStateException();
            getSystemService(DisplayManager.class).registerDisplayListener(displayListener, worker);
            client = new OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
                    .readTimeout(0, TimeUnit.MILLISECONDS).pingInterval(20, TimeUnit.SECONDS).build();
            connect();
            worker.post(sendTask);
        } catch (RuntimeException error) {
            finish("화면 공유를 시작하지 못했습니다. 전송 시작을 다시 누르고 화면 공유를 허용해 주세요.");
        }
    }

    private Point screenSize() {
        WindowManager manager = getSystemService(WindowManager.class);
        if (Build.VERSION.SDK_INT >= 30) {
            Rect bounds = manager.getMaximumWindowMetrics().getBounds();
            return new Point(bounds.width(), bounds.height());
        }
        Point size = new Point();
        manager.getDefaultDisplay().getRealSize(size);
        return size;
    }

    private void resize(int capturedWidth, int capturedHeight) {
        sourceWidth = capturedWidth; sourceHeight = capturedHeight;
        int[] size = ConnectionOptions.captureSize(capturedWidth, capturedHeight, captureEdge);
        if (size[0] == width && size[1] == height) return;
        ImageReader replacement = ImageReader.newInstance(size[0], size[1], PixelFormat.RGBA_8888, 3);
        try {
            display.setSurface(null);
            display.resize(size[0], size[1], getResources().getConfiguration().densityDpi);
            display.setSurface(replacement.getSurface());
        } catch (RuntimeException error) { replacement.close(); throw error; }
        reader.close(); reader = replacement;
        width = size[0]; height = size[1];
        if (latest != null) { latest.recycle(); latest = null; }
        lastSent = 0;
    }

    private void updateBitmap() {
        try (Image image = reader.acquireLatestImage()) {
            if (image == null) return; // Static screens reuse the last bitmap, keeping the server heartbeat fresh.
            Image.Plane plane = image.getPlanes()[0];
            int pixelStride = plane.getPixelStride();
            int paddedWidth = plane.getRowStride() / pixelStride;
            Bitmap padded = Bitmap.createBitmap(paddedWidth, image.getHeight(), Bitmap.Config.ARGB_8888);
            ByteBuffer pixels = plane.getBuffer();
            pixels.rewind();
            // Some devices omit the unused padding at the end of the final row.
            int required = padded.getByteCount();
            if (pixels.remaining() < required) {
                ByteBuffer complete = ByteBuffer.allocate(required);
                complete.put(pixels).rewind();
                padded.copyPixelsFromBuffer(complete);
            } else padded.copyPixelsFromBuffer(pixels);
            Bitmap cropped = Bitmap.createBitmap(padded, 0, 0, image.getWidth(), image.getHeight());
            if (cropped != padded) padded.recycle();
            if (latest != null) latest.recycle();
            latest = cropped;
        }
    }

    private void connect() {
        if (stopping) return;
        worker.removeCallbacks(connectTask);
        registered = false; full = false; recording = false;
        int attempt = ++generation;
        updateStatus("선생님 서버에 연결 중…");
        socket = client.newWebSocket(new Request.Builder().url(options.url).build(), new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response response) {
                worker.post(() -> {
                    if (stopping || attempt != generation || socket != ws) { ws.cancel(); return; }
                    try {
                        ws.send(StudentProtocol.hello(options, resumeKey, paused, help));
                    } catch (JSONException error) { finish("학생 정보를 확인해 주세요."); }
                });
            }
            @Override public void onMessage(WebSocket ws, String message) {
                worker.post(() -> {
                    if (stopping || attempt != generation || socket != ws) return;
                    try {
                        JSONObject msg = new JSONObject(message);
                        switch (msg.optString("t")) {
                            case "ok":
                                registered = true; recording = msg.optBoolean("recording"); lastSent = 0;
                                update = StudentProtocol.update(options.url, msg.optJSONObject("update"));
                                configureCapture(msg);
                                monitoringStatus(); break;
                            case "mode": full = msg.optBoolean("full"); lastSent = 0; break;
                            case "recording":
                                recording = msg.optBoolean("on"); configureCapture(msg);
                                if (registered) monitoringStatus(); break;
                            case "capture":
                                long id = msg.optLong("requestId", 0);
                                if (!paused && registered && recording && captureEdge == 2560 && id > 0 && id <= 0xffffffffL) {
                                    captureRequest = id;
                                    sendCapture(ws, id, 0);
                                }
                                break;
                            case "notice": showNotice(msg.optString("text")); break;
                            case "help":
                                help = msg.optBoolean("on");
                                updateStatus(state.message);
                                break;
                            case "end": finish("수업이 종료되었습니다."); break;
                            case "error":
                                if (msg.optBoolean("fatal")) finish("오류: " + msg.optString("msg"));
                                else updateStatus("오류: " + msg.optString("msg"));
                                break;
                            default: break;
                        }
                    } catch (JSONException ignored) { /* Ignore malformed control messages. */ }
                    catch (RuntimeException error) { finish("저장 화질 변경 중 화면 공유가 중지되었습니다. 다시 시작해 주세요."); }
                });
            }
            @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
                worker.post(() -> { if (attempt == generation) reconnect(ws); });
            }
            @Override public void onClosing(WebSocket ws, int code, String reason) {
                ws.close(code, reason);
                worker.post(() -> { if (attempt == generation) reconnect(ws); });
            }
            @Override public void onClosed(WebSocket ws, int code, String reason) {
                worker.post(() -> { if (attempt == generation) reconnect(ws); });
            }
        });
        WebSocket pending = socket;
        worker.postDelayed(() -> { if (!registered && attempt == generation) reconnect(pending); }, 12000);
    }

    private void reconnect(WebSocket previous) {
        if (stopping || previous == null || previous != socket) return;
        registered = false; full = false; recording = false;
        socket = null; generation++;
        previous.cancel();
        updateStatus("연결 끊김 · 다시 연결 중… 같은 Wi-Fi와 서버 주소를 확인하세요.");
        worker.removeCallbacks(connectTask);
        worker.postDelayed(connectTask, 2000);
    }

    private void monitoringStatus() {
        if (paused) { updateStatus("화면 꺼짐·잠금 대기 중 · 잠금 해제 후 자동으로 전송합니다."); return; }
        updateStatus("전송 중 · 선생님이 화면을 보고 있습니다\n" +
                (recording ? (captureEdge == 2560 ? "AI 분석용 고화질 기록 수집 중" : "PDF 기록 수집 켜짐") : "PDF 기록 수집 꺼짐"));
    }

    private void configureCapture(JSONObject message) {
        int edge = recording && "ai".equals(message.optString("captureQuality")) ? 2560 : 1280;
        if (captureEdge == edge) return;
        captureEdge = edge;
        captureRequest = 0;
        if (display != null) resize(sourceWidth, sourceHeight);
    }

    private void sendCapture(WebSocket ws, long id, int retries) {
        if (stopping || paused || !registered || !recording || captureEdge != 2560 || socket != ws || captureRequest != id) return;
        try {
            updateBitmap();
            if (latest == null || ws.queueSize() > 4 * 1024 * 1024) {
                if (retries < 30) worker.postDelayed(() -> sendCapture(ws, id, retries + 1), 100);
                return;
            }
            ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
            if (latest.compress(Bitmap.CompressFormat.JPEG, 85, jpeg)) {
                if (!ws.send(ByteString.of(StudentProtocol.capture(id, jpeg.toByteArray())))) reconnect(ws);
            }
            captureRequest = 0;
        } catch (RuntimeException error) {
            captureRequest = 0;
            updateStatus("고화질 캡처에 실패했습니다. 다음 저장 시점에 다시 시도합니다.");
        }
    }
    /** The raised hand outlives a reconnect: the next hello carries it to the server. */
    private void raiseHand(boolean on) {
        if (stopping || help == on) return;
        help = on;
        if (registered && socket != null) {
            try { socket.send(StudentProtocol.help(on)); }
            catch (JSONException ignored) { /* 손들기 실패는 화면 전송에 영향을 주지 않는다. */ }
        }
        updateStatus(state.message);
    }

    private void showNotice(String text) {
        if (stopping || text == null || text.trim().isEmpty()) return;
        notice = text.trim();
        noticeAt = System.currentTimeMillis();
        getSystemService(NotificationManager.class).notify(NOTICE_ID,
                new Notification.Builder(this, NOTICE_CHANNEL).setSmallIcon(R.drawable.ic_monitor)
                        .setContentTitle("선생님 메시지").setContentText(notice)
                        .setStyle(new Notification.BigTextStyle().bigText(notice))
                        .setContentIntent(openApp()).setAutoCancel(true)
                        .setCategory(Notification.CATEGORY_MESSAGE)
                        .setDefaults(Notification.DEFAULT_ALL).build());
        updateStatus(state.message);
    }

    private void updateStatus(String text) {
        if (stopping) return;
        state = new State(true, text, options, resumeKey, notice, noticeAt, help);
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(text));
    }
    private PendingIntent openApp() {
        return PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE);
    }
    private Notification notification(String text) {
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, ScreenShareService.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_monitor)
                .setContentTitle("학생 화면 공유 중").setContentText(text.replace('\n', ' '))
                .setStyle(new Notification.BigTextStyle().bigText(text)).setContentIntent(openApp())
                .addAction(new Notification.Action.Builder(null, "전송 중지", stop).build())
                .setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_SERVICE).build();
    }

    private boolean screenUnavailable() {
        return !getSystemService(PowerManager.class).isInteractive()
                || getSystemService(KeyguardManager.class).isKeyguardLocked();
    }

    private void refreshScreenState(boolean woke) {
        if (stopping || client == null) return;
        boolean unavailable = screenUnavailable();
        boolean changed = paused != unavailable;
        paused = unavailable;
        if (changed || woke) {
            captureRequest = 0;
            lastSent = 0;
            if (latest != null) { latest.recycle(); latest = null; }
            // Discard a pre-lock buffer; only a newly acquired image may be transmitted.
            if (reader != null) {
                try (Image stale = reader.acquireLatestImage()) { /* discard */ }
                catch (RuntimeException ignored) { /* try again on the next frame */ }
            }
        }
        if (changed && paused) {
            if (registered && socket != null) socket.send("{\"t\":\"pause\",\"paused\":true}");
            monitoringStatus();
        } else if (!paused && (changed || woke)) {
            // The old TCP connection may still look open after Doze. Replace it now.
            if (socket != null) { WebSocket old = socket; socket = null; generation++; old.cancel(); }
            connect();
        }
    }

    private void release() {
        if (stopping) return;
        stopping = true; registered = false; generation++;
        worker.removeCallbacksAndMessages(null);
        if (socket != null) { socket.cancel(); socket = null; }
        if (display != null) { display.release(); display = null; }
        if (reader != null) { reader.close(); reader = null; }
        if (latest != null) { latest.recycle(); latest = null; }
        if (projection != null) {
            projection.unregisterCallback(projectionCallback);
            projection.stop(); projection = null;
        }
        getSystemService(DisplayManager.class).unregisterDisplayListener(displayListener);
        if (client != null) {
            client.connectionPool().evictAll(); client.dispatcher().executorService().shutdown();
        }
    }
    private void finish(String message) {
        if (stopping) return;
        release();
        state = new State(false, message);
        stopSelf();
    }
    @Override public void onTaskRemoved(Intent rootIntent) { worker.post(() -> finish("앱을 닫아 전송을 멈췄습니다.")); }
    @Override public void onDestroy() {
        if (receiverRegistered) unregisterReceiver(screenOff);
        stopForeground(STOP_FOREGROUND_REMOVE);
        worker.post(() -> {
            if (!stopping) { release(); state = new State(false, "전송이 중지되었습니다."); }
            thread.quitSafely();
        });
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
