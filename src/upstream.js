/**
 * Upstream client for the MiMo desktop-free channel.
 *
 * The endpoint is `mimo-server-cn.xiaomimimo.com/api/route/chat/completions`,
 * which speaks the OpenAI chat-completions protocol. Measurements confirm:
 *
 *   - request body is the standard OpenAI shape,
 *   - streaming responses are `data: {...}` SSE chunks terminated by `[DONE]`,
 *   - tool calls arrive as `delta.tool_calls` with `finish_reason: "tool_calls"`,
 *   - the response body is schema-identical to OpenAI's.
 *
 * So there is no protocol translation layer here — unlike the WorkBuddy
 * plugin, which had to shim a private wire format. What this module owns is
 * authentication (via the session), request shaping, and error classification.
 *
 * @module dsh-mimo-connect/upstream
 */

import { MIMO_SERVER } from './session.js'

/**
 * Fields pi-ai carries in-process that are not part of the wire contract.
 * Sending them risks a 400 from a strict gateway.
 */
const DROPPED_FIELDS = ['provider', 'api', 'compat']

/**
 * Normalize a chat-completions body for the MiMo gateway.
 *
 * @param raw - the JSON request body as a string.
 * @returns the normalized body string.
 */
export function prepareChatBody(raw) {
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    // Not JSON we can inspect; forward verbatim.
    return raw
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return raw

  const out = { ...body }
  for (const field of DROPPED_FIELDS) delete out[field]
  if (out.stream === undefined) out.stream = true
  return JSON.stringify(out)
}

/**
 * Failure classes the shim maps to HTTP status codes.
 * @typedef {'hard_credit'|'soft_rate'|'session_dead'|'not_found'|'server'|'client'} UpstreamErrorKind
 */

/**
 * Classify an upstream HTTP failure.
 *
 * @param status - the HTTP status returned upstream.
 * @param message - the upstream error text.
 * @returns the failure class.
 */
export function classifyUpstreamError(status, message) {
  const text = String(message ?? '').toLowerCase()
  if (status === 401 || status === 403) return 'session_dead'
  if (status === 404) return 'not_found'
  if (status === 402) return 'hard_credit'
  if (status === 429) return 'soft_rate'
  if (status >= 500) return 'server'
  if (status === 400 && /quota|balance|insufficient|credit|额度|余额/.test(text)) return 'hard_credit'
  return 'client'
}

/**
 * Client that performs streaming chat completions against the MiMo gateway.
 */
export class MiMoUpstreamClient {
  /**
   * @param options.session - the session used for auth and cookie scoping.
   */
  constructor(options = {}) {
    this.session = options.session
  }

  /**
   * Issue a streaming chat completion.
   *
   * @param body - the normalized JSON request body.
   * @param signal - abort signal tied to the inbound request.
   * @returns a discriminated result: `{ ok: true, response }` or
   *          `{ ok: false, kind, status, message }`.
   */
  async chatStream(body, signal) {
    let response
    try {
      response = await this.session.chatStream(body, signal)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      return {
        ok: false,
        kind: 'server',
        status: 0,
        message: `无法连接 MiMo 服务：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    if (!response.ok) {
      let text = ''
      try {
        text = await response.text()
      } catch {
        text = response.statusText
      }
      return {
        ok: false,
        kind: classifyUpstreamError(response.status, text),
        status: response.status,
        message: text,
      }
    }

    return { ok: true, response }
  }

  /**
   * Probe the account state. Returns undefined when unavailable — quota display
   * is optional and must never break a turn.
   *
   * @param signal - optional abort signal.
   * @returns a small status document, or undefined.
   */
  async account(signal) {
    try {
      const response = await this.session.request(`${MIMO_SERVER}/api/user/xiaomi/me`, {
        headers: { Accept: 'application/json' },
        signal,
      })
      if (!response.ok) return undefined
      const text = await response.text()
      // The account host serves HTML for unauthenticated paths; only accept JSON.
      if (!text.trimStart().startsWith('{')) return undefined
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }
}
