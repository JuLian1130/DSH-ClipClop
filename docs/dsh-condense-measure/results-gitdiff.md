# `git diff` / `git show` 的 `compact_diff`：三个数与 36.0% 对照

**票 14 / task-2**。被测形态照计划 §4.4 第 1 行（规格出处：调研 §4.1.6 / §5.3 #18，RTK `src/cmds/git/git_cmd.rs` 的 `compact_diff(input, 200)`）；忠实性守卫照计划 §4.1 #7。三个数由 `harness.py`（已冻结，未改动）出；本文所有读数都来自 `/tmp/dsh-condense` 上的真跑。

复现命令见 §7。

---

## 1. 结论

| 数 | 读数 |
| --- | ---: |
| **省幅 · triggered 口径**（分母＝真正被替换的 993 次，4,752,981 tok）——**与调研 36.0% 同一把尺** | **37.0%** |
| **省幅 · all 口径**（分母＝全部过下限的 bash/pwsh 调用 57,942,678 tok） | **3.0%** |
| **触发数** | **993**（`git diff` 993 / `git show` **0**） |
| **守卫放弃数** | **1,660**（占过下限 git 族调用的 61.7%） |

**同口径复核 36.0%：对得上（+1.0pp）。** 触发口径 37.0% vs 调研 36.0%；再把调研自己的策略 B+C 拿到本语料上重跑 = **37.2%**（harness 口径）/ **36.8%**（自有分解口径）。三条读数都落在 36.0% 的 ±1.2pp 内，所以 36.0% 在本语料上**可以复核**，不存在「对不上」。harness 的 3.0% 是 **all** 口径——分母是全部 bash 调用，其中 62,285 次非 git 调用一次都没触发，两者不矛盾。

三个必须知道的事实：

1. **样本充足**：3,133 次 git 族 bash 调用（`git diff` 2,221 / `git show` 912），其中含 `@@` 的真 diff 1,936 次 / 20.4M 字符 / 8.22M o200k token——与调研的 1,870 次 / 20.5M 字符 / 8.29M token 几乎重合。**36.0% 在本语料上可以复核**，不需要写「样本不足」。
2. **`git show` 这一半完全失效**：912 次里过下限 804 次，**触发 0 次**，782 次被守卫放弃——其中 427 次压根不是 diff（`git show <rev>:<path>` 打印的是文件内容、`git show --stat` 打印的是统计表），354 次是 commit 前言／复合命令横幅，1 次中段截断。计划把 `git diff` / `git show` 归成一条 handler，实测只有 `git diff` 那半边有产出。
3. **省幅几乎全部来自 `max_lines=200` 的整体截断**，不是来自「砍上下文」：1,031 次被接受的调用里 507 次撞上 200 行输出上限，贡献了接受样本省幅的 **96%**。这与调研策略 B（把 context 折成计数）是**两个不同的机制**。

---

## 2. 先量样本：语料里有多少条 git 命令

口径：读 `/tmp/dsh-condense/sessions/*.jsonl`，`name == "bash"`，按 §4.2 #10 剥脚手架链（`cd` / `export` / `set` / … 与标题横幅 `echo` / `printf`），按**首个实质命令**取 git 子命令。全语料 177,551 次调用 / 106,504 次 bash。

| 量 | 读数 |
| --- | ---: |
| git 族 bash 调用 | 3,133（`git diff` 2,221 / `git show` 912） |
| 其中过尺寸下限（≥128 估算单位） | 2,691 |
| 低于尺寸下限、一个都不触发 | 442 |
| **含 `@@` 的真 unified diff** | **1,936 次 / 20.4M 字符 / 8,217,346 o200k tok** |
| 两条规则同时命中的行（首命者胜的次序问题） | **0** |
| 横幅/脚手架导致不匹配 | 0 |

作为对照，调研 §3.2 的总体是 **1,870 份真 unified diff / 20.5M 字符 / 8.29M o200k token / 行构成 changed 61.9% + context 31.4%**。两个语料在这三量上分别差 **+3.5% / −0.5% / −0.9%**，可以当作同一个总体。

---

## 3. 被测形态

`compact_diff(input, max_lines=200)`（RTK `git_cmd.rs:1343` 的移植，逐分支对齐）：

- 每个文件累计、在下一个 `diff --` 头之前与文末输出 `  +N -M`；
- 完整保留 `@@` 头（含尾部函数/符号上下文），`@@@` 组合 diff 按标记列数 `at_run-1` 处理；
- 每 hunk 明细封顶 `max_hunk_lines = 100`，超出部分按增删分别记入 `  ... (N deletions, M additions truncated)`；
- **前导**上下文每 hunk ≤3 行、全 diff ≤ `max_lines/10`（=20 行），且不计入 `max_lines`；
- 全 diff 明细到 `max_lines` 即收尾，追加 `... (more changes truncated)` 与 `[full diff: rtk git diff --no-compact]`；
- 跳过 `\ No newline`；标记列按**字节**切（`line.encode()[:width]`），多字节正文与 `--word-diff` 不会切坏；
- `index` / `mode` / `rename` / `Binary files` 等文件级元信息行丢弃（RTK 行为）。

**一处容易被读错、且直接决定省幅的地方**：RTK 只封顶**首个变更之前**的上下文；第一个变更之后、hunk 内部的上下文行**照留**，并计入 `max_hunk_lines`。所以「每 hunk 明细 ≤100」对大 hunk 才生效，典型 hunk 的上下文一行不掉——这正是调研测出的「朴素砍上下文只有 1.5%」的同一个原因，也是 compact_diff ≠ 策略 B 的根本差别。

**分派规则**：`Rule("compact-diff", ("bash","pwsh"), lossy=True, apply, matches_git_family)`，另有单规则的 `git diff` / `git show` 两条用于分解。

**忠实性守卫**（`Outcome(text, abstained=True)`，任何一行解析失败即整次放弃）：

| 原因 | 判据 |
| --- | --- |
| `stray-line-outside-hunk` | hunk 之外出现既非 `diff --`、非合法 hunk 头、非文件级元信息、非 `\ No newline`、非空行的行 |
| `hunk-unterminated-at-eof` | 输入结束时仍有 hunk 未耗尽（`±` 行数与 `@@` 声明对不上）→ 输入被截断 |
| `hunk-unterminated-before-next-hunk` / `-before-file-header` | 下一个 hunk/文件头到来时上一个 hunk 仍未耗尽，同上 |
| `bad-marker-column` | 标记列出现 ` ` / `+` / `-` 以外的字节（`--word-diff` 的无标记正文行、正文被截断切在行中等） |
| `not-a-unified-diff` | 既无 `@@` 也无 `diff --`（`--stat` / `--name-only` / `git show <rev>:<path>` 之类） |

---

## 4. 三个数与 36.0% 的对照

### 4.1 harness 读数（真跑，`--what guarded`）

```
targeted=64976 (floor-skipped=41523)  triggered=993  abstained=1660  unchanged=62285  gate-rejected=38
tokens before=57942678  after=56183505
省幅 all=3.0%（分母 57942678 token：全部命中目标工具的调用；放弃与未改动算零节省）
省幅 triggered=37.0%（分母 4752981 token：只有真正被替换的 993 次）
```

`targeted` 是**全部**过下限的 bash/pwsh 调用（64,976），其中只有 2,691 次落在 git 族上，所以 all 口径是把 handler 的收益摊到整个 bash 语料上的结果；**与调研 36.0% 可比的是 triggered 口径 37.0%**。`gate-rejected=38` 是净收益闸门拦下的、守卫本身放行的小 diff（如 mode-only 变更，省不到 24 估算单位）。守卫放弃 1,660 次 = harness 的 `abstained`。

对照（同样真跑）：守卫关闭时 all=5.8% / triggered=41.6%（触发 2,449）；调研策略 B+C 作为一条规则时 all=5.2% / triggered=37.2%（触发 1,845）。

### 4.2 与调研 36.0% 同口径的复核（`--what decompose`）

总体：含 `@@` 的 diff 1,936 次 / 8,217,346 o200k tok。

| 口径 | 省幅 | 明细 |
| --- | ---: | --- |
| 调研策略 B+C（无守卫，全口径） | **36.8%** | 8,217,346 → 5,190,767 |
| 调研策略 B+C（harness triggered 口径，真跑） | **37.2%** | 触发 1,845 次，分母 8,046,327 tok |
| **compact_diff 严格守卫 · 触发口径（自有分解）** | **37.1%** | 接受 1,031 次，4,798,350 → 3,019,615 |
| compact_diff 严格守卫 · 全口径（放弃按零省幅计） | 21.6% | 放弃 905 次 + 闸门拦下的样本 |
| compact_diff 严格守卫 · 触发口径＋回退说明 | 36.7% | 回退说明 19 o200k tok/次 |
| compact_diff 守卫关闭 · 触发口径 | 37.6% | 接受 1,737 次，7,570,990 → 4,726,299 |
| compact_diff 守卫关闭 · 全口径 | 34.6% | — |
| — 其中被 `max_lines=200` 整体截断的接受样本 | — | 507 次，贡献 1,705,496 tok = 接受样本省幅的 **96%** |

harness 自己报的 triggered 口径（37.0%）与自有分解（37.1%）一致，差 0.1pp 来自闸门拦下的 38 次与回退说明。

**归因（硬判据要求的「语料 / 口径 / 实现」三分）**：

- **语料：不是差异来源。** 同一套 B+C 实现换到本语料得 36.8%（自有）/ 37.2%（harness），与调研 36.0% 差 0.8–1.2pp；三个总量指标（次数/字符/token）都在 3.5% 以内。语料变了（会话更多、项目不同），但 diff 的形状没变。
- **口径：3.0% 与 36.0% 的全部差额在这里。** harness 的 all 口径分母是**全部** bash 调用（57.9M tok，其中 git 族只占 8.2M），而 62,285 次非 git 调用不可能触发；再叠加严格守卫的 1,660 次放弃按零省幅计。换成 triggered 口径（分母只有被替换的 993 次）就是 37.0%，与 36.0% 差 1.0pp。
- **实现：compact_diff 与策略 B+C 不是同一件事，比例接近是巧合。** compact_diff 只砍**前导**上下文，省幅的 96% 来自 `max_lines=200` 的整体截断；B+C 砍的是全部 context 且只对 >150 changed 行的文件封顶。两者在这份语料上落到同一个 36–37%，是长尾分布下两个不同机制的同值，**不能据此认为 compact_diff「复刻」了调研的策略**；票 16 若要 ≥60%，靠的是 `max_lines` 截断而不是调研的 B+C。

### 4.3 与 harness 对账

harness：`57,942,678 − 56,183,505 = 1,759,173` tok 省下。decompose 的 git 族接受样本省幅 = `4,798,350 − 3,019,615 = 1,778,735` tok。差额 19,562 = 993 次触发 × 19 tok 回退说明（18,867）＋ 38 次闸门拦下样本的省幅（约 695）。两条独立读数在 0.04% 内对得上。

---

## 5. 守卫放弃分布（重点发现：61.7%）

| 原因 | 次数 | 占放弃 | 说明 |
| --- | ---: | ---: | --- |
| `stray-line-outside-hunk` | 798 | 48.1% | 正文是 diff，但 hunk 之外混了别的行：commit 前言（Author/Date/message）、`echo "=== 标题 ===" && …` 这类复合命令横幅 |
| `not-a-unified-diff` | 755 | 45.5% | 正文压根不是 unified diff：`git diff --stat` / `--name-only` / `git show <rev>:<path>` |
| `hunk-unterminated-at-eof` | 83 | 5.0% | **输入被截断的实证**：`git diff … \| head -200`、`-- pnpm-lock.yaml`、bash 结果撞 50,000 字符上限 |
| `bad-marker-column` | 22 | 1.3% | 标记列被切断 / `--word-diff` 形态 |
| `hunk-unterminated-before-next-hunk` / `-before-file-header` | 1 + 1 | 0.1% | 中段被截断 |

按子命令：`git diff` 878 次放弃（stray 444 / 非 diff 328 / 截断 83 / 标记列 22 / 中段 1），`git show` 782 次放弃（非 diff 427 / stray 354 / 中段 1）。两条单规则跑的触发数 993 + 0 与家族规则的 993 完全一致，放弃数 878 + 782 = 1,660 也完全一致——**首命者胜的划分在这份语料上互不重叠**（另测「两条规则同时命中」= 0 行）。

**放弃数偏高（61.7%）本身就是结论**：

- 它让 handler 的**全口径**省幅从 34.6%（守卫关闭）掉到 21.6%，即**守卫吃掉了 13pp 的收益**。
- `git show` 半边被 782 次放弃全部清零，其中 427 次是「输出根本不是 diff」——这类调用连进 handler 都不该进（分派规则按 `git show` 命中，但 `git show <rev>:<path>` 打印文件内容）。要让它有产出，必须要么在解析前剥掉 commit 前言、要么把「非 diff 输出」从分派里排除，两条都超出本票范围，留给票 16 决定。
- 撞 50,000 字符上限的 28 次调用里 **20 次被守卫放弃**（71%）——即 bash 工具自己截断过的大 diff，正是调研 §3.2 长尾里最值得精简的那批，恰好不可用。计划 §4.1 #7 要求「截断时整体放弃」，这条规则与「省幅 ≥60%」在这份语料上直接冲突。

---

## 6. harness 缺口与实现偏差（未改 `harness.py`）

1. **`measure_dispatch` 装不下有序规则表。** 规则表长度 >1 且发生首次触发时，`harness.py:196-197` 抛 `AssertionError: dispatch must resolve to exactly one rule`。计划 §4.2 #8 要求「有序规则表 + 首个命中者胜」，仓里的 harness **跑不了**这种表。变通：家族规则单跑一次作为正式读数，`git diff` / `git show` 各单跑一次做分解，另用 `--what decompose` 核「两条规则同时命中 = 0 行」。复现见 §7 第 6 条。
2. **`省幅 triggered` 曾与 `省幅 all` 在代码上恒等**（未触发的调用把 `before` 记进 `tokens_after`，于是 `tokens_saved_triggered + tokens_after ≡ tokens_before`，化简后就是 `saved/tokens_before`）。**lead 已在本次测量期间修好**：`Report` 新增 `tokens_before_triggered`，`saving_triggered` 改用它作分母，`show()` 同时打印两个口径与各自分母。**本文所有 harness 读数都是用修好的版本重跑的**；自有分解口径（37.1%）与它（37.0%）一致，可互为验证。注意：修好之前那个恒等式会让票 16 的「省幅 ≥60%」判据读出一个被稀释的数字。
3. **分母只能按工具名收窄**（`targets`），收不到命令族，所以「这个 handler 能省多少」在 harness 里只能表现为全 bash 语料的 all 口径（3.0%）；命令族口径由 §4.2 的自有分解补上。
4. **`abstained` 把守卫放弃与真异常混在一起**（`harness.py:163-165` 的 `except Exception` 也记 abstain）。变通：本模块的 `apply` 自己分账，非预期异常计入 `UNEXPECTED` 并在每次读数后打印；本轮 5 次跑全为 `{}`。
5. **§4.1 #7 的第一判据（`stdout.truncated`）离线测不了**：`bash` 结果的 `meta` 只有 `cwd`（README 已知边界 3）。变通：用「hunk 行数与 `@@` 声明对不上」替代，抓到 85 次截断；但计数法有盲点——截断恰好落在行边界且两侧计数仍自洽时会漏（本地 fixture 复现过一次）。
6. **实现偏差**：`diff_header_path` 未解码带引号的路径（RTK 会 `unescape_path`），输出里路径可能多几个 `"` / 转义符；对 token 读数的影响远小于 0.1%。另外，`\ No newline` 在 hunk 已耗尽后出现时 RTK 是静默忽略，本模块显式识别该串；实测中这一分支是必需的（否则每次「文件末尾无换行」都会误判为 stray line）。

---

## 7. 复现命令

```bash
# 0) 语料（不进仓库）
python3 docs/dsh-condense-measure/extract_calls.py --out /tmp/dsh-condense

# 1) 正式读数：严格守卫（三个数）
python3 docs/dsh-condense-measure/transforms_gitdiff.py --what guarded

# 2) 口径诊断：守卫关闭 / 调研策略 B+C
python3 docs/dsh-condense-measure/transforms_gitdiff.py --what noguard
python3 docs/dsh-condense-measure/transforms_gitdiff.py --what surveybc

# 3) 单规则分解（git diff / git show）
python3 docs/dsh-condense-measure/transforms_gitdiff.py --what order

# 4) git 族逐条拆解：样本量、守卫原因分布、各口径省幅
python3 docs/dsh-condense-measure/transforms_gitdiff.py --what decompose
```

小样本快跑（冒烟）：

```bash
python3 docs/dsh-condense-measure/transforms_gitdiff.py --what guarded --max-calls 3000
```

第 6 条第 1 项（规则表 >1 的断言）的最小复现：

```bash
cd docs/dsh-condense-measure && python3 - <<'PY'
from harness import Outcome, Rule, measure_dispatch
half = Rule("half", ("bash", "pwsh"), True, lambda t, r: Outcome(t[: len(t) // 2]), lambda r: True)
never = Rule("never", ("bash", "pwsh"), True, lambda t, r: Outcome(t), lambda r: False)
measure_dispatch("one-rule", [half], max_calls=6000)          # 正常出数
measure_dispatch("two-rule", [half, never], max_calls=6000)   # AssertionError: dispatch must resolve to exactly one rule
PY
```

本轮全部 harness 读数的一次性日志：`/tmp/gitdiff-measure-final.log`（5 次跑的分段）；自有分解：`/tmp/decompose-final.txt`。全部读数取自修好 `saving_triggered` 之后的 `harness.py`，本模块 `from harness import …`，没有内联公式的副本。
