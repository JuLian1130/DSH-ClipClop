#!/usr/bin/env python3
"""Ticket-18 question: does the native `grep` quota starve later files?

The plan (§4.4 row 4, and the phase-0 acceptance criterion) treats

    "the files that come first eat the whole match quota, the files further down
     show nothing at all"

as a **judgement, not a measurement**, and requires phase 0 to settle it: if the
distribution turns out to be even, the per-file cap handler is dropped.

DSH truncates `grep` head-only at `GREP_MAX_MATCHES = 250` by match order, and the
result text states the cap itself (`Found <shown> of <total> matches`), so the
question is answerable directly from the corpus. What "starved" means concretely:
the shown matches concentrate in the first few files, and the last shown file is
cut mid-file, so every file after it is invisible.

Also reports the tail-length histogram, which is how the ~50,000-character ceiling
on what a session log keeps becomes visible.
"""
import argparse
import collections
import glob
import json
import os
import re

FOUND = re.compile(r"^Found (\d+) of (\d+) matches")
FILE_LINE = re.compile(r"^Line \d+:")
TAIL_CEILING = 50_000


def rows(out_dir, name):
    for fn in glob.glob(os.path.join(out_dir, "sessions", "*.jsonl")):
        with open(fn, encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                if row.get("name") == name:
                    yield row


def parse_grep(text):
    """-> (shown, total, [(file, matches), ...]) or None when unparseable."""
    m = FOUND.match(text)
    shown = int(m.group(1)) if m else None
    total = int(m.group(2)) if m else None
    blocks = []
    current = None
    for line in text.split("\n"):
        if not line.strip():
            continue
        if FILE_LINE.match(line):
            if current is not None:
                current[1] += 1
            continue
        if line.startswith("(") or line.startswith("Found "):
            continue
        # a path line opens a new file block
        if current is not None:
            blocks.append(current)
        current = [line, 0]
    if current is not None:
        blocks.append(current)
    if not blocks:
        return None
    return shown, total, [(p, c) for p, c in blocks]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/dsh-condense")
    ap.add_argument("--min-tokens", type=int, default=1024,
                    help="the plan's own selectivity for the grep handler")
    args = ap.parse_args()

    tails = collections.Counter()
    grep_rows = []
    for row in rows(args.out, "grep"):
        n = row.get("textLen") or 0
        if n >= TAIL_CEILING - 100:
            tails["grep@ceiling"] += 1
        grep_rows.append(row)
    bash_at_ceiling = sum(
        1 for r in rows(args.out, "bash") if (r.get("textLen") or 0) >= TAIL_CEILING - 100
    )
    del tails
    print("grep calls: %d ; bash rows at the %d-char ceiling: %d"
          % (len(grep_rows), TAIL_CEILING, bash_at_ceiling))

    parsed = []
    for row in grep_rows:
        got = parse_grep(row.get("text") or "")
        if got:
            parsed.append((row, got))
    print("parsed: %d of %d" % (len(parsed), len(grep_rows)))

    truncated = [(r, g) for r, g in parsed
                 if g[0] is not None and g[1] is not None and g[0] < g[1]]
    whole = [1 for r, g in parsed if g[0] is not None and g[0] == g[1]]
    print("capped (shown < total): %d ; complete (shown == total): %d ; "
          "no header: %d" % (len(truncated), len(whole), len(parsed) - len(truncated) - len(whole)))

    if not truncated:
        print("\nno capped grep calls in this corpus -> the judgement cannot be tested here")
        return 0

    file_counts = collections.Counter()
    largest_share = []
    single_file = 0
    for _row, (shown, _total, blocks) in truncated:
        n_files = len(blocks)
        file_counts[n_files] += 1
        if n_files == 1:
            single_file += 1
        top = max(c for _p, c in blocks) if blocks else 0
        if shown:
            largest_share.append(top / shown)

    largest_share.sort()

    def pct(xs, q):
        return xs[min(len(xs) - 1, int(len(xs) * q))]

    tot_matches = sum(g[1] for _r, g in truncated)
    shown_matches = sum(g[0] for _r, g in truncated)
    print("\n--- capped grep calls (%d) ---" % len(truncated))
    print("files shown per call: min=%d median=%d p90=%d max=%d"
          % (min(file_counts), pct(sorted(file_counts.elements()), 0.5),
             pct(sorted(file_counts.elements()), 0.9), max(file_counts)))
    print("calls showing a single file: %d (%.1f%%)"
          % (single_file, 100.0 * single_file / len(truncated)))
    print("share of the shown quota eaten by the largest single file: "
          "median=%.0f%% p90=%.0f%% max=%.0f%%"
          % (100 * pct(largest_share, 0.5), 100 * pct(largest_share, 0.9),
             100 * largest_share[-1]))
    print("matches visible overall: %d of %d (%.1f%%)"
          % (shown_matches, tot_matches, 100.0 * shown_matches / tot_matches))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
