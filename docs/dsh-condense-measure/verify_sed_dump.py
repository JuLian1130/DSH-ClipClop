#!/usr/bin/env python3
"""票 17 判据 4：拿**发布实现**导出的 JSONL 对账 `sed` 大窗口与原始转储两族的省幅门槛。

判据 4 要两句话：两族各有三个数（触发数 / `triggered` 省幅 / `all` 省幅），必须由**发布实现**
在真实语料上重算，门槛 `triggered ≥ 25%` 且 `all ≥ 1%`；不达门槛的那一族不发布。复现方式与票 16
逐字同构：发布实现把判定与替换 dump 成 JSONL，本脚本按票 14 `harness.py` 的口径对账。它不另立
口径，直接 import `harness.py`（尺寸下限、净收益闸门、两个省幅各自的分母定义）与
`transforms_sed_dump.py`（原型的 `sed_rule` / `dump_rules` / `all_rules`），只补三件事——
**独立数一遍 `all` 分母**、**逐 callId 把发布实现的导出与原型对上**、**按族分开算两个省幅口径**。

两段交付（同一份脚本，`--stage` 选）：

- **第一段（不依赖 dump，现在就能跑）**：用 `estimate_units(text) >= 128`、非空正文、
  `targets=("bash","pwsh")` 的 harness 口径独立数一遍 `all` 分母，核对 `results-sed-dump.md`
  记的 **64,976 行 / 41,523 行低于下限 / 57,942,678 tok**；再用 `measure_dispatch` + 原型规则
  重跑 `sed` 大窗口（**1,331 / 69.0% / 3.1%**，守卫放弃 197）、原始转储
  （**2,547 / 68.7% / 4.9%**，守卫放弃 7,682）与两者合跑的有序规则表（记录 3,878 / 68.8% / 8.0%，
  守卫放弃 7,879），差多少、差在哪一类逐项写出。顺带把「语料快照没有 exitCode /
  stdout.truncated 两列」核成实证（与票 16 同一件事）。
- **第二段（dump 落地后）**：读产物 1（`tests/condense-corpus-glance.spec.ts`）导出的 JSONL，
  **按族分别**算三个数——`triggered` 分母 = 该族真正替换掉的调用（`family == X` 且
  `outcome == 'condensed'`）；`all` 分母 = 过尺寸下限、非空的 `bash`/`pwsh` 快照行（**与票 16
  同一把尺子**，逐项对账是否仍等于 64,976 / 57,942,678）。省幅给三个口径（照票 16 的写法）：
  口径 1 = dump 原值（插件估算单位，闸门同一把尺）；口径 2 = o200k token、说明按 `ENTRY_RESERVE`
  预留占位（悲观端）；口径 3 = o200k token、说明按 harness 的约 30 字符（与记录可比、乐观端）。
  与原型读数不一致的行按类归因（平台面 / 地址部分取窗口这条有意差异 / 入口预留口径 / 守卫 /
  其它），样例不超过 5 条；最后给 `≥25%`（triggered）与 `≥1%`（all）两条门槛的判定。

**dump 的字段口径（第二段据此算，别读错）**：`sha256` / `chars` 描述**族收窄后的正文**，
**不含真实入口说明**；`afterUnits` 是「该正文 + `entryChars` 字符预留」的估算单位（闸门计价用的
合成）；`entryChars` 是预留**上界**（`packages/dsh-result-clipper/src/entry.ts` 的 `ENTRY_RESERVE`，
本脚本从源码读回），**不是**实际写出的说明长度——真实说明含会话相关 locator，离线拿不到。

**两条守卫在本次语料上测不了（第一段第 3 节给出实证）。** 生产实现有两条原型没有的守卫：
`exitCode != 0` 放弃、`stdout.truncated` 放弃。DSH 的 durable 事件**不带工具执行的 `value`**
（`packages/core/tools/src/index.ts:575`：canonical value "deliberately omitted from durable
events"），`extract_calls.py` 只从事件里取 content / meta / isError，所以语料快照里既没有
`exitCode`，也没有表示 stdout 被截断的那一列。后果：

> **这份读数等于原型口径，不等价于生产口径。** 两条守卫在语料上恒为「不触发」，dump 的
> `exitCode` / `truncated` 恒为 null 是同一事实的镜像。要拿生产口径的读数，必须在**捕获现场**
> 带上这两列，本脚本无法凭空补出来。

尺子（tiktoken 不可用时的降级规则见 `make_ruler`）：报数口径 `o200k_base`，与
`results-sed-dump.md` 同一把尺；闸门口径仍是插件自己的 `estimate_units`（`ceil(chars/4)+4`）。
降级发生时脚本会在报告首行明确写出尺子换了，不算静默替换。

跑法（仓库根目录）：

    # 第一段：all 分母 + 原型读数复现（不需要 dump，现在就能跑）
    python3 docs/dsh-condense-measure/verify_sed_dump.py --stage 1

    # 第二段：dump 落地后（--dump 缺省 /tmp/dsh-condense-ts/ts-dispatch-glance.jsonl，
    # 环境变量 DSH_CONDENSE_TS_GLANCE_DUMP 可覆盖）
    python3 docs/dsh-condense-measure/verify_sed_dump.py \
        --out /tmp/dsh-condense --dump /tmp/dsh-condense-ts/ts-dispatch-glance.jsonl

冒烟（小样本，口径与正式读数一致，只是行数少）：

    python3 docs/dsh-condense-measure/verify_sed_dump.py --stage 1 --max-calls 3000

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
from transforms_sed_dump import (all_rules, dump_rules, first_command,  # noqa: E402
                                 sed_rule, sed_window_lines)

DEFAULT_OUT = "/tmp/dsh-condense"
DEFAULT_DUMP = "/tmp/dsh-condense-ts/ts-dispatch-glance.jsonl"
DUMP_ENV = "DSH_CONDENSE_TS_GLANCE_DUMP"

# 仓库根（本文件在 docs/dsh-condense-measure/ 下）；ENTRY_RESERVE 从生产源码读回，不写死。
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENTRY_TS = os.path.join(REPO_ROOT, "packages", "dsh-result-clipper", "src", "entry.ts")

# 命中目标工具：与 harness 的 measure_dispatch 缺省一致，也就是两族的 `all` 分母。
TARGETS = ("bash", "pwsh")
LABEL = "票 17 判据 4 对账：sed 大窗口 + 原始转储"

# 本票的两族；dump 里还会有票 16 的 `compactDiff` 行，只计它的分布、不参与本票统计。
GLANCE_FAMILIES = ("sedWindow", "rawDump")
FAMILY_LABEL = {"sedWindow": "② sed 大窗口（≥101 行）", "rawDump": "③ 原始转储 cat/ls/head/tail/nl"}

# `results-sed-dump.md` 记下的读数，作为对账基线。
RECORD = {
    "above_floor": 64_976,
    "floor_skipped": 41_523,
    "tokens_before": 57_942_678,
    "sedWindow": {"targeted": 64_976, "triggered": 1_331, "abstained": 197,
                  "saving_triggered_pct": 69.0, "saving_all_pct": 3.1},
    "rawDump": {"targeted": 64_976, "triggered": 2_547, "abstained": 7_682,
                "saving_triggered_pct": 68.7, "saving_all_pct": 4.9},
    "combined": {"targeted": 64_976, "triggered": 3_878, "abstained": 7_879,
                 "saving_triggered_pct": 68.8, "saving_all_pct": 8.0},
}

# 判定差异归因；前两类是发布实现**有意**或**已声明**与原型不同（平台面、票 17 备注的地址部分取
# 窗口），`dispatch-mismatch` 是两侧脚手架剥离/拆链不是同一张表造成的命中集合差。按类量、不当 bug 报。
# 优先级即此顺序（第一条命中者胜）。
DIFF_CLASSES = ("platform-pwsh", "sed-address-window", "dispatch-mismatch",
                "reserve-caliber", "guard", "other")
DIFF_LABEL = {
    "platform-pwsh": "平台面（发布只在 bash 上求值，原型含 pwsh）",
    "sed-address-window": "地址部分取窗口（票 17 备注的有意差异：原型对整段命令串扫 `N,Mp`，"
                          "连替换文本里的也算命中）",
    "dispatch-mismatch": "分派面命中集合差（原型 `first_command` 的脚手架表/拆链与发布的 "
                         "`firstSubstantiveCommand` 不是同一张表）",
    "reserve-caliber": "入口说明预留口径（ENTRY_RESERVE 上界 vs harness ≈30 字符说明）",
    "guard": "守卫差异（两侧都命中同一族，一侧守卫放弃）",
    "other": "其它",
}

# 正文差异归因（判定一致、但收窄后的正文 sha256 不同）。
BODY_CLASSES = ("cross-family", "line-convention", "length-differs", "other-body")
BODY_LABEL = {
    "cross-family": "两侧命中的不是同一族（正文来自不同 handler）",
    "line-convention": "行切分/行尾口径（原型 Python `splitlines()` 认 \\x0c 等分隔符、且把 CRLF 的 `\\r` "
                       "吃掉；发布 JS 只按 `\\n` 切，`\\r` 留在行内 → 保留行每行多 1 字符）",
    "length-differs": "同族、但发布正文的 JS 长度与原型不同（且正文里没有会漂的行切分/行尾字符）",
    "other-body": "其它（未归因余量，按样例核）",
}

Entry = collections.namedtuple(
    "Entry", "call_id name command units units_js before_tok proto family body text_len "
             "text_sha addr_only split_conv")


def js_len(text):
    """JS 的 `String.length`：UTF-16 码元数（dump 的 `chars` 就是这个口径）。"""
    return len(text.encode("utf-16-le")) // 2


def publish_lines(text):
    """发布侧 `glance.ts:179-182` 的 `splitLines`：只按 `\\n` 切，末尾空串丢掉一个。"""
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


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
        print("!! tiktoken 不可用（%s）：降级为 estimate 单位（ceil(chars/4)+4）作尺子。" % exc)
        print("!! 尺子已变：以下 token 读数与 results-sed-dump.md 的 o200k 读数**不可直接比较**。")
        return estimate_units
    return count


# --- 原型逐条判定（复刻 harness `_run` 的 dispatch 分支，不另立口径） ---------------

class Proto:
    """原型两族：`family_of` 复刻有序规则表的首命中者胜，`apply` 取该族的收窄函数。"""

    def __init__(self):
        self.sed = sed_rule()
        self.dumps = dump_rules()

    def family_of(self, row):
        if self.sed.matches(row):
            return "sedWindow"
        for rule in self.dumps:
            if rule.matches(row):
                return "rawDump"
        return None

    def apply(self, family, text, row):
        rule = self.sed if family == "sedWindow" else self.dumps[0]
        return rule.apply(text, row)


def classify_prototype(proto, source, family, row):
    """复刻 harness `_run`：命中族 → 守卫 → 等值 → 净收益闸门。

    返回 (outcome, body)；outcome 用 dump 的词表
    （family-miss / abstained / unchanged / not-shorter / condensed）。
    注意：本函数只是**复刻** harness 的判定，不是另立口径——下限与闸门都取自 harness。
    """
    if family is None:
        return "family-miss", None
    try:
        res = proto.apply(family, source, row)
    except Exception:
        return "abstained", None
    if res.abstained:
        return "abstained", None
    out = res.text
    if out == source:
        return "unchanged", None
    composed = out + fallback_notice(len(source))
    if estimate_units(source) - estimate_units(composed) < MIN_NET_GAIN_UNITS:
        return "not-shorter", out
    return "condensed", out


def strip_substitution(segment):
    """把 `sed` 脚本里的 `s<d>…<d>…<d>` / `y<d>…<d>…<d>` 替换体抠掉，只留地址与命令字母。

    用来分辨票 17 那条**有意差异**：原型 `_RANGE` 扫整段命令串，于是 `sed -n 's/x/1,200p/p' f`
    会被当成 200 行窗口命中；发布只在**地址部分**取窗口。这个扫描器只服务归因计数，不参与
    任何读数口径。抠不干净时宁可判「不是地址命中」，把行留给 `other` 类。
    """
    out, i, n = [], 0, len(segment)
    while i < n:
        ch = segment[i]
        if ch in "sy" and (i == 0 or not (segment[i - 1].isalnum() or segment[i - 1] in "_-")):
            delim = segment[i + 1] if i + 1 < n else ""
            if delim and delim not in " \t":
                j, fields = i + 2, 0
                while j < n and fields < 2:
                    if segment[j] == "\\":
                        j += 2
                        continue
                    if segment[j] == delim:
                        fields += 1
                    j += 1
                if fields == 2:
                    out.append(ch)
                    i = j
                    continue
        out.append(ch)
        i += 1
    return "".join(out)


def sed_window_in_address(segment):
    """原型命中的窗口是否**也在地址部分**（`strip_substitution` 之后仍然 ≥101 行）。"""
    return (sed_window_lines(strip_substitution(segment)) or 0) >= 101


def corpus_pass(out_dir, max_calls, ruler, want_proto):
    """一次全语料扫描：`all` 分母（独立复现）+ 守卫列缺失实证（+ 需要时原型逐条判定）。

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
    proto = Proto() if want_proto else None

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
        # 行切分/行尾口径：原型 Python `splitlines()` 认 \x0c 等分隔符、且把 CRLF 的 \r 吃掉；
        # 发布 JS 只按 \n 切（`glance.ts:179-182`），`\r` 留在行内 → 保留行每行多 1 字符。
        split_conv = "\r" in source or len(source.splitlines()) != len(publish_lines(source))
        if not above_floor:
            entry = Entry(
                call_id=row.get("callId"), name=row.get("name"), command=command, units=units,
                units_js=units_js, before_tok=0, proto="below-floor", family=None, body=None,
                text_len=len(source), text_sha=text_sha, addr_only=False, split_conv=split_conv)
            index[row.get("callId")].append(entry)
            # 低于下限的行也进 `ordered`：dump 是**行口径**，逐位对齐要拿它当第 N 行（票 16 同此）。
            ordered.append(entry)
            continue
        family = proto.family_of(row)
        outcome, body = classify_prototype(proto, source, family, row)
        addr_only = False
        if family == "sedWindow":
            _name, segment = first_command(command)
            addr_only = bool(segment) and sed_window_in_address(segment)
        entry = Entry(
            call_id=row.get("callId"), name=row.get("name"), command=command, units=units,
            units_js=units_js, before_tok=before_tok, proto=outcome, family=family, body=body,
            text_len=len(source), text_sha=text_sha, addr_only=addr_only, split_conv=split_conv)
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
    print("  分平台：非空 bash=%d / pwsh=%d；空正文 bash=%d / pwsh=%d"
          % (stat["nonempty_bash"], stat["nonempty_pwsh"],
             stat["empty_bash"], stat["empty_pwsh"]))
    print("口径：name ∈ %s、正文非空、estimate_units(text) >= %d、token 尺子 = o200k_base"
          % ("/".join(TARGETS), FLOOR_UNITS))

    print("\n=== 第一段 2. 原型读数重跑（measure_dispatch + transforms_sed_dump）===")
    runs = (
        ("sedWindow", "② sed 大窗口（≥101 行）", [sed_rule()]),
        ("rawDump", "③ 原始转储 cat/ls/head/tail/nl", dump_rules()),
        ("combined", "§4.4 有序规则表：sed 大窗口 → cat → ls → head → tail → nl",
         all_rules()),
    )
    for key, title, rules in runs:
        want = RECORD[key]
        print("\n--- %s：%s ---" % (key, title))
        if key == "combined":
            print("规则表（有序，首个命中者胜）：" + " → ".join(r.name for r in rules))
        rep = measure_dispatch(title, rules, out_dir=args.out, max_calls=args.max_calls)
        print("与 results-sed-dump.md 记录逐项对照：")
        print(cmp_num("targeted", rep.targeted, want["targeted"]))
        print(cmp_num("triggered", rep.triggered, want["triggered"]))
        print(cmp_num("abstained（守卫放弃）", rep.abstained, want["abstained"]))
        print("  triggered 省幅 = %.1f%%（记录 %.1f%%，差 %+.1fpp）"
              % (100 * rep.saving_triggered, want["saving_triggered_pct"],
                 100 * rep.saving_triggered - want["saving_triggered_pct"]))
        print("  all 省幅 = %.1f%%（记录 %.1f%%，差 %+.1fpp）"
              % (100 * rep.saving_all, want["saving_all_pct"],
                 100 * rep.saving_all - want["saving_all_pct"]))
        print("  triggered 分母 tokens = %d，all 分母 tokens = %d"
              % (rep.tokens_before_triggered, rep.tokens_before))
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
    print("      因此这份读数 = **原型口径**，**不等价于生产口径**。")


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


def pair_rows(dump, index, ordered):
    """配对：dump 与语料的非空目标行**逐位对齐**；退路才是按 callId + command + beforeUnits 消耗。

    语料同一 callId 会随会话快照重复出现，dump 也是行口径；不消耗条目就会把同一语料行配给多行
    dump，凭空造出差异。
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


def body_class(entry, dump_row):
    """正文与原型不一致的归因（只服务报告，不进读数）。"""
    if entry.family != dump_row.get("family"):
        return "cross-family"
    if entry.split_conv:
        return "line-convention"
    if entry.body is not None and int(dump_row.get("chars") or 0) != js_len(entry.body):
        return "length-differs"
    return "other-body"


def classify_diff(entry, dump_row):
    """差异归因，按优先级取第一条命中（顺序即 DIFF_CLASSES）；已声明的差异不作 bug 报。"""
    dump_family = dump_row.get("family")
    if entry.name != "bash" and dump_family is None:
        return "platform-pwsh"
    if entry.family != dump_family:
        if entry.family == "sedWindow" and not entry.addr_only:
            return "sed-address-window"
        return "dispatch-mismatch"
    if entry.proto == "condensed" and dump_row.get("outcome") == "not-shorter":
        return "reserve-caliber"
    if entry.proto == "abstained" or dump_row.get("outcome") == "abstained":
        return "guard"
    return "other"


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
    print("配到语料行 = %d（配对方式 = %s；逐位对齐 %d；须退路配对 = %d）"
          % (len(pair), mode, exact, ambiguous))
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
    print("dump 行没有语料行可配 = %d（其中 outcome=below-floor %d、name 分布 %s）"
          % (len(unmatched), sum(1 for r in unmatched if r.get("outcome") == "below-floor"),
             dict(collections.Counter(r.get("name") for r in unmatched).most_common(5))))
    print("语料目标行在 dump 里没有 = %d：name 分布 %s；其中原型族命中 %d"
          % (len(leftover), dict(collections.Counter(e.name for e in leftover).most_common()),
             sum(1 for e in leftover if e.family is not None)))
    print("  ↑ 平台面：发布实现只在 bash 上求值。语料里 pwsh 行 = %d（非空 %d / 空 %d）"
          % (stat["nonempty_pwsh"] + stat["empty_pwsh"], stat["nonempty_pwsh"], stat["empty_pwsh"]))

    print("\n=== 第二段 1. 逐 callId：发布实现 vs 原型（outcome / 族归属）===")
    comparable = agree = below_floor_agree = 0
    diffs = collections.Counter()
    diffs_by_family = collections.Counter()
    diff_samples = collections.defaultdict(list)
    family_only = []
    for row in dump:
        entry = pair.get(id(row))
        if entry is None:
            continue
        if row.get("outcome") == "below-floor" or entry.proto == "below-floor":
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
        family = entry.family or row.get("family")
        if row.get("outcome") != entry.proto:
            cls = classify_diff(entry, row)
            diffs[cls] += 1
            if family in GLANCE_FAMILIES:
                diffs_by_family[(family, cls)] += 1
            if len(diff_samples[cls]) < 5:
                diff_samples[cls].append("%s（原型 %s / dump %s）"
                                         % (row.get("callId"), entry.proto, row.get("outcome")))
        else:
            family_only.append("%s（原型族 %s / dump 族 %s）"
                               % (row.get("callId"), entry.family, row.get("family")))
    print("低于下限、两侧一致 = %d 行（不计入可比行）；可比 dump 行（过下限）= %d   "
          "outcome 与族归属都一致 = %d" % (below_floor_agree, comparable, agree))
    print("差异归因（优先级：平台面 → 地址部分取窗口 → 分派面命中集合 → 预留口径 → 守卫 → 其它）：")
    for cls in DIFF_CLASSES:
        print("  %s = %d%s" % (DIFF_LABEL[cls], diffs[cls],
                               ("；样例 " + " | ".join(diff_samples[cls])) if diff_samples[cls] else ""))
    print("仅族归属不一致（outcome 一致）= %d%s"
          % (len(family_only), ("；样例 " + " | ".join(family_only[:5])) if family_only else ""))

    print("\n=== 第二段 1b. 族收窄后正文的字段口径（sha256 / chars / entryChars）===")
    both = sha_match = chars_match = longer = shorter = 0
    body_cls = collections.Counter()
    body_samples = collections.defaultdict(list)
    au_body = au_reserve = 0
    for row in dump:
        entry = pair.get(id(row))
        if entry is None or row.get("outcome") != "condensed" or entry.body is None:
            continue
        both += 1
        if row.get("sha256") == _sha256(entry.body):
            sha_match += 1
        else:
            cls = body_class(entry, row)
            body_cls[cls] += 1
            if len(body_samples[cls]) < 5:
                body_samples[cls].append(
                    "%s（原型族 %s 长 %d / dump 族 %s 长 %d）"
                    % (row.get("callId"), entry.family, js_len(entry.body),
                       row.get("family"), int(row.get("chars") or 0)))
        chars = int(row.get("chars") or 0)
        length = js_len(entry.body)
        if chars == length:
            chars_match += 1
        elif chars > length:
            longer += 1
        else:
            shorter += 1
        after_units = int(row.get("afterUnits") or 0)
        if after_units == estimate_units(entry.body):
            au_body += 1
        if after_units == estimate_units(entry.body + "x" * reserve):
            au_reserve += 1
    print("dump 里 condensed 且原型也能重建正文的行 = %d（dump 的 %d 行里）"
          % (both, outcomes["condensed"]))
    print("  sha256 与原型正文一致 = %d；不一致 = %d（归因：跨族 %d / 行切分口径 %d / 长度不同 %d / 其它 %d）"
          % (sha_match, both - sha_match, body_cls["cross-family"], body_cls["line-convention"],
             body_cls["length-differs"], body_cls["other-body"]))
    for cls in BODY_CLASSES:
        if body_samples[cls]:
            print("    %s 样例：%s" % (BODY_LABEL[cls], " | ".join(body_samples[cls])))
    print("  chars 与原型正文的 JS 长度：相等 %d / 发布更长 %d / 发布更短 %d"
          % (chars_match, longer, shorter))
    print("  afterUnits 口径：等于 estimate(正文) %d 行；等于 estimate(正文 + %d 字符预留) %d 行"
          % (au_body, reserve, au_reserve))
    entry_chars = collections.Counter(int(r.get("entryChars") or 0) for r in dump
                                      if r.get("outcome") == "condensed")
    print("  收敛行 entryChars 分布 = %s（发布口径应为 %d）"
          % (dict(entry_chars.most_common(4)), reserve))

    print("\n=== 第二段 2. 省幅（按族：triggered = 该族真正替换的调用；all = 过下限全部 bash/pwsh）===")
    all_units = stat["before_units"]
    all_tok = stat["before_tok"]
    print("  all 分母：%d 行 / Σ = %d 单位 / %d tok（记录 %d 行 / %d tok）"
          % (stat["above_floor"], all_units, all_tok,
             RECORD["above_floor"], RECORD["tokens_before"]))
    print("  与票 16 的 all 分母同一把尺子 = %s（两侧都是 name ∈ bash/pwsh、正文非空、"
          "estimate_units >= %d、按语料快照行累计）"
          % (stat["above_floor"] == RECORD["above_floor"] and all_tok == RECORD["tokens_before"],
             FLOOR_UNITS))

    readings = {}
    for family in GLANCE_FAMILIES:
        condensed = [r for r in dump
                     if r.get("family") == family and r.get("outcome") == "condensed"
                     and id(r) in pair]
        before_units = after_units = 0
        no_body = 0
        for row in condensed:
            before_units += int(row.get("beforeUnits") or 0)
            after_units += int(row.get("afterUnits") or 0)
            if pair[id(row)].body is None:
                no_body += 1
        # token 口径的 after 侧只能借原型重建的那一份正文（dump 不含正文，与票 16 同）。所以这里**只取
        # 发布正文与原型正文逐字相同**的行（sha256 相等）——那些行上「原型正文的 token 数」就是「发布正文的
        # token 数」；正文不同的行（本语料 10 行，全部是行切分口径）从 token 口径排除、单独报数。
        tok_rows = [r for r in condensed
                    if pair[id(r)].body is not None and r.get("sha256") == _sha256(pair[id(r)].body)]
        recon_before_tok = after_tok_reserve = after_tok_notice = 0
        for row in tok_rows:
            entry = pair[id(row)]
            recon_before_tok += entry.before_tok
            after_tok_reserve += ruler(entry.body) + ruler("x" * reserve)
            after_tok_notice += ruler(entry.body) + ruler(fallback_notice(entry.text_len))
        t_units = pct(before_units - after_units, before_units)
        a_units = pct(before_units - after_units, all_units)
        t_r = pct(recon_before_tok - after_tok_reserve, recon_before_tok) if recon_before_tok else None
        a_r = pct(recon_before_tok - after_tok_reserve, all_tok) if recon_before_tok else None
        t_h = pct(recon_before_tok - after_tok_notice, recon_before_tok) if recon_before_tok else None
        a_h = pct(recon_before_tok - after_tok_notice, all_tok) if recon_before_tok else None
        readings[family] = dict(t_units=t_units, a_units=a_units, t_r=t_r, a_r=a_r,
                                t_h=t_h, a_h=a_h, before_units=before_units,
                                after_units=after_units, rows=len(condensed))
        want = RECORD[family]
        print("\n--- %s（%s）---" % (family, FAMILY_LABEL[family]))
        print("  族触发集（family=%s 且 outcome=condensed）= %d 行；记录原型 triggered = %d，差 %+d"
              % (family, len(condensed), want["triggered"], len(condensed) - want["triggered"]))
        print("  替换后正文重建不出（原型在该行放弃）= %d 行，已从 token 口径的分子分母中排除" % no_body)
        print("  token 口径（口径 2/3）实际用的行 = %d（发布正文与原型正文 sha256 逐字相同；"
              "另排除「正文不同」%d 行、原型重建不出 %d 行）"
              % (len(tok_rows), len(condensed) - no_body - len(tok_rows), no_body))
        print("  分母：triggered = %d 行 / ΣbeforeUnits = %d 单位 / ΣafterUnits = %d 单位"
              " / Σbefore 语料 token = %d tok"
              % (len(condensed), before_units, after_units, recon_before_tok))
        print("  口径 1（dump 原值 = 插件估算单位，after 含 entryChars=%d 预留上界）：" % reserve)
        print("    triggered = %.1f%%（记录 %.1f%%，差 %+.1fpp）    all = %.1f%%（记录 %.1f%%，差 %+.1fpp）"
              % (t_units, want["saving_triggered_pct"], t_units - want["saving_triggered_pct"],
                 a_units, want["saving_all_pct"], a_units - want["saving_all_pct"]))
        print("  口径 2（o200k token，说明按 entryChars=%d 字符预留占位 —— 悲观端）：" % reserve)
        print("    triggered = %s（分母 %d tok）    all = %s（分母 %d tok）"
              % (fmt_pct(t_r), recon_before_tok, fmt_pct(a_r), all_tok))
        print("  口径 3（o200k token，说明按 harness ≈30 字符 —— 与记录可比、乐观端）：")
        print("    triggered = %s（分母 %d tok）    all = %s（分母 %d tok）"
              % (fmt_pct(t_h), recon_before_tok, fmt_pct(a_h), all_tok))

    print("\n=== 第二段 2b. 分族核对（三组，独立于上面的百分比）===")
    rows_by_family = collections.Counter(str(r.get("family")) for r in dump)
    cond_by_family = collections.Counter(str(r.get("family")) for r in dump
                                         if r.get("outcome") == "condensed")
    print("  ① dump 分族行数：%s；其中 outcome=condensed：%s"
          % (dict(rows_by_family.most_common()), dict(cond_by_family.most_common())))
    for family in GLANCE_FAMILIES:
        print("     %s：行 %d / condensed %d（第二段 2 的触发集 %d）→ 一致 = %s"
              % (family, rows_by_family[family], cond_by_family[family],
                 readings[family]["rows"], cond_by_family[family] == readings[family]["rows"]))
    sed_set = {id(r) for r in dump
               if r.get("family") == "sedWindow" and r.get("outcome") == "condensed"}
    raw_set = {id(r) for r in dump
               if r.get("family") == "rawDump" and r.get("outcome") == "condensed"}
    glance_cond = sum(cond_by_family[f] for f in GLANCE_FAMILIES)
    print("  ② 两族触发集互不相交：|sedWindow ∩ rawDump| = %d（应为 0）；并集 = %d"
          " == dump 里两族 condensed 行数 %d；再加 compactDiff condensed %d"
          " == dump 全部 condensed %d"
          % (len(sed_set & raw_set), len(sed_set | raw_set), glance_cond,
             cond_by_family["compactDiff"], sum(cond_by_family.values())))
    print("     ΣbeforeUnits / ΣafterUnits（触发集）：sedWindow %d / %d；rawDump %d / %d"
          % (readings["sedWindow"]["before_units"], readings["sedWindow"]["after_units"],
             readings["rawDump"]["before_units"], readings["rawDump"]["after_units"]))
    for family in GLANCE_FAMILIES:
        condensed = [r for r in dump if r.get("family") == family
                     and r.get("outcome") == "condensed"]
        shrunk = sum(1 for r in condensed if int(r.get("afterUnits") or 0)
                     < int(r.get("beforeUnits") or 0))
        counter = len(condensed) - shrunk
        print("  ③ %s 触发集里 afterUnits < beforeUnits 的行 = %d（应等于 triggered %d，一致 = %s）；"
              "反例（afterUnits >= beforeUnits）= %d（应为 0）"
              % (family, shrunk, readings[family]["rows"],
                 shrunk == readings[family]["rows"], counter))
    print("  说明：两族的三个口径读数彼此贴近（sedWindow 66.3/68.3/69.0、rawDump 65.9/68.4/69.2）"
          "是巧合还是混族，看上面三组：行集合与 ΣbeforeUnits/ΣafterUnits 都是分族打印的。")

    print("\n=== 第二段 3. 与原型读数不一致的逐类归因（按族）===")
    proto_trig = {f: sum(1 for entries in index.values() for e in entries
                         if e.family == f and e.proto == "condensed") for f in GLANCE_FAMILIES}
    for family in GLANCE_FAMILIES:
        dump_rows = [r for r in dump if r.get("family") == family]
        dump_trig = len([r for r in dump_rows if r.get("outcome") == "condensed"])
        proto_rows = [e for entries in index.values() for e in entries if e.family == family]
        both = [r for r in dump_rows if pair.get(id(r)) is not None
                and pair[id(r)].family == family]
        proto_only = [e for e in proto_rows
                      if id(e) not in {id(pair[id(r)]) for r in both}]
        addr_false = [e for e in proto_only if e.family == "sedWindow" and not e.addr_only]
        print("  %s：原型命中 %d（triggered %d）→ 发布命中 %d（triggered %d，差 %+d）"
              % (family, len(proto_rows), proto_trig[family], len(dump_rows), dump_trig,
                 dump_trig - proto_trig[family]))
        print("    命中集合：两侧都命中 %d；只有原型命中 %d（其中原型判 condensed %d）；"
              "只有发布命中 %d"
              % (len(both), len(proto_only),
                 sum(1 for e in proto_only if e.proto == "condensed"), len(dump_rows) - len(both)))
        if family == "sedWindow":
            print("      只有原型命中里，窗口只在**替换文本**里（地址部分没有 ≥101 行窗口）= %d"
                  "（这条就是票 17 备注的有意差异）" % len(addr_false))
        total_cls = sum(diffs_by_family[(family, cls)] for cls in DIFF_CLASSES)
        print("    判定差异 %d 行，逐类：" % total_cls)
        for cls in DIFF_CLASSES:
            print("      %s = %d" % (DIFF_LABEL[cls], diffs_by_family[(family, cls)]))
        # 分派面差异给样例命令：这一类是本报告里最大的一类，得看得见它长什么样。
        for direction, want_dump_hit in (("只有原型命中", False), ("只有发布命中", True)):
            samples = [r.get("command") or "" for r in dump
                       if (r.get("family") == family or
                           (pair.get(id(r)) is not None and pair[id(r)].family == family))
                       and classify_diff(pair[id(r)], r) == "dispatch-mismatch"
                       and ((r.get("family") is not None) == want_dump_hit)]
            if samples:
                print("      %s的样例命令：%s"
                      % (direction, " | ".join(c[:70] for c in samples[:4])))
    print("  （差异行里出现 `family=None` 的那侧按另一侧的族记账；两族之外的差异不在此表。）")
    compact = [r for r in dump if r.get("family") == "compactDiff"]
    print("  旁证：dump 里票 16 的 compactDiff 行 = %d（outcome=condensed %d），不参与本票统计"
          % (len(compact), sum(1 for r in compact if r.get("outcome") == "condensed")))

    print("\n=== 第二段 4. 门槛判定（票 17 判据 4：triggered ≥ 25% 且 all ≥ 1%）===")
    for family in GLANCE_FAMILIES:
        got = readings[family]
        print("  %s（%s）" % (family, FAMILY_LABEL[family]))
        print("    triggered ≥ 25%%：口径1 %.1f%% → %s ；口径2 %s → %s ；口径3 %s → %s"
              % (got["t_units"], verdict(got["t_units"], 25.0), fmt_pct(got["t_r"]),
                 verdict(got["t_r"], 25.0), fmt_pct(got["t_h"]), verdict(got["t_h"], 25.0)))
        print("    all ≥ 1%%：      口径1 %.1f%% → %s ；口径2 %s → %s ；口径3 %s → %s"
              % (got["a_units"], verdict(got["a_units"], 1.0), fmt_pct(got["a_r"]),
                 verdict(got["a_r"], 1.0), fmt_pct(got["a_h"]), verdict(got["a_h"], 1.0)))
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
        print("!! 它由 packages/dsh-result-clipper/tests/condense-corpus-glance.spec.ts 产出；")
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
