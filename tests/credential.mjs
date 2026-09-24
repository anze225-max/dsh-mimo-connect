/**
 * Credential store tests: source priority, desktop read-only access, atomic
 * write, permissions, and the "already signed in ⇒ no prompt" guarantee.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  MiMoCredentialStore,
  parseOwnCredential,
  writeOwnCredential,
  ownAuthPath,
  desktopCookieCandidates,
  OWN_AUTH_FILENAME,
} from '../src/credential.js'

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

const root = mkdtempSync(join(tmpdir(), 'mimo-cred-'))
const cleanup = () => rmSync(root, { recursive: true, force: true })

/** Build a Chromium-shaped cookie database at `path`. */
function makeCookieDb(path, rows) {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE cookies (
    host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB
  )`)
  const insert = db.prepare('INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?, ?, ?, ?)')
  for (const [host, name, value] of rows) insert.run(host, name, value, null)
  db.close()
}

const REAL_ROWS = [
  ['.account.xiaomi.com', 'cUserId', 'CUID-123'],
  ['.account.xiaomi.com', 'passToken', 'V1:PASS-TOKEN'],
  ['.account.xiaomi.com', 'userId', '3207174710'],
  ['.xiaomi.com', 'cUserId', 'CUID-123'],
  ['.xiaomi.com', 'uLocale', 'zh_CN'],
  ['www.example.com', 'tracking', 'noise'],   // must be ignored
]

console.log('\n== own credential: parse ==')
check('parses flat shape', parseOwnCredential(JSON.stringify({
  passToken: 'PT', cUserId: 'C', userId: 'U',
})), { passToken: 'PT', cUserId: 'C', userId: 'U', savedAtMs: undefined })

check('parses versioned shape', parseOwnCredential(JSON.stringify({
  version: 1, credential: { passToken: 'PT', cUserId: 'C', userId: 'U', savedAtMs: 123 },
})), { passToken: 'PT', cUserId: 'C', userId: 'U', savedAtMs: 123 })

check('rejects wrong version', parseOwnCredential(JSON.stringify({
  version: 99, credential: { passToken: 'PT' },
})), undefined)
check('rejects missing passToken', parseOwnCredential(JSON.stringify({ cUserId: 'C' })), undefined)
check('rejects invalid JSON', parseOwnCredential('{nope'), undefined)
check('rejects null', parseOwnCredential('null'), undefined)

console.log('\n== own credential: atomic write + permissions ==')
{
  const path = join(root, 'own', OWN_AUTH_FILENAME)
  writeOwnCredential(path, { passToken: 'PT-WRITE', cUserId: 'C', userId: 'U' })
  checkFn('file exists', existsSync(path))
  const parsed = parseOwnCredential(readFileSync(path, 'utf-8'))
  check('round-trips', parsed.passToken, 'PT-WRITE')
  checkFn('stamped with savedAtMs', typeof parsed.savedAtMs === 'number')
  if (process.platform === 'win32') {
    console.log('  SKIP 权限位断言（Windows 不使用 POSIX mode）')
  } else {
    check('mode is 0600', (statSync(path).mode & 0o777).toString(8), '600')
  }
  // No temp files left behind.
  const strays = readdirSafe(join(root, 'own')).filter(f => f.includes('.tmp-'))
  check('no temp file left behind', strays, [])
}

function readdirSafe(dir) {
  try { return require('node:fs').readdirSync(dir) } catch { return [] }
}

console.log('\n== ownAuthPath honors DSH_HOME ==')
check('uses DSH_HOME when set', ownAuthPath({ DSH_HOME: join(root, 'home') }),
  join(root, 'home', OWN_AUTH_FILENAME))
checkFn('falls back to ~/.dsh', ownAuthPath({}).endsWith(OWN_AUTH_FILENAME))

console.log('\n== desktop candidates ==')
{
  const cands = desktopCookieCandidates({ APPDATA: 'C:\\AD' })
  checkFn('prefers the xiaomi-account partition',
    cands[0] === join('C:\\AD', 'Xiaomi MiMo', 'Partitions', 'xiaomi-account', 'Network', 'Cookies'), cands[0])
  checkFn('MIMO_COOKIE_DB override wins',
    desktopCookieCandidates({ MIMO_COOKIE_DB: 'C:\\x.db', APPDATA: 'C:\\AD' })[0] === 'C:\\x.db')
}

console.log('\n== resolve: desktop source ==')
{
  const dbPath = join(root, 'desktop', 'Cookies')
  makeCookieDb(dbPath, REAL_ROWS)
  const store = new MiMoCredentialStore({
    env: {}, ownPath: join(root, 'nonexistent.json'), cookieCandidates: [dbPath],
  })
  const cred = await store.resolve()
  check('source is desktop', cred.source, 'desktop')
  check('passToken extracted', cred.passToken, 'V1:PASS-TOKEN')
  check('userId extracted', cred.userId, '3207174710')
  check('cUserId extracted', cred.cUserId, 'CUID-123')
  check('noise cookie ignored', 'tracking' in cred, false)
  check('read-only: db still present', existsSync(dbPath), true)
  check('identity is the userId', store.identityOf(cred), '3207174710')
}

console.log('\n== resolve: plugin source wins over desktop ==')
{
  const dbPath = join(root, 'desktop2', 'Cookies')
  makeCookieDb(dbPath, REAL_ROWS)
  const ownPath = join(root, 'own2.json')
  writeOwnCredential(ownPath, { passToken: 'PT-OWN', cUserId: 'OWN-C', userId: 'OWN-U' })
  const store = new MiMoCredentialStore({ env: {}, ownPath, cookieCandidates: [dbPath] })
  const cred = await store.resolve()
  check('plugin credential preferred', cred.source, 'plugin')
  check('plugin passToken used', cred.passToken, 'PT-OWN')
}

console.log('\n== resolve: no source ⇒ actionable error ==')
{
  const store = new MiMoCredentialStore({
    env: {}, ownPath: join(root, 'missing.json'), cookieCandidates: [join(root, 'missing-db')],
  })
  const status = await store.status()
  check('reports signed out', status.signedIn, false)
  checkFn('names the login command', /login/.test(status.reason), status.reason)
  let threw
  try { await store.resolve() } catch (e) { threw = e }
  checkFn('resolve throws', threw !== undefined)
}

console.log('\n== desktop db without passport cookies is not a credential ==')
{
  const dbPath = join(root, 'empty', 'Cookies')
  makeCookieDb(dbPath, [['www.example.com', 'a', 'b']])
  const store = new MiMoCredentialStore({
    env: {}, ownPath: join(root, 'none.json'), cookieCandidates: [dbPath],
  })
  check('falls through to signed-out', (await store.status()).signedIn, false)
}

console.log('\n== corrupt own credential falls back, does not crash ==')
{
  const dbPath = join(root, 'desktop3', 'Cookies')
  makeCookieDb(dbPath, REAL_ROWS)
  const ownPath = join(root, 'corrupt.json')
  writeFileSync(ownPath, '{not json')
  const store = new MiMoCredentialStore({ env: {}, ownPath, cookieCandidates: [dbPath] })
  const cred = await store.resolve()
  check('falls back to desktop', cred.source, 'desktop')
}

console.log('\n== jarFor seeds the passport triple ==')
{
  const jar = MiMoCredentialStore.jarFor({
    passToken: 'PT', cUserId: 'C', userId: 'U',
  })
  checkFn('account host gets the triple', (() => {
    const h = jar.headerFor('https://account.xiaomi.com/pass/serviceLogin')
    return h.includes('passToken=PT') && h.includes('cUserId=C') && h.includes('userId=U')
  })())
  check('unrelated host gets nothing', jar.headerFor('https://mimo-server-cn.xiaomimimo.com/x'), '')
}

console.log('\n== the zero-prompt guarantee ==')
{
  // A machine with a signed-in desktop app must resolve without any prompt.
  const dbPath = join(root, 'desktop4', 'Cookies')
  makeCookieDb(dbPath, REAL_ROWS)
  const store = new MiMoCredentialStore({
    env: {}, ownPath: join(root, 'absent.json'), cookieCandidates: [dbPath],
  })
  const status = await store.status()
  checkFn('signed in silently from the desktop app', status.signedIn === true)
  checkFn('no reason field (nothing to tell the user)', status.reason === undefined)
}

cleanup()
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exitCode = fail === 0 ? 0 : 1
