#!/usr/bin/env python3
"""Ticket-18 question: does the native `grep` quota starve later files?

The plan (§4.4 row 4, and the phase-0 acceptance criterion) treats

    "the files that come first eat the whole match quota, the files further down
     show nothing at all"

as a **judgement, not a measurement**, and requires phase 0 to settle it: if the
distribution turns out to be even, the per-file cap handler is dropped.

DSH truncates `grep` head-only at `GREP_MAX_MATCHES = 250` by match order, and the
result text states the cap itself, so the question is answerable from the corpus.
Two header forms occur, and the difference is the whole signal:

    Found 250 of 362 matches   -> capped at 250, 362 existed
    Found 43 matches           -> complete, 43 existed
    No matches found           -> complete, none

What "starved" means concretely: the shown matches concentrate in the first few
files, and the last shown file is cut mid-file, so every file after it is invisible.

Also prints the longest result per tool, which is where the ceiling on what the
model ever sees becomes visible.
"""
import argparse
import collections
import re
from extract_calls import iter_rows

FOUND = re.compile(r"^Found (\d+)(?: of (\d+))? match")
FILE_LINE = re.compile(r"^Line \d+:")


def parse_grep(text):
    """-> (shown, total, [(file, matches), ...]) or None when unparseable."""
    first = text.split("\n", 1)[0]
    if first.startswith("No matches found"):
        return 0, 0, []
    m = FOUND.match(first)
    if not m:
        return None
    shown = int(m.group(1))
    total = int(m.group(2)) if m.group(2) else shown
    blocks = []
    current = None
    for line in text.split("\n")[1:]:
        if not line.strip():
            continue
        if FILE_LINE.match(line):
            if current is not None:
                current[1] += 1
            continue
        if line.startswith("("):
            continue
        # a path line opens a new file block
        if current is not None:
            blocks.append(current)
        current = [line, 0]
    if current is not None:
        blocks.append(current)
    return shown, total, [(p, c) for p, c in blocks]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="/tmp/dsh-condense")
    args = ap.parse_args()

    grep_rows = []
    longest = collections.Counter()
    for row in iter_rows(args.out):
        n = row.get("textLen") or 0
        if n > longest[row.get("name") or "<none>"]:
            longest[row.get("name") or "<none>"] = n
        if row.get("name") == "grep":
            grep_rows.append(row)

    print("longest result per tool (chars): %s"
          % ", ".join("%s=%d" % kv for kv in longest.most_common(6)))

    parsed = [(row, parse_grep(row.get("text") or "")) for row in grep_rows]
    unparseable = [r for r, g in parsed if g is None]
    parsed = [(r, g) for r, g in parsed if g is not None]
    capped = [(r, g) for r, g in parsed if g[0] < g[1]]
    complete = [(r, g) for r, g in parsed if g[0] == g[1]]
    print("grep calls: %d ; parsed: %d ; unparseable: %d ; capped: %d ; complete: %d"
          % (len(grep_rows), len(parsed), len(unparseable), len(capped), len(complete)))

    if not capped:
        print("\nno capped grep calls in this corpus -> the judgement cannot be tested here")
        return 0

    file_counts = collections.Counter()
    largest_share = []
    single_file = 0
    for _row, (shown, _total, blocks) in capped:
        n_files = len(blocks)
        file_counts[n_files] += 1
        if n_files == 1:
            single_file += 1
        top = max(c for _p, c in blocks) if blocks else 0
        if shown:
            largest_share.append(top / shown)

    ordered = sorted(file_counts.elements())

    def pct(xs, q):
        return xs[min(len(xs) - 1, int(len(xs) * q))]

    tot = sum(g[1] for _r, g in capped)
    seen = sum(g[0] for _r, g in capped)
    print("\n--- capped grep calls (%d) ---" % len(capped))
    print("files shown per call: min=%d median=%d p90=%d max=%d"
          % (min(ordered), pct(ordered, 0.5), pct(ordered, 0.9), max(ordered)))
    print("calls showing a single file: %d (%.1f%%)"
          % (single_file, 100.0 * single_file / len(capped)))
    largest_share.sort()
    print("share of the shown quota eaten by the largest single file: "
          "median=%.0f%% p90=%.0f%% max=%.0f%%"
          % (100 * pct(largest_share, 0.5), 100 * pct(largest_share, 0.9),
             100 * largest_share[-1]))
    print("matches visible overall: %d of %d (%.1f%%)" % (seen, tot, 100.0 * seen / tot))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
