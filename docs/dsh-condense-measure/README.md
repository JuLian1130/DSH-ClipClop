# 工具结果精简：测量基建

工具结果精简层的离线语料与基线测量。随票 14 交付，机制与参数见 `.scratch/dsh-result-clipper/doc/tool-result-trimming-plan.md` §4 与 §7。

## 为什么另起一份抽取，而不是复用 `docs/dsh-bash-usage/`

那里的两个抽取器都答不了「这一层能省多少」：

- `extract.py` **按构造只留 `bash`**——`rows/` 里连工具名字段都没有。
- `extract_all.py` 的 `want` 是 8 个写类工具的**白名单，不含 `grep` 与 `glob`**，而且把 `text` 截到 400 字符。

两处都指向同一件事：**`/tmp/dsh-bash-stats/all_tools.jsonl` 里「零 native `grep`/`glob`」是那份抽取的白名单造成的，不是会话里没有**。本目录的抽取不设工具名白名单，并从同一批会话里抽到了 `grep` 2,954 次、`glob` 284 次。同一个索引对 `bash` 也只记到 47,783 次（本目录 106,504 次），因为它的行只在 `tool/result` 出现时才产生、且成文于一份更早的会话集。**该索引不可作为本层的语料。**

## 怎么跑

```
python3 docs/dsh-condense-measure/extract_calls.py --out /tmp/dsh-condense
python3 docs/dsh-condense-measure/measure_baseline.py
python3 docs/dsh-condense-measure/grep_quota.py
```

`extract_calls.py` 逐个**会话目录**读它下面所有版本（`session.v3` / `session.v4` 同时存在，不按目录去重就会把同一次调用数两遍），按 `callId` 合并，结果正文取最长的那份。输出 `$OUT/sessions/<dirkey>.jsonl`，一行一次调用，另出 `$OUT/summary.json`。

首跑读数（本机，2026-10-16）：**2,093 个会话目录 / 2,129 份日志 / 177,551 次调用 / 0 解析失败 / 49 秒 / 769 MB**。

**已交付**：语料抽取、每个工具的调用数 / 字符数 / token 基线、与 §7.5 的对账（**从计划文档解析**，不是手抄常量）、native `grep` 配额分布。

**未交付（票 14 剩下的部分）**：每个候选变换与命令族规则的**测量用原型**，以及它们的省幅 / 触发数 / 守卫放弃数。因此下面「净收益闸门在测量内计算」目前是**口径要求**——还没有脚本算过闸门。

## 三个数的定义

本层的每个候选变换与每条命令族规则都要出这三个数，口径取自计划 §7.1 与 §7.2：

| 数 | 定义 |
| --- | --- |
| **省幅** | 该变换在语料上省下的 token 占比。用真分词器（`o200k_base`）；两侧同口径，绝对值不可信、只比比例 |
| **触发数** | 真正发生替换的调用数（过了净收益闸门、且确实更短） |
| **守卫放弃数** | 该变换因**忠实性守卫**主动放弃的次数（例如输入已被工具自身截断时不输出跨文件聚合量、命令非零退出码时不走激进压缩）。它不是失败——失败另有取值 |

配套两条：**低于尺寸下限的调用一个都不触发**（这是调研「误伤率」在本层的替代形式）；**净收益闸门在测量内计算，不事后补算**。对照真实语料，不用合成 fixture。

## 与计划 §7.5 基线的对账

`measure_baseline.py` 会把四个已钉住的工具与计划 §7.5 并排打印，**差超过 5% 即报红**。2026-10-16 实测：

| 工具 | 计划 §7.5 调用数 | 实测 | 偏差 | 计划 §7.5 token | 实测 token | 偏差 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `bash` | 106,665 | 106,504 | −0.2% | 61,420,407 | 61,405,768 | −0.0% |
| `read` | 25,309 | 25,325 | +0.1% | 51,599,440 | 51,790,732 | +0.4% |
| `grep` | 2,993 | 2,954 | −1.3% | 4,502,889 | 4,436,512 | −1.5% |
| `glob` | 286 | 284 | −0.7% | 144,180 | 143,987 | −0.1% |

四个工具都在 1.5% 以内，差额来自两次抽取之间会话还在增长。§7.5 的基线**可复现**。

全工具口径（token 前 8）：`bash` 106,504 次 / 61,405,768、`read` 25,325 / 51,790,732、`web_fetch` 1,585 / 5,418,565、`grep` 2,954 / 4,436,512、`edit` 26,160 / 855,111、`job_output` 1,079 / 394,443、`write` 4,625 / 218,823、`glob` 284 / 143,987。

## 已知边界（测量前必须知道）

1. **`bash` 与 `web_fetch` 的结果正文封顶在 50,000 字符，`read` 到 57,507、不受该顶。** 归因是**推断而非从常量读出**：spill 策略按 `maxInlineTokens` 预算截断、头尾各留一半，base bundle 配 12,500 估算单位，而估算器是 `CHARS_PER_TOKEN = 4`（`packages/llm/token-meter/src/estimate.ts:13`），所以上限落在 50,000 字符附近；`read` 高出它，与 spill 在 `packages/spill/spill-policy/src/index.ts:135` 硬编码豁免 `read` 一致。另注一个同值但不同物：`tool-workflow` 也有 50,000 的字符上限（`maxResultChars`），但它作用于 `workflow` 工具自己的渲染结果，不是这三个工具。**这道顶就是 ADR 0005 所说的「下游正文」。**
2. **`spillPath` 不是结构化字段。** 会话日志的 `tool/result.meta` 里没有它；它只以文本形式出现在结果正文尾部的「stored at: …」说明里（全语料 96 行含该串）。本层不读它，这条只影响测量能拿到什么。
3. **离线测不到 `bash` 的截断事实。** `bash` 结果的 `meta` 只有 `cwd`，`stdout.truncated` 不在日志里；`grep` / `glob` / `web_fetch` 的 `meta` 有 `truncated`，`read` 用 `offset` / `lines` / `totalLines` 分页。所以「输入是否已被工具自身截断」这个 debug 字段**只能在运行期采集**，语料回放测不出它的出现频率。
4. **语料含少量畸形调用**：工具名出现 `bas`（1 次）与 `render_check(){}`（1 次）。抽取照实保留，不做清洗。
5. **`bash` 有 5 次调用没有对应结果**（日志在此收尾），行内 `hasResult=false`。

## native `grep` 配额分布的实测（票 18 的判断）

计划把「靠前的文件吃满配额、靠后的文件一条没有」列为**判断不是实测**，并要求阶段 0 验掉；实测分布均匀则推荐作废。`grep_quota.py` 的读数（2,954 次 grep 调用，全部解析成功）：

- 结果里带 `Found <shown> of <total> matches` 头的**只有 69 次**（2.3%），即真正被 250 条配额截断的那部分。其余 2,885 次里：**2,582 次**是 `Found N matches`（未截断，`N` 就是全部）、**247 次**是 `No matches found`、**56 次**是 `Error: grep search failed (exit 2): rg: …`（错误结果，根本没有命中头）。三种形态的区别就是信号本身，所以 `grep_quota.py` 按首行形态分开计数并打印（第四桶是 `Error: grep search failed` 之类的错误结果）。
- 这 69 次里，**每次展示的文件数中位数 53、p90 123、最多 131**；只有 **1 次（1.4%）** 出现「单文件吃满配额」。
- 展示的配额里，**单个文件最大占比中位数 12%、p90 34%**。
- 被截断的那 69 次整体只看得见 31.3% 的命中（17,250 / 55,144）——后半段确实看不到，但分不到「前几个文件」头上。

结论：**这个判断在它有害的那个形态上不成立**——配额是摊在几十个文件上的，不是被头部文件吃掉的。按计划 §6「阶段 4 是条件票」的约定，票 18 **已作废**，读数记在设计文档的验证状态节（不记 `deferred.md`）。

## 三个 workstream 的实测读数（票 14）

| 变换 / handler | 触发数 | 守卫放弃 | 省幅 `all` | 省幅 `triggered` | 门槛（`triggered` ≥25% 且 `all` ≥1%） |
| --- | ---: | ---: | ---: | ---: | --- |
| 通用 ① 剥 ANSI | 7 | 0 | 0.0% | 47.0% | 不适用（§4.3 不设门槛） |
| 通用 ② 去 `\r` 进度条 | 57 | 0 | 0.0% | 4.5% | 不适用 |
| 通用 ③ 相邻游程去重 | 109 | 0 | 0.0% | 4.7% | 不适用 |
| 通用 ④ 尾部偏置封顶 | 2,714 | 0 | 9.1% | 49.4% | 不适用 |
| `git diff` `compact_diff` | 993 | **1,660** | 3.0% | **37.0%** | **达到 → 发布** |
| `sed` 大窗口 | 1,331 | 197 | 3.1% | **69.0%** | 达到 |
| 原始转储 | 2,547 | 7,682 | 4.9% | **68.7%** | 达到 |

读数与复现命令见各 workstream 的 `results-*.md`；三个数的口径定义在 `harness.py` 的 docstring。`sed` + 转储的合并跑（同一张有序规则表）给出 `triggered=3,878`、`abstained=7,879`，正好等于两行之和，可作交叉校验。

三条要一起读的结论：

1. **通用 ①②③ 在本语料上几乎没有收益**（命中 132 / 237 / 192 次，触发 7 / 57 / 109 次）。剥 ANSI 尤其：132 次改动里 95 次被净收益闸门挡下，只省 5,037 token（**0.004%**）——ANSI 已被上游剥净。§4.3 对这三条不设省幅门槛，所以它们仍可默认生效，但**不能当成省 token 的手段**。
2. **`compact_diff` 曾没过计划 §4.4 的 ≥60% 门槛（触发口径 37.0%），门槛已按实测改为 25% —— 它现在发布。** 原门槛与计划 §2.2 / §7.5 引的同一条策略基线（36.0%）冲突：同一条策略既被当作基线、又被要求过 60%。门槛改为从基线推出（25% ≈ 36% × 0.7），分母写死为 `triggered`，并要求 `all` ≥1%。另有一条诚实校正：它的省幅 **96% 来自 `max_lines=200` 的整体行数截断，不是调研那种砍 hunk 上下文**，所以「都是 36%」是总量巧合、不是复刻；而它只覆盖 106,504 次 bash 调用里的 993 次（0.93%），省下约 2.9% 的 bash token。
3. **`git show` 半边触发 0 次**（过下限 804 次全被守卫放弃：427 次压根不是 diff、354 次 commit 前言）。这条规则没有产出。
4. **脚手架剥离是这两个 handler 成立的前提**：不剥的话 `sed` 只覆盖 333 / 1,620（漏 79%）、转储只覆盖 4,327 / 16,670（漏 74%）。做法是按 `&&` / `||` / `|` / `;` / 换行拆段（引号内的分隔符不算）、跳过 `cd`/`echo`/`printf`/`set`/`export`/`source`/`.`/`true`/`:`/`pwd`/`pushd`/`popd`/`ulimit`/`umask` 与赋值语句，取第一段。
5. **`sed` 的「策略依赖」答案是「窗口专用预算」**：§4.5 的通用封顶参数（头 50 / 尾 200）在 `sed` 上只有 28.1%（仅 42 次触发，因为 sed 窗口中位数才 110 行、300 行总额度几乎从不生效）；实测最松的可过线档是头 20 / 尾 20（30+30 就掉到 54.9%）。

## TS 实现的真语料验证（票 15）

上面这些读数是**原型**的。票 15 把通用变换做成 `packages/dsh-result-clipper/src/condense.ts` 并接进流水线后，得在发布版实现上复核一遍，复核结果在 [`results-condense-ts.md`](results-condense-ts.md)：

- [`condense_ts_verify.py`](condense_ts_verify.py) 读 TS 侧导出的 JSONL，**import 本目录的原型**（`transforms_general.py` + `harness.py`）逐条比 sha256 / 长度 / 判定，再用 `o200k_base` 做「估算单位减少 ⟹ 真 token 减少」的同号断言。
- TS 侧的导出由 [`condense-corpus.spec.ts`](../../packages/dsh-result-clipper/tests/condense-corpus.spec.ts) 产生：逐调用断言幂等，并把「会被替换」的调用导出成 JSONL。**语料在场就一定跑**（`DSH_CONDENSE_CORPUS` 优先，否则用本目录 `extract_calls.py` 的默认输出路径 `/tmp/dsh-condense`；都没有才跳过），所以本机常规 `pnpm test` 也会跑这条断言。

```bash
cd packages/dsh-result-clipper
DSH_CONDENSE_CORPUS=/tmp/dsh-condense PATH=/tmp/pm-shim:$PATH \
  pnpm vitest run tests/condense-corpus.spec.ts
cd ../..
python3 docs/dsh-condense-measure/condense_ts_verify.py \
  --out /tmp/dsh-condense --dump /tmp/dsh-condense-ts/ts-condense.jsonl
```

结论：幂等违反 0、口径同号反例 0、TS 与原型逐条等价（票 14 读数可搬运）。细节、触发集差异与「这次没验证到的部分」见 [`results-condense-ts.md`](results-condense-ts.md)。
