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

import {
  readFileSync,
  existsSync,
  copyFileSync,
  unlinkSync,
  mkdirSync,
  renameSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { CookieJar } from './cookie-jar.js'

/**
 * One resolved MiMo credential: the Xiaomi passport triple, plus where it came
 * from. `cookiePath` is present only for a credential read out of the desktop
 * app's cookie database, and records which candidate path answered.
 *
 * @typedef {object} MiMoCredential
 * @property {string} passToken - the passport token; the only required field.
 * @property {string} cUserId - the account's client-side user id.
 * @property {string} userId - the account's user id.
 * @property {'plugin'|'desktop'} source - which resolver answered.
 * @property {number} [savedAtMs] - when the plugin saved its own credential.
 * @property {string} [cookiePath] - the desktop cookie database that answered.
 */

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
    out.push(
      join(home, '.config', 'Xiaomi MiMo', 'Partitions', 'xiaomi-account', 'Network', 'Cookies'),
    )
    out.push(
      join(
        home,
        'Library',
        'Application Support',
        'Xiaomi MiMo',
        'Partitions',
        'xiaomi-account',
        'Network',
        'Cookies',
      ),
    )
  }
  return [...new Set(out)]
}

/**
 * Read every row of a cookie database, read-only.
 *
 * Opening read-only is what keeps the "never modify the desktop app" promise:
 * a read-only handle cannot checkpoint or vacuum the file it is pointed at.
 * The live database can be opened this way even while Chromium holds it open in
 * WAL mode (measured), which is what makes the fallback in `readDesktopCookies`
 * usable at all.
 *
 * @param path - path to a cookie database.
 * @returns the rows, or undefined when the file cannot be read as one.
 */
function readCookieRows(path) {
  if (!existsSync(path)) return undefined
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      return db.prepare('SELECT host_key, name, value FROM cookies').all()
    } finally {
      db.close()
    }
  } catch {
    // Not a database, not a cookie table, or unreadable. The caller decides
    // whether that is final.
    return undefined
  }
}

/**
 * Read the passport cookies out of a Chromium cookie database.
 *
 * The database is copied to a temporary file first: the desktop app holds it
 * open while running, and copying avoids interleaving a read with its writes.
 *
 * The copy is only an optimization, never the sole route to the data. Chromium
 * commits new cookies into the `-wal` sidecar and only folds them back into the
 * main file at a checkpoint, so a copy that misses `-wal` opens *successfully*
 * but reports `no such table: cookies` — measured, and the opposite of what the
 * previous comment here claimed. A failed sidecar copy therefore used to
 * degrade all the way to "no credential on this machine", which is precisely
 * the zero-prompt case this module exists to serve. When the copy cannot be
 * read, the original file is opened read-only instead.
 *
 * @param dbPath - path to the `Cookies` SQLite file.
 * @param {object} [options] - optional overrides for tests.
 * @param {typeof copyFileSync} [options.copyFile] - copier, to exercise a failed sidecar copy.
 * @returns `{ domain: { name: value } }`, or undefined when unreadable/empty.
 */
export function readDesktopCookies(dbPath, options = {}) {
  if (!existsSync(dbPath)) return undefined

  const copyFile = options.copyFile ?? copyFileSync
  const scratch = join(tmpdir(), `mimo-ck-${process.pid}-${Date.now()}.db`)
  const sidecars = ['', '-journal', '-wal', '-shm']
  const copied = []
  for (const suffix of sidecars) {
    if (existsSync(dbPath + suffix)) {
      try {
        copyFile(dbPath + suffix, scratch + suffix)
        copied.push(scratch + suffix)
      } catch {
        // Recorded implicitly: the read below falls back to the original file
        // when the scratch copy turns out to be incomplete.
      }
    }
  }

  try {
    const rows = readCookieRows(scratch) ?? readCookieRows(dbPath)
    if (rows === undefined) return undefined

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
      try {
        unlinkSync(path)
      } catch {}
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
  const home = env.DSH_HOME && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
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
  const body = JSON.stringify(
    {
      version: OWN_FORMAT_VERSION,
      credential: {
        passToken: credential.passToken,
        cUserId: credential.cUserId,
        userId: credential.userId,
        savedAtMs: Date.now(),
      },
    },
    null,
    2,
  )
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, path)
  try {
    chmodSync(path, 0o600)
  } catch {}
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
   * @returns {MiMoCredential|undefined} the credential plus `source`, or undefined.
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
   * @returns {MiMoCredential|undefined} the credential plus `source` and the path used, or undefined.
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
      'MiMo 尚未登录。请先运行 `dsh plugin --profile <profile> exec dsh-mimo-connect login` ' +
        '完成一次登录，或在 Xiaomi MiMo 桌面端登录后重试。' +
        `（已查找：${this.#candidates.join(', ') || '无可用路径'}）`,
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
   * Stable identity string for one credential, used to detect credential
   * changes and decide whether the held session and roster still apply.
   *
   * Built from the account id when one is present, plus a digest of the
   * `passToken`. The digest contributes two things the account id alone cannot:
   *
   *   - `login` explicitly lets the user leave `cUserId`/`userId` blank, since
   *     `passToken` is the only field the STS exchange needs. An identity that
   *     returned `undefined` for such a credential was a real defect: `index.js`
   *     rebuilds the session jar only when the identity *changes*, so a blank-id
   *     credential resolved, resolved again to `undefined`, compared equal to the
   *     initial `undefined`, and left the jar empty forever — never sending the
   *     `passToken` the mint depends on.
   *   - re-signing-in keeps `userId` but issues a new `passToken`. Without the
   *     digest the identity looked unchanged, so a running plugin kept using the
   *     expired token and the documented "re-login to recover" path did nothing
   *     until DSH restarted.
   *
   * A digest is used rather than the token itself so this value cannot leak the
   * secret if it is ever logged. It stays stable for an unchanged credential,
   * which is what stops the poll loop from re-minting the session every
   * `pollSeconds`.
   *
   * @param credential - the credential.
   * @returns an opaque identity, or undefined when there is nothing to identify.
   */
  identityOf(credential) {
    if (credential === undefined || credential === null) return undefined
    const passToken = typeof credential.passToken === 'string' ? credential.passToken : ''
    if (passToken.length === 0) return undefined

    const id =
      typeof credential.userId === 'string' && credential.userId.length > 0
        ? credential.userId
        : typeof credential.cUserId === 'string' && credential.cUserId.length > 0
          ? credential.cUserId
          : ''
    const digest = createHash('sha256').update(passToken).digest('hex').slice(0, 16)
    return id.length > 0 ? `${id}#${digest}` : `passToken#${digest}`
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
