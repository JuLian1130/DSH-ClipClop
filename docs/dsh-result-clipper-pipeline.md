# dsh-result-clipper 流水线（核心业务逻辑）

一次工具结果进入 `tools/post-execute` 之后，到底会不会发模型请求、会不会被改写、什么时候原样透传——**全部判据
在这一个文件里**。它是行为的权威描述：代码与它不一致时，先确认哪一边是想要的，再改另一边（同步清单见 §5）。

debug 记录里的「结果取值」就是本文每个出口给出的那个值（`summarized` / `unmodified`+原因 / `rejected`）。

## 速查：五种收场

| 收场 | 什么时候 | 模型请求 | 取值 |
| --- | --- | --- | --- |
| **不走模型，透传原文** | 摘要总开关关；没声明 `extract` 且规则摘要关；声明了哨兵 `WHOLE_RESULT`；声明了逐字正文的目标；没进候选（非目标工具 / 含图片 / 低于下限 / 达到上限）；`read` 按入口读回 | 0 | `summary-off` / `rule-summary-off` / `whole-result` / `exact-text` / `not-candidate` / `read-back` |
| **走了模型，没产出摘要，透传原文** | 摘要模型返回「保留全文」（不带 `extract` 时契约里才提供它）；隐私判 `uncertain`；请求失败 / 非法输出 / 窗口不足；**输出撞满预算被截断** | 1 | `kept` / `uncertain` / `failed` / `failed-window` / `truncated` |
| **产出了摘要，仍透传原文** | 摘要（含入口说明）不比原文短；存不进去（没有 spill 后端 / 写入失败 / 没有会话归属） | 1 | `not-shorter` / `failed` |
| **产出了摘要，替换正文** | 隐私判 `safe` + `summarize`（两个摘要开关都管不到它）；声明了 `extract` 且模型给了短说明；没声明 `extract`、规则摘要开、模型给了短说明 | 1 | `summarized` |
| **不走模型，直接返回摘要** | memo 命中（摘要提示词路、没声明 `extract`、隐私关闭、同一工具同一正文本会话摘过） | 0 | `summarized` |

四点补充：① 第一行的六种情况都要求**隐私闸门没对这一条生效**——隐私路上「没进候选 / 按入口读回」发生在判定之后，那时已经有 1 次请求；② `failed` 也可能零请求（摘要 route 没配出来）；③ 隐私判 `sensitive`（或 `block` 策略下的失效）**不是透传**：交回固定拒绝文案，记 `rejected`；④ **出厂默认只摘要主模型主动请求的那些结果**（「自动摘要大内容」默认不勾），所以默认部署下第二行与第三行基本不出现、第四行只来自主动请求。隐私开着时 `web_fetch` 默认不进隐私路，照常走摘要提示词路。

每一步的完整顺序、例外与口径见 §1～§4。

## 0. 名词与前提

| 名词 | 含义 |
| --- | --- |
| 目标工具 | `bash`、`pwsh`、`read`、`web_fetch`；其余工具的结果不进摘要候选（隐私开着时仍过闸门） |
| 候选 | 目标工具 + 结果全是文本块 + 估算大小 ≥ `minInlineTokens`；`bash`/`pwsh`/`web_fetch` 另需 < `maxSummarizeTokens`，`read` 无上限 |
| 摘要总开关 | `summarize`（配置区顶端第一个开关）。开：给目标工具挂 `extract` 参数，摘要提示词路才工作 |
| 规则摘要开关 | `ruleSummary`（摘要组第一个勾选，**默认关**）。关：没声明 `extract` 的候选结果直接透传 |
| 隐私闸门 | `privacyGate`（隐私组之上的开关，+ `webFetchPrivacyGate`）。判定与摘要是**同一次请求**的两个字段 |
| 提取目标 | 主模型在调用参数里写的 `extract`；只在摘要总开关开着时被认 |
| 入口读回 | `read` 读的路径命中本会话里插件自己写出的 spill `locator` |
| memo | 摘要提示词路的复用（键 = 工具名 + 正文 hash）；只在隐私关闭时参与 |
| 准入判断 | 可选的额外一次 `yes/no` 判断；**默认关闭**，本文标出它开启时多出来的那一步 |

两条前提，先记住：

1. **PTC 子派发不介入**：`exec.parent !== undefined` 直接交回下游，插件一个字段都不改。
2. **两条路互斥**：隐私闸门对这一条结果生效时走**隐私路**，否则走**摘要提示词路**。隐私路**永不**再发一次单独的
   摘要请求，也不发准入请求（同一次请求里已经既有判定又有摘要）。

哪条路生效：`privacyGate` 开着，**且**（勾了 `webFetchPrivacyGate` 或工具不是 `web_fetch`）→ 隐私路。
`web_fetch` 默认**不**进隐私路（它取的多是外网公开信息），所以隐私开着时它照常走摘要提示词路、照常发摘要请求；
勾上 `webFetchPrivacyGate` 它才进隐私路。其余工具只要隐私开着就进隐私路。

## 1. 决策顺序

每一步「命中就交回」，命中之后不再往下走。没有模型请求的步骤标了 0 次。

### 1.0 进分支之前（两条路共用）

| # | 条件 | 结果取值 | 模型请求 |
| --- | --- | --- | --- |
| 0 | `exec.parent !== undefined`（PTC 子派发） | 不介入 | 0 |
| 1 | 下游决策已是 `block`（别的监听器/spill 策略拒绝） | `not-candidate` | 0 |
| 2 | `extract` 目标：只在摘要总开关开着时被认 | — | — |

### 1.1 隐私路（1 次请求，除非配置失败）

| # | 条件 | 结果取值 | 说明 |
| --- | --- | --- | --- |
| 1 | 隐私 route 未确认为本地 / 没有 `llm` 服务 / route 为空 | `failed`（放行）或 `rejected`（`block` 策略） | 配置失败，0 次请求 |
| 2 | 判 `sensitive` | `rejected` | 固定拒绝文案，不含参数与正文 |
| 3 | 判 `uncertain` | `uncertain`（放行）或 `rejected`（`block` 策略） | 连带取消摘要 |
| 4 | 请求失败 / 非法输出 | `failed` / `failed-window`（放行）或 `rejected` | 窗口不足单列 |
| 5 | `read` 且按入口读回 | `read-back` | 判定已完成 |
| 6 | 没进候选（非目标工具 / 含图片 / 低于下限 / 达上限） | `not-candidate` | 判定已完成 |
| 6b | 声明了哨兵 `WHOLE_RESULT` | `whole-result` | 不采用这次判定随附的摘要；提示词里既无哨兵也无目标那一段 |
| 6c | 目标要求逐字正文 | `exact-text` | 同上，并追加一条指向 `offset/limit` 的提醒 |
| 7 | `safe` + `action: keep` | `kept` | 正文逐字不变、不写存储 |
| 8 | `safe` + `action: summarize` | `summarized` / `not-shorter` / `failed` | 见 §1.4 |

**这一路不看摘要总开关，也不看规则摘要开关**（§4.1）：判 `safe` 的摘要照旧替换正文，`summarize: false` 也一样。
所以 `summary-off` 与 `rule-summary-off` 这两个取值**不会**出现在隐私路上。

### 1.2 摘要提示词路（0～2 次请求）

| # | 条件 | 结果取值 | 模型请求 |
| --- | --- | --- | --- |
| 1 | 摘要总开关关着 | `summary-off` | 0 |
| 2 | `read` 且按入口读回 | `read-back` | 0 |
| 3 | 没进候选（同 §1.1 第 6 步） | `not-candidate` | 0 |
| 3b | 声明了哨兵 `WHOLE_RESULT` | `whole-result` | 0 |
| 3c | 目标要求逐字正文 | `exact-text` | 0 |
| 4 | 没声明 `extract`（漏填或空串）**且** 规则摘要开关关着 | `rule-summary-off` | 0（附一条 `extract-missing` 会话提醒） |
| 5 | 没声明 `extract` 且 memo 命中 | `summarized` / `not-shorter` / `failed` | 0（复用旧摘要） |
| 6 | 摘要 route 没配出来 / 没有 `llm` 服务 | `failed` | 0～1（准入可能已发过） |
| 7 | 准入（开着且没声明 `extract`）判 `no` | `admission-no` | 1 |
| 8 | 摘要模型返回 `keep` | `kept` | 1 |
| 9 | 摘要请求失败 / 非法输出 | `failed` | 1 |
| 9b | 输出撞满预算（终止原因 `max-tokens`） | `truncated` | 1 |
| 10 | 摘要模型返回 `summarize` | `summarized` / `not-shorter` / `failed` | 1 |

声明了 `extract` 的调用跳过准入（第 7 步）、跳过 memo（第 5 步），规则正文换成目标（§4.3）。第 5 步与第 9 步里的"非法输出"指严格解析不成立；**内容写完、只少收尾 `}`** 的输出会被抢救成摘要（§4.8），引号没闭合的那一类不抢救。`extract` 是必填参数，第 4 步的前提在真实运行里意味着"模型漏填"（照默认处理并提醒一次，见 §4.9）。

### 1.3 「替换」本身（`replace`）

走到这里手里已经有一段候选摘要（来自模型、memo 或隐私请求）。三条出口：

| 条件 | 结果取值 |
| --- | --- |
| `摘要长度 + 入口说明预留上界 ≥ 被替换正文长度` | `not-shorter`（透传，不写盘） |
| 没有 spill 后端 / `saveText` 失败 / 没有会话归属 | `failed`（透传） |
| 其余 | `summarized`：正文换成「摘要 + 入口说明」，原文写进 spill |

**长度比较的两把尺子不同**：候选资格用**原始投影**（监听器第二个参数）量；长度比较用**模型即将看到的投影**
（下游决策的正文）。入口说明的预留上界是 `ENTRY_RESERVE`，实际入口写作发生在比较之后，所以不比它长就一次
`saveText` 都不发。

干跑（`dryRun` 生效时）：走完整条流水线、请求照发，但永远交回下游决策、不写盘、不记入口、不读写 memo，记录里
的动作与原因是「本应发生什么」。

## 2. 决策表（按问题，展开版）

### 2.1 什么时候不透传？——只有这四种

| 什么时候 | 取值 | 必要条件 |
| --- | --- | --- |
| 隐私路判 `safe` + `summarize` | `summarized` | 隐私闸门对这一条生效（`web_fetch` 要先勾 `webFetchPrivacyGate`）且结果进了候选 |
| 声明了 `extract`，摘要模型给了短说明 | `summarized` | 摘要总开关开，且结果进了候选 |
| 没声明 `extract`，摘要模型给了短说明 | `summarized` | 摘要总开关开 + 规则摘要开，且结果进了候选 |
| 没声明 `extract`，memo 命中 | `summarized` | 摘要总开关开 + 规则摘要开，且结果进了候选（隐私关闭，memo 才参与） |

其余一律透传原文。拦截（`rejected`）不是透传：模型看到的是固定拒绝文案。

### 2.2 什么时候完全不发模型请求且透传原文

| 条件 | 取值 | 请求 |
| --- | --- | --- |
| PTC 子派发 | 不介入 | 0 |
| 下游决策已是 `block` | `not-candidate` | 0 |
| 摘要提示词路 + 摘要总开关关 | `summary-off` | 0 |
| 摘要提示词路 + 声明了哨兵 `WHOLE_RESULT` / 逐字正文目标 | `whole-result` / `exact-text` | 0 |
| 摘要提示词路 + 没声明 `extract` + 规则摘要关 | `rule-summary-off` | 0（附一条 `extract-missing` 提醒） |
| 摘要提示词路 + route 没配出来（准入关闭时） | `failed` | 0 |
| 摘要提示词路 + 没进候选（非目标工具 / 含图片 / 低于下限 / 达上限） | `not-candidate` | 0 |
| 摘要提示词路 + `read` 按入口读回 | `read-back` | 0 |
| 摘要提示词路 + memo 命中 | `summarized`（复用旧摘要） | 0 |
| 隐私路 + 隐私配置失败（未确认本地 / 无 `llm` / route 空）且策略是放行 | `failed` | 0 |
| **隐私路** + 没进候选 / 按入口读回 | `not-candidate` / `read-back` | **1**（判定已发过） |

「低于下限就透传且不发请求」这条**对声明了 `extract` 的调用同样成立**：候选判定在两条路里都在摘要请求之前，
提取目标不改变它。隐私路上「没进候选」与「按入口读回」发生在判定**之后**，所以那两条不是零请求——零请求的
透传只出现在摘要提示词路与上面列出的隐私配置失败那一格。

### 2.3 什么时候走了模型但透传原文

| 什么时候 | 取值 |
| --- | --- |
| 摘要模型返回 `keep` | `kept`（契约里提供 `keep` 时才有；见 §4.3） |
| 隐私路判 `uncertain` | `uncertain`（放行侧；`block` 策略下是拦截） |
| 请求失败 / 非法输出 / 超窗 | `failed` / `failed-window`（放行侧） |
| 输出撞满预算被截断 | `truncated`（摘要请求；隐私请求的同一次截断记 `failed`。放行侧，不做抢救） |
| 隐私路判 `safe` 但没有摘要可换（没进候选、按入口读回） | `not-candidate` / `read-back` |

### 2.4 什么时候产出了摘要但透传原文

| 什么时候 | 取值 |
| --- | --- |
| 摘要（含入口说明）不比原文短 | `not-shorter` |
| 存不进去：没有 spill 后端 / `saveText` 失败 / 没有会话归属 | `failed` |

### 2.5 什么时候不走模型却拿到摘要

| 什么时候 | 取值 |
| --- | --- |
| memo 命中的重复读取（摘要提示词路 + 没声明 `extract` + 隐私关闭） | `summarized`（复用旧摘要，零请求，入口照旧新写一份） |

它只在摘要提示词路上存在：隐私开着时不查也不写（必然连带跳过本次隐私判定），声明了 `extract` 时不查也不写
（memo 的键里没有目标）。

## 3. 取值域（debug JSONL）

| 取值 | 含义 | 必要条件 |
| --- | --- | --- |
| `summarized` | 正文已替换成「摘要 + 入口说明」 | 见 §2.1 |
| `rejected` | 已拦截（原生 `block` + 固定文案） | 隐私路：`sensitive`，或策略 `block` 下的失效 |
| `summary-off` | 摘要提示词路关闭 | 不在隐私路上出现 |
| `rule-summary-off` | 规则摘要关闭 + 没声明 `extract` | 不在隐私路上出现 |
| `not-candidate` | 不是候选（或下游已 `block`） | 两条路都可能 |
| `read-back` | 按入口读回，跳过摘要 | 两条路都可能 |
| `admission-no` | 准入判断判 `no` | 准入开着 |
| `kept` | 摘要模型要求保留全文 | 契约里提供 `keep` 时 |
| `not-shorter` | 摘要不比原文短 | 拿到过一段摘要 |
| `uncertain` | 隐私未判定，按策略放行 | 隐私路 |
| `exact-text` | 目标要求逐字正文，摘要给不出逐字保证，按原文透传 | 声明了逐字目标且进了候选 |
| `whole-result` | 目标是哨兵 `WHOLE_RESULT`：显式要整份结果 | 进了候选 |
| `truncated` | 输出撞满预算被截断（终止原因 `max-tokens`），按原文透传 | 摘要请求；**隐私路把同一次请求的截断归入 `failed`**（判定本身不可信，且失效必须可见） |
| `failed` | 失败（请求失败 / 非法输出 / route 未配 / 存储不可用） | 两条路都可能 |
| `failed-window` | 本地窗口不足，按策略放行 | 隐私路 |

判断结果（`kept` / `not-shorter` / `not-candidate` / `exact-text` / `whole-result` / 两个关闭）与故障（`failed*` / `truncated`）必须是不同取值，不得合并；**预算不够（`truncated`）与请求失败（`failed`）也不是同一件事**。

## 4. 容易搞错的口径

### 4.1 隐私路自成一路，两个摘要开关都管不到它（2026-10-05 裁决）

隐私请求不读摘要提示词，判定与摘要是同一次请求的两个字段，所以：**隐私开着时判 `safe` 的摘要照旧替换正文，
`summarize: false` 也一样**。否则这一次请求的输出白付，判 `safe` 的正文也白白留在上下文里。两个摘要开关只管
摘要提示词那条路：

- `summarize` 关 → 那条路不发请求也不替换（`summary-off`），也不给工具挂 `extract`。
- `ruleSummary` 关 → 那条路上没声明 `extract` 的候选结果透传（`rule-summary-off`）；`extract` 是必填参数，所以这条同时就是"模型漏填"的计数，并伴随一条 `extract-missing` 会话提醒（§4.9）。

（修正前的实现让隐私路也要求 `summarize`，与本节冲突，票 26 已改。）

### 4.2 隐私路永不发单独的摘要请求

一次工具结果在隐私模式下只有**一次**模型往返：判定与摘要在同一次请求里。准入判断也跳过。因此隐私模式下
「走摘要模型」这句话指的就是那次合并请求里的 `summary` 字段。

### 4.3 声明了 `extract` 的调用没有「保留全文」这个出口

`extract` 一出现，摘要请求与隐私请求的输出契约里就只有 `summarize` 一种动作，规则正文也不再提 `keep`：那条
路径上"透传"只剩一种合法来源——**结果长度低于摘要下限**，由程序自己透传、一个模型请求都不发（隐私开着时只发
那一次隐私判断）。低于下限之外的结果都要交回短说明；原文有 spill 留档与入口可读回，所以不给这个出口不会丢
东西。模型仍返回 `keep` 时按「保留全文」处理（原文透传），只是契约里不再提供它。

### 4.4 memo 只在摘要提示词路上、且只在没声明 `extract` 时

隐私开着时不查也不写（否则必然连带跳过本次隐私判定）；声明了 `extract` 时不查也不写（memo 的键里没有目标，
复用会把另一种问法的摘要当答案返回）。

### 4.5 `web_fetch` 默认不进隐私路

`webFetchPrivacyGate` 默认不勾：隐私开着时 `web_fetch` 不进隐私路、不送本地判定，照常走摘要提示词路并照常发
摘要请求。勾上它才与别的工具一样逐条判定。

### 4.6 两把尺子

候选资格用**原始投影**（spill 截断之前），长度比较与替换用**模型可见投影**（spill 之后）。所以「达到
`maxSummarizeTokens` 的 `bash` 结果」是交给 spill 的 `not-candidate`，而不是"摘要失败"。

### 4.7 超长结果与 `read`

`maxSummarizeTokens` 只约束 `bash`/`pwsh`/`web_fetch`；`read` 不设插件上界（`read` 工具自身按 `readMaxBytes`
封顶，spill 硬编码豁免 `read`）。

### 4.8 输出预算、截断与抢救

摘要请求的输出预算是 `clamp(输入估算 / 8, 512, 1984)`（准入请求固定用下限 512；隐私请求按投影大小用同一把尺子）。
终止原因为 `max-tokens` 时这条输出必然残缺，按原文透传并记 `truncated`（**已核实**：本部署的 `dsh-cline-pass` 适配器把 provider 的 `length` / `max_tokens` 映射成 `{kind: 'max-tokens'}`，见其 `lib/adapter.js:405`；DSH 侧的终止原因是闭集 `stop | tool-calls | max-tokens | aborted | error`），**不做抢救**——把切了一半的正文当
摘要交回会把答案切掉。只有"严格解析不成立、但输出以 `{"action":"summarize","summary":"` 开头且引号已闭合"
（正文写完、外壳没写完）才抢救，抢救正文照常走长度比较。上限 1,984 由「摘要 + 入口说明留在旧结果裁剪器阈值
以内」反推（设计文档「长度约束」），改上限要重新检查那条。

### 4.9 `extract` 必填，`WHOLE_RESULT` 是"要整份"的唯一写法

参数说明与三条工具说明都要求每次调用都写 `extract`；要整份结果只有一种写法——哨兵 `WHOLE_RESULT`（大小写
不敏感），它按原文透传、不发摘要请求，也不受规则摘要开关影响。必填与哨兵都只是**模型可见的提示**（DSH 的
`tools.register` 只校验 `output.schema`，模型参数不由注册表统一校验），所以漏填不会变成工具调用失败：漏填或
空串照默认处理，并追加一条 `extract-missing` 会话提醒（同会话同类一条）。**低于摘要下限的结果不提醒**——那不是
候选，本来就不该有人填参数。

## 5. 改这里的表要同步什么

| 改了什么 | 同步对象 |
| --- | --- |
| 判定顺序、某个出口的条件 | `packages/dsh-result-clipper/src/index.ts`（`process` / `replace`）；本文 §1 |
| 新增/删除取值 | `src/debug.ts`（`UnmodifiedReason`）、本文 §3、`README.zh.md` 的 debug 一段 |
| 输出预算 / 上限 / 抢救与截断的边界 | `src/summary.ts`（`summarizeBudget` / `SUMMARY_CEILING_TOKENS` / `salvageSummary`）、设计文档「长度约束」与「摘要」、本文 §4.8 |
| `extract` 的必填性、哨兵与跳过写法 | `src/extract.ts`（`EXTRACT_DESCRIPTION` / 三段说明 / `isWholeResult`）、`src/privacy.ts`（`ReminderReason`）、本文 §4.9 |
| 开关语义 | `src/config.ts`、`src/client/card.tsx` 与 `src/client/locales.ts`（中英）、README 的配置一节 |
| 提示词契约（外壳、schema、动作集合） | `src/summary.ts` / `src/privacy.ts` / `src/extract.ts`、本文 §4.3 |

行为层的用例在 `packages/dsh-result-clipper/tests/`：`summary.spec.ts`（摘要提示词路）、`privacy.spec.ts`（隐私
路）、`extract.spec.ts`（提取路径）、`full-closure.spec.ts`（各取值的闭合矩阵）。改判定顺序时这几份都要跟着动。
