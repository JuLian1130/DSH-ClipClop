#!/usr/bin/env python3
"""Baseline table for the condense layer: per-tool calls, characters and tokens.

Reads the corpus written by `extract_calls.py` and reports, per tool name:
calls, result characters, and `o200k_base` tokens (the caliber the survey and the
plan's §7.5 baseline use). Prints a side-by-side against the four tools §7.5 pinned,
so a rerun is self-checking rather than a number nobody can reproduce.
"""
import argparse
import json
import os
import sys

import tiktoken

# plan doc `doc/tool-result-trimming-plan.md` §7.5 (2,124 session logs, o200k_base)
PLAN_75 = {
    "bash": {"calls": 106665, "tokens": 61420407},
    "grep": {"calls": 2993, "tokens": 4502889},
    "glob": {"calls": 286, "tokens": 144180},
    "read": {"calls": 25309, "tokens": 51599440},
}


def rows(out_dir):
    sess = os.path.join(out_dir, "sessions")
    for fn in sorted(os.listdir(sess)):
        with open(os.path.join(sess, fn), encoding="utf-8") as fh:
            for line in fh:
                try:
                    yield json.loads(line)
                except Exception:
                    continue


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/dsh-condense")
    ap.add_argument("--plan", default=".scratch/dsh-result-clipper/doc/tool-result-trimming-plan.md")
    args = ap.parse_args()

    enc = tiktoken.get_encoding("o200k_base")
    stats = {}
    n = 0
    for row in rows(args.out):
        n += 1
        name = row.get("name") or "<none>"
        st = stats.setdefault(name, {"calls": 0, "chars": 0, "tokens": 0})
        st["calls"] += 1
        text = row.get("text") or ""
        st["chars"] += len(text)
        if text:
            st["tokens"] += len(enc.encode_ordinary(text))

    print("calls=%d\n" % n)
    print("%-24s %8s %14s %14s" % ("tool", "calls", "chars", "tokens"))
    for name, st in sorted(stats.items(), key=lambda kv: -kv[1]["tokens"]):
        print("%-24s %8d %14d %14d" % (name, st["calls"], st["chars"], st["tokens"]))

    print("\n--- reconcile with %s §7.5 ---" % args.plan)
    ok = True
    print("%-8s %10s %10s %8s   %12s %12s %8s" % (
        "tool", "plan", "measured", "delta", "plan_tok", "meas_tok", "delta"))
    for name, want in PLAN_75.items():
        got = stats.get(name, {"calls": 0, "tokens": 0})
        dc = got["calls"] / want["calls"] - 1 if want["calls"] else 0
        dt = got["tokens"] / want["tokens"] - 1 if want["tokens"] else 0
        print("%-8s %10d %10d %7.1f%%   %12d %12d %7.1f%%" % (
            name, want["calls"], got["calls"], dc * 100,
            want["tokens"], got["tokens"], dt * 100))
        if abs(dc) > 0.05 or abs(dt) > 0.05:
            ok = False
    print("\nwithin 5%% on every pinned tool: %s" % ("yes" if ok else "NO"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
