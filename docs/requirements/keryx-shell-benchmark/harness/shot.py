#!/usr/bin/env python3
"""Turn a tmux pane capture (ANSI SGR) into an HTML page that renders like the
terminal it came from, so a headless browser can screenshot it.

This is a real capture of the live TUI: tmux renders the pane, `capture-pane -e`
preserves the escape sequences, and this only translates them to spans. It is
not a re-render of plain text.

Usage: shot.py <pane.ansi> <out.html> [title]
"""
import html
import re
import sys

# xterm 256 -> rgb, enough of it: the TUI uses 16 basic + a few 256 greys.
BASIC = [
    "#000000", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
    "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
]


def xterm256(n: int) -> str:
    if n < 16:
        return BASIC[n]
    if n < 232:
        n -= 16
        r, g, b = n // 36, (n % 36) // 6, n % 6
        conv = lambda v: 0 if v == 0 else 55 + 40 * v
        return f"#{conv(r):02x}{conv(g):02x}{conv(b):02x}"
    v = 8 + (n - 232) * 10
    return f"#{v:02x}{v:02x}{v:02x}"


SGR = re.compile(r"\x1b\[([0-9;]*)m")
OTHER_ESC = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]")


class State:
    def __init__(self):
        self.fg = None
        self.bg = None
        self.bold = False
        self.dim = False
        self.italic = False
        self.underline = False
        self.reverse = False

    def style(self) -> str:
        fg, bg = self.fg, self.bg
        if self.reverse:
            fg, bg = bg or "#0b0b0e", fg or "#d8d8d8"
        parts = []
        if fg:
            parts.append(f"color:{fg}")
        if bg:
            parts.append(f"background:{bg}")
        if self.bold:
            parts.append("font-weight:600")
        if self.dim:
            parts.append("opacity:.62")
        if self.italic:
            parts.append("font-style:italic")
        if self.underline:
            parts.append("text-decoration:underline")
        return ";".join(parts)


def apply(state: State, codes: list[int]) -> None:
    i = 0
    while i < len(codes):
        c = codes[i]
        if c == 0:
            state.__init__()
        elif c == 1:
            state.bold = True
        elif c == 2:
            state.dim = True
        elif c == 3:
            state.italic = True
        elif c == 4:
            state.underline = True
        elif c == 7:
            state.reverse = True
        elif c == 22:
            state.bold = state.dim = False
        elif c == 23:
            state.italic = False
        elif c == 24:
            state.underline = False
        elif c == 27:
            state.reverse = False
        elif 30 <= c <= 37:
            state.fg = BASIC[c - 30]
        elif 90 <= c <= 97:
            state.fg = BASIC[c - 90 + 8]
        elif 40 <= c <= 47:
            state.bg = BASIC[c - 40]
        elif 100 <= c <= 107:
            state.bg = BASIC[c - 100 + 8]
        elif c == 39:
            state.fg = None
        elif c == 49:
            state.bg = None
        elif c in (38, 48) and i + 1 < len(codes):
            target = "fg" if c == 38 else "bg"
            if codes[i + 1] == 5 and i + 2 < len(codes):
                setattr(state, target, xterm256(codes[i + 2]))
                i += 2
            elif codes[i + 1] == 2 and i + 4 < len(codes):
                r, g, b = codes[i + 2], codes[i + 3], codes[i + 4]
                setattr(state, target, f"#{r:02x}{g:02x}{b:02x}")
                i += 4
        i += 1


def convert(text: str) -> str:
    text = OTHER_ESC.sub("", text.replace("\r", ""))
    state = State()
    out = []
    pos = 0
    for m in SGR.finditer(text):
        chunk = text[pos:m.start()]
        if chunk:
            style = state.style()
            esc = html.escape(chunk)
            out.append(f'<span style="{style}">{esc}</span>' if style else esc)
        raw = m.group(1)
        codes = [int(p) if p else 0 for p in raw.split(";")] if raw else [0]
        apply(state, codes)
        pos = m.end()
    tail = text[pos:]
    if tail:
        style = state.style()
        esc = html.escape(tail)
        out.append(f'<span style="{style}">{esc}</span>' if style else esc)
    return "".join(out)


PAGE = """<!doctype html><meta charset="utf-8"><title>{title}</title>
<style>
  html,body{{margin:0;background:#0b0b0e}}
  .frame{{padding:18px 20px 22px;display:inline-block;min-width:100%;box-sizing:border-box}}
  .bar{{font:12px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#8a8a94;
        padding:0 0 12px;display:flex;gap:8px;align-items:center}}
  .dot{{width:11px;height:11px;border-radius:50%;display:inline-block}}
  pre{{margin:0;font:13.5px/1.42 "DejaVu Sans Mono","SF Mono",Menlo,monospace;
       color:#d8d8d8;white-space:pre;tab-size:8}}
</style>
<div class="frame">
  <div class="bar">
    <span class="dot" style="background:#ff5f57"></span>
    <span class="dot" style="background:#febc2e"></span>
    <span class="dot" style="background:#28c840"></span>
    <span style="margin-left:8px">{title}</span>
  </div>
  <pre>{body}</pre>
</div>
"""


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    title = sys.argv[3] if len(sys.argv) > 3 else "keryx"
    raw = open(src, encoding="utf-8", errors="replace").read()
    # tmux pads every line to the pane width; trailing blank lines are noise.
    lines = [ln.rstrip() for ln in raw.split("\n")]
    while lines and not re.sub(r"\x1b\[[0-9;]*m", "", lines[-1]).strip():
        lines.pop()
    body = convert("\n".join(lines))
    open(dst, "w", encoding="utf-8").write(
        PAGE.format(title=html.escape(title), body=body)
    )
    print(dst)


if __name__ == "__main__":
    main()
