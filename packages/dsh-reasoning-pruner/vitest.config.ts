import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 客户端 bundle 从平台模块表里 `require('@deepseek-ai/dsh-client-ui-primitives')`（本行用它的 `Switch`），
    // 夹具因此直接 import 发布态的它；它的产物带 `.module.css`。让 Vite 处理这一份（`css` 默认关闭，样式被
    // stub），否则 Node 直接 import 会抛 `Unknown file extension ".css"`。只内联这一个包，其余 DSH 包仍走 Node。
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-ui-primitives/] } },
  },
})
