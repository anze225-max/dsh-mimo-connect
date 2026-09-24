/**
 * 端到端验证：用修好的 CookieJar 打通真实链路。
 *
 * 这验证第 1-3 步的核心逻辑（jar + STS + 推理），用的是真实端点。
 * 若通过，说明架构正确，剩下的是包装成插件。
 */
import { CookieJar } from '../src/cookie-jar.js'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'https://mimo-server-cn.xiaomimimo.com'
const UA = 'MiClaw/1.0'

// --- 从桌面端读取 cookie（模拟 credential.js） ---
const src = join(process.env.APPDATA, 'Xiaomi MiMo', 'Partitions', 'xiaomi-account', 'Network', 'Cookies')
const tmp = join(process.env.TEMP ?? '.', `mimo-ck-${process.pid}.db`)
for (const s of ['', '-journal']) if (existsSync(src + s)) copyFileSync(src + s, tmp + s)

const db = new DatabaseSync(tmp, { readOnly: true })
const rows = db.prepare('SELECT host_key, name, value FROM cookies').all()
db.close()
for (const s of ['', '-journal']) if (existsSync(tmp + s)) unlinkSync(tmp + s)

const jar = new CookieJar()
for (const r of rows) {
  if (typeof r.value === 'string' && r.value.length > 0) jar.set(r.host_key, r.name, r.value)
}
console.log('=== 从桌面端读取的 cookie ===')
console.log('  ' + jar.describe())

// --- 请求辅助：严格按域发送 ---
let requestCount = 0
async function request(url, init = {}) {
  requestCount++
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/json,*/*;q=0.8',
    ...(init.headers ?? {}),
  }
  const cookie = jar.headerFor(url)
  if (cookie.length > 0) headers.Cookie = cookie

  const res = await fetch(url, { ...init, headers, redirect: 'manual' })
  jar.absorb(res.headers, new URL(url).hostname)
  return res
}

// --- STS 换取 serviceToken ---
console.log('\n=== STS 换取 serviceToken ===')
let r = await request(`${BASE}/api/user/xiaomi/me`)
console.log(`  1) ${r.status}`)
r = await request(r.headers.get('location'))
console.log(`  2) ${r.status}  (deviceId: ${jar.get('account.xiaomi.com', 'deviceId') !== undefined ? '有' : '无'})`)
r = await request(r.headers.get('location'))
console.log(`  3) ${r.status}`)
if (r.headers.get('location')) {
  r = await request(r.headers.get('location'))
  console.log(`  4) ${r.status}`)
}

const serviceToken = jar.get('mimo-server-cn.xiaomimimo.com', 'serviceToken')
console.log(`\n  serviceToken: ${serviceToken !== undefined ? `有 (len=${serviceToken.length})` : '无'}`)

// --- 推理 ---
console.log('\n=== 推理验证 ===')
let ok = 0
const chat = async (label, body) => {
  const res = await request(`${BASE}/api/route/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const good = res.status === 200
  if (good) ok++
  console.log(`  ${good ? 'PASS' : 'FAIL'} ${label}: HTTP ${res.status}`)
  if (good && !body.stream) {
    const j = JSON.parse(text)
    console.log(`        回复: ${JSON.stringify(j.choices?.[0]?.message?.content)}`)
  }
  return text
}

await chat('非流式', {
  model: 'mimo-v2.6-flash',
  messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
  stream: false,
})

const streamText = await chat('流式', {
  model: 'mimo-v2.6-flash',
  messages: [{ role: 'user', content: 'Say hi.' }],
  stream: true,
})
console.log(`        SSE 帧数: ${(streamText.match(/data:/g) ?? []).length}`)

await chat('工具调用', {
  model: 'mimo-v2.6-flash',
  messages: [{ role: 'user', content: 'Weather in Beijing? Use the tool.' }],
  stream: false,
  tools: [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  }],
})

await chat('pro 模型', {
  model: 'mimo-v2.6-pro',
  messages: [{ role: 'user', content: 'Reply: OK' }],
  stream: false,
})

console.log(`\n=== 结果: ${ok}/4 通过，共 ${requestCount} 次请求 ===`)
process.exitCode = ok === 4 ? 0 : 1
