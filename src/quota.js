/**
 * Remaining free-quota lookup for the MiMo desktop channel.
 *
 * `GET {server}/api/user/usage` answers with the account's current allowance:
 *
 * ```json
 * {"code":0,"message":"success",
 *  "data":{"percent":99.8,"resetDate":"2026-09-30","resetAt":1790782334}}
 * ```
 *
 * `percent` is the **remaining** share of the period's allowance, not the used
 * share: a freshly reset account reads 99.8 rather than 0.2. `resetAt` is a Unix
 * second timestamp for the next refill, and `resetDate` is its calendar day in
 * the account's own timezone.
 *
 * The probe is read-only and consumes nothing. Every failure path returns
 * undefined rather than throwing — a quota readout must never be able to break
 * inference or a page render.
 *
 * @module dsh-mimo-connect/quota
 */

import { MIMO_SERVER } from './session.js'

/** How long a successful reading is reused before another probe. */
export const QUOTA_CACHE_MS = 60 * 1000

/**
 * How long a *failed* probe is remembered, so a signed-out or offline host does
 * not issue one doomed request per client render.
 */
export const QUOTA_FAILURE_CACHE_MS = 15 * 1000

/** Upper bound on a single probe, so a hung gateway cannot pin the route open. */
const QUOTA_TIMEOUT_MS = 8000

/**
 * @typedef {object} MiMoQuota
 * @property {number} percent - remaining share of the allowance, 0–100.
 * @property {number} [resetAt] - Unix seconds of the next reset.
 * @property {string} [resetDate] - calendar day of the next reset.
 * @property {number} fetchedAt - Unix milliseconds when this reading was taken.
 */

/**
 * Parse the `data` payload of `/api/user/usage`.
 *
 * @param value - the decoded response body.
 * @returns the quota reading, or undefined when the shape is not understood.
 */
export function parseQuota(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  // The envelope carries `code`/`data`; a bare `data` object is also accepted so
  // a future gateway that drops the envelope keeps working.
  const data = value.data !== undefined && typeof value.data === 'object' && value.data !== null
    ? value.data
    : value
  const percent = data.percent
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined

  const quota = { percent: Math.min(100, Math.max(0, percent)) }
  if (typeof data.resetAt === 'number' && Number.isFinite(data.resetAt)) {
    quota.resetAt = data.resetAt
  }
  if (typeof data.resetDate === 'string' && data.resetDate.length > 0) {
    quota.resetDate = data.resetDate
  }
  return quota
}

/**
 * Reads the account's remaining quota through an established session, caching
 * both successes and failures.
 */
export class MiMoQuotaReader {
  #getSession
  #fetchImpl
  #cached
  #cachedAtMs
  #failureUntilMs
  #inflight

  /**
   * @param options.getSession - returns the current session, which may change
   *        when the credential identity changes.
   * @param options.fetch - fetch implementation (for tests).
   */
  constructor(options = {}) {
    this.#getSession = options.getSession
    this.#fetchImpl = options.fetch ?? globalThis.fetch
    this.#cached = undefined
    this.#cachedAtMs = 0
    this.#failureUntilMs = 0
    this.#inflight = undefined
  }

  /** Drop cached state, e.g. after a credential change. */
  invalidate() {
    this.#cached = undefined
    this.#cachedAtMs = 0
    this.#failureUntilMs = 0
  }

  /**
   * The last successful reading, without touching the network.
   *
   * Diagnostics use this: a status accessor must never cause an outbound
   * request, or merely inspecting plugin state would go online.
   *
   * @returns the cached reading, or undefined.
   */
  peek() {
    return this.#cached
  }

  /**
   * Read the remaining quota, using the cache when it is still fresh.
   *
   * @param options.force - bypass a cached success.
   * @param options.signal - abort signal from the caller.
   * @returns the reading, or undefined when unavailable.
   */
  async read(options = {}) {
    const now = Date.now()
    if (!options.force && this.#cached !== undefined && now - this.#cachedAtMs < QUOTA_CACHE_MS) {
      return this.#cached
    }
    if (this.#cached === undefined && now < this.#failureUntilMs) return undefined

    // Collapse concurrent readers onto one probe.
    if (this.#inflight !== undefined) return this.#inflight

    this.#inflight = this.#probe(options.signal).finally(() => {
      this.#inflight = undefined
    })
    return this.#inflight
  }

  /**
   * Perform one probe.
   *
   * @param signal - optional caller signal.
   * @returns the reading, or undefined.
   */
  async #probe(signal) {
    const session = this.#getSession?.()
    if (session === undefined) return undefined

    const timeout = AbortSignal.timeout(QUOTA_TIMEOUT_MS)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

    try {
      // The session may need a fresh serviceToken; establish it lazily so the
      // very first page load after a restart can already show a figure.
      await session.ensureSession()

      const response = await session.request(`${MIMO_SERVER}/api/user/usage`, {
        headers: { Accept: 'application/json' },
        signal: combined,
      })
      if (!response.ok) {
        // Drain so the socket is released.
        try { await response.arrayBuffer() } catch {}
        this.#failureUntilMs = Date.now() + QUOTA_FAILURE_CACHE_MS
        return undefined
      }

      const text = await response.text()
      // Unauthenticated paths on this host answer with HTML.
      if (!text.trimStart().startsWith('{')) {
        this.#failureUntilMs = Date.now() + QUOTA_FAILURE_CACHE_MS
        return undefined
      }

      const parsed = parseQuota(JSON.parse(text))
      if (parsed === undefined) {
        this.#failureUntilMs = Date.now() + QUOTA_FAILURE_CACHE_MS
        return undefined
      }

      const reading = { ...parsed, fetchedAt: Date.now() }
      this.#cached = reading
      this.#cachedAtMs = reading.fetchedAt
      this.#failureUntilMs = 0
      return reading
    } catch {
      // Abort, network failure, or malformed JSON all mean "no figure right now".
      this.#failureUntilMs = Date.now() + QUOTA_FAILURE_CACHE_MS
      return undefined
    }
  }
}
