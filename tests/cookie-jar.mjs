/**
 * Domain isolation tests.
 *
 * Regression guard for the measured failure: mixing `.account.xiaomi.com` and
 * `.xiaomi.com` cookies into one header made the gateway answer EXPIRED and
 * bounce every request to the passport login page. `headerFor()` must never
 * leak a cookie across domain boundaries.
 */
import { CookieJar, domainMatches, parseSetCookie } from '../src/cookie-jar.js'

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  PASS ${label}`) }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`) }
}

console.log('\n== domainMatches ==')
check('exact host', domainMatches('example.com', 'example.com'), true)
check('subdomain', domainMatches('example.com', 'api.example.com'), true)
check('deep subdomain', domainMatches('example.com', 'a.b.example.com'), true)
check('leading dot normalized', domainMatches('.example.com', 'api.example.com'), true)
check('case-insensitive', domainMatches('EXAMPLE.com', 'api.Example.COM'), true)
check('sibling domain rejected', domainMatches('xiaomi.com', 'xiaomimimo.com'), false)
check('partial label rejected', domainMatches('xiaomi.com', 'notxiaomi.com'), false)
check('parent not matched by child', domainMatches('api.example.com', 'example.com'), false)
check('empty rejected', domainMatches('', 'example.com'), false)

console.log('\n== parseSetCookie ==')
check('plain pair', parseSetCookie('a=1', 'h.example'), {
  domain: 'h.example', name: 'a', value: '1', hostOnly: true,
})
check('domain attribute wins', parseSetCookie('a=1; Domain=.example.com; Path=/', 'h.example'), {
  domain: 'example.com', name: 'a', value: '1', hostOnly: false,
})
check('strips quotes', parseSetCookie('a="quoted"', 'h.example').value, 'quoted')
check('empty quoted value', parseSetCookie('a=""', 'h.example').value, '')
check('value containing =', parseSetCookie('a=b=c', 'h.example').value, 'b=c')
check('garbage rejected', parseSetCookie('novalue', 'h.example'), undefined)
check('blank rejected', parseSetCookie('', 'h.example'), undefined)

console.log('\n== jar: THE regression (cross-domain isolation) ==')
const jar = new CookieJar()
jar.set('.account.xiaomi.com', 'passToken', 'PT-VALUE')
jar.set('.account.xiaomi.com', 'cUserId', 'ACCOUNT-CUID')
jar.set('.xiaomi.com', 'cUserId', 'PARENT-CUID')
jar.set('.xiaomi.com', 'uLocale', 'zh_CN')

// account.xiaomi.com matches BOTH .account.xiaomi.com and .xiaomi.com (RFC 6265
// domain matching). Each name must appear exactly once, and the more specific
// domain's value must win — this mirrors what the real cookie DB contains.
const accountHeader = jar.headerFor('https://account.xiaomi.com/pass/serviceLogin')
const accountPairs = accountHeader.split('; ')
check('account.xiaomi.com: no duplicate names',
  accountPairs.length, new Set(accountPairs.map(p => p.split('=')[0])).size)
check('account.xiaomi.com: most specific domain wins for cUserId',
  accountHeader.includes('cUserId=ACCOUNT-CUID'), true)
check('account.xiaomi.com: parent-only cookie still included',
  accountHeader.includes('uLocale=zh_CN'), true)
check('account.xiaomi.com: passToken present',
  accountHeader.includes('passToken=PT-VALUE'), true)

const mimoHeader = jar.headerFor('https://mimo-server-cn.xiaomimimo.com/api/user/xiaomi/me')
check('unrelated host gets NO cookies (the bug that broke everything)', mimoHeader, '')

const xiaomiHeader = jar.headerFor('https://www.xiaomi.com/x')
check('xiaomi.com does not inherit account.xiaomi.com cookies',
  xiaomiHeader.split('; ').sort(), ['cUserId=PARENT-CUID', 'uLocale=zh_CN'])

console.log('\n== jar: EXPIRED semantics ==')
const jar2 = new CookieJar()
jar2.set('a.example', 'tok', 'good')
check('present before', jar2.headerFor('https://a.example/'), 'tok=good')
jar2.set('a.example', 'tok', 'EXPIRED')
check('EXPIRED clears the cookie', jar2.headerFor('https://a.example/'), '')
jar2.set('a.example', 'tok', 'good2')
jar2.set('a.example', 'tok', '')
check('empty value clears the cookie', jar2.headerFor('https://a.example/'), '')

console.log('\n== jar: absorb from response ==')
const jar3 = new CookieJar()
jar3.absorb([
  'serviceToken=ST-123; Path=/; Domain=.xiaomimimo.com',
  'cUserId=EXPIRED; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  'deviceId=wb_abc; Path=/',
], 'mimo-server-cn.xiaomimimo.com')

check('domain cookie routed to its domain', jar3.get('xiaomimimo.com', 'serviceToken'), 'ST-123')
check('host-only cookie attributed to response host', jar3.get('mimo-server-cn.xiaomimimo.com', 'deviceId'), 'wb_abc')
check('EXPIRED dropped', jar3.get('mimo-server-cn.xiaomimimo.com', 'cUserId'), undefined)

const stHeader = jar3.headerFor('https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions')
check('mimo host receives domain + host cookies',
  stHeader.split('; ').sort(), ['deviceId=wb_abc', 'serviceToken=ST-123'])

check('account.xiaomi.com receives nothing from mimo jar',
  jar3.headerFor('https://account.xiaomi.com/pass/serviceLogin'), '')

console.log('\n== jar: seed / describe / toJSON ==')
const jar4 = new CookieJar()
jar4.seed({ '.account.xiaomi.com': { passToken: 'P', cUserId: 'C', userId: 'U' } })
check('seed works', jar4.headerFor('https://account.xiaomi.com/').split('; ').sort(),
  ['cUserId=C', 'passToken=P', 'userId=U'])
check('describe lists names not values', jar4.describe(), 'account.xiaomi.com: [passToken, cUserId, userId]')
check('toJSON round-trips', jar4.toJSON()['account.xiaomi.com'].passToken, 'P')

console.log('\n== jar: overwrite wins ==')
const jar5 = new CookieJar()
jar5.set('a.example', 'k', 'v1')
jar5.set('a.example', 'k', 'v2')
check('last write wins', jar5.headerFor('https://a.example/'), 'k=v2')

console.log('\n== jar: real-world duplicate cUserId (measured DB shape) ==')
// The actual MiMo cookie DB stores cUserId under BOTH domains with the same
// value. A duplicated name must never reach the wire.
const jar6 = new CookieJar()
jar6.seed({
  '.account.xiaomi.com': { cUserId: 'SAME', passToken: 'PT', userId: '3207174710' },
  '.xiaomi.com': { cUserId: 'SAME', uLocale: 'zh_CN' },
})
const real = jar6.headerFor('https://account.xiaomi.com/pass/serviceLogin')
const names = real.split('; ').map(p => p.split('=')[0])
check('no duplicated cookie names', names.length, new Set(names).size)
check('every expected cookie present',
  names.sort(), ['cUserId', 'passToken', 'uLocale', 'userId'])
check('mimo host still gets nothing',
  jar6.headerFor('https://mimo-server-cn.xiaomimimo.com/api/user/xiaomi/me'), '')

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exitCode = fail === 0 ? 0 : 1
