#!/usr/bin/env python3
"""usage-guard status line for Claude Code.

Reads the statusLine JSON on stdin and prints one or two lines. Shows the
numbers that decide whether you reach the end of the week: context size,
5-hour and 7-day plan usage, and the burn pace against a linear week.

Styles (``--style`` or ``USAGE_GUARD_STATUSLINE_STYLE``):
  minimal    one line, plain separators, no special font      (default)
  bar        one line with block progress bars
  powerline  one line with Nerd Font glyphs and colored segments
  multiline  two lines: identity on top, budgets below

No network, no subprocesses. Never crashes; always prints something.
"""
import argparse
import json
import os
import sys
import time

RESET = "\033[0m"
DIM = "\033[2m"
BOLD = "\033[1m"
FG = {"green": "\033[32m", "yellow": "\033[33m", "red": "\033[31m", "cyan": "\033[36m",
      "magenta": "\033[35m", "blue": "\033[34m", "white": "\033[37m"}
BG = {"green": "\033[42m", "yellow": "\033[43m", "red": "\033[41m", "cyan": "\033[46m",
      "magenta": "\033[45m", "blue": "\033[44m", "grey": "\033[100m"}
WEEK = 7 * 86400
FIVE_H = 5 * 3600


def get(d, *keys):
    for k in keys:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
    return d


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def git_branch(start):
    try:
        path = os.path.abspath(start)
        while True:
            dotgit = os.path.join(path, ".git")
            if os.path.isdir(dotgit):
                head_file = os.path.join(dotgit, "HEAD")
                break
            if os.path.isfile(dotgit):
                with open(dotgit) as f:
                    line = f.read().strip()
                if not line.startswith("gitdir:"):
                    return None
                gitdir = line[len("gitdir:"):].strip()
                if not os.path.isabs(gitdir):
                    gitdir = os.path.join(path, gitdir)
                head_file = os.path.join(gitdir, "HEAD")
                break
            parent = os.path.dirname(path)
            if parent == path:
                return None
            path = parent
        with open(head_file) as f:
            head = f.read().strip()
        if head.startswith("ref: "):
            ref = head[5:]
            return ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
        return head[:7] or None
    except Exception:
        return None


def level(pct, warn=60, bad=85):
    if pct is None:
        return "white"
    return "red" if pct >= bad else "yellow" if pct >= warn else "green"


def bar(pct, width=8):
    if pct is None:
        return "·" * width
    filled = max(0, min(width, int(round(pct / 100 * width))))
    return "█" * filled + "░" * (width - filled)


def reset_label(resets_at, now, window):
    """'3d 4h' until reset for the week, '1h20' for the 5-hour window."""
    if resets_at is None:
        return None
    left = max(0, resets_at - now)
    if window == WEEK:
        d, rem = divmod(int(left), 86400)
        h = rem // 3600
        return f"{d}d{h:02d}h" if d else f"{h}h"
    h, rem = divmod(int(left), 3600)
    m = rem // 60
    return f"{h}h{m:02d}"


def pace(used_pct, resets_at, now, window):
    """used / expected-if-linear. 1.0 = on track, 2.0 = burning twice as fast."""
    if used_pct is None or resets_at is None:
        return None
    elapsed = window - (resets_at - now)
    if elapsed <= window * 0.02:  # window just started: pace is meaningless
        return None
    expected = elapsed / window * 100
    return used_pct / expected if expected > 0 else None


def tokens_k(v):
    v = num(v)
    if v is None:
        return None
    return f"{v/1000:.0f}k" if v >= 1000 else f"{int(v)}"


class Fields:
    def __init__(self, data, now):
        self.model = get(data, "model", "display_name") or get(data, "model", "id") or "?"
        self.ctx_pct = num(get(data, "context_window", "used_percentage"))
        cu = get(data, "context_window", "current_usage") or {}
        in_tok = sum(num(cu.get(k)) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        self.ctx_tokens = tokens_k(in_tok) if in_tok else None
        self.ctx_size = tokens_k(get(data, "context_window", "context_window_size"))
        self.five_pct = num(get(data, "rate_limits", "five_hour", "used_percentage"))
        self.five_reset = num(get(data, "rate_limits", "five_hour", "resets_at"))
        self.week_pct = num(get(data, "rate_limits", "seven_day", "used_percentage"))
        self.week_reset = num(get(data, "rate_limits", "seven_day", "resets_at"))
        self.cost = num(get(data, "cost", "total_cost_usd"))
        cwd = get(data, "workspace", "current_dir") or data.get("cwd") or os.getcwd()
        self.dir = os.path.basename(str(cwd).rstrip("/")) or str(cwd)
        self.branch = git_branch(str(cwd))
        self.five_left = reset_label(self.five_reset, now, FIVE_H)
        self.week_left = reset_label(self.week_reset, now, WEEK)
        self.week_pace = pace(self.week_pct, self.week_reset, now, WEEK)

    def pct(self, v):
        return "--%" if v is None else f"{v:.0f}%"

    def pace_txt(self):
        return None if self.week_pace is None else f"{self.week_pace:.1f}x"


def c(color, text, color_on=True):
    return f"{FG[color]}{text}{RESET}" if color_on else text


def style_minimal(f, color):
    parts = [str(f.model), f"ctx {f.pct(f.ctx_pct)}"]
    parts.append(c(level(f.five_pct), f"5h {f.pct(f.five_pct)}", color))
    week = f"7d {f.pct(f.week_pct)}"
    if f.week_pace:
        week += f" pace {f.pace_txt()}"
    if f.week_left:
        week += f" ↺{f.week_left}"
    parts.append(c(level(f.week_pct, 50, 75), week, color))
    parts.append(f.dir)
    if f.branch:
        parts.append(f.branch)
    return " · ".join(parts)


def style_bar(f, color):
    parts = [str(f.model)]
    parts.append(f"ctx {bar(f.ctx_pct)} {f.pct(f.ctx_pct)}")
    parts.append(c(level(f.five_pct), f"5h {bar(f.five_pct, 5)} {f.pct(f.five_pct)}", color))
    week = f"7d {bar(f.week_pct)} {f.pct(f.week_pct)}"
    if f.week_pace:
        week += f" {f.pace_txt()}"
    if f.week_left:
        week += f" ↺{f.week_left}"
    parts.append(c(level(f.week_pct, 50, 75), week, color))
    parts.append(f.dir + (f" {f.branch}" if f.branch else ""))
    return " │ ".join(parts)


def style_powerline(f, color):
    sep = ""  # Nerd Font right-pointing triangle
    segs = [("blue", f"  {f.model} "),
            ("grey", f"  ctx {f.pct(f.ctx_pct)} "),
            (level(f.five_pct), f"  5h {f.pct(f.five_pct)} "),
            (level(f.week_pct, 50, 75), f"  7d {f.pct(f.week_pct)}" + (f" {f.pace_txt()}" if f.week_pace else "") + (f" ↺{f.week_left}" if f.week_left else "") + " "),
            ("magenta", f"  {f.dir}" + (f"  {f.branch}" if f.branch else "") + " ")]
    if not color:
        return sep.join(t for _, t in segs)
    out = ""
    for i, (bg, text) in enumerate(segs):
        fg_text = "\033[30m" if bg in ("yellow", "green", "white") else "\033[97m"
        out += f"{BG.get(bg, BG['grey'])}{fg_text}{text}{RESET}"
        nxt = segs[i + 1][0] if i + 1 < len(segs) else None
        out += f"{FG.get(bg, '')}{BG.get(nxt, BG['grey']) if nxt else ''}{sep}{RESET}"
    return out


def style_multiline(f, color):
    top = f"{BOLD if color else ''}{f.model}{RESET if color else ''} · {f.dir}" + (f" · {f.branch}" if f.branch else "")
    ctx = f"ctx {bar(f.ctx_pct, 10)} {f.pct(f.ctx_pct)}"
    if f.ctx_tokens and f.ctx_size:
        ctx += f" ({f.ctx_tokens}/{f.ctx_size})"
    five = c(level(f.five_pct), f"5h {bar(f.five_pct, 5)} {f.pct(f.five_pct)}" + (f" ↺{f.five_left}" if f.five_left else ""), color)
    week = f"7d {bar(f.week_pct, 10)} {f.pct(f.week_pct)}"
    if f.week_pace:
        week += f" pace {f.pace_txt()}"
    if f.week_left:
        week += f" ↺{f.week_left}"
    week = c(level(f.week_pct, 50, 75), week, color)
    bottom = " │ ".join([ctx, five, week])
    if f.cost:
        bottom += f" │ ${f.cost:.2f}"
    return top + "\n" + bottom


STYLES = {"minimal": style_minimal, "bar": style_bar, "powerline": style_powerline, "multiline": style_multiline}

SAMPLE = {
    "model": {"display_name": "Fable 5.1"},
    "workspace": {"current_dir": "/Users/adrian/Projects/claude-code-templates"},
    "context_window": {"used_percentage": 42, "context_window_size": 200000,
                        "current_usage": {"input_tokens": 1200, "cache_read_input_tokens": 82000, "cache_creation_input_tokens": 900}},
    "rate_limits": {"five_hour": {"used_percentage": 23.5, "resets_at": 0}, "seven_day": {"used_percentage": 43, "resets_at": 0}},
    "cost": {"total_cost_usd": 1.23},
}


def render(data, style, color, now=None):
    now = time.time() if now is None else now
    f = Fields(data if isinstance(data, dict) else {}, now)
    fn = STYLES.get(style) or style_minimal
    return fn(f, color)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--style", default=os.environ.get("USAGE_GUARD_STATUSLINE_STYLE", "minimal"), choices=sorted(STYLES))
    ap.add_argument("--no-color", action="store_true")
    ap.add_argument("--preview", action="store_true", help="render every style with sample data and exit")
    args = ap.parse_args(argv)
    color = not args.no_color
    if args.preview:
        now = time.time()
        SAMPLE["rate_limits"]["five_hour"]["resets_at"] = now + 2 * 3600 + 15 * 60
        SAMPLE["rate_limits"]["seven_day"]["resets_at"] = now + 5 * 86400 + 4 * 3600  # Monday of a Saturday-reset week
        for name in ("minimal", "bar", "powerline", "multiline"):
            print(f"{DIM}[{name}]{RESET}")
            print(render(SAMPLE, name, color, now))
            print()
        return 0
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    print(render(data, args.style, color))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("usage-guard statusline: error")
        sys.exit(0)
