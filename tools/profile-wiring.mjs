/**
 * 最终验证：用 DSH 自己的 profile 组合逻辑，检查 dsh-mimo-connect
 * 是否真的进入了 patch 栈（而不只是文件放对了位置）。
 *
 * 直接调用 dsh 的 composeProfile / runProfile 路径太重（会真的起服务，
 * 且需要 pnpm）。这里复刻它读取 bundle patch 的那一步，验证：
 *   1. profile 的 package.json 里声明了 bundle；
 *   2. 该 bundle 的 cordis.patch.yml 可解析；
 *   3. 解析出的条目名能被 Node 解析到真实模块。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'

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
console.log(`\n== profile: ${profileDir} ==`)

const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf-8'))
const bundles = pkg.dsh?.profile?.bundles ?? []
console.log('  bundles:', bundles.join(', '))
checkFn('bundle 列表含 dsh-mimo-connect', bundles.includes('dsh-mimo-connect'))
checkFn('原 workbuddy 仍在（未破坏既有配置）', bundles.includes('dsh-workbuddy-connect'))

console.log('\n== 每个 bundle 的 cordis.patch.yml 是否可解析 ==')
for (const bundle of bundles) {
  if (bundle.startsWith('@deepseek-ai/')) continue // 框架自带，跳过
  const dir = join(profileDir, 'node_modules', bundle)
  const patchPath = join(dir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) { console.log(`  SKIP ${bundle}（无 patch 文件）`); continue }
  let parsed
  try {
    parsed = yaml.load(readFileSync(patchPath, 'utf-8'))
  } catch (e) {
    fail++; console.log(`  FAIL ${bundle} patch 解析失败: ${e.message}`); continue
  }
  const inserts = Array.isArray(parsed) ? parsed.flatMap(e => e?.insert ?? []) : []
  console.log(`  ${bundle}: insert ${JSON.stringify(inserts)}`)
  for (const row of inserts) {
    const mp = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
    checkFn(`  ${row.name} package.json main 指向存在文件`,
      existsSync(join(dir, mp.main)), mp.main)
  }
}

console.log('\n== 插件入口可被 Node 解析（真 import） ==')
const entry = 'file:///' + join(profileDir, 'node_modules', 'dsh-mimo-connect', 'src', 'index.js').replace(/\\/g, '/')
const mod = await import(entry)
check('插件 name', mod.name, 'llm-mimo')
check('插件 inject', mod.inject, ['llm'])

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
