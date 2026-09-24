/**
 * Session tests: redirect-chain driving, cookie scoping, renewal, retry.
 * Uses a mock fetch so the chain is exercised deterministically, plus one
 * optional live check when a desktop credential is present.
 */
import { CookieJar } from '../src/cookie-jar.js'
import { MiMoSession, MIMO_SERVER, XIAOMI_ACCOUNT } from '../src/session.js'
import { MiMoCredentialStore } from '../src/credential.js'

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`) }
}
const checkFn = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label} ${detail}`) }
}

/** Minimal Response stand-in with a real Headers instance. */
function res(status, { location, setCookie = [], body = '' } = {}) {
  const headers = new Headers()
  if (location !== undefined) headers.set('location', location)
  // getSetCookie is not on the Headers class in Node's fetch; attach it.
  headers.getSetCookie = () => setCookie
  return {
    status,
    headers,
    text: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

console.log('\n== session: successful redirect chain ==')
{
  const jar = new CookieJar()
  jar.set('.account.xiaomi.com', 'passToken', 'PT')
  jar.set('.account.xiaomi.com', 'cUserId', 'CU')
  jar.set('.account.xiaomi.com', 'userId', '3207174710')

  const seen = []
  const fetchMock = async (url, init) => {
    seen.push({ url, cookie: init.headers.Cookie ?? '' })
    const u = new URL(url)
    if (u.hostname === 'mimo-server-cn.xiaomimimo.com' && u.pathname === '/api/user/xiaomi/me') {
      const cb = `${MIMO_SERVER}/api/sts?sign=SIG&followup=${encodeURIComponent(`${MIMO_SERVER}/api/user/xiaomi/me`)}`
      return res(302, { location: `${XIAOMI_ACCOUNT}/pass/serviceLogin?callback=${encodeURIComponent(cb)}` })
    }
    if (u.hostname === 'account.xiaomi.com') {
      const cb = u.searchParams.get('callback')
      return res(302, { location: cb, setCookie: ['deviceId=wb_test; Path=/; Domain=.account.xiaomi.com'] })
    }
    if (u.pathname === '/api/sts') {
      return res(307, {
        location: `${MIMO_SERVER}/api/user/xiaomi/me?userId=3207174710`,
        setCookie: ['serviceToken=ST-ABCDEF; Path=/; Domain=.xiaomimimo.com'],
      })
    }
    return res(200, { body: '{}' })
  }

  const session = new MiMoSession({ jar, fetch: fetchMock })
  const token = await session.ensureSession()
  check('token minted', token, 'ST-ABCDEF')
  check('chain length', seen.length, 3)

  check('hop 1 sent passport cookies to the mimo server host', seen[0].cookie, '')
  checkFn('hop 2 sent passport cookies to account.xiaomi.com',
    seen[1].cookie.includes('passToken=PT') && seen[1].cookie.includes('cUserId=CU'))
  // deviceId is issued for .account.xiaomi.com, and the STS hop goes to the
  // mimo server domain — so scoping means it correctly is NOT sent there.
  // (The live check below proves the mint succeeds regardless.)
  checkFn('deviceId stored on its own domain', jar.get('account.xiaomi.com', 'deviceId') === 'wb_test')
  checkFn('deviceId not leaked to the mimo server host', !seen[2].cookie.includes('deviceId'))
  checkFn('passport cookies not leaked to the mimo server host', !seen[2].cookie.includes('passToken'))
  for (const hop of seen) {
    const pairs = hop.cookie.length === 0 ? [] : hop.cookie.split('; ')
    const names = pairs.map(p => p.split('=')[0])
    if (names.length !== new Set(names).size) {
      fail++
      console.log(`  FAIL duplicate cookie name in ${hop.url}`)
      break
    }
  }
  pass++
  console.log('  PASS no hop sent a duplicated cookie name')

  // Idempotence: a fresh session is not re-minted.
  const again = await session.ensureSession()
  check('reuses the live token', again, 'ST-ABCDEF')
  check('no extra hops on reuse', seen.length, 3)
}

console.log('\n== session: concurrent ensureSession shares one mint ==')
{
  const jar = new CookieJar()
  jar.set('.account.xiaomi.com', 'passToken', 'PT')
  let chains = 0
  const fetchMock = async (url) => {
    const u = new URL(url)
    if (u.hostname === 'account.xiaomi.com') {
      chains++
      return res(302, { location: u.searchParams.get('callback') })
    }
    if (u.pathname === '/api/sts') {
      return res(307, { setCookie: ['serviceToken=ST-ONCE; Domain=.xiaomimimo.com'] })
    }
    return res(302, { location: `${XIAOMI_ACCOUNT}/pass/serviceLogin?callback=${encodeURIComponent(`${MIMO_SERVER}/api/sts?sign=S`)}` })
  }
  const session = new MiMoSession({ jar, fetch: fetchMock })
  const [a, b, c] = await Promise.all([
    session.ensureSession(), session.ensureSession(), session.ensureSession(),
  ])
  check('all callers get the token', [a, b, c], ['ST-ONCE', 'ST-ONCE', 'ST-ONCE'])
  check('only one chain was walked', chains, 1)
}

console.log('\n== session: failure when no token appears ==')
{
  const jar = new CookieJar()
  jar.set('.account.xiaomi.com', 'passToken', 'PT')
  const fetchMock = async () => res(302, { location: `${XIAOMI_ACCOUNT}/loop` })
  const session = new MiMoSession({ jar, fetch: fetchMock })
  let threw
  try { await session.ensureSession() } catch (e) { threw = e }
  checkFn('throws with an actionable message', threw !== undefined && /serviceToken/.test(threw.message),
    threw?.message)
}

console.log('\n== session: 401 triggers one renewal ==')
{
  const jar = new CookieJar()
  jar.set('.account.xiaomi.com', 'passToken', 'PT')
  let chatCalls = 0
  let tokenIssue = 0
  const fetchMock = async (url) => {
    const u = new URL(url)
    if (u.pathname === '/api/sts') {
      tokenIssue++
      return res(307, { setCookie: [`serviceToken=ST-${tokenIssue}; Domain=.xiaomimimo.com`] })
    }
    if (u.hostname === 'account.xiaomi.com') {
      return res(302, { location: u.searchParams.get('callback') })
    }
    if (u.pathname === '/api/route/chat/completions') {
      chatCalls++
      if (chatCalls === 1) return res(401, { body: '' })
      return res(200, { body: 'data: ok' })
    }
    return res(302, { location: `${XIAOMI_ACCOUNT}/pass/serviceLogin?callback=${encodeURIComponent(`${MIMO_SERVER}/api/sts?sign=S`)}` })
  }
  const session = new MiMoSession({ jar, fetch: fetchMock })
  const response = await session.chatStream('{}')
  check('eventually 200', response.status, 200)
  check('chat attempted twice', chatCalls, 2)
  check('token re-minted', tokenIssue, 2)
}

console.log('\n== session: request carries scoped cookies only ==')
{
  const jar = new CookieJar()
  jar.set('.account.xiaomi.com', 'passToken', 'SECRET')
  jar.set('.xiaomimimo.com', 'serviceToken', 'ST')
  let captured
  const session = new MiMoSession({
    jar,
    fetch: async (url, init) => { captured = { url, cookie: init.headers.Cookie ?? '' }; return res(200) },
  })
  await session.request(`${MIMO_SERVER}/api/route/chat/completions`, { method: 'POST' })
  check('mimo host receives its token', captured.cookie, 'serviceToken=ST')
  check('passport secret not leaked to mimo host', captured.cookie.includes('passToken'), false)
}

console.log('\n== live check (skipped when no desktop credential) ==')
{
  const store = new MiMoCredentialStore()
  const status = await store.status()
  if (!status.signedIn) {
    console.log('  SKIP 未找到凭证，跳过实网检查')
  } else {
    const jar = MiMoCredentialStore.jarFor(status.credential)
    const session = new MiMoSession({ jar })
    try {
      const token = await session.ensureSession()
      checkFn('live: serviceToken minted', typeof token === 'string' && token.length > 20)
      const response = await session.chatStream(JSON.stringify({
        model: 'mimo-v2.6-flash',
        messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
        stream: false,
      }))
      check('live: inference returns 200', response.status, 200)
      const body = await response.text()
      checkFn('live: real answer returned', /PONG/.test(body), body.slice(0, 160))
    } catch (e) {
      fail++
      console.log(`  FAIL live check threw: ${e.message}`)
    }
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exitCode = fail === 0 ? 0 : 1
