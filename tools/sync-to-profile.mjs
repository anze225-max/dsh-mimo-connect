// 把工作区的插件源码同步到 DSH profile，并校验完整性。
//
// 同步两份产物：
//   - src/ + bin/ 是 node 半侧，直接复制即可；
//   - lib/client.js 是浏览器半侧，宿主从 exports["./client"] 读取，
//     缺失会让激活阶段直接报错，所以必须先构建再同步。
//
// 目标位置由环境变量控制，因为 DSH 的安装方式不止一种：
//
//   DSH_PROFILE_DIR  目标 profile 目录（默认 $DSH_HOME/profiles/$DSH_PROFILE，
//                    再退回 ~/.dsh/profiles/desktop）
//   DSH_PROFILE      目标 profile 名（默认 desktop，仅在未设 DSH_PROFILE_DIR
//                    时参与拼接）
//
// 源目录默认就是本脚本所在的仓库根目录，因此从任何地方 clone 下来都能直接跑；
// 需要覆盖时用 MIMO_PLUGIN_SRC。
import { readFileSync, copyFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Repository root: the parent of this script's own directory. */
const ws = process.env.MIMO_PLUGIN_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Resolve the profile directory to sync into.
 *
 * `DSH_PROFILE_DIR` wins when set (that is what the running DSH exports, so it
 * is the most reliable source). Otherwise fall back to `$DSH_HOME/profiles/<name>`
 * and finally `~/.dsh/profiles/desktop`.
 *
 * @returns {string} absolute destination profile directory.
 */
function resolveProfileDir() {
  const explicit = process.env.DSH_PROFILE_DIR
  if (typeof explicit === 'string' && explicit.length > 0) return explicit

  const profile = process.env.DSH_PROFILE ?? 'desktop'
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) return join(home, 'profiles', profile)

  const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (userProfile.length === 0) {
    console.error(
      '错误：无法确定 profile 目录。请设置 DSH_PROFILE_DIR（或 DSH_HOME、USERPROFILE）。',
    )
    process.exit(1)
  }
  return join(userProfile, '.dsh', 'profiles', profile)
}

const dst = join(resolveProfileDir(), 'node_modules', 'dsh-mimo-connect')
console.log(`源目录  : ${ws}`)
console.log(`目标目录: ${dst}`)

// 先构建浏览器 bundle，避免同步一份过期的客户端代码。
console.log('=== 构建浏览器 bundle ===')
execFileSync(process.execPath, [join(ws, 'tools', 'build-client.mjs')], { stdio: 'inherit' })

// 清掉旧结构，避免 auth.js 这类已删除文件残留
rmSync(dst, { recursive: true, force: true })
for (const d of ['src', 'bin', 'lib']) mkdirSync(join(dst, d), { recursive: true })

let copied = 0
for (const f of readdirSync(join(ws, 'src'))) {
  copyFileSync(join(ws, 'src', f), join(dst, 'src', f))
  console.log(`  src/${f}`)
  copied++
}
for (const f of readdirSync(join(ws, 'bin'))) {
  copyFileSync(join(ws, 'bin', f), join(dst, 'bin', f))
  console.log(`  bin/${f}`)
  copied++
}
for (const f of readdirSync(join(ws, 'lib'))) {
  copyFileSync(join(ws, 'lib', f), join(dst, 'lib', f))
  console.log(`  lib/${f}`)
  copied++
}
for (const f of ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml']) {
  copyFileSync(join(ws, f), join(dst, f))
  console.log(`  ${f}`)
  copied++
}
console.log(`\n已复制 ${copied} 个文件 -> ${dst}`)

console.log('\n=== 校验 ===')
const pkg = JSON.parse(readFileSync(join(dst, 'package.json'), 'utf-8'))
console.log('  main:', pkg.main, '| 存在:', existsSync(join(dst, pkg.main)))
const binPath = pkg.bin?.['dsh-mimo-connect'] ?? ''
console.log('  bin :', binPath, '| 存在:', existsSync(join(dst, binPath)))
const idx = readFileSync(join(dst, 'src', 'index.js'), 'utf-8')
console.log('  含 accessor 修复 :', idx.includes("ctx.accessor('mimoStatus'"))
console.log('  含额度路由       :', idx.includes('/api/mimo.quota'))
console.log('  含乱码           :', /锟斤拷|缁旑垳|閳/.test(idx))
console.log('  auth.js 已移除   :', !existsSync(join(dst, 'src', 'auth.js')))

// 浏览器半侧是激活阶段的硬依赖，单独校验。
const clientExport = pkg.exports?.['./client']?.default
const declared = pkg.dsh?.client !== undefined
console.log('  dsh.client 声明  :', declared)
console.log(
  '  exports[./client]:',
  clientExport,
  '| 存在:',
  existsSync(join(dst, clientExport ?? '')),
)
if (declared && !existsSync(join(dst, clientExport ?? ''))) {
  console.error('\n错误：声明了 dsh.client 但缺少 lib/client.js，DSH 激活会失败。')
  process.exitCode = 1
}
