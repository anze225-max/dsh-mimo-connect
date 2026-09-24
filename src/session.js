/**
 * MiMo session establishment.
 *
 * The passport cookies read from the desktop app (or from the plugin's own
 * sign-in) cannot be used for inference directly. They must first be exchanged
 * for a `serviceToken` through MiMo's STS endpoint, via a redirect chain:
 *
 *   1. GET  {server}/api/user/xiaomi/me
 *        → 302 to account.xiaomi.com/pass/serviceLogin?callback=…/api/sts?sign=…
 *   2. GET  {account}/pass/serviceLogin?callback=…
 *        → 302 back to the STS URL, and sets `deviceId`
 *   3. GET  {server}/api/sts?sign=…&followup=…
 *        → 307, and sets `serviceToken` for the MiMo server domain
 *   4. follow `followup` (optional; completes the round trip)
 *
 * Two details are load-bearing and were both learned the hard way:
 *
 *   - **Cookies are sent per-domain.** `account.xiaomi.com` and
 *     `mimo-server-cn.xiaomimimo.com` must each receive only their own cookies.
 *     Mixing them makes the gateway revoke the session (`EXPIRED`).
 *   - **Every response must be absorbed.** The `deviceId` issued in step 2 is
 *     required by step 3.
 *
 * @module dsh-mimo-connect/session
 */

import { CookieJar, domainMatches } from './cookie-jar.js'

/** Upstream API server for the desktop-free quota channel. */
export const MIMO_SERVER = 'https://mimo-server-cn.xiaomimimo.com'

/** Xiaomi passport host. */
export const XIAOMI_ACCOUNT = 'https://account.xiaomi.com'

/**
 * User-Agent used for upstream calls. This is the same identity the third-party
 * MiMo Switch bridge presents; the gateway does not require desktop-app
 * impersonation.
 */
export const MIMO_USER_AGENT = 'MiClaw/1.0'

/** Domain the `serviceToken` is issued for. */
const SERVER_HOST = new URL(MIMO_SERVER).hostname

/** How long a minted serviceToken is trusted before a proactive refresh. */
const SERVICE_TOKEN_TTL_MS = 10 * 60 * 1000

/** Maximum redirect hops followed while establishing a session. */
const MAX_HOPS = 6

/**
 * Held session state: the cookie jar plus the minted token and its age.
 */
export class MiMoSession {
  #jar
  #fetchImpl
  #mintedAtMs
  #minting

  /**
   * @param options.jar - the jar seeded with passport cookies.
   * @param options.fetch - fetch implementation (for tests).
   */
  constructor(options = {}) {
    this.#jar = options.jar ?? new CookieJar()
    this.#fetchImpl = options.fetch ?? globalThis.fetch
    this.#mintedAtMs = undefined
    this.#minting = undefined
  }

  /** The underlying cookie jar. */
  get jar() {
    return this.#jar
  }

  /**
   * Read a cookie that applies to the MiMo server host.
   *
   * The gateway issues `serviceToken` with `Domain=.xiaomimimo.com` — a parent
   * of the server host — so a strict host-keyed lookup misses it. Match the
   * same way the jar does when building a header, preferring the most specific
   * domain.
   *
   * @param name - cookie name.
   * @returns the value, or undefined.
   */
  #cookieForServer(name) {
    let best
    let bestLen = -1
    for (const domain of this.#jar.domains()) {
      if (!domainMatches(domain, SERVER_HOST)) continue
      const value = this.#jar.get(domain, name)
      if (value === undefined) continue
      if (domain.length > bestLen) {
        best = value
        bestLen = domain.length
      }
    }
    return best
  }

  /** Current `serviceToken`, or undefined when not established. */
  serviceToken() {
    return this.#cookieForServer('serviceToken')
  }

  /** Whether the held token is missing or past its trust window. */
  needsRenewal() {
    const token = this.serviceToken()
    if (token === undefined) return true
    if (this.#mintedAtMs === undefined) return true
    return Date.now() - this.#mintedAtMs > SERVICE_TOKEN_TTL_MS
  }

  /**
   * One request that carries only the cookies matching that URL, then absorbs
   * whatever the response sets.
   *
   * @param url - absolute URL.
   * @param init - fetch init.
   * @returns the response.
   */
  async request(url, init = {}) {
    const headers = { 'User-Agent': MIMO_USER_AGENT, ...(init.headers ?? {}) }
    const cookie = this.#jar.headerFor(url)
    if (cookie.length > 0) headers.Cookie = cookie

    const response = await this.#fetchImpl(url, { ...init, headers, redirect: 'manual' })
    this.#jar.absorb(response.headers, new URL(url).hostname)
    return response
  }

  /**
   * Establish (or re-establish) a `serviceToken`.
   *
   * Concurrent callers share one in-flight mint rather than racing.
   *
   * @returns the minted token.
   * @throws when the chain does not yield a token.
   */
  async ensureSession() {
    const existing = this.serviceToken()
    if (existing !== undefined && !this.needsRenewal()) return existing

    if (this.#minting !== undefined) return this.#minting

    this.#minting = this.#mint().finally(() => {
      this.#minting = undefined
    })
    return this.#minting
  }

  /**
   * Drop any held `serviceToken`, wherever it was scoped.
   *
   * The gateway may issue it under a parent domain, so clearing only the exact
   * host key would leave a stale token behind.
   */
  #clearServiceToken() {
    for (const domain of this.#jar.domains()) {
      if (domainMatches(domain, SERVER_HOST)) this.#jar.set(domain, 'serviceToken', '')
    }
    this.#mintedAtMs = undefined
  }

  /**
   * Walk the redirect chain until a `serviceToken` appears.
   *
   * @returns the token.
   */
  async #mint() {
    // Drop a stale token so a failed refresh cannot look like success.
    this.#clearServiceToken()

    let url = `${MIMO_SERVER}/api/user/xiaomi/me`
    let lastStatus = 0

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const response = await this.request(url, {
        headers: { Accept: 'text/html,application/json,*/*;q=0.8' },
      })
      lastStatus = response.status

      // The token can arrive on any hop; check before deciding to continue.
      const token = this.serviceToken()
      if (token !== undefined && token.length > 0) {
        this.#mintedAtMs = Date.now()
        return token
      }

      const location = response.headers.get('location')
      if (location === null || location.length === 0) {
        // Drain the body so the socket is released before we give up.
        try { await response.arrayBuffer() } catch {}
        break
      }
      url = new URL(location, url).toString()
    }

    throw new Error(
      'MiMo 会话建立失败：未取得 serviceToken。'
      + `最后一次响应 HTTP ${lastStatus}。`
      + '若持续失败，请重新登录（login）或在桌面端重新登录。',
    )
  }

  /**
   * Send a chat completion, renewing the session once on an auth failure.
   *
   * @param body - the JSON request body string.
   * @param signal - abort signal for the caller's request.
   * @returns the upstream response.
   */
  async chatStream(body, signal) {
    const send = async () => {
      await this.ensureSession()
      return this.request(`${MIMO_SERVER}/api/route/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
        },
        body,
        signal,
      })
    }

    let response = await send()
    if (response.status === 401 || response.status === 403) {
      // The token aged out mid-flight; mint a fresh one and retry exactly once.
      this.#clearServiceToken()
      try { await response.arrayBuffer() } catch {}
      response = await send()
    }
    return response
  }

  /** Non-secret session summary for diagnostics. */
  describe() {
    const token = this.serviceToken()
    return {
      hasServiceToken: token !== undefined && token.length > 0,
      tokenAgeMs: this.#mintedAtMs === undefined ? undefined : Date.now() - this.#mintedAtMs,
      cookies: this.#jar.describe(),
    }
  }
}
