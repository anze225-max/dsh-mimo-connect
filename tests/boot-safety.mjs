/**
 * 启动前自检：模拟 DSH 组装 profile patch 栈时会做的事，确认
 * dsh-mimo-connect 不会让插件树挂掉。
 *
 * 复刻 DSH 的顺序：读 bundle 列表 → 逐个解析 cordis.patch.yml →
 * 用真实 cordis Context 加载每个 entry。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label}\n       期望 ${e}\n       实际 ${a}`) }
}
const checkFn = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label} ${detail}`) }
}

const profileDir = join(process.env.DSH_HOME, 'profiles', 'desktop')
console.log(`\n== 组装 profile: ${profileDir} ==`)

const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf-8'))
const bundles = pkg.dsh.profile.bundles
console.log('  bundles:', bundles.join(', '))

// 收集所有非框架 bundle 的 insert 条目（DSH 的 composeEntries 做同一件事）
const rows = []
for (const bundle of bundles) {
  if (bundle.startsWith('@deepseek-ai/')) continue
  const dir = join(profileDir, 'node_modules', bundle)
  const patch = join(dir, 'cordis.patch.yml')
  if (!existsSync(patch)) continue
  const parsed = yaml.load(readFileSync(patch, 'utf-8'))
  for (const entry of Array.isArray(parsed) ? parsed : []) {
    for (const row of entry?.insert ?? []) {
      rows.push({ bundle, dir, ...row })
    }
  }
}
console.log('  待加载条目:', rows.map(r => `${r.id}(${r.name})`).join(', '))
checkFn('含 llm-mimo 条目', rows.some(r => r.id === 'llm-mimo'))

console.log('\n== 逐个加载条目（真实 cordis）==')
for (const row of rows) {
  const entryPath = join(row.dir, 'package.json')
  if (!existsSync(entryPath)) { console.log(`  SKIP ${row.name}: 无 package.json`); continue }
  const meta = JSON.parse(readFileSync(entryPath, 'utf-8'))
  const mainPath = join(row.dir, meta.main)
  checkFn(`${row.name}: main 文件存在`, existsSync(mainPath), meta.main)

  if (row.id !== 'llm-mimo') continue // 只实例化本插件，别的靠 DSH 自己

  const mod = await import('file:///' + mainPath.replace(/\\/g, '/'))
  check(`${row.name}: 导出 name`, mod.name, row.id === 'llm-mimo' ? 'llm-mimo' : undefined)
  checkFn(`${row.name}: 导出 apply`, typeof mod.apply === 'function')

  const ctx = new Context()
  ctx.provide('llm', { registerAdapter: () => () => {} })
  let thrown
  try { mod.apply(ctx, { authFile: 'D:\\nonexistent\\auth.json', pollSeconds: 0 }) }
  catch (e) { thrown = e }
  checkFn(`${row.name}: apply 不抛异常（否则 DSH 进恢复模式）`, thrown === undefined,
    thrown ? `threw: ${thrown.message}` : '')
  checkFn(`${row.name}: 未把 ctx.x 当服务写`, typeof ctx.status !== 'function')
  checkFn(`${row.name}: 状态经由 accessor 暴露`, typeof ctx.mimoStatus === 'function')
}

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
if (fail === 0) console.log('结论：插件可安全加载，不会触发恢复模式')
process.exitCode = fail === 0 ? 0 : 1
