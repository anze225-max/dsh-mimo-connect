/**
 * CLI 端到端验证（功能②的入口就是它）。
 *
 * `bin/cli.js` 是用户实际敲的那条路径，而它此前没有任何测试。本套件用**真实
 * 子进程**跑真实 CLI：只有网络被 `--import` 预载的替身拦下，其余（readline
 * 交互、凭证存盘、会话换取、状态判定）都是真代码。
 *
 * 之所以能离线跑：CLI 的 `login` 在保存前会真的验证一次凭证，那一步要联网。
 * 预载替身把上游换成对 `passToken` **严格**的假 passport —— 收不到 passToken
 * 就当未登录。宽松替身会让「凭证没生效」这类缺陷照样通过，那正是本仓库在
 * desktop 路径上踩过的坑。
 *
 * 子进程的 stdio 走**文件描述符**而不是管道，因为受限沙箱下管道会 EPERM；
 * 文件方式在 CI 与本机都能用。
 */
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  openSync,
  closeSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'mimo-cli-'))

/**
 * Write the offline upstream double.
 *
 * `accept`  — a passport that believes a request carrying `passToken` and answers
 *             the real 3-hop STS chain, minting a serviceToken.
 * `reject`  — a passport that recognizes nothing: every hop is a login page, so
 *             the mint never yields a token.
 */
const stubPath = join(root, 'upstream-stub.mjs')
writeFileSync(
  stubPath,
  `
const mode = process.env.MIMO_STUB_MODE ?? 'accept'
const H = (o = {}) => {
  const h = new Headers()
  if (o.location !== undefined) h.set('location', o.location)
  h.getSetCookie = () => o.sc ?? []
  return h
}
const html = () => ({
  status: 200, ok: true, headers: H(),
  text: async () => '<html>passport login</html>',
  arrayBuffer: async () => new ArrayBuffer(0),
})

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url)
  const cookie = init.headers?.Cookie ?? ''
  if (mode === 'reject') return html()

  if (u.hostname === 'mimo-server-cn.xiaomimimo.com' && u.pathname === '/api/user/xiaomi/me') {
    const cb = 'https://mimo-server-cn.xiaomimimo.com/api/sts?sign=SIG'
    return { status: 302, headers: H({ location: 'https://account.xiaomi.com/pass/serviceLogin?callback=' + encodeURIComponent(cb) }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
  }
  if (u.hostname === 'account.xiaomi.com') {
    // 严格：没有 passToken 就不是已登录会话。
    if (!cookie.includes('passToken=')) return html()
    return { status: 302, headers: H({ location: u.searchParams.get('callback'), sc: ['deviceId=wb_cli; Domain=.account.xiaomi.com'] }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
  }
  if (u.pathname === '/api/sts') {
    return { status: 307, headers: H({ location: 'https://mimo-server-cn.xiaomimimo.com/api/user/xiaomi/me', sc: ['serviceToken=ST-CLI; Domain=.xiaomimimo.com'] }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
  }
  if (u.pathname === '/api/route/chat/completions') {
    return { status: 200, ok: true, headers: H(), text: async () => JSON.stringify({ choices: [{ message: { content: 'PONG' } }] }), arrayBuffer: async () => new ArrayBuffer(0) }
  }
  return { status: 200, ok: true, headers: H(), text: async () => '{}', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }
}
`,
)

/**
 * Run the real CLI in its own process.
 *
 * @param args - CLI arguments.
 * @param options - `stdin` text, extra env, and whether to preload the stub.
 * @returns `{ status, stdout, stderr }`.
 */
let spawnCount = 0
function spawnCli(args, { stdin = '', env = {}, stub = true } = {}) {
  const dir = join(root, `run-${spawnCount++}`)
  mkdirSync(dir, { recursive: true })
  const inPath = join(dir, 'stdin.txt')
  const outPath = join(dir, 'stdout.txt')
  const errPath = join(dir, 'stderr.txt')
  writeFileSync(inPath, stdin)

  const inFd = openSync(inPath, 'r')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')

  const nodeArgs = []
  if (stub) nodeArgs.push('--import', pathToFileURL(stubPath).href)
  nodeArgs.push(join(repoRoot, 'bin', 'cli.js'), ...args)

  const result = spawnSync(process.execPath, nodeArgs, {
    cwd: repoRoot,
    stdio: [inFd, outFd, errFd],
    env: { ...process.env, ...env },
  })

  closeSync(inFd)
  closeSync(outFd)
  closeSync(errFd)

  return {
    status: result.status,
    stdout: readFileSync(outPath, 'utf-8'),
    stderr: readFileSync(errPath, 'utf-8'),
  }
}

/** Build a Chromium-shaped cookie database at `path`. */
function makeCookieDb(path, rows) {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)')
  const insert = db.prepare(
    'INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?, ?, ?, ?)',
  )
  for (const [host, name, value] of rows) insert.run(host, name, value, null)
  db.close()
}

const DESKTOP_DB = join(root, 'desktop', 'Cookies')
makeCookieDb(DESKTOP_DB, [
  ['.account.xiaomi.com', 'passToken', 'V1:CLI-DESKTOP'],
  ['.account.xiaomi.com', 'cUserId', 'CLI-CUID'],
  ['.account.xiaomi.com', 'userId', '3207174711'],
])

console.log('\n================ CLI：功能②（插件自身 login）================')

console.log('\n== login：可留空 cUserId/userId，且必须真的验证后才保存 ==')
{
  const home = join(root, 'home-login')
  mkdirSync(home, { recursive: true })
  const ownPath = join(home, '.mimo-connect-auth.json')

  // 三个输入：passToken、cUserId（留空）、userId（留空），正是文档允许的用法。
  const r = spawnCli(['login'], {
    stdin: 'V1:STDIN-TOKEN\n\n\n',
    env: { DSH_HOME: home, MIMO_COOKIE_DB: join(root, 'nope', 'Cookies') },
  })
  check('退出码 0', r.status, 0)
  checkFn('报告登录成功', /登录成功/.test(r.stdout), r.stdout.slice(-200))
  check('凭证文件已写入', existsSync(ownPath), true)

  const saved = JSON.parse(readFileSync(ownPath, 'utf-8'))
  check('保存了 passToken', saved.credential.passToken, 'V1:STDIN-TOKEN')
  check('留空字段被接受', saved.credential.userId, '')
  check('记录了格式版本', saved.version, 1)

  // 存盘后 status 必须认这个凭证 —— 这是 login 与 status 之间真实的接续。
  const st = spawnCli(['status', '--json'], { env: { DSH_HOME: home } })
  const doc = JSON.parse(st.stdout)
  check('status 使用插件凭证', doc.account.source, 'plugin')
  check('status 退出码 0', st.status, 0)
}

console.log('\n== login：凭证被上游拒绝时 → 不保存、退出码非 0 ==')
{
  const home = join(root, 'home-reject')
  mkdirSync(home, { recursive: true })
  const ownPath = join(home, '.mimo-connect-auth.json')

  const r = spawnCli(['login'], {
    stdin: 'V1:BOGUS\n\n\n',
    env: {
      DSH_HOME: home,
      MIMO_COOKIE_DB: join(root, 'nope', 'Cookies'),
      MIMO_STUB_MODE: 'reject',
    },
  })
  checkFn('退出码非 0', r.status !== 0, `status=${r.status}`)
  checkFn(
    '说明了验证失败',
    /验证失败/.test(r.stderr) || /验证失败/.test(r.stdout),
    r.stderr.slice(-200),
  )
  check('未保存未经验证的凭证', existsSync(ownPath), false)
}

console.log('\n== login：passToken 留空 → 取消，不写文件 ==')
{
  const home = join(root, 'home-cancel')
  mkdirSync(home, { recursive: true })
  const ownPath = join(home, '.mimo-connect-auth.json')

  const r = spawnCli(['login'], {
    stdin: '\n\n\n',
    env: { DSH_HOME: home, MIMO_COOKIE_DB: join(root, 'nope', 'Cookies') },
  })
  checkFn('退出码非 0', r.status !== 0, `status=${r.status}`)
  checkFn('提示已取消', /取消/.test(r.stdout) || /取消/.test(r.stderr), r.stdout.slice(-200))
  check('未写入凭证', existsSync(ownPath), false)
}

console.log('\n== logout：只删自己的凭证，并说明桌面端不受影响 ==')
{
  const home = join(root, 'home-logout')
  mkdirSync(home, { recursive: true })
  const ownPath = join(home, '.mimo-connect-auth.json')
  writeFileSync(
    ownPath,
    JSON.stringify({
      version: 1,
      credential: { passToken: 'V1:TEMP', cUserId: 'C', userId: 'U' },
    }),
  )

  const env = { DSH_HOME: home, MIMO_COOKIE_DB: DESKTOP_DB }
  const before = spawnCli(['status', '--json'], { env })
  check('删前用插件凭证', JSON.parse(before.stdout).account.source, 'plugin')

  const r = spawnCli(['logout'], { env })
  check('退出码 0', r.status, 0)
  checkFn('提示桌面端登录态不受影响', /桌面端/.test(r.stdout), r.stdout.trim())
  check('凭证文件已删除', existsSync(ownPath), false)

  const after = spawnCli(['status', '--json'], { env })
  check('删后回落到桌面端', JSON.parse(after.stdout).account.source, 'desktop')
}

console.log('\n== logout：本来就没有凭证 → 友好提示而非报错 ==')
{
  const home = join(root, 'home-nologout')
  mkdirSync(home, { recursive: true })
  const r = spawnCli(['logout'], { env: { DSH_HOME: home } })
  check('退出码 0', r.status, 0)
  checkFn('说明没有凭证', /没有保存凭证/.test(r.stdout), r.stdout.trim())
}

console.log('\n================ CLI：功能①（读取客户端凭证）================')

console.log('\n== status：桌面端 cookie 库 → 认作已登录 ==')
{
  const home = join(root, 'home-status')
  mkdirSync(home, { recursive: true })
  const r = spawnCli(['status', '--json'], {
    env: { DSH_HOME: home, MIMO_COOKIE_DB: DESKTOP_DB },
  })
  const doc = JSON.parse(r.stdout)
  check('退出码 0', r.status, 0)
  check('signedIn 为 true', doc.signedIn, true)
  check('来源是 desktop', doc.account.source, 'desktop')
  check('userId 正确', doc.account.userId, '3207174711')
  checkFn('列出了内置模型', Array.isArray(doc.models) && doc.models.length > 0)
  checkFn('状态里不含敏感值', !JSON.stringify(doc).includes('V1:CLI-DESKTOP'))
}

console.log('\n== status：无任何凭证 → 退出码 1 并给出 login 指引 ==')
{
  const home = join(root, 'home-none')
  mkdirSync(home, { recursive: true })
  const r = spawnCli(['status'], {
    env: { DSH_HOME: home, MIMO_COOKIE_DB: join(root, 'nope', 'Cookies') },
  })
  check('退出码 1', r.status, 1)
  checkFn('提示未登录', /未登录/.test(r.stdout), r.stdout.trim())
  checkFn('列出探测路径便于排查', /cookie 探测路径/.test(r.stdout), r.stdout.trim())
}

console.log('\n== doctor：已登录机器上的诊断必须退出 0 ==')
{
  const home = join(root, 'home-doctor')
  mkdirSync(home, { recursive: true })
  const r = spawnCli(['doctor'], {
    env: { DSH_HOME: home, MIMO_COOKIE_DB: DESKTOP_DB },
  })
  check('退出码 0', r.status, 0)
  checkFn('报告可以建立会话', /可以建立会话/.test(r.stdout), r.stdout.slice(-300))
  checkFn('列出探测过的路径', /探测过的桌面端路径/.test(r.stdout))
}

console.log('\n== verify：真实调用一次模型（上游为替身）==')
{
  const home = join(root, 'home-verify')
  mkdirSync(home, { recursive: true })
  const r = spawnCli(['verify'], {
    env: { DSH_HOME: home, MIMO_COOKIE_DB: DESKTOP_DB },
  })
  check('退出码 0', r.status, 0)
  checkFn('会话建立成功', /serviceToken 已建立/.test(r.stdout), r.stdout.slice(-300))
  checkFn('拿到模型回复', /模型返回: "PONG"/.test(r.stdout), r.stdout.slice(-300))
  checkFn('结论为工作正常', /插件工作正常/.test(r.stdout))
}

console.log('\n== verify：无凭证 → 退出码 1，不发起调用 ==')
{
  const home = join(root, 'home-verify-none')
  mkdirSync(home, { recursive: true })
  const r = spawnCli(['verify'], {
    env: { DSH_HOME: home, MIMO_COOKIE_DB: join(root, 'nope', 'Cookies') },
  })
  check('退出码 1', r.status, 1)
  checkFn('提示未找到凭证', /未找到 MiMo 凭证/.test(r.stderr), r.stderr.trim())
}

console.log('\n================ CLI：参数处理 ================')

console.log('\n== 无参数 / --help → 打印用法 ==')
{
  const r = spawnCli([], { stub: false })
  check('退出码 0', r.status, 0)
  checkFn('打印用法', /用法:/.test(r.stdout), r.stdout.slice(0, 200))
  checkFn(
    '列出全部子命令',
    ['status', 'login', 'logout', 'verify', 'doctor'].every(c => r.stdout.includes(c)),
  )
}

console.log('\n== 未知子命令 → 退出码 1 并显示用法 ==')
{
  const r = spawnCli(['frobnicate'], { stub: false })
  check('退出码 1', r.status, 1)
  checkFn('指出未知子命令', /未知子命令: frobnicate/.test(r.stderr), r.stderr.trim())
  // `usage()` writes to stdout while the error goes to stderr, so the two
  // streams have to be checked separately rather than as one blob.
  checkFn('用法打印在 stdout', /用法:/.test(r.stdout), r.stdout.slice(0, 200))
}

rmSync(root, { recursive: true, force: true })
console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
