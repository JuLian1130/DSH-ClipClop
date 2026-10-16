#!/usr/bin/env python3
"""票 15 判据 12：在真实语料上核对 TS 实现与**已测量原型**的等价性，并验证「闸门口径与报数口径同号」。

三件事，口径全部复用既有的两个模块，本脚本不另立一套：

1. **等价性**：读 TS 侧导出的 JSONL（`tests/condense-corpus.spec.ts` 的产物），对每一条调用重跑
   `transforms_general.py` 的原型链与生产形态的闸门，比 `sha256(精简后正文)`、长度、`lossy`、
   命中规则、以及「是否被替换」的判定。等价成立时，票 14 的读数（尾部偏置封顶触发 2,714 次 /
   触发口径 49.4%）才可以搬到发布版。
2. **口径同号**（判据 12）：用 `tiktoken` 的 `o200k_base`，对每个被替换的调用算
   `len(encode_ordinary(原文))` 与 `len(encode_ordinary(精简后正文 + 入口预留))`，断言前者严格更大。
   入口预留按生产闸门的口径取 `src/entry.ts` 的 `ENTRY_RESERVE`（256 字符上界，比真实入口说明
   长约 30 字符更保守），**且只对有损替换计**——无损替换不写入口。**零反例即结案。**
3. **触发集差异**：打印「生产闸门触发集 vs harness 触发集」的差集与方向。

两处已知的**口径差异**，本脚本按它们归因，不当作等价性破坏：

- TS 的 `chars` 是 JS 的 `String.length`（UTF-16 码元），Python 的 `len()` 是码点；含星平面字符
  （emoji 等）的正文两者不等。长度比对因此按 UTF-16 码元算。
- 票 15 给封顶加了一条原型没有的守卫：正文末尾已有一条上游位置说明（spill / `grep` / `glob` 写的）
  时放弃整层（判据 5「至多一个可下钻入口」）。原型会照常封顶，于是「原型会替换而 TS 没导出」里
  有一部分由它解释，脚本逐条归因并单独报数。

口径出处：`harness.py` 的 docstring（三个数与闸门）、`transforms_general.py` 的 `triggered_caliber`
（harness 的 `chain` 读法：只要改动过就按「+ 回退说明」计价）。本脚本 import 它们的函数，不复制。

用法（仓库根目录）：

    python3 docs/dsh-condense-measure/condense_ts_verify.py \
        --out /tmp/dsh-condense --dump /tmp/dsh-condense-ts/ts-condense.jsonl
"""
import argparse
import collections
import hashlib
import json
import os
import re
import sys

import tiktoken

from extract_calls import iter_rows
from harness import (FLOOR_UNITS, MIN_NET_GAIN_UNITS, estimate_units,
                     fallback_notice)
from transforms_general import NAME_CAP, ORDER, PURE, tail_cap

# 精简层作用的工具集，与 packages/dsh-result-clipper/src/condense.ts 的 CONDENSE_TOOLS 对齐。
CONDENSE_TOOLS = ("bash", "grep", "pwsh")

# 仓库根（本文件在 docs/dsh-condense-measure/ 下）。
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENTRY_TS = os.path.join(REPO_ROOT, "packages", "dsh-result-clipper", "src", "entry.ts")

DEFAULT_OUT = "/tmp/dsh-condense"
DEFAULT_DUMP = "/tmp/dsh-condense-ts/ts-condense.jsonl"

# 原型与 TS 的规则 id 只差一个序号前缀（`16-tail-cap` / `tail-cap`）。
PREFIX = re.compile(r"^\d+-")

# TS 侧的位置说明标记，与 condense.ts 的 POSITION_NOTICE_MARKER 同值。
POSITION_NOTICE_MARKER = " stored at: "


def entry_reserve_chars():
    """从生产源码读回退入口预留上界，避免文档里再写一份会漂移的常数。"""
    with open(ENTRY_TS, encoding="utf-8") as fh:
        match = re.search(r"ENTRY_RESERVE\s*=\s*(\d+)", fh.read())
    if not match:
        raise SystemExit("找不到 ENTRY_RESERVE 的定义：%s" % ENTRY_TS)
    return int(match.group(1))


def js_length(text):
    """JS 的 `String.length`：UTF-16 码元数（TS 导出的 `chars` 就是这个口径）。"""
    return len(text.encode("utf-16-le")) // 2


def has_position_notice(text):
    """复现 condense.ts 的 `hasPositionNotice`，**只用于给差异归因**，不参与原型判定。"""
    trimmed = text.rstrip()
    if not trimmed.endswith(")"):
        return False
    start = trimmed.rfind("\n\n(")
    if start < 0:
        return False
    return POSITION_NOTICE_MARKER in trimmed[start:]


def load_dump(path):
    """读 TS 导出：callId -> 记录，并统计重复 callId。"""
    dump = {}
    dup = 0
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if row["callId"] in dump:
                dup += 1
            dump[row["callId"]] = row
    return dump, dup


def prototype_chain(source):
    """按 §4.3 的 13→16 顺序跑原型链。

    @returns (精简后正文, 有损规则是否真的改动了, 真正改动过的规则名列表, 进封顶前的正文)
    """
    text = source
    changed = []
    lossy_changed = False
    pre_cap = source
    for name in ORDER:
        if name == NAME_CAP:
            pre_cap = text
        out = (tail_cap(text, None) if name == NAME_CAP else PURE[name](text, None)).text
        if out != text:
            changed.append(PREFIX.sub("", name))
            if name == NAME_CAP:
                lossy_changed = True
        text = out
    return text, lossy_changed, changed, pre_cap


def prod_gate(source, composed, lossy_changed, reserve):
    """生产形态的闸门：有损替换把入口预留（上界）算进后一侧，无损不算。"""
    if composed == source:
        return False
    after = estimate_units(composed + "x" * reserve) if lossy_changed else estimate_units(composed)
    return estimate_units(source) - after >= MIN_NET_GAIN_UNITS


def harness_gate(source, composed):
    """harness 的 chain 读法：只要改动过，后一侧一律加回退说明（约 30 字符）。"""
    if composed == source:
        return False
    return estimate_units(source) - estimate_units(composed + fallback_notice(len(source))) >= MIN_NET_GAIN_UNITS


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=DEFAULT_OUT, help="语料目录（票 14 抽取产物）")
    ap.add_argument("--dump", default=DEFAULT_DUMP, help="TS 侧导出的 JSONL")
    args = ap.parse_args()

    reserve = entry_reserve_chars()
    dump, dump_dup = load_dump(args.dump)
    enc = tiktoken.get_encoding("o200k_base")

    target_calls = 0
    row_ids = collections.Counter()
    checks = 0                # 逐条做过的等价性比对
    field_bad = {"sha256": [], "chars": [], "rules": [], "lossy": []}
    proto_more = []           # 原型会替换、TS 没导出（(callId, 是否被位置说明守卫解释)）
    ts_more = []              # TS 导出了、原型闸门却不替换
    prod_rows = 0             # 原型 + 生产形态闸门会替换的行
    harness_rows = 0          # harness 口径会替换的行
    harness_only = []         # harness 会替换、生产形态不会（入口预留造成）
    prod_only = []            # 生产形态会替换、harness 不会（harness 对无损改动也加说明造成）

    counterexamples = []
    min_ratio = None
    min_ratio_call = None
    min_abs = None
    min_abs_call = None

    tokens_all_before = 0
    trig_before = 0
    trig_after = 0
    harness_notice_before = 0
    harness_notice_after = 0

    for row in iter_rows(args.out):
        name = row.get("name")
        source = row.get("text") or ""
        if name not in CONDENSE_TOOLS or not source:
            continue
        if estimate_units(source) < FLOOR_UNITS:
            continue
        target_calls += 1
        call_id = row.get("callId")
        row_ids[call_id] += 1

        composed, lossy_changed, changed, pre_cap = prototype_chain(source)
        before_tok = len(enc.encode_ordinary(source))
        tokens_all_before += before_tok

        is_prod = prod_gate(source, composed, lossy_changed, reserve)
        is_harness = harness_gate(source, composed)
        if is_prod:
            prod_rows += 1
        if is_harness:
            harness_rows += 1
        if is_prod and not is_harness:
            prod_only.append(call_id)
        elif is_harness and not is_prod:
            harness_only.append(call_id)

        record = dump.get(call_id)
        if record is None:
            if is_prod:
                proto_more.append((call_id, lossy_changed and has_position_notice(pre_cap)))
            continue

        # —— 1. 等价性：TS 导出 vs 原型 ——
        checks += 1
        if hashlib.sha256(composed.encode("utf-8")).hexdigest() != record["sha256"]:
            field_bad["sha256"].append(call_id)
        if js_length(composed) != record["chars"]:
            field_bad["chars"].append(call_id)
        if sorted(changed) != sorted(record["rules"]):
            field_bad["rules"].append(call_id)
        if lossy_changed != record["lossy"]:
            field_bad["lossy"].append(call_id)
        if not is_prod:
            ts_more.append(call_id)
            continue

        # —— 2. 口径同号：估算单位减少 ⇒ o200k_base token 减少 ——
        after_text = composed + "x" * reserve if lossy_changed else composed
        after_tok = len(enc.encode_ordinary(after_text))
        if before_tok <= after_tok:
            counterexamples.append((call_id, before_tok, after_tok, lossy_changed))
            continue
        trig_before += before_tok
        trig_after += after_tok
        ratio = (before_tok - after_tok) / before_tok
        if min_ratio is None or ratio < min_ratio:
            min_ratio, min_ratio_call = ratio, call_id
        if min_abs is None or (before_tok - after_tok) < min_abs:
            min_abs, min_abs_call = before_tok - after_tok, call_id

        notice_after = len(enc.encode_ordinary(composed + fallback_notice(len(source))))
        harness_notice_before += before_tok
        harness_notice_after += notice_after

    explained = sum(1 for _, why in proto_more if why)
    unexplained = [cid for cid, why in proto_more if not why]
    bad_total = sum(len(v) for v in field_bad.values())

    print("=== 票 15 判据 12：TS 实现 vs 已测量原型（等价性 + 口径同号）===")
    print("语料=%s   TS 导出=%s（%d 个不同 callId / %d 行，重复行 %d）"
          % (args.out, args.dump, len(dump), len(dump) + dump_dup, dump_dup))
    print("目标工具=%s   尺寸下限=%d 估算单位   净收益阈值=%d   入口预留=%d 字符"
          % (" / ".join(CONDENSE_TOOLS), FLOOR_UNITS, MIN_NET_GAIN_UNITS, reserve))
    print("进闸门的调用（估算单位 >= %d）= %d 行（%d 个不同 callId，最多重复 %d 次；"
          "语料按会话快照抽取，同一调用会随多个会话目录重复出现——本报告一律用行口径，与票 14 一致）"
          % (FLOOR_UNITS, target_calls, len(row_ids), max(row_ids.values()) if row_ids else 0))

    print("\n--- 1. 等价性：TS 导出 vs transforms_general.py 原型 ---")
    print("逐条比对=%d   sha256/长度(UTF-16 码元)/命中规则/lossy 有出入的条数=%d"
          % (checks, bad_total))
    for field, ids in field_bad.items():
        print("  %s 不一致=%d%s" % (field, len(ids), ("：" + "、".join(ids[:5])) if ids else ""))
    print("原型会替换、TS 没导出=%d（其中 %d 由「末尾已有上游位置说明则放弃」守卫解释，未解释 %d）"
          % (len(proto_more), explained, len(unexplained)))
    for call_id in unexplained[:10]:
        print("  未解释：%s" % call_id)
    print("TS 导出了、原型闸门却不替换=%d%s"
          % (len(ts_more), ("：" + "、".join(ts_more[:5])) if ts_more else ""))

    print("\n--- 2. 口径同号：估算单位减少 ⇒ o200k_base token 减少（判据 12）---")
    print("口径：有损替换 = 精简后正文 + %d 字符入口预留上界；无损替换 = 只算精简后正文" % reserve)
    print("被替换调用=%d   反例=%d" % (checks - len(ts_more), len(counterexamples)))
    for call_id, before, after, lossy in counterexamples[:20]:
        print("  反例：%s  原文 %d token → 精简后 %d token（lossy=%s）" % (call_id, before, after, lossy))
    if min_ratio is not None:
        print("最小省幅=%.3f%%（%s）   最小绝对省幅=%d token（%s）"
              % (100 * min_ratio, min_ratio_call, min_abs, min_abs_call))
        print("triggered 口径省幅：Σbefore=%d  Σafter=%d  省幅=%.1f%%"
              % (trig_before, trig_after,
                 100 * (trig_before - trig_after) / trig_before if trig_before else 0.0))
        print("all 口径省幅：Σbefore（全部进闸门调用）=%d  省幅=%.2f%%"
              % (tokens_all_before,
                 100 * (trig_before - trig_after) / tokens_all_before if tokens_all_before else 0.0))
        if harness_notice_before:
            print("（敏感性：把入口预留换成 harness 的约 30 字符回退说明，triggered 省幅=%.1f%%）"
                  % (100 * (harness_notice_before - harness_notice_after) / harness_notice_before))

    print("\n--- 3. 生产闸门触发集 vs harness 触发集（行口径）---")
    print("生产形态（原型 + 生产闸门）= %d 行   harness 口径 = %d 行" % (prod_rows, harness_rows))
    print("harness 有、生产没有 = %d 行（入口预留 %d 字符 > harness 的约 30 字符说明）"
          % (len(harness_only), reserve))
    print("生产有、harness 没有 = %d 行（harness 对**任何**改动都加回退说明计价，无损改动因此更难过闸门）"
          % len(prod_only))
    for call_id in harness_only[:10]:
        print("  harness 独有：%s" % call_id)
    for call_id in prod_only[:10]:
        print("  生产独有：%s" % call_id)
    print("方向：%s"
          % ("生产 ⊆ harness（单方向）" if not prod_only else
             ("harness ⊆ 生产（单方向）" if not harness_only else
              "两个方向都非空：生产闸门既不是 harness 的子集也不是超集")))
    print("另：TS 实际导出 %d 行；它比「生产形态」少 %d 行，全部是上面由位置说明守卫解释的那些。"
          % (checks, prod_rows - checks))

    failed = bool(bad_total or unexplained or ts_more or counterexamples)
    print("\n结论：等价性%s；口径同号%s"
          % ("一致" if not (bad_total or unexplained or ts_more) else "不一致",
             "零反例即结案" if not counterexamples else "出现 %d 个反例" % len(counterexamples)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
