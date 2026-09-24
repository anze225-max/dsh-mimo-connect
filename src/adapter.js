/**
 * The MiMo adapter.
 *
 * Mirrors the structure dsh-workbuddy-connect uses to register a provider into
 * the DSH LLM seam:
 *
 *   - a pi-ai provider built by `createProvider` with the OpenAI-completions
 *     API, so DSH drives streaming and tool calls through its normal path,
 *   - a hand-assembled `PiAiAdapter` profile (the internal `resolveProfiles()`
 *     helper is not part of dsh-llm-pi-ai's public surface),
 *   - an `invalidate()` hook so DSH re-lists models after a credential change.
 *
 * Structural difference from the reference: there is no loopback shim. The
 * gateway already speaks OpenAI, so models point straight at it and the
 * credential is supplied per request by the session's cookie header.
 *
 * @module dsh-mimo-connect/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { MIMO_DISPLAY_NAME, MIMO_PROVIDER, displayNameOf } from './catalog.js'
import { MIMO_SERVER } from './session.js'

/** Provider idle ceiling while one stream read is outstanding. */
export const MIMO_STREAM_IDLE_TIMEOUT_MS = 3e5

/**
 * Inert pi-ai auth plane, as in the reference plugin.
 *
 * The MiMo route authenticates exclusively through `resolveApiKey`, which
 * returns the session cookie. pi-ai's ambient discovery must never manufacture
 * a credential for this route, or a stray env var could silently shadow the
 * resolved sign-in.
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-mimo-connect: the mimo route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false
    },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

/**
 * Image-request budgets required by the dsh-llm-pi-ai profile type.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
}

/**
 * Convert one catalog entry into the pi-ai model shape DSH consumes.
 *
 * **No reasoning declaration, deliberately.** Advertising `reasoning: true`
 * makes DSH offer an Off/Minimal/Low/Medium/High picker, but the MiMo
 * gateway ignores every reasoning control that was measured:
 * `thinking.type=disabled`, `thinking.enabled=false`, `reasoning_effort`
 * (none/low), `enable_thinking=false` and `chat_template_kwargs` all left the
 * reasoning token count unchanged (176–237 across runs). Showing a picker that
 * silently does nothing is worse than showing none, so the field is omitted
 * and reasoning content still streams through as `thinking_*` events.
 *
 * The `headers` field is the authentication channel: pi-ai spreads
 * `model.headers` into the request it builds from `model.baseUrl`, so the
 * session's cookie header can be attached without a loopback shim.
 *
 * @param info - catalog entry.
 * @param baseUrl - the endpoint this model is served from.
 * @param headers - extra request headers (the cookie header).
 * @returns the pi-ai model descriptor.
 */
export function toPiModel(info, baseUrl, headers = {}) {
  return {
    id: info.id,
    name: displayNameOf(info),
    api: 'openai-completions',
    provider: MIMO_PROVIDER,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    compat: { maxTokensField: 'max_tokens' },
    headers,
  }
}

/**
 * Adapter subclass that reads live catalog state, so a roster change is
 * reflected on the next listing without a re-register.
 */
class MiMoPiAiAdapter extends PiAiAdapter {
  #catalog

  /**
   * @param catalog - the catalog holder.
   * @param options - pi-ai adapter options.
   */
  constructor(catalog, options) {
    super(options)
    this.#catalog = catalog
  }

  /** Catalog entry for one model id, or undefined when the catalog omits it. */
  #infoFor(model) {
    return this.#catalog.current().find(entry => entry.id === model)
  }

  async listModels(provider) {
    const models = await super.listModels(provider)
    return models.map((model) => {
      const info = this.#infoFor(model.id)
      return info === undefined ? model : { ...model, name: displayNameOf(info) }
    })
  }

  async resolveModel(provider, model, signal) {
    const resolved = await super.resolveModel(provider, model, signal)
    const info = this.#infoFor(model)
    return info === undefined ? resolved : { ...resolved, name: displayNameOf(info) }
  }
}

/**
 * Build the adapter DSH registers.
 *
 * @param options.catalog - the catalog holder.
 * @param options.getSession - returns the session currently in effect. A getter
 *   rather than a session instance, because the session is replaced whenever
 *   the credential changes (sign-in, sign-out, account switch).
 * @param options.resolveAttachments - returns the host's durable attachment
 *   service. Required whenever a model advertises image input: dsh-llm-pi-ai
 *   throws `UNSUPPORTED_CONTENT` the moment a message carries an image block
 *   and this resolves to undefined.
 * @returns `{ adapter, invalidate }`.
 */
export function createMiMoAdapter(options) {
  const { catalog, getSession, resolveAttachments, resolveImageAccess } = options

  const baseUrl = `${MIMO_SERVER}/api/route`
  const chatUrl = `${baseUrl}/chat/completions`

  /**
   * Build the model list, attaching the current cookie header to each model.
   *
   * `getModels` is re-read on every listing, so a renewed `serviceToken`
   * reaches the next request without re-registering the provider.
   */
  const buildModels = () => catalog.current().map(
    info => toPiModel(info, baseUrl, { Cookie: getSession().jar.headerFor(chatUrl) }),
  )

  const provider = {
    ...createProvider({
      id: MIMO_PROVIDER,
      name: MIMO_DISPLAY_NAME,
      auth: {
        apiKey: {
          name: 'MiMo session cookie',
          async resolve({ credential }) {
            const apiKey = credential?.key
            if (apiKey === undefined || apiKey.length === 0) return undefined
            return { auth: { apiKey }, source: 'MiMo' }
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    // Read the roster live, so a change is visible without re-registering.
    getModels: () => buildModels(),
  }

  const profile = {
    provider: MIMO_PROVIDER,
    displayName: MIMO_DISPLAY_NAME,
    streamIdleTimeoutMs: MIMO_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-mimo-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map([[MIMO_PROVIDER, profile]])

  const adapter = new MiMoPiAiAdapter(catalog, {
    profiles: () => profiles,
    auth: INERT_AUTH,
    /**
     * Hand pi-ai an opaque per-request credential.
     *
     * Establishing the session here is what makes the cookie available: pi-ai
     * resolves the API key before streaming, and the model list the request is
     * dispatched with is built inside `streamWithSnapshot` — which reads
     * `getModels()` after this resolves. So the header captured in
     * `buildModels()` reflects the freshly minted `serviceToken`.
     *
     * The returned string itself is inert; the gateway ignores the bearer
     * token and authenticates on the cookie header carried via
     * `model.headers`.
     */
    resolveApiKey: async () => {
      await getSession().ensureSession()
      return 'mimo-session'
    },
    // The attachment service is what makes image input possible at all: with
    // no resolver, pi-ai rejects any message containing an image block with
    // UNSUPPORTED_CONTENT — including a text-only turn in a conversation whose
    // earlier tool results carried images.
    ...(resolveAttachments === undefined
      ? {}
      : { resolveAttachments: () => resolveAttachments() }),
    ...(resolveImageAccess === undefined
      ? {}
      : { resolveImageAccess: (attachments, ref) => resolveImageAccess(attachments, ref) }),
  })

  return {
    adapter,
    invalidate: () => {
      profiles = new Map([[MIMO_PROVIDER, profile]])
    },
  }
}
