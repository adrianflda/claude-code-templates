#!/usr/bin/env python3
"""
resource-guard — PreToolUse(Bash) hook. Before a HEAVY command (build /
playwright / dev server / big clone), if system RAM is tight, surface a
real-time warning so we free memory or background it instead of hitting an OOM
(the failure that killed the #793 e2e twice). Non-blocking, fast (vm_stat +
sysctl only), silent unless both heavy-command AND tight-RAM.
"""
import sys, json, re, subprocess

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

cmd = ((data.get("tool_input") or {}).get("command")) or ""
HEAVY = re.compile(
    r"\b(next build|next dev|next start|npm run (build|dev|stg|prod|local)|"
    r"playwright|vitest|jest|npm run test|yarn build|docker build|webpack|tsc\b)"
)
if not HEAVY.search(cmd):
    sys.exit(0)


def mem():
    swap_used = swap_total = free_mb = 0.0
    try:
        sw = subprocess.run(["sysctl", "-n", "vm.swapusage"],
                            capture_output=True, text=True, timeout=2).stdout
        swap_used = float(re.search(r"used = ([\d.]+)M", sw).group(1))
        swap_total = float(re.search(r"total = ([\d.]+)M", sw).group(1))
    except Exception:
        pass
    try:
        vs = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=2).stdout
        psz = int(re.search(r"page size of (\d+)", vs).group(1))
        free = int(re.search(r"Pages free:\s+(\d+)", vs).group(1))
        inact = int(re.search(r"Pages inactive:\s+(\d+)", vs).group(1))
        free_mb = (free + inact) * psz / 1048576
    except Exception:
        free_mb = 99999
    return free_mb, swap_used, swap_total


free_mb, su, st = mem()
swap_pct = (su / st * 100) if st else 0
# Reclaimable RAM only: swap > 75% alone fired all 425 warnings of 30 days with >= 3 GB free (2026-10-28 audit);
# macOS keeps swap high long after the pressure is gone. Swap is still shown in the message.
if free_mb < 1200:
    msg = (
        f"⚠️ RESOURCE-GUARD — RAM is tight (~{free_mb:.0f}MB reclaimable, "
        f"swap {su:.0f}/{st:.0f}M = {swap_pct:.0f}%) before a heavy command. "
        "OOM risk: close apps/tabs or run it in the background with a timeout; "
        "`python3 ~/.claude/hooks/claude-reaper.py` lists hung processes."
    )
    print(json.dumps({
        "systemMessage": msg,
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": msg,
        },
    }))
sys.exit(0)
