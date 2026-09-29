import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import launcher


class SettingsTest(unittest.TestCase):
    def test_password_rules(self):
        v = launcher.validate_settings
        self.assertIsNone(v("math2026", "math2026", "C:\기록"))
        self.assertIn("4자", v("abc", "abc", "C:\기록"))
        self.assertIn("공개 문서", v("teacher1234", "teacher1234", "C:\기록"))
        self.assertIn("일치", v("math2026", "math2027", "C:\기록"))
        self.assertIn("빈칸", v(" math2026", " math2026", "C:\기록"))
        self.assertIn("저장 폴더", v("math2026", "math2026", "  "))

    def test_config_round_trip_and_defaults(self):
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"SCREEN_MONITOR_TEACHER_HOME": home}):
            self.assertIsNone(launcher.load_config(), "처음에는 설정이 없다")
            launcher.save_config({"password": "math2026", "save_dir": "D:\기록", "port": 8080})
            self.assertEqual(launcher.load_config(), {"password": "math2026", "save_dir": "D:\기록", "port": 8080})
            Path(home, "config.json").write_text(json.dumps({"password": "math2026", "port": "x"}), encoding="utf-8")
            config = launcher.load_config()
            self.assertEqual(config["port"], 8080)
            self.assertTrue(config["save_dir"].endswith("학생화면기록"))

    def test_default_folder_avoids_onedrive(self):
        with mock.patch.object(launcher, "documents_dir", return_value=Path("C:/Users/t/OneDrive/문서")):
            self.assertEqual(launcher.default_save_dir(), str(Path.home() / "학생화면기록"))
        with mock.patch.object(launcher, "documents_dir", return_value=Path("C:/Users/t/Documents")):
            self.assertEqual(launcher.default_save_dir(), str(Path("C:/Users/t/Documents/학생화면기록")))


class EventTest(unittest.TestCase):
    def test_only_status_lines_are_events(self):
        self.assertEqual(launcher.parse_event('@@{"t":"ready","port":8080}'), {"t": "ready", "port": 8080})
        self.assertIsNone(launcher.parse_event("  학생 화면 모니터 서버가 켜졌습니다."))
        self.assertIsNone(launcher.parse_event("@@not json"))
        self.assertIsNone(launcher.parse_event('@@{"port":1}'))


if __name__ == "__main__":
    unittest.main()
