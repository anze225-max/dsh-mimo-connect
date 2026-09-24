/**
 * 检查仓库的可发现性现状。
 *
 * 影响「被找到」的因素：
 *   1. Description / topics（GitHub 搜索和推荐的主要依据）
 *   2. README 是否会被社区聚合站收录
 *   3. 是否有 License（影响他人敢不敢用）
 *   4. npm 包是否可被 `dsh plugin add` 直接安装
 */
const REPO = 'anze225-max/dsh-mimo-connect'
const H = { 'User-Agent': 'probe' }

const r = await fetch(`https://api.github.com/repos/${REPO}`, { headers: H })
const j = await r.json()

console.log('=== 仓库可见性要素 ===')
console.log('  description :', j.description ?? '(未设置) ← GitHub 搜索权重最高')
console.log('  topics      :', (j.topics ?? []).length === 0 ? '(未设置) ← 决定能否被分类检索' : j.topics.join(', '))
console.log('  homepage    :', j.homepage || '(未设置)')
console.log('  license     :', j.license?.spdx_id ?? '(无)')
console.log('  stars/forks :', j.stargazers_count, '/', j.forks_count)
console.log('  has_issues  :', j.has_issues)
console.log('  has_wiki    :', j.has_wiki)

console.log('\n=== npm 可安装性 ===')
for (const name of ['dsh-mimo-connect']) {
  const nr = await fetch(`https://registry.npmjs.org/${name}`, { headers: H })
  console.log(`  npm 上的 ${name}: ${nr.status === 404 ? '未发布（无法用 dsh plugin add 直接装）' : 'HTTP ' + nr.status}`)
}

console.log('\n=== 参考项目的情况（对照）===')
const wr = await fetch('https://api.github.com/repos/corrinehu/dsh-workbuddy-connect', { headers: H })
const w = await wr.json()
console.log('  workbuddy-connect stars:', w.stargazers_count)
console.log('  topics:', (w.topics ?? []).join(', ') || '(无)')
console.log('  description:', (w.description ?? '').slice(0, 80))

console.log('\n=== DSH 插件市场的收录方式 ===')
const mkt = await fetch('https://api.github.com/search/repositories?q=dsh-plugin+in:name,description,topics&sort=stars', { headers: H })
const mj = await mkt.json()
console.log('  GitHub 上带 dsh-plugin 关键词的仓库数:', mj.total_count)
for (const item of (mj.items ?? []).slice(0, 6)) {
  console.log(`    ${item.full_name}  ★${item.stargazers_count}  topics=[${(item.topics ?? []).join(',')}]`)
}
