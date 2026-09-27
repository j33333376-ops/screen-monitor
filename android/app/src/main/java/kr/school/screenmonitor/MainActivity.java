package kr.school.screenmonitor;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputFilter;
import android.text.InputType;
import android.text.util.Linkify;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.CheckBox;
import android.view.inputmethod.EditorInfo;

public class MainActivity extends Activity {
    private static final int CAPTURE_REQUEST = 10, NOTIFICATION_REQUEST = 11;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final String[] keys = { "server", "code", "grade", "cls", "num", "name" };
    private final EditText[] fields = new EditText[6];
    private final EditText[] addressParts = new EditText[5];
    private LinearLayout addressRow, directAddress;
    private CheckBox directMode;
    private TextView status, notice;
    private Button start, help;
    private boolean awaitingConsent;
    private Bundle pending;
    private ScreenShareService.State lastState;
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            ScreenShareService.State state = ScreenShareService.state;
            if (state != lastState) { lastState = state; render(); }
            main.postDelayed(this, 400);
        }
    };

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (saved != null) {
            awaitingConsent = saved.getBoolean("awaiting");
            pending = saved.getBundle("pending");
        }
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(243, 246, 251));
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
                        | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        FrameLayout outer = new FrameLayout(this);
        scroll.addView(outer);
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(24), dp(30), dp(24), dp(32));
        int available = getResources().getDisplayMetrics().widthPixels;
        FrameLayout.LayoutParams formParams = new FrameLayout.LayoutParams(
                Math.min(available, dp(640)), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        outer.addView(form, formParams);

        TextView eyebrow = text("SCREEN MONITOR · 학생용", 12, "#2563EB");
        form.addView(eyebrow);
        TextView title = text("선생님과 화면 공유", 28, "#16243A");
        title.setTypeface(null, Typeface.BOLD);
        title.setPadding(0, dp(8), 0, dp(8));
        form.addView(title);
        TextView intro = text("같은 Wi-Fi에서 수업에 참여하세요.\n전송 시작 후 Android의 화면 공유를 허용해 주세요.", 15, "#526078");
        intro.setLineSpacing(dp(4), 1);
        intro.setPadding(0, 0, 0, dp(18));
        form.addView(intro);

        addServerAddress(form);
        addField(form, 1, "수업 코드", "선생님이 알려 준 6자리", true);
        fields[1].setFilters(new InputFilter[] {new InputFilter.LengthFilter(6)});
        LinearLayout numbers = new LinearLayout(this);
        form.addView(numbers);
        String[] labels = {"학년", "반", "번호"};
        for (int i = 0; i < 3; i++) {
            LinearLayout column = new LinearLayout(this);
            column.setOrientation(LinearLayout.VERTICAL);
            if (i < 2) column.setPadding(0, 0, dp(10), 0);
            numbers.addView(column, new LinearLayout.LayoutParams(0, -2, 1));
            addField(column, i + 2, labels[i], "1~99", true);
            fields[i + 2].setFilters(new InputFilter[] {new InputFilter.LengthFilter(2)});
        }
        addField(form, 5, "이름", "학생 이름", false);
        fields[5].setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_WORDS);
        fields[5].setFilters(new InputFilter[] {new InputFilter.LengthFilter(20)});

        status = text("대기 중", 15, "#334155");
        status.setPadding(dp(16), dp(14), dp(16), dp(14));
        status.setBackground(rounded("#E5ECF7"));
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        form.addView(status, new LinearLayout.LayoutParams(-1, -2));
        start = new Button(this);
        start.setTextSize(17);
        start.setTextColor(Color.WHITE);
        start.setAllCaps(false);
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(-1, dp(58));
        buttonParams.topMargin = dp(14);
        form.addView(start, buttonParams);
        start.setOnClickListener(v -> toggle());
        help = new Button(this);
        help.setTextSize(16);
        help.setAllCaps(false);
        help.setTextColor(Color.parseColor("#8A4B08"));
        LinearLayout.LayoutParams helpParams = new LinearLayout.LayoutParams(-1, dp(52));
        helpParams.topMargin = dp(10);
        form.addView(help, helpParams);
        help.setOnClickListener(v -> startService(new Intent(this, ScreenShareService.class)
                .setAction(ScreenShareService.HELP).putExtra("on", !ScreenShareService.state.help)));
        notice = text("", 16, "#8A4B08");
        // 주소는 눌러서 브라우저로 열 수 있게 한다. setText 전에 지정해야 적용된다.
        notice.setAutoLinkMask(Linkify.WEB_URLS);
        notice.setLinksClickable(true);
        notice.setLinkTextColor(Color.parseColor("#1A4FD6"));
        notice.setPadding(dp(16), dp(14), dp(16), dp(14));
        notice.setBackground(rounded("#FFF4E1"));
        notice.setLineSpacing(dp(4), 1);
        notice.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        notice.setVisibility(View.GONE);
        LinearLayout.LayoutParams noticeParams = new LinearLayout.LayoutParams(-1, -2);
        noticeParams.topMargin = dp(14);
        form.addView(notice, noticeParams);
        TextView note = text("전송 중에는 선생님이 공유한 화면을 볼 수 있고 PDF로 저장할 수 있습니다.\n"
                + "공유 범위를 선택하는 창이 나오면 ‘전체 화면’을 선택하세요.\n"
                + "다른 앱으로 이동해도 전송은 계속됩니다. 이 앱이나 알림의 ‘전송 중지’로 언제든 멈출 수 있습니다.\n"
                + "화면이 꺼지면 대기하고 잠금 해제 후 자동으로 전송합니다. Android가 공유 권한을 종료한 경우에는 다시 허용해 주세요.\n"
                + "최근 앱 목록에서 이 앱을 지우면 전송을 중지합니다.", 13, "#64748B");
        note.setLineSpacing(dp(4), 1);
        note.setPadding(0, dp(18), 0, 0);
        form.addView(note);
        SharedPreferences prefs = getPreferences(MODE_PRIVATE);
        for (int i = 1; i < fields.length; i++) {
            String value = saved != null ? saved.getString(keys[i], "") :
                    (i == 1 ? "" : prefs.getString(keys[i], ""));
            fields[i].setText(value);
        }
        restoreServer(saved != null ? saved.getString("server", "") : prefs.getString("server", ""));
        ConnectionOptions resume = ScreenShareService.state.resumeOptions;
        if (resume != null && saved == null) {
            String[] values = {resume.url, resume.code, resume.grade, resume.cls, resume.num, resume.name};
            restoreServer(resume.url);
            for (int i = 1; i < fields.length; i++) fields[i].setText(values[i]);
        }
        setContentView(scroll);
        scroll.requestApplyInsets();
        lastState = ScreenShareService.state;
        render();
        if (!ScreenShareService.state.running && !directMode.isChecked()) addressParts[3].requestFocus();
    }

    private void addServerAddress(LinearLayout form) {
        TextView caption = text("서버 IP 주소 · 포트", 14, "#334155");
        caption.setPadding(0, dp(6), 0, dp(6));
        form.addView(caption);
        addressRow = new LinearLayout(this);
        addressRow.setGravity(Gravity.CENTER_VERTICAL);
        // IP addresses always read left-to-right even with an RTL system locale.
        addressRow.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);
        form.addView(addressRow);
        for (int i = 0; i < 5; i++) {
            if (i > 0) {
                TextView separator = text(i == 4 ? ":" : ".", 18, "#526078");
                separator.setPadding(dp(2), 0, dp(2), 0);
                addressRow.addView(separator);
            }
            EditText input = new EditText(this);
            input.setId(200 + i);
            input.setContentDescription(i == 4 ? "서버 포트" : "IP 주소 " + (i + 1) + "번째 숫자");
            input.setInputType(InputType.TYPE_CLASS_NUMBER);
            input.setSingleLine(true);
            input.setSelectAllOnFocus(true);
            input.setTextSize(16);
            input.setTextColor(Color.rgb(22, 36, 58));
            input.setGravity(Gravity.CENTER);
            input.setPadding(dp(2), 0, dp(2), 0);
            input.setBackground(rounded("#FFFFFF"));
            input.setFilters(new InputFilter[] {new InputFilter.LengthFilter(i == 4 ? 5 : 3)});
            input.setImeOptions(EditorInfo.IME_ACTION_NEXT);
            input.setNextFocusForwardId(i == 3 || i == 4 ? 101 : 201 + i);
            if (i == 3) input.setHint("입력");
            addressRow.addView(input, new LinearLayout.LayoutParams(0, dp(50), i == 4 ? 1.5f : 1));
            addressParts[i] = input;
        }
        directAddress = new LinearLayout(this);
        directAddress.setOrientation(LinearLayout.VERTICAL);
        addField(directAddress, 0, "서버 주소 직접 입력", "도메인 또는 https://주소", false);
        directAddress.setVisibility(View.GONE);
        form.addView(directAddress);
        TextView hint = text("빈칸에 네 번째 숫자를 입력하세요.\n다른 네트워크에서는 나머지 숫자도 바꿀 수 있습니다.", 12, "#526078");
        hint.setPadding(0, dp(6), 0, 0);
        form.addView(hint);
        directMode = new CheckBox(this);
        directMode.setText("주소 직접 입력 (도메인·HTTPS)");
        directMode.setTextSize(12);
        form.addView(directMode);
        directMode.setOnCheckedChangeListener((button, checked) -> {
            addressRow.setVisibility(checked ? View.GONE : View.VISIBLE);
            directAddress.setVisibility(checked ? View.VISIBLE : View.GONE);
            hint.setVisibility(checked ? View.GONE : View.VISIBLE);
        });
    }

    private void restoreServer(String value) {
        fields[0].setText(value);
        String[] parts = ConnectionOptions.splitIpv4(value);
        directMode.setChecked(parts == null);
        if (parts == null) parts = ConnectionOptions.splitIpv4("");
        for (int i = 0; i < 5; i++) addressParts[i].setText(parts[i]);
    }

    private String[] addressValues() {
        String[] parts = new String[5];
        for (int i = 0; i < 5; i++) parts[i] = addressParts[i].getText().toString().trim();
        return parts;
    }

    private void addField(LinearLayout parent, int index, String label, String hint, boolean numeric) {
        TextView caption = text(label, 14, "#334155");
        caption.setPadding(0, dp(6), 0, dp(6));
        parent.addView(caption);
        EditText input = new EditText(this);
        input.setId(100 + index);
        caption.setLabelFor(input.getId());
        input.setContentDescription(label);
        input.setSingleLine(true);
        input.setTextSize(16);
        input.setHint(hint);
        input.setTextColor(Color.rgb(22, 36, 58));
        input.setPadding(dp(14), 0, dp(14), 0);
        input.setInputType(numeric ? InputType.TYPE_CLASS_NUMBER :
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setBackground(rounded("#FFFFFF"));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(50));
        params.bottomMargin = dp(10);
        parent.addView(input, params);
        fields[index] = input;
    }

    private void toggle() {
        if (ScreenShareService.state.running) {
            startService(new Intent(this, ScreenShareService.class).setAction(ScreenShareService.STOP));
            return;
        }
        if (awaitingConsent) return;
        try {
            String server = directMode.isChecked() ? value(0) : ConnectionOptions.ipv4Address(addressValues());
            ConnectionOptions values = new ConnectionOptions(server, value(1), value(2), value(3), value(4), value(5));
            pending = new Bundle();
            pending.putString("url", values.url);
            pending.putString("code", values.code);
            pending.putString("grade", values.grade);
            pending.putString("cls", values.cls);
            pending.putString("num", values.num);
            pending.putString("name", values.name);
            ScreenShareService.State current = ScreenShareService.state;
            ConnectionOptions previous = current.resumeOptions;
            if (previous != null && previous.url.equals(values.url) && previous.code.equals(values.code)
                    && previous.grade.equals(values.grade) && previous.cls.equals(values.cls) && previous.num.equals(values.num)) {
                pending.putString("resumeKey", current.resumeKey);
            }
            awaitingConsent = true;
            render();
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
            } else requestCapture();
        } catch (IllegalArgumentException error) { status.setText(error.getMessage()); }
    }

    private void requestCapture() {
        try {
            startActivityForResult(getSystemService(MediaProjectionManager.class).createScreenCaptureIntent(), CAPTURE_REQUEST);
        } catch (RuntimeException error) {
            awaitingConsent = false;
            render();
            status.setText("화면 공유를 시작할 수 없습니다. 태블릿의 관리 정책을 확인하세요.");
        }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        if (request == NOTIFICATION_REQUEST && awaitingConsent) requestCapture();
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != CAPTURE_REQUEST) return;
        awaitingConsent = false;
        if (result != RESULT_OK || data == null || pending == null) {
            render();
            status.setText("화면 공유가 취소되었습니다. 전송하려면 다시 시작하세요.");
            return;
        }
        Intent service = new Intent(this, ScreenShareService.class).setAction(ScreenShareService.START);
        service.putExtras(pending);
        service.putExtra("resultCode", result);
        service.putExtra("captureData", data);
        pending = null;
        try {
            startForegroundService(service);
            status.setText("화면 공유를 준비하는 중…");
        } catch (RuntimeException error) {
            render();
            status.setText("화면 공유 시작에 실패했습니다. 앱을 연 상태에서 다시 시도하세요.");
        }
    }

    private void render() {
        ScreenShareService.State current = ScreenShareService.state;
        boolean active = current.running;
        help.setEnabled(active);
        help.setText(current.help ? "✋ 호출 취소 (선생님께 알림 중)" : "✋ 선생님 호출");
        help.setBackgroundTintList(ColorStateList.valueOf(Color.parseColor(current.help ? "#FFD79A" : "#EEF1F6")));
        if (current.notice == null) notice.setVisibility(View.GONE);
        else {
            notice.setVisibility(View.VISIBLE);
            notice.setText("선생님 (" + java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT)
                    .format(new java.util.Date(current.noticeAt)) + ")\n" + current.notice);
        }
        for (EditText field : fields) field.setEnabled(!active && !awaitingConsent);
        for (EditText field : addressParts) field.setEnabled(!active && !awaitingConsent);
        directMode.setEnabled(!active && !awaitingConsent);
        start.setEnabled(!awaitingConsent);
        start.setText(active ? "전송 중지" : awaitingConsent ? "화면 공유 허용 대기 중…" :
                ScreenShareService.state.resumeOptions != null ? "전송 재개" : "전송 시작");
        start.setBackgroundTintList(ColorStateList.valueOf(Color.parseColor(active ? "#DC4545" : "#2563EB")));
        status.setText(awaitingConsent ? "Android의 화면 공유 허용 창을 확인하세요." : ScreenShareService.state.message);
    }

    @Override protected void onResume() { super.onResume(); main.post(refresh); }
    @Override protected void onPause() {
        main.removeCallbacks(refresh);
        SharedPreferences.Editor prefs = getPreferences(MODE_PRIVATE).edit();
        for (int i = 0; i < fields.length; i++) if (i != 1) prefs.putString(keys[i], value(i));
        prefs.apply();
        super.onPause();
    }
    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        for (int i = 0; i < fields.length; i++) out.putString(keys[i], value(i));
        out.putBoolean("awaiting", awaitingConsent);
        out.putBundle("pending", pending);
    }
    private String value(int index) {
        if (index == 0 && !directMode.isChecked()) {
            String[] parts = addressValues(); // Keep partially typed values on rotation, without validating yet.
            return String.join(".", parts[0], parts[1], parts[2], parts[3]) + ":" + parts[4];
        }
        return fields[index].getText().toString().trim();
    }
    private int dp(int n) { return Math.round(n * getResources().getDisplayMetrics().density); }
    private TextView text(String value, int size, String color) {
        TextView view = new TextView(this);
        view.setText(value); view.setTextSize(size); view.setTextColor(Color.parseColor(color));
        return view;
    }
    private GradientDrawable rounded(String color) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.parseColor(color)); background.setCornerRadius(dp(12));
        return background;
    }
}
