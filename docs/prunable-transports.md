# 可裁剪传输调研：Messages / Responses 能否丢弃历史推理

状态：**调研，未落地**。本文件回答一个问题——首版把裁剪资格钉在 `api === 'openai-completions'`（`src/replay.ts:37-39`）上，是**能力边界**还是**证据边界**？

结论：是**证据边界**。三种传输都能丢弃历史推理，但**代价与实现路径各不相同**，而且 `anthropic-messages` 的正解不是「删块」。本文不改变任何现有行为，也不主张立刻扩范围；它把「扩之前必须知道什么」写清楚。

## 证据边界

首版范围不是能力判断，原话是范围声明。`.scratch/historical-reasoning-pruning/gate-a-record.md:15-19` 的「适用范围」写了两句：

1. 结论**只在被实测的那个网关**（`api.commandcode.ai`）上成立，**不得外推**到其它网关。
2. 覆盖的是 **chat-completions 传输**——**不含** `llm-deepseek` 的 Messages 传输（那条已被「裁剪资格」排除在首版范围外）。

`docs/dsh-reasoning-pruner-design.md:234` 补了排除理由：Messages 那条「**机制更简单**，且已被裁剪资格排除」。而 `deepseek-messages` 信封被排除的直接原因是**结构上没有 `api` 字段**（同文件 `:134-135`），不是它裁不了。

⚠️ 因此「只有 chat-completions 能丢」是把**我在哪测过**读成了**哪些做得到**。本文其余部分是能力调研，**不构成任何闸门背书**。

### 版本基准与一处引用偏差

| 项 | 值 | 依据 |
| --- | --- | --- |
| DSH 基准 | `0.2.0-rc.1` | `package.json:44-45` 的 `^0.2.0-rc.1`；`packages/dsh-reasoning-pruner/node_modules` 下实装的 `dsh-llm` / `dsh-llm-pi-ai` / `dsh-llm-deepseek` / `dsh-session` 均报 `0.2.0-rc.1` |
| pi-ai | `0.85.1` | 本仓 `node_modules/.pnpm/@earendil-works+pi-ai@0.85.1*` |

两处需要留意，本文均已核对：

- **`README.zh.md:19,22` 仍写 `0.1.7-rc.2`，已过期**。基准在提交 `fc24821`（「DSH 基准升到 0.2.0-rc.1，版本声明改用 ^ 范围」）中已抬到 `0.2.0-rc.1`，README 未同步。
- **本仓的 pi-ai 副本是未打补丁的**（本仓无 `patches/` 目录），而设计文档与源码依据引用的是 DSH 检出里**已打补丁**的副本。两者相差一行，例如历史组装时的过滤：DSH 检出 `dist/api/openai-completions.js:979`，本仓同文件 `:980`。**引用 pi-ai 行号时必须写明是哪一个副本**，否则会指错行。

下文 pi-ai 行号统一以**本仓副本**为准，并在括号里给出差异说明。

## 机制回顾：两层，都不产生 400

与设计文档「裁剪资格」同源，摘要如下（细节归该文档，此处只作为判断依据）：

**第一层（服务层，按 adapter 实例）**：`packages/llm/llm/src/index.ts:991-1006` 的 `forAdapter` 在派发前剥掉历史消息上的 `replayState`——`this.adapters.get(source.provider)?.adapter === adapter` 才保留。`llm-pi-ai` 用一个 adapter 实例注册全部路由，所以 Messages / Responses / completions 之间切换**不触发**这一层；跨到 `llm-deepseek` 才触发。

**第二层（adapter 内，按 `api` 三元组）**：pi-ai `transformMessages` 是三条线共用的入口——`openai-completions.js:908`、`openai-responses-shared.js:88`、`anthropic-messages.js:779` 三处调用。其中 `dist/api/transform-messages.js:68-70`：

```js
const isSameModel = assistantMsg.provider === model.provider &&
                    assistantMsg.api === model.api &&
                    assistantMsg.model === model.id;
```

thinking 块的四种归宿（同文件 `:72-89`）：

| 情况 | 处理 | 行 |
| --- | --- | --- |
| `redacted` 且非同模型 | 丢 | `:75-77` |
| 同模型且有签名 | 保留原文（含 OpenAI 加密 reasoning） | `:80-81` |
| 文本为空 | 丢 | `:83-84` |
| 其余（跨模型但有文本） | 降级成 `{type:'text'}` | `:86-89` |

⇒ **跨模型时密文回执由客户端先丢**，不会送给不拥有它的端点。这是独立于服务端的第二道防线。

## 逐传输结论

| 传输（`api`） | 能否丢历史推理 | 现有算子能否复用 | 主要风险 |
| --- | --- | --- | --- |
| `openai-completions` | 能（**已实测**） | 是 | — |
| `openai-responses`（含 `azure-` / `codex-`） | 能 | **是**，删块 = 不发 item | 配对校验；闸门 A/B 须重测 |
| `anthropic-messages` | 能 | **否**，应改走服务端 `clear_thinking_20251015` | 连续段 / 最新回合不可改 / 前缀绑定 400 |
| `deepseek-messages` | 能 | 是 | 端点对「无签名 thinking 块」的接受度 |

### `openai-responses`（及 azure / codex 变体）

三个变体共用同一个转换器，所以结论一次覆盖三条：`azure-openai-responses.js:11` 与 `openai-codex-responses.js:14` 都从 `openai-responses-shared.js` 导入 `convertResponsesMessages`。

**线上载荷**：整个 reasoning item 的 JSON（含 `encrypted_content`）存在 `thinkingSignature` 里，回灌时原样解析回 `output`（`dist/api/openai-responses-shared.js:138-140`）：

```js
if (block.thinkingSignature) {
    const reasoningItem = JSON.parse(block.thinkingSignature);
    output.push(reasoningItem);
}
```

**因此「删块」正好等于「不发这个 item」——现有算子语义在这里天然成立**，无需新分支。`block.thinking` 存的是摘要文本（`item.summary[].text`，回退 `item.content[].text`，`:582-585`）。

请求侧在 effort/summary 存在时包含密文：`openai-responses.js:262,270`、`azure-openai-responses.js:235` 的 `params.include = ["reasoning.encrypted_content"]`。

**风险一：配对校验。** 重放 reasoning item 需连同其后的 item；pi-ai 靠跨模型时置空 `fc_*` item id 规避（`:170-177` 的注释明写 "For different-model messages, set id to undefined to avoid pairing validation"）。裁剪后若留下配对被拆开的组合，需实测确认。

**风险二：不能外推闸门读数。** `encrypted_content` 的体积与计费行为跟 `reasoning_content` 不是一回事。Gate A 记录里的 Δ=175（`gate-a-record.md:3-4`）**只在 chat-completions 上成立**。

**官方侧佐证**：OpenAI 的 [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning) 明说 `reasoning.context: "current_turn"` 下「reasoning items **can remain in the API payload for continuity, but the service does not render them into the new sample**」——即「留着但不渲染」是被支持的一等行为，比客户端删块更细。GPT-5.6 系列默认 `all_turns`。

### `anthropic-messages`

**别用删块。** 这条的正解是服务端的 thinking block clearing。

`dist/api/anthropic-messages.js:988-1015` 是 pi-ai 的序列化分支：`redacted` 块回灌成 `redacted_thinking` + `data`（`:988-993`）；**无签名**时按 `allowEmptySignature` 二选一——要么发带空签名的 `thinking`，要么**降级成普通 `text`**（`:1003-1015`）。这一分支与 DSH catalog 的 `allowEmptySignature` 开关对应。

客户端删块的三条硬约束（均来自 Anthropic 官方文档）：

- **只能从最旧端连续删**："You can remove thinking blocks from the start of the history (oldest first), from the end, or all of them. What fails is a **gap**"（[Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)）。插件「保留最近 K 步、删更旧」方向一致，但必须保证**无缺口**。
- **工具回合里最新的 assistant 消息不可改**，否则 400 `` `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified ``（[Troubleshooting](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting)）。
- **前缀绑定**：Fable 5.1 / Opus 5.5 / Sonnet 5.5 校验 `system` / `tools` / 前置 `messages`；2026-08-31 后创建的账号**默认 400**。

**服务端替代方案**（[Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)）：

```json
"context_management": { "edits": [
  { "type": "clear_thinking_20251015",
    "keep": { "type": "thinking_turns", "value": 2 } }
]}
```

两个关键性质：它是 server-side、在 prompt 到达模型前生效；且 "On Claude Fable 5.1, Claude Opus 5.5, and Claude Sonnet 5.5, **server-side context management never invalidates thinking blocks**"。默认行为本身已按模型分档（Opus 4.5+ / Sonnet 4.6+ / Fable / Mythos 保留全部，更早的只留最后一轮），`keep` 用于覆盖。

⚠️ **但 DSH 目前完全没接这条**：`packages/llm/` 与 `llm-pi-ai/src/` 里检索 `context_management` / `clear_thinking` **零命中**。所以走服务端方案需要先有上游支持，不是本插件能独立完成的。

⇒ 这条传输的取舍不只是「能不能裁」，而是**「客户端删块（伤推理连续性）」还是「等上游接服务端参数（不伤）」**。两者质量影响不同，**不能共用同一套判据**。

### `deepseek-messages`（`llm-deepseek`）

设计文档 `:234` 的判断成立：这条走 `thinking` + `signature`，块删掉就不发了。

需实测的是**缺签名时发出的形状**：`packages/llm/llm-deepseek/src/serialize.ts:31-34` 是无条件分支——

```ts
case 'reasoning': return {
  type: 'thinking', thinking: block.text,
  ...replay?.[index]?.signature === undefined ? {} : { signature: replay[index].signature },
}
```

即裁剪后（信封条目同步删掉）会发出**无签名的 `{type:'thinking', thinking:text}`**。这与 `anthropic-messages` 的 `allowEmptySignature` 分支是同类形状，但 `llm-deepseek` 没有对应开关。目标端点是否接受须实测。

### `openai-completions`（现状，作为对照）

线上字段不是通用输入字段，而是**白名单**：`OPENAI_COMPLETIONS_REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"]`（本仓 `:155`）。方向也与「支持丢弃」相反——某些网关**要求**字段存在但为空，于是补 `reasoning_content: ""`（`:1045-1048`，`requiresReasoningContentOnAssistantMessages: isDeepSeek` 在 `:1287`）。

⚠️ 措辞提醒：本仓传输字面量是 `'openai-completions'`，**不是** `chat-completions`（设计文档 `:136` 已记）。

## 若要扩范围：需要动的地方

1. **资格判定**（`src/replay.ts:37-39`）从等值判断换成**传输能力表**。当前 `'openai-completions'` 这个字面量在替两个不同事实背书：(a) 线上有没有可删的 reasoning 载荷，(b) 删了端点接不接受。各传输的答案不同。
2. **浏览器半的能力常量**（`src/client/availability.ts:33` 的 `PRUNABLE_PROTOCOL = 'openai-completions'`）必须同步，否则「设置 → 内置插件」开关的置灰状态与实际能力不一致。注意 `tests/client-grey-out.spec.ts:52-53` 现在把 `anthropic-messages` 当作**不可裁的对照组**钉着，改判定就要改这条断言。
3. **`anthropic-messages` 若走服务端方案**，则它不属于本插件的投影机制，而是请求参数——这是另一个接缝，不能复用 `pruneReasoning`。

## 未核实项（外推前必须补）

- **Gate A 只在被实测网关 + chat-completions 上成立**（`gate-a-record.md:17`）。任何新传输都要重测端点接受度。
- **Gate B（缓存净收益）与 Gate D（任务质量）对 Responses / anthropic-messages 全未测**。Responses 的 `encrypted_content` 体积与计费行为未知；anthropic-messages 的客户端删块**明确会伤同模型推理连续性**，其质量代价可能与 completions 不同量级。
- **Responses 的配对校验**在裁剪后的实际表现未实测。
- **`deepseek-messages` 端点的接受度**未实测（本文只核到会发出无签名 `thinking` 块这一事实）。

## 源码依据索引

pi-ai 行号以本仓副本为准（DSH 检出副本因打补丁少一行，见「引用偏差」）。

| 断言 | 位置 |
| --- | --- |
| `isSameModel` 三元组 | pi-ai `dist/api/transform-messages.js:68-70` |
| thinking 四种归宿 | 同上 `:72-89` |
| 三条线的 `transformMessages` 调用 | `openai-completions.js:908`、`openai-responses-shared.js:88`、`anthropic-messages.js:779` |
| Responses：reasoning item 回灌 | `openai-responses-shared.js:138-140` |
| Responses：摘要文本来源 | 同上 `:582-585` |
| Responses：配对规避 | 同上 `:170-177` |
| Responses：`include` 密文 | `openai-responses.js:262,270`；`azure-openai-responses.js:235` |
| azure / codex 共用转换器 | `azure-openai-responses.js:11`、`openai-codex-responses.js:14` |
| Anthropic：redacted 回灌 | `anthropic-messages.js:988-993` |
| Anthropic：无签名的二选一 | 同上 `:1003-1015` |
| completions：字段白名单 | `openai-completions.js:155` |
| completions：空 `reasoning_content` | 同上 `:1045-1048`、`:1287` |
| DSH：按 adapter 实例剥 replayState | `packages/llm/llm/src/index.ts:991-1006` |
| DSH：Messages 序列化分支 | `packages/llm/llm-deepseek/src/serialize.ts:31-34` |
| 插件：资格判定 | `src/replay.ts:37-39` |
| 插件：浏览器半能力常量 | `src/client/availability.ts:33` |

官方文档：[Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)、[Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)、[Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)、[Troubleshooting thinking](https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting)、[Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)。