#!/usr/bin/env python3
"""Baseline table for the condense layer: per-tool calls, characters and tokens.

Reads the corpus written by `extract_calls.py` and reports, per tool name: calls,
result characters, and `o200k_base` tokens.

The pinned figures are **parsed out of the plan document**, not transcribed into
this file — a hand-typed copy would keep agreeing with itself after the spec moved.
"""
import argparse
import re
import sys

import tiktoken
from extract_calls import iter_rows

PLAN_ROW = re.compile(r"^\|\s*`([a-z_]+)`[^|]*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|")
DOC_TOLERANCE = 0.05


def pinned(path):
    """Pull the §7.5 baseline rows (tool, calls, tokens) out of the plan table."""
    out = {}
    seen_header = False
    for line in open(path, encoding="utf-8"):
        header = "|".join(line.split("|")[1:4]).strip()
        if "工具" in header and "调用数" in header:
            seen_header = True
            continue
        if not seen_header:
            continue
        if line.startswith("##"):
            break
        m = PLAN_ROW.match(line)
        if m:
            out[m.group(1)] = (int(m.group(2).replace(",", "")),
                               int(m.group(3).replace(",", "")))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/dsh-condense")
    ap.add_argument("--plan",
                    default=".scratch/dsh-result-clipper/doc/tool-result-trimming-plan.md")
    args = ap.parse_args()

    want = pinned(args.plan)
    if not want:
        print("could not parse the §7.5 table from %s" % args.plan, file=sys.stderr)
        return 2

    enc = tiktoken.get_encoding("o200k_base")
    stats = {}
    n = 0
    for row in iter_rows(args.out):
        n += 1
        st = stats.setdefault(row.get("name") or "<none>", {"calls": 0, "chars": 0, "tokens": 0})
        st["calls"] += 1
        text = row.get("text") or ""
        st["chars"] += len(text)
        if text:
            st["tokens"] += len(enc.encode_ordinary(text))

    print("calls=%d\n" % n)
    print("%-24s %8s %14s %14s" % ("tool", "calls", "chars", "tokens"))
    for name, st in sorted(stats.items(), key=lambda kv: -kv[1]["tokens"]):
        print("%-24s %8d %14d %14d" % (name, st["calls"], st["chars"], st["tokens"]))

    print("\n--- reconcile with §7.5 of %s ---" % args.plan)
    print("%-8s %10s %10s %8s   %12s %12s %8s" % (
        "tool", "plan", "measured", "delta", "plan_tok", "meas_tok", "delta"))
    ok = True
    for name, (want_calls, want_tokens) in sorted(want.items()):
        got = stats.get(name, {"calls": 0, "tokens": 0})
        dc = got["calls"] / want_calls - 1
        dt = got["tokens"] / want_tokens - 1
        print("%-8s %10d %10d %7.1f%%   %12d %12d %7.1f%%" % (
            name, want_calls, got["calls"], dc * 100, want_tokens, got["tokens"], dt * 100))
        if abs(dc) > DOC_TOLERANCE or abs(dt) > DOC_TOLERANCE:
            ok = False
    print("\nwithin %d%% on every pinned tool: %s"
          % (DOC_TOLERANCE * 100, "yes" if ok else "NO"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
