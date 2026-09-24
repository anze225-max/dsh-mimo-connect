/**
 * MiMo credential store.
 *
 * Two sources, in priority order:
 *
 *   1. the plugin's own sign-in  — `$DSH_HOME/.mimo-connect-auth.json`
 *   2. the MiMo desktop app      — its Chromium cookie database
 *
 * The desktop app is read **read-only**, and only when the plugin has not
 * signed in itself. That ordering is what makes a machine that already has a
 * signed-in desktop app work with zero prompts.
 *
 * What we need from either source is the Xiaomi passport triple
 * (`passToken` / `cUserId` / `userId`). Those are exchanged for a short-lived
 * `serviceToken` by `session.js`; they are not themselves usable for inference.
 *
 * Unlike the WorkBuddy desktop app, MiMo's cookie values are stored in
 * plaintext — Chromium leaves `value` populated and `encrypted_value` empty —
 * so no DPAPI / safeStorage unwrapping is required.
 *
 * @module dsh-mimo-connect/credential
 */

import { readFileSync, existsSync, copyFileSync, unlinkSync, mkdirSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CookieJar } from './cookie-jar.js'

/** Xiaomi passport cookies required to establish a session. */
export const REQUIRED_COOKIES = ['passToken', 'cUserId', 'userId']

/** Where the plugin keeps its own credential, relative to the DSH home. */
export const OWN_AUTH_FILENAME = '.mimo-connect-auth.json'

/** On-disk format version of the plugin-owned credential. */
export const OWN_FORMAT_VERSION = 1

/** Upstream the desktop credential is used against. */
export const MIMO_SERVER = 'https://mimo-server-cn.xiaomimimo.com'

/**
 * Desktop cookie databases to probe, most likely first.
 *
 * @param env - environment to read.
 * @returns candidate absolute paths.
 */
export function desktopCookieCandidates(env = process.env) {
  const out = []
  const override = env.MIMO_COOKIE_DB
  if (typeof override === 'string' && override.trim().length > 0) out.push(override.trim())

  const appData = env.APPDATA
  if (typeof appData === 'string' && appData.length > 0) {
    // The desktop app isolates the Xiaomi account in its own partition.
    out.push(join(appData, 'Xiaomi MiMo', 'Partitions', 'xiaomi-account', 'Network', 'Cookies'))
    out.push(join(appData, 'Xiaomi MiMo', 'Network', 'Cookies'))
  }
  const home = env.HOME ?? env.USERPROFILE
  if (typeof home === 'string' && home.length > 0) {
    // Non-Windows layouts, for completeness.
    out.push(join(home, '.config', 'Xiaomi MiMo', 'Partitions', 'xiaomi-account', 'Network', 'Cookies'))
    out.push(join(home, 'Library', 'Application Support', 'Xiaomi MiMo', 'Partitions', 'xiaomi-account', 'Network', 'Cookies'))
  }
  return [...new Set(out)]
}

/**
 * Read the passport cookies out of a Chromium cookie database.
 *
 * The database is copied to a temporary file first: the desktop app holds it
 * open while running, and reading in place can fail or block.
 *
 * @param dbPath - path to the `Cookies` SQLite file.
 * @returns `{ domain: { name: value } }`, or undefined when unreadable/empty.
 */
export function readDesktopCookies(dbPath) {
  if (!existsSync(dbPath)) return undefined

  const scratch = join(tmpdir(), `mimo-ck-${process.pid}-${Date.now()}.db`)
  const sidecars = ['', '-journal', '-wal', '-shm']
  const copied = []
  for (const suffix of sidecars) {
    if (existsSync(dbPath + suffix)) {
      try {
        copyFileSync(dbPath + suffix, scratch + suffix)
        copied.push(scratch + suffix)
      } catch {
        // A locked sidecar is not fatal; the main file carries the cookies.
      }
    }
  }
  if (!existsSync(scratch)) return undefined

  try {
    const db = new DatabaseSync(scratch, { readOnly: true })
    let rows
    try {
      rows = db.prepare('SELECT host_key, name, value FROM cookies').all()
    } finally {
      db.close()
    }

    const byDomain = {}
    let seen = 0
    for (const row of rows) {
      const name = row?.name
      const value = row?.value
      const host = row?.host_key
      if (typeof name !== 'string' || typeof value !== 'string' || value.length === 0) continue
      if (typeof host !== 'string' || host.length === 0) continue
      // Only passport cookies matter; skip analytics and locale noise.
      if (!REQUIRED_COOKIES.includes(name) && name !== 'uLocale') continue
      ;(byDomain[host] ??= {})[name] = value
      if (REQUIRED_COOKIES.includes(name)) seen++
    }
    return seen > 0 ? byDomain : undefined
  } catch {
    return undefined
  } finally {
    for (const path of copied) {
      try { unlinkSync(path) } catch {}
    }
  }
}

/**
 * The plugin's own credential file path.
 *
 * @param env - environment to read.
 * @returns absolute path.
 */
export function ownAuthPath(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, OWN_AUTH_FILENAME)
}

/**
 * Parse the plugin-owned credential document.
 *
 * @param text - raw file contents.
 * @returns the credential, or undefined when unusable.
 */
export function parseOwnCredential(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  if (parsed.version !== undefined && parsed.version !== OWN_FORMAT_VERSION) return undefined
  const c = parsed.credential ?? parsed
  const passToken = typeof c.passToken === 'string' ? c.passToken : ''
  if (passToken.length === 0) return undefined
  return {
    passToken,
    cUserId: typeof c.cUserId === 'string' ? c.cUserId : '',
    userId: typeof c.userId === 'string' ? c.userId : '',
    savedAtMs: typeof c.savedAtMs === 'number' ? c.savedAtMs : undefined,
  }
}

/**
 * Persist the plugin-owned credential atomically and owner-only.
 *
 * @param path - destination path.
 * @param credential - the passport triple to store.
 */
export function writeOwnCredential(path, credential) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  const body = JSON.stringify({
    version: OWN_FORMAT_VERSION,
    credential: {
      passToken: credential.passToken,
      cUserId: credential.cUserId,
      userId: credential.userId,
      savedAtMs: Date.now(),
    },
  }, null, 2)
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, path)
  try { chmodSync(path, 0o600) } catch {}
}

/**
 * Credential resolver with the documented priority order.
 */
export class MiMoCredentialStore {
  #env
  #candidates
  #ownPath

  /**
   * @param options - optional overrides for tests.
   */
  constructor(options = {}) {
    this.#env = options.env ?? process.env
    this.#ownPath = options.ownPath ?? ownAuthPath(this.#env)
    this.#candidates = options.cookieCandidates ?? desktopCookieCandidates(this.#env)
  }

  /** Paths probed for the desktop cookie database. */
  cookieCandidates() {
    return [...this.#candidates]
  }

  /** Path of the plugin-owned credential. */
  ownPath() {
    return this.#ownPath
  }

  /**
   * Load the plugin's own credential, if present.
   *
   * @returns the credential plus `source`, or undefined.
   */
  readOwn() {
    try {
      if (!existsSync(this.#ownPath)) return undefined
      const parsed = parseOwnCredential(readFileSync(this.#ownPath, 'utf-8'))
      if (parsed === undefined) return undefined
      return { ...parsed, source: 'plugin' }
    } catch {
      return undefined
    }
  }

  /**
   * Load a credential from the desktop app's cookie database.
   *
   * @returns the credential plus `source` and the path used, or undefined.
   */
  readDesktop() {
    for (const path of this.#candidates) {
      const byDomain = readDesktopCookies(path)
      if (byDomain === undefined) continue

      // The passport triple lives under the account domain.
      let found
      for (const [domain, cookies] of Object.entries(byDomain)) {
        if (domain.includes('account.xiaomi.com') && typeof cookies.passToken === 'string') {
          found = cookies
          break
        }
      }
      if (found === undefined) continue
      return {
        passToken: found.passToken,
        cUserId: found.cUserId ?? '',
        userId: found.userId ?? '',
        source: 'desktop',
        cookiePath: path,
      }
    }
    return undefined
  }

  /**
   * Resolve using the documented priority order.
   *
   * @returns the credential.
   * @throws when neither source yields one.
   */
  async resolve() {
    const own = this.readOwn()
    if (own !== undefined) return own

    const desktop = this.readDesktop()
    if (desktop !== undefined) return desktop

    throw new Error(
      'MiMo 尚未登录。请先运行 `dsh plugin --profile <profile> exec dsh-mimo-connect login` '
      + '完成一次登录，或在 Xiaomi MiMo 桌面端登录后重试。'
      + `（已查找：${this.#candidates.join(', ') || '无可用路径'}）`,
    )
  }

  /**
   * Non-throwing probe for status output and startup reconciliation.
   *
   * @returns `{ signedIn: true, credential }` or `{ signedIn: false, reason }`.
   */
  async status() {
    try {
      return { signedIn: true, credential: await this.resolve() }
    } catch (error) {
      return { signedIn: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Stable identity string for one credential, used to detect account changes.
   *
   * @param credential - the credential.
   * @returns an opaque identity, or undefined when it carries no user id.
   */
  identityOf(credential) {
    if (credential === undefined) return undefined
    const id = credential.userId.length > 0 ? credential.userId : credential.cUserId
    return id.length > 0 ? id : undefined
  }

  /**
   * Seed a jar with the passport cookies of one credential.
   *
   * @param credential - the credential.
   * @returns the seeded jar.
   */
  static jarFor(credential) {
    const jar = new CookieJar()
    jar.set('.account.xiaomi.com', 'passToken', credential.passToken)
    if (credential.cUserId.length > 0) {
      jar.set('.account.xiaomi.com', 'cUserId', credential.cUserId)
      jar.set('.xiaomi.com', 'cUserId', credential.cUserId)
    }
    if (credential.userId.length > 0) {
      jar.set('.account.xiaomi.com', 'userId', credential.userId)
      jar.set('.xiaomi.com', 'userId', credential.userId)
    }
    return jar
  }
}
