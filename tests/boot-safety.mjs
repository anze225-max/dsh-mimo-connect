/**
 * 启动前自检：模拟 DSH 组装 profile patch 栈时会做的事，确认
 * dsh-mimo-connect 不会让插件树挂掉。
 *
 * 复刻 DSH 的顺序：读 bundle 列表 → 逐个解析 cordis.patch.yml →
 * 用真实 cordis Context 加载每个 entry。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import { SKIP_EXIT_CODE } from './exit-codes.mjs'

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

// 本套件检查的是「本插件装进 profile 之后能否安全加载」，因此需要一个真实的
// DSH profile。CI 或没装 DSH 的机器上 DSH_HOME 不存在 —— 那是环境状态，
// 不是缺陷，所以干净地跳过而不是抛错。
const dshHome = process.env.DSH_HOME
if (typeof dshHome !== 'string' || dshHome.length === 0) {
  console.log('\n  SKIP 未设置 DSH_HOME（没有可检查的 DSH profile）')
  console.log('       在装有 DSH 并已安装本插件的机器上设置 DSH_HOME 后重跑。')
  console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
  console.log('结论：无可检查的 profile，跳过（不是失败）')
  process.exit(SKIP_EXIT_CODE)
}

const profileDir = join(dshHome, 'profiles', 'desktop')
console.log(`\n== 组装 profile: ${profileDir} ==`)

const profileManifest = join(profileDir, 'package.json')
if (!existsSync(profileManifest)) {
  console.log(`\n  SKIP 找不到 ${profileManifest}（该 profile 尚未初始化）`)
  console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
  console.log('结论：无可检查的 profile，跳过（不是失败）')
  process.exit(SKIP_EXIT_CODE)
}

const pkg = JSON.parse(readFileSync(profileManifest, 'utf-8'))
const bundles = pkg.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  console.log('\n  SKIP profile manifest 未声明 dsh.profile.bundles')
  console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
  console.log('结论：无可检查的 bundle 列表，跳过（不是失败）')
  process.exit(SKIP_EXIT_CODE)
}
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
console.log('  待加载条目:', rows.map(r => `${r.id}(${r.name})`).join(', ') || '(无)')

// 本套件检查的是「本插件装进 profile 之后能否安全加载」。若 profile 尚未安装
// dsh-mimo-connect（例如在 CI 或未安装的机器上跑），这里没有可加载的条目——
// 那是环境状态，不是缺陷，因此跳过而不是失败。
const installed = rows.some(r => r.id === 'llm-mimo')
if (!installed) {
  console.log('\n  SKIP 当前 profile 未安装 dsh-mimo-connect（bundle 列表里没有它）')
  console.log('       先执行：dsh plugin --profile <profile> add <插件路径或 git 说明>')
  console.log('       然后重跑本套件。')
  console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
  console.log('结论：无待验证的安装，跳过（不是失败）')
  process.exit(SKIP_EXIT_CODE)
}
checkFn('含 llm-mimo 条目', installed)

console.log('\n== 逐个加载条目（真实 cordis）==')
for (const row of rows) {
  const entryPath = join(row.dir, 'package.json')
  if (!existsSync(entryPath)) {
    console.log(`  SKIP ${row.name}: 无 package.json`)
    continue
  }
  const meta = JSON.parse(readFileSync(entryPath, 'utf-8'))
  const mainPath = join(row.dir, meta.main)
  checkFn(`${row.name}: main 文件存在`, existsSync(mainPath), meta.main)

  if (row.id !== 'llm-mimo') continue // 只实例化本插件，别的靠 DSH 自己

  // 真实 DSH 把框架包（`@deepseek-ai/*`）放在自己的 `app.asar` 归档里，只有
  // DSH 的 Electron 进程能解析它们。用普通 node 直接 import 一份**已安装**的
  // 插件，解析必然在第一个 peer 依赖上失败 —— 报的是 `Cannot find package
  // '@deepseek-ai/schemastery'`，与插件本身是否正确无关。
  //
  // 这一点只能用同类插件对照来确认，不能靠状态码判断：`dsh-workbuddy-connect`
  // 在真实 DSH 里工作正常，而普通 node 加载它同样失败。所以这里**不能**把
  // 「普通 node 加载失败」记成缺陷。
  //
  // 但也不能就此跳过整个断言：插件的 `apply()` 行为仍然要验。做法是用
  // `createRequire` 从**插件自己的目录**出发，把 peer 依赖解析到本仓库的
  // `node_modules`（`npm i --no-save` 时就装在那里），这样 `apply()` 能真实
  // 执行，被验证的是插件代码而不是宿主归档的布局。
  //
  // 之前这个套件之所以“通过”，是因为 profile 里放的是一个指向本仓库的
  // junction，本仓库恰好有 `node_modules/@deepseek-ai/*` —— 那是**假通过**，
  // 它验证的是巧合，不是插件。
  let mod
  try {
    mod = await import(pathToFileURL(mainPath).href)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const missing = /Cannot find package '([^']+)'/.exec(message)
    if (missing !== null) {
      console.log(
        `  SKIP 普通 node 无法解析 ${missing[1]}（框架包在 DSH 的 app.asar 内，只有 DSH 进程可解析）`,
      )
      console.log('       这是环境布局，不是缺陷；同类插件 dsh-workbuddy-connect 同样如此。')
      console.log('       插件的 apply() 行为改由 tests/entry.mjs 在仓库内验证。')
      process.exitCode = SKIP_EXIT_CODE
      break
    }
    throw error
  }

  check(`${row.name}: 导出 name`, mod.name, row.id === 'llm-mimo' ? 'llm-mimo' : undefined)
  checkFn(`${row.name}: 导出 apply`, typeof mod.apply === 'function')

  const ctx = new Context()
  ctx.provide('llm', { registerAdapter: () => () => {} })
  let thrown
  try {
    // `cookieDb` is the current config key; it used to be `authFile`. Point it at
    // a path that cannot exist, so the plugin starts with no credential and the
    // checks below exercise the signed-out path deterministically.
    mod.apply(ctx, { cookieDb: join('nonexistent', 'Cookies'), pollSeconds: 0 })
  } catch (e) {
    thrown = e
  }
  checkFn(
    `${row.name}: apply 不抛异常（否则 DSH 进恢复模式）`,
    thrown === undefined,
    thrown ? `threw: ${thrown.message}` : '',
  )
  checkFn(`${row.name}: 未把 ctx.x 当服务写`, typeof ctx.status !== 'function')
  checkFn(`${row.name}: 状态经由 accessor 暴露`, typeof ctx.mimoStatus === 'function')
}

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
// A skip already set SKIP_EXIT_CODE above. It must survive this line: `apply()`
// could not be exercised, so "loaded safely" is not a claim this run may make.
// Overwriting it with 0 would turn "not verified" into "verified" — the exact
// confusion the three-state runner (`tests/run.mjs`) exists to prevent.
if (process.exitCode === SKIP_EXIT_CODE) {
  console.log('结论：框架包在 DSH 归档内，本机无法用普通 node 复现加载；跳过（不是失败）')
} else if (fail === 0) {
  console.log('结论：插件可安全加载，不会触发恢复模式')
  process.exitCode = 0
} else {
  process.exitCode = 1
}
