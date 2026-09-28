import io
import os
import tempfile
import tkinter as tk
import unittest
from unittest.mock import Mock, patch
from PIL import Image

# 테스트가 이 PC 사용자의 진짜 입력 기억 파일을 읽거나 덮어쓰지 않게 한다.
os.environ["SCREEN_MONITOR_SETTINGS"] = os.path.join(tempfile.mkdtemp(), "settings.json")
import student
from student import App, Sender, Tray, capture_packet, link_spans


class FakeTray:
    """창 숨김·종료 동작만 보면 되므로 진짜 트레이 아이콘은 올리지 않는다."""
    def __init__(self, app, ready=True):
        self.app = app
        self.ready = ready
        self.started = False
        self.stopped = False
        self.messages = []
        self.states = []

    def start(self):
        self.started = True
        return self.ready

    def set_active(self, active, status):
        self.states.append((active, status))

    def notify(self, message):
        self.messages.append(message)

    def stop(self):
        self.stopped = True


def gone(root):
    """root.destroy() 뒤에는 Tcl 해석기 자체가 사라져 winfo 조회도 실패한다."""
    try:
        return not root.winfo_exists()
    except tk.TclError:
        return True


class StubIcon:
    """pystray.Icon 대역: 아이콘 이미지를 몇 번 갈아 끼웠는지 센다."""
    def __init__(self):
        self.title = ''
        self.images = []
        self.notifications = []
        self.stopped = False

    @property
    def icon(self):
        return self.images[-1] if self.images else None

    @icon.setter
    def icon(self, value):
        self.images.append(value)

    def notify(self, message, title=None):
        self.notifications.append((message, title))

    def stop(self):
        self.stopped = True


class RecoveryTests(unittest.TestCase):
    def sender(self):
        sender = Sender(Mock())
        sender.ws = Mock()
        sender.registered = True
        return sender

    def test_capture_failure_after_sleep_recreates_handles_and_resumes(self):
        sender = self.sender()
        broken, recovered = Mock(), Mock()
        broken.monitors = recovered.monitors = [None, {}]
        broken.grab.side_effect = RuntimeError('display asleep')
        recovered.grab.return_value = Mock(size=(2, 2), bgra=bytes([255] * 16))
        packets = []
        def sent(packet, **kwargs):
            packets.append(packet)
            sender.stop_event.set()
        sender.ws.send.side_effect = sent
        with patch('student.mss.mss', side_effect=[broken, recovered]) as create, \
                patch.object(sender.stop_event, 'wait', return_value=False):
            sender._capture_loop()
        self.assertEqual(create.call_count, 2)
        broken.close.assert_called_once()
        self.assertEqual(len(packets), 1)
        self.assertEqual(Image.open(io.BytesIO(packets[0][1:])).size, (2, 2))
        self.assertFalse(sender.capture_waiting)
        sender.ws.close.assert_not_called()

    def test_stop_during_capture_retry_does_not_resume(self):
        sender = self.sender()
        broken = Mock()
        broken.grab.side_effect = RuntimeError('locked')
        def stop_wait(seconds):
            sender.stop_event.set()
            return True
        with patch('student.mss.mss', return_value=broken), \
                patch.object(sender.stop_event, 'wait', side_effect=stop_wait):
            sender._capture_loop()
        sender.ws.send.assert_not_called()
        broken.close.assert_called_once()

    def test_long_sleep_replaces_connection_without_sending_stale_frame(self):
        sender = self.sender()
        sender.ws.close.side_effect = sender.stop_event.set
        with patch('student.time.time', side_effect=[100, 100 + 11 * 60]), \
                patch('student.mss.mss') as create:
            sender._capture_loop()
        sender.ws.close.assert_called_once()
        sender.ws.send.assert_not_called()
        create.assert_not_called()
        self.assertFalse(sender.registered)


class HighCaptureTests(unittest.TestCase):
    def test_original_resolution_and_request_header(self):
        packet = capture_packet(Image.new('RGB', (2000, 1200), 'white'), 0x12345678)
        self.assertEqual(packet[:5], b'\x03\x12\x34\x56\x78')
        self.assertEqual(Image.open(io.BytesIO(packet[5:])).size, (2000, 1200))

    def test_large_and_portrait_screens_preserve_aspect_ratio(self):
        for size, expected in [((3840, 2160), (2560, 1440)), ((1600, 2560), (1600, 2560)), ((800, 600), (800, 600))]:
            packet = capture_packet(Image.new('RGB', size, 'white'), 1)
            self.assertEqual(Image.open(io.BytesIO(packet[5:])).size, expected)

    def test_only_active_ai_session_can_queue_capture(self):
        class UI:
            def set_status(self, *args, **kwargs): pass
        sender = Sender(UI())
        current = sender.ws = object()
        sender.registered = True
        sender._on_message(current, '{"t":"capture","requestId":1}')
        self.assertTrue(sender.capture_requests.empty())
        sender.recording = True
        sender.capture_quality = 'ai'
        sender._on_message(object(), '{"t":"capture","requestId":1}')
        sender._on_message(current, '{"t":"capture","requestId":-1}')
        self.assertTrue(sender.capture_requests.empty())
        sender._on_message(current, '{"t":"capture","requestId":1}')
        self.assertEqual(sender.capture_requests.get_nowait(), (current, 1))


class NoticeLinkTests(unittest.TestCase):
    def urls(self, text):
        return [url for _, url in link_spans(text)]

    def test_addresses_are_found_without_the_korean_text_around_them(self):
        self.assertEqual(self.urls('자료는 https://example.org/a/b?x=1 에 있어요'),
                         ['https://example.org/a/b?x=1'])
        self.assertEqual(self.urls('www.naver.com 보세요'), ['www.naver.com'])
        self.assertEqual(self.urls('둘 https://a.kr/1 과 https://b.kr/2 입니다'),
                         ['https://a.kr/1', 'https://b.kr/2'])

    def test_sentence_punctuation_is_not_part_of_the_address(self):
        # 괄호로 감싼 주소 뒤에 조사가 바로 붙어도 주소만 남아야 한다.
        self.assertEqual(self.urls('여기(https://ko.wikipedia.org/wiki/수학)를 참고.'),
                         ['https://ko.wikipedia.org/wiki/수학'])
        self.assertEqual(self.urls('https://example.org/end.'), ['https://example.org/end'])
        self.assertEqual(self.urls('링크 없음'), [])
        self.assertEqual(self.urls('https://'), [])


class NoticeWidgetTests(unittest.TestCase):
    """The student must be able to click the address the teacher sent."""
    def setUp(self):
        try:
            self.root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(f'Tk unavailable: {error}')
        self.root.withdraw()
        self.app = App(self.root, tray_factory=FakeTray)
        self.app.root.attributes = lambda *a, **k: None   # 창을 앞으로 올리지 않는다
        self.app.root.bell = lambda: None
        self.addCleanup(self.root.destroy)

    def test_only_the_address_is_tagged_and_opens_in_a_browser(self):
        opened = []
        with patch('student.webbrowser.open', side_effect=lambda url: opened.append(url)):
            self.app.show_notice('과제는 https://example.org/hw 에 올리세요')
            box = self.app.notice_box
            self.assertEqual(len(self.app.notice_tags), 1)
            tag = self.app.notice_tags[0]
            start, end = box.tag_ranges(tag)
            self.assertEqual(box.get(start, end), 'https://example.org/hw')
            self.assertIn('과제는', box.get('1.0', 'end'))
            self.app.open_link('https://example.org/hw')
            self.app.open_link('www.naver.com')
            self.app.open_link('javascript:alert(1)')   # 웹 주소가 아니면 열지 않는다
        self.assertEqual(opened, ['https://example.org/hw', 'https://www.naver.com'])

    def test_a_new_message_replaces_the_previous_links(self):
        self.app.show_notice('https://a.kr/1 과 https://a.kr/2')
        self.assertEqual(len(self.app.notice_tags), 2)
        self.app.show_notice('링크 없는 안내')
        self.assertEqual(self.app.notice_tags, [])
        self.assertIn('링크 없는 안내', self.app.notice_box.get('1.0', 'end'))


class TrayWindowTests(unittest.TestCase):
    """창을 닫아도 전송은 이어지고, 종료는 트레이 메뉴에서만 된다."""
    def app(self, ready=True):
        try:
            root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(f'Tk unavailable: {error}')
        root.withdraw()
        app = App(root, tray_factory=lambda owner: FakeTray(owner, ready=ready))
        self.addCleanup(lambda: gone(root) or root.destroy())
        app.sender = Mock()
        app.active = True
        return app

    def test_closing_the_window_only_hides_it_and_keeps_sending(self):
        app = self.app()
        app.root.deiconify()
        app.on_close()
        self.assertEqual(app.root.state(), 'withdrawn')
        app.sender.stop.assert_not_called()
        self.assertFalse(app.closed)
        self.assertTrue(app.root.winfo_exists())
        self.assertEqual(len(app.tray.messages), 1)
        self.assertIn('계속', app.tray.messages[0])
        app.root.deiconify()
        app.on_close()   # 안내 풍선은 처음 한 번만
        self.assertEqual(len(app.tray.messages), 1)

    def test_tray_open_brings_the_hidden_window_back(self):
        app = self.app()
        app.on_close()
        app.tray_command('show')
        app.poll_events()
        self.assertEqual(app.root.state(), 'normal')
        self.assertFalse(app.closed)

    def test_teacher_message_pops_the_window_out_of_the_tray(self):
        app = self.app()
        app.root.attributes = lambda *a, **k: None
        app.root.bell = lambda: None
        app.on_close()
        app.show_notice('알림')
        self.assertEqual(app.root.state(), 'normal')

    def test_only_the_tray_quit_stops_sending_and_removes_the_icon(self):
        app = self.app()
        app.on_close()
        app.tray_command('quit')
        app.poll_events()
        app.sender.stop.assert_called_once()
        self.assertTrue(app.tray.stopped)
        self.assertTrue(app.closed)
        self.assertTrue(gone(app.root))

    def test_without_a_tray_icon_the_close_button_still_quits(self):
        app = self.app(ready=False)
        app.on_close()
        app.sender.stop.assert_called_once()
        self.assertTrue(app.closed)
        self.assertTrue(gone(app.root))

    def test_tray_shows_whether_the_screen_is_being_sent(self):
        app = self.app()
        app.tray.states.clear()
        app.set_status('전송 중 ● 모니터링되고 있습니다', ok=True)
        app.poll_events()
        self.assertEqual(app.tray.states[-1], (True, '전송 중 ● 모니터링되고 있습니다'))
        app.reset_controls()
        self.assertEqual(app.tray.states[-1][0], False)


class TrayIconTests(unittest.TestCase):
    def tray(self):
        tray = Tray(Mock())
        tray.icon = StubIcon()
        return tray

    def test_menu_clicks_are_handed_to_the_app_thread(self):
        tray = self.tray()
        tray._show(None, None)
        tray._quit(None, None)
        self.assertEqual([call.args[0] for call in tray.app.tray_command.call_args_list],
                         ['show', 'quit'])

    def test_icon_is_redrawn_only_when_the_sending_state_changes(self):
        tray = self.tray()
        tray.set_active(False, '대기 중')
        tray.set_active(False, '연결 중…')
        self.assertEqual(len(tray.icon.images), 1)
        tray.set_active(True, '전송 중')
        self.assertEqual(len(tray.icon.images), 2)
        self.assertNotEqual(tray.icon.images[0].tobytes(), tray.icon.images[1].tobytes())

    def test_long_text_is_cut_to_what_windows_accepts(self):
        tray = self.tray()
        tray.set_active(True, '긴 상태 ' * 60)
        tray.notify('긴 안내 ' * 60)
        self.assertLessEqual(len(tray.icon.title), student.TRAY_TIP_MAX)
        self.assertLessEqual(len(tray.icon.notifications[0][0]), student.TRAY_MESSAGE_MAX)

    def test_a_tray_that_cannot_start_reports_failure_instead_of_trapping_the_student(self):
        tray = Tray(Mock())
        with patch('student.pystray.Icon', side_effect=RuntimeError('no shell')):
            self.assertFalse(tray.start())
        self.assertIsNone(tray.icon)

    def test_stopping_twice_is_harmless(self):
        tray = self.tray()
        icon = tray.icon
        tray.stop()
        tray.stop()
        self.assertTrue(icon.stopped)
        self.assertIsNone(tray.icon)


if __name__ == '__main__':
    unittest.main()
