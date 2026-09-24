// 恢复 dsh-mimo-connect 在 DSH desktop profile 中的注册。
// 只增补条目，不动既有的 workbuddy / dshmarket。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const profile = join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop')

// --- 1) profile package.json：依赖 + bundle ---
const pkgPath = join(profile, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
pkg.dependencies ??= {}
pkg.dependencies['dsh-mimo-connect'] = 'file:./node_modules/dsh-mimo-connect'
// 保持既有顺序，把新 bundle 插在 workbuddy 之后
const bundles = pkg.dsh?.profile?.bundles
if (!Array.isArray(bundles)) throw new Error('profile package.json 缺少 dsh.profile.bundles')
if (!bundles.includes('dsh-mimo-connect')) {
  const at = bundles.indexOf('dsh-workbuddy-connect')
  bundles.splice(at >= 0 ? at + 1 : bundles.length, 0, 'dsh-mimo-connect')
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log('package.json bundles:', bundles.join(', '))

// --- 2) .package-map.json：pnpm 解析映射 ---
const mapPath = join(profile, 'node_modules', '.package-map.json')
const map = JSON.parse(readFileSync(mapPath, 'utf-8'))
map.packages['dsh-mimo-connect'] = {
  url: './dsh-mimo-connect',
  dependencies: { 'dsh-mimo-connect': 'dsh-mimo-connect' },
}
map.packages['.'].dependencies['dsh-mimo-connect'] = 'dsh-mimo-connect'
writeFileSync(mapPath, JSON.stringify(map))
console.log('.package-map.json 根依赖:', Object.keys(map.packages['.'].dependencies).join(', '))
