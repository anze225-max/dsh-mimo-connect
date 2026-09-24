// 把工作区的插件源码同步到 DSH profile，并校验完整性。
import { readFileSync, copyFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ws = 'D:\\DSH_WorkSpace\\dsh-mimo-connect'
const dst = join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-mimo-connect')

// 清掉旧结构，避免 auth.js 这类已删除文件残留
rmSync(dst, { recursive: true, force: true })
mkdirSync(join(dst, 'src'), { recursive: true })
mkdirSync(join(dst, 'bin'), { recursive: true })

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
console.log('  含乱码           :', /锟斤拷|缁旑垳|閳/.test(idx))
console.log('  auth.js 已移除   :', !existsSync(join(dst, 'src', 'auth.js')))
