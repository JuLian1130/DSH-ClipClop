/**
 * 浏览器半的打包步骤：把 `src/client/` 打成**发布态**的 CJS 闭包工厂。
 *
 * 产物形状是装载器的硬约束（`packages/client/tsdown.client.ts` 的 banner/intro/footer）：文件在浏览器里以
 * `window.__ModuleLoader__.load({ id, factory })` 注册，`factory(require)` 返回模块的 exports（`apply` 与
 * `inject`）。**id 逐字符等于包名**，所以从 package.json 读，不手写第二份。
 *
 * external 就是产物实际 `require` 的那几个：react、react/jsx-runtime，以及平台模块表里的
 * `@deepseek-ai/dsh-client-ui-primitives`（开关行的 `Switch`）。其余跨包协作一律走 cordis 服务
 * （`import type` 在产物里被擦除），所以没有别的 external——**值引用别的 DSH 包会在这里被内联**，那是错的。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

await build({
  entryPoints: [fileURLToPath(new URL('../src/client/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../lib/client.js', import.meta.url)),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  // esbuild 没有独立的 `intro`，所以 DSH 的 banner+intro 两段在这里合成一段；footer 照旧收口。
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {\n`
      + 'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
})
