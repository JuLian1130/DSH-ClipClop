# DSH-ClipClop

用于 deepseek-harness 的 ClipClop 插件集合。

## 构建与测试

```bash
pnpm install
pnpm --dir packages/dsh-reasoning-pruner run build      # host 半 + 浏览器半
pnpm --dir packages/dsh-reasoning-pruner run typecheck
pnpm --dir packages/dsh-reasoning-pruner run test
```

`dsh-reasoning-pruner` 有**两个面**，产物都在 `lib/` 下：

- **host 半**（`src/`）由 `tsc -p tsconfig.json` 直出 `lib/**`，按 profile patch 装载。
- **浏览器半**（`src/client/`）由 `scripts/build-client.mjs` 用 esbuild 打成一份**发布态**的 CJS 闭包工厂
  `lib/client.js`：首行是 `window.__ModuleLoader__.load({ id, factory })`、`id` 逐字符等于包名，工厂交出的
  exports 是 `apply` 与 `inject`；`package.json` 的 `dsh.client`（`platform: 'web'`）与 `exports["./client"]`
  指向它。装载器只认这一种形状，**产物缺失会在服务构造期同步抛出**（`client bundle not found; run pnpm run
  build before launch`），不是静默跳过。

因此测试**不在测试期构建**：先跑一次 `build` 再跑 `test`。
