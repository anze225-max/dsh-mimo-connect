/**
 * 验证修复：模拟 dsh-llm-pi-ai 的图片检查逻辑。
 *
 * 真实逻辑（lib/index.js:1846-1847）：
 *   const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
 *   if (containsImage && attachments === undefined) throw UNSUPPORTED_CONTENT
 *
 * 本测试直接跑这段逻辑，对比「接线前 / 接线后」的行为。
 */
import { createMiMoAdapter } from '../src/adapter.js'
import { MiMoCatalog } from '../src/catalog.js'
import { MiMoSession } from '../src/session.js'
import { contentHasImage } from '@deepseek-ai/dsh-llm'

let pass = 0
let fail = 0
const checkFn = (l, c, d = '') => {
  if (c) { pass++; console.log(`  PASS ${l}`) }
  else { fail++; console.log(`  FAIL ${l} ${d}`) }
}

/** 复刻 pi-ai 的守卫判断。 */
function simulateGuard(adapter, messages) {
  const containsImage = messages.some(m => contentHasImage(m.content))
  // 从 adapter 内部取配置：PiAiAdapter 把 config 存在 this.config
  const cfg = adapter.config ?? {}
  const attachments = containsImage ? cfg.resolveAttachments?.() : undefined
  if (containsImage && attachments === undefined) {
    return { ok: false, error: 'pi-ai image input requires the durable attachment service' }
  }
  return { ok: true }
}

const catalog = new MiMoCatalog()

// 模拟截图里的那条消息：纯文本，但会话历史里有图片
const textOnly = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }]
const withImage = [
  { role: 'user', content: [{ type: 'text', text: '看图' }] },
  { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] },
]
// 工具结果里嵌套图片 —— contentHasImage 会递归检查
const nestedImage = [
  { role: 'user', content: [{ type: 'tool-result', toolCallId: 't1', content: [{ type: 'image', source: {} }] }] },
]

console.log('\n== contentHasImage 的行为 ==')
checkFn('纯文本 → false', contentHasImage(textOnly[0].content) === false)
checkFn('直接图片 → true', contentHasImage(withImage[1].content) === true)
checkFn('工具结果内嵌图片 → true（关键）', contentHasImage(nestedImage[0].content) === true)

console.log('\n== 修复前：不接线 resolveAttachments ==')
{
  const { adapter } = createMiMoAdapter({ catalog, getSession: () => new MiMoSession({}) })
  const r1 = simulateGuard(adapter, textOnly)
  const r2 = simulateGuard(adapter, withImage)
  checkFn('纯文本可过', r1.ok)
  checkFn('含图片被拒（这是修复前的症状）', !r2.ok, JSON.stringify(r2))
}

console.log('\n== 修复后：接线 resolveAttachments ==')
{
  const store = { id: 'attachments' }
  const { adapter } = createMiMoAdapter({
    catalog,
    getSession: () => new MiMoSession({}),
    resolveAttachments: () => store,
  })
  const r1 = simulateGuard(adapter, textOnly)
  const r2 = simulateGuard(adapter, withImage)
  const r3 = simulateGuard(adapter, nestedImage)
  checkFn('纯文本可过', r1.ok)
  checkFn('含图片可过（关键修复）', r2.ok, JSON.stringify(r2))
  checkFn('工具结果内嵌图片可过', r3.ok, JSON.stringify(r3))
}

console.log('\n== 修复后但服务尚未就绪 ==')
{
  const { adapter } = createMiMoAdapter({
    catalog,
    getSession: () => new MiMoSession({}),
    resolveAttachments: () => undefined,
  })
  const r = simulateGuard(adapter, withImage)
  checkFn('如实报告（不静默）', !r.ok)
}

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
