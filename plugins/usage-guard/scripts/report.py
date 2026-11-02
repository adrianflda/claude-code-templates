#!/usr/bin/env python3
"""usage-guard report: where the subscription went, from the local transcripts.

Reads every ``~/.claude/projects/**/*.jsonl`` assistant message in the window,
dedupes streamed chunks by (message id, request id) and attributes a
price-weighted cost to day, model, kind (main / subagent / claude-mem
observer), project, session and subagent name.

Weights are the relative API list prices for the Opus/Sonnet families:
input 1.0, cache write 1.25, cache read 0.10, output 5.0. They are not your
bill; they rank consumers the way the plan is drained.
"""
import argparse
import collections
import datetime as dt
import glob
import json
import os
import re
import sys

WEIGHTS = {"inp": 1.0, "cc": 1.25, "cr": 0.10, "out": 5.0}
AGENT_RE = re.compile(r"-[0-9a-f]{16}\.jsonl$")


def load(root, days):
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)
    seen = {}
    for path in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True):
        rel = os.path.relpath(path, root)
        parts = rel.split(os.sep)
        proj = parts[0]
        kind = ("subagent" if "subagents" in parts
                else "claude-mem" if "claude-mem-observer" in proj
                else "main")
        agent = AGENT_RE.sub("", os.path.basename(path)) if kind == "subagent" else "-"
        sess = parts[1].replace(".jsonl", "") if len(parts) > 1 else "?"
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    try:
                        d = json.loads(line)
                    except ValueError:
                        continue
                    if d.get("type") != "assistant":
                        continue
                    m = d.get("message") or {}
                    u = m.get("usage")
                    ts = d.get("timestamp")
                    if not u or not ts or m.get("model") == "<synthetic>":
                        continue
                    try:
                        t = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    except ValueError:
                        continue
                    if t < since:
                        continue
                    seen[(m.get("id"), d.get("requestId"))] = {
                        "t": t.astimezone(), "proj": proj, "kind": kind, "agent": agent, "sess": sess,
                        "model": m.get("model", "?"),
                        "inp": u.get("input_tokens", 0) or 0,
                        "cc": u.get("cache_creation_input_tokens", 0) or 0,
                        "cr": u.get("cache_read_input_tokens", 0) or 0,
                        "out": u.get("output_tokens", 0) or 0,
                    }
        except OSError as e:
            print(f"skip {path}: {e}", file=sys.stderr)
    return list(seen.values())


def cost(r):
    return sum(r[k] * WEIGHTS[k] for k in WEIGHTS)


def ctx(r):
    return r["inp"] + r["cc"] + r["cr"]


def group(rows, keyf, top):
    acc = collections.defaultdict(lambda: {"calls": 0, "cost": 0.0, "out": 0, "ctx": 0})
    for r in rows:
        a = acc[keyf(r)]
        a["calls"] += 1
        a["cost"] += cost(r)
        a["out"] += r["out"]
        a["ctx"] += ctx(r)
    items = sorted(acc.items(), key=lambda kv: -kv[1]["cost"])
    return items[:top] if top else items


def print_table(title, items, total):
    print(f"\n== {title} ==")
    print(f"{'key':48} {'calls':>6} {'share':>6} {'out_tok':>10} {'avg_ctx':>8}")
    for k, a in items:
        share = 100 * a["cost"] / total if total else 0
        print(f"{str(k)[:48]:48} {a['calls']:6d} {share:5.1f}% {a['out']:10d} {a['ctx'] // max(a['calls'], 1):8d}")


def percentile(values, p):
    if not values:
        return 0
    values = sorted(values)
    return values[min(len(values) - 1, int(len(values) * p))]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--top", type=int, default=12)
    ap.add_argument("--root", default=os.path.join(os.environ.get("CLAUDE_CONFIG_DIR", os.path.expanduser("~/.claude")), "projects"))
    ap.add_argument("--json", action="store_true", help="machine-readable summary instead of tables")
    args = ap.parse_args(argv)

    rows = load(args.root, args.days)
    total = sum(cost(r) for r in rows)
    if not rows:
        print(f"no assistant messages in the last {args.days} days under {args.root}")
        return 0

    by_kind = group(rows, lambda r: r["kind"], None)
    by_day = group(rows, lambda r: r["t"].strftime("%Y-%m-%d"), None)
    by_model = group(rows, lambda r: r["model"], None)
    by_sess = group(rows, lambda r: f"{r['proj'][:28]}/{r['sess'][:8]}", args.top)
    by_agent = group([r for r in rows if r["kind"] == "subagent"], lambda r: r["agent"][:40], args.top)
    main_ctx = [ctx(r) for r in rows if r["kind"] == "main"]
    sub_ctx = [ctx(r) for r in rows if r["kind"] == "subagent"]
    big_main = [r for r in rows if r["kind"] == "main" and ctx(r) > 200000]
    main_cost = sum(cost(r) for r in rows if r["kind"] == "main")

    summary = {
        "days": args.days, "calls": len(rows), "weighted_total": round(total),
        "share_by_kind": {k: round(100 * a["cost"] / total, 1) for k, a in by_kind},
        "main_ctx_p50": percentile(main_ctx, 0.5), "main_ctx_p90": percentile(main_ctx, 0.9),
        "main_calls_over_200k_pct": round(100 * len(big_main) / max(len(main_ctx), 1)),
        "main_cost_over_200k_pct": round(100 * sum(cost(r) for r in big_main) / main_cost) if main_cost else 0,
        "subagent_ctx_p50": percentile(sub_ctx, 0.5), "subagent_ctx_p90": percentile(sub_ctx, 0.9),
        "output_tokens": {k: a["out"] for k, a in by_kind},
    }
    if args.json:
        print(json.dumps(summary, indent=2))
        return 0

    print(f"usage-guard report: last {args.days} days, {len(rows)} API calls, price-weighted attribution")
    print_table("by kind", by_kind, total)
    print_table("by model", by_model, total)
    print_table("by day", sorted(by_day, key=lambda kv: kv[0]), total)
    print_table(f"top {args.top} sessions", by_sess, total)
    if by_agent:
        print_table(f"top {args.top} subagents", by_agent, total)
    print("\n== context per call ==")
    print(f"main:     p50={summary['main_ctx_p50']:,} p90={summary['main_ctx_p90']:,}; "
          f"{summary['main_calls_over_200k_pct']}% of calls over 200k = {summary['main_cost_over_200k_pct']}% of main cost")
    print(f"subagent: p50={summary['subagent_ctx_p50']:,} p90={summary['subagent_ctx_p90']:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
