# dsh-system-one 设计

状态：第一步（服务名、声明合并、请求/结果类型、注册表）已实装，契约已按 vllm 与 SGLang 的 `/v1/systemone` 补齐可选字段与可信度信号；第二步（provider 实现、接入层的条目页、决策通道子插件与其页面）需求已厘清、未开工，范围见「当前范围与非目标」，机制见「决策通道」。远程面不做。

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

- `instructions`（整次请求）：放在所有题之前的一段共享上下文；目前只有 vllm 的 `/v1/systemone` 有它（固定 prompt 的模型会 400），SGLang 没有。发给 SGLang 的 provider 收到非空值必须抛错——SGLang 会静默忽略未知顶层字段，不能让它悄悄丢掉。
- `optionDescriptions`（是非题与单选）：把两侧/各选项的含义单列出来；缺席表示含义写在 `instructions` 里。两边都支持，且都按字符串忠实渲染。是非题的 key 用 `true`/`false`，与答案的 `probability` 对齐，不用后端的 `yes`/`no`。
- `levels`（量表）：每档是 `Level`（字符串或 JSON 对象/数组）。字符串是两边的公共集；富值只有 SGLang 原样保留，vllm 会 `str()` 化，所以 vllm provider 必须拒绝非字符串档位。
- `images`（整次请求）：图片 URL 或 data URL；两边都收字符串。模型不支持图片时由后端报错。
- `chatTemplateKwargs`（整次请求）：传给 chat template 的参数。两边都收，但都会按自己的模板规则校验或拒绝；vllm 的固定 prompt 模型可能忽略它，所以它是 **best-effort**，契约不据此保证效果。

答案的可信度信号：

- `confidence`：provider 自报的集中程度，**不是答案正确的概率**。定义随 provider 而变（vllm 是选中标签在全词表上的概率；SGLang 是 TypeSafe adapter 的归一化公式，忽略标签外的质量），**不可跨 provider 比较**；是非题在 SGLang 上缺席。
- `labelMass`：答案标签在整个词表上的概率质量，0–1。vllm 放在每题的 `diagnostics.label_mass`，SGLang 放在答案的 `x_label_mass`；SGLang 在只对允许项打分的 checkpoint（Clef/joint schema、decision checkpoint）上省略，`systemone` provider 遇到省略时按 1.0 归一化。契约里它是可选项，缺席表示 provider 没报。
- `argmaxIsLabel`：读位置的最高概率 token 是否属于答案标签；只有 vllm 测得到，SGLang 缺席。缺席不是 `true`/`false`，消费者不能把它当默认值。
- `legend`：量表答案回显“第 i 档的值”，与请求的 `levels` 同序；vllm 与 SGLang 都回，只是 SGLang 能回 JSON 原值、vllm 只回字符串。provider 把它转成数组，长度必须等于 `levels`。

失败语义：**provider 级失败抛错**（端点不可达、凭据不对、后端 400/422/501）；**单题级的答失败或漏答都不算整次失败**——该题在 `answers` 里缺席，**这是唯一的保证**。provider 若无法隔离单题失败（vllm/SGLang 的整请求校验就是如此），只能整次抛错；缺席的保证只在 provider 能隔离时成立。`warnings` 是 provider 的自报项（`Warning.questionId` 可选，因为警告也可能针对整次调用，例如输入被截断），服务只透传、**不为漏答补写**：漏答若要有解释，由 provider 自己给。消费者必须处理缺席。

**不支持的可选字段必须抛错，不得静默忽略**：请求字段（`instructions`、富 `levels` 等）在某个 provider 上无法如实表达时，provider 要报错并点名字段；响应字段（`labelMass`、`argmaxIsLabel`、`legend`）是 optional，缺席有明确含义，不是某个默认值。

`state` 是**必填**字段，但不是每个后端都能表达任意 JSON：SGLang 只收字符串/对象/数组。provider 遇到 `null` 或标量时同样抛错并点名字段——不字符串化、不包成对象。把它悄悄改写成另一种形状等于换掉判断依据，比报错更糟。

### 字段与后端对照

| 契约字段 | vllm `/v1/systemone` | SGLang `/v1/systemone` | 不支持时 |
| --- | --- | --- | --- |
| `labelMass` | `diagnostics[qid].label_mass` | `answers[qid].x_label_mass`；Clef/joint schema 与 decision checkpoint 省略 | 缺席=没报；provider 对省略按 1.0 归一化 |
| `argmaxIsLabel` | `diagnostics[qid].argmax_is_label` | 无 | 缺席 |
| `images` | `images`（字符串 URL/data URL） | `images`（字符串或 `{url, detail}`） | 模型不支持图片时后端 400 |
| `instructions` | `instructions` | 无；未知顶层字段被忽略 | SGLang provider 抛错 |
| `optionDescriptions` | `criteria` 里的描述 | 同左 | 无 |
| 富 `levels` | 会 `str()` 化 | 原样保留 | vllm provider 抛错 |
| `chatTemplateKwargs` | `chat_template_kwargs`；固定 prompt 模型可能忽略 | `chat_template_kwargs`；Clef 拒绝非空 | 后端 400；标注 best-effort |
| `legend` | score 答案的 `legend`（字符串） | score 答案的 `legend`（可为 JSON） | 长度不符时 provider 抛错 |

后端限额与边界由 provider 校验，契约不承诺统一：题数（vllm 64；SGLang 无文档上限）、choice 选项（vllm 26，d3 255；SGLang 1–255，>26 需 tokenizer 支持双字母 label）、score 档位（vllm 2–10；SGLang 1–10）、`state`（vllm 任意 JSON；SGLang 只收字符串/对象/数组，`null`/标量 422）、question id（vllm 非空；SGLang 允许空）、`model`（vllm 可选；SGLang 必填）。

以上限额与边界按 2026-10-20 的 vllm 与 SGLang 源码核对；接新版本时以实际源码为准。

## 条目配置与设置页

`entries` 是本包唯一的配置项：一个扁平对象数组，每项是 `{ id, label, kind, baseUrl, model, apiKeyEnv? }`。`id` 是内部标识，唯一、由系统生成（页面新增条目时生成一个可读 slug，例如 `sglang-local-3f9c`；手写 patch 时自己给一个唯一值），消费者按它指名条目；`label` 是给人看的名称，**可以不唯一**（两个条目都叫「本地 SGLang」是合法的）。默认空数组，示例只以注释形式出现在 `cordis.patch.yml`，不指向任何真实部署。装载时按数组建条目并注册——`kind` 经**工厂表**映射到 provider 实现，枚举内有值但没有工厂时在加载期报错并点出 `kind`（不能让一个没有实现的条目注册成功、到 `ask` 时才炸）；重复 `id` 仍按既有规则抛错。

**为什么 id 不能由用户填**：供应商名、模型、地址、协议这四项都不唯一，把其中任何一个当键，都会出现两个条目同名、`ask` 指向不确定实现的局面——这正是第一步「同名注册抛错」要防的事，所以在源头就给它一个系统生成的唯一 id。

**用扁平对象 + `kind` 枚举，不用判别联合**：两种协议（`systemone`、`openai`）共用同一组字段，字段不随 kind 变化；判别联合只在字段随 kind 变化时才需要，而通用 HTTP 不做，那个需求不存在。

**`entries` 整字段 `.volatile()`**：设置页的写回路径只接受 volatile 路径；而 volatile 只能落在顶层固定字段路径（数组元素内部再放会被拒），所以标记打在整个 `entries` 上。

**条目页**（客户端半）做增删改：名称、模型、API 地址、协议（下拉两种）、API 密钥（可选）。内部 `id` 不由用户输入——新增时生成、之后只读显示（供复制到消费者的配置里）。密钥字段把值写进凭据域（`$DSH_HOME/.credentials.yaml`），配置里只留引用名 `apiKeyEnv`——先例是设置页里的 WebSearchCard，「written through the credentials domain, never into the settings section」。**引用名的默认值 = 条目 `id`**（新增时自动填）；高级用法仍可在 patch 里把 `apiKeyEnv` 覆盖成自己的环境变量名。

## 决策通道（第二步）

接入层之上有一个子插件，把决策判断交给 agent：需要判断、选择或评分时调它，而不是让主模型自己拿主意。它按第三方 provider 的用法接注册表（`inject: ['systemOne']` 后注册），用哪个条目由它自己的配置回答——接入层不因此新增插件面，也不因此获得全局状态。

**工具面只有一个 `ask`**：参数是 `state`（契约里必填，供判断的状态）与 `questions`（id → 题型内联，每题自带 `instructions`）。请求级的 `instructions`、`images`、`chatTemplateKwargs` **不暴露给模型**——`instructions` 是 vllm 独有、SGLang 会抛错，暴露它等于给模型一个会踩的坑；`images` 模型产不出来；`chatTemplateKwargs` 是部署参数。`signal` 从工具执行上下文透传；`timeoutMs` 若上下文给出 deadline 就转成它，否则不传（工具运行上下文的字段形状尚未核实，实现票里核一次）。`target` 不进工具参数。不按题型拆成多个工具，也不提供排序、判定这类契约里没有的复合操作——生态里「少而正交」是共识，而契约本来就是一次批量 `ask`。

**引导分两档，设置页切换，默认第一档**：第一档是工具描述 + 一个技能（工具描述就是给模型看的——DSH 会把每个工具的 guidance 段渲染进系统提示；技能登记进 DSH 的技能注册表，正文随包交付，写「什么时候该用、什么时候是类别错误」的细则）；第二档在第一档之上再经 `dsh-system-prompt` 的 `PromptSection` 注册表注入一句固定引导（该注册表存在，`section` 的签名尚未核实，实现票里先核）。技能注册表声明为**可选**依赖：profile 没组合技能子系统时插件照常加载，只是少一个技能。不做更强形态（拦截或替换主模型的判断）——那是编排层的事，且要动全局行为。

**开关默认关闭，关掉即不注册工具**：工具不存在，它的 guidance 段也不存在。本仓先例是改 agent 行为的能力默认关闭；`ctx.tools.register` 返回 disposer，配合 `ctx.effect` 的动态注册有现成写法（`dsh-tool-subagent` 与 `dsh-experimental-tool-agent-team` 各一处）。

**阈值默认不设，设置页可开可设**：开启后每题给一个确定性——是非题用 `|probability − 0.5| × 2`，choice/score 用 provider 自报的 `confidence`；低于阈值该题标 `abstain`，答案与概率仍原样交回。provider 没报可信度、分布也缺席时确定性算不出来，同样标 `abstain` 并写明原因——「判不出来」不等于「放行」。标记的形状是工具返回里新增的一层 `decisions: Record<题 id, { verdict: 'act' | 'abstain'; reason?: string }>`；阈值关闭时这一层不出现，`answers` 本体不变。阈值只进配置、不进工具参数（取值 0–1，越界按配置非法在加载期报错）：模型能自己放宽的闸门不是闸门。确定性公式是我们给的语义，而 provider 的 `confidence` 定义各不相同，同一阈值在不同 provider 上松紧不同——这一点要写进页面文案与 README，工具描述里也要说明 `decisions` 层的含义（`abstain` 是「低于你设的可信度门槛」，不是「答案错了」）。

不采用生态里「由判定器决定要不要披露这个工具」的做法：mu 的实测记录是它在 Terminal-Bench 2.1 上被问了 162 次、从未生效，交互会话里问了 34 次、一个都没打开，还让每轮等待（p50 0.91 s / p90 8.9 s）。开关由使用者控制。

**通道的页面**（客户端半）管三件事：选当前条目（选项跨命名空间读条目页那份 `entries`）、切引导档位、开/设阈值。跨命名空间只读不写——写没有先例。

## 已裁决的取舍

- **远程面不做**（理由见上）：设置页改从配置命名空间读，注册表不需要远程面，`@Remote` 标记、typert 的生成产物与带生成器的流水线因此都不进来。
- **不提供「按题型取答案」的类型映射**：没有消费者需要，需要时再按实际用法加。
- **服务不合成警告**：`warnings` 是 provider 的自报项，服务只透传。漏答的保证只有「该题不在 `answers` 里」这一条；为漏答补写一条服务自造的警告，要在契约里新增一个警告类型，而 provider 自己已解释过原因时还会与它并存，换到的只是「消费者不必自己 diff」。
- **保留可选 `confidence`，另加 `labelMass`/`argmaxIsLabel`**：三者都是可信度信号，业务插件可能按它们设阈值。定义随 provider 而变、不可跨 provider 比较，契约只透传，不用它们做任何判断。
- **`mock` 不做**：生态里的 mock 解决的是「无网络无凭据也能断言精确值」，本仓这个角色由测试期的进程内假 provider 承担（第一步的 8 条行为测试已经这么用）。
- **8 个可选字段进契约**：`labelMass`、`argmaxIsLabel`、`images`、`instructions`、`optionDescriptions`、富 `levels`、`chatTemplateKwargs`、`legend`。`cacheSalt`、`priority`、`requestId` 只记录用途，不进契约（等真实的运维/追踪需求）；`audio`/`videos` 也不进，只加 `images`。
- **provider-specific 字段进同一契约，靠“不支持就抛错”兜住**：请求字段在某个 provider 上无法如实表达时抛错并点名字段（尤其 SGLang 的 `instructions`、vllm 的富 `levels`）；响应字段 optional，缺席有明确语义。这样既不丢有场景的能力，也不会静默换掉答案依据。
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

- **`kind` 只有两种**：`systemone`（vllm、SGLang、TypeSafe、OpenCode Zen 的 `/v1/systemone`）与 `openai`（OpenAI Decisions API）。后者**未对真实端点实测**，验收只到按官方载荷的夹具，接上真实端点后补一次。
- **通用 HTTP 不做**：`systemone` 换 `baseUrl` 已覆盖同类端点；要「通用」就得引入请求/响应映射配置，而契约要求「不支持的可选字段必须抛错」，通用映射无法保证这条。等出现一个 `systemone` 表达不了的具体端点再做。
- **页面分两张**：接入层的客户端半管条目的增删改（写自己的命名空间）；通道子插件的客户端半管「选当前条目 + 引导档位 + 阈值」（写自己的命名空间，跨命名空间只读条目 id）。跨命名空间写没有先例，不做。页面上的「当前应用的决策模型」只对通道这一层有意义——它不是全局开关，注册表按设计可以有多条，多个业务插件各自指名自己的条目。
- **MCP 面与策略插件不在第二步**：MCP 面是同一批工具的第二种交付，需要一个独立进程与框架无关的核心（DSH 只有 MCP 客户端，没有 MCP server 能力）；「决策模型如何在 Agent 中被使用」的策略插件要按真实场景定，否则就是替使用者预设用法。两者与通道同属这个 bundle，记为后续。

## 当前范围与非目标

第一步交付契约与注册表。第二步交付三件事，需求已厘清：

1. **provider 实现**（接入层内）：`entries` 在装载时建条目并注册；`systemone` provider 按上面的字段对照与限额做映射与拒绝规则（SGLang 的 `instructions` 抛错、vllm 的富 `levels` 抛错、SGLang 缺 `x_label_mass` 时按 1.0 归一化、`legend` 长度校验、后端错误码），`state` 在 SGLang 上无法表达时抛错（见「题面与答案」）；`openai` provider 接 OpenAI Decisions API 的载荷。凭据按 `apiKeyEnv` 经 `ctx.credentials` 解析。
2. **接入层的条目页**（客户端半）：增删改条目，密钥写凭据域。
3. **决策通道子插件**（bundle 的新行）：工具、技能、两档引导、默认关闭的开关、可选阈值，以及它自己的页面。

不在第二步：远程面（不做）、mock、通用 HTTP、MCP 面、策略插件。其余非目标见上面「做什么、不做什么」。

## 验收要点

- `pnpm --dir packages/dsh-system-one run typecheck` 同时覆盖 `src` 与 `tests`；`build` 在 `tsc` 之外多一条客户端产物（条目页），`tests/declaration-merge.spec.ts` 继续读构建产物。
- 第一步的 8 条行为测试继续通过（`ask` 交回答案与耗时、漏答的题从 `answers` 缺席且 `warnings` 原样交回、未注册 `target` 的报错点名 id、同名注册抛错、`providers()` 顺序、注册随注册方 fiber 释放、可选请求字段原样透传且 `target` 不进入 provider 请求、可信度信号与 `legend` 原样交回）。
- 跨包声明合并：`tests/declaration-merge.spec.ts` 在临时目录里搭一个真实消费者包跑 `tsc`，fixture 带上可选字段，并带反向对照（不 import 本包时同一个用法必须编译失败）与插件面断言（`ctx.systemOne.providers()` 取不到）。
- provider 的映射与拒绝规则按 vllm/SGLang 源码核对的夹具测：三种题型的映射、可选字段的拒绝（SGLang 的 `instructions`、vllm 的富 `levels`）、SGLang 缺 `x_label_mass` 时的归一化、`legend` 长度校验、后端错误码。
- `openai` provider：按官方载荷的夹具与拒绝规则验收；**未对真实端点实测**，接上真实端点后补一次。
- 决策通道：工具面（一个 `ask`、`target` 不进参数、题面与答案原样透传）、开关（关掉即工具不存在且 guidance 段消失）、两档引导、阈值语义（两种确定性公式、算不出时按 `abstain`）各有可跑用例。
- 真实 profile 装载：`tests/profile-load.spec.ts` 把装载路径纳入门禁——`pnpm pack` 进临时 profile、按 `dsh.profile.bundles` 组合出这一行、用真实 Loader 启动并跑启动审计，断言该行 ACTIVE 且 `ctx.systemOne` 注册假 provider 后 `ask` 成功；profile 里装不上本包时该 bundle 被跳过、原因点名本包（复核记录见 `.scratch/dsh-system-one/profile-load.md`）。bundle 加上通道行后**仍需**复验多行 patch。
- 端到端（真实 vllm/SGLang 端点）列为「有端点才做」，不进验收门禁。
