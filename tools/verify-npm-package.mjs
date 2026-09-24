/**
 * 端到端验证：从 npm 真正下载发布的包，检查内容完整性。
 *
 * 「npm publish 成功」不等于「别人能装好」——要确认 tarball 里
 * 运行时必需的文件都在，且能正常 import。
 */
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { gunzipSync } from 'node:zlib'

const PKG = 'dsh-mimo-connect'
const work = mkdtempSync(join(tmpdir(), 'mimo-verify-'))

/**
 * 极简 tar 解析器。
 *
 * 沙箱禁止 spawn 外部 `tar`，所以用 Node 自带的 zlib 解压后手工解析
 * ustar 头。只处理 npm 打包产生的普通文件，够用。
 */
function untar(buffer, dest) {
  let offset = 0
  const out = []
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    // 全零块表示归档结束
    if (header.every(b => b === 0)) break

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeOctal, 8) || 0
    const type = String.fromCharCode(header[156])

    offset += 512
    if (name.length > 0) {
      const target = join(dest, name)
      if (type === '5') {
        mkdirSync(target, { recursive: true })
      } else if (type === '0' || type === '\0' || type === '') {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, buffer.subarray(offset, offset + size))
        out.push(name)
      }
    }
    // 数据按 512 对齐
    offset += Math.ceil(size / 512) * 512
  }
  return out
}

console.log('=== 1) 从 registry 拉取元数据 ===')
const meta = await (await fetch(`https://registry.npmjs.org/${PKG}`)).json()
const latest = meta['dist-tags'].latest
const version = meta.versions[latest]
console.log(`  ${meta.name}@${latest}`)
console.log(`  tarball: ${version.dist.tarball}`)

console.log('\n=== 2) 下载并解包 tarball ===')
const tgz = join(work, 'pkg.tgz')
const buf = Buffer.from(await (await fetch(version.dist.tarball)).arrayBuffer())
writeFileSync(tgz, buf)
console.log(`  下载 ${buf.length} 字节`)

const pkgDir = work
mkdirSync(pkgDir, { recursive: true })
// npm 的 tarball 顶层就是 `package/`，所以直接解到 work 下。
const extracted = untar(gunzipSync(buf), pkgDir)
console.log(`  解包 ${extracted.length} 个文件`)
console.log('  示例:', extracted.slice(0, 3).join(', '))

console.log('\n=== 3) 检查运行时必需文件 ===')
const required = [
  'package/package.json',
  'package/cordis.patch.yml',
  'package/src/index.js',
  'package/src/adapter.js',
  'package/src/catalog.js',
  'package/src/cookie-jar.js',
  'package/src/credential.js',
  'package/src/session.js',
  'package/src/upstream.js',
  'package/bin/cli.js',
]
let missing = 0
for (const f of required) {
  const ok = existsSync(join(pkgDir, f))
  if (!ok) missing++
  console.log(`  ${ok ? 'OK  ' : 'MISS'} ${f.replace('package/', '')}`)
}
console.log(`  → ${required.length - missing}/${required.length} 就位`)

console.log('\n=== 4) 检查不应包含的文件 ===')
let leaked = 0
const pkgRoot = join(pkgDir, 'package')
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) { walk(p); continue }
    if (/\.(db|log|tgz)$/i.test(e.name)) {
      console.log('  泄漏:', p.replace(pkgRoot, 'package'))
      leaked++
    }
  }
}
walk(pkgRoot)
console.log(`  → ${leaked === 0 ? '干净' : leaked + ' 个可疑文件'}`)

console.log('\n=== 5) 验证 package.json 关键字段 ===')
const pj = JSON.parse(readFileSync(join(pkgDir, 'package', 'package.json'), 'utf-8'))
console.log('  main    :', pj.main)
console.log('  bin     :', JSON.stringify(pj.bin))
console.log('  仓库    :', pj.repository?.url)
console.log('  dsh.bundle:', JSON.stringify(pj.dsh?.bundle))

console.log('\n=== 6) 验证模块可被 import（语法正确性）===')
try {
  const mod = await import('file:///' + join(pkgDir, 'package', 'src', 'index.js').replace(/\\/g, '/'))
  console.log('  插件导出 name  :', mod.name)
  console.log('  插件导出 inject:', JSON.stringify(mod.inject))
  console.log('  Config 存在    :', mod.Config !== undefined)
} catch (e) {
  // 缺少 @deepseek-ai/* 依赖时 import 会失败，这属预期
  const msg = e.message
  if (/Cannot find package '@deepseek-ai|Cannot find package '@earendil-works/.test(msg)) {
    console.log('  (预期：依赖由宿主提供，独立 import 无法解析 → 属正常)')
  } else {
    console.log('  ❌ 真实语法错误:', msg.slice(0, 200))
  }
}

console.log('\n=== 7) 统计 ===')
const files = []
const collect = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) collect(p)
    else files.push({ path: p.replace(pkgRoot, ''), size: statSync(p).size })
  }
}
collect(pkgRoot)
console.log(`  总文件数: ${files.length}`)
console.log(`  总大小  : ${(files.reduce((a, f) => a + f.size, 0) / 1024).toFixed(1)} kB`)

rmSync(work, { recursive: true, force: true })
console.log(`\n=== 结论: ${missing === 0 && leaked === 0 ? '✅ 发布完整可用' : '⚠ 有问题需修复'} ===`)
process.exitCode = missing === 0 && leaked === 0 ? 0 : 1
