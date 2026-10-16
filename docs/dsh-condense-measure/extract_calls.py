#!/usr/bin/env python3
"""Extract every tool call + its full result from DSH session logs, unfiltered.

Why this exists rather than reusing `docs/dsh-bash-usage/`:

- `extract.py` there keeps only `bash` calls (`rows/` carries no tool-name field at all).
- `extract_all.py` keeps an allow-list of 8 write-ish tools that **excludes `grep` and
  `glob`**, and truncates `text` to 400 characters.
- Measuring a condense ratio needs the whole result text, and native `grep` / `glob`
  are exactly the tools that allow-list dropped — so neither existing extractor can
  answer "how much could the condense layer save".

Output, one JSONL per session directory (a session directory holds one log per schema
version, v3 and v4, so calls would otherwise be counted twice):

    $OUT/sessions/<dirkey>.jsonl

Row fields: callId, name, session, project, version, file, turn, step, command,
description, argKeys, argsScalars, text, textLen, isError, meta, metaTruncated,
hasResult.

Large argument values (file bodies, old/new strings) are recorded as lengths only —
they are not what the condense layer rewrites, and keeping them would multiply the
corpus size for nothing.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser("~")
DEFAULT_ROOT = os.path.join(HOME, ".dsh", "sessions")
DEFAULT_OUT = "/tmp/dsh-condense"
# Argument values we keep verbatim; anything longer is recorded as a length only.
MAX_ARG_VALUE = 2000


def session_dirs(root):
    """Every directory that directly contains at least one session log."""
    found = set()
    for dirpath, _dirnames, filenames in os.walk(root):
        if any(f.startswith("session") and f.endswith(".jsonl.zstd") for f in filenames):
            found.add(dirpath)
    return sorted(found)


def iter_events(path):
    """Yield parsed events from one zstd-compressed JSONL session log."""
    proc = subprocess.Popen(
        ["zstd", "-dc", path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
    )
    try:
        for raw in proc.stdout:
            raw = raw.strip()
            if not raw:
                continue
            try:
                yield json.loads(raw)
            except Exception:
                continue
    finally:
        try:
            proc.stdout.close()
        except Exception:
            pass
        proc.wait()


def collect_text(content):
    """Pull text out of a tool-result content tree (v3 nests, v4 does not)."""
    chunks = []

    def walk(node):
        if isinstance(node, str):
            chunks.append(node)
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            if node.get("type") == "text" and isinstance(node.get("text"), str):
                chunks.append(node["text"])
                return
            inner = node.get("content")
            if isinstance(inner, (list, str)):
                walk(inner)

    walk(content)
    return "\n".join(chunks)


def parse_args(raw):
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            got = json.loads(raw)
        except Exception:
            return {"_raw": raw}
        return got if isinstance(got, dict) else {"_raw": got}
    return {}


def slim(value):
    """Keep small scalars; replace anything bulky with a length marker."""
    if isinstance(value, str):
        if len(value) > MAX_ARG_VALUE:
            return {"_len": len(value)}
        return value
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return [slim(v) for v in value[:20]]
    if isinstance(value, dict):
        return {k: slim(v) for k, v in list(value.items())[:20]}
    return None


def extract_dir(paths, out_path):
    """Merge every schema version in one session directory, deduped by callId."""
    calls = {}
    results = {}
    session_id = version = None
    project = os.path.basename(os.path.dirname(paths[0]))
    events = 0
    for path in paths:
        for ev in iter_events(path):
            events += 1
            etype = ev.get("type")
            if etype == "session" and session_id is None:
                session_id = ev.get("id")
                version = ev.get("version")
                project = os.path.basename(ev.get("cwd") or project)
            elif etype == "tool/call":
                data = ev.get("data") or {}
                cid = data.get("callId")
                if cid is None:
                    continue
                calls[cid] = {
                    "name": data.get("name"),
                    "args": parse_args(data.get("arguments")),
                    "turn": data.get("turn"),
                    "step": data.get("step"),
                }
            elif etype == "tool/result":
                data = ev.get("data") or {}
                msg = data.get("message") or {}
                src = msg.get("source") if isinstance(msg.get("source"), dict) else {}
                cid = (
                    msg.get("toolCallId")
                    or data.get("toolCallId")
                    or data.get("callId")
                    or src.get("callId")
                )
                if cid is None:
                    continue
                text = collect_text(msg.get("content"))
                # v3/v4 copies of the same call: keep the longest text we see.
                prev = results.get(cid)
                if prev is None or len(text) > len(prev["text"]):
                    meta = data.get("meta")
                    results[cid] = {
                        "text": text,
                        "isError": bool(data.get("isError") or msg.get("isError")),
                        "meta": meta if isinstance(meta, dict) else {},
                    }

    rows = []
    for cid, call in calls.items():
        res = results.get(cid)
        args = call["args"] or {}
        rows.append({
            "callId": cid,
            "name": call["name"],
            "session": session_id,
            "project": project,
            "version": version,
            "dir": os.path.basename(paths[0].rsplit("/", 1)[0]) if "/" in paths[0] else None,
            "turn": call["turn"],
            "step": call["step"],
            "command": args.get("command") if isinstance(args.get("command"), str) else "",
            "description": args.get("description") if isinstance(args.get("description"), str) else "",
            "argKeys": sorted(args.keys()),
            "args": {k: slim(v) for k, v in args.items()},
            "text": res["text"] if res else "",
            "textLen": len(res["text"]) if res else 0,
            "isError": res["isError"] if res else None,
            "meta": {k: slim(v) for k, v in (res["meta"] if res else {}).items()},
            "metaTruncated": bool((res or {}).get("meta", {}).get("truncated")),
            "hasResult": res is not None,
        })
    with open(out_path, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    return (paths[0], len(rows), len(calls), len(results), events, None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0, help="only the first N session dirs")
    args = ap.parse_args()

    dirs = session_dirs(args.root)
    if args.limit:
        dirs = dirs[: args.limit]
    out_dir = os.path.join(args.out, "sessions")
    os.makedirs(out_dir, exist_ok=True)
    print("session dirs: %d -> %s" % (len(dirs), out_dir), flush=True)

    t0 = time.time()
    done = rows_total = errors = files = 0
    per_tool = {}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = []
        for d in dirs:
            logs = sorted(
                os.path.join(d, f)
                for f in os.listdir(d)
                if f.startswith("session") and f.endswith(".jsonl.zstd")
            )
            files += len(logs)
            key = d.replace("/", "_")
            futs.append(pool.submit(extract_dir, logs, os.path.join(out_dir, key + ".jsonl")))
        for fut in futs:
            try:
                _first, n, ncalls, nresults, _ev, _err = fut.result()
            except Exception as exc:  # pragma: no cover
                errors += 1
                print("ERR %s" % exc, flush=True)
                continue
            done += 1
            rows_total += n
            if done % 100 == 0:
                print(
                    "progress %d/%d rows=%d elapsed=%.1fs"
                    % (done, len(dirs), rows_total, time.time() - t0),
                    flush=True,
                )

    for fn in os.listdir(out_dir):
        with open(os.path.join(out_dir, fn), encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                name = row.get("name") or "<none>"
                bucket = per_tool.setdefault(name, {"calls": 0, "chars": 0, "noResult": 0})
                bucket["calls"] += 1
                bucket["chars"] += row.get("textLen") or 0
                if not row.get("hasResult"):
                    bucket["noResult"] += 1

    summary = {
        "root": args.root,
        "out": args.out,
        "session_dirs": len(dirs),
        "log_files": files,
        "calls": rows_total,
        "errors": errors,
        "elapsed_s": round(time.time() - t0, 1),
        "per_tool": dict(sorted(per_tool.items(), key=lambda kv: -kv[1]["calls"])),
    }
    with open(os.path.join(args.out, "summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
    print("DONE dirs=%d files=%d calls=%d errors=%d elapsed=%.1fs"
          % (done, files, rows_total, errors, time.time() - t0), flush=True)
    print("per-tool:", json.dumps(summary["per_tool"], ensure_ascii=False), flush=True)
    if errors:
        print("WARNING: %d session dirs failed" % errors, file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
