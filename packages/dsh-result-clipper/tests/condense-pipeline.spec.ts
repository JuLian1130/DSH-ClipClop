/**
 * 票 15 判据 1/2/3/4/5/10：精简层接进 `tools/post-execute` 流水线。
 *
 * 观察面全是**端到端**的：`ctx.tools.execute` 交回给模型的正文、假 spill 后端收到的写入、debug JSONL 的
 * 「结果取值 + `condense` 观测」。夹具**不传** `condense` / `condenseMinUnits`，所以走的就是部署默认值
 * （总开关开、尺寸下限 128 估算单位、净收益阈值 24 估算单位、封顶头 50 / 尾 200 / 触发 300 行 / 单行 2000
 * 字符）——这正是本票「装上去默认就生效」的观察面。
 *
 * 四类结果取值在这里各有一条正对照：`condensed`、`condense-off`、`condense-abstained`、
 * `condense-not-shorter`；另有一条负对照说明「本层一处都没改动时不表态」。
 *
 * @module
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config } from '../src/index.ts'
import { WHOLE_RESULT } from '../src/extract.ts'
import { exec, mount, textOf, textTool } from './support/host.ts'
import type { HostFixture } from './support/host.ts'
import { AGGREGATE_LINE, GIT_DIFF_ARGS, GIT_DIFF_BODY } from './support/gitdiff.ts'
import { FakeRoute, requestText } from './support/route.ts'
import { FakeSpill } from './support/spill.ts'

/**
 * 400 行正文：超过尾部封顶的**触发**行数（默认 300），所以封顶会丢掉中间 150 行、只留头 50 + 尾 200。
 * 它是本票的「有损」样本：替换必须写出回退入口。
 */
const LONG_LINES_BODY = Array.from({ length: 400 }, (_, index) => `line-${String(index).padStart(3, '0')}`).join('\n')

/** 刚过摘要下限的正文（估价 1254 估算单位）：用来对照「精简过的不再进摘要」。 */
const LONG_BODY = 'x'.repeat(5000)

/**
 * 改了但省不到净收益阈值的正文：200 行互不相同的短行之后有一个三行的相邻游程。游程去重只省下几个字符，
 * 换算成估算单位不到阈值 24，所以判定落在 `condense-not-shorter` 上（不是「没改动」）。
 */
const NOT_SHORTER_BODY = [
  ...Array.from({ length: 200 }, (_, index) => `l${index}`),
  'REPEAT', 'REPEAT', 'REPEAT',
].join('\n')

/** 低于尺寸下限的短结果：本层一处都不会改动。 */
const SHORT_BODY = 'short body'

/** 摘要模型回的短说明。 */
const SUMMARY = '摘要正文-SENTINEL-6a1c'

/** 一条 `summarize` 答复。 */
const SUMMARY_REPLY = JSON.stringify({ action: 'summarize', summary: SUMMARY })

const open: HostFixture[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (fixture) => { await fixture.dispose() }))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 一个全新的临时目录。 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-result-clipper-condense-pipeline-'))
  roots.push(root)
  return root
}

/**
 * 装一份被测插件并登记收场：debug 默认开启（本层唯一的观测面就是它写出的那条记录）。
 * @param config - 覆盖默认的插件配置；**不传** `condense` 与六个参数就走部署默认。
 * @param route - 摘要请求要用的假 route；不给时 context 里没有 `llm` 服务。
 * @param spill - 假 spill 后端；显式传 `null` 表示没有后端（有损替换的回退入口就此写不成）。
 * @returns 夹具与 debug 日志路径。
 */
async function mounted(
  config: Schemastery.TypeS<typeof Config> = {},
  route?: FakeRoute,
  spill: FakeSpill | null = new FakeSpill(),
): Promise<{ fixture: HostFixture, path: string }> {
  const path = join(tempRoot(), 'debug.jsonl')
  const fixture = await mount({ debug: true, debugPath: path, ...config }, undefined, route, spill)
  open.push(fixture)
  return { fixture, path }
}

/** 读回一整份 JSONL，逐行解析。 */
function readRecords(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** 记录去掉耗时后逐字比较：同一份输入在「装与不装精简层」两臂上必须给出同一条记录。 */
function withoutDuration(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return records.map((record) => ({ ...record, durationMs: 0 }))
}

/**
 * 一个像真实 shell 那样报告截断的工具：`value` 是 `{ stdout, stderr }`，正文由 `render` 投影出来。
 * @param truncated - `stdout.truncated` 的取值（真工具写布尔；夹具也用它试「形状不认识」的读法）。
 * @param body - 模型可见的正文。
 * @returns 注册用的工具定义。
 */
function shellResultTool(truncated: boolean | string, body: string): ToolDefinition {
  return defineTool({
    name: 'bash',
    description: 'bash',
    parameters: {},
    output: {
      // `value` 的形状由这条工具自己声明；本插件只从里面读两个截断布尔，读不到就当没有。
      schema: { type: 'json' },
      render: (): [{ type: 'text', text: string }] => [{ type: 'text', text: body }],
    },
    async execute() {
      return { stdout: { truncated }, stderr: { truncated: false } }
    },
  })
}

describe('票 15 判据 1：默认部署下大 shell 结果就变短', () => {
  it('默认部署（不传 condense）下，一条 400 行的 bash 结果被尾部封顶替换，并带指向原文的入口说明', async () => {
    const { fixture, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_LINES_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    const text = textOf(result.content)
    expect(result.isError).toBe(false)
    expect(text).not.toBe(LONG_LINES_BODY)
    expect(text.length).toBeLessThan(LONG_LINES_BODY.length)
    expect(text).toContain('…[省略 150 行]')
    // 入口说明用的是「精简」的措辞而不是摘要（被丢掉的不是模型的改写，是被压掉的原文），并指向完整正文。
    expect(text).toContain('精简版')
    expect(text).toContain(fixture.spill!.refs[0]!.locator)
    expect(readRecords(path)).toEqual([
      expect.objectContaining({
        toolName: 'bash',
        action: 'condensed',
        condense: expect.objectContaining({ rules: ['tail-cap'], truncated: false }),
      }),
    ])
  })
})

describe('票 21：模型要整份/逐字时精简层让路', () => {
  it('WHOLE_RESULT：超过单行封顶的结果逐字透传，不写入口，记录 whole-result 且没有精简观测', async () => {
    const spill = new FakeSpill()
    const { fixture, path } = await mounted({ condenseByCommand: true }, undefined, spill)
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, { command: 'cat f', extract: WHOLE_RESULT }))

    expect(textOf(result.content)).toBe(LONG_BODY)
    expect(spill.saves).toHaveLength(0)
    const [record] = readRecords(path)
    expect(record).toEqual(expect.objectContaining({ action: 'unmodified', reason: 'whole-result', extract: true }))
    expect(record).not.toHaveProperty('condense')
  })

  it('逐字要求：命令族也不接手，记录 exact-text', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(textTool('bash', GIT_DIFF_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, {
      ...GIT_DIFF_ARGS,
      extract: 'verbatim lines 20-40',
    }))

    expect(textOf(result.content)).toBe(GIT_DIFF_BODY)
    const [record] = readRecords(path)
    expect(record).toEqual(expect.objectContaining({ action: 'unmodified', reason: 'exact-text', extract: true }))
    expect(record).not.toHaveProperty('condense')
  })

  it('WHOLE_RESULT：打开命令族也不收窄 diff，正文逐字不变', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(textTool('bash', GIT_DIFF_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, { ...GIT_DIFF_ARGS, extract: WHOLE_RESULT }))

    expect(textOf(result.content)).toBe(GIT_DIFF_BODY)
    expect(readRecords(path)[0]).toEqual(expect.objectContaining({ action: 'unmodified', reason: 'whole-result' }))
    expect(readRecords(path)[0]).not.toHaveProperty('condense')
  })
})

describe('票 15 判据 1：总开关关掉即透传', () => {
  it('关掉总开关后同一条结果逐字未变、一次存储写入都不发，记录记 condense-off', async () => {
    const spill = new FakeSpill()
    const { fixture, path } = await mounted({ condense: false }, undefined, spill)
    fixture.ctx.tools.register(textTool('bash', LONG_LINES_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(textOf(result.content)).toBe(LONG_LINES_BODY)
    expect(spill.saves).toHaveLength(0)
    expect(readRecords(path)).toEqual([
      expect.objectContaining({
        action: 'unmodified',
        reason: 'condense-off',
        condense: expect.objectContaining({ rules: [], truncated: false }),
      }),
    ])
  })
})

describe('票 15 判据 2：有损但回退入口写不成时必须返回原文', () => {
  it('没有存储后端：写不出入口就交回下游原文，且正文里不留下任何入口说明', async () => {
    const { fixture, path } = await mounted({}, undefined, null)
    fixture.ctx.tools.register(textTool('bash', LONG_LINES_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    const text = textOf(result.content)
    expect(text).toBe(LONG_LINES_BODY)
    expect(text).not.toContain('精简版')
    expect(text).not.toContain('原文在此')
    expect(readRecords(path)).toEqual([
      expect.objectContaining({
        action: 'unmodified',
        reason: 'condense-abstained',
        condense: expect.objectContaining({ rules: [], truncated: false }),
      }),
    ])
  })

  it('存储写入抛错：同样交回下游原文，存储里也没有留下任何东西', async () => {
    const spill = new FakeSpill()
    spill.fail = true
    const { fixture, path } = await mounted({}, undefined, spill)
    fixture.ctx.tools.register(textTool('bash', LONG_LINES_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    const text = textOf(result.content)
    expect(text).toBe(LONG_LINES_BODY)
    expect(text).not.toContain('精简版')
    expect(spill.saves).toHaveLength(0)
    expect(readRecords(path)).toEqual([
      expect.objectContaining({ action: 'unmodified', reason: 'condense-abstained' }),
    ])
  })
})

describe('票 15 判据 3：丢掉的内容按入口读得回来', () => {
  it('写进存储的是替换前的完整正文；按入口 read 回来被认作读回，别的路径不是', async () => {
    const spill = new FakeSpill()
    const { fixture, path } = await mounted({}, undefined, spill)
    fixture.ctx.tools.register(textTool('bash', LONG_LINES_BODY))
    fixture.ctx.tools.register(textTool('read', 'read body'))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    // 存储收到的是**替换前**的那一份完整正文，归属与来源都对得上。
    expect(spill.saves).toHaveLength(1)
    expect(spill.saves[0]!.content).toBe(LONG_LINES_BODY)
    expect(spill.saves[0]!.source).toEqual({ kind: 'tool', toolName: 'bash', callId: 'call-bash', label: 'result' })
    expect(spill.saves[0]!.owner).toEqual({ sessionId: 's1' })

    const locator = spill.refs[0]!.locator
    expect(textOf(result.content)).toContain(locator)

    const back = await fixture.ctx.tools.execute(exec('read', undefined, { file_path: locator }))
    const elsewhere = await fixture.ctx.tools.execute(exec('read', undefined, { file_path: '/elsewhere.txt' }))
    expect(textOf(back.content)).toBe('read body')
    expect(textOf(elsewhere.content)).toBe('read body')

    const records = readRecords(path)
    expect(records[1]).toEqual(expect.objectContaining({ toolName: 'read', action: 'unmodified', reason: 'read-back' }))
    expect(records[2]).toEqual(expect.objectContaining({ toolName: 'read', action: 'unmodified', reason: 'not-candidate' }))
    // `read` 不在精简工具集里：它的记录里没有本层的观测字段。
    expect(records[1]).not.toHaveProperty('condense')
    expect(records[2]).not.toHaveProperty('condense')
  })
})

describe('票 15 判据 10：干跑只预报，不替换、不写回退入口、不记台账', () => {
  it('干跑下正文是下游原文、存储一次都没写、摘要请求也不发，记录带 dryRun 与 condensed', async () => {
    const spill = new FakeSpill()
    const route = new FakeRoute([{ text: SUMMARY_REPLY }])
    const { fixture, path } = await mounted(
      { dryRun: true, ruleSummary: true, routeProvider: 'local', routeModel: 'qwen' }, route, spill,
    )
    fixture.ctx.tools.register(textTool('bash', LONG_LINES_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(textOf(result.content)).toBe(LONG_LINES_BODY)
    expect(spill.saves).toHaveLength(0)
    // 干跑同样跳过整条摘要路：route 配齐了也没有请求发出去（预报的是「打开精简之后会发生什么」）。
    expect(route.requests).toHaveLength(0)
    expect(readRecords(path)).toEqual([
      expect.objectContaining({
        action: 'condensed',
        dryRun: true,
        condense: expect.objectContaining({ rules: ['tail-cap'], truncated: false }),
      }),
    ])

    // 阳性对照：同一条输入在非干跑下真的被替换、真的写了一次入口。
    const realSpill = new FakeSpill()
    const real = await mounted({}, undefined, realSpill)
    real.fixture.ctx.tools.register(textTool('bash', LONG_LINES_BODY))
    const replaced = await real.fixture.ctx.tools.execute(exec('bash'))
    expect(textOf(replaced.content)).not.toBe(LONG_LINES_BODY)
    expect(realSpill.saves).toHaveLength(1)
  })
})

/**
 * 取替换后的**正文那一段**：入口说明按工具名生成（`/spill/bash.txt` / `/spill/pwsh.txt`），那不是要比的东西。
 * @param text - 交回模型的完整正文。
 * @returns 入口说明之前的那一段。
 */
function condensedBody(text: string): string {
  return text.split('\n\n（以上为本次')[0] as string
}

describe('票 15 判据 8：按内容判定、平台中立', () => {
  it('同一份正文在 bash 与 pwsh 上得到同一份精简结果与同一条记录', async () => {
    const { fixture, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_LINES_BODY))
    fixture.ctx.tools.register(textTool('pwsh', LONG_LINES_BODY))

    const bash = await fixture.ctx.tools.execute(exec('bash'))
    const pwsh = await fixture.ctx.tools.execute(exec('pwsh'))

    expect(condensedBody(textOf(pwsh.content))).toBe(condensedBody(textOf(bash.content)))
    expect(condensedBody(textOf(pwsh.content))).toContain('…[省略 150 行]')
    expect(withoutDuration(readRecords(path))).toEqual([
      expect.objectContaining({ toolName: 'bash', action: 'condensed', condense: expect.objectContaining({ rules: ['tail-cap'] }) }),
      expect.objectContaining({ toolName: 'pwsh', action: 'condensed', condense: expect.objectContaining({ rules: ['tail-cap'] }) }),
    ])
  })

  it('命令串不参与本层的取舍：参数里写着 unix 命令的 pwsh 结果与同文本的 bash 结果同路', async () => {
    const { fixture } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_LINES_BODY))
    fixture.ctx.tools.register(textTool('pwsh', LONG_LINES_BODY))

    // 本层一个 `arguments` 都不读：不打开「按命令语义精简」时，同一条命令串在两种 shell 上是同一份取舍。
    const args = { command: 'git diff --stat' }
    const bash = await fixture.ctx.tools.execute(exec('bash', undefined, args))
    const pwsh = await fixture.ctx.tools.execute(exec('pwsh', undefined, args))

    expect(condensedBody(textOf(pwsh.content))).toBe(condensedBody(textOf(bash.content)))
  })

  it('打开「按命令语义精简」后，同一条 unix 命令串只在 bash 上被命令族接手（票 16 判据 13）', async () => {
    const { fixture, path } = await mounted({ condenseByCommand: true })
    fixture.ctx.tools.register(textTool('bash', GIT_DIFF_BODY))
    fixture.ctx.tools.register(textTool('pwsh', GIT_DIFF_BODY))

    const args = { command: 'git diff --stat' }
    const bash = await fixture.ctx.tools.execute(exec('bash', undefined, args))
    const pwsh = await fixture.ctx.tools.execute(exec('pwsh', undefined, args))

    // 阳性对照：bash 上族真的接手了（正文里出现逐文件聚合量）；pwsh 上即使命令串就是 `git diff` 也不进分派。
    expect(textOf(bash.content)).toMatch(AGGREGATE_LINE)
    expect(textOf(pwsh.content)).not.toMatch(AGGREGATE_LINE)
    expect(readRecords(path).map(record => record.condense)).toEqual([
      expect.objectContaining({ family: 'compactDiff' }),
      expect.not.objectContaining({ family: expect.anything() }),
    ])
  })
})

describe('票 15 的顺序：隐私闸门判的是精简后的正文（用户故事 61、计划 §2.1 第 2 条）', () => {
  it('隐私请求里看到的是封顶后的正文，不是下游原文', async () => {
    const route = new FakeRoute([{ text: '' }])
    const { fixture, path } = await mounted(
      { privacyGate: true, privacyConfirmedLocal: true, routeProvider: 'mock', routeModel: 'mock' },
      route,
    )
    fixture.ctx.tools.register(textTool('bash', LONG_LINES_BODY))
    await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    const projection = requestText(route.requests[0]!)
    expect(projection).toContain('…[省略 150 行]')
    // 被丢掉的中间行（索引 50–199 那一段）不在投影里：判的必须是模型真正会看到的那份正文。
    expect(projection).not.toContain('line-100')
    // 按 `passthrough` 放行的隐私失效不改变正文的定性——交回的仍是精简结果，取值仍是 `condensed`。
    expect(readRecords(path)).toEqual([
      expect.objectContaining({ action: 'condensed', condense: expect.objectContaining({ rules: ['tail-cap'] }) }),
    ])
  })

  it('阳性对照：没被精简过的正文在隐私请求里是全文', async () => {
    const route = new FakeRoute([{ text: '' }])
    const { fixture } = await mounted(
      { privacyGate: true, privacyConfirmedLocal: true, routeProvider: 'mock', routeModel: 'mock' },
      route,
    )
    const body = Array.from({ length: 299 }, (_, index) => `line-${String(index).padStart(3, '0')}`).join('\n')
    fixture.ctx.tools.register(textTool('bash', body))
    await fixture.ctx.tools.execute(exec('bash'))

    const projection = requestText(route.requests[0]!)
    expect(projection).toContain('line-100')
    expect(projection).not.toContain('…[省略')
  })
})

describe('票 15 判据 10：四个去向各有一条，且「一处都没改动」不表态', () => {
  it('改了但省的不到净收益阈值：交回下游原文，记录记 condense-not-shorter', async () => {
    const { fixture, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', NOT_SHORTER_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(textOf(result.content)).toBe(NOT_SHORTER_BODY)
    expect(readRecords(path)).toEqual([
      expect.objectContaining({
        action: 'unmodified',
        reason: 'condense-not-shorter',
        // 命中的规则照记：闸门挡下的是「替换」，不是「哪条规则命中过」——这是「为什么没变短」的答案。
        condense: expect.objectContaining({ rules: ['dedup-adjacent'], truncated: false }),
      }),
    ])
  })

  it('负对照：低于尺寸下限的短结果仍记既有词表的 not-candidate（本层不表态）', async () => {
    const { fixture, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', SHORT_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(textOf(result.content)).toBe(SHORT_BODY)
    expect(readRecords(path)).toEqual([
      expect.objectContaining({
        action: 'unmodified',
        reason: 'not-candidate',
        // 本层考虑过这条结果（精简工具 + 一张文本块），所以观测字段照写。
        condense: expect.objectContaining({ rules: [], truncated: false }),
      }),
    ])
  })
})

describe('票 15 判据 1：精简过的不再进摘要', () => {
  it('阴性对照：开着精简时零摘要请求，交回的是精简结果', async () => {
    const route = new FakeRoute([{ text: SUMMARY_REPLY }])
    const { fixture } = await mounted({ ruleSummary: true, routeProvider: 'local', routeModel: 'qwen' }, route)
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(0)
    expect(textOf(result.content)).toContain('精简版')
  })

  it('阳性对照：同一份夹具只关掉精简层，同一条候选结果真的发出一次摘要请求并被摘要替换', async () => {
    const route = new FakeRoute([{ text: SUMMARY_REPLY }])
    const { fixture } = await mounted(
      { condense: false, ruleSummary: true, routeProvider: 'local', routeModel: 'qwen' }, route,
    )
    fixture.ctx.tools.register(textTool('bash', LONG_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(route.requests).toHaveLength(1)
    expect(textOf(result.content)).toContain(SUMMARY)
    expect(textOf(result.content)).not.toContain('精简版')
  })
})

describe('票 15 判据 1：精简层只作用于自己的工具集', () => {
  it.each(['read', 'web_fetch', 'glob'])(
    '%s 的文本结果逐字未变，装与不装精简层写出同一条记录、且记录里没有 condense 字段',
    async (toolName) => {
      // 这一条同时是票 19 的阴性对照：`read` / `web_fetch` 的决策自票 15 交付（主仓 `69eba3a`）起逐字未变——
      // 两臂相等只证明「装与不装同一条」，下面这行字面量才把「决策本身是什么」钉住（差一个字段即红）。
      const withLayer = await mounted()
      withLayer.fixture.ctx.tools.register(textTool(toolName, LONG_LINES_BODY))
      const result = await withLayer.fixture.ctx.tools.execute(exec(toolName))

      const withoutLayer = await mounted({ condense: false })
      withoutLayer.fixture.ctx.tools.register(textTool(toolName, LONG_LINES_BODY))
      const other = await withoutLayer.fixture.ctx.tools.execute(exec(toolName))

      expect(textOf(result.content)).toBe(LONG_LINES_BODY)
      expect(textOf(other.content)).toBe(LONG_LINES_BODY)
      expect(withoutDuration(readRecords(withLayer.path))).toEqual(withoutDuration(readRecords(withoutLayer.path)))
      expect(readRecords(withLayer.path)).toEqual([
        expect.objectContaining({ toolName, action: 'unmodified', reason: 'not-candidate' }),
      ])
      expect(readRecords(withLayer.path)[0]).not.toHaveProperty('condense')
    },
  )
})

describe('票 15 判据 10：替换只改正文', () => {
  it('下游决策带的附加上下文原样保留：顺序与来源都不变', async () => {
    const { fixture, path } = await mounted()
    fixture.ctx.tools.register(textTool('bash', LONG_LINES_BODY))
    const attached = createUserMessage({ content: [{ type: 'text', text: 'attached-SENTINEL-3d9f' }], source: { kind: 'user' } })
    fixture.ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({
      kind: 'accept', additionalContexts: [attached],
    }))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(textOf(result.content)).toContain('精简版')
    expect(result.additionalContexts).toEqual([attached])
    expect(readRecords(path)).toEqual([expect.objectContaining({ action: 'condensed' })])
  })
})

describe('票 15 判据 10：记下输入是否已被工具自身截断', () => {
  it('stdout.truncated 为真时记录 condense.truncated 为 true', async () => {
    const { fixture, path } = await mounted()
    fixture.ctx.tools.register(shellResultTool(true, LONG_LINES_BODY))
    const result = await fixture.ctx.tools.execute(exec('bash'))

    expect(textOf(result.content)).toContain('精简版')
    expect(readRecords(path)[0]!.condense).toEqual(expect.objectContaining({ rules: ['tail-cap'], truncated: true }))
  })

  it('只有严格 true 才算截断：形状不认识的取值一律为 false', async () => {
    const other = await mounted()
    // 真值不是布尔（例如上游改成字符串「yes」）时不猜，按未截断读。
    other.fixture.ctx.tools.register(shellResultTool('yes', LONG_LINES_BODY))
    await other.fixture.ctx.tools.execute(exec('bash'))

    const textBlocks = await mounted()
    // 既有文本工具夹具的 `value` 是内容块数组，压根没有 `stdout` 这个形状。
    textBlocks.fixture.ctx.tools.register(textTool('bash', LONG_LINES_BODY))
    await textBlocks.fixture.ctx.tools.execute(exec('bash'))

    expect(readRecords(other.path)[0]!.condense).toEqual(expect.objectContaining({ rules: ['tail-cap'], truncated: false }))
    expect(readRecords(textBlocks.path)[0]!.condense).toEqual(expect.objectContaining({ rules: ['tail-cap'], truncated: false }))
  })
})


describe('票 19 判据 2：19 个非 volatile 字段改值即改变行为（写在配置文件里可读，也按其取值生效）', () => {
  /**
   * 一份带 hunk 前导上下文的 diff：三个 hunk，每个 40 行长上下文再跟 10 处改动。只有 `leadingContext` 会改
   * 这些上下文行留几行；省幅要盖过回退入口的预留，所以上下文行写得长一点。
   */
  const CONTEXT_DIFF = [
    'diff --git a/app.ts b/app.ts',
    'index 1a2b3c4..5d6e7f8 100644',
    '--- a/app.ts',
    '+++ b/app.ts',
    ...Array.from({ length: 3 }, (_, hunk) => [
      `@@ -${hunk * 50 + 1},50 +${hunk * 50 + 1},50 @@ function part${hunk}() {`,
      ...Array.from({ length: 40 }, (_, index) => ` keep-${hunk}-${String(index).padStart(2, '0')}-context-padding`),
      ...Array.from({ length: 10 }, (_, index) => `-const old${hunk}${index} = compute(${index})`),
      ...Array.from({ length: 10 }, (_, index) => `+const neu${hunk}${index} = compute(${index})`),
    ]).flat(),
  ].join('\n')
  /** 200 行转储，中间 30 行是「有意思的行」——只有 `hits` 那一档会改变它们插不插。 */
  const DUMP_200 = Array.from({ length: 200 }, (_, index) =>
    index >= 20 && index < 50 ? `error: something failed at ${index}` : `row-${String(index).padStart(3, '0')}`).join('\n')
  /** 200 行互不相同的正文：通用链不动它，只有 `sed` 大窗口族会收窄。 */
  const SED_200 = Array.from({ length: 200 }, (_, index) => `row-${String(index).padStart(3, '0')}`).join('\n')
  /** 296 行、每行接近 20 字符：默认封顶触发行数 300 不触发，改成 50 才触发，且省幅要盖过回退入口的预留。 */
  const PLAIN_296 = Array.from({ length: 296 }, (_, index) =>
    `row-${String(index).padStart(3, '0')}-xxxxxxxxxxxx`).join('\n')

  /** 一档「只改这一个字段」的对照。 */
  interface FieldCase {
    readonly field: string
    readonly value: number | boolean
    readonly body: string
    /** 命令族要读的命令串；不给就是一次没有参数的工具调用。 */
    readonly args?: Record<string, unknown>
    /** 命令族那一半必须先打开「按命令语义精简」。 */
    readonly byCommand?: boolean
  }

  const CASES: readonly FieldCase[] = [
    // 票 15 的六个通用参数：四条通用形状变换各自可拧的那一档。
    { field: 'condenseMinUnits', value: 1e9, body: LONG_LINES_BODY },
    { field: 'condenseMinNetGainUnits', value: 0, body: NOT_SHORTER_BODY },
    { field: 'condenseHeadLines', value: 10, body: LONG_LINES_BODY },
    { field: 'condenseTailLines', value: 100, body: LONG_LINES_BODY },
    { field: 'condenseMaxLines', value: 50, body: PLAIN_296 },
    { field: 'condenseMaxLineChars', value: 5000, body: 'x'.repeat(3000) },
    // 票 16 的 `git diff` 族。
    { field: 'condenseGitDiff', value: false, body: GIT_DIFF_BODY, args: GIT_DIFF_ARGS, byCommand: true },
    { field: 'condenseGitDiffMaxHunkLines', value: 1, body: GIT_DIFF_BODY, args: GIT_DIFF_ARGS, byCommand: true },
    { field: 'condenseGitDiffMaxLines', value: 20, body: GIT_DIFF_BODY, args: GIT_DIFF_ARGS, byCommand: true },
    { field: 'condenseGitDiffLeadingContext', value: 0, body: CONTEXT_DIFF, args: GIT_DIFF_ARGS, byCommand: true },
    // 票 17 的 `sed` 大窗口族与原始转储族。
    { field: 'condenseSedWindow', value: false, body: SED_200, args: { command: "sed -n '1,200p' f" }, byCommand: true },
    { field: 'condenseSedWindowHeadLines', value: 5, body: SED_200, args: { command: "sed -n '1,200p' f" }, byCommand: true },
    { field: 'condenseSedWindowTailLines', value: 5, body: SED_200, args: { command: "sed -n '1,200p' f" }, byCommand: true },
    { field: 'condenseSedWindowMinLines', value: 1e6, body: SED_200, args: { command: "sed -n '1,200p' f" }, byCommand: true },
    { field: 'condenseRawDump', value: false, body: DUMP_200, args: { command: 'cat bigfile' }, byCommand: true },
    { field: 'condenseRawDumpHeadLines', value: 5, body: DUMP_200, args: { command: 'cat bigfile' }, byCommand: true },
    { field: 'condenseRawDumpTailLines', value: 5, body: DUMP_200, args: { command: 'cat bigfile' }, byCommand: true },
    { field: 'condenseRawDumpMinLines', value: 1e6, body: DUMP_200, args: { command: 'cat bigfile' }, byCommand: true },
    { field: 'condenseRawDumpHits', value: 0, body: DUMP_200, args: { command: 'cat bigfile' }, byCommand: true },
  ]

  /**
   * 装一份夹具、跑同一条结果，交回模型可见正文。
   * @param config - 这一档的插件配置。
   * @param testCase - 这一档要跑的工具正文与参数。
   * @returns 交回给模型的正文。
   */
  const outputOf = async (config: Record<string, unknown>, testCase: FieldCase): Promise<string> => {
    const { fixture } = await mounted(config as Schemastery.TypeS<typeof Config>)
    fixture.ctx.tools.register(textTool('bash', testCase.body))
    const result = await fixture.ctx.tools.execute(exec('bash', undefined, testCase.args))
    return textOf(result.content)
  }

  it('逐字段对照：只改这一个字段、同一条结果的正文就变', async () => {
    const schemaFields = Object.keys((Config as unknown as { dict: Record<string, unknown> }).dict)
      .filter(field => field.startsWith('condense') && field !== 'condense' && field !== 'condenseByCommand')
    // 对照表必须与 schema 上的非 volatile 字段一一对上：加一个字段而不补一档，这里就红。
    expect(new Set(CASES.map(testCase => testCase.field))).toEqual(new Set(schemaFields))
    expect(schemaFields).toHaveLength(19)

    for (const testCase of CASES) {
      const base = testCase.byCommand === true ? { condenseByCommand: true } : {}
      const baseline = await outputOf(base, testCase)
      const overridden = await outputOf({ ...base, [testCase.field]: testCase.value }, testCase)
      expect(overridden, `${testCase.field} 改值后同一条结果的正文应随之改变`).not.toBe(baseline)
    }
  })
})
