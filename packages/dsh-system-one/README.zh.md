# dsh-system-one

决策模型的接入层：把带类型的题面（是非／单选／量表）交给一个条目，拿回带概率、可审计的答案。本包同时是 bundle 与接入层——它提供 `ctx.systemOne` 注册表，并把配置里的**条目**在装载时建好、注册进去。

当前状态：契约、注册表、条目配置与 `systemone` 协议（vllm／SGLang 的 `/v1/systemone`）的 provider 已落地。`openai` 协议还没有实现，所以配了那种条目会在装载期报「这个 kind 没有实现」——这是预期状态，不是配置写错了。

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

## `systemone` 协议怎么接

- **端点**是 `baseUrl` + `/v1/systemone`。`baseUrl` 填服务根地址（例如 `http://127.0.0.1:30000`），不要带 `/v1`。
- **凭据**：`apiKeyEnv` 非空时，每次调用都经凭据服务重新解析，以 `Authorization: Bearer <值>` 带上。引用名没配置、或 profile 没装载凭据子系统时，这次调用直接失败并说明是哪一条——不会当成「没有凭据」静默发出去。
- **限额由后端校验**：题数、选项数、量表档位数这些各家不同，provider 不抄一份到客户端；超限时那次调用失败，错误里带后端原文（它本来就点着字段）。
- **请求级 `instructions` 不支持**：传了非空值直接报错。vllm 认它、SGLang 会静默忽略，两边没法都如实表达，所以按「不证实即不支持」处理。
- **量表档位只有字符串在两边都被忠实支持**：provider 拿回读的档位值（`legend`）与请求的档位逐项核对，后端若把富档位串化成字符串（vllm 会），就报错并点出 `levels`。
- **`state` 原样透传**：SGLang 只收字符串、对象、数组，`null` 或标量会被它拒绝（422），provider 把那次调用判失败并带原文。
