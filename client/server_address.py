"""Split IPv4 input with an optional full URL for existing HTTPS/domain setups."""
import re
import tkinter as tk
from tkinter import ttk

DEFAULT_PARTS = ("192", "168", "1", "", "8080")


def ipv4_address(parts):
    if len(parts) != 5:
        raise ValueError("IP 주소 네 칸과 포트를 입력하세요.")
    values = []
    for index, part in enumerate(parts):
        part = part.strip()
        maximum = 65535 if index == 4 else 255
        minimum = 1 if index == 4 else 0
        if not re.fullmatch(r"[0-9]{1,5}" if index == 4 else r"[0-9]{1,3}", part):
            raise ValueError("IP 주소는 각 칸에 0~255, 포트는 1~65535의 숫자를 입력하세요.")
        number = int(part)
        if not minimum <= number <= maximum:
            raise ValueError("IP 주소는 각 칸에 0~255, 포트는 1~65535의 숫자를 입력하세요.")
        values.append(str(number))
    return ".".join(values[:4]) + ":" + values[4]


class ServerAddressInput(ttk.Frame):
    def __init__(self, parent, on_next=None):
        super().__init__(parent)
        self.direct = tk.BooleanVar(value=False)
        self.parts_row = ttk.Frame(self)
        self.parts_row.pack(fill="x")
        self.parts = []
        for index, default in enumerate(DEFAULT_PARTS):
            if index:
                ttk.Label(self.parts_row, text=":" if index == 4 else ".").pack(side="left", padx=2)
            entry = ttk.Entry(self.parts_row, width=6 if index == 4 else 4, justify="center")
            entry.insert(0, default)
            entry.pack(side="left", fill="x", expand=True)
            limit = 5 if index == 4 else 3
            validate = self.register(lambda value, limit=limit: not value or
                                     (value.isascii() and value.isdigit() and len(value) <= limit))
            entry.configure(validate="key", validatecommand=(validate, "%P"))
            entry.bind("<FocusIn>", lambda event: event.widget.selection_range(0, "end"))
            self.parts.append(entry)
        if on_next:
            self.parts[3].bind("<Return>", lambda event: on_next())
        self.full = ttk.Entry(self)
        self.toggle = ttk.Checkbutton(self, text="주소 직접 입력 (도메인·HTTPS)", variable=self.direct,
                                      command=self.switch_mode)
        self.toggle.pack(anchor="w", pady=(4, 0))

    def switch_mode(self):
        if self.direct.get():
            self.parts_row.pack_forget()
            if not self.full.get():
                self.full.insert(0, ".".join(e.get() for e in self.parts[:4]) + ":" + self.parts[4].get())
            self.full.pack(fill="x", before=self.toggle)
            self.full.focus_set()
        else:
            self.full.pack_forget()
            self.parts_row.pack(fill="x", before=self.toggle)
            self.parts[3].focus_set()

    def get(self):
        return self.full.get().strip() if self.direct.get() else ipv4_address([e.get() for e in self.parts])

    def set(self, value):
        """지난번에 쓴 주소를 되살린다. IP:포트는 다섯 칸에, 그 밖의 주소는 직접 입력 칸에 넣는다."""
        value = str(value).strip()
        match = re.fullmatch(r"(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})", value)
        if match:
            self.direct.set(False)
            for entry, part in zip(self.parts, match.groups()):
                entry.delete(0, "end")
                entry.insert(0, part)
        elif value:
            self.direct.set(True)
            self.full.delete(0, "end")
            self.full.insert(0, value)
        self.switch_mode()

    def config(self, **kwargs):
        state = kwargs.pop("state", None)
        if state is not None:
            for widget in [*self.parts, self.full, self.toggle]:
                widget.configure(state=state)
        if kwargs:
            super().configure(**kwargs)
