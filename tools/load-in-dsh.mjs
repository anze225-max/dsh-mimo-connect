/**
 * 用真实 DSH cordis 运行时加载已安装的插件。
 *
 * 这是「装进 DSH 后能跑」的最强证据：用宿主自己的 Context、真实注册
 * provider、真实列出模型，并跑一次真实推理。
 */
const base = 'file:///' + process.env.USERPROFILE.replace(/\\/g, '/')
  + '/.dsh/profiles/desktop/node_modules/dsh-mimo-connect/src/'

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label}\n       期望 ${e}\n       实际   ${a}`) }
}
const checkFn = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label} ${detail}`) }
}

console.log('\n== 加载已安装的插件 ==')
const mod = await import(base + 'index.js')
check('插件名', mod.name, 'llm-mimo')
check('声明注入 llm', mod.inject, ['llm'])

console.log('\n== 用真实 cordis Context 调用 apply() ==')
const { Context } = await import('@deepseek-ai/cordis')
const ctx = new Context()

const registered = new Map()
ctx.provide('llm', {
  registerAdapter(routes, adapter) {
    for (const r of routes) registered.set(r, adapter)
    console.log(`    llm.registerAdapter(${JSON.stringify(routes)})`)
    return () => registered.delete(routes[0])
  },
})
checkFn('cordis Context 构造成功', ctx !== undefined)

// 不传 cookieDb，让插件走默认探测（当前机器上桌面端已登录）。
let applyError
try {
  mod.apply(ctx, { pollSeconds: 0 })
} catch (error) {
  applyError = error
}
checkFn('apply 不抛异常（否则 DSH 进恢复模式）', applyError === undefined, applyError?.message)

await new Promise(r => setTimeout(r, 120))

console.log('\n== provider 注册 ==')
checkFn('provider 已注册进 llm seam', registered.has('mimo'))
const adapter = registered.get('mimo')
checkFn('adapter 可列模型', typeof adapter?.listModels === 'function')
if (adapter) {
  const models = await adapter.listModels('mimo')
  check('列出内置模型', models.map(m => m.id), ['mimo-v2.6-flash', 'mimo-v2.6-pro'])
  check('显示名含倍率', models[0].name, 'MiMo V2.6 Flash · x0.40')
  check('provider 显示名', adapter.providerInfo('mimo').name, 'MiMo')
}

console.log('\n== 状态 accessor ==')
checkFn('ctx.status 未被占用为服务', typeof ctx.status !== 'function')
checkFn('ctx.mimoStatus 已注册为 accessor', typeof ctx.mimoStatus === 'function')
const st = await ctx.mimoStatus()
checkFn('已登录（本机桌面端登录态）', st.signedIn === true, st.reason)
check('仍然注册成功', st.registered, true)
check('目录来源为内置', st.catalog.source, 'builtin')
check('模型清单', st.catalog.models, ['mimo-v2.6-flash', 'mimo-v2.6-pro'])
checkFn('暴露了 cookie 探测路径', st.cookieCandidates.length > 0)
checkFn('状态不含敏感值', !JSON.stringify(st).includes('V1:'))

console.log('\n== 实网：经真实 adapter 完成一次对话 ==')
if (adapter) {
  const { MiMoCredentialStore } = await import(base + 'credential.js')
  const { MiMoSession, MIMO_SERVER } = await import(base + 'session.js')
  const cred = await new MiMoCredentialStore().status()
  if (!cred.signedIn) {
    console.log('  SKIP 无凭证')
  } else {
    const session = new MiMoSession({ jar: MiMoCredentialStore.jarFor(cred.credential) })
    await session.ensureSession()
    const { createProvider } = await import('@earendil-works/pi-ai')
    const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy')
    const { toPiModel } = await import(base + 'adapter.js')
    const { FALLBACK_MIMO_MODELS } = await import(base + 'catalog.js')

    const liveModel = toPiModel(FALLBACK_MIMO_MODELS[0], `${MIMO_SERVER}/api/route`, {
      Cookie: session.jar.headerFor(`${MIMO_SERVER}/api/route/chat/completions`),
    })
    const provider = createProvider({
      id: 'mimo', name: 'MiMo',
      auth: { apiKey: { name: 'x', async resolve() { return { auth: { apiKey: 'd' }, source: 'm' } } } },
      models: [liveModel],
      api: openAICompletionsApi(),
    })
    let text = ''
    for await (const e of provider.stream(liveModel, {
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    }, { apiKey: 'd' })) {
      if (e.type === 'text_delta') text += e.delta ?? ''
    }
    checkFn('真实回复正确', /PONG/.test(text), `got ${JSON.stringify(text)}`)
  }
}

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
