"""교사 노트북용 실행기: 서버를 창 없이 켜고, 트레이 아이콘으로 열기·설정·안전 종료를 맡는다.

서버(server/server.js)는 CONTROL_STDIN=1 로 띄운다. 서버는 표준 출력에 '@@{json}' 줄로 상태를 알리고,
표준 입력으로 'shutdown' 을 받으면 수업을 모두 끝내 PDF를 저장한 뒤 스스로 꺼진다.
그래서 트레이의 '종료'는 PDF 저장이 끝날 때까지 기다렸다가 끝난다.
"""
import ctypes
import json
import os
import queue
import subprocess
import sys
import threading
import webbrowser
from ctypes import wintypes
from pathlib import Path

APP_NAME = "학생 화면 모니터"
APP_VERSION = "2026.09.29"
DEFAULT_PORT = 8080
MUTEX_NAME = r"Local\SchoolScreenMonitor.Teacher"
EVENT_SHOW = r"Local\SchoolScreenMonitor.Teacher.Show"
EVENT_QUIT = r"Local\SchoolScreenMonitor.Teacher.Quit"
PUBLIC_PASSWORD = "teacher1234"  # 공개 문서에 적힌 옛 기본값이라 쓰지 못하게 한다.
CREATE_NO_WINDOW = 0x08000000


# ---------- 경로·설정 ----------
def app_dir():
    """설치 폴더. 빌드한 exe 옆에 server/, client/dist/, android/dist/ 가 있다."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def data_dir():
    """이 PC 사용자 폴더(%APPDATA%\\ScreenMonitorTeacher). 테스트는 환경 변수로 바꾼다."""
    override = os.environ.get("SCREEN_MONITOR_TEACHER_HOME")
    if override:
        return Path(override)
    return Path(os.environ.get("APPDATA") or Path.home()) / "ScreenMonitorTeacher"


def documents_dir():
    if sys.platform == "win32":
        try:
            guid = (ctypes.c_ubyte * 16).from_buffer_copy(
                bytes.fromhex("D0 9A D3 FD 8F 23 AF 46 AD B4 6C 85 48 03 69 C7".replace(" ", "")))
            out = ctypes.c_wchar_p()
            if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(out)) == 0:
                path = Path(out.value)
                ctypes.windll.ole32.CoTaskMemFree(out)
                return path
        except Exception:
            pass
    return Path.home() / "Documents"


def default_save_dir():
    """문서\\학생화면기록. 문서 폴더가 OneDrive로 동기화되면 학생 화면이 클라우드로 올라가므로 사용자 폴더로 비킨다."""
    docs = documents_dir()
    if "onedrive" in str(docs).lower():
        return str(Path.home() / "학생화면기록")
    return str(docs / "학생화면기록")


def load_config():
    try:
        data = json.loads((data_dir() / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("password"), str) or not data["password"]:
        return None
    if not isinstance(data.get("save_dir"), str) or not data["save_dir"].strip():
        data["save_dir"] = default_save_dir()
    port = data.get("port", DEFAULT_PORT)
    data["port"] = port if isinstance(port, int) and 1 <= port <= 65535 else DEFAULT_PORT
    return data


def save_config(config):
    folder = data_dir()
    folder.mkdir(parents=True, exist_ok=True)
    temp = folder / "config.json.tmp"
    temp.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, folder / "config.json")


def validate_settings(password, confirm, save_dir):
    """문제가 있으면 안내 문구, 없으면 None."""
    if len(password) < 4:
        return "비밀번호는 4자 이상으로 정하세요."
    if len(password) > 64:
        return "비밀번호는 64자 이내로 정하세요."
    if password != password.strip():
        return "비밀번호 앞뒤에 빈칸을 넣지 마세요."
    if password == PUBLIC_PASSWORD:
        return "teacher1234는 공개 문서에 적힌 값이라 쓸 수 없습니다. 다른 비밀번호를 정하세요."
    if password != confirm:
        return "비밀번호 확인이 일치하지 않습니다."
    if not save_dir.strip():
        return "저장 폴더를 정하세요."
    return None


def parse_event(line):
    """서버의 '@@{json}' 상태 줄만 읽는다. 나머지 줄은 기록용이다."""
    line = line.strip()
    if not line.startswith("@@"):
        return None
    try:
        event = json.loads(line[2:])
    except ValueError:
        return None
    return event if isinstance(event, dict) and isinstance(event.get("t"), str) else None


# ---------- 서버 프로세스 ----------
class ServerProcess:
    def __init__(self, on_event, on_exit):
        self.on_event = on_event
        self.on_exit = on_exit
        self.proc = None
        self.log_path = data_dir() / "server.log"

    def node_path(self):
        bundled = app_dir() / "server" / "node.exe"
        if bundled.exists():
            return str(bundled)
        from shutil import which
        return which("node")

    def start(self, config):
        node = self.node_path()
        if not node:
            raise RuntimeError("server\\node.exe를 찾지 못했습니다. 프로그램을 다시 설치하세요.")
        server_dir = app_dir() / "server"
        env = dict(os.environ)
        env.update({
            "CONTROL_STDIN": "1",
            "TEACHER_PASSWORD": config["password"],
            "SAVE_DIR": config["save_dir"],
            "PORT": str(config["port"]),
        })
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        if self.log_path.exists():
            try:
                os.replace(self.log_path, self.log_path.with_name("server-이전.log"))
            except OSError:
                pass
        self.proc = subprocess.Popen(
            [node, "server.js"], cwd=str(server_dir), env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            creationflags=CREATE_NO_WINDOW if sys.platform == "win32" else 0)
        threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()

    def _read(self, proc):
        with open(self.log_path, "a", encoding="utf-8") as log:
            for raw in proc.stdout:
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                log.write(line + "\n")
                log.flush()
                event = parse_event(line)
                if event:
                    self.on_event(event)
        self.on_exit(proc.wait())

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def request_shutdown(self):
        """PDF를 저장하고 끄라고 알린다. 실제 종료는 on_exit 로 알 수 있다."""
        try:
            self.proc.stdin.write(b"shutdown\n")
            self.proc.stdin.flush()
            return True
        except (OSError, AttributeError, ValueError):
            return False

    def kill(self):
        if self.alive():
            self.proc.kill()


# ---------- 중복 실행·신호 ----------
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True) if sys.platform == "win32" else None
if kernel32:
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateEventW.restype = wintypes.HANDLE
    kernel32.OpenEventW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.OpenEventW.restype = wintypes.HANDLE
    kernel32.SetEvent.argtypes = [wintypes.HANDLE]
    kernel32.WaitForMultipleObjects.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE), wintypes.BOOL, wintypes.DWORD]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]


def acquire_single_instance():
    ctypes.set_last_error(0)
    handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        kernel32.CloseHandle(handle)
        return None
    return handle


def signal_running(name):
    handle = kernel32.OpenEventW(0x0002, False, name)  # EVENT_MODIFY_STATE
    if not handle:
        return False
    kernel32.SetEvent(handle)
    kernel32.CloseHandle(handle)
    return True


def wait_until_closed(timeout=180):
    """--quit 은 실행 중인 프로그램이 PDF를 저장하고 완전히 꺼질 때까지 기다린다(설치·제거 프로그램이 이어서 파일을 바꾼다)."""
    import time
    kernel32.OpenMutexW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.OpenMutexW.restype = wintypes.HANDLE
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        handle = kernel32.OpenMutexW(0x00100000, False, MUTEX_NAME)  # SYNCHRONIZE
        if not handle:
            return True
        kernel32.CloseHandle(handle)
        time.sleep(0.5)
    return False


def watch_signals(put):
    """두 번째 실행(교사 화면 열기)과 --quit(설치·제거 프로그램이 부름)을 기다린다."""
    show = kernel32.CreateEventW(None, False, False, EVENT_SHOW)
    quit_ = kernel32.CreateEventW(None, False, False, EVENT_QUIT)
    handles = (wintypes.HANDLE * 2)(show, quit_)
    while True:
        which = kernel32.WaitForMultipleObjects(2, handles, False, 0xFFFFFFFF)
        put("show" if which == 0 else "quit_now" if which == 1 else "noop")


# ---------- 아이콘 ----------
def tray_image(on=True, size=64):
    from PIL import Image, ImageDraw
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(image)
    s = size / 64
    d.rounded_rectangle((2 * s, 2 * s, 62 * s, 62 * s), radius=14 * s, fill=(14, 107, 92) if on else (120, 128, 126))
    tiles = [(12, 12, 30, 30), (34, 12, 52, 30), (12, 34, 30, 52), (34, 34, 52, 52)]
    for i, (a, b, c, e) in enumerate(tiles):
        color = (242, 201, 76) if i == 3 else (234, 244, 241)
        d.rounded_rectangle((a * s, b * s, c * s, e * s), radius=3 * s, fill=color)
    return image


# ---------- 화면 ----------
class App:
    def __init__(self, root, config):
        import pystray
        self.pystray = pystray
        self.root = root
        self.config = config
        self.events = queue.Queue()
        self.server = ServerProcess(lambda e: self.events.put(("server", e)), lambda code: self.events.put(("exit", code)))
        self.lessons = 0
        self.ready = False
        self.stopping = False      # 종료 요청을 보냈다
        self.restart_after = False  # 설정 바꾼 뒤 다시 켜기
        self.failed_once = False
        self.last_error = None
        self.icon = pystray.Icon("screen-monitor-teacher", tray_image(False), APP_NAME, menu=pystray.Menu(
            pystray.MenuItem("교사 화면 열기", lambda *_: self.put("open"), default=True),
            pystray.MenuItem("저장 폴더 열기", lambda *_: self.put("folder")),
            pystray.MenuItem("설정 (비밀번호·저장 폴더)", lambda *_: self.put("settings")),
            pystray.MenuItem("서버 기록 보기", lambda *_: self.put("log")),
            pystray.MenuItem("서버 다시 켜기", lambda *_: self.put("start"),
                             visible=lambda item: not self.server.alive()),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("종료", lambda *_: self.put("quit")),
        ))
        self.icon.run_detached()
        if kernel32:
            threading.Thread(target=watch_signals, args=(self.put,), daemon=True).start()
        root.after(100, self.poll)
        self.start_server()

    def put(self, command):
        self.events.put(("cmd", command))

    def url(self):
        return f"http://localhost:{self.config['port']}"

    def status(self, text, on=None):
        try:
            if on is not None:
                self.icon.icon = tray_image(on)
            self.icon.title = f"{APP_NAME} · {text}"[:127]
            self.icon.update_menu()  # '서버 다시 켜기'는 서버가 꺼졌을 때만 보인다.
        except Exception:
            pass

    def notify(self, text):
        try:
            self.icon.notify(text[:250], APP_NAME)
        except Exception:
            pass

    def start_server(self, open_browser=True):
        self.ready = False
        self.open_on_ready = open_browser
        self.last_error = None
        try:
            self.server.start(self.config)
        except Exception as error:
            self.status("서버를 켜지 못함", on=False)
            self.warn(str(error))
            return
        self.status("서버 켜는 중…", on=False)

    # 모든 화면 조작은 Tk 스레드에서 한다.
    def poll(self):
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "server":
                    self.on_server_event(value)
                elif kind == "exit":
                    self.on_server_exit(value)
                else:
                    self.on_command(value)
        except queue.Empty:
            pass
        self.root.after(100, self.poll)

    def on_server_event(self, event):
        t = event["t"]
        if t == "ready":
            self.ready = True
            self.status("대기 중 · 수업 없음", on=True)
            if self.open_on_ready and not os.environ.get("SM_NO_BROWSER"):
                webbrowser.open(self.url())
            self.notify("서버가 켜졌습니다. 교사 화면에서 수업을 시작하세요.")
        elif t == "lessons":
            self.lessons = int(event.get("count") or 0)
            if not self.stopping:
                self.status(f"수업 {self.lessons}개 진행 중" if self.lessons else "대기 중 · 수업 없음", on=True)
        elif t == "shuttingDown":
            self.status("PDF 저장 중… 끝나면 저절로 꺼집니다", on=True)
        elif t == "shutdownFailed":
            self.stopping = False
            self.restart_after = False
            self.failed_once = True
            self.status(f"PDF 저장 실패 · 수업 {event.get('lessons')}개 남음", on=True)
            self.warn("PDF 저장에 실패한 수업이 있어 서버를 끄지 않았습니다.\n\n"
                      "교사 화면에서 'PDF 저장 재시도'를 누르고(저장 폴더·디스크 공간 확인) 다시 종료하세요.\n"
                      "한 번 더 종료를 누르면 기록을 버리고 강제로 끌지 물어봅니다.")
            webbrowser.open(self.url())
        elif t == "error":
            self.last_error = event.get("code")

    def on_server_exit(self, code):
        self.ready = False
        if self.stopping and self.restart_after:
            self.stopping = self.restart_after = False
            self.start_server(open_browser=False)
            self.notify("새 설정으로 서버를 다시 켰습니다. 교사 화면을 새로고침하세요.")
            return
        if self.stopping:
            self.exit_app()
            return
        self.status("서버 꺼짐", on=False)
        if self.last_error == "EADDRINUSE":
            self.warn(f"{self.config['port']}번 포트를 다른 프로그램이 쓰고 있어 서버를 켜지 못했습니다.\n\n"
                      "예전 방식(서버시작.bat)의 서버 창이 열려 있으면 그 창에서 수업을 종료하고 닫은 뒤,\n"
                      "트레이 아이콘의 '서버 다시 켜기'를 누르세요.")
        else:
            self.warn("서버가 예기치 않게 멈췄습니다.\n트레이 메뉴의 '서버 기록 보기'로 원인을 확인하고 '서버 다시 켜기'를 누르세요.")

    def on_command(self, command):
        if command == "open" or command == "show":
            if self.server.alive():
                webbrowser.open(self.url())
            else:
                self.warn("서버가 꺼져 있습니다. 트레이 메뉴의 '서버 다시 켜기'를 누르세요.")
        elif command == "folder":
            folder = Path(self.config["save_dir"])
            folder.mkdir(parents=True, exist_ok=True)
            os.startfile(folder)
        elif command == "log":
            if self.server.log_path.exists():
                os.startfile(self.server.log_path)
        elif command == "start":
            if not self.server.alive():
                self.start_server()
        elif command == "settings":
            self.open_settings()
        elif command == "quit":
            self.quit(confirm=True)
        elif command == "quit_now":
            self.quit(confirm=False)

    def quit(self, confirm):
        from tkinter import messagebox
        if not self.server.alive():
            self.exit_app()
            return
        if self.stopping:
            return
        if confirm and self.failed_once:
            if messagebox.askyesno(APP_NAME, "아직 PDF로 저장하지 못한 기록이 있습니다.\n\n"
                                   "기록을 버리고 서버를 강제로 끌까요?", icon="warning", parent=self.root):
                self.stopping = True
                self.server.kill()
            return
        if confirm and self.lessons:
            if not messagebox.askyesno(APP_NAME, f"진행 중인 수업 {self.lessons}개를 종료하고\n"
                                       "학생별 PDF를 저장한 뒤 끕니다. 계속할까요?", parent=self.root):
                return
        self.stopping = True
        self.status("PDF 저장 중… 끝나면 저절로 꺼집니다", on=True)
        if not self.server.request_shutdown():
            self.server.kill()

    def exit_app(self):
        try:
            self.icon.stop()
        except Exception:
            pass
        self.root.destroy()

    def warn(self, text):
        from tkinter import messagebox
        messagebox.showwarning(APP_NAME, text, parent=self.root)

    def open_settings(self):
        result = settings_dialog(self.root, self.config, first_run=False)
        if not result:
            return
        changed = (result["password"], result["save_dir"]) != (self.config["password"], self.config["save_dir"])
        self.config.update(result)
        save_config(self.config)
        if not changed:
            return
        from tkinter import messagebox
        if not self.server.alive():
            self.start_server()
        elif self.lessons:
            messagebox.showinfo(APP_NAME, "진행 중인 수업이 있어 새 설정은 다음에 서버를 켤 때부터 적용됩니다.", parent=self.root)
        else:
            self.stopping = self.restart_after = True
            self.server.request_shutdown()


def settings_dialog(root, config, first_run):
    """비밀번호·저장 폴더 설정 창. 저장하면 dict, 취소하면 None."""
    import tkinter as tk
    from tkinter import filedialog, ttk

    win = tk.Toplevel(root)
    win.title(f"{APP_NAME} · {'처음 설정' if first_run else '설정'}")
    win.resizable(False, False)
    win.attributes("-topmost", True)
    try:
        from PIL import ImageTk
        win._icon = ImageTk.PhotoImage(tray_image(True, 32))
        win.iconphoto(False, win._icon)
    except Exception:
        pass
    frame = ttk.Frame(win, padding=22)
    frame.pack(fill="both", expand=True)
    result = {}

    if first_run:
        ttk.Label(frame, text="학생 화면 모니터에 오신 것을 환영합니다", font=("Malgun Gothic", 13, "bold")).grid(
            row=0, column=0, columnspan=3, sticky="w")
        ttk.Label(frame, text="교사 화면에 들어갈 비밀번호와 학생 화면 PDF를 저장할 폴더를 정하세요.\n"
                              "나중에 트레이 아이콘의 '설정'에서 바꿀 수 있습니다.", foreground="#56655F").grid(
            row=1, column=0, columnspan=3, sticky="w", pady=(4, 14))

    password = tk.StringVar(value=config.get("password", "") if config else "")
    confirm = tk.StringVar(value=config.get("password", "") if config else "")
    save_dir = tk.StringVar(value=(config or {}).get("save_dir") or default_save_dir())
    show = tk.BooleanVar(value=False)

    ttk.Label(frame, text="교사 비밀번호").grid(row=2, column=0, sticky="w", pady=4)
    e1 = ttk.Entry(frame, textvariable=password, show="●", width=34)
    e1.grid(row=2, column=1, columnspan=2, sticky="we", pady=4)
    ttk.Label(frame, text="비밀번호 확인").grid(row=3, column=0, sticky="w", pady=4)
    e2 = ttk.Entry(frame, textvariable=confirm, show="●", width=34)
    e2.grid(row=3, column=1, columnspan=2, sticky="we", pady=4)

    def toggle():
        mark = "" if show.get() else "●"
        e1.config(show=mark)
        e2.config(show=mark)
    ttk.Checkbutton(frame, text="비밀번호 보기", variable=show, command=toggle).grid(row=4, column=1, sticky="w")
    ttk.Label(frame, text="학생에게 알려 주지 마세요. 태블릿으로 교사 화면을 열 때도 씁니다.",
              foreground="#56655F").grid(row=5, column=1, columnspan=2, sticky="w", pady=(0, 10))

    ttk.Label(frame, text="PDF 저장 폴더").grid(row=6, column=0, sticky="w", pady=4)
    ttk.Entry(frame, textvariable=save_dir, width=34).grid(row=6, column=1, sticky="we", pady=4)

    def browse():
        chosen = filedialog.askdirectory(parent=win, initialdir=save_dir.get() or str(Path.home()))
        if chosen:
            save_dir.set(str(Path(chosen)))
    ttk.Button(frame, text="찾아보기…", command=browse).grid(row=6, column=2, padx=(6, 0))
    ttk.Label(frame, text="학생 이름이 든 화면 기록입니다. 학교 지침에 맞게 보관·삭제하세요.",
              foreground="#56655F").grid(row=7, column=1, columnspan=2, sticky="w")

    message = ttk.Label(frame, text="", foreground="#C0392B")
    message.grid(row=8, column=0, columnspan=3, sticky="w", pady=(10, 0))

    def submit(*_):
        error = validate_settings(password.get(), confirm.get(), save_dir.get())
        if error:
            message.config(text=error)
            return
        result.update(password=password.get(), save_dir=save_dir.get().strip())
        win.destroy()

    buttons = ttk.Frame(frame)
    buttons.grid(row=9, column=0, columnspan=3, sticky="e", pady=(14, 0))
    ttk.Button(buttons, text="취소" if not first_run else "나가기", command=win.destroy).pack(side="right")
    ttk.Button(buttons, text="저장하고 시작" if first_run else "저장", command=submit).pack(side="right", padx=(0, 8))
    ttk.Label(frame, text=f"버전 {APP_VERSION}", foreground="#9AA5A1").grid(row=9, column=0, sticky="w", pady=(14, 0))
    win.bind("<Return>", submit)
    win.protocol("WM_DELETE_WINDOW", win.destroy)
    e1.focus_set()
    win.update_idletasks()
    x = (win.winfo_screenwidth() - win.winfo_width()) // 2
    y = (win.winfo_screenheight() - win.winfo_height()) // 3
    win.geometry(f"+{x}+{y}")
    win.grab_set()
    root.wait_window(win)
    return dict(result) if result else None


def main(argv):
    if sys.platform == "win32":
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass
    mutex = acquire_single_instance() if kernel32 else True
    if not mutex:
        if "--quit" in argv:
            signal_running(EVENT_QUIT)
            return 0 if wait_until_closed() else 1
        signal_running(EVENT_SHOW)
        return 0
    if "--quit" in argv:
        return 0

    import tkinter as tk
    root = tk.Tk()
    root.withdraw()
    root.option_add("*Font", ("Malgun Gothic", 10))

    config = load_config()
    first_run = config is None
    if first_run:
        config = settings_dialog(root, None, first_run=True)
        if not config:
            root.destroy()
            return 0
        config["port"] = DEFAULT_PORT
        save_config(config)
    App(root, config)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
