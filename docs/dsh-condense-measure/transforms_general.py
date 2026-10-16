#!/usr/bin/env python3
"""通用形状变换（计划 §4.3 的 13–16）在真实语料上的测量用原型。

四条变换与参数：

| 名称 | 变换 | 参数 | 有损 |
| --- | --- | --- | --- |
| 13 `strip-ansi` | 剥 ANSI 转义序列 | — | 否 |
| 14 `strip-cr` | 去 `\\r` 进度条覆盖行 | — | 否 |
| 15 `dedup-adjacent` | 相邻游程去重 | `MIN_RUN = 3`，命中留一行 + `[xN]`；仅相邻、不跨距离；空行游程豁免 | 否 |
| 16 `tail-cap` | 尾部偏置封顶 | 头 50 / 尾 200 / 总 300 行 / 单行 2000 字符 | **是** |

组合方式是**链**：无损在前（13–15）、有损（16）在后，各自幂等。三个数（省幅 /
触发数 / 守卫放弃数）的口径完全由 `harness.py` 的 docstring 定义并由它计算，本文件
不重算、也不改它；`Transform(lossy=True)` 让 harness 把回退入口的说明算进净收益闸门。

用法（在仓库根目录跑，脚本所在目录自动进 `sys.path`）：

    python3 docs/dsh-condense-measure/transforms_general.py --run all   # 四个单条 + 整链，出三个数
    python3 docs/dsh-condense-measure/transforms_general.py --scan      # 零命中排查 + 幂等断言（不跑分词器）
    python3 docs/dsh-condense-measure/transforms_general.py --run 13-strip-ansi

`--scan` 不过闸门，只回答「这一条在本语料上有没有改动过任何一次结果」——这是「零命中」
的判据（含低于尺寸下限、被 harness 跳过的那些调用）。三个数里「有改动但被闸门挡下」由
`--run` 的 `gate-rejected` 给出，两者不可混为一谈。

`--triggered` 补算「只在被替换的那批调用上」的省幅。harness 的 `saving_triggered` 与
`saving_all` 恒等：未触发的调用把 `before` 记进 `tokens_after`，于是
`saved + tokens_after == tokens_before`，两个比值永远相同，读不出计划 §4.4 要的那个
「触发口径 ≥60%」。本模式按 harness 同一套闸门（`estimate_units` / `FLOOR_UNITS` /
`MIN_NET_GAIN_UNITS` / `fallback_notice`）重走一遍并顺带核对触发数是否与 harness 一致。
"""
import argparse
import re
import sys
from dataclasses import dataclass

import tiktoken

from extract_calls import iter_rows
from harness import (FLOOR_UNITS, MIN_NET_GAIN_UNITS, Outcome, Transform,
                     estimate_units, fallback_notice, measure_chain)

NAME_ANSI = "13-strip-ansi"
NAME_CR = "14-strip-cr"
NAME_DEDUP = "15-dedup-adjacent"
NAME_CAP = "16-tail-cap"
CHAIN = "chain-13..16"

# ① ANSI：CSI (`ESC [ … final`)、OSC (`ESC ] … BEL|ST`)、字符集选择、两字符转义，
# 最后一条裸 `ESC` 是兜底——它保证第一遍之后正文里再没有 ESC，于是第二遍必然不动，
# 幂等不是"碰巧成立"而是构造出来的。
ANSI = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]"          # CSI
    r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?"  # OSC
    r"|\x1b[()][0-9A-Za-z]"             # 字符集选择
    r"|\x1b[@-Z\\-_]"                   # 两字符转义
    r"|\x1b"                            # 兜底
)

MIN_RUN = 3          # §4.3 #15
HEAD_LINES = 50      # §4.3 #16
TAIL_LINES = 200
MAX_LINES = 300
MAX_LINE_CHARS = 2000

# 纯函数入口（不记账），供 --scan 与幂等断言使用。
PURE = {}


def strip_ansi(text, row):
    if "\x1b" not in text:
        return Outcome(text)
    return Outcome(ANSI.sub("", text))


def strip_cr(text, row):
    """`\\r` 覆盖行：CRLF 先归一，再对每行只保留最后一个 `\\r` 之后的内容。"""
    if "\r" not in text:
        return Outcome(text)
    out = []
    for line in text.replace("\r\n", "\n").split("\n"):
        if "\r" in line:
            line = line[line.rindex("\r") + 1:]
        out.append(line)
    return Outcome("\n".join(out))


def dedup_adjacent(text, row):
    """仅相邻的相同行、游程 >= MIN_RUN 且非空行时，压成一行 + `[xN]`。"""
    if "\n" not in text:
        return Outcome(text)
    lines = text.split("\n")
    out = []
    changed = False
    i = 0
    while i < len(lines):
        j = i + 1
        while j < len(lines) and lines[j] == lines[i]:
            j += 1
        if j - i >= MIN_RUN and lines[i].strip():
            out.append(lines[i])
            out.append("[x%d]" % (j - i))
            changed = True
        else:
            out.extend(lines[i:j])
        i = j
    if not changed:
        return Outcome(text)
    return Outcome("\n".join(out))


@dataclass
class CapStats:
    """`④` 的有损账本：只由 harness 之外的观察者读，不参与三个数。"""
    calls_capped: int = 0
    dropped_lines: int = 0
    truncated_lines: int = 0


def tail_cap(text, row, stats=None):
    """头 50 / 尾 200 / 总 300 行 / 单行 2000 字符。

    单行截断把标记也算进 2000 字符预算，于是产出恰好 <= 2000，第二遍不再触发；
    行封顶第一步先做截断，产出 <= 251 行（50 + 省略行 + 200），第二遍也不再触发。
    两条合起来让 `④` 同样幂等（验收只要求无损三条，这里顺带成立）。
    """
    lines = text.split("\n")
    truncated = 0
    if any(len(line) > MAX_LINE_CHARS for line in lines):
        fixed = []
        for line in lines:
            if len(line) > MAX_LINE_CHARS:
                mark = "…[单行截断 +%d]" % (len(line) - MAX_LINE_CHARS)
                fixed.append(line[:MAX_LINE_CHARS - len(mark)] + mark)
                truncated += 1
            else:
                fixed.append(line)
        lines = fixed
    dropped = 0
    if len(lines) > MAX_LINES:
        dropped = len(lines) - (HEAD_LINES + TAIL_LINES)
        lines = (lines[:HEAD_LINES]
                 + ["…[省略 %d 行]" % dropped]
                 + lines[-TAIL_LINES:])
    if not dropped and not truncated:
        return Outcome(text)
    if stats is not None:
        stats.calls_capped += 1
        stats.dropped_lines += dropped
        stats.truncated_lines += truncated
    return Outcome("\n".join(lines))


PURE.update({
    NAME_ANSI: strip_ansi,
    NAME_CR: strip_cr,
    NAME_DEDUP: dedup_adjacent,
    NAME_CAP: tail_cap,
})
ORDER = [NAME_ANSI, NAME_CR, NAME_DEDUP, NAME_CAP]


def cap_closure(stats):
    def apply(text, row):
        return tail_cap(text, row, stats)
    return apply


def build(stats):
    return [
        Transform(NAME_ANSI, ("*",), False, strip_ansi),
        Transform(NAME_CR, ("*",), False, strip_cr),
        Transform(NAME_DEDUP, ("*",), False, dedup_adjacent),
        Transform(NAME_CAP, ("*",), True, cap_closure(stats)),
    ]


def run_one(label, transforms, out_dir, max_calls):
    rep = measure_chain(label, transforms, out_dir=out_dir, max_calls=max_calls)
    print("命中（文字被改写）=%d   守卫放弃=%d   零改动=%d"
          % (rep.targeted - rep.unchanged - rep.abstained, rep.abstained, rep.unchanged))


def scan(out_dir, max_calls=0):
    """不跑分词器：零命中判据 + 幂等断言。"""
    changed = {n: 0 for n in ORDER}
    below = {n: 0 for n in ORDER}
    chain_changed = 0
    totals = {"calls": 0, "with_text": 0, "below_floor": 0}
    checked = 0
    mismatches = []
    cap = CapStats()

    def chain(text, row, stats):
        for name in ORDER:
            fn = PURE[name]
            text = (tail_cap(text, row, stats) if name == NAME_CAP else fn(text, row)).text
        return text

    for row in iter_rows(out_dir):
        totals["calls"] += 1
        text = row.get("text") or ""
        if not text:
            continue
        totals["with_text"] += 1
        low = estimate_units(text) < FLOOR_UNITS
        if low:
            totals["below_floor"] += 1
        checked += 1
        for name in ORDER:
            fn = PURE[name]
            once = fn(text, row).text
            if once != text:
                changed[name] += 1
                if low:
                    below[name] += 1
            twice = fn(once, row).text
            if twice != once:
                mismatches.append((name, row.get("callId")))
        c1 = chain(text, row, cap)
        c2 = chain(c1, row, None)
        if c1 != text:
            chain_changed += 1
        if c2 != c1:
            mismatches.append((CHAIN, row.get("callId")))
        if max_calls and checked >= max_calls:
            break

    print("\n=== 零命中排查（全部调用，含低于尺寸下限 %d 单位的）===" % FLOOR_UNITS)
    print("调用=%d  有正文=%d  低于下限=%d"
          % (totals["calls"], totals["with_text"], totals["below_floor"]))
    print("%-20s %12s %12s" % ("变换", "改动过", "其中低于下限"))
    for name in ORDER:
        print("%-20s %12d %12d" % (name, changed[name], below[name]))
    print("%-20s %12d" % (CHAIN, chain_changed))
    print("\n=== 幂等断言（f(f(x)) == f(x)，逐调用）===")
    print("检查调用=%d  违反=%d" % (checked, len(mismatches)))
    if mismatches:
        for name, call in mismatches[:5]:
            print("  违反：%s @ %s" % (name, call))
    assert not mismatches, "幂等断言失败：%d 处" % len(mismatches)
    print("断言通过：四条变换与整链在本语料上逐调用幂等")
    print("整链口径下 ④ 丢弃行数=%d  单行截断数=%d  发生封顶的调用=%d"
          % (cap.dropped_lines, cap.truncated_lines, cap.calls_capped))
    return changed


def triggered_caliber(out_dir, max_calls=0):
    """只算被替换的那批调用的省幅（harness 的那两个比值恒等，读不出这一条）。"""
    enc = tiktoken.get_encoding("o200k_base")
    agg = {n: {"before": 0, "after": 0, "n": 0} for n in ORDER + ["chain"]}

    def chain_text(source):
        text = source
        for name in ORDER:
            text = (tail_cap(text, None) if name == NAME_CAP else PURE[name](text, None)).text
        return text

    def composed_for(label, source):
        out = chain_text(source) if label == "chain" else PURE[label](source, None).text
        if out == source:
            return None
        composed = (out + fallback_notice(len(source))
                    if label in (NAME_CAP, "chain") else out)
        if estimate_units(source) - estimate_units(composed) < MIN_NET_GAIN_UNITS:
            return None
        return composed

    seen = 0
    for row in iter_rows(out_dir):
        source = row.get("text") or ""
        if not source:
            continue
        seen += 1
        if max_calls and seen > max_calls:
            break
        if estimate_units(source) < FLOOR_UNITS:
            continue
        before_tok = None
        for label in ORDER + ["chain"]:
            composed = composed_for(label, source)
            if composed is None:
                continue
            if before_tok is None:
                before_tok = len(enc.encode_ordinary(source))
            agg[label]["before"] += before_tok
            agg[label]["after"] += len(enc.encode_ordinary(composed))
            agg[label]["n"] += 1

    print("\n=== 触发口径省幅（只算真正被替换的调用，口径同上，补 harness 读不出的那一个）===")
    print("%-20s %10s %14s %14s %10s" % ("变换", "触发数", "Σbefore", "Σafter", "省幅"))
    for label in ORDER + ["chain"]:
        a = agg[label]
        ratio = (a["before"] - a["after"]) / a["before"] if a["before"] else 0.0
        print("%-20s %10d %14d %14d %9.1f%%"
              % (label, a["n"], a["before"], a["after"], 100 * ratio))
    return agg


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="/tmp/dsh-condense")
    ap.add_argument("--run", default="",
                    help="all | %s | chain" % " | ".join(ORDER))
    ap.add_argument("--scan", action="store_true")
    ap.add_argument("--triggered", action="store_true")
    ap.add_argument("--max-calls", type=int, default=0)
    args = ap.parse_args()

    if not args.run and not args.scan and not args.triggered:
        args.run = "all"

    if args.run:
        want = ORDER + ["chain"] if args.run == "all" else (
            ["chain"] if args.run == "chain" else [args.run])
        for key in want:
            stats = CapStats()
            four = build(stats)
            if key == "chain":
                label, trs = CHAIN, four
            else:
                label, trs = key, [t for t in four if t.name == key]
                if not trs:
                    print("unknown transform: %s" % key, file=sys.stderr)
                    return 2
            run_one(label, trs, args.out, args.max_calls)
            if key in (NAME_CAP, "chain"):
                print("④ 丢弃行数=%d  单行截断数=%d  发生封顶的调用=%d"
                      % (stats.dropped_lines, stats.truncated_lines, stats.calls_capped))

    if args.scan:
        scan(args.out, args.max_calls)
    if args.triggered:
        triggered_caliber(args.out, args.max_calls)
    return 0


if __name__ == "__main__":
    sys.exit(main())
