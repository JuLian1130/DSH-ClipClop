/**
 * 真实入口腿（票据 12）在子进程内、消息落盘那一刻记下每条 plugin notice 的 id 与正文。
 *
 * 它是 SDK 腿的 **id 截获点**：这条读数来自会话事件提交点，与 SDK 侧按协议反读的那份不是同一个读数，
 * 所以「SDK 读回的 id === 追加时那个对象自己的 id」不是恒真句。ACP 腿用它当负向读数的正向对照
 * ——先证明这条 notice 确实产生了，再断它不在 ACP 更新流里。
 *
 * 由子进程按**绝对路径**装载，所以写成纯 `.mjs`；它所在目录的最近一份 `package.json` 是本包的清单
 * （DSH 的插件清点扩展要求清单带非空 name 与 version）。
 */

import { appendFileSync } from 'node:fs'

export const name = 'dsh-navigator-notice-observer'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - 子进程里本条目自己的 context。
 * @param {{ file: string }} config - 每次 notice 落盘时追加一行 JSON 的目标文件。
 */
export function apply(ctx, config) {
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    const message = event.data
    if (message?.source?.kind !== 'plugin' || message.source.form !== 'notice') return
    const text = (message.content ?? []).map(block => block.text ?? '').join('')
    appendFileSync(config.file, `${JSON.stringify({ id: message.id, text })}\n`)
  })
}
