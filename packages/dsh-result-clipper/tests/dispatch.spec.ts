/**
 * 票 16 判据 2/3/4/5/6/7/13：分派层的**纯函数接缝**。
 *
 * 票面判据 3 明写「规则表按数据传入（分派是纯函数、夹具可注入规则）」，先例是票 15 给 `condenseText` 留的
 * `rules` 参数：所以这里直接给 `selectFamily` 喂夹具规则，而不是只跑已发布的那几条——「首个命中者胜」与
 * 「未锚定分支被拒绝」两条对照都靠夹具规则构造。
 *
 * 观察面是 `selectFamily` 的返回值与 `compileRules` 的拒绝清单，不碰任何内部实现。
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { CONDENSE_DEFAULTS, condenseText } from '../src/condense.ts'
import {
  compileRules,
  condenseRuleOf,
  firstSubstantiveCommand,
  selectFamily,
  type FactName,
  type FactValue,
  type FamilyRule,
} from '../src/dispatch.ts'

/**
 * 把字面量摊成事实 map；**没写进来的事实就是缺失**（判据 2 的「缺失不等于按空值匹配」要靠这个构造）。
 * @param entries - 事实名到取值的字面量。
 * @returns 扁平事实 map。
 */
function facts(entries: Partial<Record<FactName, FactValue>>): ReadonlyMap<FactName, FactValue> {
  return new Map(Object.entries(entries) as [FactName, FactValue][])
}

/** 一条夹具规则的正文变换：把正文变成大写，足够看出「哪一条接手了」。 */
const upper = (text: string): string => text.toUpperCase()

/**
 * 造一条夹具族规则。
 *
 * 夹具里两条规则共用同一个族 id：**赢家按规则身份判定**，这样「首个命中者胜」的对照不必依赖族词表里
 * 多出几个还没有规则的名字。
 * @param command - 命令正则源码。
 * @param extra - 还要覆盖的字段（要求的事实等）。
 * @returns 夹具规则。
 */
function rule(command: string, extra: Partial<FamilyRule> = {}): FamilyRule {
  return { family: 'compactDiff', command, lossy: true, apply: upper, ...extra }
}

/** 一次分派的结果，测试里反复要用。 */
function pick(
  toolName: string,
  factMap: ReadonlyMap<FactName, FactValue>,
  rules: readonly FamilyRule[],
): FamilyRule | undefined {
  return selectFamily(toolName, factMap, rules)
}

describe('票 16 判据 3：有序规则表与首个命中者胜', () => {
  it('两条夹具规则都能命中时，声明在前的那一条接手', () => {
    const rules = [rule('^git diff'), rule('^git')]
    expect(pick('bash', facts({ command: 'git diff --stat', format: 'text' }), rules)).toBe(rules[0])
  })

  it('把两条夹具规则的声明顺序对调，赢家随之改变', () => {
    const rules = [rule('^git'), rule('^git diff')]
    expect(pick('bash', facts({ command: 'git diff --stat', format: 'text' }), rules)).toBe(rules[0])
  })

  it('第一条不匹配时由第二条命中', () => {
    const rules = [rule('^git diff'), rule('^sed -n')]
    expect(pick('bash', facts({ command: 'sed -n 1,200p f', format: 'text' }), rules)).toBe(rules[1])
  })

  it('一条都不匹配时没有族接手', () => {
    const rules = [rule('^git diff')]
    expect(pick('bash', facts({ command: 'ls -la', format: 'text' }), rules)).toBeUndefined()
  })
})

describe('票 16 判据 4：装载时对命令正则做锚定校验', () => {
  it('按顶层 | 拆开，每个分支都以 ^ 开头时规则被接受', () => {
    const table = compileRules([rule('^git diff|^git show')])
    expect(table.rejected).toEqual([])
    expect(table.rules).toHaveLength(1)
  })

  it('未锚定的分支让那条规则被拒绝', () => {
    const table = compileRules([rule('^git diff|git show')])
    expect(table.rules).toEqual([])
    expect(table.rejected).toEqual([{ family: 'compactDiff', branch: 'git show' }])
  })

  it('字符组与分组里的 | 不算顶层分支，规则照常被接受', () => {
    const table = compileRules([rule('^git (diff|show)|^git -c (a|b) diff')])
    expect(table.rejected).toEqual([])
    expect(table.rules).toHaveLength(1)
  })

  it('转义的 | 也不算顶层分支', () => {
    const table = compileRules([rule('^git diff \\| head')])
    expect(table.rejected).toEqual([])
  })

  it('被拒绝的规则不参与分派，被接受的规则照常命中', () => {
    const table = compileRules([rule('git diff'), rule('^sed -n')])
    expect(table.rules).toEqual([expect.objectContaining({ command: '^sed -n' })])
    expect(pick('bash', facts({ command: 'git diff', format: 'text' }), table.rules)).toBeUndefined()
  })

  it('每条被拒绝的规则都交给告警回调（装载期告警就这么接出去）', () => {
    const warned: unknown[] = []
    compileRules([rule('^git diff|git show|+++ b/x'), rule('^sed -n')], (rejected) => { warned.push(rejected) })
    expect(warned).toEqual([
      { family: 'compactDiff', branch: 'git show' },
      { family: 'compactDiff', branch: '+++ b/x' },
    ])
  })

  it('不告警时回调不被调用', () => {
    const warned: unknown[] = []
    compileRules([rule('^git diff')], (rejected) => { warned.push(rejected) })
    expect(warned).toEqual([])
  })
})

describe('票 16 判据 2：事实缺失时不匹配', () => {
  it('规则要求的事实不在场时不命中（缺失不等于按空值匹配）', () => {
    const rules = [rule('^git diff', { facts: { exitCode: 0 } })]
    expect(pick('bash', facts({ command: 'git diff', format: 'text' }), rules)).toBeUndefined()
  })

  it('要求的事实在场且取值相同即命中', () => {
    const rules = [rule('^git diff', { facts: { exitCode: 0 } })]
    expect(pick('bash', facts({ command: 'git diff', format: 'text', exitCode: 0 }), rules)).toBe(rules[0])
  })

  it('事实在场但取值不同则不命中，由下一条接手', () => {
    const rules = [
      rule('^git diff', { facts: { lines: 10_000 } }),
      rule('^git diff', { facts: { lines: 12 } }),
    ]
    expect(pick('bash', facts({ command: 'git diff', format: 'text', lines: 12 }), rules)).toBe(rules[1])
  })

  it('没有任何命令事实时没有族接手', () => {
    const rules = [rule('^git diff')]
    expect(pick('bash', facts({ format: 'text' }), rules)).toBeUndefined()
  })
})

describe('票 16 判据 5：脚手架与管道不参与分派', () => {
  it('目录切换、标题回显与管道按首个实质命令命中', () => {
    const command = 'cd /repo && echo "=== 标题 ===" && git diff | head -40'
    expect(firstSubstantiveCommand(command)).toBe('git diff')
  })

  it('纯变量赋值与分隔符也不参与', () => {
    expect(firstSubstantiveCommand('export FOO=1; git diff --stat')).toBe('git diff --stat')
  })

  it('首个实质命令就是非目标命令时，后面的 git diff 不参与', () => {
    const command = 'ls -la && git diff'
    expect(firstSubstantiveCommand(command)).toBe('ls -la')
    expect(pick('bash', facts({ command, format: 'text' }), [rule('^git diff')])).toBeUndefined()
  })

  it('只有脚手架、没有实质命令时交回 undefined', () => {
    expect(firstSubstantiveCommand('cd /repo && echo "标题"')).toBeUndefined()
  })
})

describe('票 16 判据 13/7/6：平台面与两条守卫', () => {
  it('判据 13：同一条命令串在 pwsh 上不入分派、在 bash 上命中', () => {
    const rules = [rule('^git diff')]
    expect(pick('bash', facts({ command: 'git diff --stat', format: 'text' }), rules)).toBe(rules[0])
    expect(pick('pwsh', facts({ command: 'git diff --stat', format: 'text' }), rules)).toBeUndefined()
  })

  it('判据 7：输入已被工具自身截断时不接族', () => {
    const rules = [rule('^git diff')]
    expect(pick('bash', facts({ command: 'git diff', format: 'text', truncated: true }), rules)).toBeUndefined()
    expect(pick('bash', facts({ command: 'git diff', format: 'text', truncated: false }), rules)).toBe(rules[0])
  })

  it('判据 6：非零退出码不接族；缺失退出码事实时不由它挡下', () => {
    const rules = [rule('^git diff')]
    expect(pick('bash', facts({ command: 'git diff', format: 'text', exitCode: 1 }), rules)).toBeUndefined()
    expect(pick('bash', facts({ command: 'git diff', format: 'text', exitCode: 0 }), rules)).toBe(rules[0])
    expect(pick('bash', facts({ command: 'git diff', format: 'text' }), rules)).toBe(rules[0])
  })

  it('正文不是单张文本块时不接族', () => {
    const rules = [rule('^git diff')]
    expect(pick('bash', facts({ command: 'git diff', format: 'other' }), rules)).toBeUndefined()
  })
})

describe('票 16 判据 10：族 handler 抛异常归「守卫放弃」，不与失败混同', () => {
  /** 过尺寸下限的正文：判定走得到变换那一步。 */
  const BODY = Array.from({ length: 400 }, (_, index) => `line-${String(index).padStart(3, '0')}`).join('\n')

  it('经生产适配器接进安全层的族规则抛异常时判定是 abstained，且正文交回下游', () => {
    const boom: FamilyRule = {
      family: 'compactDiff',
      command: '^git diff',
      lossy: true,
      apply: (): string | undefined => { throw new Error('handler 内部炸了') },
    }
    const verdict = condenseText('bash', BODY, CONDENSE_DEFAULTS, [condenseRuleOf(boom)])
    // `abstained` 就是调用方映射成 `condense-abstained` 的那一支：异常不得落到 `failed`（「模型或 route 出了
    // 问题」）的词表里去。
    expect(verdict.kind).toBe('abstained')
  })

  it('阳性对照：同一条夹具规则不抛异常时走正常判定，不是 abstained', () => {
    const fine: FamilyRule = {
      family: 'compactDiff',
      command: '^git diff',
      lossy: true,
      apply: (text: string): string => `${text.slice(0, 200)}\n…[截断]`,
    }
    expect(condenseText('bash', BODY, CONDENSE_DEFAULTS, [condenseRuleOf(fine)]).kind).not.toBe('abstained')
  })
})
