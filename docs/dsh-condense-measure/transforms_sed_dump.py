#!/usr/bin/env python3
"""测量用原型：命令族 handler ②「`sed` 大窗口」与 ③「原始转储」。

计划 §4.4 第 2、3 行。两条规则都**按命令分派**（`measure_dispatch`，首个命中者胜），
分派前先做 §4.2 #10 的**脚手架剥离 + 管道拆分**：`cd X && echo "=== 标题 ===" && 真命令 | head`
取首个实质命令，拆 `&&` / `||` / `;` / `|`（引号内的分隔符不算）。

三条读数口径、闸门与下限全部由 `harness.py` 决定（本模块不改它）；`harness` 打出的
`省幅 triggered`（分母只有真正被替换的调用）就是硬判据的口径：

    python3 docs/dsh-condense-measure/transforms_sed_dump.py             # 两个 handler
    python3 docs/dsh-condense-measure/transforms_sed_dump.py --only sed
    python3 docs/dsh-condense-measure/transforms_sed_dump.py --only dump
    python3 docs/dsh-condense-measure/transforms_sed_dump.py --recon     # 脚手架剥离覆盖

硬判据是 `triggered` 口径的省幅 ≥60%（计划 §4.4 与 §7.4）。达不到就写「不发布」，
不放宽阈值、不换口径、不换分母。
"""
import argparse
import re
import sys
from collections import Counter

from harness import Outcome, Rule, measure_dispatch

from extract_calls import iter_rows

# --- §4.2 #10 脚手架剥离 -------------------------------------------------------

# 只为「报进度 / 切目录 / 设变量」而存在的命令：剥掉它们才能看到真正的命令。
SCAFFOLD = {
    "cd", "echo", "printf", "set", "export", "unset", "source", ".",
    "true", ":", "pwd", "pushd", "popd", "ulimit", "umask",
}
ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

_SPLIT = re.compile(r"&&|\|\||[|;\n]")


def split_segments(cmd):
    """按 `&&` / `||` / `|` / `;` / 换行拆段，**引号内不算**（`grep -E 'a|b'` 是一段）。"""
    out, buf, quote = [], [], None
    i = 0
    while i < len(cmd):
        ch = cmd[i]
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in "'\"":
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < len(cmd):
            buf.append(cmd[i:i + 2])
            i += 2
            continue
        m = _SPLIT.match(cmd, i)
        if m:
            out.append("".join(buf))
            buf = []
            i = m.end()
            continue
        buf.append(ch)
        i += 1
    out.append("".join(buf))
    return [s.strip() for s in out if s.strip()]


def _tokens(segment):
    return segment.split()


def _is_scaffold(toks):
    if not toks:
        return True
    if ASSIGN.match(toks[0]):
        return True
    head = toks[0].strip("(){}'\"")
    return head in SCAFFOLD


def first_command(cmd):
    """首个实质命令 → (命令名, 该段原文)。剥脚手架、拆链。"""
    for seg in split_segments(cmd):
        toks = _tokens(seg)
        if toks and not _is_scaffold(toks):
            return toks[0].strip("(){}'\""), seg
    return None, None


# --- handler ②：`sed` 大窗口 ---------------------------------------------------

_RANGE = re.compile(r"(\d+)\s*,\s*(\d+|\$)\s*p")


def sed_window_lines(segment):
    """该 `sed` 实际请求打印的行数；整文件（`$`）按无限大算。非 `-n` 打印窗口返回 None。"""
    if not re.search(r"(^|\s)(-n|--quiet|--silent)(\s|$)", segment):
        return None
    total, unbounded = 0, False
    for m in _RANGE.finditer(segment):
        lo, hi = int(m.group(1)), m.group(2)
        if hi == "$":
            unbounded = True
        elif int(hi) >= lo:
            total += int(hi) - lo + 1
    if unbounded:
        return 10 ** 9
    return total or None


def _keep_head_tail(lines, head, tail, cap_line, what):
    """头 head 行 + 中间省略标记 + 尾 tail 行；超长单行截到 cap_line 字符。"""
    if head + tail >= len(lines):
        return None
    if cap_line:
        cut = [ln if len(ln) <= cap_line else ln[:cap_line] + "…[行已截断]" for ln in lines]
    else:
        cut = lines
    dropped = len(lines) - head - tail
    marker = "…[%s省略 %d 行]…" % (what, dropped)
    return cut[:head] + [marker] + cut[len(cut) - tail:]


def sed_apply(head, tail, min_lines, cap_line):
    def apply(text, row):
        lines = text.splitlines()
        if len(lines) < min_lines:
            return Outcome(text, abstained=True)   # 窗口没兑现：文件更短，或被下游截了
        kept = _keep_head_tail(lines, head, tail, cap_line, "中段")
        if kept is None:
            return Outcome(text, abstained=True)
        return Outcome("\n".join(kept) + ("\n" if text.endswith("\n") else ""))
    return apply


def sed_rule(head=20, tail=20, min_lines=60, cap_line=2000):
    def matches(row):
        name, seg = first_command(row.get("command") or "")
        if name != "sed":
            return False
        window = sed_window_lines(seg)
        return window is not None and window >= 101

    return Rule("sed 大窗口（≥101 行）", ("bash", "pwsh"), True,
                sed_apply(head, tail, min_lines, cap_line), matches)


# --- handler ③：原始转储 `cat` / `ls` / `head` / `tail` / `nl` -------------------

DUMP_NAMES = ("cat", "ls", "head", "tail", "nl")
# glance 的兜底形态：头尾永远显示 + 正则命中「有意思的行」。
INTERESTING = re.compile(
    r"error|exception|traceback|fail|fatal|warn|denied|refused|timeout|not found|✗|✘|✖", re.I)


def dump_apply(head, tail, min_lines, cap_line, hits):
    def apply(text, row):
        lines = text.splitlines()
        if len(lines) < min_lines:
            return Outcome(text, abstained=True)   # 本来就是 glance 尺寸，不值得冒险
        kept = _keep_head_tail(lines, head, tail, cap_line, "中段")
        if kept is None:
            return Outcome(text, abstained=True)
        if hits:
            picked, seen = [], set()
            for i, ln in enumerate(lines):
                if len(picked) >= hits:
                    break
                if i < head or i >= len(lines) - tail:
                    continue
                if INTERESTING.search(ln) and ln not in seen:
                    seen.add(ln)
                    picked.append("%d: %s" % (i + 1, ln))
            if picked:
                kept = kept[:head] + picked + kept[head:]
        return Outcome("\n".join(kept) + ("\n" if text.endswith("\n") else ""))
    return apply


def dump_rules(head=15, tail=15, min_lines=60, cap_line=2000, hits=20):
    """一个命令名一条规则；规则表有序、首个命中者胜（§4.2 #8）。"""
    apply = dump_apply(head, tail, min_lines, cap_line, hits)
    rules = []
    for name in DUMP_NAMES:
        def matches(row, name=name):
            got, _seg = first_command(row.get("command") or "")
            return got == name
        rules.append(Rule("原始转储 %s" % name, ("bash", "pwsh"), True, apply, matches))
    return rules


def all_rules(*, head=None, tail=None, min_lines=None, cap_line=None, hits=None):
    """§4.4 的有序规则表：`sed` 大窗口在前，原始转储在后；缺省值各自取发布参数。"""
    sed_kw = dict(head=20, tail=20, min_lines=60, cap_line=2000)
    dump_kw = dict(head=15, tail=15, min_lines=60, cap_line=2000, hits=20)
    for key, value in (("head", head), ("tail", tail),
                       ("min_lines", min_lines), ("cap_line", cap_line)):
        if value is not None:
            sed_kw[key] = value
            dump_kw[key] = value
    if hits is not None:
        dump_kw["hits"] = hits
    return [sed_rule(**sed_kw)] + dump_rules(**dump_kw)


# --- 脚手架剥离的覆盖面（不经过 harness，纯计数） ------------------------------

def recon(out_dir):
    total = echo_first = echo_seg = naive = stripped = naive_sed = sed_win = 0
    chains = Counter()
    for row in iter_rows(out_dir):
        if row.get("name") not in ("bash", "pwsh"):
            continue
        total += 1
        cmd = row.get("command") or ""
        if cmd.lstrip().startswith("echo"):
            echo_first += 1
        if any(s.startswith("echo") for s in split_segments(cmd)):
            echo_seg += 1
        for op in ("&&", "||", "|", ";"):
            if op in cmd:
                chains[op] += 1
        # 不做脚手架剥离时的「首个实质命令」：整条命令的第一个 token。
        raw = (cmd.split() or [""])[0].strip("(){}'\"")
        if raw in DUMP_NAMES:
            naive += 1
        if raw == "sed" and (sed_window_lines(cmd) or 0) >= 101:
            naive_sed += 1
        name, seg = first_command(cmd)
        if name in DUMP_NAMES:
            stripped += 1
        if name == "sed" and (sed_window_lines(seg) or 0) >= 101:
            sed_win += 1
    print("bash+pwsh 调用数：%d" % total)
    print("以 echo 打头（整条命令第一 token）：%d" % echo_first)
    print("含以 echo 打头的链段：%d" % echo_seg)
    print("含 && / || / | / ; 的调用数：%s" % dict(chains))
    print("原始转储：不剥脚手架命中 %d → 剥脚手架后命中 %d（覆盖 ×%.2f）"
          % (naive, stripped, stripped / naive if naive else 0))
    print("sed 大窗口（≥101 行）：不剥脚手架命中 %d → 剥脚手架后命中 %d（覆盖 ×%.2f）"
          % (naive_sed, sed_win, sed_win / naive_sed if naive_sed else 0))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", choices=("sed", "dump"),
                    help="拆开只跑一个 handler（默认跑 §4.4 的整张有序规则表）")
    ap.add_argument("--out", default="/tmp/dsh-condense")
    ap.add_argument("--recon", action="store_true", help="只打印脚手架剥离的覆盖计数")
    ap.add_argument("--head", type=int, default=None)
    ap.add_argument("--tail", type=int, default=None)
    ap.add_argument("--min-lines", type=int, default=None)
    ap.add_argument("--hits", type=int, default=None, help="转储族保留的「有意思的行」上限")
    args = ap.parse_args()

    if args.recon:
        recon(args.out)
        return
    over = {k: v for k, v in (("head", args.head), ("tail", args.tail),
                              ("min_lines", args.min_lines)) if v is not None}
    if args.only == "sed":
        rules = [sed_rule(**over, cap_line=2000)]
        measure_dispatch("② sed 大窗口（≥101 行）", rules, out_dir=args.out)
    elif args.only == "dump":
        dump_kw = dict(over, cap_line=2000)
        if args.hits is not None:
            dump_kw["hits"] = args.hits
        rules = dump_rules(**dump_kw)
        measure_dispatch("③ 原始转储 cat/ls/head/tail/nl", rules, out_dir=args.out)
    else:
        rules = all_rules(**over, hits=args.hits)
        print("规则表（有序，首个命中者胜）：" + " → ".join(r.name for r in rules))
        measure_dispatch("§4.4 handler 有序规则表：sed 大窗口 + 原始转储", rules, out_dir=args.out)


if __name__ == "__main__":
    sys.exit(main())
