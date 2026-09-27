"""A named Windows kernel object prevents duplicate launches, including tray runs."""
import ctypes
from ctypes import wintypes
import sys


class SingleInstance:
    def __init__(self, name=r"Local\SchoolScreenMonitor.Student"):
        self.name = name
        self.handle = None
        self.kernel = None

    def acquire(self):
        if self.handle is not None:
            return True
        if sys.platform != "win32":
            return True
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel.CreateMutexW.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        ctypes.set_last_error(0)
        handle = self.kernel.CreateMutexW(None, False, self.name)
        error = ctypes.get_last_error()
        if not handle:
            raise ctypes.WinError(error)
        if error == 183:  # ERROR_ALREADY_EXISTS; do not keep the second handle alive.
            self.kernel.CloseHandle(handle)
            return False
        self.handle = handle
        return True

    def close(self):
        if self.handle is not None:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def already_running_message():
    # No Tk root or tray is created for a second launch.
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT]
    user32.MessageBoxW.restype = ctypes.c_int
    user32.MessageBoxW(None, "현재 프로그램이 실행중입니다.", "학생 화면 전송", 0x40 | 0x10000)
