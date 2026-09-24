// 回归有效性验证（子进程隔离版）。
//
// 关键点：必须让每个变体跑在**独立进程**里。之前在同一进程内替换源码再
// import，会命中 ESM 模块缓存，测到的仍是旧版本 —— 实验因此无效。
//
// 这里：把变体源码写到临时目录 → 用独立 node 进程跑测试 → 断言失败原因。
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync, openSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

const SRC = 'src'
const NEEDLE = "ctx.accessor('mimoStatus', { get: () => statusDocument })"
const MINI = 'tests/_variant-probe.mjs'

/**
 * 用一份给定的 index.js 内容，在独立进程里跑一个最小探针。
 * @returns {{status:number|null, output:string}}
 */
function probeWith(indexSource, label) {
  const dir = join('tests', `_variant-${label}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  // 复制插件源码，替换 index.js
  for (const f of ['credential.js', 'cookie-jar.js', 'adapter.js', 'upstream.js', 'catalog.js', 'session.js', 'quota.js']) {
    copyFileSync(join(SRC, f), join(dir, f))
  }
  writeFileSync(join(dir, 'index.js'), indexSource)

  // 探针：用 cordis 风格的 Proxy 调 apply，并调用 mimoStatus
  const probe = `
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const d = mkdtempSync(join(tmpdir(), 'probe-'))
const dbPath = join(d, 'Cookies')
const db = new DatabaseSync(dbPath)
db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)')
const ins = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?)')
ins.run('.account.xiaomi.com', 'passToken', 'V1:PT', null)
ins.run('.account.xiaomi.com', 'cUserId', 'C', null)
ins.run('.account.xiaomi.com', 'userId', 'U', null)
db.close()

const accessors = new Map()
const warnings = []
let proxyRef
const base = {
  llm: { registerAdapter: () => () => {} },
  emit() {}, effect() {},
  // cordis 语义：服务缺失时 scoped inject 保持挂起，绝不调用函数体。
  inject(deps, fn) {
    if (deps.some((d) => !(d in base))) return
    fn(proxyRef)
  },
  accessor(name, opts) { accessors.set(name, opts); return () => accessors.delete(name) },
  logger: { warn(...a) { warnings.push(a.map(String).join(' ')) }, error(...a) { warnings.push(a.map(String).join(' ')) } },
}
const proxy = new Proxy(base, {
  get(t, p, r) { if (p in t) return Reflect.get(t, p, r); if (accessors.has(p)) return accessors.get(p).get(); return undefined },
  set(_t, p) { throw new Error('cannot set property "' + String(p) + '" without provide') },
})
proxyRef = proxy

const mod = await import('./index.js')
let thrown
try { mod.apply(proxy, { cookieDb: dbPath, pollSeconds: 0 }) } catch (e) { thrown = e }
if (thrown) { console.log('APPLY_THREW: ' + thrown.message); process.exit(3) }
await new Promise(r => setTimeout(r, 80))
// 把 apply 期间记录到的告警暴露出来，便于区分「被拒绝」与「静默缺失」。
if (warnings.length > 0) console.log('WARNED: ' + warnings.join(' | '))
if (typeof proxy.mimoStatus !== 'function') { console.log('NO_ACCESSOR'); process.exit(4) }
const st = await proxy.mimoStatus()
console.log('OK signedIn=' + st.signedIn)
rmSync(d, { recursive: true, force: true })
`
  const probePath = join(dir, 'probe.mjs')
  writeFileSync(probePath, probe)

  const outFile = join('tests', `_variant-${label}.txt`)
  const fd = openSync(outFile, 'w')
  const r = spawnSync(process.execPath, [probePath], { stdio: ['ignore', fd, fd], cwd: process.cwd() })
  closeSync(fd)
  const output = readFileSync(outFile, 'utf-8')
  rmSync(dir, { recursive: true, force: true })
  rmSync(outFile, { recursive: true, force: true })
  return { status: r.status, output }
}

const original = readFileSync(join(SRC, 'index.js'), 'utf-8')
if (!original.includes(NEEDLE)) {
  console.error('FAIL 源码中找不到 accessor 行')
  process.exit(2)
}

console.log('=== 变体 1：旧写法 ctx.mimoStatus = fn（应当无法提供状态）===')
const brokenSrc = original.replace(NEEDLE, 'ctx.mimoStatus = statusDocument')
const broken = probeWith(brokenSrc, 'broken')
console.log('  exit:', broken.status)
console.log('  输出:', broken.output.trim().split('\n')[0] ?? '(空)')
// 旧写法下 ctx 写入被 cordis 拒绝。源码里的 try/catch 会兜住这次拒绝，
// 所以进程不再崩溃（对比 0.1.0 的树级失败），但状态接口拿不到 —— 两种
// 结果都说明该写法不可用，任一成立即算被抓住。
const rejectedByCordis = /cannot set property/.test(broken.output)
const noAccessor = /NO_ACCESSOR/.test(broken.output)
const caught = broken.status !== 0 && (rejectedByCordis || noAccessor)
console.log('  被 cordis 拒绝:', rejectedByCordis, '| 无 accessor:', noAccessor)
console.log('  判定为被抓住:', caught)

console.log('\n=== 变体 2：修复版 ctx.accessor(...)（应当通过）===')
const fixed = probeWith(original, 'fixed')
console.log('  exit:', fixed.status)
console.log('  输出:', fixed.output.trim().split('\n')[0] ?? '(空)')
const ok = fixed.status === 0 && /OK signedIn=true/.test(fixed.output)
console.log('  正常工作:', ok)

console.log('\n结论:', caught && ok
  ? '回归测试有效：旧写法必然崩溃，修复版正常工作'
  : '警告：回归验证不成立')
process.exitCode = caught && ok ? 0 : 1
