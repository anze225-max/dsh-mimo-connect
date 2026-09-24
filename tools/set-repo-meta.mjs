/**
 * 设置仓库的 description 与 topics。
 *
 * 这两项是 GitHub 搜索与「相关仓库」推荐的直接输入，缺了就等于隐形。
 * 目标对标 workbuddy-connect 的做法。
 */
const REPO = 'anze225-max/dsh-mimo-connect'
const TOKEN = process.argv[2]

if (!TOKEN) {
  console.error('用法: node tools/set-repo-meta.mjs <github-token>')
  process.exit(1)
}

const DESCRIPTION = '复用小米 MiMo 登录态，把 MiMo 模型接入 DeepSeek Harness。桌面端已登录即零配置，也可独立登录；无常驻进程、无开机自启。Bring Xiaomi MiMo models into DeepSeek Harness with zero configuration.'

const TOPICS = [
  'dsh-plugin',
  'deepseek-harness',
  'deepseek',
  'xiaomi',
  'mimo',
  'mimo-desktop',
  'model-provider',
  'zero-config',
]

const res = await fetch(`https://api.github.com/repos/${REPO}`, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-mimo-connect',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    description: DESCRIPTION,
    homepage: 'https://github.com/anze225-max/dsh-mimo-connect#readme',
    has_issues: true,
    has_wiki: false,
  }),
})

console.log('设置 description/homepage: HTTP', res.status)
if (!res.ok) console.log('  ', (await res.text()).slice(0, 200))

const t = await fetch(`https://api.github.com/repos/${REPO}/topics`, {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-mimo-connect',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ names: TOPICS }),
})

console.log('设置 topics: HTTP', t.status)
if (!t.ok) console.log('  ', (await t.text()).slice(0, 200))

// 复核
const check = await fetch(`https://api.github.com/repos/${REPO}`, {
  headers: { 'User-Agent': 'dsh-mimo-connect' },
})
const j = await check.json()
console.log('\n=== 复核 ===')
console.log('  description:', (j.description ?? '(未设置)').slice(0, 100))
console.log('  topics     :', (j.topics ?? []).join(', ') || '(未设置)')
console.log('  homepage   :', j.homepage || '(未设置)')
