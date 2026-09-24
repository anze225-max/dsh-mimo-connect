/**
 * Model catalog.
 *
 * The MiMo gateway exposes **no** model-listing endpoint — `/api/route/models`,
 * `/api/models` and `/v1/models` all return 404. The roster is therefore a
 * built-in snapshot, taken from the desktop app's own `model-catalog.json`
 * TEXT entries (whose `displayRatio` is the credit multiplier shown in its UI).
 *
 * Only chat models belong here: the app's ASR / TTS / image entries cannot
 * serve a DSH turn.
 *
 * @module dsh-mimo-connect/catalog
 */

/** Provider route this plugin owns. */
export const MIMO_PROVIDER = 'mimo'

/** Display name shown in the DSH model picker. */
export const MIMO_DISPLAY_NAME = 'MiMo'

/**
 * Context window assumed for a model the catalog does not describe.
 */
const DEFAULT_CONTEXT_WINDOW = 262144

/** Output ceiling assumed for a model the catalog does not describe. */
const DEFAULT_MAX_TOKENS = 65536

/**
 * Built-in roster, mirroring MiMo Desktop's `model-catalog.json` TEXT entries.
 *
 * There is deliberately no `supportsReasoning` flag. These models *do* emit
 * chain-of-thought (it arrives as `reasoning_content` and is surfaced as
 * `thinking_*` stream events), but the gateway ignores every control that was
 * measured for it — see `toPiModel` in `./adapter.js`. A flag would only
 * advertise a picker that does nothing.
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
  return BUILTIN_BY_ID.get(id) ?? {
    id,
    name: id,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    supportsImages: true,
    displayRatio: undefined,
  }
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
 * The catalog holder.
 *
 * The gateway has no roster endpoint, so this is effectively a constant list.
 * The `source` bookkeeping is kept so a future endpoint can be slotted in
 * without changing consumers.
 */
export class MiMoCatalog {
  #models

  /**
   * @param models - the roster; defaults to the built-in snapshot.
   */
  constructor(models = FALLBACK_MIMO_MODELS) {
    this.#models = [...models]
  }

  /** The roster currently in effect. */
  current() {
    return [...this.#models]
  }

  /** Provenance label, for parity with the WorkBuddy plugin's status shape. */
  source() {
    return 'builtin'
  }

  /** Whether the roster holds a given model id. */
  has(id) {
    return this.#models.some(entry => entry.id === id)
  }
}
