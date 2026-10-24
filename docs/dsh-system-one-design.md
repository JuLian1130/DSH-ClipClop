# dsh-system-one 设计

状态：第一步（服务名、声明合并、请求/结果类型、注册表）已实装；第二步的条目配置、三个 provider（`systemone`、`openai`、`deepseek`）、接入层的条目页与决策通道子插件（宿主半与它自己的页面）都已落地，bundle 的多行装载也已复验（两行同装、按 id 单独禁用；复核记录见 `.scratch/dsh-system-one/profile-load-07.md`）。`deepseek` 已用 hard 20 + easy 20 的小样本 pilot 跑过真实端点（读数与已知限制见下面「`deepseek` provider」一节；`openai` 仍未对真实端点实测）。远程面不做。

一句话：把**带类型的题面**交给某个决策模型，拿回**带概率的答案**。这一层不产出内容，也不决定答案怎么用。术语见 `CONTEXT.md` 的「决策模型接入」。

## 这一层做什么、不做什么

- **是**接入层：抹平各家决策模型接口的差异，给业务插件一个稳定的问法与答案形状。
- **不是**编排层：什么时候问、答案不可信时怎么办、要不要重试整段流程，都是业务插件的事。
- 契约里**没有**分片与 provider 侧限额（如最大 token）：怎么切、切多大由 provider 自己决定。
- 结果里**没有** `tiers`、也没有 `providerId`：消费者只知道自己点名的条目 id。
- 服务里**没有**「当前 provider」这类全局状态：每次 `ask` 都点名 `target`，用哪个条目由调用方自己的配置回答。

## 服务名与装载

服务名 `ctx.systemOne`，由 `declare module '@deepseek-ai/cordis'` 合并而来。本包同时是这个 bundle 与接入层：它自己占一行（行 id `dsh-system-one`），决策通道子插件是同一份 `cordis.patch.yml` 里的第二行（行 id `dsh-system-one-channel`），每行各有 id，可按名覆盖或禁用（`dsh-base` 是纯容器形态的先例——`lib/index.js` 只有 `export {}`、`dependencies` 列出它插入的每一行；本包选择合体，因为搬家的收益只是概念整齐，代价是改包名、改引用、改测试）。两个行 id 同时是各自客户端半的配置命名空间，**必须与客户端半里写死的常量一致**：命名空间没被 compose 时那一页根本不显示（`dsh-reasoning-pruner` 的客户端注释与 `whileServed` 就是这个机制）。**子包必须列为本包的 `dependency`**：那一行的模块名要在 profile 的 `node_modules` 里解析得到，`dsh-base` 逐行列 `dependencies` 就是这个原因。

第三方 provider 在自己的插件里 `inject: ['systemOne']` 之后调 `ctx.systemOne.register(id, provider)`。注册的生命周期跟着注册方所在的 fiber，卸载即释放；同一个 id 注册两次抛错——两个条目同名会让 `ask` 指向不确定的实现，不能静默覆盖。

## 公开面

### 插件面

`Context['systemOne']` 只声明两件事：

- `register(id, provider): Disposable`
- `ask(request: AskRequest): Promise<AskResult>`

`providers()` **不在插件面上**，尽管它是服务类上的公开方法。它一旦在插件面上可见，最省事的写法就是「拿列表挑一个」（列表长度为 1 时更顺手），那正好把「用哪个条目」变回隐式默认。约束落在类型上（`Pick<SystemOneService, 'register' | 'ask'>`），但要说清它是**名义**约束：服务类本身是导出的，一次转型就能绕过（本包的测试正是这么读它的）。它挡的是顺手用法，不是刻意绕过。

### 远程面（不做）

原计划随第二步交付一个远程例外：浏览器经 `ctx.remote.systemOne.providers()` 读到条目 id，供设置页使用。**现在不做。** 设置页的数据源是配置而不是注册表：条目页读写自己那一行的 `entries`，决策通道的页面跨命名空间只读同一份 `entries`（先例：`dsh-reasoning-pruner` 的客户端读 pi-ai 的命名空间）。注册表因此不需要任何远程面，`providers()` 保持为服务类上的公开方法，用处仍是 `ask()` 报错时说明现状与测试断言注册顺序。

只打 `@Remote` 标记买不到东西，却要价一整条生成器流水线（宿主面 `./typert`、客户端面 `./remote`，build 从纯 `tsc` 换成带生成器）。这是它一直推迟、现在直接砍掉的原因。

### provider 作者面

第三方 provider 继承 `SystemOneProvider`，实现 `evaluate(request: ProviderRequest): Promise<ProviderResponse>`：

- `ProviderRequest` = `Omit<AskRequest, 'target'>`：服务已经按 `target` 解析过了，provider 不需要知道自己的 id。
- `ProviderResponse` 只带答案与 provider 侧的自报项（`warnings`/`usage`/`requests`/`modelId`）；`AskResult` 在它之上加一项服务侧测得的 `latencyMs`，两者写成继承、不各抄一遍字段。
- `signal` 与 `timeoutMs` 由服务**原样透传**：服务自己不实现超时，也不替 provider 决定重试。
- `ProviderRequest`/`ProviderResponse` 是**给写 provider 的人**的类型面，业务插件用不到。

## 题面与答案

三种题型（是非 / 闭集单选 / 有序量表）是两套外部规范的同一种语义：jev 的 Noul、OpenAI 的 predicate 都是是非题。答案带概率而不是生成文本：是非题的 `probability` 必带，choice/score 的分布是 provider 的自报项，缺席表示没报分布、不是均匀分布。题面与答案都按 id 组织（`Record<id, …>`）：消费者按稳定 id 取答案，顺序在契约层没有用，各家规范要的 name 数组由 provider 自己转。

题面里的可选输入：

- `instructions`（整次请求）：放在所有题之前的一段共享上下文；vllm 的 `/v1/systemone` 与 `deepseek` 支持它（后者由 provider 渲染进题面），SGLang 没有（固定 prompt 的模型会 400）。发给 SGLang 的 provider 收到非空值必须抛错——SGLang 会静默忽略未知顶层字段，不能让它悄悄丢掉。`systemone` provider 的落法见下面「provider 怎么区分两家的行为」：响应里没有它的回显，所以非空即抛错。
- `optionDescriptions`（是非题与单选）：把两侧/各选项的含义单列出来；缺席表示含义写在 `instructions` 里。三家都支持（`deepseek` 由 provider 渲染进题面），且都按字符串忠实渲染。是非题的 key 用 `true`/`false`，与答案的 `probability` 对齐，不用后端的 `yes`/`no`。
- `levels`（量表）：每档是 `Level`（字符串或 JSON 对象/数组）。字符串是三家共有的最小集；富值只有 SGLang 原样保留，vllm 会 `str()` 化，`deepseek` 落成 JSON 文本并原样回显。`systemone` provider 不预判后端是哪一家：富档位照发，靠响应回显的 `legend` 逐档核对，对不上就抛错点 `levels`。
- `images`（整次请求）：图片 URL 或 data URL；三家都收字符串（`deepseek` 落成图片内容块）。模型不支持图片时由后端报错。
- `chatTemplateKwargs`（整次请求）：传给 chat template 的参数。`systemone` 的两家都收，但都会按自己的模板规则校验或拒绝；vllm 的固定 prompt 模型可能忽略它，所以它是 **best-effort**，契约不据此保证效果。`deepseek` 没有位置，非空抛错。

答案的可信度信号：

- `confidence`：provider 自报的集中程度，**不是答案正确的概率**。定义随 provider 而变（vllm 是选中标签在全词表上的概率；SGLang 是 TypeSafe adapter 的归一化公式，忽略标签外的质量），**不可跨 provider 比较**；是非题在 SGLang 上缺席。`deepseek` 是重归一前的域内最大概率。
- `labelMass`：答案标签在整个词表上的概率质量，0–1。vllm 放在每题的 `diagnostics.label_mass`，SGLang 放在答案的 `x_label_mass`；SGLang 在只对允许项打分的 checkpoint（Clef/joint schema、decision checkpoint）上省略，`systemone` provider 遇到省略时按 1.0 归一化。契约里它是可选项，缺席表示 provider 没报。`deepseek` 报的是 top-20 里可见标识符的质量，因此是**整词表质量的下界**（见「`deepseek` provider」）。
- `argmaxIsLabel`：读位置的最高概率 token 是否属于答案标签；vllm 与 `deepseek` 测得到，SGLang 缺席。缺席不是 `true`/`false`，消费者不能把它当默认值。
- `legend`：量表答案回显“第 i 档的值”，与请求的 `levels` 同序；三家都回：`deepseek` 原样回显请求的 `levels`，SGLang 能回 JSON 原值，vllm 只回字符串。provider 把它转成数组，长度必须等于 `levels`。

失败语义：**provider 级失败抛错**（端点不可达、凭据不对、后端 400/422/501）；**单题级的答失败或漏答都不算整次失败**——该题在 `answers` 里缺席，**这是唯一的保证**。provider 若无法隔离单题失败（vllm/SGLang 的整请求校验就是如此），只能整次抛错；缺席的保证只在 provider 能隔离时成立。`warnings` 是 provider 的自报项（`Warning.questionId` 可选，因为警告也可能针对整次调用，例如输入被截断），服务只透传、**不为漏答补写**：漏答若要有解释，由 provider 自己给。消费者必须处理缺席。

**不支持的可选字段必须抛错，不得静默忽略**：请求字段（`instructions`、富 `levels` 等）在某个 provider 上无法如实表达时，provider 要报错并点名字段；响应字段（`labelMass`、`argmaxIsLabel`、`legend`）是 optional，缺席有明确含义，不是某个默认值。

`state` 是**必填**字段，但不是每个后端都能表达任意 JSON：SGLang 只收字符串/对象/数组。`systemone` provider 遇到 `null` 或标量时抛错并点名字段——不字符串化、不包成对象（把它悄悄改写成另一种形状等于换掉判断依据，比报错更糟）；它对 `state` **原样透传**，拒绝由后端发出（SGLang 回 422，`loc` 里点着该字段），provider 连原文包成 provider 级失败——客户端不预先猜后端是哪一家。`deepseek` 没有这个限制：任意 JSON 都序列化进题面。

### 字段与后端对照

| 契约字段 | vllm `/v1/systemone` | SGLang `/v1/systemone` | 不支持时 |
| --- | --- | --- | --- |
| `labelMass` | `diagnostics[qid].label_mass` | `answers[qid].x_label_mass`；Clef/joint schema 与 decision checkpoint 省略 | 缺席=没报；provider 对省略按 1.0 归一化 |
| `argmaxIsLabel` | `diagnostics[qid].argmax_is_label` | 无 | 缺席 |
| `images` | `images`（字符串 URL/data URL） | `images`（字符串或 `{url, detail}`） | 模型不支持图片时后端 400 |
| `instructions` | `instructions` | 无；未知顶层字段被忽略 | SGLang provider 抛错 |
| `optionDescriptions` | `criteria` 里的描述 | 同左 | 无 |
| 富 `levels` | 会 `str()` 化 | 原样保留 | `legend` 回显不符时抛错点 `levels`（回显缺席则无从核对） |
| `chatTemplateKwargs` | `chat_template_kwargs`；固定 prompt 模型可能忽略 | `chat_template_kwargs`；Clef 拒绝非空 | 后端 400；标注 best-effort |
| `legend` | score 答案的 `legend`（字符串） | score 答案的 `legend`（可为 JSON） | 长度不符时 provider 抛错 |

（`deepseek` 不在本表：它不走 `/v1/systemone`，字段落法见下面的「`deepseek` provider」一节。）

后端限额与边界由**后端**校验（provider 不抄一份到客户端：那是两家的分叉点，抄一份就必然过时或误判），provider 把 4xx/5xx 连后端原文包成 provider 级失败，契约不承诺统一：题数（vllm 64；SGLang 无文档上限）、choice 选项（vllm 26，d3 255；SGLang 1–255，>26 需 tokenizer 支持双字母 label）、score 档位（vllm 2–10；SGLang 1–10）、`state`（vllm 任意 JSON；SGLang 只收字符串/对象/数组，`null`/标量 422）、question id（vllm 非空；SGLang 允许空）、`model`（vllm 可选；SGLang 必填）。

以上限额与边界按 2026-10-20 的 vllm 与 SGLang 源码核对；接新版本时以实际源码为准。

**provider 怎么区分两家的行为（不认技术栈）**：端点常常不是自己部署的，问「对方是哪一家」既拿不到也不稳，所以 `systemone` provider 不探测后端身份，按「分叉怎么被发现」分三类：

- **后端会大声拒绝的**（`state` 的 `null`/标量、上面的限额、模型不收的图片）：原样发，拒绝由后端发出，provider 连原文包成 provider 级失败——后端的报错本来就点着字段。
- **响应里留着可核对痕迹的**：`labelMass` 读 `answers[qid].x_label_mass`（SGLang）或 `diagnostics[qid].label_mass`（vllm），都没有时按 1.0 归一；量表答案的 `legend` 必须与请求的 `levels` 逐项一致，不一致就抛错点 `levels`——把档位串化的后端（vllm 的 `str()`）因此被抓住，同样不需要知道它是谁。
- **响应证不了的**：请求级 `instructions` 只有 vllm 认、SGLang 静默忽略，而响应里没有它的痕迹，所以非空即抛错并点名该字段（不可证实即不支持）。等真有消费方需要它，再加条目级开关——那时才知道字段名与默认值该给谁。

## `openai` provider（OpenAI Decisions API）

`kind: 'openai'` 接 OpenAI 的 Decisions API（`POST /v1/decisions`）。与 `systemone` 的差别全在载荷，机制与上面那节同一套：能如实表达的如实发，表达不了的抛错点名字段，响应里读得到的按响应核对。

- **题面是数组而不是映射**：每题带 `name`（= 契约的题 id）与 `instructions`，题型叫 `predicate`／`choice`／`score`；单选多一个 `choices: [{value, description?}]`，量表多一个 `levels: [{label}]`。
- **共享证据在 `input`**：`state` 是字符串时落成 `input_text` 内容块，是对象/数组时落成 `input_json`；`images` 追加成 `input_image` 内容块。`null` 与标量没有对应的内容块，抛错点 `state`——不字符串化（与 `systemone` 的「不静默改写」同一条）。
- **请求级 `instructions`** 是 `input` 里前置的一条 developer 消息（该端点对 developer/system 消息只收文字）；空串不发。
- **三处没有位置，带了内容就抛错**（空 `chatTemplateKwargs`、空 `optionDescriptions` 等于没传，放行）：请求级 `chatTemplateKwargs`、是非题的 `optionDescriptions`（predicate 只有 `instructions`）、非字符串 `Level`（线上档位只有一个字符串 `label`）。
- **答案按 `name` 对回 id**：`probability`／`choice`／`score` 直接对应；`probabilities` 是 `[{value, probability}]`，`value` 在单选里是选项值、在量表里是 0 基档位下标，provider 按它对齐成与 `options`／`levels` 同序的数组；`confidence` 透传；`labelMass`／`argmaxIsLabel` 这个端点不报，按契约缺席（不归一到 1.0——那是 `systemone` 对「有的后端省略」的处理，这里是端点根本没有）。
- **拒答（`type: "refusal"`）**：具名的落成「该题从 `answers` 缺席 + 一条 `{type: 'refusal', questionId}` 警告」；没有 `name` 的拒答对不上任何题，只能算整次失败。
- **未对真实端点实测**：夹具按 2026-10-23 的官方指南（`developers.openai.com` 的 Decisions 页）写，接上真实端点后补一次。

## `deepseek` provider（DeepSeek 官方 chat completions）

`kind: 'deepseek'` 接 `POST {baseUrl}/chat/completions`。与另外两路不同，它**不是决策端点**：官方只提供 chat 接口，所以题面、选项标识符与读出都由 provider 自己做。代价由三个读数框住：标识符必须是单 token、`labelMass` 只是 top-20 可见部分的下界、答案取分布 argmax 而不是采样值。契约不变。

- **题面**：system 固定一句 `You are a decision engine. Reply with exactly one identifier. Do not explain.`；user 依次拼「请求级 `instructions`（非空时）→ `state`（字符串原样，其余 `JSON.stringify`）→ 该题 `instructions` → 选项/档位 → 末段指令」，每段之间空一行。选项块：是非题写 `Options:` 加 `- no`/`- yes`（`optionDescriptions.false`→`no`、`.true`→`yes`，没给描述就只写标识符），单选写 `- a: …`（按 `options` 顺序，没给描述就用选项本身），量表写 `Levels:` 加 `0: …`（富 `Level` 落成 JSON 文本）。末段点名本题实际标识符：`Answer with exactly one word: no or yes.`／`Answer with exactly one letter: a, b, …`／`Answer with exactly one digit: 0, 1, …`。`images` 非空时 user 内容换成「一段 text + 每个 URL 一个 `image_url`」；请求级 `chatTemplateKwargs` 没有位置，非空抛错；空 `instructions`、空 `optionDescriptions` 等于没传。
- **请求固定**：`model`、`messages`、`thinking: {type:'disabled'}`、`temperature: 1.0`、`max_tokens: 1`、`logprobs: true`、`top_logprobs: 20`；不设 `response_format`/`stop`/`top_p`/`seed`。每题一次请求、串行；`requests` 是实际发起的请求数，`usage` 把各响应的 `prompt_tokens`/`completion_tokens` 求和，`modelId` 取第一个成功响应的 `model`。
- **读出**：只读 `choices[0].logprobs.content[0].top_logprobs`；`logprob <= -9999` 是截断哨兵，按未观测跳过。**答案取 top 列表的 argmax，不取 `message.content`**——采样值可以不是分布里概率最高的 token。token 先规范化（去首尾空白 → 去尾随 `:, .` → 去成对引号 → 小写；顺序不能换，先去引号会让 `"a":` 这类 token 漏掉），同一标识符的多个表面形式用 logsumexp 在 log 域合并。
- **答案**：`boolean.probability = P(yes)`；`choice.choice` 是重归一后 argmax 对应的选项；`score.score = Σ i·p_i`；`legend` 原样回显请求的 `levels`。`labelMass = Σ exp(logprob)`（只算 top-20 命中的标识符，clamp 到 `[0,1]`，是下界）；`confidence = max exp(logprob)`（重归一前域内最大）；`argmaxIsLabel` 看全部 top 条的 argmax 是否落在标识符集里。
- **覆盖缺失**：`choice`/`score` 只在全部标识符都命中时返回 `probabilities`（`exp / labelMass`）；任一缺失就省略并加一条 `{type:'coverage', questionId}` 警告，仍返回答案，不拿 0 冒充概率。`boolean` 的 `probability` 照常返回，也带警告。
- **失败**：没有标识符命中 → 该题从 `answers` 缺席 + `{type:'no-identifier'}`；响应缺 `logprobs`/`top_logprobs`、长度 < 2、或非哨兵条目 ≤ 1（`temperature: 0` 的症状）→ provider 级失败，不静默退化成只取 argmax。单题 HTTP 非 2xx → 该题缺席 + `{type:'http-error'}` 并继续；401/403/404 直接抛；所有题都失败时抛第一个错误。
- **上限与拒绝**：单选 > 20、量表 > 10、空选项/空档位在发请求前抛错并点名字段；`choice` 的字母表是 `a`…`t`，`score` 的标识符是 `0`…`9`。
- **不做**：通用 logprobs 协议、verbalized JSON 概率、prefix 续写、重试与并发、`temperature` 配置项，以及全量基准测量（本票只做 20 + 20 pilot）。
- **实测状态（2026-10-24，`deepseek-flash`）**：hard 20（boolean 8／choice 8／score 4）判对 14（boolean 7/8、choice 7/8、score 0/4）；easy 20（boolean 6／choice 14）判对 20。hard 的 8 条 boolean 上 `argmaxIsLabel` 8/8、`labelMass` 中位数 0.9994、最低 0.9885，硬门通过；3 条 easy 带 `coverage` 警告但仍判对。6 条 hard 错题在 test-jev 的 `runs/260925-1722-measure/measure.json` 里同样判错（同一 argmax 口径），是模型本身答错，不是读出故障。基线来自 test-jev 的题面、与本 provider 的 prompt 不同，且 n=8，只作方向性参照；**这组读数不是准确率声明**。
- **已知限制**：`labelMass` 是 top-20 下界；标识符缺失时省略分布；只测了 `deepseek-flash`（`deepseek-v4-pro` 未复核单 token／哨兵／覆盖率）；图片是否真的收未测；规范化会把大写单词并进标识符（`I`→`i`、`A`→`a`、`No`→`no`），与 jev 一致；通道的 boolean 阈值 `|p−0.5|×2` 在低 `labelMass` 时不可靠，等通道票把 `labelMass` 纳入确定度。

## 条目配置与设置页

`entries` 是本包唯一的配置项：一个扁平对象数组，每项是 `{ id, label, kind, baseUrl, model, apiKeyEnv? }`。`id` 是内部标识，唯一、由系统生成（页面新增条目时生成一个可读 slug，例如 `sglang_local_1`；手写 patch 时自己给一个唯一值），消费者按它指名条目；`label` 是给人看的名称，**可以不唯一**（两个条目都叫「本地 SGLang」是合法的）。默认空数组，示例只以注释形式出现在 `cordis.patch.yml`，不指向任何真实部署。装载时按数组建条目并注册——`kind` 经**工厂表**映射到 provider 实现，表是穷尽的（`Record<Kind, …>`）：枚举里加一个 `kind` 却不实现它，`tsc` 就报错，不会出现「注册成功、到 `ask` 时才炸」的条目；重复 `id` 仍按既有规则抛错。

**为什么 id 不能由用户填**：供应商名、模型、地址、协议这四项都不唯一，把其中任何一个当键，都会出现两个条目同名、`ask` 指向不确定实现的局面——这正是第一步「同名注册抛错」要防的事，所以在源头就给它一个系统生成的唯一 id。

**用扁平对象 + `kind` 枚举，不用判别联合**：三种协议（`systemone`、`openai`、`deepseek`）共用同一组字段，字段不随 kind 变化；判别联合只在字段随 kind 变化时才需要，而通用 HTTP 不做，那个需求不存在。

**`entries` 整字段 `.volatile()`**：设置页的写回路径只接受 volatile 路径；而 volatile 只能落在顶层固定字段路径（数组元素内部再放会被拒），所以标记打在整个 `entries` 上。**volatile 更新不重挂载插件**：loader 把新引用提交进运行中的 fiber 后，只向所属 fiber 派发 `loader/volatile-update`（`vendor/loader/src/config/entry.ts` 的 `_commitVolatile`）；host 半监听它做整批替换——按新快照用 `buildEntries` 建出完整新一批（重复 id 在这里抛）、再预检新 id 没被其它插件占用，全部通过后才 dispose 旧的、注册新的。任一步失败都保留旧注册表并记日志，不会半替换。所以设置页保存后增删改条目立即生效，不需要重载插件或重启 DSH；同类监听的先例是 `packages/llm/llm-pi-ai/src/index.ts:315`。

**条目页**（客户端半，`src/client/`）做增删改：名称、模型、API 地址、协议（下拉三种）、API 密钥（可选）。API 地址下方按所选协议给一句填写说明（服务根地址，不要填到具体接口）。已有条目默认折叠成一行（名称 + 模型·协议），点「编辑」展开，保存成功后全部收起；新增行在保存前一直展开。内部 `id` 不由用户输入——新增时生成，展开时在卡片头以一行次要文本显示（可选中复制到消费者的配置里）。密钥字段把值写进凭据域（`$DSH_HOME/.credentials.yaml`），配置里只留引用名 `apiKeyEnv`——先例是设置页里的 WebSearchCard，「written through the credentials domain, never into the settings section」。**引用名的默认值 = 条目 `id`**（存密钥时按 `id` 取默认值，页面不提供改它的控件）；要换引用名仍可手写 patch 把 `apiKeyEnv` 改成自己的环境变量名。

落地时的四条口径（都进了 `tests/client.spec.tsx` 的判据）：

- **`id` 的字符集由凭据引用名决定**：引用名是 POSIX 环境变量名（`packages/credentials/credentials/src/index.ts` 的 `REF_PATTERN` = `^[A-Za-z_][A-Za-z0-9_]*$`），而引用名的默认值就是这个 `id`——带连字符的 slug（例如手写 patch 里的 `sglang-local`，页面已不再生成这种人写 id）在 `remote.credentials.set` 会被整次拒成 `gateway/bad-request`。所以页面生成的 `id` 只用 `[A-Za-z0-9_]`：`<名称的 ASCII slug>_<序号>`；名称里没有 ASCII 字母数字时退化成 `entry_<序号>`，名称以数字开头时前面补 `entry_`（否则首字符过不了引用名语法）。序号取**该前缀下**第一个没被用掉的整数（**不用随机后缀**：随机会在每次改名时变一次，卡片头上那行 id 跟着跳）。**新增那一刻还没有名称**，所以先给 `entry_<序号>`；还是草稿的行按当前名称重算（边打字前缀边长大；换了前缀就按新前缀重新取号），**保存之后固定**（下游配置里的 `target` 指着它，改名不再动摇）。**手写 patch 时**若打算让密钥存在默认引用名下（`apiKeyEnv` 等于 `id`），`id` 也必须落在这个字符集里；`apiKeyEnv` 留空表示这个条目不使用凭据（`wire.ts` 对空引用名不解析），想用带连字符的 id 就显式给一个合法的 `apiKeyEnv`。
- **一次原子写回**：保存提交的是整份数组（`{ op: 'set', path: ['entries'] }`），本包没有第二个可写字段，所以写回路径上不会出现非 volatile 的写入（宿主对非 volatile 路径直接拒绝）。
- **先写凭据、再写配置**：`apiKeyEnv` 只在「这次真写了密钥」或「条目本来就带引用名」时取到非空引用名，其余写空串——空串在 schema 里就是「这个条目不使用凭据」，`wire.ts` 对空引用名不解析，所以这一行照常不带凭据。凭据写失败整次不保存，避免配置指向一个不存在的密钥。
- **协议下拉的三个取值就是 `Kind` 的三个值**（`systemone`、`openai`、`deepseek`），页面不翻译它们：用户必须照着服务方给的接口类型选。

## 决策通道（第二步）

接入层之上有一个子插件，把决策判断交给 agent：需要判断、选择或评分时调它，而不是让主模型自己拿主意。它按第三方 provider 的用法接注册表（`inject: ['systemOne']` 后注册），用哪个条目由它自己的配置回答——接入层不因此新增插件面，也不因此获得全局状态。

**工具面只有一个 `ask`**：参数是 `state`（契约里必填，供判断的状态）与 `questions`（id → 题型内联，每题自带 `instructions`）。请求级的 `instructions`、`images`、`chatTemplateKwargs` **不暴露给模型**——`instructions` 是 vllm 独有、SGLang 会抛错，暴露它等于给模型一个会踩的坑；`images` 模型产不出来；`chatTemplateKwargs` 是部署参数。`signal` 从工具执行上下文透传；**`timeoutMs` 不传**——运行上下文（`packages/core/tools/src/contracts.ts` 的 `ToolRunContext`）只有 `signal` 与派发账目，没有 deadline 字段，而服务也不自己实现超时。`target` 不进工具参数。不按题型拆成多个工具，也不提供排序、判定这类契约里没有的复合操作——生态里「少而正交」是共识，而契约本来就是一次批量 `ask`。

**引导分两档，设置页切换，默认第一档**：第一档是工具描述 + 一个技能（工具描述就是给模型看的——DSH 会把每个工具的 guidance 段渲染进系统提示；技能登记进 DSH 的技能注册表，正文随包交付，写「什么时候该用、什么时候是类别错误」的细则）；第二档在第一档之上再经 `dsh-system-prompt` 的 `PromptSection` 注册表注入一句固定引导（`section({ name, order, text, interpolate? })` 返回 disposer，位次表 `SECTION_ORDERS` 是闭集、第三方只能给数字）。技能注册表声明为**可选**依赖：profile 没组合技能子系统时插件照常加载，只是少一个技能——cordis 的 `inject` 没有「可选」写法，落地用一条单独的 `ctx.inject(['skills'], …)` 纤维等它出现，缺席时那条纤维不激活。不做更强形态（拦截或替换主模型的判断）——那是编排层的事，且要动全局行为。

**开关默认关闭，关掉即不注册工具**：工具不存在，它的 guidance 段也不存在。本仓先例是改 agent 行为的能力默认关闭；`ctx.tools.register` 返回 disposer，配合 `ctx.effect` 的动态注册有现成写法（`dsh-tool-subagent` 与 `dsh-experimental-tool-agent-team` 各一处）。

**阈值默认不设，设置页可开可设**：开启后每题给一个确定性——是非题用 `|probability − 0.5| × 2`，choice/score 用 provider 自报的 `confidence`；低于阈值该题标 `abstain`，答案与概率仍原样交回。provider 没报可信度、分布也缺席时确定性算不出来，同样标 `abstain` 并写明原因——「判不出来」不等于「放行」。标记的形状是工具返回里新增的一层 `decisions: Record<题 id, { verdict: 'act' | 'abstain'; reason?: string }>`；阈值关闭时这一层不出现，`answers` 本体不变。阈值只进配置、不进工具参数（取值 0–1，越界按配置非法在加载期报错）：模型能自己放宽的闸门不是闸门。确定性公式是我们给的语义，而 provider 的 `confidence` 定义各不相同，同一阈值在不同 provider 上松紧不同——这一点要写进页面文案与 README，工具描述里也要说明 `decisions` 层的含义（`abstain` 是「低于你设的可信度门槛」，不是「答案错了」）。

不采用生态里「由判定器决定要不要披露这个工具」的做法：mu 的实测记录是它在 Terminal-Bench 2.1 上被问了 162 次、从未生效，交互会话里问了 34 次、一个都没打开，还让每轮等待（p50 0.91 s / p90 8.9 s）。开关由使用者控制。

落地时的四条口径（都进了 `packages/dsh-system-one-channel` 的判据）：

- **`questions` 在工具参数里是数组，不是契约那张映射**：工具 schema 只能给每个属性一个定名形状，异构的映射值表达不出来，模型就只能靠描述猜每道题有哪些字段。每项自带 `id`，派发前把数组转成 `Record<id, Question>`；重复 id 直接报错点名（后一道会顶掉前一道，等于丢题）。
- **技能跟着开关，不独立于工具**：关掉时工具、引导段、技能一起不注册。留一个指引模型去调不存在工具的技能，比不装技能更糟。
- **`enabled` 不标 volatile，另外三个字段标**：后三项按每次调用／每次组装现读，所以设置页改完即生效；`enabled` 决定的是装载期注册什么，改它本来就该重挂载插件。
- **引导句按档位现读**：第二档那句引导注册成一个 `text: () => …` 的段（第一档返回空串，渲染时空段被丢掉），所以切档位也不需要重载插件。

**通道的页面**（客户端半）管三件事：选当前条目（选项跨命名空间读条目页那份 `entries`）、切引导档位、开/设阈值。跨命名空间只读不写——写没有先例。页面没有保存按钮：改哪项就写哪项；阈值关闭时数值设置整组不显示。

落地时的五条口径（`packages/dsh-system-one-channel/tests/client.spec.tsx` 覆盖行为面）：

- **改哪项写哪项、没有保存按钮**：每次交互只提交这一项（门槛的开关与数值是同一个字段，一起写），不碰没动过的项——最要紧的局面是条目被删掉之后下拉里没有能匹配当前值的选项，整份回写会把一项使用者没碰过的设置清空。当前值不在选项里时，页面把它原样补成一项显示出来，不补造空值；「条目被删掉、只改引导」与「快照还没到时、只改引导」各有一条用例钉住这条。
- **阈值关闭时数值设置整组不显示；数值留原始文本、失焦或停顿后写回**：数字输入框按 `Number()` 收值的话，敲下 `0.` 那一瞬会被当成 `0` 写回控件、小数点再也打不进去（输入框对这类中间态报空串，React 只在值与目标不等时才改 DOM）。文本合法时停止输入 400ms 后写回；失焦/回车时立刻判定，越界或为空报一句话、一条都不写。关闭阈值时按草稿里的有效数值（无效则用配置里的原值）写回 `{ enabled: false, value }`，数值不丢、输入框收起。
- **下拉的值是条目 `id`、显示文本可以重复**：重名的显示文本追加 `id` 后四位（「本地 SGLang（3f9c）」）；一条条目都没有时给出「先到条目页登记」的那句话，而不是一个空白下拉。总开关 `enabled` 不在页面上：宿主只接受 volatile 路径的写入，它也不是按次现读的字段。
- **写入按交互顺序排队**：页面把每次改动接到上一条写入后面，慢链路上连点两下开关或连续改两项时，后一次不会先落地；控件不做整组禁用，失败只报一句话，下一次交互继续写。用例把在途写入挂住，断言第二笔在前一笔返回前不进入写入面、放行后两笔按交互顺序落地。
- **页面写明通道本身要先启用**：`enabled` 默认关闭，而这一页只跟 volatile 字段走——不写这一句的话，默认态下改完三项、什么都不发生，读起来像插件坏了。所以 `live` 那句（改动马上生效、不用重载）之外还有一句「通道本身要先在插件配置里启用，那一步要重载插件」。这句不解释控件放哪，只说前提。

## 已裁决的取舍

- **远程面不做**（理由见上）：设置页改从配置命名空间读，注册表不需要远程面，`@Remote` 标记、typert 的生成产物与带生成器的流水线因此都不进来。
- **不提供「按题型取答案」的类型映射**：没有消费者需要，需要时再按实际用法加。
- **服务不合成警告**：`warnings` 是 provider 的自报项，服务只透传。漏答的保证只有「该题不在 `answers` 里」这一条；为漏答补写一条服务自造的警告，要在契约里新增一个警告类型，而 provider 自己已解释过原因时还会与它并存，换到的只是「消费者不必自己 diff」。
- **保留可选 `confidence`，另加 `labelMass`/`argmaxIsLabel`**：三者都是可信度信号，业务插件可能按它们设阈值。定义随 provider 而变、不可跨 provider 比较，契约只透传，不用它们做任何判断。
- **`mock` 不做**：生态里的 mock 解决的是「无网络无凭据也能断言精确值」，本仓这个角色由测试期的进程内假 provider 承担（第一步的 8 条行为测试已经这么用）。
- **8 个可选字段进契约**：`labelMass`、`argmaxIsLabel`、`images`、`instructions`、`optionDescriptions`、富 `levels`、`chatTemplateKwargs`、`legend`。`cacheSalt`、`priority`、`requestId` 只记录用途，不进契约（等真实的运维/追踪需求）；`audio`/`videos` 也不进，只加 `images`。
- **provider-specific 字段进同一契约，靠“不支持就抛错”兜住**：请求字段在某个后端上无法如实表达时抛错并点名字段（SGLang 的 `instructions` 不可证实即拒；vllm 的富 `levels` 靠 `legend` 回显核对抓出）；响应字段 optional，缺席有明确语义。这样既不丢有场景的能力，也不会静默换掉答案依据。
- **`labelMass` 归一化**：SGLang 在 Clef/joint schema 与 decision checkpoint 上省略 `x_label_mass`；`systemone` provider 按 1.0 归一化，与 vllm 在这些模型上的 `label_mass=1` 对齐。这是一条依赖 SGLang 文档的假设，接新 checkpoint 时复核。
- **`chatTemplateKwargs` 是 best-effort**：vllm 的固定 prompt 模型会忽略它，SGLang 的 Clef 会拒绝非空值；契约不据此保证效果，只作为模板参数透传。
- **`legend` 用数组**：与 `levels` 同序，`legend[i]` 是第 i 档的值；provider 把两边的 map 转数组并校验长度。不采用 wire 的 map 形状，避免字符串键与整数样键重排。
- **boolean 的 `optionDescriptions`**：与 choice 用同一个概念，key 用 `true`/`false` 而不是后端的 `yes`/`no`；两边都原生支持，映射无损。
- **`/v1/systemone` 归入 `systemone` kind，vllm 与 SGLang 都是目标**：两边都实现 System One 的三种题型，行为差异由 provider 抹平，见上面的字段对照与限额。同一个 kind 换 `baseUrl` 覆盖 TypeSafe、OpenCode Zen、vllm 与 SGLang。
- **`/v1/score` 不做**：它是打分原语（`query` + `items` + `label_token_ids` → scores 矩阵），不是决策协议——用它就得由 provider 自己渲染题面、套 chat template、并对答案 label 做分词校验，而这些正是 `/v1/systemone` 在服务端替我们做完的事。它服务的那批模型里，能进决策端点的（如 d3 的 `D3ForSequenceClassification`）已由 `/v1/systemone` 提供原生 readout；不能进的（RewardModel、部分 classification）各有专用门面，所以 `/v1/score` 对决策用途没有额外覆盖。
- **决策端点的模型边界**：vllm 按 `model_config.architecture` 从注册表选 read strategy，覆盖生成模型、pooling（Clef）、classification（d3）与 diffusion（DiffusionGemma）；没有注册策略的架构返回 501，不会自动回退到通用渲染。d3 的 `D3ForSequenceClassification` 策略读取 checkpoint 的 `hf_config.decision_config` 走原生 readout；生成模型走通用渲染。SGLang 默认要求生成模型，decision checkpoint 与 Clef 走各自的 readout（`decision_config.json`/`joint_head_config.json`）；`--enable-mis`、`--dllm-algorithm`、LoRA adapter 与部分 chat-template 配置按名拒绝。接具体 checkpoint 时实测走哪条。
- **SGLang 的 `/v1/decisions` 不做**：它对我们这个契约是 SGLang 自己的 `/v1/systemone` 的子集，而且在我们在意的部分是更窄的那个——`/v1/decisions` 的答案没有 `confidence`、选项上限 26；`/v1/systemone` 有 confidence（choice/score）、choice 最多 255、score 1–10。它多出来的 `temperature`、`prompt_format_version`、`return_prompt_token_ids` 都是调参与复现性用途，契约里没有位置；其中 `temperature` 对决策检查点也不该由调用方定——checkpoint 自带的 `decision_config.json` 里写着，`/v1/systemone` 会自动沿用。
- **`OpenAI decisions` 指 OpenAI 的 Decisions API**（`POST /v1/decisions`，题型 `predicate`／`choice`／`score`），不是 SGLang 的同名端点：两家路径相同而载荷互不兼容——题目标识 `name` 对 `id`、答案数组对映射、概率 `[{value, probability}]` 对 `{名字: float}`。SGLang 那个不做，所以「当前范围」的 provider 列表里不会有同名项。
- **拒答（refusal）走 `Warning`，不新增答案类型**：有的规范（如 OpenAI Decisions API）会让某一题返回 `type: "refusal"`——模型拒绝回答这一题，没有判断结果，也不带 `probability`／`choice`／`score`／`confidence`。它按我们的口径落成两件事：该题从 `answers` 缺席，provider 另报一条带 `questionId` 的 `Warning`；未具名的整次拒答算 provider 级失败、抛错。契约因此不需要新增答案类型——`Warning.questionId` 就是为这种情况留的。拒答只有 provider 看得到（响应里那一项写着 refusal），服务拿不到，所以它只能由 provider 自报，这正是「服务不合成警告」那条的用例。

- **`kind` 有三种**：`systemone`（vllm、SGLang、TypeSafe、OpenCode Zen 的 `/v1/systemone`）、`openai`（OpenAI Decisions API，**未对真实端点实测**，验收只到按官方载荷的夹具）与 `deepseek`（DeepSeek 官方 `POST /chat/completions`；provider 自己渲染题面、把选项折成单 token 标识符、读 top-20，见下面「`deepseek` provider」）。
- **通用 HTTP 不做**：`systemone` 换 `baseUrl` 已覆盖同类端点；要「通用」就得引入请求/响应映射配置，而契约要求「不支持的可选字段必须抛错」，通用映射无法保证这条。等出现一个 `systemone` 表达不了的具体端点再做。
- **页面分两张**：接入层的客户端半管条目的增删改（写自己的命名空间）；通道子插件的客户端半管「选当前条目 + 引导档位 + 阈值」（写自己的命名空间，跨命名空间只读条目 id）。跨命名空间写没有先例，不做。页面上的「当前应用的决策模型」只对通道这一层有意义——它不是全局开关，注册表按设计可以有多条，多个业务插件各自指名自己的条目。
- **MCP 面与策略插件不在第二步**：MCP 面是同一批工具的第二种交付，需要一个独立进程与框架无关的核心（DSH 只有 MCP 客户端，没有 MCP server 能力）；「决策模型如何在 Agent 中被使用」的策略插件要按真实场景定，否则就是替使用者预设用法。两者与通道同属这个 bundle，记为后续。

## 当前范围与非目标

第一步交付契约与注册表。第二步交付三件事，需求已厘清：

1. **provider 实现**（接入层内）：`entries` 在装载时建条目并注册，之后跟着 volatile 更新整批替换，三个 provider 都已落地。`systemone` 按「字段与后端对照」与「provider 怎么区分两家的行为」做映射与拒绝规则——`instructions` 非空抛错、富 `levels` 按 `legend` 回显核对、`labelMass` 按响应字段读并在缺席时归一到 1.0、`legend` 长度校验、后端错误码与限额连原文包成 provider 级失败；`openai` 按「`openai` provider（OpenAI Decisions API）」那节接官方载荷；`deepseek` 按「`deepseek` provider」那节接官方 chat completions（自渲染题面、单 token 标识符、top-20 读出）。三者共用同一层 HTTP 与凭据：凭据按 `apiKeyEnv` 经 `ctx.credentials` 解析（`ctx.get` 取可选服务，没装凭据子系统时用到才报错），以 `Authorization: Bearer` 放进请求。
2. **接入层的条目页**（客户端半，已落地）：设置页里的「决策模型」页签，增删改条目，密钥写凭据域；口径见「条目配置与设置页」末四条。
3. **决策通道子插件**（bundle 的新行）：工具、技能、两档引导、默认关闭的开关、可选阈值，以及它自己的页面（宿主半与页面都已落地，在独立包里）。

不在第二步：远程面（不做）、mock、通用 HTTP、MCP 面、策略插件。其余非目标见上面「做什么、不做什么」。

## 验收要点

- `pnpm --dir packages/dsh-system-one run typecheck` 同时覆盖 `src` 与 `tests`；`build` 在 `tsc` 之外多一条客户端产物（条目页），`tests/declaration-merge.spec.ts` 继续读构建产物。
- 第一步的 8 条行为测试继续通过（`ask` 交回答案与耗时、漏答的题从 `answers` 缺席且 `warnings` 原样交回、未注册 `target` 的报错点名 id、同名注册抛错、`providers()` 顺序、注册随注册方 fiber 释放、可选请求字段原样透传且 `target` 不进入 provider 请求、可信度信号与 `legend` 原样交回）。
- 条目配置：`tests/entries-config.spec.ts` 把配置契约纳入门禁——示例 patch 的键集合与 `Config` 字段逐一相等、`label` 不唯一、`id` 重复或缺失与 `kind` 越界在装载期报错并点出键名、三个 kind 的条目同时装载并各自注册、`entries` 是整字段 volatile（宿主写回门禁读的 `schema.meta.volatile`）。
- 跨包声明合并：`tests/declaration-merge.spec.ts` 在临时目录里搭一个真实消费者包跑 `tsc`，fixture 带上可选字段，并带反向对照（不 import 本包时同一个用法必须编译失败）与插件面断言（`ctx.systemOne.providers()` 取不到）。
- provider 的映射与拒绝规则按 vllm/SGLang 源码核对的**线上形状**做夹具（不按厂商身份）：`tests/systemone-provider.spec.ts` 覆盖三种题型的映射、非空 `instructions` 的拒绝、`legend` 长度与回显核对（后端把档位串化时抛错）、`labelMass` 的两种位置与缺席时的归一、后端非 2xx 连原文（当前用例以 400 与 422 为例；限额由后端校验、provider 只转述，未单设夹具）、凭据解析与 `Bearer`。
- `openai` provider：`tests/openai-provider.spec.ts` 覆盖三种题型的题面数组与答案映射、`state`／`instructions`／`images` 落成哪段 `input`、`chatTemplateKwargs` 与是非题 `optionDescriptions` 与非字符串 `Level` 的拒绝、具名拒答的缺席+警告与未具名拒答的整次失败、两个 kind 按 `target` 各自命中自己的端点；**未对真实端点实测**，接上真实端点后补一次。
- `deepseek` provider：`tests/deepseek-provider.spec.ts` 覆盖三种题型的题面与请求体（含 messages）、`labelMass`／`confidence`／`argmaxIsLabel` 的读出、标识符部分缺失时省略 `probabilities` 并报 `coverage`、`argmaxIsLabel=false` 仍取域内 argmax、`temperature 0` 症状与缺 `logprobs` 的 provider 级失败、没有标识符命中时的缺席+警告、选项/档位上限与 `chatTemplateKwargs` 拒绝、`usage`／`requests`／`modelId` 与单题 HTTP 隔离；真实端点只做 20 + 20 pilot（读数见「`deepseek` provider」一节），**不进验收门禁**。
- 决策通道（宿主半在 `packages/dsh-system-one-channel/tests/`）：工具面（一个 `ask`、`target` 不进参数、题面与答案原样透传）、开关（关掉即工具不存在且 guidance 段消失）、两档引导（第二档比第一档只多那一句）、阈值语义（两种确定性公式、算不出时按 `abstain`）、配置非法在装载期点名键名各有可跑用例；技能注册表的缺席由「不装它也能挂起来」那一条覆盖。
- 条目页（客户端半）：`tests/client.spec.tsx` 与 `tests/client-packaging.spec.ts` 把它纳入门禁——页签注册在 `settings.plugins.tab`、`whileServed` 与写回用的都是 patch 行 id `dsh-system-one`、保存是一次 `{ op: 'set', path: ['entries'] }` 的原子写入（一轮增删改结束后每条写入都落在 `entries` 上）、密钥进凭据域且配置里只有引用名（负向断言：写回值里不出现密钥）、生成的 `id` 落在凭据引用名的字符集里、已有条目默认折叠点「编辑」展开（保存后收起）、保存后条目的增删改热生效（`tests/system-one.spec.ts` 的「条目配置热生效」一组与 `tests/volatile-update.spec.ts` 的真实 Loader 链路）、协议下拉的三个取值等于 `Kind` 枚举、宿主拒绝／传输层失败／凭据拒绝各报一句话；产物是装载器认的闭包工厂（`dsh.client`、`exports['./client']`、`locale/*.json` 都在）。**真实 profile 里的视觉核对待用户执行**（核对记录见 `.scratch/dsh-system-one/manual-check-04.md` 与 `manual-check-02c.md`）。
- 真实 profile 装载：`tests/profile-load.spec.ts` 把装载路径纳入门禁——两个包 `pnpm pack` 进临时 profile（profile 由真实的 `initProfile` 初始化，`nodeLinker: hoisted`）、按 `dsh.profile.bundles` 组合出两行、用真实 Loader 启动并跑启动审计，断言**两行都 ACTIVE**、接入层的 `ctx.systemOne` 与通道的 `systemone_ask` 同时可用（经工具面调一次走完接入层，并断言题面真的进了 provider）、两行都从 profile 的安装副本解析；按 id 只禁用通道那一行时接入层照常、工具不存在，只禁用接入层那一行时通道行不激活且审计点名它在等 `systemOne`，用重新组合把那一行放开后恢复；profile 里装不上本包时该 bundle 被跳过、原因点名本包。示例 patch 的键集合与各自 schema 逐一相等由 `tests/entries-config.spec.ts`（`entries` 与条目的六个字段）与子包 `tests/channel-config.spec.ts`（通道那一行的四个字段加门槛里两个内层键，bundle 那份与子包自己那份都查）覆盖。复核记录见 `.scratch/dsh-system-one/profile-load.md`（单行）与 `.scratch/dsh-system-one/profile-load-07.md`（多行、真实 `dsh`）。
- 通道页（客户端半，在 `packages/dsh-system-one-channel/tests/`）：`client.spec.tsx` 与 `client-packaging.spec.ts` 把它纳入门禁——写回命名空间等于本行 patch 的 id `dsh-system-one-channel`（与宿主半的 `name` 同一个字符串）、只读命名空间等于接入层那一行的 id、页签注册在 `settings.plugins.tab` 且 `whileServed` 只跟自己的命名空间走、下拉的值是条目 `id`（重名追加后四位、空列表给出去哪登记的提示）、三件事各写回自己的命名空间且整个装配里没有一笔写到另一个命名空间（负向断言）、门槛关闭时数值设置整组不显示、越界在失焦时报错且一条都不写、改动即写没有保存按钮、写入按交互顺序排队、宿主拒绝与传输层失败各报一句话、页面文案不出现参数名与机制名；产物是装载器认的闭包工厂。**真实 profile 里的视觉与文案核对待用户执行**（核对记录见 `.scratch/dsh-system-one/manual-check-06.md`）。
- 端到端（真实 vllm/SGLang 端点）列为「有端点才做」，不进验收门禁。
