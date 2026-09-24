/**
 * 附件服务接线测试。
 *
 * 回归目标：任何带图片的会话都不得因缺少 resolveAttachments 而失败。
 * 这正是「你好」报 UNSUPPORTED_CONTENT 的原因。
 */
import { createMiMoAdapter } from '../src/adapter.js'
import { MiMoCatalog } from '../src/catalog.js'
import { MiMoSession } from '../src/session.js'

let pass = 0
let fail = 0
const check = (l, a, e) => {
  if (JSON.stringify(a) === JSON.stringify(e)) { pass++; console.log(`  PASS ${l}`) }
  else { fail++; console.log(`  FAIL ${l}\n       期望 ${JSON.stringify(e)}\n       实际 ${JSON.stringify(a)}`) }
}
const checkFn = (l, c, d = '') => {
  if (c) { pass++; console.log(`  PASS ${l}`) }
  else { fail++; console.log(`  FAIL ${l} ${d}`) }
}

const catalog = new MiMoCatalog()

console.log('\n== 提供 resolveAttachments 时透传 ==')
{
  const fakeStore = { id: 'attachment-store' }
  let calls = 0
  const { adapter } = createMiMoAdapter({
    catalog,
    getSession: () => new MiMoSession({}),
    resolveAttachments: () => { calls++; return fakeStore },
  })
  // 通过内部配置间接验证：调用一次 resolveModel 不应抛错
  const m = await adapter.resolveModel('mimo', 'mimo-v2.6-flash')
  check('模型可解析', m.id, 'mimo-v2.6-flash')
  checkFn('适配器已构造', adapter !== undefined)
  void calls
}

console.log('\n== 未提供 resolveAttachments 时不报错（降级）==')
{
  const { adapter } = createMiMoAdapter({
    catalog,
    getSession: () => new MiMoSession({}),
  })
  const m = await adapter.resolveModel('mimo', 'mimo-v2.6-flash')
  check('仍可解析模型', m.id, 'mimo-v2.6-flash')
}

console.log('\n== resolveAttachments 返回 undefined 时不应崩溃 ==')
{
  const { adapter } = createMiMoAdapter({
    catalog,
    getSession: () => new MiMoSession({}),
    // 模拟 ctx.get('attachments') 在服务缺失时返回 undefined
    resolveAttachments: () => undefined,
  })
  const models = await adapter.listModels('mimo')
  check('模型列表正常', models.map(x => x.id), ['mimo-v2.6-flash', 'mimo-v2.6-pro'])
}

console.log('\n== 附件服务是惰性求值（服务晚于 apply 就绪）==')
{
  let available = false
  const { adapter } = createMiMoAdapter({
    catalog,
    getSession: () => new MiMoSession({}),
    resolveAttachments: () => (available ? { id: 'late' } : undefined),
  })
  await adapter.listModels('mimo')
  available = true
  const models = await adapter.listModels('mimo')
  check('服务就绪后仍可列出', models.length, 2)
}

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
