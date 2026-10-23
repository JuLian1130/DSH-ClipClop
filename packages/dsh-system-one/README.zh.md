# dsh-system-one

决策模型的接入层：把带类型的题面（是非／单选／量表）交给一个条目，拿回带概率、可审计的答案。本包同时是 bundle 与接入层——它提供 `ctx.systemOne` 注册表，并把配置里的**条目**在装载时建好、注册进去。

当前状态：契约、注册表与条目配置已落地。两个 `kind` 的 provider 实现还没有，所以现在配了条目会在装载期报「这个 kind 没有实现」——这是预期状态，不是配置写错了。

## 安装

本包 `private: true`，不发布到 registry。装进 profile 的必须是预构建产物（安装不执行构建脚本）：

```bash
cd packages/dsh-system-one
./node_modules/.bin/tsc -p tsconfig.json      # 产出 lib/
pnpm pack --pack-destination /tmp/dsh-system-one
dsh plugin --profile <name> add /tmp/dsh-system-one/dsh-clipclop-dsh-system-one-*.tgz --ignore-scripts
```

包声明了 `dsh.bundle.patch`，安装会把它自动追加进 profile 的 `dsh.profile.bundles`，不必手改。装完重启 DSH（或让 profile 重载）——`dsh --profile <name> --dump-config` 里出现 `id: dsh-system-one` 这一行即装载成功。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id `dsh-system-one` 覆写。profile 层在 bundle 层之后应用，所以这一条盖得住包内的默认值。

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `id` | 是 | 内部标识，**唯一**。`ask` 的 `target` 用它指名条目。由系统生成：页面新增条目时自动生成，手写 patch 时自己给一个唯一值（例如 `sglang-local`）。 |
| `label` | 是 | 显示名称，给人看。**可以不唯一**：两个条目都叫「本地 SGLang」是合法的。 |
| `kind` | 是 | 协议，二选一：`systemone`（vllm／SGLang／TypeSafe 的 `/v1/systemone`）或 `openai`（OpenAI Decisions API）。 |
| `baseUrl` | 是 | 端点地址。 |
| `model` | 是 | 模型名。 |
| `apiKeyEnv` | 否 | 凭据的**引用名**。密钥本身不写进配置文件（它进凭据域），这里只留名字；页面新增条目时默认填该条目的 `id`，也可以改成自己的环境变量名。留空＝不带凭据。 |

```yaml
- id: dsh-system-one
  config:
    entries:
      - id: sglang-local
        label: 本地 SGLang
        kind: systemone
        baseUrl: http://127.0.0.1:30000
        model: qwen3-4b
      - id: openai-decisions
        label: OpenAI Decisions
        kind: openai
        baseUrl: https://api.openai.com
        model: gpt-5
        apiKeyEnv: OPENAI_API_KEY
```

`entries` 默认是空数组：不配条目时注册表为空，`ask` 点名任何条目都会报错并列出已注册的 id。配置非法一律在装载期报错并点出键名（`id` 缺失或重复、`kind` 不在两个取值里、`kind` 没有对应实现）。

条目在 **profile 装载时**注册：改完条目（含地址、模型、凭据引用名）要重载 profile（重启 DSH）才会生效。
