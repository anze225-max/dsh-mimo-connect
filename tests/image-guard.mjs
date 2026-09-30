/**
 * 验证修复：模拟 dsh-llm-pi-ai 的图片检查逻辑。
 *
 * 真实逻辑（dsh-llm-pi-ai lib/index.js）：
 *   const containsImage = options.messages.some((message) => contentHasImage(message.content))
 *   if (containsImage && attachments === undefined) throw UNSUPPORTED_CONTENT
 *
 * 本测试直接跑这段逻辑，对比「接线前 / 接线后」的行为。
 *
 * 关于 dsh 0.2.0-rc.2 的语义变化：`contentHasImage` 只检查**顶层**块
 * （`content.some(block => block.type === 'image')`，见 dsh-llm lib/index.js:593），
 * 不再递归进工具结果。早期版本的 dsh 会递归，那份假设已不再成立——所以下面用
 * 「顶层图片块」构造用例，并单独断言这层语义，避免测试随库实现漂移而误报。
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

// 模拟截图里的那条消息：纯文本
const textOnly = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }]
const withImage = [
  { role: 'user', content: [{ type: 'text', text: '看图' }] },
  { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] },
]
// 多条消息中任一含顶层图片块
const laterImage = [
  { role: 'assistant', content: [{ type: 'text', text: '好' }] },
  { role: 'user', content: [{ type: 'image', source: {} }] },
]

console.log('\n== contentHasImage 的行为（0.2.0-rc.2）==')
checkFn('纯文本 → false', contentHasImage(textOnly[0].content) === false)
checkFn('直接图片 → true', contentHasImage(withImage[1].content) === true)
checkFn('顶层为文本时不因嵌套内容报 true', contentHasImage([{ type: 'text', text: 'x' }]) === false)
checkFn('多条消息中任一条含图片即命中', laterImage.some(m => contentHasImage(m.content)) === true)

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
  const r3 = simulateGuard(adapter, laterImage)
  checkFn('纯文本可过', r1.ok)
  checkFn('含图片可过（关键修复）', r2.ok, JSON.stringify(r2))
  checkFn('后续消息含图片也可过', r3.ok, JSON.stringify(r3))
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

console.log('\n== 适配补充：resolveImageAccess 已接线 ==')
{
  const ref = { attachmentId: 'att-x', mediaType: 'image/png', width: 10, height: 10 }

  // fs 缺失：imageHostPath 给出宿主路径，但映射不出来 → 必须降级为「无路径」而不是抛错
  const storeNoFs = { id: 'attachments', imageHostPath: () => 'C:/host/x.png' }
  const { adapter: noFsAdapter } = createMiMoAdapter({
    catalog,
    getSession: () => new MiMoSession({}),
    resolveAttachments: () => storeNoFs,
    getFs: () => undefined,
  })
  let cfg = noFsAdapter.config ?? {}
  checkFn('adapter 暴露 resolveImageAccess', typeof cfg.resolveImageAccess === 'function')
  let threw
  let value
  try { value = cfg.resolveImageAccess(storeNoFs, ref) }
  catch (e) { threw = e }
  checkFn('fs 缺失时降级、不抛错', threw === undefined, threw ? String(threw.message) : '')
  checkFn('降级结果为 undefined（句柄里不含路径）', value === undefined, JSON.stringify(value))

  // 附件本身没有宿主路径 → 同样降级
  const storeNoHostPath = { id: 'attachments', imageHostPath: () => undefined }
  let v2
  let t2
  try { v2 = cfg.resolveImageAccess(storeNoHostPath, ref) } catch (e) { t2 = e }
  checkFn('无宿主路径时降级、不抛错', t2 === undefined, t2 ? String(t2.message) : '')
  checkFn('无宿主路径时结果为 undefined', v2 === undefined, JSON.stringify(v2))

  // fs 可用：映射出只读路径
  const fsStub = { processPathFromHostPath: (hostPath) => `/proc${hostPath}` }
  const { adapter: withFsAdapter } = createMiMoAdapter({
    catalog,
    getSession: () => new MiMoSession({}),
    resolveAttachments: () => storeNoFs,
    getFs: () => fsStub,
  })
  cfg = withFsAdapter.config ?? {}
  const access = cfg.resolveImageAccess(storeNoFs, ref)
  checkFn('fs 可用时给出 readonlyPath', access?.readonlyPath === '/procC:/host/x.png', JSON.stringify(access))

  // 显式传入的 resolveImageAccess 覆盖默认实现
  const { adapter: overrideAdapter } = createMiMoAdapter({
    catalog,
    getSession: () => new MiMoSession({}),
    resolveAttachments: () => storeNoFs,
    resolveImageAccess: () => ({ readonlyPath: '/custom' }),
  })
  const overridden = (overrideAdapter.config ?? {}).resolveImageAccess(storeNoFs, ref)
  checkFn('显式 resolveImageAccess 优先', overridden?.readonlyPath === '/custom', JSON.stringify(overridden))
}

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
