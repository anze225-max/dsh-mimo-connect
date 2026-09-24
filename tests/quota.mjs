/**
 * 剩余额度读取测试。
 *
 * 回归目标：
 *   1. `/api/user/usage` 的 percent 是「剩余」百分比，不是已用；
 *   2. 任何失败路径都返回 undefined，绝不抛错——额度显示不得影响推理；
 *   3. 缓存与失败退避生效，避免每次渲染都打一次上游；
 *   4. 凭证切换后旧额度必须失效。
 */
import { MiMoQuotaReader, parseQuota, QUOTA_CACHE_MS } from '../src/quota.js'
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

console.log('\n== parseQuota 解析 ==')
check('标准信封', parseQuota({ code: 0, message: 'success', data: { percent: 99.8, resetDate: '2026-09-30', resetAt: 1790782334 } }),
  { percent: 99.8, resetAt: 1790782334, resetDate: '2026-09-30' })
check('裸 data 也接受', parseQuota({ percent: 42 }), { percent: 42 })
check('缺 percent 返回 undefined', parseQuota({ data: { resetDate: '2026-09-30' } }), undefined)
check('非对象返回 undefined', parseQuota('nope'), undefined)
check('null 返回 undefined', parseQuota(null), undefined)
check('数组返回 undefined', parseQuota([1, 2]), undefined)
check('percent 非数字返回 undefined', parseQuota({ data: { percent: '99' } }), undefined)
check('NaN 返回 undefined', parseQuota({ data: { percent: Number.NaN } }), undefined)
check('越界被夹紧', parseQuota({ data: { percent: 120 } }).percent, 100)
check('负值被夹紧', parseQuota({ data: { percent: -5 } }).percent, 0)
check('可选字段缺失时不出现', Object.keys(parseQuota({ data: { percent: 50 } })), ['percent'])

/**
 * Build a session backed by a stub that behaves like the real gateway.
 *
 * Two behaviours are essential to reproduce, because getting either wrong makes
 * a stub pass or fail for reasons the plugin never sees:
 *
 *   - `ensureSession()` mints a `serviceToken` through the STS redirect chain
 *     before any business call, so the stub mints on `.../api/user/xiaomi/me`
 *     and serves the payload everywhere else;
 *   - a fresh session has no minted token, so `needsRenewal()` is true until
 *     that hop happens.
 *
 * @param body - the payload served to non-STS requests.
 * @param status - the HTTP status for that payload.
 * @param onCall - optional counter, invoked per non-STS request.
 * @returns the session.
 */
function sessionServing(body, status = 200, onCall) {
  return new MiMoSession({
    fetch: async (url) => {
      const { pathname } = new URL(url)
      if (pathname === '/api/user/xiaomi/me') {
        // Mint: hand back a token scoped to the server's parent domain.
        return new Response('', {
          status: 302,
          headers: { 'set-cookie': 'serviceToken=test-token; Domain=.xiaomimimo.com; Path=/' },
        })
      }
      onCall?.()
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    },
  })
}

console.log('\n== 成功读取 ==')
{
  let calls = 0
  const reader = new MiMoQuotaReader({
    getSession: () => sessionServing({ code: 0, data: { percent: 77.5, resetDate: '2026-09-30' } }, 200, () => { calls++ }),
  })
  const quota = await reader.read({})
  checkFn('读到额度', quota !== undefined)
  check('percent 正确', quota.percent, 77.5)
  checkFn('带 fetchedAt', typeof quota.fetchedAt === 'number')
  checkFn('确实发起过请求', calls > 0)
}

console.log('\n== 缓存命中不重复请求 ==')
{
  let calls = 0
  const reader = new MiMoQuotaReader({
    getSession: () => sessionServing({ code: 0, data: { percent: 60 } }, 200, () => { calls++ }),
  })
  await reader.read({})
  const first = calls
  await reader.read({})
  check('第二次走缓存', calls, first)
  await reader.read({ force: true })
  check('force 绕过缓存', calls, first + 1)
  checkFn('缓存窗口为正数', QUOTA_CACHE_MS > 0)
}

console.log('\n== 失败路径一律返回 undefined ==')
{
  const cases = {
    'HTTP 500': { body: 'boom', status: 500 },
    'HTTP 401': { body: 'nope', status: 401 },
    'HTML 响应': { body: '<html>login</html>', status: 200 },
    '非法 JSON': { body: '{not json', status: 200 },
    '缺 percent': { body: { code: 0, data: {} }, status: 200 },
  }
  for (const [label, spec] of Object.entries(cases)) {
    const reader = new MiMoQuotaReader({ getSession: () => sessionServing(spec.body, spec.status) })
    let threw = false
    let result
    try { result = await reader.read({}) } catch { threw = true }
    checkFn(`${label} 不抛错`, !threw)
    check(`${label} 返回 undefined`, result, undefined)
  }

  // 网络层异常单独构造，因为它不是响应而是抛错。
  const throwing = new MiMoQuotaReader({
    getSession: () => new MiMoSession({
      fetch: async (url) => {
        if (new URL(url).pathname === '/api/user/xiaomi/me') {
          return new Response('', {
            status: 302,
            headers: { 'set-cookie': 'serviceToken=tok; Domain=.xiaomimimo.com; Path=/' },
          })
        }
        throw new Error('ECONNREFUSED')
      },
    }),
  })
  let threw = false
  let result
  try { result = await throwing.read({}) } catch { threw = true }
  checkFn('网络异常不抛错', !threw)
  check('网络异常返回 undefined', result, undefined)
}

console.log('\n== 服务缺失时降级 ==')
{
  const reader = new MiMoQuotaReader({ getSession: () => undefined })
  check('无会话返回 undefined', await reader.read({}), undefined)
  const noGetter = new MiMoQuotaReader({})
  check('无 getSession 返回 undefined', await noGetter.read({}), undefined)
}

console.log('\n== invalidate 清空缓存 ==')
{
  let calls = 0
  const reader = new MiMoQuotaReader({
    getSession: () => sessionServing({ code: 0, data: { percent: 30 } }, 200, () => { calls++ }),
  })
  await reader.read({})
  const first = calls
  reader.invalidate()
  await reader.read({})
  check('invalidate 后重新请求', calls, first + 1)
}

console.log('\n== 失败退避 ==')
{
  let calls = 0
  const reader = new MiMoQuotaReader({
    getSession: () => sessionServing('boom', 500, () => { calls++ }),
  })
  await reader.read({})
  const first = calls
  await reader.read({})
  check('失败后短期内不再请求', calls, first)
}

console.log('\n== 并发读取只打一次上游 ==')
{
  let calls = 0
  const reader = new MiMoQuotaReader({
    getSession: () => new MiMoSession({
      fetch: async (url) => {
        if (new URL(url).pathname === '/api/user/xiaomi/me') {
          return new Response('', {
            status: 302,
            headers: { 'set-cookie': 'serviceToken=tok; Domain=.xiaomimimo.com; Path=/' },
          })
        }
        calls++
        await new Promise(r => setTimeout(r, 20))
        return new Response(JSON.stringify({ code: 0, data: { percent: 88 } }), { status: 200 })
      },
    }),
  })
  const results = await Promise.all([reader.read({}), reader.read({}), reader.read({})])
  check('三次并发只请求一次', calls, 1)
  checkFn('结果一致', results.every(r => r !== undefined && r.percent === 88))
}

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
