/**
 * 集成测试：用真实 DSH 类组装插件，验证注册 / 列表 / 解析契约。
 *
 * 这些是 DSH 实际调用的方法，所以比单元测试更接近真实运行。
 */
import { createMiMoAdapter, toPiModel, MIMO_STREAM_IDLE_TIMEOUT_MS } from '../src/adapter.js'
import { MiMoCatalog, FALLBACK_MIMO_MODELS, displayNameOf } from '../src/catalog.js'
import { MiMoSession, MIMO_SERVER } from '../src/session.js'
import { MiMoCredentialStore } from '../src/credential.js'

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label}\n       期望 ${e}\n       实际 ${a}`) }
}
const checkFn = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label} ${detail}`) }
}

console.log('\n== catalog ==')
const cat = new MiMoCatalog()
check('内置两个模型', cat.current().map(m => m.id), ['mimo-v2.6-flash', 'mimo-v2.6-pro'])
check('source 为 builtin', cat.source(), 'builtin')
check('显示名含倍率', displayNameOf(FALLBACK_MIMO_MODELS[0]), 'MiMo V2.6 Flash · x0.40')
check('pro 倍率为 1', displayNameOf(FALLBACK_MIMO_MODELS[1]), 'MiMo V2.6 Pro · x1.00')

console.log('\n== model 转换（含认证头）==')
const session = new MiMoSession({})
const cookie = session.jar.headerFor(`${MIMO_SERVER}/api/route/chat/completions`)
const pi = toPiModel(FALLBACK_MIMO_MODELS[0], `${MIMO_SERVER}/api/route`, { Cookie: cookie })
check('id', pi.id, 'mimo-v2.6-flash')
check('api', pi.api, 'openai-completions')
check('provider', pi.provider, 'mimo')
check('baseUrl 指向 /api/route', pi.baseUrl, `${MIMO_SERVER}/api/route`)
check('输入模态', pi.input, ['text', 'image'])
check('contextWindow', pi.contextWindow, 262144)
check('成本为零', pi.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
check('maxTokensField', pi.compat, { maxTokensField: 'max_tokens' })
checkFn('携带 headers 字段（认证通道）', 'headers' in pi)
checkFn('不含 reasoning 键（档位实测无效）', !('reasoning' in pi))

console.log('\n== adapter 契约 ==')
const { adapter, invalidate } = createMiMoAdapter({ catalog: cat, getSession: () => session })
checkFn('构造成功', adapter !== undefined)
checkFn('invalidate 是函数', typeof invalidate === 'function')
checkFn('有 listModels', typeof adapter.listModels === 'function')
checkFn('有 resolveModel', typeof adapter.resolveModel === 'function')
checkFn('有 stream', typeof adapter.stream === 'function')

const info = adapter.providerInfo('mimo')
check('providerInfo id', info.id, 'mimo')
check('providerInfo 名称', info.name, 'MiMo')

const models = await adapter.listModels('mimo')
check('列出两个模型', models.map(m => m.id), ['mimo-v2.6-flash', 'mimo-v2.6-pro'])
check('名称含倍率', models[0].name, 'MiMo V2.6 Flash · x0.40')
check('provider 字段', models[0].provider, 'mimo')
check('输入模态透出', models[0].inputModalities, ['text', 'image'])

const resolved = await adapter.resolveModel('mimo', 'mimo-v2.6-pro')
check('解析 pro', resolved.id, 'mimo-v2.6-pro')
check('上下文窗口', resolved.context.contextWindow, 262144)
// No reasoning picker: the gateway ignores every reasoning control that was
// measured, so advertising efforts would offer a choice that does nothing.
checkFn('不暴露无效的推理档位', resolved.reasoning === undefined, JSON.stringify(resolved.reasoning))
checkFn('模型描述不含 reasoning 键', !('reasoning' in pi))

checkFn('重试策略存在', adapter.providerRetryPolicy('mimo') !== undefined)
check('空闲超时导出', MIMO_STREAM_IDLE_TIMEOUT_MS, 300000)

let threw = false
try { await adapter.listModels('其他') } catch { threw = true }
checkFn('未知 provider 抛错', threw)

console.log('\n== 会话替换后模型头跟随更新 ==')
const session2 = new MiMoSession({})
session2.jar.set('.xiaomimimo.com', 'serviceToken', 'NEW-TOKEN')
await createMiMoAdapter({ catalog: cat, getSession: () => session2 }).adapter.listModels('mimo')
checkFn('新会话的令牌被采用',
  session2.jar.headerFor(`${MIMO_SERVER}/api/route/chat/completions`).includes('NEW-TOKEN'))

console.log('\n== 实网：通过 pi-ai 真实调用 ==')
{
  const store = new MiMoCredentialStore()
  const status = await store.status()
  if (!status.signedIn) {
    console.log('  SKIP 未找到凭证')
  } else {
    const live = new MiMoSession({ jar: MiMoCredentialStore.jarFor(status.credential) })
    await live.ensureSession()
    const { createProvider } = await import('@earendil-works/pi-ai')
    const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy')

    const liveModel = toPiModel(
      FALLBACK_MIMO_MODELS[0],
      `${MIMO_SERVER}/api/route`,
      { Cookie: live.jar.headerFor(`${MIMO_SERVER}/api/route/chat/completions`) },
    )
    const provider = createProvider({
      id: 'mimo',
      name: 'MiMo',
      auth: { apiKey: { name: 'x', async resolve() { return { auth: { apiKey: 'd' }, source: 'm' } } } },
      models: [liveModel],
      api: openAICompletionsApi(),
    })

    let text = ''
    let sawThinking = false
    const stream = provider.stream(liveModel, {
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    }, { apiKey: 'd' })
    for await (const event of stream) {
      if (typeof event.type === 'string' && event.type.startsWith('thinking_')) sawThinking = true
      if (event.type === 'text_delta') text += event.delta ?? ''
    }
    checkFn('收到推理事件', sawThinking)
    checkFn('收到真实回复', /PONG/.test(text), `got: ${JSON.stringify(text)}`)
  }
}

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
