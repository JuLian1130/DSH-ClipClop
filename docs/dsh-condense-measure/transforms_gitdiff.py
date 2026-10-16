#!/usr/bin/env python3
"""`git diff` / `git show` 的 `compact_diff` 测量原型（票 14 / task-2）。

形态与参数照计划 §4.4 第 1 行，其规格出处是调研 §4.1.6 / §5.3 #18（RTK
`src/cmds/git/git_cmd.rs` 的 `compact_diff(input, 200)`）；忠实性守卫照计划 §4.1 #7
（「任何一行解析失败 → 整个变换放弃、原样返回」）。三个数由 `harness.py` 出，本模块
只提供变换与规则，不改 harness。

跑法（在仓库根目录）：

    python3 docs/dsh-condense-measure/transforms_gitdiff.py --what guarded
    python3 docs/dsh-condense-measure/transforms_gitdiff.py --what noguard
    python3 docs/dsh-condense-measure/transforms_gitdiff.py --what surveybc
    python3 docs/dsh-condense-measure/transforms_gitdiff.py --what decompose

`--what guarded` 是被测候选（严格守卫），后两个是**诊断**口径，用来把「和调研 36.0%
对不上」的差额拆到语料 / 口径 / 实现上去。`--what decompose` 不跑 harness，用同一把
o200k 尺子把 git 族子集逐条拆开（规则归属、守卫原因分布、各变体省幅）。
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from harness import (DEFAULT_OUT, Outcome, Rule, estimate_units,  # noqa: E402
                     fallback_notice, measure_dispatch)

MAX_LINES = 200            # 计划 §4.4 第 1 行 / 调研 §4.1.6：compact_diff(input, 200)
MAX_HUNK_LINES = 100
MAX_LEADING_CONTEXT = 3

# --- 调研 §3.2 的策略 B+C 参数（诊断用，不是本 handler 的形态）-------------------
BC_CHANGED_CAP = 150
BC_HEAD = 60
BC_TAIL = 30

ABSTAIN_REASONS = collections.Counter()
UNEXPECTED = collections.Counter()


# =====================================================================
# 1. 命令族规则：脚手架剥离 + 按首个实质命令取 git 子命令
# =====================================================================
_SEG = re.compile(r"&&|\|\||;|\n")
# `cd X && echo "=== 标题 ===" && 真命令 | head`（调研 §3.4：5,278/5,334）——脚手架与
# 标题横幅都不带语义，`echo`/`printf` 之后才是真命令。
_SCAFFOLD = re.compile(r"^(?:cd|pushd|popd|export|set|source|\.|time|env|umask|ulimit)\b")
_BANNER = re.compile(r"^(?:echo|printf)\b")
_GIT_FLAG_WITH_ARG = {"-C", "-c", "--git-dir", "--work-tree", "--namespace",
                      "--exec-path", "--config-env"}


def git_subcommand(cmd: str, skip_banners: bool = True):
    """首个实质命令的 git 子命令名（`diff` / `show`），不是 git 命令则 None。

    先按 `&&` / `||` / `;` / `|` / 换行切段，跳过脚手架段；`skip_banners` 时标题横幅
    段也跳过。管道右侧（`| head`）不参与判定：左侧才是产出正文的命令。
    """
    for seg in _SEG.split(cmd or ""):
        s = seg.strip()
        if not s or _SCAFFOLD.match(s):
            continue
        if skip_banners and _BANNER.match(s):
            continue
        if not (s == "git" or s.startswith("git ") or s.startswith("git\t")):
            return None
        toks = s.split()[1:]
        i = 0
        while i < len(toks):
            if not toks[i].startswith("-"):
                return toks[i]
            i += 2 if toks[i] in _GIT_FLAG_WITH_ARG else 1
        return None
    return None


def matches_git_family(row) -> bool:
    return git_subcommand(row.get("command") or "") in ("diff", "show")


def matches_git_diff(row) -> bool:
    return git_subcommand(row.get("command") or "") == "diff"


def matches_git_show(row) -> bool:
    return git_subcommand(row.get("command") or "") == "show"


# =====================================================================
# 2. compact_diff：RTK `git_cmd.rs:1343` 的移植 + 严格守卫
# =====================================================================
class _Abstain(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class _Hunk:
    """RTK `HunkHeader`：`parents` 按标记列顺序，`new` 是结果文件侧的行数。"""

    __slots__ = ("parents", "new", "width")

    def __init__(self, parents, new, width):
        self.parents = parents
        self.new = new
        self.width = width

    def exhausted(self) -> bool:
        return self.new == 0 and all(p == 0 for p in self.parents)

    def consume(self, markers: bytes) -> None:
        is_add = b"+" in markers
        is_del = b"-" in markers
        for i, remaining in enumerate(self.parents):
            column = markers[i] if i < len(markers) else None
            if is_del:
                present = column == 0x2D      # b'-'
            else:
                present = column != 0x2B      # b'+'；短于前缀的行读作 context
            if present:
                self.parents[i] = max(remaining - 1, 0)
        if is_add or not is_del:
            self.new = max(self.new - 1, 0)


def parse_hunk_header(line: str):
    """`@@ -a,b +c,d @@` 与 `@@@ -a,b -c,d +e,f @@@`（RTK 同名函数）。"""
    at_run = len(line) - len(line.lstrip("@"))
    if at_run < 2:
        return None
    body = line[at_run:].split("@")[0]
    parents: list = []
    new = None
    for group in body.split():
        if not group or group[0] not in "-+":
            continue
        rest = group[1:]
        if "," in rest:
            _, c = rest.split(",", 1)
            if not c.isdigit():
                return None
            count = int(c)
        else:
            count = 1
        if group[0] == "-":
            parents.append(count)
        else:
            new = count
    width = at_run - 1
    if len(parents) != width:
        # 与 RTK 一致：列数说了算；缺的 parent 记为「永不耗尽」。
        parents = parents[:width] + [sys.maxsize] * max(width - len(parents), 0)
    return _Hunk(parents, new if new is not None else 0, width)


# 文件级元信息行：是合法 diff 结构，但不是 hunk 内容，照 RTK 丢弃。
_META_PREFIXES = ("index ", "new file mode ", "deleted file mode ", "old mode ",
                  "new mode ", "similarity index ", "dissimilarity index ",
                  "rename from ", "rename to ", "copy from ", "copy to ",
                  "Binary files ", "GIT binary patch", "literal ", "delta ")


def _is_file_meta(line: str) -> bool:
    if line == "---" or line == "+++":
        return True
    if line.startswith("--- ") or line.startswith("+++ "):
        return True
    return any(line.startswith(p) for p in _META_PREFIXES)


def diff_header_path(line: str) -> str:
    """`diff --git a/x b/x` → `x`（RTK `diff_header_path` 的简化版，引号不解码）。"""
    parts = line.split(" ", 2)
    if len(parts) < 3:
        return "unknown"
    rest = parts[2]
    if not line.startswith("diff --git "):
        return rest
    if " b/" in rest:
        dst = rest.rsplit(" b/", 1)[1]
        return dst[:-1] if dst.endswith('"') else dst
    return rest


def _truncation_note(deletions: int, additions: int):
    def count(n, noun):
        return "%d %s%s" % (n, noun, "" if n == 1 else "s")
    if not deletions and not additions:
        return None
    if not deletions:
        return "  ... (%s truncated)" % count(additions, "addition")
    if not additions:
        return "  ... (%s truncated)" % count(deletions, "deletion")
    return "  ... (%s, %s truncated)" % (count(deletions, "deletion"),
                                         count(additions, "addition"))


def compact_diff(text: str, max_lines: int = MAX_LINES, guard: bool = True):
    """返回 `(out, reason)`；`reason` 为 None 表示产出可用，否则是守卫放弃的原因。

    `guard=True` 时任何一行解析失败都放弃整次（计划 §4.1 #7）；`guard=False` 是
    RTK 原始行为（未识别的行静默忽略），只用作口径诊断。
    """
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    result: list = []
    current_file = ""
    added = removed = 0
    hunk = None
    hunk_shown = 0
    skipped_add = skipped_del = 0
    leading: list = []
    leading_total = 0
    leading_cap = max_lines // 10
    was_truncated = False
    saw_any_hunk = False
    broke = False

    def flush_leading():
        nonlocal leading_total
        room = max(leading_cap - leading_total, 0)
        keep = min(len(leading), room)
        result.extend(leading[len(leading) - keep:])
        leading.clear()
        leading_total += keep

    def close_hunk(reason_if_open: str):
        nonlocal hunk
        if hunk is not None and not hunk.exhausted() and guard:
            raise _Abstain(reason_if_open)
        hunk = None

    for line in lines:
        if line.endswith("\r"):
            line = line[:-1]

        if line.startswith("diff --"):
            flush_leading()
            close_hunk("hunk-unterminated-before-file-header")
            note = _truncation_note(skipped_del, skipped_add)
            if note:
                result.append(note)
                was_truncated = True
                skipped_del = skipped_add = 0
            if current_file and (added or removed):
                result.append("  +%d -%d" % (added, removed))
            current_file = diff_header_path(line)
            result.append("\n" + current_file)
            added = removed = 0
            hunk = None
            hunk_shown = 0
        else:
            header = parse_hunk_header(line)
            if header is not None:
                flush_leading()
                close_hunk("hunk-unterminated-before-next-hunk")
                note = _truncation_note(skipped_del, skipped_add)
                if note:
                    result.append(note)
                    was_truncated = True
                    skipped_del = skipped_add = 0
                hunk = header
                hunk_shown = 0
                saw_any_hunk = True
                result.append(line)          # 完整 @@ 头，含尾部函数/符号上下文
            else:
                if hunk is not None and hunk.exhausted():
                    hunk = None
                if hunk is not None:
                    if line.startswith("\\"):
                        # `\ No newline at end of file`：注解上一行，不占两侧行数。
                        if guard and len(line) > 1 and not line.startswith("\\ No newline"):
                            raise _Abstain("bad-no-newline-marker")
                        continue
                    raw = line.encode("utf-8", "surrogateescape")
                    width = min(hunk.width, len(raw))
                    markers = raw[:width]
                    if any(m not in b" +-" for m in markers):
                        # 标记列里出现非 ` `/`+`/`-` 字节：不是合法 hunk 行
                        # （`--word-diff` 的无标记正文行也落这里）。
                        raise _Abstain("bad-marker-column")
                    is_add = b"+" in markers
                    is_del = b"-" in markers
                    hunk.consume(markers)
                    if is_add or is_del:
                        if is_add:
                            added += 1
                        if is_del:
                            removed += 1
                        if hunk_shown < MAX_HUNK_LINES:
                            flush_leading()
                            result.append(line)
                            hunk_shown += 1
                        elif is_del:
                            skipped_del += 1
                        else:
                            skipped_add += 1
                        leading.clear()
                    elif hunk_shown > 0:
                        if hunk_shown < MAX_HUNK_LINES:
                            result.append(line)
                            hunk_shown += 1
                    elif leading_total < leading_cap:
                        if len(leading) == MAX_LEADING_CONTEXT:
                            leading.pop(0)
                        leading.append(line)
                    if hunk.exhausted():
                        hunk = None
                        flush_leading()
                else:
                    # hunk 之外的每一行都必须是 diff 结构行，否则整次放弃。
                    if line.strip() == "":
                        pass
                    elif line.startswith("\\ No newline"):
                        # 计划 §4.4 第 1 行明写「跳过 `\ No newline`」：它注解的是上一
                        # 行，而上一行耗尽 hunk 时它就落在 hunk 之外了。
                        pass
                    elif _is_file_meta(line):
                        pass
                    elif not guard:
                        pass
                    elif "@@" not in text:
                        # `--stat` / `--name-only` / `git show <rev>:<path>`：正文压根
                        # 不是 unified diff，第一行就会被下面这条拦下。
                        raise _Abstain("not-a-unified-diff")
                    else:
                        raise _Abstain("stray-line-outside-hunk")

        if len(result) - leading_total >= max_lines:
            result.append("\n... (more changes truncated)")
            was_truncated = True
            broke = True
            break

    if hunk is not None and not broke:
        raise _Abstain("hunk-unterminated-at-eof")
    if not saw_any_hunk and not any(l.startswith("diff --") for l in lines):
        # 不是 unified diff（`--stat` / `--name-only` / `git show <rev>:<path>` 之类）
        if guard:
            raise _Abstain("not-a-unified-diff")

    flush_leading()
    note = _truncation_note(skipped_del, skipped_add)
    if note:
        result.append(note)
        was_truncated = True
    if current_file and (added or removed):
        result.append("  +%d -%d" % (added, removed))
    if was_truncated:
        result.append("[full diff: rtk git diff --no-compact]")
    out = "\n".join(result)
    if out == text:
        return text, None
    return out, None


# =====================================================================
# 3. 诊断变体：守卫关闭版、调研策略 B+C
# =====================================================================
def survey_bc(text: str) -> str:
    """调研 §3.2 的策略 B+C：B 只留 +/- 行、context 折成计数；C 单文件 changed
    >150 时留头 60 尾 30。不是计划要的 compact_diff，只用于口径对照。"""
    if "@@" not in text:
        return text
    blocks: list = []
    cur: list = []
    ctx_run = 0

    def endctx():
        nonlocal ctx_run
        if ctx_run:
            cur.append(("ctx", ctx_run))
            ctx_run = 0

    for line in text.split("\n"):
        if line.startswith("diff --"):
            endctx()
            if cur:
                blocks.append(cur)
            cur = [("hdr", line)]
        elif line.startswith(("index ", "--- ", "+++ ", "new file mode ", "old mode ",
                              "new mode ", "deleted file mode ")):
            endctx()
            cur.append(("hdr", line))
        elif line.startswith("@@"):
            endctx()
            cur.append(("hdr", line))
        elif line.startswith("+") or line.startswith("-") or line.startswith("\\"):
            endctx()
            cur.append(("chg", line))
        else:
            ctx_run += 1
    endctx()
    if cur:
        blocks.append(cur)

    out: list = []
    for blk in blocks:
        chg = [i for i, (k, _) in enumerate(blk) if k == "chg"]
        keep = set(chg)
        elided = 0
        if len(chg) > BC_CHANGED_CAP:
            keep = set(chg[:BC_HEAD]) | set(chg[-BC_TAIL:])
            elided = len(chg) - len(keep)
        dropped = False
        for i, (kind, val) in enumerate(blk):
            if kind == "hdr":
                out.append(val)
            elif kind == "ctx":
                out.append("  … (%d context lines)" % val)
            elif i in keep:
                out.append(val)
            elif not dropped:
                out.append("  … (%d changed lines elided)" % elided)
                dropped = True
    return "\n".join(out)


# =====================================================================
# 4. 交给 harness 的规则
# =====================================================================
def _apply(guard: bool):
    def apply(text, row):
        try:
            out, reason = compact_diff(text, guard=guard)
        except _Abstain as exc:
            ABSTAIN_REASONS[exc.reason] += 1
            return Outcome(text, abstained=True)
        except Exception as exc:            # 真 bug：单独记账，别混进守卫放弃
            UNEXPECTED["%s: %s" % (type(exc).__name__, exc)] += 1
            return Outcome(text, abstained=True)
        if reason is not None:
            ABSTAIN_REASONS[reason] += 1
            return Outcome(text, abstained=True)
        return Outcome(out)
    return apply


def _apply_bc(text, row):
    if "@@" not in text:
        return Outcome(text)
    return Outcome(survey_bc(text))


def _apply_family(guard: bool):
    def apply(text, row):
        if git_subcommand(row.get("command") or "") not in ("diff", "show"):
            return Outcome(text)            # 非 git 族：本规则不介入
        return _apply(guard)(text, row)
    return apply


FAMILY_RULE = Rule("compact-diff", ("bash", "pwsh"), True, _apply_family(True),
                   matches_git_family)
DIFF_RULE = Rule("compact-diff-git-diff", ("bash", "pwsh"), True,
                 _apply_family(True), matches_git_diff)
SHOW_RULE = Rule("compact-diff-git-show", ("bash", "pwsh"), True,
                 _apply_family(True), matches_git_show)
GUARD_OFF_RULE = Rule("compact-diff-noguard", ("bash", "pwsh"), True,
                      _apply_family(False), matches_git_family)
BC_RULE = Rule("survey-B+C", ("bash", "pwsh"), True, _apply_bc, matches_git_family)


def report_reasons(label):
    print("守卫放弃原因（%s）：%s" % (label, dict(ABSTAIN_REASONS.most_common())))
    print("非预期异常（必须为 0，否则本次读数作废）：%s" % dict(UNEXPECTED))


# =====================================================================
# 5. 自有分解口径：git 族子集逐条拆开
# =====================================================================
def decompose(out_dir: str, limit: int = 0):
    """不跑 harness 的逐条拆解：规则归属、守卫原因、各口径省幅。

    与 harness 的差别只有一处：这里把 git 族子集单独拿出来算，分母只有这个子集
    （harness 的 `省幅` 分母是全部过下限的 bash 调用），所以这个读数才是和调研
    §3.2 的 36.0% 同一个口径。
    """
    import tiktoken
    enc = tiktoken.get_encoding("o200k_base")
    stat = collections.Counter()
    reasons = collections.Counter()
    reasons_by_sub = collections.defaultdict(collections.Counter)
    examples = collections.defaultdict(list)
    at = collections.defaultdict(int)          # 与调研 §3.2 同口径的总体：含 `@@` 的 diff
    notice_tok = len(enc.encode_ordinary(fallback_notice(123456)))
    n = 0

    def accumulate(prefix, text, before, try_parse):
        """guard 开/关各记一份：接受样本的 before/after，放弃样本的 before。"""
        try:
            out = try_parse()
        except _Abstain as exc:
            at[prefix + "_abstain_n"] += 1
            at[prefix + "_abstain_before"] += before
            return exc
        at[prefix + "_n"] += 1
        at[prefix + "_before"] += before
        at[prefix + "_after"] += len(enc.encode_ordinary(out))
        if "[full diff: rtk git diff --no-compact]" in out:
            at[prefix + "_cap_n"] += 1
            at[prefix + "_cap_saved"] += before - len(enc.encode_ordinary(out))
        return None

    for fp in sorted(glob.glob(os.path.join(out_dir, "sessions", "*.jsonl"))):
        with open(fp, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                # 不做子串级预筛：`git -C x diff` / `git --no-pager diff` 里没有
                # 连续出现的 "git diff"，预筛会把它们漏掉（首版就漏了 169 次）。
                if '"bash"' not in line or "git" not in line:
                    continue
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                if row.get("name") != "bash":
                    continue
                cmd = row.get("command") or ""
                sub = git_subcommand(cmd)
                if matches_git_diff(row) and matches_git_show(row):
                    stat["两规则同时命中的行"] += 1
                if sub not in ("diff", "show"):
                    if git_subcommand(cmd, skip_banners=False) in ("diff", "show"):
                        stat["横幅/脚手架导致不匹配"] += 1
                    continue
                text = row.get("text") or ""
                if not text:
                    stat["无结果正文"] += 1
                    continue
                n += 1
                stat["git族调用"] += 1
                stat["git-" + sub] += 1
                if estimate_units(text) < 128:
                    stat["低于尺寸下限(不触发)"] += 1
                    continue
                stat["过尺寸下限"] += 1
                before = len(enc.encode_ordinary(text))
                is_diff = "@@" in text
                if is_diff:
                    at["n"] += 1
                    at["chars"] += len(text)
                    at["tok_before"] += before
                exc = None
                if is_diff:
                    exc = accumulate("g", text, before, lambda: compact_diff(text, guard=True)[0])
                    accumulate("ng", text, before, lambda: compact_diff(text, guard=False)[0])
                    at["bc_after"] += len(enc.encode_ordinary(survey_bc(text)))
                else:
                    # 非 diff 的 git 行不参与省幅总体，但守卫放弃仍要计数。
                    try:
                        compact_diff(text, guard=True)
                    except _Abstain as bad:
                        exc = bad
                if exc is not None:
                    reasons[exc.reason] += 1
                    reasons_by_sub[sub][exc.reason] += 1
                    if len(text) >= 49000:
                        stat["正文≥49000字符且守卫放弃"] += 1
                    if len(examples[exc.reason]) < 3:
                        examples[exc.reason].append((row.get("callId"), cmd[:90]))
                elif len(text) >= 49000:
                    # bash 结果正文封顶在 50,000 字符（README 已知边界 1），撞顶的
                    # 那些正是最值得精简的大 diff。
                    stat["正文≥49000字符"] += 1
                if limit and n >= limit:
                    break
        if limit and n >= limit:
            break

    def pct(after, before):
        return 100 * (before - after) / before if before else 0.0

    print("== git 族子集分解：%d 次 bash 调用 ==" % n)
    for k in ("git族调用", "git-diff", "git-show", "过尺寸下限", "低于尺寸下限(不触发)",
              "无结果正文", "横幅/脚手架导致不匹配", "两规则同时命中的行",
              "正文≥49000字符", "正文≥49000字符且守卫放弃"):
        print("  %-24s %d" % (k, stat[k]))
    print("  守卫放弃 %d 次（占过下限的 %.1f%%）：%s"
          % (sum(reasons.values()), 100.0 * sum(reasons.values()) / stat["过尺寸下限"],
             dict(reasons.most_common())))
    for sub, c in sorted(reasons_by_sub.items()):
        print("    git-%s: %s" % (sub, dict(c.most_common())))
    for k, ex in sorted(examples.items()):
        for cid, cmd in ex:
            print("    例[%s] %s | %s" % (k, cid, cmd))

    b = at["tok_before"]
    print("== 与调研 §3.2 同口径的总体：含 `@@` 的 diff %d 次 / %.1fM 字符 / %d o200k tok =="
          % (at["n"], at["chars"] / 1e6, b))
    print("  调研策略 B+C（全口径，无守卫）        省幅 %5.1f%%  (%d→%d)"
          % (pct(at["bc_after"], b), b, at["bc_after"]))
    print("  compact_diff 严格守卫 · 触发口径       省幅 %5.1f%%  (接受 %d 次 %d→%d)"
          % (pct(at["g_after"], at["g_before"]), at["g_n"], at["g_before"], at["g_after"]))
    print("  compact_diff 严格守卫 · 全口径         省幅 %5.1f%%  (放弃 %d 次按零省幅计)"
          % (pct(at["g_after"] + at["g_abstain_before"], b), at["g_abstain_n"]))
    print("  compact_diff 严格守卫 · 触发口径+回退说明 省幅 %5.1f%%  (%d tok/次)"
          % (pct(at["g_after"] + at["g_n"] * notice_tok, at["g_before"]), notice_tok))
    print("  compact_diff 守卫关闭 · 触发口径       省幅 %5.1f%%  (接受 %d 次 %d→%d)"
          % (pct(at["ng_after"], at["ng_before"]), at["ng_n"], at["ng_before"], at["ng_after"]))
    print("  compact_diff 守卫关闭 · 全口径         省幅 %5.1f%%"
          % pct(at["ng_after"] + at["ng_abstain_before"], b))
    print("  其中被 max_lines=%d 整体截断的接受样本：%d 次 / 贡献省幅 %d tok（占接受样本省幅的 %.0f%%）"
          % (MAX_LINES, at["g_cap_n"], at["g_cap_saved"],
             100.0 * at["g_cap_saved"] / max(at["g_before"] - at["g_after"], 1)))


# =====================================================================
# 6. CLI
# =====================================================================
def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--what", default="guarded",
                    choices=("guarded", "noguard", "surveybc", "order", "decompose"))
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--max-calls", type=int, default=0)
    args = ap.parse_args()

    if args.what == "decompose":
        return decompose(args.out, args.max_calls)
    if args.what == "guarded":
        measure_dispatch("git diff/show · compact_diff（严格守卫，被测候选）",
                         [FAMILY_RULE], out_dir=args.out, max_calls=args.max_calls)
        report_reasons("guarded")
    elif args.what == "noguard":
        measure_dispatch("git diff/show · compact_diff（守卫关闭，口径诊断）",
                         [GUARD_OFF_RULE], out_dir=args.out, max_calls=args.max_calls)
        report_reasons("noguard")
    elif args.what == "surveybc":
        measure_dispatch("git diff/show · 调研策略 B+C（口径诊断）",
                         [BC_RULE], out_dir=args.out, max_calls=args.max_calls)
        report_reasons("surveybc")
    elif args.what == "order":
        # 有序规则表 + 首个命中者胜：harness 的 dispatch 分支在规则表长度 >1 且首次
        # 触发时抛 AssertionError（harness.py:196-197），装不下多条规则，所以这里
        # 用两条单规则跑，另在 decompose 里核「同一行是否两条都命中」。
        for label, rule in (("git diff", DIFF_RULE), ("git show", SHOW_RULE)):
            measure_dispatch("单规则：%s" % label, [rule], out_dir=args.out,
                             max_calls=args.max_calls)
        report_reasons("order")


if __name__ == "__main__":
    main()
