/**
 * Domain-scoped cookie jar.
 *
 * This module exists because of one measured failure: sending
 * `.account.xiaomi.com` and `.xiaomi.com` cookies in the same `Cookie` header
 * makes MiMo's gateway treat the session as invalid and answer every cookie
 * with `EXPIRED`, redirecting back to the passport login page. Scoping each
 * request's header to the domains that actually match the request host is what
 * makes the STS exchange succeed.
 *
 * Semantics follow RFC 6265 closely enough for this flow:
 *
 *   - a host-only cookie (no `Domain=`) is sent to exactly that host;
 *   - a domain cookie (`Domain=example.com`) is sent to that host and any
 *     subdomain;
 *   - a leading dot on the domain attribute means the same thing and is
 *     normalized away.
 *
 * @module dsh-mimo-connect/cookie-jar
 */

/** A cookie whose value means "drop this cookie". */
const CLEARED = /^(EXPIRED)?$/

/**
 * Normalize a domain for comparison: lowercase, no leading dot.
 *
 * @param domain - raw domain string.
 * @returns the normalized domain.
 */
function normalizeDomain(domain) {
  return String(domain ?? '').trim().toLowerCase().replace(/^\./, '')
}

/**
 * Whether a cookie scoped to `domain` may be sent to `host`.
 *
 * @param domain - the cookie's domain (normalized).
 * @param host - the request host (normalized).
 * @returns true when the cookie matches.
 */
export function domainMatches(domain, host) {
  const d = normalizeDomain(domain)
  const h = normalizeDomain(host)
  if (d.length === 0 || h.length === 0) return false
  return h === d || h.endsWith(`.${d}`)
}

/**
 * Parse one `Set-Cookie` header line.
 *
 * @param line - the raw header value.
 * @param fallbackHost - host to attribute the cookie to when no Domain is given.
 * @returns the parsed cookie, or undefined when the line is unusable.
 */
export function parseSetCookie(line, fallbackHost) {
  if (typeof line !== 'string' || line.length === 0) return undefined
  const parts = line.split(';')
  const pair = parts[0] ?? ''
  const eq = pair.indexOf('=')
  if (eq <= 0) return undefined

  const name = pair.slice(0, eq).trim()
  if (name.length === 0) return undefined

  // Strip surrounding quotes; Chromium serializes empty values as "".
  let value = pair.slice(eq + 1).trim()
  const quoted = /^"(.*)"$/.exec(value)
  if (quoted !== null) value = quoted[1]

  let domain = normalizeDomain(fallbackHost)
  let hostOnly = true
  for (const attr of parts.slice(1)) {
    const i = attr.indexOf('=')
    const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase()
    if (key === 'domain') {
      const raw = i === -1 ? '' : attr.slice(i + 1).trim()
      // An explicit Domain makes it a domain cookie even without a dot.
      domain = normalizeDomain(raw)
      hostOnly = false
    }
  }
  if (domain.length === 0) return undefined

  return { domain, name, value, hostOnly }
}

/**
 * A jar of cookies keyed by domain, then by name. Last write wins, so
 * re-absorbing a refresh overwrites the previous value.
 */
export class CookieJar {
  /** @type {Map<string, Map<string, string>>} */
  #byDomain = new Map()

  /**
   * Store a cookie. Empty values and the literal `EXPIRED` clear the entry:
   * the gateway uses both to revoke a session.
   *
   * @param domain - cookie domain.
   * @param name - cookie name.
   * @param value - cookie value; empty or `EXPIRED` deletes.
   */
  set(domain, name, value) {
    const d = normalizeDomain(domain)
    if (d.length === 0) return
    let bucket = this.#byDomain.get(d)
    if (bucket === undefined) {
      bucket = new Map()
      this.#byDomain.set(d, bucket)
    }
    if (typeof value !== 'string' || CLEARED.test(value.trim())) bucket.delete(name)
    else bucket.set(name, value)
  }

  /** Read one cookie value, or undefined. */
  get(domain, name) {
    return this.#byDomain.get(normalizeDomain(domain))?.get(name)
  }

  /**
   * Build the `Cookie` header for one URL, including only cookies whose domain
   * matches that URL's host.
   *
   * A host can legitimately match several stored domains at once — for example
   * `account.xiaomi.com` matches both `.account.xiaomi.com` and `.xiaomi.com`,
   * and in practice both carry a `cUserId`. Emitting that name twice produces
   * an invalid header (and a duplicate-cookie ambiguity on the server), so each
   * name is emitted once, taking the value from the most specific domain — the
   * longest matching domain wins, which is the rule browsers apply.
   *
   * @param url - the absolute request URL.
   * @returns the header value, or an empty string when nothing matches.
   */
  headerFor(url) {
    let host
    try {
      host = new URL(url).hostname
    } catch {
      return ''
    }

    // Collect matches, then resolve per-name conflicts by domain specificity.
    const matches = []
    for (const [domain, cookies] of this.#byDomain) {
      if (!domainMatches(domain, host)) continue
      matches.push({ domain, cookies })
    }
    // Most specific first, so the first write of a name is the one we keep.
    matches.sort((a, b) => b.domain.length - a.domain.length)

    const chosen = new Map()
    for (const { cookies } of matches) {
      for (const [name, value] of cookies) {
        if (!chosen.has(name)) chosen.set(name, value)
      }
    }
    return [...chosen].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  /**
   * Absorb the `Set-Cookie` headers of one response.
   *
   * @param headers - a Headers-like object, or an array of raw header lines.
   * @param host - host the response came from, for cookies with no Domain.
   */
  absorb(headers, host) {
    const lines = Array.isArray(headers)
      ? headers
      : (typeof headers?.getSetCookie === 'function' ? headers.getSetCookie() : [])
    for (const line of lines) {
      const parsed = parseSetCookie(line, host)
      if (parsed === undefined) continue
      this.set(parsed.domain, parsed.name, parsed.value)
    }
  }

  /** Seed from `{ domain: { name: value } }`, as read from a browser DB. */
  seed(byDomain) {
    for (const [domain, cookies] of Object.entries(byDomain ?? {})) {
      for (const [name, value] of Object.entries(cookies ?? {})) {
        this.set(domain, name, value)
      }
    }
  }

  /** Every domain currently holding at least one cookie. */
  domains() {
    return [...this.#byDomain.keys()]
  }

  /** Names held for one domain (diagnostics only; never prints values). */
  namesFor(domain) {
    return [...(this.#byDomain.get(normalizeDomain(domain))?.keys() ?? [])]
  }

  /** A `{ domain: { name: value } }` snapshot; contains secrets. */
  toJSON() {
    const out = {}
    for (const [domain, cookies] of this.#byDomain) {
      out[domain] = Object.fromEntries(cookies)
    }
    return out
  }

  /** Non-secret summary for logs: `domain: [names]`. */
  describe() {
    return this.domains().map(d => `${d}: [${this.namesFor(d).join(', ')}]`).join(' | ')
  }
}
