# dsh-system-one 设计

状态：第一步（服务名、声明合并、请求/结果类型、注册表）已实装；第二步（provider 实现、设置页与远程面）未开工。

一句话：把**带类型的题面**交给某个决策模型，拿回**带概率的答案**。这一层不产出内容，也不决定答案怎么用。术语见 `CONTEXT.md` 的「决策模型接入」。

## 这一层做什么、不做什么

- **是**接入层：抹平各家决策模型接口的差异，给业务插件一个稳定的问法与答案形状。
- **不是**编排层：什么时候问、答案不可信时怎么办、要不要重试整段流程，都是业务插件的事。
- 契约里**没有**分片与 provider 侧限额（如最大 token）：怎么切、切多大由 provider 自己决定。
- 结果里**没有** `tiers`、也没有 `providerId`：消费者只知道自己点名的条目 id。
- 服务里**没有**「当前 provider」这类全局状态：每次 `ask` 都点名 `target`，用哪个条目由调用方自己的配置回答。

## 服务名与装载

服务名 `ctx.systemOne`，由 `declare module '@deepseek-ai/cordis'` 合并而来。一个包、一个装载行（`cordis.patch.yml`）。

第三方 provider 在自己的插件里 `inject: ['systemOne']` 之后调 `ctx.systemOne.register(id, provider)`。注册的生命周期跟着注册方所在的 fiber，卸载即释放；同一个 id 注册两次抛错——两个条目同名会让 `ask` 指向不确定的实现，不能静默覆盖。

## 公开面

### 插件面

`Context['systemOne']` 只声明两件事：

- `register(id, provider): Disposable`
- `ask(request: AskRequest): Promise<AskResult>`

`providers()` **不在插件面上**，尽管它是服务类上的公开方法。它一旦在插件面上可见，最省事的写法就是「拿列表挑一个」（列表长度为 1 时更顺手），那正好把「用哪个条目」变回隐式默认。约束落在类型上（`Pick<SystemOneService, 'register' | 'ask'>`），但要说清它是**名义**约束：服务类本身是导出的，一次转型就能绕过（本包的测试正是这么读它的）。它挡的是顺手用法，不是刻意绕过。

### 远程面（未交付，随第二步）

设计上只应有这一个远程例外：浏览器经 `ctx.remote.systemOne.providers()` 读到条目 id，用它的是设置页；`ask` 不在远程面上，业务插件的判断在本进程里做。

**第一步不交付它。** 只打 `@Remote` 标记是半个面：typert 的远程面要求随包交付生成产物（宿主面的 `./typert` 与客户端面的 `./remote`，本仓的 build 也就得从纯 `tsc` 换成带生成器的流水线），而消费它的客户端半属于第二步。标记单独存在时买不到任何东西，却要价一份测试期装饰器转译——所以标记、产物与转译一起在第二步落地。在那之前 `providers()` 只是服务类上的公开方法，用处是 `ask()` 报错时说明现状与测试断言注册顺序。

### provider 作者面

第三方 provider 继承 `SystemOneProvider`，实现 `evaluate(request: ProviderRequest): Promise<ProviderResponse>`：

- `ProviderRequest` = `Omit<AskRequest, 'target'>`：服务已经按 `target` 解析过了，provider 不需要知道自己的 id。
- `ProviderResponse` 只带答案与 provider 侧的自报项（`warnings`/`usage`/`requests`/`modelId`）；`AskResult` 在它之上加一项服务侧测得的 `latencyMs`，两者写成继承、不各抄一遍字段。
- `signal` 与 `timeoutMs` 由服务**原样透传**：服务自己不实现超时，也不替 provider 决定重试。
- `ProviderRequest`/`ProviderResponse` 是**给写 provider 的人**的类型面，业务插件用不到。

## 题面与答案

三种题型（是非 / 闭集单选 / 有序量表）是两套外部规范的同一种语义：jev 的 Noul、OpenAI 的 predicate 都是是非题。答案带概率而不是生成文本：是非题的 `probability` 必带，choice/score 的分布是 provider 的自报项，缺席表示没报分布、不是均匀分布。题面与答案都按 id 组织（`Record<id, …>`）：消费者按稳定 id 取答案，顺序在契约层没有用，各家规范要的 name 数组由 provider 自己转。

三种答案都可以带一个可选的 `confidence`：它是分布的集中程度，**不是答案正确的概率**。两套外部规范对它的定义与来源不一致，所以契约只把它当参考、不据此做任何判断——要不要按它设阈值是业务插件的事。

失败语义：**provider 级失败抛错**（端点不可达、凭据不对）；**单题级的答失败或漏答都不算整次失败**——该题在 `answers` 里缺席，**这是唯一的保证**。`warnings` 是 provider 的自报项（`Warning.questionId` 可选，因为警告也可能针对整次调用，例如输入被截断），服务只透传、**不为漏答补写**：漏答若要有解释，由 provider 自己给。消费者必须处理缺席。

## 已裁决的取舍

- **远程面推迟到第二步**（理由见上）：`@Remote` 标记、typert 的生成产物、以及为装饰器付出的测试期转译，一起在客户端半落地时再进来。第一步因此没有装饰器，也就没有测试期的转译配置。
- **不提供「按题型取答案」的类型映射**：没有消费者需要，需要时再按实际用法加。
- **服务不合成警告**：`warnings` 是 provider 的自报项，服务只透传。漏答的保证只有「该题不在 `answers` 里」这一条；为漏答补写一条服务自造的警告，要在契约里新增一个警告类型，而 provider 自己已解释过原因时还会与它并存，换到的只是「消费者不必自己 diff」。
- **保留可选 `confidence`**：两套外部规范都返回它，业务插件可能按它设阈值。契约只透传，不用它做任何判断。
- **第二步的 `mock`** 会是一种 provider 类型（第一步的 provider 面只有 `evaluate`，还没有 `kind` 这个配置字段），不出现在默认条目列表里。
- **`/v1/systemone` 归入 `systemone` kind，不为 SGLang 新增类型**：SGLang 在 System One 规范上加的三样东西都有默认值或只影响响应——`images` 与 `chat_template_kwargs` 默认空，`x_label_mass` 只是答案里多一个字段；它只按名拒绝 `/v1/decisions` 专有的三个字段（`temperature`、`prompt_format_version`、`return_prompt_token_ids`）。所以**符合规范的请求体原样可用**，同一个 kind 换 `baseUrl` 就覆盖 TypeSafe、OpenCode Zen 与 SGLang。
- **`/v1/score` 不做**：它是打分原语（`query` + `items` + `label_token_ids` → scores 矩阵），不是决策协议——用它就得由 provider 自己渲染题面、套 chat template、并对答案 label 做分词校验，而这些正是 `/v1/systemone` 在服务端替我们做完的事。它独家服务的那批模型（`*ForSequenceClassification`、`*ForRewardModel`）题面在训练时焊死、`is_generation` 为假，进不了决策端点，各自另有专用门面（`/v1/classify`、`/v1/rerank`），所以它对决策用途零覆盖。
- **决策端点的模型边界**：`/v1/systemone` 要求服务端是**生成模型**、且带 chat template 与 tokenizer；SequenceClassification、RewardModel、`--enable-mis`、diffusion、LoRA adapter 一律按名拒绝。决策检查点（jev／laya 一类）靠 checkpoint 自带的 `decision_config.json` 走原生 readout，没有它就走通用渲染路径——仍能出答案，只是保真度不同，接一个具体 checkpoint 时要实测走的是哪条。
- **SGLang 的 `/v1/decisions` 不做**：它对我们这个契约是 `/v1/systemone` 的子集，而且在我们在意的部分是更窄的那个——答案没有 `confidence`、选项上限 26（systemone 允许 255）、choice 与 score 的最小长度更严。它多出来的只有三样：`temperature`（只缩放选项概率）、`prompt_format_version`、`return_prompt_token_ids`，都是调参与复现性用途，契约里没有位置；其中唯一有语义的 `temperature` 对决策检查点也不该由调用方定——checkpoint 自带的那份 `decision_config.json` 里写着，`/v1/systemone` 会自动沿用。
- **`OpenAI decisions` 指 OpenAI 的 Decisions API**（`POST /v1/decisions`，题型 `predicate`／`choice`／`score`），不是 SGLang 的同名端点：两家路径相同而载荷互不兼容——题目标识 `name` 对 `id`、答案数组对映射、概率 `[{value, probability}]` 对 `{名字: float}`。SGLang 那个不做，所以「当前范围」的 provider 列表里不会有同名项。
- **拒答（refusal）走 `Warning`，不新增答案类型**：有的规范（如 OpenAI Decisions API）会让某一题返回 `type: "refusal"`——模型拒绝回答这一题，没有判断结果，也不带 `probability`／`choice`／`score`／`confidence`。它按我们的口径落成两件事：该题从 `answers` 缺席，provider 另报一条带 `questionId` 的 `Warning`；未具名的整次拒答算 provider 级失败、抛错。契约因此不需要新增答案类型——`Warning.questionId` 就是为这种情况留的。拒答只有 provider 看得到（响应里那一项写着 refusal），服务拿不到，所以它只能由 provider 自报，这正是「服务不合成警告」那条的用例。

## 当前范围与非目标

第一步只交付契约与注册表。provider 实现（`systemone`、通用 HTTP、OpenAI decisions、mock）、设置页与远程面在第二步。其余非目标见上面「做什么、不做什么」。

## 验收要点

- `pnpm --dir packages/dsh-system-one run typecheck` 同时覆盖 `src` 与 `tests`。
- 6 条行为测试：`ask` 交回答案与耗时、provider 漏答的题从 `answers` 缺席且 `warnings` 原样交回、未注册 `target` 的报错点名 id、同名注册抛错、`providers()` 顺序、注册随注册方 fiber 释放。
- 跨包声明合并：`tests/declaration-merge.spec.ts` 在临时目录里搭一个真实消费者包跑 `tsc`，并带反向对照（不 import 本包时同一个用法必须编译失败）与插件面断言（`ctx.systemOne.providers()` 取不到）。
- **尚未实测**：按真实 profile 装载这条 bundle 行——第一步的测试都用 `new Context()`，装载路径不在任何门禁里。第二步开工前补一次真实装载。
