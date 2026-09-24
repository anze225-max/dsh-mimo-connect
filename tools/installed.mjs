// 验证已安装副本能加载，并跑真实端到端。
const inst = process.env.USERPROFILE.replace(/\\/g, '/')
  + '/.dsh/profiles/desktop/node_modules/dsh-mimo-connect/src/'

let pass = 0, fail = 0
const check = (l, a, e) => {
  if (JSON.stringify(a) === JSON.stringify(e)) { pass++; console.log(`  PASS ${l}`) }
  else { fail++; console.log(`  FAIL ${l}\n       期望 ${JSON.stringify(e)}\n       实际 ${JSON.stringify(a)}`) }
}
const checkFn = (l, c, d = '') => {
  if (c) { pass++; console.log(`  PASS ${l}`) }
  else { fail++; console.log(`  FAIL ${l} ${d}`) }
}

console.log('=== 加载已安装副本 ===')
const mod = await import('file:///' + inst + 'index.js')
check('插件名', mod.name, 'llm-mimo')
check('注入 llm', mod.inject, ['llm'])
checkFn('有 apply', typeof mod.apply === 'function')

const { MiMoCredentialStore } = await import('file:///' + inst + 'credential.js')
const { MiMoSession, MIMO_SERVER } = await import('file:///' + inst + 'session.js')
const { FALLBACK_MIMO_MODELS } = await import('file:///' + inst + 'catalog.js')
const { createMiMoAdapter, toPiModel } = await import('file:///' + inst + 'adapter.js')

console.log('\n=== 凭证解析 ===')
const store = new MiMoCredentialStore()
const status = await store.status()
checkFn('已登录', status.signedIn, status.reason)
if (status.signedIn) {
  check('来源', status.credential.source, 'desktop')
  console.log(`  用户: ${status.credential.userId}`)
}

console.log('\n=== 会话建立 ===')
const session = new MiMoSession({ jar: MiMoCredentialStore.jarFor(status.credential) })
const token = await session.ensureSession()
checkFn('serviceToken 已铸造', typeof token === 'string' && token.length > 20)

console.log('\n=== adapter 契约 ===')
const cat = { current: () => FALLBACK_MIMO_MODELS, source: () => 'builtin' }
const { adapter } = createMiMoAdapter({ catalog: cat, getSession: () => session })
const models = await adapter.listModels('mimo')
check('模型列表', models.map(m => m.id), ['mimo-v2.6-flash', 'mimo-v2.6-pro'])
check('显示名含倍率', models[0].name, 'MiMo V2.6 Flash · x0.40')

console.log('\n=== 实网：pi-ai 真实调用 ===')
const { createProvider } = await import('@earendil-works/pi-ai')
const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy')

const liveModel = toPiModel(FALLBACK_MIMO_MODELS[0], `${MIMO_SERVER}/api/route`, {
  Cookie: session.jar.headerFor(`${MIMO_SERVER}/api/route/chat/completions`),
})
const provider = createProvider({
  id: 'mimo', name: 'MiMo',
  auth: { apiKey: { name: 'x', async resolve() { return { auth: { apiKey: 'd' }, source: 'm' } } } },
  models: [liveModel], api: openAICompletionsApi(),
})

let text = ''
for await (const e of provider.stream(liveModel, {
  messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
}, { apiKey: 'd' })) {
  if (e.type === 'text_delta') text += e.delta ?? ''
}
checkFn('收到真实回复', /PONG/.test(text), `got ${JSON.stringify(text)}`)

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
