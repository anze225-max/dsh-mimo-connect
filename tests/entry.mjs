/**
 * Plugin-entry tests.
 *
 * Drives `apply()` with a cordis-faithful mock context and asserts the
 * registration lifecycle, the credential-source priority (the zero-prompt
 * guarantee), and the accessor regression that previously took the whole
 * plugin tree down.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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

/** Build a Chromium-shaped cookie database. */
function makeCookieDb(path, rows) {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)')
  const insert = db.prepare('INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?, ?, ?, ?)')
  for (const [host, name, value] of rows) insert.run(host, name, value, null)
  db.close()
}

const REAL_ROWS = [
  ['.account.xiaomi.com', 'cUserId', 'CUID-123'],
  ['.account.xiaomi.com', 'passToken', 'V1:PASS-TOKEN'],
  ['.account.xiaomi.com', 'userId', '3207174710'],
]

/**
 * Mock host context.
 *
 * The proxy mimics cordis: writing an undeclared property is a service write
 * and MUST throw. A plain object silently accepted `ctx.status = fn` and hid
 * the exact bug that broke DSH startup.
 */
function makeHost({ cookieDb }) {
  const registrations = []
  const emissions = []
  const effects = []
  const errors = []
  const accessors = new Map()

  const base = {
    llm: {
      registerAdapter(routes, adapter) {
        registrations.push({ routes, adapter })
        return () => { registrations.pop() }
      },
    },
    emit(event) { emissions.push(event) },
    effect(fn) { effects.push(fn) },
    inject(_deps, fn) { fn(proxy) },
    accessor(name, options) {
      if (accessors.has(name)) throw new Error(`property "${name}" is already declared as accessor`)
      accessors.set(name, options)
      return () => accessors.delete(name)
    },
    logger: {
      warn(...a) { errors.push(['warn', ...a]) },
      error(...a) { errors.push(['error', ...a]) },
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

  return {
    ctx: proxy,
    registrations,
    emissions,
    effects,
    errors,
    accessors,
    config: cookieDb === undefined ? { pollSeconds: 0 } : { cookieDb, pollSeconds: 0 },
  }
}

function applyPlugin(mod, ctx, config) {
  try {
    mod.apply(ctx, config)
    return undefined
  } catch (error) {
    return error
  }
}

const root = mkdtempSync(join(tmpdir(), 'mimo-entry-'))
const mod = await import(new URL('../src/index.js', import.meta.url))

console.log('\n== 插件元数据 ==')
check('插件名', mod.name, 'llm-mimo')
check('注入 llm', mod.inject, ['llm'])
checkFn('Config 存在', mod.Config !== undefined)
checkFn('apply 是函数', typeof mod.apply === 'function')

console.log('\n== 桌面端已登录 ⇒ 零提示（核心保证）==')
{
  const dbPath = join(root, 'desktop', 'Cookies')
  makeCookieDb(dbPath, REAL_ROWS)
  const host = makeHost({ cookieDb: dbPath })
  const err = applyPlugin(mod, host.ctx, host.config)
  checkFn('apply 不抛异常', err === undefined, err?.message)
  checkFn('provider 已注册', host.registrations.length === 1)
  check('注册路由', host.registrations[0].routes, ['mimo'])
  checkFn('注册了销毁 effect', host.effects.length >= 1)

  await new Promise(r => setTimeout(r, 80))

  const status = await host.ctx.mimoStatus()
  check('状态为已登录', status.signedIn, true)
  check('来源是桌面端', status.account.source, 'desktop')
  check('用户 id 正确', status.account.userId, '3207174710')
  check('已注册', status.registered, true)
  check('内置模型列表', status.catalog.models, ['mimo-v2.6-flash', 'mimo-v2.6-pro'])
  checkFn('未记录任何错误（无打扰）', host.errors.length === 0, JSON.stringify(host.errors))
  checkFn('状态不含敏感值', !JSON.stringify(status).includes('V1:PASS-TOKEN'))
}

console.log('\n== 无凭证 ⇒ 明确提示，但仍注册 provider ==')
{
  const host = makeHost({ cookieDb: join(root, 'absent', 'Cookies') })
  const err = applyPlugin(mod, host.ctx, host.config)
  checkFn('apply 不抛异常', err === undefined, err?.message)
  checkFn('provider 仍注册（模型选择器可见）', host.registrations.length === 1)
  await new Promise(r => setTimeout(r, 80))

  const status = await host.ctx.mimoStatus()
  check('报告未登录', status.signedIn, false)
  checkFn('提示中给出 login 指引', /login/.test(status.reason), status.reason)
  checkFn('暴露探测路径便于排查', status.cookieCandidates.length > 0)
}

console.log('\n== 插件自存凭证优先于桌面端 ==')
{
  const dbPath = join(root, 'desktop2', 'Cookies')
  makeCookieDb(dbPath, REAL_ROWS)
  const home = join(root, 'home2')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.mimo-connect-auth.json'), JSON.stringify({
    version: 1,
    credential: { passToken: 'OWN-PT', cUserId: 'OWN-C', userId: 'OWN-U' },
  }))

  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const host = makeHost({ cookieDb: dbPath })
    applyPlugin(mod, host.ctx, host.config)
    const status = await host.ctx.mimoStatus()
    check('使用插件自身凭证', status.account.source, 'plugin')
    check('用户 id 来自插件凭证', status.account.userId, 'OWN-U')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
}

console.log('\n== 回归：apply 不得写裸 ctx 属性 ==')
{
  const dbPath = join(root, 'desktop3', 'Cookies')
  makeCookieDb(dbPath, REAL_ROWS)
  const host = makeHost({ cookieDb: dbPath })
  const err = applyPlugin(mod, host.ctx, host.config)
  checkFn('apply 在 cordis 式 ctx 上不抛异常', err === undefined, err?.message)
  check('状态经 accessor 暴露', [...host.accessors.keys()], ['mimoStatus'])
  checkFn('未使用 ctx.status 服务写入', typeof host.ctx.status !== 'function')
}

console.log('\n== 销毁 ==')
{
  const dbPath = join(root, 'desktop4', 'Cookies')
  makeCookieDb(dbPath, REAL_ROWS)
  const host = makeHost({ cookieDb: dbPath })
  applyPlugin(mod, host.ctx, host.config)
  const dispose = host.effects[0]
  checkFn('销毁函数可调用', typeof dispose === 'function')
  try { dispose()(); pass++; console.log('  PASS 销毁不抛异常') }
  catch (e) { fail++; console.log(`  FAIL 销毁抛异常: ${e.message}`) }
}

rmSync(root, { recursive: true, force: true })

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
