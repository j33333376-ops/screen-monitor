import json
import os
import tempfile
import tkinter as tk
import unittest
from unittest.mock import Mock, patch

os.environ["SCREEN_MONITOR_SETTINGS"] = os.path.join(tempfile.mkdtemp(), "settings.json")
import student
from student import APP_VERSION, App, Sender, update_url
from test_student import FakeTray


class TkCase(unittest.TestCase):
    def setUp(self):
        self.settings = os.path.join(tempfile.mkdtemp(), "settings.json")
        os.environ["SCREEN_MONITOR_SETTINGS"] = self.settings
        try:
            self.root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(f"Tk unavailable: {error}")
        self.root.withdraw()
        self.addCleanup(self.root.destroy)

    def app(self):
        # 한 테스트 안에서 창을 다시 여는 것처럼 새 App을 만든다.
        for child in self.root.winfo_children():
            child.destroy()
        return App(self.root, tray_factory=FakeTray)


class RememberTests(TkCase):
    def fill(self, app, **values):
        for key, value in values.items():
            app.entries[key].delete(0, "end")
            app.entries[key].insert(0, value)

    def test_inputs_except_the_class_code_come_back_next_time(self):
        app = self.app()
        app.entries["server"].parts[3].insert(0, "28")
        self.fill(app, code="123456", grade="2", cls="3", num="7", name="김민수")
        with patch("student.Sender") as sender:
            app.toggle()
        sender.return_value.start.assert_called_once()
        with open(self.settings, encoding="utf-8") as file:
            saved = json.load(file)
        self.assertEqual(saved, {"server": "192.168.1.28:8080", "grade": "2", "cls": "3", "num": "7", "name": "김민수"})
        self.assertNotIn("code", saved, "수업 코드는 수업마다 바뀌므로 기억하지 않는다")

        again = self.app()
        self.assertEqual(again.entries["server"].get(), "192.168.1.28:8080")
        self.assertEqual([again.entries[k].get() for k in ("code", "grade", "cls", "num", "name")],
                         ["", "2", "3", "7", "김민수"])

    def test_a_direct_address_is_restored_in_the_direct_field(self):
        with open(self.settings, "w", encoding="utf-8") as file:
            json.dump({"server": "https://class.example", "name": "이름"}, file)
        app = self.app()
        self.assertTrue(app.entries["server"].direct.get())
        self.assertEqual(app.entries["server"].get(), "https://class.example")

    def test_invalid_input_is_not_remembered_and_a_broken_file_is_ignored(self):
        with open(self.settings, "w", encoding="utf-8") as file:
            file.write("{not json")
        app = self.app()
        self.assertEqual(app.entries["name"].get(), "")
        app.entries["server"].parts[3].insert(0, "28")
        self.fill(app, code="12", grade="2", cls="3", num="7", name="김민수")
        with patch("student.Sender") as sender:
            app.toggle()
        sender.assert_not_called()
        with open(self.settings, encoding="utf-8") as file:
            self.assertEqual(file.read(), "{not json", "잘못된 입력으로는 저장하지 않는다")


class UpdateTests(TkCase):
    def test_hello_tells_the_server_the_platform_and_version(self):
        sender = Sender(Mock())
        with patch("student.threading.Thread"):
            sender.start("192.168.1.28:8080", "123456", "2", "3", "7", "이름")
        self.assertEqual((sender.hello["platform"], sender.hello["version"]), ("windows", APP_VERSION))

    def test_update_link_stays_on_the_teacher_server_download_path(self):
        self.assertEqual(update_url("ws://192.168.1.28:8080/ws", {"version": "1.6.0", "url": "/download/windows"}),
                         ("1.6.0", "http://192.168.1.28:8080/download/windows"))
        self.assertEqual(update_url("wss://class.example/ws", {"version": "1.6.0", "url": "/download/windows"})[1],
                         "https://class.example/download/windows")
        for bad in [{"version": "1.6.0", "url": "https://evil.example/x.exe"},
                    {"version": "1.6.0", "url": "/download/../../x"},
                    {"version": "최신", "url": "/download/windows"}, None]:
            with self.subTest(bad=bad):
                self.assertEqual(update_url("ws://192.168.1.28:8080/ws", bad), (None, None))

    def test_ok_with_update_shows_a_button_that_opens_the_download(self):
        app = self.app()
        sender = Sender(app)
        sender.url = "ws://192.168.1.28:8080/ws"
        app.sender = sender
        current = sender.ws = object()
        sender._on_message(current, json.dumps({"t": "ok", "update": {"version": "1.6.0", "url": "/download/windows"}}))
        app.poll_events()
        self.root.update_idletasks()
        self.assertIn("1.6.0", app.update_btn.cget("text"))
        self.assertEqual(len(app.tray.messages), 1, "트레이 풍선으로 한 번만 알린다")
        sender._on_message(current, json.dumps({"t": "ok", "update": {"version": "1.6.0", "url": "/download/windows"}}))
        app.poll_events()
        self.assertEqual(len(app.tray.messages), 1, "다시 접속해도 또 알리지 않는다")
        with patch("student.webbrowser.open") as opened:
            app.open_update()
        opened.assert_called_once_with("http://192.168.1.28:8080/download/windows")

    def test_ok_without_update_shows_nothing(self):
        app = self.app()
        sender = Sender(app)
        sender.url = "ws://192.168.1.28:8080/ws"
        app.sender = sender
        current = sender.ws = object()
        sender._on_message(current, json.dumps({"t": "ok", "update": None}))
        app.poll_events()
        self.assertIsNone(app.update_url)
        self.assertEqual(app.tray.messages, [])


if __name__ == "__main__":
    unittest.main()
