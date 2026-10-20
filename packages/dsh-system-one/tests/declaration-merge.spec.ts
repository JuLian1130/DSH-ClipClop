import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 跨包声明合并：`declare module '@deepseek-ai/cordis'` 把 `ctx.systemOne` 合进宿主 `Context`。
 *
 * 这件事**包内 typecheck 与包内测试都看不见**——只有在另一个包里 import 本包、且两边解析到同一份
 * cordis 时才成立。所以本文件在临时目录里搭一个真实消费者包跑 `tsc`，并配一个反向对照证明这个检查
 * 真会红。
 *
 * 需要构建产物（消费者读的是 `lib/index.d.ts`）：先跑 `pnpm --dir packages/dsh-system-one run build`。
 */

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = join(packageDir, 'node_modules', '.bin', 'tsc')

// 消费者必须开着这两个开关：本包与 DSH 的声明文件里保留 `.ts` 说明符（本仓 tsconfig.base.json 同款）。
const CONSUMER_TSCONFIG = `${JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: true,
    noEmit: true,
  },
  include: ['src/**/*.ts'],
}, undefined, 2)}\n`

const IMPORT_PACKAGE = "import type {} from '@dsh-clipclop/dsh-system-one'\n"

/** 只用插件面的消费者：能编译过，当且仅当声明合并落到了宿主那份 cordis 上。 */
const ASK = `${IMPORT_PACKAGE}import type { Context } from '@deepseek-ai/cordis'

declare const ctx: Context
export const asked: Promise<unknown> = ctx.systemOne.ask({
  target: 'x',
  state: null,
  questions: {
    q: {
      type: 'choice',
      instructions: 'q?',
      options: ['a', 'b'],
      optionDescriptions: { a: 'first' },
    },
    s: {
      type: 'score',
      instructions: 's?',
      levels: ['low', { label: 'high' }],
    },
  },
  instructions: 'shared',
  images: ['data:image/png;base64,AAAA'],
  chatTemplateKwargs: { enable_thinking: false },
})
`

/** 反向对照：拿掉类型 import，同一个用法必须编译不过。 */
const ASK_WITHOUT_IMPORT = ASK.replace(IMPORT_PACKAGE, '')

/** 插件面收窄成 register/ask：`providers()` 在服务类上，从 `ctx.systemOne` 上取不到。 */
const PROVIDERS = `${IMPORT_PACKAGE}import type { Context } from '@deepseek-ai/cordis'

declare const ctx: Context
export const ids: readonly string[] = ctx.systemOne.providers()
`

let fixture: string | undefined

/** 搭一个真的消费者包：依赖都软链到本包自己解析到的物理副本，模拟宿主供给唯一实例。 */
beforeAll(() => {
  if (!existsSync(join(packageDir, 'lib', 'index.d.ts'))) {
    throw new Error('declaration-merge.spec.ts 需要构建产物：先跑 pnpm --dir packages/dsh-system-one run build')
  }
  fixture = mkdtempSync(join(tmpdir(), 'dsh-system-one-merge-'))
  mkdirSync(join(fixture, 'src'), { recursive: true })
  const deps = [
    ['@deepseek-ai', 'cordis'],
    ['@dsh-clipclop', 'dsh-system-one'],
  ] as const
  for (const [scope, name] of deps) {
    mkdirSync(join(fixture, 'node_modules', scope), { recursive: true })
    const target = name === 'dsh-system-one' ? packageDir : realpathSync(join(packageDir, 'node_modules', scope, name))
    symlinkSync(target, join(fixture, 'node_modules', scope, name), 'dir')
  }
  writeFileSync(join(fixture, 'tsconfig.json'), CONSUMER_TSCONFIG)
})

afterAll(() => {
  if (fixture !== undefined) rmSync(fixture, { recursive: true, force: true })
})

/** 把消费者源码换成 `source`，用它自己的 tsconfig 跑一次真实 tsc。 */
function typecheck(source: string): { ok: boolean; output: string } {
  const root = fixture!
  writeFileSync(join(root, 'src', 'index.ts'), source)
  const result = spawnSync(tsc, ['-p', join(root, 'tsconfig.json')], { encoding: 'utf8' })
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

describe('跨包声明合并（真实消费者包 + 真实 tsc）', () => {
  it('消费者 import 本包后，ctx.systemOne 有类型', { timeout: 30_000 }, () => {
    const { ok, output } = typecheck(ASK)
    expect(output).toBe('')
    expect(ok).toBe(true)
  })

  it('对照：不 import 本包时同一个用法编译不过', { timeout: 30_000 }, () => {
    const { ok, output } = typecheck(ASK_WITHOUT_IMPORT)
    expect(ok).toBe(false)
    expect(output).toContain('systemOne')
  })

  it('插件面上取不到 providers()', { timeout: 30_000 }, () => {
    const { ok, output } = typecheck(PROVIDERS)
    expect(ok).toBe(false)
    expect(output).toContain('providers')
  })
})
