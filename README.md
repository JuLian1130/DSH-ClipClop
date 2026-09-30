# DSH-ClipClop

用于 deepseek-harness 的 ClipClop 插件集合。

## 构建与测试

两个包（`packages/dsh-navigator`、`packages/dsh-reasoning-pruner`）同处一个 pnpm workspace，根上一条命令覆盖两边：

```bash
pnpm install            # 装依赖并各跑一次 prepare（= build）
pnpm run build
pnpm run typecheck
pnpm -r run test
```

单包重跑把 `pnpm run build` 换成 `pnpm --dir packages/<包名> run build` 即可。

`dsh-reasoning-pruner` 有**两个面**，产物都在 `lib/` 下：

- **host 半**（`src/`）由 `tsc -p tsconfig.json` 直出 `lib/**`，按 profile patch 装载。
- **浏览器半**（`src/client/`）由 `scripts/build-client.mjs` 用 esbuild 打成一份**发布态**的 CJS 闭包工厂
  `lib/client.js`：首行是 `window.__ModuleLoader__.load({ id, factory })`、`id` 逐字符等于包名，工厂交出的
  exports 是 `apply` 与 `inject`；`package.json` 的 `dsh.client`（`platform: 'web'`）与 `exports["./client"]`
  指向它。装载器只认这一种形状，**产物缺失会在服务构造期同步抛出**（`client bundle not found; run pnpm run
  build before launch`），不是静默跳过。

因此测试**不在测试期构建**：先跑一次 `build` 再跑 `test`。
