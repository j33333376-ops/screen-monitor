# -*- coding: utf-8 -*-
"""
학생 화면 전송 프로그램 (시제품)

역할:
  - 수업 코드 / 반 / 번호 / 이름을 입력받아 서버에 연결한다.
  - 2초마다 화면을 작게 줄여(JPEG) 서버로 보낸다.
  - 교사가 이 학생을 확대하면(full 모드) 잠시 고화질로 보낸다.
  - 선생님이 보낸 짧은 안내 문구를 창에 띄운다.
  - '선생님 호출'을 누르면 교사 화면에 손든 표시가 올라간다.
  - '전송 중지'를 누르면 즉시 전송을 멈춘다.
  - 창을 닫으면 트레이 아이콘으로 숨고 전송은 이어진다. 종료는 트레이 메뉴에서만 한다.

개인정보 원칙:
  - 화면은 파일로 저장하지 않는다.
  - 다음 실행 때 다시 입력하지 않도록 서버 주소·학년·반·번호·이름만 이 PC 사용자 폴더
    (%APPDATA%\\ScreenMonitorStudent\\settings.json)에 저장한다. 수업 코드는 저장하지 않는다.
  - 항상 "모니터링 중" 상태가 창에 보인다. 창을 숨겨도 트레이 아이콘의 색과 설명에 남는다.
  - 자동 실행/자동 시작 없음. 학생이 직접 실행하고 코드를 입력해야만 동작한다.

배포 시에는 백신 오탐이 적은 C#(.NET)으로 다시 만드는 것을 권장. 이 파일은 동작 검증용.
"""
import io
import os
import re
import time
import json
import threading
import queue
import uuid
import webbrowser
from urllib.parse import urlsplit, urlunsplit
import tkinter as tk
from tkinter import ttk
from single_instance import SingleInstance, already_running_message
from server_address import ServerAddressInput

import mss
import pystray
from PIL import Image, ImageDraw
import websocket  # websocket-client

# ---- 설정 ----
# 교사 서버가 이 번호로 새 버전 여부를 판단한다. 올릴 때 build-exe.ps1이 dist/version.json에 같은 값을 적는다.
APP_VERSION = "1.5.0"
# 서버 주소는 실행 창에서 입력한다. 아래는 입력칸 기본값.
DEFAULT_SERVER = ""   # 배포 시 도메인(wss)으로 교체
# 다음 수업에 다시 입력하지 않도록 기억하는 칸. 수업 코드는 수업마다 바뀌므로 기억하지 않는다(Android 앱과 같음).
SETTINGS_KEYS = ("server", "grade", "cls", "num", "name")
THUMB_W = 480          # 평상시 가로 픽셀
THUMB_INTERVAL = 2.0   # 초
THUMB_QUALITY = 45
FULL_W = 1280          # 확대 대상일 때
FULL_INTERVAL = 1.0
FULL_QUALITY = 62

# 선생님 메시지 안의 주소를 눌러서 열 수 있게 찾아낸다.
LINK_PATTERN = re.compile(r"(?:https?://|www\.)[^\s<>\"']+", re.IGNORECASE)
LINK_TRAILING = ".,;:!?]}'\"\u00b7"


def link_spans(text):
    """Yield (start, url) for each address, dropping the punctuation that follows it."""
    for match in LINK_PATTERN.finditer(text):
        url, depth = "", 0
        for char in match.group():
            if char == "(":
                depth += 1
            elif char == ")":
                # 여는 괄호 없이 닫히면 주소가 아니라 문장의 괄호다: 여기서 끊는다.
                if depth == 0:
                    break
                depth -= 1
            url += char
        url = url.rstrip(LINK_TRAILING)
        if url and url.lower() not in ("http://", "https://", "www."):
            yield match.start(), url


KIND_THUMB = 1
KIND_FULL = 2
KIND_CAPTURE = 3
CAPTURE_MAX_EDGE = 2560
CAPTURE_QUALITY = 85


def capture_packet(image, request_id):
    """Encode the original screen, never an enlarged live thumbnail."""
    if max(image.size) > CAPTURE_MAX_EDGE:
        scale = CAPTURE_MAX_EDGE / max(image.size)
        image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=CAPTURE_QUALITY)
    return bytes([KIND_CAPTURE]) + request_id.to_bytes(4, "big") + output.getvalue()


def settings_path():
    """이 PC 사용자 폴더에만 저장한다(%APPDATA%\\ScreenMonitorStudent). 테스트는 환경 변수로 바꾼다."""
    override = os.environ.get("SCREEN_MONITOR_SETTINGS")
    if override:
        return override
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(base, "ScreenMonitorStudent", "settings.json")


def load_settings():
    try:
        with open(settings_path(), encoding="utf-8") as file:
            data = json.load(file)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {key: str(data[key])[:200] for key in SETTINGS_KEYS if isinstance(data.get(key), (str, int))}


def save_settings(values):
    """저장에 실패해도 전송은 그대로 한다(다음에 다시 입력하면 될 뿐이다)."""
    path = settings_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temp = path + ".tmp"
        with open(temp, "w", encoding="utf-8") as file:
            json.dump({key: values[key] for key in SETTINGS_KEYS if key in values}, file, ensure_ascii=False)
        os.replace(temp, path)
    except OSError:
        pass


def update_url(ws_url, update):
    """교사 서버가 알려 준 새 버전 받기 주소. 같은 서버의 /download/ 아래만 허용한다."""
    if not isinstance(update, dict):
        return None, None
    version, path = update.get("version"), update.get("url")
    if not (isinstance(version, str) and re.fullmatch(r"\d+(\.\d+){0,3}", version)):
        return None, None
    if not (isinstance(path, str) and re.fullmatch(r"/download/[a-z]+", path)):
        return None, None
    parts = urlsplit(ws_url)
    scheme = "https" if parts.scheme == "wss" else "http"
    return version, urlunsplit((scheme, parts.netloc, path, "", ""))


def server_url(value):
    value = value.strip()
    if "://" not in value:
        value = "ws://" + value
    parts = urlsplit(value)
    scheme = {"http": "ws", "https": "wss"}.get(parts.scheme, parts.scheme)
    if (scheme not in ("ws", "wss") or not parts.hostname or parts.username
            or parts.password or parts.query or parts.fragment or parts.path not in ("", "/", "/ws", "/ws/")):
        raise ValueError("서버 주소는 IP:포트 또는 http(s)://주소 형식으로 입력하세요.")
    port = parts.port  # Invalid port syntax raises ValueError here, before starting a worker.
    host = parts.netloc
    if port is None and scheme == "ws":
        host += ":8080"
    return urlunsplit((scheme, host, "/ws", "", ""))


class Sender:
    """One immutable run per start; a capture worker survives connection retries."""
    def __init__(self, ui):
        self.ui = ui
        self.ws = None
        self.running = False
        self.full = False
        self.recording = False
        self.capture_quality = "standard"
        self.capture_requests = queue.Queue(maxsize=2)
        self.help = False
        # 소켓 한 개를 UI 스레드와 캡처 스레드가 함께 쓰므로 전송을 직렬화한다.
        self.send_lock = threading.Lock()
        self.registered = False
        self.stop_event = threading.Event()
        self.thread = None
        self.cap_thread = None
        self.capture_waiting = False

    def status(self, text, ok=None):
        self.ui.set_status(text, ok=ok, source=self)

    def monitoring_status(self):
        suffix = (" · AI 분석용 고화질 기록 중" if self.capture_quality == "ai" else " · 선생님이 PDF 저장 중") if self.recording else " · PDF 저장 꺼짐"
        self.status("전송 중 ● 모니터링되고 있습니다" + suffix, ok=True)

    def start(self, server, code, grade, cls, num, name):
        self.url = server_url(server)
        self.hello = dict(t="hello", code=code, grade=grade, cls=cls, num=num, name=name,
                          platform="windows", version=APP_VERSION,
                          highCapture=True, notice=True, help=False, resumeKey=uuid.uuid4().hex)
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
        self.registered = False
        self.stop_event.set()
        # Closing a socket may wait; never block the Tk event loop.
        connection = self.ws
        if connection:
            threading.Thread(target=connection.close, daemon=True).start()

    def send_json(self, obj):
        connection = self.ws
        if not connection or not self.registered or self.stop_event.is_set():
            return False
        try:
            with self.send_lock:
                connection.send(json.dumps(obj))
            return True
        except Exception:
            return False

    def set_help(self, on):
        """Keep the raised hand across reconnects: the next hello carries it too."""
        self.help = on
        self.hello["help"] = on
        self.send_json({"t": "help", "on": on})
        self.ui.help_changed(self)

    def _on_message(self, ws, message):
        if ws is not self.ws or self.stop_event.is_set():
            return
        try:
            msg = json.loads(message)
        except (ValueError, TypeError):
            return
        if not isinstance(msg, dict):
            return
        kind = msg.get("t")
        if kind == "ok":
            self.recording = bool(msg.get("recording"))
            self.capture_quality = msg.get("captureQuality", "standard")
            self.registered = True
            self.monitoring_status()
            version, url = update_url(self.url, msg.get("update"))
            if url:
                self.ui.update_available(self, version, url)
        elif kind == "mode":
            self.full = bool(msg.get("full"))
        elif kind == "recording":
            self.recording = bool(msg.get("on"))
            self.capture_quality = msg.get("captureQuality", "standard")
            self.monitoring_status()
        elif kind == "capture":
            request_id = msg.get("requestId")
            if (self.registered and self.recording and self.capture_quality == "ai"
                    and type(request_id) is int and 0 < request_id <= 0xffffffff):
                try:
                    self.capture_requests.put_nowait((ws, request_id))
                except queue.Full:
                    pass  # The server retries at the next sampling interval.
        elif kind == "notice":
            text = str(msg.get("text", "")).strip()
            if text:
                self.ui.notice(self, text)
        elif kind == "help":
            self.help = bool(msg.get("on"))
            self.hello["help"] = self.help
            self.ui.help_changed(self)
        elif kind == "end":
            self.status("수업이 종료되었습니다.", ok=False)
            self.stop()
        elif kind == "error":
            self.status("오류: " + str(msg.get("msg", "")), ok=False)
            if msg.get("fatal"):
                self.stop()

    def _on_open(self, ws):
        if self.stop_event.is_set():
            ws.close()
            return
        with self.send_lock:
            ws.send(json.dumps(self.hello))

    def _on_close(self, ws, *_):
        if ws is self.ws:
            self.registered = False

    def _run(self):
        self.cap_thread = threading.Thread(target=self._capture_loop, daemon=True)
        self.cap_thread.start()
        try:
            while not self.stop_event.is_set():
                self.registered = False
                self.full = False
                self.status("연결 중…")
                connection = websocket.WebSocketApp(
                    self.url, on_open=self._on_open, on_message=self._on_message,
                    on_close=self._on_close)
                self.ws = connection
                try:
                    if not self.stop_event.is_set():
                        connection.run_forever(ping_interval=20, ping_timeout=10)
                except Exception as error:
                    if not self.stop_event.is_set():
                        self.status(f"연결 오류: {error}")
                finally:
                    self.registered = False
                    connection.close()
                if not self.stop_event.is_set():
                    self.status("연결이 끊겼습니다. 다시 연결 중…")
                    self.stop_event.wait(2)
        finally:
            self.running = False
            self.stop_event.set()
            self.ui.finished(self)

    def _capture_loop(self):
        capture = None
        previous_ws = None
        last = 0.0
        last_tick = time.time()
        try:
            while not self.stop_event.is_set():
                now = time.time()
                woke = now - last_tick > 15
                last_tick = now
                if woke:
                    if capture is not None:
                        try:
                            capture.close()
                        except Exception:
                            pass
                        capture = None
                    connection = self.ws
                    self.registered = False
                    self.status("절전 복귀 감지 · 다시 연결 중…")
                    if connection is not None:
                        connection.close()
                connection = self.ws
                if not self.registered or connection is None:
                    self.stop_event.wait(0.05)
                    continue
                if connection is not previous_ws:
                    previous_ws, last = connection, 0.0
                full = self.full
                request_id = None
                try:
                    source, requested_id = self.capture_requests.get_nowait()
                    if source is connection and self.recording and self.capture_quality == "ai":
                        request_id = requested_id
                except queue.Empty:
                    pass
                interval = FULL_INTERVAL if full else THUMB_INTERVAL
                if request_id is None and time.monotonic() - last < interval:
                    self.stop_event.wait(0.05)
                    continue
                try:
                    if capture is None:
                        capture = mss.mss()
                    raw = capture.grab(capture.monitors[1])
                    img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
                except Exception:
                    # Sleep, lock and display reconfiguration can invalidate MSS handles.
                    # Keep the student's run alive and recreate capture on this thread.
                    if capture is not None:
                        try:
                            capture.close()
                        except Exception:
                            pass
                    capture = None
                    self.capture_waiting = True
                    self.status("화면 복구 대기 중… 잠금 해제·절전 복귀 후 자동으로 전송합니다.")
                    self.stop_event.wait(2)
                    continue
                if request_id is not None:
                    packet = capture_packet(img, request_id)
                else:
                    width, quality, kind = (FULL_W, FULL_QUALITY, KIND_FULL) if full else (THUMB_W, THUMB_QUALITY, KIND_THUMB)
                    if img.width > width:
                        img = img.resize((width, max(1, int(img.height * width / img.width))), Image.Resampling.BILINEAR)
                    buf = io.BytesIO()
                    img.save(buf, format="JPEG", quality=quality)
                    packet = bytes([kind]) + buf.getvalue()
                # A stop or reconnect during capture must not send to a replacement socket.
                if self.stop_event.is_set() or not self.registered or connection is not self.ws:
                    continue
                try:
                    with self.send_lock:
                        connection.send(packet, opcode=websocket.ABNF.OPCODE_BINARY)
                    if self.capture_waiting:
                        self.capture_waiting = False
                        self.monitoring_status()
                    if request_id is None:
                        last = time.monotonic()
                except Exception:
                    if connection is self.ws:
                        self.registered = False
                        connection.close()  # Forces the connection worker to reconnect.
        except Exception as error:
            self.status(f"화면 캡처 오류: {error}", ok=False)
            self.stop()
        finally:
            if capture is not None:
                capture.close()


TRAY_NAME = "학생 화면 전송"
TRAY_TIP_MAX = 127      # Windows 트레이 설명(szTip) 한도
TRAY_MESSAGE_MAX = 255  # 풍선 알림(szInfo) 한도


def tray_image(active):
    """전송 중인지 트레이에서도 보이도록 아이콘 색을 바꾼다(초록=전송 중, 회색=대기)."""
    color = (47, 174, 102) if active else (128, 133, 141)
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((4, 10, 60, 44), radius=6, fill=color)
    draw.rectangle((12, 18, 52, 36), fill=(255, 255, 255, 255))
    draw.rectangle((26, 44, 38, 52), fill=color)
    draw.rectangle((18, 52, 46, 58), fill=color)
    return image


class Tray:
    """작업 표시줄 오른쪽 끝의 트레이 아이콘.

    메뉴는 pystray 의 스레드에서 실행되므로 여기서 Tk 를 직접 건드리지 않는다.
    App 의 이벤트 큐로만 말을 건다."""

    def __init__(self, app):
        self.app = app
        self.icon = None
        self.active = None

    def start(self):
        """아이콘을 올린다. 실패하면 False: 그때는 창 닫기가 예전처럼 종료가 된다."""
        ready = threading.Event()

        def setup(icon):
            icon.visible = True
            ready.set()

        try:
            self.icon = pystray.Icon(
                "screen-monitor-student", tray_image(False), TRAY_NAME,
                menu=pystray.Menu(
                    pystray.MenuItem("창 열기", self._show, default=True),
                    pystray.MenuItem("종료", self._quit)))
            threading.Thread(target=self.icon.run, kwargs={"setup": setup}, daemon=True).start()
        except Exception:
            self.icon = None
            return False
        if not ready.wait(5):
            # 아이콘을 올리지 못한 채로 두면 학생이 프로그램을 끝낼 방법이 없다.
            self.stop()
            return False
        return True

    def _show(self, icon=None, item=None):
        self.app.tray_command("show")

    def _quit(self, icon=None, item=None):
        self.app.tray_command("quit")

    def set_active(self, active, status):
        icon = self.icon
        if icon is None:
            return
        try:
            if active != self.active:
                self.active = active
                icon.icon = tray_image(active)
            icon.title = (TRAY_NAME + " · " + status)[:TRAY_TIP_MAX]
        except Exception:
            pass

    def notify(self, message):
        icon = self.icon
        if icon is None:
            return
        try:
            icon.notify(message[:TRAY_MESSAGE_MAX], TRAY_NAME)
        except Exception:
            pass

    def stop(self):
        icon, self.icon = self.icon, None
        if icon is not None:
            try:
                icon.stop()
            except Exception:
                pass


class App:
    def __init__(self, root, tray_factory=Tray):
        self.root = root
        root.title(f"학생 화면 전송 {APP_VERSION}")
        root.geometry("440x680")
        root.resizable(False, False)
        self.sender = None
        self.events = queue.Queue()
        self.closed = False
        self.status_text = "대기 중"
        self.hidden_hint = False

        frm = ttk.Frame(root, padding=16)
        frm.pack(fill="both", expand=True)

        self.entries = {}
        for label, key, default in [
            ("서버 주소", "server", DEFAULT_SERVER),
            ("수업 코드", "code", ""),
            ("학년", "grade", ""),
            ("반", "cls", ""),
            ("번호", "num", ""),
            ("이름", "name", ""),
        ]:
            row = ttk.Frame(frm); row.pack(fill="x", pady=4)
            ttk.Label(row, text=label, width=8).pack(side="left")
            e = (ServerAddressInput(row, on_next=lambda: self.entries["code"].focus_set())
                 if key == "server" else ttk.Entry(row))
            e.pack(side="left", fill="x", expand=True)
            if default:
                e.insert(0, default)
            self.entries[key] = e
        # 지난번 입력을 되살린다. 그러면 보통은 수업 코드만 넣고 전송 시작을 누르면 된다.
        saved = load_settings()
        if saved.get("server"):
            self.entries["server"].set(saved["server"])
        for key in ("grade", "cls", "num", "name"):
            if saved.get(key):
                self.entries[key].insert(0, saved[key])
        if saved.get("server"):
            self.entries["code"].focus_set()
        else:
            self.entries["server"].parts[3].focus_set()

        self.btn = ttk.Button(frm, text="전송 시작", command=self.toggle)
        self.btn.pack(fill="x", pady=(12, 6))

        self.help_btn = tk.Button(frm, text="✋ 선생님 호출", command=self.toggle_help,
                                  state="disabled", relief="ridge", bd=1,
                                  bg="#eef1f6", activebackground="#e2e7f0")
        self.help_btn.pack(fill="x", pady=(0, 6))

        self.status = tk.Label(frm, text="대기 중", fg="#555",
                               wraplength=320, justify="left")
        self.status.pack(fill="x", pady=(4, 0))

        # 교사 서버에 더 새로운 앱이 있을 때만 보인다. 누르면 브라우저가 교사 노트북에서 새 파일을 받는다.
        self.update_url = None
        self.update_notified = False
        self.update_btn = tk.Button(frm, command=self.open_update, relief="ridge", bd=1,
                                    bg="#ede9fe", fg="#5b21b6", activebackground="#ddd6fe")
        self.update_hint = tk.Label(frm, fg="#5b21b6", wraplength=380, justify="left", font=("", 8))

        # Label 이 아니라 Text 라야 주소 부분만 눌러서 열 수 있다.
        self.notice_box = tk.Text(frm, height=3, wrap="word", bg="#fff4e1", fg="#8a4b08",
                                  relief="flat", padx=12, pady=10, cursor="arrow",
                                  highlightthickness=0, borderwidth=0)
        self.notice_box.config(state="disabled")
        self.notice_tags = []
        self.notice_at = 0.0

        self.tray = tray_factory(self)
        self.tray_ready = self.tray.start()

        note = tk.Label(
            frm, fg="#999", wraplength=320, justify="left", font=("", 8),
            text="192.168.1.□:8080 — 빈칸에 선생님 IP의 네 번째 숫자를 입력하세요. 다른 주소는 각 칸을 바꾸세요.\n"
                 "전송 중 선생님이 화면을 볼 수 있고 PDF로 저장할 수 있습니다. "
                 "저장 여부는 위에 표시됩니다. "
                 + ("창을 닫으면 창만 숨고 전송은 계속됩니다. 끝내려면 작업 표시줄 오른쪽 끝의 "
                    "트레이 아이콘을 우클릭해 '종료'를 누르세요."
                    if self.tray_ready else "창을 닫으면 전송을 멈춥니다."))
        note.pack(side="bottom", fill="x")

        root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.active = False
        root.after(50, self.poll_events)

    def reset_controls(self):
        self.active = False
        self.btn.config(text="전송 시작")
        self.help_btn.config(state="disabled", text="✋ 선생님 호출", bg="#eef1f6")
        for entry in self.entries.values():
            entry.config(state="normal")
        self.sync_tray()

    def toggle_help(self):
        if self.sender:
            self.sender.set_help(not self.sender.help)

    def render_help(self):
        raised = bool(self.sender and self.sender.help)
        self.help_btn.config(state="normal" if self.active else "disabled",
                             text="✋ 호출 취소 (선생님께 알림 중)" if raised else "✋ 선생님 호출",
                             bg="#ffd79a" if raised else "#eef1f6")

    def open_link(self, url):
        if url.lower().startswith("www."):
            url = "https://" + url
        if not url.lower().startswith(("http://", "https://")):
            return
        try:
            webbrowser.open(url)
        except Exception:
            self.set_status("링크를 열지 못했습니다. 주소를 직접 입력해 주세요.", ok=False)

    def show_notice(self, text):
        stamp = time.strftime("%H:%M")
        box = self.notice_box
        box.config(state="normal")
        for name in self.notice_tags:
            box.tag_delete(name)
        self.notice_tags = []
        box.delete("1.0", "end")
        box.insert("end", f"선생님 ({stamp})\n")
        position = 0
        for index, (at, url) in enumerate(link_spans(text)):
            box.insert("end", text[position:at])
            start = box.index("end-1c")
            box.insert("end", url)
            name = f"link{index}"
            box.tag_add(name, start, box.index("end-1c"))
            box.tag_configure(name, foreground="#1a4fd6", underline=True)
            box.tag_bind(name, "<Button-1>", lambda event, target=url: self.open_link(target))
            box.tag_bind(name, "<Enter>", lambda event: box.config(cursor="hand2"))
            box.tag_bind(name, "<Leave>", lambda event: box.config(cursor="arrow"))
            self.notice_tags.append(name)
            position = at + len(url)
        box.insert("end", text[position:])
        box.config(state="disabled")
        if not box.winfo_ismapped():
            box.pack(fill="x", pady=(10, 0))
        try:
            box.update_idletasks()
            lines = box.count("1.0", "end-1c", "displaylines")
            box.config(height=max(2, min(8, int(lines[0]) if lines else 3)))
        except (tk.TclError, TypeError, ValueError):
            pass
        # 다른 프로그램을 쓰고 있거나 창을 트레이로 숨겼어도 보이도록 잠깐 앞으로 올린다.
        self.show_window()
        try:
            self.root.attributes("-topmost", True)
            self.root.bell()
            self.root.after(4000, lambda: self.root.attributes("-topmost", False))
        except tk.TclError:
            pass

    def show_update(self, version, url):
        self.update_url = url
        self.update_btn.config(text=f"⬆ 새 버전 {version}이 있습니다 · 받기")
        self.update_hint.config(text="받은 파일을 실행하기 전에 작업 표시줄 오른쪽 끝 트레이 아이콘을 우클릭해 "
                                     "'종료'로 이 프로그램을 끝내세요. 받은 파일 이름이 '학생화면전송 (1).exe'처럼 "
                                     "바뀔 수 있으니, 다음부터는 새로 받은 파일을 실행하세요.")
        if not self.update_btn.winfo_ismapped():
            self.update_btn.pack(fill="x", pady=(10, 0), after=self.status)
            self.update_hint.pack(fill="x", pady=(4, 0), after=self.update_btn)
        # 수업 중 창을 앞으로 띄우지는 않는다. 트레이 풍선으로 한 번만 알린다.
        if not self.update_notified:
            self.update_notified = True
            self.tray.notify(f"학생 화면 전송 새 버전 {version}이 있습니다. 창을 열어 '받기'를 누르세요.")

    def open_update(self):
        if not self.update_url:
            return
        try:
            webbrowser.open(self.update_url)
        except Exception:
            self.set_status("브라우저를 열지 못했습니다. 선생님께 새 버전 파일을 받아 주세요.", ok=False)

    def toggle(self):
        if self.active:
            self.sender.stop()
            self.sender = None
            self.reset_controls()
            self.set_status("전송을 멈췄습니다.", ok=False)
            return
        try:
            vals = {key: entry.get().strip() for key, entry in self.entries.items()}
        except ValueError as error:
            self.set_status(str(error), ok=False)
            return
        if not all(vals.values()):
            self.set_status("모든 칸을 입력하세요.", ok=False)
            return
        try:
            server_url(vals["server"])
            if len(vals["code"]) != 6 or not vals["code"].isascii() or not vals["code"].isdigit():
                raise ValueError("수업 코드는 6자리 숫자입니다.")
            for key in ("grade", "cls", "num"):
                if not vals[key].isascii() or not vals[key].isdigit() or not 1 <= int(vals[key]) <= 99:
                    raise ValueError("학년, 반, 번호는 1~99의 숫자로 입력하세요.")
                vals[key] = str(int(vals[key]))
            if len(vals["name"]) > 20:
                raise ValueError("이름은 20자 이내로 입력하세요.")
        except ValueError as error:
            self.set_status(str(error), ok=False)
            return
        save_settings(vals)
        self.sender = Sender(self)
        self.active = True
        self.btn.config(text="전송 중지")
        self.render_help()
        for entry in self.entries.values():
            entry.config(state="disabled")
        self.sender.start(**vals)
        self.sync_tray()

    def show_window(self):
        """트레이로 숨은 창을 다시 띄운다."""
        try:
            self.root.deiconify()
            self.root.lift()
            self.root.focus_force()
        except tk.TclError:
            pass

    def sync_tray(self):
        self.tray.set_active(self.active, self.status_text)

    def tray_command(self, command):
        # pystray 스레드에서 들어온다: Tk 는 poll_events 에서만 만진다.
        self.events.put(("tray", None, command, None))

    def set_status(self, text, ok=None, source=None):
        self.events.put(("status", source, text, ok))

    def finished(self, source):
        self.events.put(("finished", source, None, None))

    def notice(self, source, text):
        self.events.put(("notice", source, text, None))

    def help_changed(self, source):
        self.events.put(("help", source, None, None))

    def update_available(self, source, version, url):
        self.events.put(("update", source, version, url))

    def poll_events(self):
        # Workers never call Tk, including root.after(), which is not safe during shutdown.
        while not self.events.empty():
            kind, source, text, ok = self.events.get_nowait()
            if source is not None and source is not self.sender:
                continue
            if kind == "tray":
                if text == "quit":
                    self.quit_app()
                    return
                self.show_window()
            elif kind == "finished":
                self.reset_controls()
            elif kind == "notice":
                self.show_notice(text)
            elif kind == "help":
                self.render_help()
            elif kind == "update":
                self.show_update(text, ok)   # (version, url)
            else:
                color = "#2fae66" if ok else ("#e04545" if ok is False else "#555")
                self.status.config(text=text, fg=color)
                self.status_text = text
                self.sync_tray()
        if not self.closed:
            self.root.after(50, self.poll_events)

    def on_close(self):
        """X 를 눌러도 전송은 이어진다. 끝내는 것은 트레이 메뉴의 '종료'뿐이다."""
        if not self.tray_ready:
            self.quit_app()
            return
        self.root.withdraw()
        if not self.hidden_hint:
            self.hidden_hint = True
            self.tray.notify("창을 숨겼습니다. 화면 전송은 계속됩니다.\n"
                             "끝내려면 트레이 아이콘을 우클릭해 '종료'를 누르세요.")
        self.sync_tray()

    def quit_app(self):
        if self.closed:
            return
        self.closed = True
        if self.sender:
            self.sender.stop()
        self.tray.stop()
        self.root.destroy()


if __name__ == "__main__":
    instance = SingleInstance()
    if instance.acquire():
        try:
            root = tk.Tk()
            App(root)
            root.mainloop()
        finally:
            instance.close()
    else:
        already_running_message()
