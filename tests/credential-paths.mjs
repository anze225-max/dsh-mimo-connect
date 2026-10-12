/**
 * 两条凭证来源的端到端验证。
 *
 * 插件对外承诺的「两种登录方式」就是本套件的两个主题：
 *
 *   ① 读取本机 MiMo 客户端的 cookie 库（只读复用，零提示）
 *   ② 插件自身 `login` 保存的凭证（没装客户端也能用）
 *
 * 本套件里只有 fetch 是测试替身；`apply()`、`MiMoCredentialStore`、
 * `MiMoSession`、`CookieJar` 全是真实代码，所以能覆盖到「会话是否真的带着
 * passToken 走完 STS 换取」这一层——而不是只测某个函数返回值。
 *
 * 替身里的 passport 是**严格**的：收不到 passToken 就返回登录页而不是回调，
 * 与真实 passport 行为一致。宽松的替身会让「jar 没播种」这种缺陷通过。
 */
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  copyFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MiMoCredentialStore, readDesktopCookies, writeOwnCredential } from '../src/credential.js'
import { MiMoSession } from '../src/session.js'
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

const MIMO_HOST = 'mimo-server-cn.xiaomimimo.com'
const ACCOUNT_HOST = 'account.xiaomi.com'
const root = mkdtempSync(join(tmpdir(), 'mimo-paths-'))

/** Build a Chromium-shaped cookie database. `wal: true` keeps rows in the -wal. */
function makeCookieDb(path, rows, { wal = false, keepOpen = false } = {}) {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  if (wal) db.prepare('PRAGMA journal_mode=WAL').get()
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)')
  const insert = db.prepare(
    'INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?, ?, ?, ?)',
  )
  for (const [host, name, value] of rows) insert.run(host, name, value, null)
  if (!keepOpen) db.close()
  return db
}

const REAL_ROWS = [
  ['.account.xiaomi.com', 'passToken', 'V1:DESKTOP-TOKEN'],
  ['.account.xiaomi.com', 'cUserId', 'DESKTOP-CUID'],
  ['.account.xiaomi.com', 'userId', '3207174710'],
  ['.xiaomi.com', 'uLocale', 'zh_CN'],
  ['www.example.com', 'tracking', 'noise'],
]

/** Headers stand-in carrying both `set-cookie` shapes the jar understands. */
function headersOf({ location, setCookie = [] } = {}) {
  const headers = new Headers()
  if (location !== undefined) headers.set('location', location)
  headers.getSetCookie = () => setCookie
  return headers
}

/**
 * Install a fetch double that speaks the real STS redirect chain.
 *
 * The passport hop mirrors the real one: it only redirects back to the STS
 * callback when the request actually carried `passToken`. That is what makes
 * "the jar was never seeded" observable instead of silently succeeding.
 *
 * @param onRequest - called with `{ host, path, cookie }` for each hop.
 */
function installUpstream(onRequest) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url)
    const cookie = init.headers?.Cookie ?? ''
    onRequest({ host: u.hostname, path: u.pathname, cookie })

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
      if (!cookie.includes('passToken=')) {
        // Strict: no passToken means "who are you?", not a callback.
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
          setCookie: ['deviceId=wb_test; Path=/; Domain=.account.xiaomi.com'],
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
          setCookie: ['serviceToken=ST-ESTABLISHED; Path=/; Domain=.xiaomimimo.com'],
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
  return () => {
    globalThis.fetch = original
  }
}

/**
 * Drive the REAL plugin `apply()` against a mock cordis context.
 *
 * @returns `{ status, hops, errors }` after letting `sync()` settle.
 */
async function applyPlugin({ home, cookieDb, pollSeconds = 0 }) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const hops = []
  const restore = installUpstream(hop => hops.push(hop))
  const errors = []

  const accessors = new Map()
  const base = {
    llm: { registerAdapter: () => () => {} },
    emit() {},
    effect() {},
    // cordis: a scoped inject stays pending while the service is absent.
    inject(deps, fn) {
      if (deps.some(d => !(d in base))) return
      fn(proxy)
    },
    accessor(name, options) {
      accessors.set(name, options)
      return () => accessors.delete(name)
    },
    logger: {
      warn(...a) {
        errors.push(a.map(String).join(' '))
      },
      error(...a) {
        errors.push(a.map(String).join(' '))
      },
    },
  }
  const proxy = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      if (accessors.has(prop)) return accessors.get(prop).get()
      return undefined
    },
    set(_target, prop) {
      throw new Error(`cannot set property "${String(prop)}" without provide`)
    },
  })

  const mod = await import('../src/index.js')
  mod.apply(proxy, { cookieDb, pollSeconds })
  await new Promise(r => setTimeout(r, 120))

  const status = await proxy.mimoStatus()

  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  restore()

  return { status, hops, errors }
}

/** Write the plugin's own credential into a temp DSH home. */
function seedOwnCredential(home, credential) {
  mkdirSync(home, { recursive: true })
  writeOwnCredential(join(home, '.mimo-connect-auth.json'), credential)
}

console.log('\n================ ① 读取本机 MiMo 客户端凭证 ================')

console.log('\n== ①-1 真实 Chromium cookie 库 → 解析出凭证并建立会话 ==')
{
  const dbPath = join(root, 'd1', 'Cookies')
  makeCookieDb(dbPath, REAL_ROWS)
  const home = join(root, 'home-d1')

  const { status, hops } = await applyPlugin({ home, cookieDb: dbPath })
  check('已登录（无需任何交互）', status.signedIn, true)
  check('来源标为 desktop', status.account.source, 'desktop')
  check('userId 正确', status.account.userId, '3207174710')
  checkFn('记录了 cookie 库路径', typeof status.account.cookiePath === 'string')
  check('会话已取得 serviceToken', status.session.hasServiceToken, true)

  const passportHop = hops.find(h => h.host === ACCOUNT_HOST)
  checkFn(
    'passport 那一跳确实带上了 passToken',
    passportHop !== undefined && passportHop.cookie.includes('passToken=V1:DESKTOP-TOKEN'),
    JSON.stringify(passportHop?.cookie),
  )
  checkFn('无任何告警（零提示保证）', status.signedIn && hops.length > 0)
}

console.log('\n== ①-2 只读保证：原库不被修改，且不留下临时文件 ==')
{
  const dbPath = join(root, 'd2', 'Cookies')
  makeCookieDb(dbPath, REAL_ROWS)
  const before = readFileSync(dbPath).toString('base64')
  const scratchPattern = /^mimo-ck-/
  const tmpBefore = readdirSync(tmpdir()).filter(f => scratchPattern.test(f)).length

  const store = new MiMoCredentialStore({
    env: {},
    ownPath: join(root, 'absent.json'),
    cookieCandidates: [dbPath],
  })
  const credential = await store.resolve()
  check('解析成功', credential.source, 'desktop')
  check('原库字节未变', readFileSync(dbPath).toString('base64') === before, true)
  check(
    '未留下 mimo-ck-* 临时文件',
    readdirSync(tmpdir()).filter(f => scratchPattern.test(f)).length,
    tmpBefore,
  )
}

console.log('\n== ①-3 回归：-wal 旁车复制失败时仍能拿到凭证 ==')
{
  // Chromium 把新 cookie 提交到 -wal，只在 checkpoint 时才折回主库。
  // 只复制主库会「打开成功但报 no such table: cookies」。修复前这会一路
  // 退化成「本机没有凭证」，正是本模块要服务的零提示场景。
  const dbPath = join(root, 'd3', 'Cookies')
  const open = makeCookieDb(dbPath, REAL_ROWS, { wal: true, keepOpen: true })

  // 先证明确实复现了那个陷阱：只复制主库时读不出任何行。
  const mainOnly = join(root, 'd3', 'main-only.db')
  copyFileSync(dbPath, mainOnly)
  check('前提：只复制主库确实读不到表', readDesktopCookies(mainOnly), undefined)

  // 再证明修复后的行为：-wal 复制抛错时，回退到只读打开原库。
  const recovered = readDesktopCookies(dbPath, {
    copyFile: (from, to) => {
      if (from.endsWith('-wal')) throw new Error('simulated: -wal 被占用')
      copyFileSync(from, to)
    },
  })
  checkFn('旁车复制失败仍解析出凭证', recovered !== undefined, JSON.stringify(recovered))
  check('passToken 正确恢复', recovered?.['.account.xiaomi.com']?.passToken, 'V1:DESKTOP-TOKEN')
  check('userId 正确恢复', recovered?.['.account.xiaomi.com']?.userId, '3207174710')

  open.close()
}

console.log('\n== ①-4 无凭证的库 / 垃圾文件 → 干净地报告未登录，不抛错 ==')
{
  const junk = join(root, 'd4', 'Cookies')
  mkdirSync(join(root, 'd4'), { recursive: true })
  writeFileSync(junk, 'not a database')
  check('垃圾文件 → undefined', readDesktopCookies(junk), undefined)

  const noPassport = join(root, 'd5', 'Cookies')
  makeCookieDb(noPassport, [['www.example.com', 'a', 'b']])
  const store = new MiMoCredentialStore({
    env: {},
    ownPath: join(root, 'none.json'),
    cookieCandidates: [noPassport],
  })
  const status = await store.status()
  check('库中没有 passport cookie → 未登录', status.signedIn, false)
  checkFn('提示里给出 login 指引', /login/.test(status.reason), status.reason)
}

console.log('\n================ ② 插件自身 login 凭证 ================')

console.log('\n== ②-1 login 存盘 → 插件直接可用（不依赖客户端）==')
{
  const home = join(root, 'home-login')
  seedOwnCredential(home, { passToken: 'V1:OWN-TOKEN', cUserId: 'OWN-C', userId: 'OWN-U' })
  const { status, hops } = await applyPlugin({
    home,
    cookieDb: join(root, 'absent', 'Cookies'),
  })
  check('已登录', status.signedIn, true)
  check('来源标为 plugin', status.account.source, 'plugin')
  check('会话已建立', status.session.hasServiceToken, true)
  const passportHop = hops.find(h => h.host === ACCOUNT_HOST)
  checkFn(
    '用的是插件自己的 passToken',
    passportHop !== undefined && passportHop.cookie.includes('passToken=V1:OWN-TOKEN'),
    JSON.stringify(passportHop?.cookie),
  )
}

console.log('\n== ②-2 两处都有凭证 ⇒ 插件自身的优先（文档承诺的顺序）==')
{
  const dbPath = join(root, 'd6', 'Cookies')
  makeCookieDb(dbPath, REAL_ROWS)
  const home = join(root, 'home-both')
  seedOwnCredential(home, { passToken: 'V1:OWN-WINS', cUserId: 'OWN-C', userId: 'OWN-U' })

  const { status, hops } = await applyPlugin({ home, cookieDb: dbPath })
  check('来源是 plugin', status.account.source, 'plugin')
  const passportHop = hops.find(h => h.host === ACCOUNT_HOST)
  checkFn(
    '发送的是插件凭证而不是桌面端凭证',
    passportHop !== undefined && passportHop.cookie.includes('passToken=V1:OWN-WINS'),
    JSON.stringify(passportHop?.cookie),
  )
}

console.log('\n== ②-3 回归：cUserId/userId 留空的凭证也必须能建立会话 ==')
{
  // `login` 明确允许这两项留空（只有 passToken 是 STS 必须的）。
  // 修复前 identityOf() 对这种凭证返回 undefined，index.js 的
  // `identity !== currentIdentity` 判定为「没变化」，于是永远不重建 jar、
  // 永远不播种 passToken —— 会话建立静默失败。
  const home = join(root, 'home-blank')
  seedOwnCredential(home, { passToken: 'V1:BLANK-IDS', cUserId: '', userId: '' })

  const { status, hops } = await applyPlugin({ home, cookieDb: join(root, 'absent2', 'Cookies') })
  check('已登录', status.signedIn, true)
  check('会话已建立（这是修复点）', status.session.hasServiceToken, true)
  const passportHop = hops.find(h => h.host === ACCOUNT_HOST)
  checkFn(
    'passport 那一跳带上了 passToken',
    passportHop !== undefined && passportHop.cookie.includes('passToken=V1:BLANK-IDS'),
    JSON.stringify(passportHop?.cookie ?? '(未到达该跳)'),
  )
}

console.log('\n== ②-4 回归：重新登录（换 passToken）后必须被采纳 ==')
{
  // 账号没变但 passToken 轮换了（passToken 实测 30 天过期，重新登录是文档
  // 给出的恢复路径）。修复前 identityOf() 只取 userId，认为「没变化」，
  // 于是运行中的插件继续用旧 token，直到重启才生效。
  const home = join(root, 'home-rotate')
  seedOwnCredential(home, { passToken: 'V1:OLD', cUserId: 'C', userId: '3207174710' })

  const store = new MiMoCredentialStore({
    env: { DSH_HOME: home },
    ownPath: join(home, '.mimo-connect-auth.json'),
    cookieCandidates: [],
  })
  const first = store.identityOf(await store.resolve())

  seedOwnCredential(home, { passToken: 'V1:NEW', cUserId: 'C', userId: '3207174710' })
  const second = store.identityOf(await store.resolve())
  checkFn('轮换后身份发生变化（会触发会话重建）', first !== second, `${first} vs ${second}`)
  checkFn('身份不含明文 token', !first.includes('V1:OLD') && !second.includes('V1:NEW'))

  // 同一凭证必须保持稳定，否则轮询会每个周期重建会话。
  const again = store.identityOf(await store.resolve())
  check('同一凭证身份稳定（不会每周期重换会话）', again, second)
}

console.log('\n== ②-5 回归：服务端吊销后必须能自愈（不必重启 DSH）==')
{
  // 真实 STS 探测显示：passport 认为凭证无效时，会用 `passToken=EXPIRED`
  // 明确吊销客户端手里的 token，jar 会照做删掉条目。
  //
  // 此时磁盘凭证**没有变化**，所以 identityOf() 判定「没变化」，旧的
  // adoptCredential 不会重新播种 jar —— 一次服务端吊销就把插件永久卡在
  // 「已登录但无法建立会话」，直到 DSH 重启。
  const home = join(root, 'home-revoke')
  seedOwnCredential(home, { passToken: 'V1:REVOKED-SOON', cUserId: 'C', userId: '3207174710' })

  const store = new MiMoCredentialStore({
    env: { DSH_HOME: home },
    ownPath: join(home, '.mimo-connect-auth.json'),
    cookieCandidates: [],
  })
  const credential = await store.resolve()
  const session = new MiMoSession({ jar: MiMoCredentialStore.jarFor(credential) })
  check('初始状态能送出 passToken', session.hasPassport(), true)

  // 服务端吊销。
  session.jar.set('account.xiaomi.com', 'passToken', 'EXPIRED')
  check('吊销后 hasPassport 为 false（jar 被清空）', session.hasPassport(), false)
  check(
    '吊销后确实送不出 passToken',
    session.jar.headerFor('https://account.xiaomi.com/pass/serviceLogin').includes('passToken='),
    false,
  )

  // 恢复路径：重新用磁盘凭证播种。这正是 index.js 现在会做的事。
  const reseeded = new MiMoSession({ jar: MiMoCredentialStore.jarFor(credential) })
  check('重新播种后恢复 hasPassport', reseeded.hasPassport(), true)
  checkFn(
    '重新播种后再次送出 passToken',
    reseeded.jar
      .headerFor('https://account.xiaomi.com/pass/serviceLogin')
      .includes('passToken=V1:REVOKED-SOON'),
  )
}

console.log('\n== ②-6 logout 只删自己的凭证，不碰桌面端 ==')
{
  const dbPath = join(root, 'd7', 'Cookies')
  makeCookieDb(dbPath, REAL_ROWS)
  const home = join(root, 'home-logout')
  seedOwnCredential(home, { passToken: 'V1:TEMP', cUserId: 'C', userId: 'U' })
  const ownPath = join(home, '.mimo-connect-auth.json')

  const store = new MiMoCredentialStore({
    env: { DSH_HOME: home },
    ownPath,
    cookieCandidates: [dbPath],
  })
  check('删前来源是 plugin', (await store.resolve()).source, 'plugin')

  rmSync(ownPath)
  const after = await store.resolve()
  check('删后回落到桌面端凭证', after.source, 'desktop')
  check('桌面端凭证未被影响', after.passToken, 'V1:DESKTOP-TOKEN')
}

rmSync(root, { recursive: true, force: true })
console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
