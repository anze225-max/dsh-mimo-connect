/**
 * 会话自愈验证：服务端吊销后，插件必须能自己恢复。
 *
 * 这一条来自**真实服务器**的观察，不是设想出来的场景。逐跳探测真实 STS 链路时
 * 看到：passport 认为凭证无效，会用 `passToken=EXPIRED` 明确吊销客户端手里的
 * token，而 CookieJar 会照做（把条目删掉）—— 这个行为本身是对的。
 *
 * 问题在于**恢复**：磁盘上的凭证文件没有任何变化，所以 `identityOf()` 判定
 * 「身份没变」，`index.js` 不会重新播种 jar。一次服务端吊销就把插件永久卡在
 * 「已登录、但永远建立不了会话」，直到 DSH 重启。
 *
 * 本套件用真实 `apply()` 驱动完整路径，并且**在吊销只发生一次**的条件下断言
 * 自愈。这个「只吊销一次」的设定很关键：它让测试有判别力 —— 去掉
 * `hasPassport()` 那段恢复逻辑，本套件必然失败（已验证）。
 *
 * 若吊销持续发生，那是凭证真的失效，应当报错而不是反复自愈，因此不在本套件
 * 的断言范围内。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOwnCredential } from '../src/credential.js'

const MIMO_HOST = 'mimo-server-cn.xiaomimimo.com'
const ACCOUNT_HOST = 'account.xiaomi.com'

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

const root = mkdtempSync(join(tmpdir(), 'mimo-recovery-'))
const home = join(root, 'home')
writeOwnCredential(join(home, '.mimo-connect-auth.json'), {
  passToken: 'V1:RECOVERY-TOKEN',
  cUserId: 'RECOVERY-CUID',
  userId: '3207174710',
})

/** 吊销只发生一次：「会话失效，但凭证本身仍然有效」。 */
let revokeUsed = false
let hopsWithToken = 0
let hopsWithoutToken = 0

const headersOf = (o = {}) => {
  const h = new Headers()
  if (o.location !== undefined) h.set('location', o.location)
  h.getSetCookie = () => o.sc ?? []
  return h
}

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url)
  const cookie = init.headers?.Cookie ?? ''

  if (u.hostname === MIMO_HOST && u.pathname === '/api/user/xiaomi/me') {
    const cb = `https://${MIMO_HOST}/api/sts?sign=SIG`
    return {
      status: 302,
      headers: headersOf({
        location: `https://${ACCOUNT_HOST}/pass/serviceLogin?callback=${encodeURIComponent(cb)}`,
      }),
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    }
  }

  if (u.hostname === ACCOUNT_HOST) {
    const hasToken = cookie.includes('passToken=')
    if (hasToken) hopsWithToken++
    else hopsWithoutToken++

    if (hasToken && !revokeUsed) {
      revokeUsed = true
      return {
        status: 302,
        headers: headersOf({
          location: `https://${ACCOUNT_HOST}/fe/service/login`,
          sc: [
            'passToken=EXPIRED; Domain=.account.xiaomi.com',
            'cUserId=EXPIRED; Domain=.account.xiaomi.com',
          ],
        }),
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    }

    if (!hasToken) {
      // 严格：没有 passToken 就是未登录页面，不是回调。
      return {
        status: 200,
        ok: true,
        headers: headersOf(),
        text: async () => '<html>passport login</html>',
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    }

    return {
      status: 302,
      headers: headersOf({
        location: u.searchParams.get('callback'),
        sc: ['deviceId=wb_recovery; Domain=.account.xiaomi.com'],
      }),
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    }
  }

  if (u.pathname === '/api/sts') {
    return {
      status: 307,
      headers: headersOf({
        location: `https://${MIMO_HOST}/api/user/xiaomi/me`,
        sc: ['serviceToken=ST-RECOVERED; Domain=.xiaomimimo.com'],
      }),
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    }
  }

  return {
    status: 200,
    ok: true,
    headers: headersOf(),
    text: async () => '{}',
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

process.env.DSH_HOME = home
const accessors = new Map()
const base = {
  llm: { registerAdapter: () => () => {} },
  emit() {},
  effect() {},
  inject(deps, fn) {
    if (deps.some(d => !(d in base))) return
    fn(proxy)
  },
  accessor(n, o) {
    accessors.set(n, o)
    return () => accessors.delete(n)
  },
  logger: { warn() {}, error() {} },
}
const proxy = new Proxy(base, {
  get(t, p, r) {
    if (p in t) return Reflect.get(t, p, r)
    if (accessors.has(p)) return accessors.get(p).get()
    return undefined
  },
  set(_t, p) {
    throw new Error(`cannot set property "${String(p)}" without provide`)
  },
})

console.log('\n== 服务端吊销后必须能自愈（不必重启 DSH）==')

const mod = await import('../src/index.js')
// 快速轮询：自愈要发生在下一轮 sync 上，这正是缺陷会显形的地方。
// cookieDb 指向不存在的路径，确保只用插件自身凭证。
mod.apply(proxy, { cookieDb: join(root, 'absent', 'Cookies'), pollSeconds: 0.25 })

// 留足时间让「吊销 → 下一轮 sync → 重新播种 → 再 mint」走完。
await new Promise(r => setTimeout(r, 3000))

const status = await proxy.mimoStatus()
console.log(`  passport 带 token ${hopsWithToken} 次 / 不带 token ${hopsWithoutToken} 次`)
console.log(`  最终 jar: ${status.session.cookies || '(空)'}`)

checkFn('吊销路径确实被触发过（否则本套件没有判别力）', revokeUsed === true)
checkFn(
  '吊销确实让 jar 丢掉过 passToken',
  hopsWithoutToken > 0,
  `不带 token 的跳转次数 = ${hopsWithoutToken}`,
)
checkFn('仍报告已登录（凭证文件还在）', status.signedIn === true)
checkFn(
  '自愈：jar 重新含 passToken',
  (status.session.cookies ?? '').includes('account.xiaomi.com: [passToken'),
  status.session.cookies,
)
checkFn(
  '自愈：仍能建立会话，未被永久卡死',
  status.session.hasServiceToken === true,
  JSON.stringify(status.session),
)

globalThis.fetch = realFetch
rmSync(root, { recursive: true, force: true })
console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
