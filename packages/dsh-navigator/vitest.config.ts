import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Web 腿的客户端夹具直接 import 发布态 `@deepseek-ai/dsh-client-ui-primitives`，它的产物带
    // `.module.css`；让 Vite 处理这一份（`css` 默认关闭，样式被 stub），否则 Node 直接 import 会抛
    // `Unknown file extension ".css"`。只内联这一个包，其余 DSH 包仍走 Node，既有用例不受影响。
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-ui-primitives/] } },
  },
})
