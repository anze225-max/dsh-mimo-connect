/**
 * Model catalog.
 *
 * History, because it explains the current design
 * ----------------------------------------------
 * This module used to hard-code the roster. That was correct at the time: the
 * gateway exposed **no** model-listing endpoint, so `/api/route/models`,
 * `/api/models` and `/v1/models` all answered 404, and the only way to know
 * which models existed was to copy the desktop app's own `model-catalog.json`.
 *
 * A later anonymous probe saw `/api/route/models` answer **401** instead of 404
 * and this file concluded, wrongly, that the endpoint now existed — reasoning
 * that 401 means "not authenticated" while 404 would mean "no such route".
 *
 * That inference was tested against a real signed-in credential on 2026-10-12
 * and **it does not hold**. What the gateway actually does:
 *
 *   - every path under `/api/route/` answers 401 without a session — including
 *     invented ones like `/api/route/model/config` that certainly do not exist;
 *   - every path outside that prefix answers 404, again including invented ones.
 *
 * So 401 here is a **prefix-wide auth fence evaluated before routing**, not
 * evidence that a route exists. With a valid session `/api/route/models`,
 * `/api/route/model/list` and 14 other candidate paths all answered 404, while
 * the genuinely existing `/api/user/usage` answered 200 in the same breath.
 * The listing endpoint does not exist, and it never did.
 *
 * Why this module no longer guesses
 * ---------------------------------
 * The gateway-first path is kept, but not because an endpoint is expected to be
 * found: it is kept so that the plugin will adopt a real roster automatically if
 * Xiaomi ever publishes one, without a code change. Until then it must be
 * understood as a **probe that normally finds nothing**. The 404 fallbacks are
 * therefore the normal, expected outcome, not a malfunction.
 *
 * The snapshot is the practical source of truth. It is verified rather than
 * guessed: on 2026-10-12 both built-in ids resolved past model validation and
 * were stopped only by the membership gate (`403 membership_required`), whereas
 * near-miss ids (`mimo-v2.5-flash`, `mimo-v2.6-ultra`, `mimo-v2.6`) and an
 * unrelated one (`gpt-4o`) were rejected earlier with
 * `400 chat_model_not_public`. Reaching the membership gate is what shows the
 * names are right. `source()` still reports `'builtin'`, because that is what is
 * in effect.
 *
 * Only chat models belong here: the desktop app's ASR / TTS / image entries
 * cannot serve a DSH turn, so gateway entries that are not chat-shaped are
 * filtered out rather than surfaced as broken choices.
 *
 * @module dsh-mimo-connect/catalog
 */

import { MIMO_SERVER } from './session.js'

/** Provider route this plugin owns. */
export const MIMO_PROVIDER = 'mimo'

/** Display name shown in the DSH model picker. */
export const MIMO_DISPLAY_NAME = 'MiMo'

/**
 * Context window assumed for a model the catalog does not describe.
 *
 * A guess, and labelled as such: it is only reached for an id that neither the
 * gateway nor the snapshot describes.
 */
const DEFAULT_CONTEXT_WINDOW = 262144

/** Output ceiling assumed for a model the catalog does not describe. */
const DEFAULT_MAX_TOKENS = 65536

/**
 * Built-in roster, used **only** when the gateway cannot be asked.
 *
 * Mirrors MiMo Desktop's `model-catalog.json` TEXT entries, whose
 * `displayRatio` is the credit multiplier that app shows. Treat it as a
 * degraded-mode list, not as the current truth — see the module comment.
 *
 * There is deliberately no `supportsReasoning` flag here. The models do emit
 * chain-of-thought (it arrives as `reasoning_content` and is surfaced as
 * `thinking_*` stream events), but whether the gateway honours any *control*
 * over it is an open question that must be measured rather than assumed; see
 * `toPiModel` in `./adapter.js` and `tools/probe-gateway.mjs`. A flag guessed
 * wrong is worse than no flag, because it advertises a picker that does
 * nothing.
 */
export const FALLBACK_MIMO_MODELS = [
  {
    id: 'mimo-v2.6-flash',
    name: 'MiMo V2.6 Flash',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    supportsImages: true,
    displayRatio: 0.4,
  },
  {
    id: 'mimo-v2.6-pro',
    name: 'MiMo V2.6 Pro',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    supportsImages: true,
    displayRatio: 1,
  },
]

/** Built-in metadata keyed by model id. */
const BUILTIN_BY_ID = new Map(FALLBACK_MIMO_MODELS.map(entry => [entry.id, entry]))

/**
 * Describe one model id, preferring built-in metadata and falling back to
 * conservative defaults so an unknown (newly launched) id still works.
 *
 * @param id - the model id.
 * @returns the catalog entry.
 */
export function describeModel(id) {
  return (
    BUILTIN_BY_ID.get(id) ?? {
      id,
      name: id,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      supportsImages: true,
      displayRatio: undefined,
    }
  )
}

/**
 * Display label for the picker, carrying the credit multiplier the desktop app
 * shows (e.g. `MiMo V2.6 Flash · x0.40`).
 *
 * @param info - catalog entry.
 * @returns the label.
 */
export function displayNameOf(info) {
  const ratio = info.displayRatio
  if (typeof ratio !== 'number') return info.name
  return `${info.name} · x${ratio.toFixed(2)}`
}

/**
 * Pull a model id out of one gateway entry.
 *
 * The gateway's exact shape has not been confirmed against a live signed-in
 * account (that needs a subscription), so several plausible field names are
 * accepted. Being liberal here is deliberate: the cost of a missed alias is
 * "the roster silently stays on the snapshot", which is exactly the failure
 * this module exists to remove.
 *
 * @param entry - one element of the gateway's model list.
 * @returns the id, or undefined.
 */
function idOf(entry) {
  if (typeof entry === 'string') return entry.length > 0 ? entry : undefined
  if (entry === null || typeof entry !== 'object') return undefined
  for (const key of ['id', 'model', 'modelId', 'name']) {
    const value = entry[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Locate the model array inside a gateway response.
 *
 * Same reasoning as `idOf`: the envelope is unconfirmed, so the common shapes
 * are all tried before concluding there is nothing to read.
 *
 * @param parsed - the decoded response body.
 * @returns an array of entries, or undefined when none is found.
 */
export function findModelArray(parsed) {
  if (parsed === null || parsed === undefined) return undefined
  if (Array.isArray(parsed)) return parsed
  if (typeof parsed !== 'object') return undefined
  const candidates = [
    parsed.data,
    parsed.data?.models,
    parsed.data?.list,
    parsed.models,
    parsed.list,
  ]
  for (const c of candidates) {
    if (Array.isArray(c)) return c
  }
  return undefined
}

/**
 * Convert one gateway entry into the catalog's internal shape.
 *
 * Unknown fields are left undefined rather than invented, so a caller can tell
 * "the gateway did not say" apart from "the gateway said X". `contextWindow`
 * and `maxTokens` fall back to the conservative defaults because a model that
 * advertises no window still has to be usable.
 *
 * @param entry - one gateway model entry.
 * @returns the catalog entry, or undefined when no id can be read.
 */
export function normalizeGatewayModel(entry) {
  const id = idOf(entry)
  if (id === undefined) return undefined

  const source = entry !== null && typeof entry === 'object' ? entry : {}
  const builtin = BUILTIN_BY_ID.get(id)

  /** Read the first present, correctly-typed numeric field among aliases. */
  const num = (...keys) => {
    for (const k of keys) {
      const v = source[k]
      if (typeof v === 'number' && Number.isFinite(v)) return v
    }
    return undefined
  }
  /** Read the first present string field among aliases. */
  const str = (...keys) => {
    for (const k of keys) {
      const v = source[k]
      if (typeof v === 'string' && v.length > 0) return v
    }
    return undefined
  }

  const contextWindow =
    num('contextWindow', 'context_length', 'contextLength', 'maxContextTokens') ??
    builtin?.contextWindow ??
    DEFAULT_CONTEXT_WINDOW
  const maxTokens =
    num('maxTokens', 'max_tokens', 'maxOutputTokens') ?? builtin?.maxTokens ?? DEFAULT_MAX_TOKENS

  // Image support may be stated directly, or implied by a modality list.
  let supportsImages
  if (typeof source.supportsImages === 'boolean') supportsImages = source.supportsImages
  else if (Array.isArray(source.input)) supportsImages = source.input.includes('image')
  else if (Array.isArray(source.modalities)) supportsImages = source.modalities.includes('image')
  else if (builtin !== undefined) supportsImages = builtin.supportsImages

  return {
    id,
    name: str('displayName', 'label', 'title') ?? builtin?.name ?? id,
    contextWindow,
    maxTokens,
    supportsImages,
    // Accepted under its gateway name too, since that is what the desktop app
    // calls the credit multiplier.
    displayRatio: num('displayRatio', 'ratio') ?? builtin?.displayRatio,
  }
}

/**
 * Whether a gateway entry looks like a chat model this plugin can serve.
 *
 * The desktop app's catalog also lists ASR / TTS / image entries; those cannot
 * answer a DSH turn, so offering them would produce a picker entry that always
 * fails. Entries that state a non-chat kind are dropped; entries that state
 * nothing are kept, because refusing an unlabelled model would be worse than
 * trying it.
 *
 * @param entry - one gateway model entry.
 * @returns true when the entry should be offered.
 */
export function isChatModel(entry) {
  if (entry === null || typeof entry !== 'object') return typeof entry === 'string'
  const kind = entry.type ?? entry.kind ?? entry.category ?? entry.modality
  if (typeof kind !== 'string') return true
  const k = kind.toLowerCase()
  if (/asr|tts|speech|audio|image|vision-only|embedding|rerank/.test(k)) return false
  return true
}

/**
 * The catalog holder.
 *
 * The roster starts as the built-in snapshot so the provider can register
 * immediately (a first run must not block on the network), and can be replaced
 * by the gateway's roster once that has been fetched. `source()` always says
 * which of the two is currently in effect.
 */
export class MiMoCatalog {
  #models
  #source

  /**
   * @param models - the initial roster; defaults to the built-in snapshot.
   * @param source - provenance of that initial roster.
   */
  constructor(models = FALLBACK_MIMO_MODELS, source = 'builtin') {
    this.#models = [...models]
    this.#source = source
  }

  /** The roster currently in effect. */
  current() {
    return [...this.#models]
  }

  /**
   * Provenance label: `'gateway'` when the roster came from the API,
   * `'builtin'` when it is the unverified snapshot.
   */
  source() {
    return this.#source
  }

  /** Whether the roster holds a given model id. */
  has(id) {
    return this.#models.some(entry => entry.id === id)
  }

  /**
   * Adopt a roster fetched from the gateway.
   *
   * Refuses an empty list: "the gateway said nothing" must not be allowed to
   * blank the picker, because that would turn a transient upstream hiccup into
   * "no models available". An empty result therefore leaves the snapshot in
   * place, and `source()` keeps reporting `'builtin'` so the state is visible.
   *
   * @param entries - normalized catalog entries.
   * @returns true when a non-empty roster was adopted.
   */
  adoptGatewayModels(entries) {
    const usable = Array.isArray(entries) ? entries.filter(e => e !== undefined) : []
    if (usable.length === 0) return false
    this.#models = [...usable]
    this.#source = 'gateway'
    return true
  }

  /**
   * Fetch the roster from the gateway and adopt it when usable.
   *
   * Every failure path returns false rather than throwing: a model list is
   * useful but never worth failing a session over, and the snapshot is a
   * perfectly workable fallback. `session` is only used for its request
   * plumbing, so a caller may pass any object shaped like `MiMoSession`.
   *
   * @param session - the session used to authenticate the request.
   * @param {object} [options] - refresh options.
   * @param {AbortSignal} [options.signal] - optional abort signal.
   * @param {string[]} [options.paths] - endpoints to try, in order.
   * @param {string} [options.baseUrl] - gateway origin; defaults to the real
   *   one. Injectable so this path can be driven against a local server in
   *   tests, which is the only way to exercise it without a subscription.
   * @returns true when the gateway roster replaced the snapshot.
   */
  async refreshFromGateway(
    session,
    { signal, paths = GATEWAY_MODEL_PATHS, baseUrl = MIMO_SERVER } = {},
  ) {
    if (session === undefined || session === null) return false

    for (const path of paths) {
      let parsed
      try {
        const response = await session.request(`${baseUrl}${path}`, {
          headers: { Accept: 'application/json' },
          signal,
        })
        // Distinguish the two failure classes, because they call for opposite
        // responses:
        //
        //   - 401/403 mean "not signed in, or not entitled". Every endpoint
        //     sits behind the same fence, so trying the next one only adds
        //     latency to reach the same answer. Stop and keep the snapshot.
        //   - anything else (404 for a renamed route, 5xx for a bad gateway)
        //     is specific to this path, so the next candidate is still worth
        //     trying.
        if (!response.ok) {
          try {
            await response.arrayBuffer()
          } catch {}
          if (response.status === 401 || response.status === 403) return false
          continue
        }
        const text = await response.text()
        // Unauthenticated paths on this host answer with HTML, not JSON.
        if (!text.trimStart().startsWith('{') && !text.trimStart().startsWith('[')) continue
        parsed = JSON.parse(text)
      } catch {
        continue
      }

      const array = findModelArray(parsed)
      if (array === undefined) continue
      const normalized = array
        .filter(isChatModel)
        .map(normalizeGatewayModel)
        .filter(e => e !== undefined)
      if (this.adoptGatewayModels(normalized)) return true
    }
    return false
  }
}

/**
 * Endpoints tried, in order, when asking the gateway for its roster.
 *
 * **Measured on 2026-10-12 with a valid signed-in credential: every one of these
 * answers 404.** So does every other candidate that was tried (16 in total,
 * including `/api/route/models`). The listing endpoint does not exist — see the
 * module comment for why a 401 seen anonymously does *not* contradict that.
 *
 * The list is kept anyway, and deliberately ordered by plausibility, so that if
 * Xiaomi ever publishes a roster the plugin adopts it on the next sync without a
 * code change. Reaching the snapshot fallback is the expected outcome today.
 */
export const GATEWAY_MODEL_PATHS = ['/api/route/models', '/api/route/model/list', '/api/models']
