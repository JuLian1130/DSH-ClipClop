#!/usr/bin/env python3
"""票 16 判据 12：拿**发布实现**导出的 JSONL 对账 git diff 族的省幅门槛读数。

判据 12 要两句话：git diff 族在真实语料上的省幅 **triggered 口径 ≥ 25%** 且 **all 口径 ≥ 1%**，
且必须用**发布实现**跑出来的读数、按票 14 `harness.py` 的口径对账。本脚本就是那把对账的尺子：
它不另立口径，直接 import `harness.py`（尺寸下限、净收益闸门、两个省幅各自的分母定义）与
`transforms_gitdiff.py`（原型的族规则 `matches_git_family` 与 `compact_diff`），只补两件事——
**独立数一遍 all 分母**、**逐 callId 把发布实现的导出与原型对上**。

两段交付（同一份脚本，`--stage` 选）：

- **第一段（不依赖 dump）**：用 `estimate_units(text) >= 128`、非空正文、`targets=("bash","pwsh")`
  的 harness 口径独立数一遍 all 分母，核对 `results-gitdiff.md` 记的 **64,976 行 / 57,942,678 tok**；
  再用 `measure_dispatch` + 原型族规则重跑一遍，核对 **triggered=993 / 37.0% / 3.0%**。
  同时把「语料快照没有 exitCode / stdout.truncated 两列」这件事核成实证。
- **第二段（dump 落地后）**：读发布实现的 JSONL，逐 callId 比 `outcome` / `family`，差异按
  平台面（发布只在 bash 求值）/ `git show` 未覆盖 / 入口说明预留口径 / 判据 8 的两处有意差异
  （引号路径还原、无 hunk 文件保真实变化行）/ 守卫差异 / 其它 归类并给样例；再用 dump 算发布
  实现的 triggered / all 省幅，与 993 / 37.0% / 3.0% 对账，差异必须落到**语料**、**口径**还是
  **实现**上；最后给出 `≥25%`（triggered）与 `≥1%`（all）两条门槛的判定。

**dump 的字段口径（第二段据此算，别读错）**：`sha256` / `chars` 描述**族收窄后的正文**，**不含
真实入口说明**；`afterUnits` 是「该正文 + `entryChars` 字符预留」的估算单位（闸门计价用的合成）；
`entryChars` 是预留**上界**（`packages/dsh-result-clipper/src/entry.ts` 的 `ENTRY_RESERVE`，本脚本
从源码读回），**不是**实际写出的说明长度——真实说明含会话相关 locator，离线拿不到。因此省幅按
三条口径给区间：口径 1 = dump 原值（插件估算单位，与闸门同一把尺）；口径 2 = o200k token、说明按
`entryChars` 预留占位（悲观端）；口径 3 = o200k token、说明按 harness 的约 30 字符（与记录的
37.0% 可比，乐观端）。

**两条守卫在本次语料上测不了（第一段第 3 节给出实证，后果写在下面）。** 生产实现有两条
`compact_diff` 原型没有的守卫：`exitCode != 0` 放弃、`stdout.truncated` 放弃。DSH 的 durable
事件**不带工具执行的 `value`**（`packages/core/tools/src/index.ts:575`：canonical value
"deliberately omitted from durable events"），`extract_calls.py` 只从事件里取
content / meta / isError，所以语料快照里既没有 `exitCode`，也没有表示 stdout 被截断的那一列
（`meta` 里的 `truncated` 是别的工具自己的字段，见第一段第 3 节的实测分布）。后果：

> **这份读数等于原型口径，不等价于生产口径。** 两条守卫在语料上恒为「不触发」，于是任何
> 「生产实现比原型多放弃 N 次」都读不出来；dump 的 `exitCode` / `truncated` 恒为 null 正是
> 同一个事实的镜像。要拿到生产口径的读数，必须在**捕获现场**带上这两列（或让语料携带
> `value`），本脚本无法凭空补出来。

尺子（tiktoken 不可用时的降级规则见 `make_ruler`）：报数口径 `o200k_base`，与
`results-gitdiff.md` 同一把尺；闸门口径仍是插件自己的 `estimate_units`（`ceil(chars/4)+4`）。
降级发生时脚本会在报告首行明确写出尺子换了，不算静默替换。

跑法（仓库根目录）：

    # 第一段：all 分母 + 原型读数复现（不需要 dump）
    python3 docs/dsh-condense-measure/verify_dispatch_diff.py --stage 1

    # 第二段：dump 落地后（--dump 缺省 /tmp/dsh-condense-ts/ts-dispatch-diff.jsonl，
    # 环境变量 DSH_CONDENSE_TS_DIFF_DUMP 可覆盖）
    python3 docs/dsh-condense-measure/verify_dispatch_diff.py \
        --out /tmp/dsh-condense --dump /tmp/dsh-condense-ts/ts-dispatch-diff.jsonl

冒烟（小样本，口径与正式读数一致，只是行数少）：

    python3 docs/dsh-condense-measure/verify_dispatch_diff.py --stage 1 --max-calls 3000

只读语料：本脚本不写任何文件，`--out` 指向的语料只读。
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from extract_calls import iter_rows  # noqa: E402
from harness import (FLOOR_UNITS, MIN_NET_GAIN_UNITS, estimate_units,  # noqa: E402
                     fallback_notice, measure_dispatch)
# `_Abstain` 是原型守卫放弃的唯一携带原因的形式（`compact_diff` 成功时恒返回 reason=None，
# 放弃时抛异常），归因「守卫差异」需要它。
from transforms_gitdiff import (FAMILY_RULE, MAX_LINES, _Abstain,  # noqa: E402
                                compact_diff, git_subcommand)

DEFAULT_OUT = "/tmp/dsh-condense"
DEFAULT_DUMP = "/tmp/dsh-condense-ts/ts-dispatch-diff.jsonl"
DUMP_ENV = "DSH_CONDENSE_TS_DIFF_DUMP"

# 仓库根（本文件在 docs/dsh-condense-measure/ 下）；ENTRY_RESERVE 从生产源码读回，不写死。
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENTRY_TS = os.path.join(REPO_ROOT, "packages", "dsh-result-clipper", "src", "entry.ts")

# 命中目标工具：与 harness 的 measure_dispatch 缺省一致。
TARGETS = ("bash", "pwsh")
LABEL = "票 16 判据 12 对账：git diff 族"

# `results-gitdiff.md` §4.1 记下的读数，作为对账基线。
RECORD = {
    "above_floor": 64_976,
    "floor_skipped": 41_523,
    "triggered": 993,
    "abstained": 1_660,
    "unchanged": 62_285,
    "gate_rejected": 38,
    "tokens_before": 57_942_678,
    "tokens_triggered_before": 4_752_981,
    "saving_triggered_pct": 37.0,
    "saving_all_pct": 3.0,
}

# 差异归因；前五类是发布实现**有意**或**已声明**与原型不同（票 16 判据 8 / 平台面 / 覆盖面 /
# 预留口径），按类量、不当 bug 报。优先级即此顺序（第一条命中者胜）。
DIFF_CLASSES = ("platform-pwsh", "show-not-covered", "reserve-caliber", "quoted-path",
                "no-hunk-file", "post-cut", "guard", "other")
DIFF_LABEL = {
    "platform-pwsh": "平台面（发布只在 bash 上求值，原型含 pwsh）",
    "show-not-covered": "`git show` 未覆盖（发布族只覆盖 git diff）",
    "reserve-caliber": "入口说明预留口径（ENTRY_RESERVE 上界 vs harness ≈30 字符说明）",
    "quoted-path": "引号路径还原（判据 8 有意差异）",
    "no-hunk-file": "无 hunk 文件保写法（判据 8 有意差异）",
    "post-cut": "maxLines 截断后的行为差异（发布继续扫完、每文件仍出聚合量；见 src/gitdiff.ts:275-282）",
    "guard": "守卫差异",
    "other": "其它",
}

Entry = collections.namedtuple(
    "Entry", "call_id name command units units_js before_tok proto family body text_len "
             "quoted no_hunk reason text_sha")


def js_len(text):
    """JS 的 `String.length`：UTF-16 码元数（dump 的 `chars` 就是这个口径）。"""
    return len(text.encode("utf-16-le")) // 2


def entry_reserve_chars():
    """从生产源码读回预留上界，避免文档/脚本里再写一份会漂移的常数。"""
    with open(ENTRY_TS, encoding="utf-8") as fh:
        match = re.search(r"ENTRY_RESERVE\s*=\s*(\d+)", fh.read())
    if not match:
        raise SystemExit("找不到 ENTRY_RESERVE 的定义：%s" % ENTRY_TS)
    return int(match.group(1))


def make_ruler():
    """报数尺子：`o200k_base`；tiktoken 不可用时降级为插件的估算单位，并明说换了尺子。"""
    try:
        import tiktoken
        enc = tiktoken.get_encoding("o200k_base")

        def count(text):
            return len(enc.encode_ordinary(text))
    except Exception as exc:  # pragma: no cover - 本机 tiktoken 0.13.0 可用
        print("!! tiktoken 不可用（%s）：降级为 estimate 单位（ceil(chars/4)+4）作尺子。"
              % exc)
        print("!! 尺子已变：以下 token 读数与 results-gitdiff.md 的 o200k 读数**不可直接比较**。")
        return estimate_units
    return count


def classify_prototype(source, family):
    """复刻 harness `_run` 的 dispatch 分支：命中族 → 守卫 → 等值 → 净收益闸门。

    返回 (outcome, body, reason)；outcome 用 dump 的词表
    （family-miss / abstained / unchanged / not-shorter / condensed）。
    注意：本函数只是**复刻** harness 的判定，不是另立口径——下限与闸门都取自 harness。
    """
    if family is None:
        return "family-miss", None, None
    try:
        out, _ = compact_diff(source, MAX_LINES, True)
    except _Abstain as exc:
        return "abstained", None, exc.reason
    if out == source:
        return "unchanged", None, None
    if estimate_units(source) - estimate_units(out + fallback_notice(len(source))) < MIN_NET_GAIN_UNITS:
        return "not-shorter", out, None
    return "condensed", out, None


def corpus_pass(out_dir, max_calls, ruler, want_proto):
    """一次全语料扫描：all 分母（独立复现）+ 守卫列缺失实证（+ 需要时原型逐条判定）。

    行/下限/`max_calls` 的语义逐字对齐 `harness._run`：`max_calls` 数的是**非空且命中目标
    工具**的行，`seen > max_calls` 时停。
    """
    stat = collections.Counter()
    row_keys: set = set()
    meta_keys: set = set()
    meta_truncated = 0
    index = collections.defaultdict(list)
    ordered = []
    seen = 0

    for row in iter_rows(out_dir):
        if row.get("name") not in TARGETS:
            continue
        stat["tool_rows"] += 1
        row_keys.update(row.keys())
        meta = row.get("meta")
        if isinstance(meta, dict):
            meta_keys.update(meta.keys())
            if meta.get("truncated"):
                meta_truncated += 1
        if row.get("isError"):
            stat["is_error"] += 1

        source = row.get("text") or ""
        if not source:
            stat["empty_text"] += 1
            stat["empty_" + str(row.get("name"))] += 1
            continue
        stat["nonempty_" + str(row.get("name"))] += 1
        seen += 1
        if max_calls and seen > max_calls:
            break
        units = estimate_units(source)
        above_floor = units >= FLOOR_UNITS
        if above_floor:
            stat["above_floor"] += 1
            before_tok = ruler(source)
            stat["before_tok"] += before_tok
            stat["before_units"] += units
        else:
            stat["floor_skipped"] += 1
            before_tok = 0
        if not want_proto:
            continue

        command = row.get("command") or ""
        units_js = 4 + -(-js_len(source) // 4)          # dump 的 beforeUnits 是 JS 长度口径
        text_sha = hashlib.sha256(source.encode("utf-8")).hexdigest()
        if not above_floor:
            # 低于下限的行也进索引：dump 是行口径，不索引它们会把 41,523 行误报成「无行可配」。
            entry = Entry(
                call_id=row.get("callId"), name=row.get("name"), command=command, units=units,
                units_js=units_js, before_tok=0, proto="below-floor", family=None, body=None,
                text_len=len(source), quoted=False, no_hunk=False, reason=None, text_sha=text_sha)
        else:
            sub = git_subcommand(command)
            family = sub if sub in ("diff", "show") else None
            proto, body, reason = classify_prototype(source, family)
            entry = Entry(
                call_id=row.get("callId"), name=row.get("name"), command=command, units=units,
                units_js=units_js, before_tok=before_tok, proto=proto, family=family, body=body,
                text_len=len(source),
                # 两个「有意差异」类只对**命中族**的行有意义：非 git 命令里 "@@" 缺席不算「无 hunk 文件」。
                quoted=family is not None and 'diff --git "' in source,
                no_hunk=family is not None and "@@" not in source, reason=reason, text_sha=text_sha)
        index[row.get("callId")].append(entry)
        ordered.append(entry)

    evidence = {"row_keys": sorted(row_keys), "meta_keys": sorted(meta_keys),
                "meta_truncated": meta_truncated}
    return stat, evidence, index, ordered


def cmp_num(label, got, want):
    """一行「读数 vs 记录」的对照，带差值与单位。"""
    if want is None:
        return "  %s = %s" % (label, got)
    return "  %s = %s（记录 %s，差 %+d）" % (label, got, want, got - want)


def stage1(args, stat, evidence):
    print("\n=== 第一段 1. all 分母（独立复现，本脚本自己数；不用 harness 的计数器）===")
    print(cmp_num("过下限的非空 bash/pwsh 调用", stat["above_floor"], RECORD["above_floor"]))
    print(cmp_num("其 o200k token 总和", stat["before_tok"], RECORD["tokens_before"]))
    print(cmp_num("低于下限、一个都不触发", stat["floor_skipped"], RECORD["floor_skipped"]))
    print("  空正文的 bash/pwsh 调用 = %d（harness 的 `if not source: continue` 会先丢掉它们）"
          % stat["empty_text"])
    print("  非空 bash/pwsh 调用 = %d = 过下限 %d + 低于下限 %d"
          % (stat["above_floor"] + stat["floor_skipped"],
             stat["above_floor"], stat["floor_skipped"]))
    print("口径：name ∈ %s、正文非空、estimate_units(text) >= %d、token 尺子 = o200k_base"
          % ("/".join(TARGETS), FLOOR_UNITS))

    print("\n=== 第一段 2. 原型读数重跑（measure_dispatch + 原型族规则 compact-diff）===")
    print("原型族规则 = transforms_gitdiff.FAMILY_RULE（matches_git_family，guard=True）；harness 自报如下：")
    rep = measure_dispatch(LABEL, [FAMILY_RULE], out_dir=args.out, max_calls=args.max_calls)
    print("\n与记录逐项对照：")
    print(cmp_num("targeted", rep.targeted, RECORD["above_floor"]))
    print(cmp_num("triggered", rep.triggered, RECORD["triggered"]))
    print(cmp_num("abstained", rep.abstained, RECORD["abstained"]))
    print(cmp_num("unchanged", rep.unchanged, RECORD["unchanged"]))
    print(cmp_num("gate-rejected", rep.gate_rejected, RECORD["gate_rejected"]))
    print(cmp_num("tokens before", rep.tokens_before, RECORD["tokens_before"]))
    print(cmp_num("triggered 分母 tokens", rep.tokens_before_triggered, RECORD["tokens_triggered_before"]))
    print("  triggered 省幅 = %.1f%%（记录 %.1f%%，差 %+.1fpp）"
          % (100 * rep.saving_triggered, RECORD["saving_triggered_pct"],
             100 * rep.saving_triggered - RECORD["saving_triggered_pct"]))
    print("  all 省幅 = %.1f%%（记录 %.1f%%，差 %+.1fpp）"
          % (100 * rep.saving_all, RECORD["saving_all_pct"],
             100 * rep.saving_all - RECORD["saving_all_pct"]))
    print("第一段交叉验证：本脚本独立数的过下限行数/Σtoken 与 harness 自报一致 = %s"
          % (stat["above_floor"] == rep.targeted and stat["before_tok"] == rep.tokens_before))

    print("\n=== 第一段 3. 守卫事实缺失（exitCode / stdout.truncated）===")
    print("语料行字段（bash/pwsh 全体）= %s" % ", ".join(evidence["row_keys"]))
    print("  有 exitCode 字段 = %s   有 truncated 字段 = %s"
          % ("exitCode" in evidence["row_keys"], "truncated" in evidence["row_keys"]))
    print("bash/pwsh 行出现过的 meta 键 = %s" % ", ".join(evidence["meta_keys"]))
    print("  其中 meta.truncated 为真的 bash/pwsh 行 = %d（该键不是 stdout 截断：它是别的工具"
          "自己的结果字段，bash 的 meta 只有 cwd）" % evidence["meta_truncated"])
    print("  isError 为真的 bash/pwsh 行 = %d（布尔，不是 exitCode；也无法区分退出码）"
          % stat["is_error"])
    print("结论：生产实现的两条守卫（exitCode != 0、stdout.truncated）在本语料上**无法触发**，"
          "dump 的 exitCode / truncated 恒为 null。")
    print("      因此这份读数 = **原型口径**，**不等价于生产口径**；任何「生产比原型多放弃」"
          "都读不出来。")


def load_dump(path):
    rows = []
    dup = 0
    seen = set()
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if row.get("callId") in seen:
                dup += 1
            seen.add(row.get("callId"))
            rows.append(row)
    return rows, dup


CUT_MARKER = "[full diff: rtk git diff --no-compact]"


def hit_cut(body):
    """原型正文是否撞上 `maxLines` 整体截断。"""
    return bool(body) and CUT_MARKER in body


def classify_diff(entry, dump_row):
    """差异归因，按优先级取第一条命中（顺序即 DIFF_CLASSES）；已声明的差异不作 bug 报。"""
    dump_hit = dump_row.get("family") is not None
    if entry.name != "bash" and not dump_hit:
        return "platform-pwsh"
    if entry.family == "show" and not dump_hit:
        return "show-not-covered"
    if entry.proto == "condensed" and dump_row.get("outcome") == "not-shorter":
        return "reserve-caliber"
    if entry.quoted:
        return "quoted-path"
    if entry.no_hunk:
        return "no-hunk-file"
    if hit_cut(entry.body):
        return "post-cut"
    if entry.proto == "abstained" or dump_row.get("outcome") == "abstained":
        return "guard"
    return "other"


def pair_rows(dump, index, ordered):
    """配对：dump 与语料的非空目标行**逐位对齐**（已实测两侧次序一致，见报告第二段 0），
    退路才是按 callId + command + beforeUnits 逐条消耗。

    语料同一 callId 会随会话快照重复出现，dump 也是行口径；不消耗条目就会把同一语料行
    配给多行 dump，凭空造出差异。
    """
    if len(dump) == len(ordered) and all(d.get("callId") == e.call_id
                                         for d, e in zip(dump, ordered)):
        return ({id(d): e for d, e in zip(dump, ordered)}, [], 0, len(dump), [], "positional")
    pool = {cid: list(entries) for cid, entries in index.items()}
    pair, unmatched, ambiguous, exact = {}, [], 0, 0
    for row in dump:
        entries = pool.get(row.get("callId"))
        if not entries:
            unmatched.append(row)
            continue
        command = row.get("command") or ""
        units = int(row.get("beforeUnits") or 0)
        hit = [e for e in entries if e.command == command and e.units == units]
        if not hit:
            hit = [e for e in entries if e.command == command]
        if not hit:
            hit = entries
        if len(hit) > 1:
            ambiguous += 1
        chosen = hit[0]
        if chosen.command == command and chosen.units == units:
            exact += 1
        pair[id(row)] = chosen
        entries.remove(chosen)
        if not entries:
            pool.pop(row.get("callId"), None)
    leftover = [e for entries in pool.values() for e in entries]
    return pair, unmatched, ambiguous, exact, leftover, "callId"




def pct(saved, before):
    return 100.0 * saved / before if before else 0.0


def fmt_pct(value):
    """百分比读数；None 表示**没有读数**（该口径下一行都重建不出来），不写成 0%。"""
    return "无法计算（无可重建正文的行）" if value is None else "%.1f%%" % value


def verdict(reading, threshold):
    if reading is None:
        return "无法判定"
    return "通过" if reading >= threshold else "未通过"


def stage2(dump_path, dump, dup, stat, index, ordered, ruler):
    reserve = entry_reserve_chars()
    pair, unmatched, ambiguous, exact, leftover, mode = pair_rows(dump, index, ordered)
    outcomes = collections.Counter(r.get("outcome") for r in dump)
    families = collections.Counter(str(r.get("family")) for r in dump)

    print("\n=== 第二段 0. dump 完整性（%s）===" % dump_path)
    print("行数 = %d（重复 callId %d）   不同 callId = %d   name 分布 = %s"
          % (len(dump), dup, len({r.get("callId") for r in dump}),
             dict(collections.Counter(r.get("name") for r in dump).most_common())))
    print("语料非空行 = %s   空正文 = %s"
          % ({k[9:]: v for k, v in stat.items() if k.startswith("nonempty_")},
             {k[6:]: v for k, v in stat.items() if k.startswith("empty_") and k != "empty_text"}))
    print("outcome 分布 = %s" % dict(outcomes.most_common()))
    print("family 取值 = %s" % dict(families.most_common()))
    print("配到语料行 = %d（配对方式 = %s；逐位对齐 %d）" % (len(pair), mode, exact))
    py_match = js_match = 0
    for row in dump:
        entry = pair.get(id(row))
        if entry is None:
            continue
        before_units = int(row.get("beforeUnits") or 0)
        py_match += before_units == entry.units
        js_match += before_units == entry.units_js
    print("  beforeUnits 口径：等于 Python 码点版 estimate_units %d 行、等于 JS UTF-16 版 %d 行"
          "（两者不同 %d 行 → dump 用 JS 的 String.length）" % (py_match, js_match, js_match - py_match))
    seen_sha = {}
    dup_diff = 0
    for entry in ordered:
        prev = seen_sha.setdefault(entry.call_id, entry.text_sha)
        if prev != entry.text_sha:
            dup_diff += 1
    print("  同 callId 重复行的正文哈希不同 = %d（0 = 重复行正文完全相同，配对无歧义）" % dup_diff)
    print("dump 行没有语料行可配 = %d（其中 outcome=below-floor %d、name 分布 %s）"
          % (len(unmatched), sum(1 for r in unmatched if r.get("outcome") == "below-floor"),
             dict(collections.Counter(r.get("name") for r in unmatched).most_common(5))))
    print("语料目标行在 dump 里没有 = %d：name 分布 %s；其中原型族命中 %d"
          % (len(leftover), dict(collections.Counter(e.name for e in leftover).most_common()),
             sum(1 for e in leftover if e.family is not None)))
    print("  ↑ 平台面：发布实现只在 bash 上求值。语料里 pwsh 行 = %d（非空 %d / 空 %d）"
          "→ 平台面差异在本语料上**无样本、无法核实**（不代表它不存在；dump 的 name 分布也全是 bash）"
          % (stat["nonempty_pwsh"] + stat["empty_pwsh"], stat["nonempty_pwsh"], stat["empty_pwsh"]))

    print("\n=== 第二段 1. 逐 callId：发布实现 vs 原型（outcome / 族归属）===")
    comparable = agree = below_floor_agree = 0
    diffs = collections.Counter()
    diff_samples = collections.defaultdict(list)
    guard_reasons = collections.Counter()
    guard_props = collections.Counter()
    family_only = []
    for row in dump:
        entry = pair.get(id(row))
        if entry is None:
            continue
        if row.get("outcome") == "below-floor" or entry.proto == "below-floor":
            # 尺寸下限两侧一致就不是差异；只有两侧判定不同才说明正文/尺子不同。
            if row.get("outcome") == entry.proto:
                below_floor_agree += 1
            else:
                diffs["other"] += 1
                if len(diff_samples["other"]) < 5:
                    diff_samples["other"].append("%s（原型 %s / dump %s）"
                                                 % (row.get("callId"), entry.proto,
                                                    row.get("outcome")))
            continue
        comparable += 1
        dump_hit = row.get("family") is not None
        if row.get("outcome") == entry.proto and dump_hit == (entry.family is not None):
            agree += 1
            continue
        if row.get("outcome") != entry.proto:
            cls = classify_diff(entry, row)
            diffs[cls] += 1
            if entry.proto == "abstained":
                guard_reasons[entry.reason] += 1
            if cls == "guard":
                guard_props["正文 >= 50000 字符（bash 截断上限附近）"] += entry.text_len >= 50000
                guard_props["原型正文撞 max_lines 整体截断"] += bool(
                    entry.body and "[full diff: rtk git diff --no-compact]" in entry.body)
                guard_props["原型正文含 \\ No newline"] += bool(
                    entry.body and r"\ No newline" in entry.body)
            if len(diff_samples[cls]) < 5:
                diff_samples[cls].append("%s（原型 %s / dump %s）"
                                         % (row.get("callId"), entry.proto, row.get("outcome")))
        else:
            family_only.append("%s（原型族 %s / dump 族 %s）"
                               % (row.get("callId"), entry.family, row.get("family")))
    print("低于下限、两侧一致 = %d 行（不计入可比行）；可比 dump 行（过下限）= %d   "
          "outcome 与族归属都一致 = %d" % (below_floor_agree, comparable, agree))
    print("差异归因（优先级：平台面 → git show → 预留口径 → 引号路径 → 无 hunk → 守卫 → 其它）：")
    for cls in DIFF_CLASSES:
        print("  %s = %d%s" % (DIFF_LABEL[cls], diffs[cls],
                               ("；样例 " + " | ".join(diff_samples[cls])) if diff_samples[cls] else ""))
    print("  原型放弃原因分布（守卫类）= %s" % dict(guard_reasons.most_common()))
    print("  守卫差异行的属性（%d 行，用于判断是否落在截断路径上）：%s"
          % (diffs["guard"], dict(guard_props)))
    print("仅族归属不一致（outcome 一致）= %d%s"
          % (len(family_only), ("；样例 " + " | ".join(family_only[:5])) if family_only else ""))

    print("\n=== 第二段 1b. 族收窄后正文的字段口径（sha256 / chars / afterUnits）===")
    both = sha_match = chars_match = longer = shorter = 0
    body_cls = collections.Counter()
    body_samples = collections.defaultdict(list)
    au_body = au_reserve = au_notice = 0
    deltas = collections.Counter()
    capped = collections.Counter()
    for row in dump:
        entry = pair.get(id(row))
        if entry is None or row.get("outcome") != "condensed" or entry.body is None:
            continue
        both += 1
        body = entry.body
        if row.get("sha256") == _sha256(body):
            sha_match += 1
        else:
            cls = ("quoted-path" if entry.quoted else
                   "no-hunk-file" if entry.no_hunk else
                   "post-cut-body" if hit_cut(entry.body) else "other-body")
            body_cls[cls] += 1
            if len(body_samples[cls]) < 5:
                body_samples[cls].append(row.get("callId"))
        chars = int(row.get("chars") or 0)
        length = js_len(body)
        if chars == length:
            chars_match += 1
        elif chars > length:
            longer += 1
        else:
            shorter += 1
        deltas[chars - length] += 1
        # 原型正文是否撞上 max_lines 整体截断：用来判断正文差异是否集中在截断路径上。
        capped[("[full diff: rtk git diff --no-compact]" in body, chars == length)] += 1
        after_units = int(row.get("afterUnits") or 0)
        if after_units == estimate_units(body):
            au_body += 1
        if after_units == estimate_units(body + "x" * reserve):
            au_reserve += 1
        if after_units == estimate_units(body + fallback_notice(entry.text_len)):
            au_notice += 1
    print("dump 里 condensed 且原型也能重建正文的行 = %d（dump 的 %d 行里）"
          % (both, outcomes["condensed"]))
    print("  sha256 与原型正文一致 = %d；不一致 = %d（归因：引号路径 %d / 无 hunk 文件 %d / "
          "maxLines 截断后行为 %d / 其它 %d）"
          % (sha_match, both - sha_match, body_cls["quoted-path"], body_cls["no-hunk-file"],
             body_cls["post-cut-body"], body_cls["other-body"]))
    for cls in ("quoted-path", "no-hunk-file", "post-cut-body", "other-body"):
        if body_samples[cls]:
            print("    %s 样例：%s" % (cls, " | ".join(body_samples[cls])))
    print("  chars 与原型正文的 JS 长度：相等 %d / 发布更长 %d / 发布更短 %d（判据 8 保真实变化行"
          "会让发布输出更长）" % (chars_match, longer, shorter))
    print("  长度差 Δ=chars−原型 JS 长度 的分布（前 8）：%s"
          % dict(deltas.most_common(8)))
    print("  按「原型正文是否撞 max_lines 整体截断」拆：截断行 = %d（其中长度相等 %d / 不等 %d）、"
          "未截断行 = %d（其中相等 %d / 不等 %d）"
          % (capped[(True, True)] + capped[(True, False)], capped[(True, True)], capped[(True, False)],
             capped[(False, True)] + capped[(False, False)], capped[(False, True)], capped[(False, False)]))
    print("  afterUnits 口径：等于 estimate(正文) %d 行；等于 estimate(正文 + %d 字符预留) %d 行；"
          "等于 estimate(正文 + harness ≈30 字符说明) %d 行"
          % (au_body, reserve, au_reserve, au_notice))
    print("  说明：dump 的 sha256 / chars 是**族收窄后的正文**，**不含真实入口说明**；entryChars=%d "
          "是闸门计价用的预留**上界**，不是实际写出的说明长度（真实说明含会话相关 locator，离线拿不到）。"
          % reserve)

    hit_rows = [r for r in dump if r.get("family") is not None and id(r) in pair]
    print("\n=== 第二段 1c. 入口说明预留口径单独量化（发布族命中 %d 行）===" % len(hit_rows))
    pred = collections.Counter()
    impl_only = []
    harness_condensed = 0
    for row in hit_rows:
        entry = pair[id(row)]
        if entry.body is None:
            pred["abstained" if entry.proto == "abstained" else "unknown"] += 1
            continue
        if entry.units - estimate_units(entry.body + "x" * reserve) >= MIN_NET_GAIN_UNITS:
            pred["condensed"] += 1
            if row.get("outcome") != "condensed":
                impl_only.append("%s（原型 %s / dump %s）"
                                 % (row.get("callId"), entry.proto, row.get("outcome")))
        else:
            pred["not-shorter"] += 1
        if entry.proto == "condensed":
            harness_condensed += 1
    print("  原型（after 侧 = harness ≈30 字符说明）判 condensed = %d" % harness_condensed)
    print("  把 after 侧换成 ENTRY_RESERVE=%d 字符后预测：condensed=%d / not-shorter=%d / "
          "abstained=%d / unknown=%d"
          % (reserve, pred["condensed"], pred["not-shorter"], pred["abstained"], pred["unknown"]))
    print("  dump 实际：condensed=%d / not-shorter=%d / abstained=%d"
          % (outcomes["condensed"], outcomes["not-shorter"], outcomes["abstained"]))
    print("  「换成 harness 的说明长度就会翻成 condensed」的行 = %d（%d → %d，即预留口径解释的差额）"
          % (harness_condensed - outcomes["condensed"], outcomes["condensed"], harness_condensed))
    print("  预留计价预测 condensed、dump 却非 condensed 的行 = %d%s（超出预留口径，指向实现差异）"
          % (len(impl_only), ("；样例 " + " | ".join(impl_only[:5])) if impl_only else ""))

    print("\n=== 第二段 2. 省幅（triggered = 族真正替换的调用；all 分母 = 过下限全部 bash/pwsh）===")
    condensed = [r for r in dump
                 if r.get("outcome") == "condensed" and r.get("family") is not None and id(r) in pair]
    before_units = after_units = 0
    recon_before_tok = after_tok_harness = after_tok_reserve = 0
    no_body = units_match = 0
    for row in condensed:
        entry = pair[id(row)]
        before_units += int(row.get("beforeUnits") or 0)
        after_units += int(row.get("afterUnits") or 0)
        if int(row.get("beforeUnits") or 0) == entry.units:
            units_match += 1
        if entry.body is None:
            no_body += 1
            continue
        recon_before_tok += entry.before_tok
        after_tok_harness += ruler(entry.body) + ruler(fallback_notice(entry.text_len))
        after_tok_reserve += ruler(entry.body) + ruler("x" * reserve)

    proto_condensed = sum(1 for entries in index.values() for e in entries if e.proto == "condensed")
    c_show = sum(1 for entries in index.values() for e in entries
                 if e.family == "show" and e.proto == "condensed")
    c_offplatform = sum(1 for e in leftover if e.proto == "condensed")
    dump_only = [r for r in condensed if pair[id(r)].proto != "condensed"]

    all_units = stat["before_units"]
    all_tok = stat["before_tok"]
    t_units = pct(before_units - after_units, before_units)
    a_units = pct(before_units - after_units, all_units)
    t_h = pct(recon_before_tok - after_tok_harness, recon_before_tok) if recon_before_tok else None
    a_h = pct(recon_before_tok - after_tok_harness, all_tok) if recon_before_tok else None
    t_r = pct(recon_before_tok - after_tok_reserve, recon_before_tok) if recon_before_tok else None
    a_r = pct(recon_before_tok - after_tok_reserve, all_tok) if recon_before_tok else None

    print("  族触发集（family=compactDiff 且 outcome=condensed）= %d 行；dump 的 beforeUnits 与语料 "
          "estimate_units 一致 = %d 行" % (len(condensed), units_match))
    print("  原型口径 triggered=%d：`git show` 触发 %d 行、非 bash（pwsh）触发 %d 行（发布侧都不接手）、"
          "发布族可见的 bash+git diff 触发 %d；dump condensed = %d，少 %d 行由 1c 的预留口径解释"
          % (proto_condensed, c_show, c_offplatform, proto_condensed - c_show - c_offplatform,
             len(condensed), proto_condensed - c_show - c_offplatform - len(condensed)))
    print("  覆盖面：原型接手而发布族记 family-miss 的 `git show` 行 = %d" % diffs["show-not-covered"])
    print("  反向：dump condensed 但原型非 condensed = %d 行" % len(dump_only))
    print("  替换后正文重建不出（原型在该行放弃）= %d 行，已从 token 口径的分子分母中排除" % no_body)
    print("  分母：triggered = %d 行 / ΣbeforeUnits = %d 单位 / Σbefore 语料 token = %d tok"
          % (len(condensed), before_units, recon_before_tok))
    print("  分母：all       = %d 行 / Σ = %d 单位 / %d tok（记录 57,942,678 tok）"
          % (stat["above_floor"], all_units, all_tok))
    print("  口径 1（dump 原值 = 插件估算单位，after 含 entryChars=%d 预留上界）：" % reserve)
    print("    triggered = %.1f%%（分母 %d 单位）    all = %.1f%%（分母 %d 单位）"
          % (t_units, before_units, a_units, all_units))
    print("  口径 2（o200k token，说明按 entryChars=%d 字符预留占位 —— 悲观端）：" % reserve)
    print("    triggered = %s（分母 %d tok）    all = %s（分母 %d tok）"
          % (fmt_pct(t_r), recon_before_tok, fmt_pct(a_r), all_tok))
    print("  口径 3（o200k token，说明按 harness ≈30 字符 —— 与记录 37.0% 可比、乐观端）：")
    print("    triggered = %s（分母 %d tok）    all = %s（分母 %d tok）"
          % (fmt_pct(t_h), recon_before_tok, fmt_pct(a_h), all_tok))
    print("  区间来源：真实入口说明的长度介于 harness 的约 30 字符与 %d 字符预留上界之间（dump 只有"
          "长度上界，没有说明正文）→ 口径 3 是乐观端、口径 2 是悲观端，口径 1 与闸门同一把尺。" % reserve)
    print("  同分母对照：本次节省（口径 3）/ 原型 triggered 分母 %d tok = %.1f%%（与 37.0%% 的差额是"
          "口径：发布把自己的 295 行挤出了 triggered 集）"
          % (RECORD["tokens_triggered_before"],
             pct(recon_before_tok - after_tok_harness, RECORD["tokens_triggered_before"])))
    print("  记录（原型、harness 说明计价）：triggered=%.1f%%（分母 %d tok）  all=%.1f%%（分母 %d tok）"
          % (RECORD["saving_triggered_pct"], RECORD["tokens_triggered_before"],
             RECORD["saving_all_pct"], RECORD["tokens_before"]))

    print("\n=== 第二段 3. 差异落到语料 / 口径 / 实现哪一边 ===")
    print("语料：过下限 Σtoken = %d vs 记录 %d（差 %+d）→ %s"
          % (all_tok, RECORD["tokens_before"], all_tok - RECORD["tokens_before"],
             "与记录同源，不是差异来源" if all_tok == RECORD["tokens_before"] else "语料已变"))
    print("口径：triggered %d → %d 的差额 %d 行由入口说明计价口径解释（1c：把 after 侧换成 harness 的"
          "≈30 字符说明，%d 行会翻回 condensed）；覆盖面口径另计（`git show` %d 行发布记 family-miss）；"
          "all 是「摊到整个 bash 语料」的口径，不是族自身省幅"
          % (proto_condensed, len(condensed), proto_condensed - len(condensed), harness_condensed,
             diffs["show-not-covered"]))
    print("实现：dump condensed 而原型非 condensed = %d 行；正文 sha256 不一致 = %d 行"
          "（引号路径 %d / 无 hunk 文件 %d / maxLines 截断后行为 %d / 其它 %d）——前几类是原型与"
          "发布的有意差异（判据 8 + 截断后行为），不作 bug 报；「其它」才是未归因余量"
          % (len(dump_only), both - sha_match, body_cls["quoted-path"], body_cls["no-hunk-file"],
             body_cls["post-cut-body"], body_cls["other-body"]))

    print("\n=== 第二段 4. 门槛判定（票 16 判据 12）===")
    print("triggered ≥ 25%%：口径1 %.1f%% → %s ；口径2 %s → %s ；口径3 %s → %s"
          % (t_units, verdict(t_units, 25.0), fmt_pct(t_r), verdict(t_r, 25.0),
             fmt_pct(t_h), verdict(t_h, 25.0)))
    print("all ≥ 1%%：      口径1 %.1f%% → %s ；口径2 %s → %s ；口径3 %s → %s"
          % (a_units, verdict(a_units, 1.0), fmt_pct(a_r), verdict(a_r, 1.0),
             fmt_pct(a_h), verdict(a_h, 1.0)))
    print("注意：以上读数的守卫面仍受第一段第 3 节限制（语料无 exitCode / stdout.truncated），"
          "等于原型口径，不等价于生产口径。")


def _sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=DEFAULT_OUT, help="语料目录（票 14 抽取产物，只读）")
    ap.add_argument("--dump", default=None,
                    help="发布实现导出的 JSONL（缺省 %s，环境变量 %s 可覆盖）"
                         % (DEFAULT_DUMP, DUMP_ENV))
    ap.add_argument("--max-calls", type=int, default=0, help="只跑前 N 条非空目标调用（冒烟）")
    ap.add_argument("--stage", choices=("auto", "1", "2"), default="auto",
                    help="1 = 只做第一段；2 = 必须有 dump；auto = 有 dump 就做第二段")
    args = ap.parse_args()

    dump_path = args.dump or os.environ.get(DUMP_ENV) or DEFAULT_DUMP
    print("=== %s ===" % LABEL)
    ruler = make_ruler()
    want_stage2 = args.stage != "1"
    stat, evidence, index, ordered = corpus_pass(args.out, args.max_calls, ruler,
                                                 want_proto=want_stage2)

    stage1(args, stat, evidence)

    if not want_stage2:
        print("\n（--stage 1：按显式要求只做第一段，未读 dump。）")
        return 0
    if not os.path.exists(dump_path):
        print("\n!! 找不到发布实现导出的 JSONL：%s" % dump_path)
        print("!! 它由 lead 在 packages/dsh-result-clipper/tests/condense-corpus-diff.spec.ts 里产出；")
        print("!! 用 --dump 或环境变量 %s 指定路径。" % DUMP_ENV)
        if args.stage == "2":
            print("!! --stage 2 需要 dump：本次不做第二段。")
            return 2
        print("!! 本次只完成第一段（第二段等 dump 落地后再跑）。")
        return 0

    dump, dup = load_dump(dump_path)
    stage2(dump_path, dump, dup, stat, index, ordered, ruler)
    return 0


if __name__ == "__main__":
    sys.exit(main())
