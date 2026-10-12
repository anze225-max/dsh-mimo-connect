/**
 * Catalog tests: gateway-first roster with a snapshot fallback.
 *
 * These matter because the catalog is what the model picker shows. Two
 * failure modes are specifically guarded:
 *
 *   - **inventing a roster** — a silent fallback that presents the stale
 *     snapshot as if it were current, or a parse that accepts the wrong shape
 *     and yields nonsense model ids;
 *   - **blanking the roster** — letting an empty or failed gateway response
 *     wipe a perfectly usable fallback, which would turn a transient upstream
 *     hiccup into "no models available".
 *
 * No credentials and no network are needed: the session is a stub.
 */
import {
  MiMoCatalog,
  FALLBACK_MIMO_MODELS,
  findModelArray,
  normalizeGatewayModel,
  isChatModel,
  GATEWAY_MODEL_PATHS,
} from '../src/catalog.js'

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  PASS ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}\n       期望 ${e}\n       实际 ${a}`)
  }
}
const checkFn = (label, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  PASS ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label} ${detail}`)
  }
}

/** A session stub whose `request` returns a scripted response. */
function stubSession(responses) {
  const calls = []
  return {
    calls,
    async request(url, init) {
      calls.push({ url, init })
      const next = responses.shift()
      if (next === undefined) throw new Error('unexpected request')
      if (next.throws) throw new Error(next.throws)
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        headers: new Headers({ 'content-type': next.contentType ?? 'application/json' }),
        async text() {
          return next.body ?? ''
        },
        async arrayBuffer() {
          return new ArrayBuffer(0)
        },
      }
    },
  }
}

console.log('\n== 默认状态：快照，且如实标注 ==')
{
  const c = new MiMoCatalog()
  check('source 为 builtin', c.source(), 'builtin')
  check(
    '默认就是内置快照',
    c.current().map(m => m.id),
    FALLBACK_MIMO_MODELS.map(m => m.id),
  )
}

console.log('\n== 网关优先：拿到清单就采用并改标来源 ==')
{
  const c = new MiMoCatalog()
  const session = stubSession([
    {
      status: 200,
      body: JSON.stringify({ data: { models: [{ id: 'gateway-a' }, { id: 'gateway-b' }] } }),
    },
  ])
  const ok = await c.refreshFromGateway(session)
  check('刷新成功', ok, true)
  check('来源变为 gateway', c.source(), 'gateway')
  check(
    '用的是网关清单',
    c.current().map(m => m.id),
    ['gateway-a', 'gateway-b'],
  )
}

console.log('\n== 空清单绝不清空可用的回退 ==')
{
  const c = new MiMoCatalog()
  // 网关连上但返回空列表 —— 不能让选择器变空
  const session = stubSession([{ status: 200, body: JSON.stringify({ data: { models: [] } }) }])
  const ok = await c.refreshFromGateway(session)
  check('空清单不算成功', ok, false)
  check(
    '仍保留快照',
    c.current().map(m => m.id),
    FALLBACK_MIMO_MODELS.map(m => m.id),
  )
  check('来源仍为 builtin（未被谎报为 gateway）', c.source(), 'builtin')
}

console.log('\n== 401/403 表示无权限：回退快照，不重试其它路径 ==')
{
  const c = new MiMoCatalog()
  const session = stubSession([{ status: 401, body: '' }])
  const ok = await c.refreshFromGateway(session)
  check('未采用', ok, false)
  check('来源仍为 builtin', c.source(), 'builtin')
  check('只发起一次请求（401 后不再试其它端点）', session.calls.length, 1)
}

console.log('\n== 一个端点失败会继续尝试下一个 ==')
{
  const c = new MiMoCatalog()
  const session = stubSession([
    { status: 404, body: 'not found' },
    { status: 200, body: JSON.stringify([{ id: 'second-path-worked' }]) },
  ])
  const ok = await c.refreshFromGateway(session)
  check('第二个端点成功', ok, true)
  check(
    '采用了它的清单',
    c.current().map(m => m.id),
    ['second-path-worked'],
  )
  checkFn('确实试了两个端点', session.calls.length === 2, `实际 ${session.calls.length}`)
}

console.log('\n== 异常与非 JSON 响应不会抛出 ==')
{
  const c = new MiMoCatalog()
  const session = stubSession([{ throws: 'network down' }])
  const ok = await c.refreshFromGateway(session)
  check('网络异常 → 未采用', ok, false)
  check('来源仍为 builtin', c.source(), 'builtin')

  const c2 = new MiMoCatalog()
  const session2 = stubSession([{ status: 200, body: '<html>login page</html>' }])
  check('HTML 响应 → 未采用', await c2.refreshFromGateway(session2), false)
}

console.log('\n== 非聊天条目被过滤（ASR/TTS/图像不能服务一轮对话）==')
{
  check('ASR 被排除', isChatModel({ id: 'a', type: 'asr' }), false)
  check('TTS 被排除', isChatModel({ id: 'b', type: 'tts' }), false)
  check('image 被排除', isChatModel({ id: 'c', type: 'image' }), false)
  check('embedding 被排除', isChatModel({ id: 'd', kind: 'embedding' }), false)
  check('text 保留', isChatModel({ id: 'e', type: 'text' }), true)
  check('chat 保留', isChatModel({ id: 'f', type: 'chat' }), true)
  check('未标注类型保留（宁可试也不要误拒）', isChatModel({ id: 'g' }), true)

  const c = new MiMoCatalog()
  const session = stubSession([
    {
      status: 200,
      body: JSON.stringify({
        data: {
          models: [
            { id: 'chat-ok', type: 'text' },
            { id: 'asr-bad', type: 'asr' },
            { id: 'tts-bad', type: 'tts' },
          ],
        },
      }),
    },
  ])
  await c.refreshFromGateway(session)
  check(
    '只留下聊天模型',
    c.current().map(m => m.id),
    ['chat-ok'],
  )
}

console.log('\n== 字段别名与类型守卫 ==')
{
  const a = normalizeGatewayModel({
    id: 'm1',
    displayName: 'Model One',
    contextWindow: 1000,
    maxTokens: 100,
  })
  check('读取 displayName', a.name, 'Model One')
  check('读取 contextWindow', a.contextWindow, 1000)
  check('读取 maxTokens', a.maxTokens, 100)

  const b = normalizeGatewayModel({ id: 'm2', context_length: 2000, max_tokens: 200 })
  check('下划线别名 context_length', b.contextWindow, 2000)
  check('下划线别名 max_tokens', b.maxTokens, 200)

  // 类型不对的值必须被忽略，而不是当成有效数字用
  const c = normalizeGatewayModel({ id: 'm3', contextWindow: 'big', maxTokens: null })
  checkFn('错误类型回退到默认值', typeof c.contextWindow === 'number', JSON.stringify(c))

  check('无 id 返回 undefined', normalizeGatewayModel({ name: '' }), undefined)
  check('字符串条目可用', normalizeGatewayModel('plain-id').id, 'plain-id')

  // 图片能力可由 input / modalities 推出
  check(
    'input 含 image',
    normalizeGatewayModel({ id: 'x', input: ['text', 'image'] }).supportsImages,
    true,
  )
  check('input 无 image', normalizeGatewayModel({ id: 'x', input: ['text'] }).supportsImages, false)
  check(
    'modalities 含 image',
    normalizeGatewayModel({ id: 'x', modalities: ['image'] }).supportsImages,
    true,
  )

  // 已知内置模型保留其倍率与名称
  const known = normalizeGatewayModel({ id: 'mimo-v2.6-flash' })
  check('已知模型沿用内置倍率', known.displayRatio, 0.4)
  check('已知模型沿用内置名称', known.name, 'MiMo V2.6 Flash')
}

console.log('\n== findModelArray 兼容多种信封 ==')
{
  check('裸数组', findModelArray([{ id: 'a' }]).length, 1)
  check('data.models', findModelArray({ data: { models: [{ id: 'a' }] } }).length, 1)
  check('data.list', findModelArray({ data: { list: [{ id: 'a' }] } }).length, 1)
  check('data 直接是数组', findModelArray({ data: [{ id: 'a' }] }).length, 1)
  check('顶层 models', findModelArray({ models: [{ id: 'a' }] }).length, 1)
  check('找不到时返回 undefined', findModelArray({ foo: 'bar' }), undefined)
  check('null 安全', findModelArray(null), undefined)
}

console.log('\n== 端点顺序：已确认的 401 端点排第一 ==')
{
  check('首选 /api/route/models', GATEWAY_MODEL_PATHS[0], '/api/route/models')
}

console.log('\n== adoptGatewayModels 直接调用 ==')
{
  const c = new MiMoCatalog()
  check('空数组不采用', c.adoptGatewayModels([]), false)
  check('undefined 不采用', c.adoptGatewayModels(undefined), false)
  check('来源未变', c.source(), 'builtin')
  check('有内容则采用', c.adoptGatewayModels([{ id: 'z' }]), true)
  check('来源已变', c.source(), 'gateway')
  check(
    '内容正确',
    c.current().map(m => m.id),
    ['z'],
  )
}

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
