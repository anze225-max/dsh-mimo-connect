/**
 * 端到端验证：模拟一个真实网关，确认「网关优先 + 快照兜底」整条链路真的工作。
 *
 * 这是在没有订阅凭证的情况下，能对 C1 改造做出的最强验证——用假的 HTTP 响应
 * 驱动真实的 `MiMoCatalog`，覆盖实际会遇到的各种上游状态。
 */
import { MiMoCatalog, FALLBACK_MIMO_MODELS } from '../src/catalog.js'

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

/** 一个最小 HTTP 服务器，按脚本返回响应。 */
import { createServer } from 'node:http'

/**
 * 用真实 HTTP 服务器（而非 stub）驱动，这样 `session.request` 走的
 * 是真 fetch，能发现 URL 拼接、header、JSON 解析等层面的问题。
 */
async function withServer(handler, fn) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

/**
 * 一个只有 request 的最小 session，原样转发到本地测试服务器。
 *
 * 只实现 `request`，因为目录刷新只需要这一个方法——这也验证了
 * `refreshFromGateway` 对 session 的依赖确实很窄。
 *
 * 注意：请求的 URL 由 `refreshFromGateway` 的 `baseUrl` 决定。这个假 session
 * 不去解析它，而是直接把「路径」映射到本地服务器，这样测试既覆盖了真实
 * 的 HTTP 往返，又不需要连真网关。
 */
function sessionFor(baseUrl) {
  return {
    async request(url) {
      const path = new URL(url).pathname
      return fetch(`${baseUrl}${path}`)
    },
  }
}

console.log('\n== 场景 1：网关正常返回清单 → 采用网关的 ==')
await withServer(
  (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        code: 0,
        data: {
          models: [
            {
              id: 'sub-model-a',
              displayName: '订阅模型 A',
              contextWindow: 128000,
              maxTokens: 8192,
              input: ['text', 'image'],
            },
            { id: 'sub-model-b', displayName: '订阅模型 B', contextWindow: 64000, maxTokens: 4096 },
            { id: 'whisper', type: 'asr' },
          ],
        },
      }),
    )
  },
  async base => {
    const catalog = new MiMoCatalog()
    const ok = await catalog.refreshFromGateway(sessionFor(base), { baseUrl: base })
    check('刷新成功', ok, true)
    check('来源标为 gateway', catalog.source(), 'gateway')
    check(
      '采用了网关清单（并过滤掉 ASR）',
      catalog.current().map(m => m.id),
      ['sub-model-a', 'sub-model-b'],
    )
    const a = catalog.current()[0]
    check('保留了网关给的名字', a.name, '订阅模型 A')
    check('保留了网关给的上下文窗口', a.contextWindow, 128000)
    check('从 input 推出图片能力', a.supportsImages, true)
  },
)

console.log('\n== 场景 2：网关 401（无订阅/未登录）→ 用快照并如实标注 ==')
await withServer(
  (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('')
  },
  async base => {
    const catalog = new MiMoCatalog()
    const ok = await catalog.refreshFromGateway(sessionFor(base), { baseUrl: base })
    check('未采用', ok, false)
    check('来源如实标为 builtin', catalog.source(), 'builtin')
    check(
      '仍可用（快照兜底）',
      catalog.current().map(m => m.id),
      FALLBACK_MIMO_MODELS.map(m => m.id),
    )
  },
)

console.log('\n== 场景 3：网关 500 → 快照兜底 ==')
await withServer(
  (req, res) => {
    res.writeHead(500)
    res.end('boom')
  },
  async base => {
    const catalog = new MiMoCatalog()
    check('未采用', await catalog.refreshFromGateway(sessionFor(base), { baseUrl: base }), false)
    check('来源仍为 builtin', catalog.source(), 'builtin')
  },
)

console.log('\n== 场景 4：返回 HTML（未认证时的典型行为）→ 快照兜底 ==')
await withServer(
  (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body>login</body></html>')
  },
  async base => {
    const catalog = new MiMoCatalog()
    check('未采用', await catalog.refreshFromGateway(sessionFor(base), { baseUrl: base }), false)
    check('来源仍为 builtin', catalog.source(), 'builtin')
  },
)

console.log('\n== 场景 5：第一个端点 404，第二个可用 → 自动降级到备用端点 ==')
await withServer(
  (req, res) => {
    if (req.url === '/api/route/model/list') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ id: 'from-fallback-path' }]))
      return
    }
    res.writeHead(404)
    res.end('')
  },
  async base => {
    const catalog = new MiMoCatalog()
    const allowed = ['/api/route/models', '/api/route/model/list', '/api/models']
    const ok = await catalog.refreshFromGateway(sessionFor(base), { baseUrl: base })
    check('通过备用端点成功', ok, true)
    check(
      '采用了它的清单',
      catalog.current().map(m => m.id),
      ['from-fallback-path'],
    )
  },
)

console.log('\n== 场景 6：网关返回空清单 → 绝不清空选择器 ==')
await withServer(
  (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: { models: [] } }))
  },
  async base => {
    const catalog = new MiMoCatalog()
    check('不算成功', await catalog.refreshFromGateway(sessionFor(base), { baseUrl: base }), false)
    check(
      '快照仍在',
      catalog.current().map(m => m.id),
      FALLBACK_MIMO_MODELS.map(m => m.id),
    )
    check('来源未谎报', catalog.source(), 'builtin')
  },
)

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
