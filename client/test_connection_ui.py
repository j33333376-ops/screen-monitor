import os
import subprocess
import sys
import tkinter as tk
import unittest
import uuid
from unittest.mock import patch

from server_address import DEFAULT_PARTS, ServerAddressInput, ipv4_address
from single_instance import SingleInstance, already_running_message


class AddressTests(unittest.TestCase):
    def test_only_fourth_octet_needs_input(self):
        parts = list(DEFAULT_PARTS)
        self.assertEqual(parts, ["192", "168", "1", "", "8080"])
        parts[3] = "28"
        self.assertEqual(ipv4_address(parts), "192.168.1.28:8080")
        self.assertEqual(ipv4_address(["010", "0", "2", "015", "80"]), "10.0.2.15:80")

    def test_rejects_invalid_or_missing_octets_and_ports(self):
        for parts in [DEFAULT_PARTS, ["256","1","1","1","8080"],
                      ["192","168","1","-1","8080"], ["192","168","1","28","0"],
                      ["192","168","1","28","65536"], ["192","168","1","28","80a"]]:
            with self.subTest(parts=parts), self.assertRaises(ValueError):
                ipv4_address(parts)

    def test_widget_disables_all_parts_and_preserves_direct_url(self):
        root = tk.Tk()
        root.withdraw()
        try:
            field = ServerAddressInput(root)
            field.parts[3].insert(0, "28")
            self.assertEqual(field.get(), "192.168.1.28:8080")
            field.config(state="disabled")
            self.assertTrue(all(str(entry.cget("state")) == "disabled" for entry in field.parts))
            field.config(state="normal")
            field.direct.set(True)
            field.switch_mode()
            field.full.delete(0, "end")
            field.full.insert(0, "https://class.example")
            self.assertEqual(field.get(), "https://class.example")
        finally:
            root.destroy()


@unittest.skipUnless(sys.platform == "win32", "Windows mutex")
class InstanceTests(unittest.TestCase):
    def test_a_second_process_is_blocked_and_exit_releases_the_lock(self):
        name = "Local\\ScreenMonitor.Test." + uuid.uuid4().hex
        first = SingleInstance(name)
        self.assertTrue(first.acquire())
        script = "from single_instance import SingleInstance; import sys; s=SingleInstance(sys.argv[1]); print(s.acquire()); s.close()"
        def launch():
            return subprocess.check_output([sys.executable, "-c", script, name],
                cwd=os.path.dirname(__file__), text=True).strip()
        try:
            self.assertEqual(launch(), "False")
        finally:
            first.close()
        self.assertEqual(launch(), "True")

    def test_duplicate_message_is_exact_and_uses_no_tk_window(self):
        with patch("single_instance.ctypes.WinDLL") as dll:
            already_running_message()
            self.assertEqual(dll.return_value.MessageBoxW.call_args.args[1], "현재 프로그램이 실행중입니다.")


if __name__ == "__main__":
    unittest.main()
