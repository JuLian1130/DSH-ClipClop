#!/usr/bin/env python3
"""Shared harness for measuring condense transforms: one interface, one set of numbers.

Every candidate transform is measured the same way so the numbers from different
workstreams are comparable. A workstream writes one module that builds `Transform`
(or `Rule`) objects and hands them to `measure_chain` / `measure_dispatch`.

    # transforms_general.py
    from harness import Transform, measure_chain, Outcome

    def strip_ansi(text, row):
        out = ANSI.sub("", text)
        return Outcome(out)          # or Outcome(text, abstained=True)

    def main():
        measure_chain("通用形状变换", [Transform("strip-ansi", ("*",), False, strip_ansi)])

The three numbers the plan asks for, and exactly how they are counted here:

- **省幅** is reported twice, because the two readings answer different questions and
  a single one hides which is meant: `all` divides over every targeted call (abstained
  and unchanged calls count as zero saving), `triggered` over only the calls that were
  actually replaced. The plan's ">=60% before a handler ships" is the `triggered`
  reading; `all` is what the context actually saves.
- **触发数** counts calls where the replacement really happened — the transform
  produced different text *and* the net-benefit gate kept it.
- **守卫放弃数** counts calls where the transform itself abstained (its fidelity
  guard said no). It is not a failure: the plan keeps failures in a separate vocabulary.

The gate is measured, not applied afterwards (plan §7.2 rule 4): a candidate is only
counted as triggering when `estimate(downstream) - estimate(composed) >= 24` units,
where the composed text is `condensed + fallback notice` for lossy transforms. The
gate's caliber is the plugin's own — `ceil(chars / 4) + 4`, mirroring
`packages/llm/token-meter/src/estimate.ts` — not the reporting tokenizer.

Reporting caliber is `o200k_base` (plan §7.2 rule 1).
"""
import argparse
import collections
import json
from dataclasses import dataclass, field
from typing import Callable, Sequence

import tiktoken

from extract_calls import iter_rows

DEFAULT_OUT = "/tmp/dsh-condense"
FLOOR_UNITS = 128          # plan §4.1 #5: smaller than this, nothing triggers
MIN_NET_GAIN_UNITS = 24    # plan §4.1 #4: save less than this and we pass through
ESTIMATE_BLOCK_OVERHEAD = 4


def estimate_units(text: str) -> int:
    """The plugin's caliber: ceil(chars / 4) + block overhead."""
    return ESTIMATE_BLOCK_OVERHEAD + -(-len(text) // 4)


def fallback_notice(chars: int) -> str:
    """What a lossy transform appends so the dropped text stays reachable."""
    return "\n[已精简：完整正文 %d 字符，入口见结果说明]\n" % chars


@dataclass
class Outcome:
    """What a transform hands back. `abstained` means its guard said no."""
    text: str
    abstained: bool = False


@dataclass
class Transform:
    name: str
    targets: Sequence[str]        # tool names; ("*",) means every tool
    lossy: bool
    apply: Callable[[str, dict], Outcome]


@dataclass
class Rule(Transform):
    """A command-family rule: first match wins, so `matches` must be cheap."""
    matches: Callable[[dict], bool] = field(default=lambda row: False)


@dataclass
class Report:
    label: str
    targeted: int = 0
    floor_skipped: int = 0
    triggered: int = 0
    abstained: int = 0
    unchanged: int = 0
    gate_rejected: int = 0
    tokens_before: int = 0
    tokens_after: int = 0
    tokens_saved_triggered: int = 0
    tokens_before_triggered: int = 0

    @property
    def saving_all(self) -> float:
        return self.tokens_saved_triggered / self.tokens_before if self.tokens_before else 0.0

    def show(self):
        print("\n=== %s ===" % self.label)
        print("targeted=%d (floor-skipped=%d)  triggered=%d  abstained=%d  "
              "unchanged=%d  gate-rejected=%d"
              % (self.targeted, self.floor_skipped, self.triggered, self.abstained,
                 self.unchanged, self.gate_rejected))
        print("tokens before=%d  after=%d" % (self.tokens_before, self.tokens_after))
        print("省幅 all=%.1f%%（分母 %d token：全部命中目标工具的调用；放弃与未改动算零节省）"
              % (100 * self.saving_all, self.tokens_before))
        print("省幅 triggered=%.1f%%（分母 %d token：只有真正被替换的 %d 次）"
              % (100 * self.saving_triggered, self.tokens_before_triggered, self.triggered))

    @property
    def saving_triggered(self) -> float:
        return (self.tokens_saved_triggered / self.tokens_before_triggered
                if self.tokens_before_triggered else 0.0)


def _targeted(row, targets) -> bool:
    return "*" in targets or row.get("name") in targets


def _run(label, transforms, out_dir, targets, floor_units, max_calls, mode):
    enc = tiktoken.get_encoding("o200k_base")
    rep = Report(label=label)
    seen = 0
    for row in iter_rows(out_dir):
        if not _targeted(row, targets):
            continue
        source = row.get("text") or ""
        if not source:
            continue
        seen += 1
        if max_calls and seen > max_calls:
            break
        if estimate_units(source) < floor_units:
            rep.floor_skipped += 1
            continue
        rep.targeted += 1
        before = len(enc.encode_ordinary(source))

        chosen = None
        if mode == "chain":
            chosen = transforms
        else:
            for rule in transforms:
                if rule.matches(row):
                    chosen = [rule]
                    break
        if not chosen:
            rep.unchanged += 1
            rep.tokens_before += before
            rep.tokens_after += before
            continue

        text = source
        abstained = False
        for tr in chosen:
            try:
                res = tr.apply(text, row)
            except Exception:
                abstained = True
                break
            if res.abstained:
                abstained = True
                break
            text = res.text
        if abstained:
            rep.abstained += 1
            rep.tokens_before += before
            rep.tokens_after += before
            continue

        if text == source:
            rep.unchanged += 1
            rep.tokens_before += before
            rep.tokens_after += before
            continue

        composed = text
        if any(tr.lossy for tr in chosen):
            composed = text + fallback_notice(len(source))
        if estimate_units(source) - estimate_units(composed) < MIN_NET_GAIN_UNITS:
            rep.gate_rejected += 1
            rep.tokens_before += before
            rep.tokens_after += before
            continue

        after = len(enc.encode_ordinary(composed))
        rep.triggered += 1
        rep.tokens_before += before
        rep.tokens_after += after
        rep.tokens_saved_triggered += before - after
        rep.tokens_before_triggered += before
        if len(transforms) > 1 and mode == "dispatch":
            raise AssertionError("dispatch must resolve to exactly one rule")
    return rep


def measure_chain(label, transforms, *, out_dir=DEFAULT_OUT, targets=("*",),
                  floor_units=FLOOR_UNITS, max_calls=0):
    rep = _run(label, transforms, out_dir, targets, floor_units, max_calls, "chain")
    rep.show()
    return rep


def measure_dispatch(label, rules, *, out_dir=DEFAULT_OUT, targets=("bash", "pwsh"),
                     floor_units=FLOOR_UNITS, max_calls=0):
    rep = _run(label, rules, out_dir, targets, floor_units, max_calls, "dispatch")
    rep.show()
    return rep


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--max-calls", type=int, default=0)
    args = ap.parse_args()
    print("nothing measured: call measure_chain / measure_dispatch from a transform module")
    print("corpus:", args.out)


if __name__ == "__main__":
    main()
