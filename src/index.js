/**
 * DSH MiMo Connect — bring Xiaomi MiMo models into DeepSeek Harness.
 *
 * The plugin resolves a MiMo credential in two ways, in priority order:
 *
 *   1. its own saved sign-in (`$DSH_HOME/.mimo-connect-auth.json`)
 *   2. the Xiaomi MiMo desktop app's cookie database (read-only)
 *
 * A machine that already has a signed-in desktop app therefore needs no
 * configuration and sees no prompt: the provider appears with its models.
 * Only when neither source yields a credential does the plugin tell the user to
 * run its `login` command.
 *
 * There is no background service, no autostart entry, and no local proxy.
 *
 * @module dsh-mimo-connect
 */

import Schema from '@deepseek-ai/schemastery'
import { MiMoCredentialStore } from './credential.js'
import { MiMoCatalog, MIMO_PROVIDER, FALLBACK_MIMO_MODELS } from './catalog.js'
import { MiMoSession } from './session.js'
import { createMiMoAdapter } from './adapter.js'
import { MiMoQuotaReader } from './quota.js'

/** Stable Cordis plugin name. */
export const name = 'llm-mimo'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/** Exact Fetch route the browser half reads the remaining quota from. */
export const QUOTA_ROUTE = '/api/mimo.quota'

/** How often to re-check for a credential change, in milliseconds. */
const DEFAULT_POLL_MS = 30000

/** Plugin configuration. */
export const Config = Schema.object({
  /** Override the desktop cookie database path (see MIMO_COOKIE_DB). */
  cookieDb: Schema.string().default(''),
  /** Seconds between credential re-checks; 0 disables polling. */
  pollSeconds: Schema.number().default(DEFAULT_POLL_MS / 1000),
})

/**
 * Register the MiMo provider with DSH.
 *
 * @param ctx - the Cordis plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const cookieDb = typeof config?.cookieDb === 'string' ? config.cookieDb.trim() : ''
  const store = new MiMoCredentialStore(
    cookieDb.length > 0 ? { cookieCandidates: [cookieDb] } : {},
  )
  const catalog = new MiMoCatalog()

  // The session is rebuilt whenever the credential identity changes, so a
  // sign-out or account switch cannot leave a stale cookie jar in place.
  let session = new MiMoSession({})
  let currentIdentity

  // Reads the account's remaining desktop free quota. The getter keeps it
  // pointed at whatever session is current, so a credential swap is picked up
  // without rebuilding the reader.
  const quota = new MiMoQuotaReader({ getSession: () => session })

  let stopped = false
  const timers = []

  /** Release handle for the registered adapter, once registration succeeds. */
  let releaseAdapter
  let registered = false

  const { adapter, invalidate } = createMiMoAdapter({
    catalog,
    getSession: () => session,
    /**
     * The host's durable attachment service, resolved lazily.
     *
     * dsh-llm-pi-ai throws `UNSUPPORTED_CONTENT` the moment a message carries
     * an image block and this returns undefined — and that includes a text-only
     * turn in a conversation whose earlier tool results contained images, which
     * is how a plain "你好" can fail right after a model switch.
     *
     * `ctx.get` is used rather than `ctx.inject` because the adapter is built
     * once at apply time, before inject callbacks run; a getter keeps the
     * lookup deferred until the service is actually needed.
     */
    resolveAttachments: () => ctx.get('attachments'),
  })

  /**
   * Point the session at whatever credential is now in effect.
   *
   * @returns the resolved credential, or undefined when signed out.
   */
  const adoptCredential = async () => {
    const status = await store.status()
    if (!status.signedIn) {
      if (currentIdentity !== undefined) {
        currentIdentity = undefined
        session = new MiMoSession({})
        quota.invalidate()
        invalidate()
      }
      return undefined
    }

    const identity = store.identityOf(status.credential)
    if (identity !== currentIdentity) {
      currentIdentity = identity
      session = new MiMoSession({ jar: MiMoCredentialStore.jarFor(status.credential) })
      // A different account has a different allowance; drop the old figure.
      quota.invalidate()
      invalidate()
      ctx.emit('llm/adapters-updated')
    }
    return status.credential
  }

  /**
   * Reconcile against the currently available credential.
   *
   * Establishing the session eagerly means the first turn does not pay the
   * redirect-chain latency, and a broken credential surfaces at startup rather
   * than mid-conversation.
   */
  const sync = async () => {
    if (stopped) return
    const credential = await adoptCredential()
    if (credential === undefined) return
    try {
      await session.ensureSession()
    } catch (error) {
      ctx.logger.warn(
        'dsh-mimo-connect: 会话建立失败，将在下次请求时重试',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** Mount the provider once, then keep it in sync with the credential. */
  const start = () => {
    let registrationError
    try {
      releaseAdapter = ctx.llm.registerAdapter([MIMO_PROVIDER], adapter)
      registered = true
      ctx.effect(() => () => {
        releaseAdapter?.()
        releaseAdapter = undefined
        registered = false
      })
    } catch (error) {
      registrationError = error instanceof Error ? error.message : String(error)
      ctx.logger.error('dsh-mimo-connect: provider registration failed', error)
    }

    if (!registered) return

    void sync()

    const pollMs = Math.max(0, Number(config?.pollSeconds) || 0) * 1000
    if (pollMs > 0) {
      const timer = setInterval(() => {
        void sync()
      }, pollMs)
      timer.unref?.()
      timers.push(timer)
    }
  }

  start()

  // Tear down timers with the plugin instance. Stop first, so an in-flight sync
  // cannot start new work, and clear timers before the loop closes.
  ctx.effect(() => () => {
    stopped = true
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
  })

  // Serve the remaining free quota to the browser half.
  //
  // `connection.fetch.register` puts an exact path behind the same
  // browser-session fence every other `/api` route sits behind, so the client
  // can read it with a plain `fetch`. The route exists only while this plugin
  // is loaded, and degrades to `available: false` rather than an error status:
  // the composer pill simply does not render when there is nothing to show.
  //
  // `ctx.inject` is used rather than adding `connection` to the plugin's own
  // `inject` list, because the service is optional: a host assembled without a
  // browser connection (a headless run, or the CLI) has none, and that must not
  // hold back provider registration. A scoped inject stays pending until the
  // service appears, so the route mounts whenever a browser exists.
  ctx.inject(['connection'], (scope) => {
    scope.connection.fetch.register({
      path: QUOTA_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const reading = await quota.read({ signal: request.signal })
        if (reading === undefined) {
          return Response.json({ available: false }, { headers: { 'cache-control': 'no-store' } })
        }
        return Response.json(
          { available: true, ...reading },
          { headers: { 'cache-control': 'no-store' } },
        )
      },
    })
  })

  /** Build the non-secret status document used by diagnostics. */
  const statusDocument = async () => {
    const status = await store.status()
    return {
      signedIn: status.signedIn,
      ...(status.signedIn
        ? {
            account: {
              userId: status.credential.userId,
              cUserId: status.credential.cUserId,
              // Which source answered: 'plugin' or 'desktop'.
              source: status.credential.source,
              ...(status.credential.cookiePath === undefined
                ? {}
                : { cookiePath: status.credential.cookiePath }),
            },
          }
        : { reason: status.reason }),
      registered,
      session: session.describe(),
      catalog: {
        source: catalog.source(),
        models: catalog.current().map(entry => entry.id),
      },
      cookieCandidates: store.cookieCandidates(),
      ownCredentialPath: store.ownPath(),
      // Cache-only: reading the status must not issue an outbound request.
      quota: quota.peek(),
    }
  }

  // Expose the status as a COMPUTED context property.
  //
  // `ctx` is a cordis proxy: a bare `ctx.status = fn` is read as a service
  // write and throws `cannot set property "status" without provide`, which
  // takes the entire plugin tree down. `ctx.accessor` is the supported way to
  // declare a derived, read-only value.
  try {
    ctx.accessor('mimoStatus', { get: () => statusDocument })
  } catch (error) {
    // Never let a diagnostics surface break plugin loading.
    ctx.logger.warn('dsh-mimo-connect: could not expose the mimoStatus accessor', error)
  }
}

export { MIMO_PROVIDER, FALLBACK_MIMO_MODELS }
