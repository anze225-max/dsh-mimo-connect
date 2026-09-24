/**
 * dsh-mimo-connect — browser half.
 *
 * Adds a remaining-quota readout to the composer stats row, immediately left of
 * the model picker, and shows it **only while the session is routed to MiMo**.
 *
 * Why the gating matters: a DeepSeek turn has nothing to do with the MiMo
 * allowance, and a figure sitting in the composer during unrelated work is
 * noise. The readout is tied to the session's own model selection, so switching
 * to MiMo makes it appear and switching away makes it disappear — no setting to
 * find, nothing to dismiss.
 *
 * The bundle is hand-written plain JS in the built `__ModuleLoader__.load`
 * shape. The host serves it at `/plugins` from the package's `./client` export,
 * discovered through the `dsh.client` declaration in package.json; see
 * `tools/build-client.mjs` for how `src/client.js` becomes `lib/client.js`.
 *
 * @module dsh-mimo-connect/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-mimo-connect',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = react
    // `react-dom` is part of the shell's frozen platform module table, so it
    // resolves without an `dsh.client.external` entry.
    const { createPortal } = require('react-dom')

    /** Provider id this plugin owns; must match MIMO_PROVIDER in src/catalog.js. */
    const MIMO_PROVIDER = 'mimo'

    /** Exact route the node half registers. */
    const QUOTA_ROUTE = '/api/mimo.quota'

    /** Poll cadence while the readout is visible. */
    const REFRESH_MS = 60 * 1000

    const NS = 'mimo'

    const zh = {
      'quota.label': 'MiMo 剩余 {percent}%',
      'quota.title': 'MiMo 桌面端免费额度剩余 {percent}%',
      'quota.reset': '重置于 {date}',
      'quota.refreshing': '正在刷新 MiMo 剩余额度',
    }

    const en = {
      'quota.label': 'MiMo {percent}% left',
      'quota.title': 'MiMo desktop free quota: {percent}% remaining',
      'quota.reset': 'Resets {date}',
      'quota.refreshing': 'Refreshing MiMo remaining quota',
    }

    /**
     * Styles for the pill.
     *
     * How the two built-in pills are laid out — copied rather than approximated:
     *
     * ```html
     * <div class="FwxveW_root" data-composer-stats>   <!-- flex; gap:12px; center -->
     *   <span class="FwxveW_anchor"><button class="FwxveW_pill">…</button></span>
     *   <span class="FwxveW_anchor"><button class="FwxveW_pill">…</button></span>
     * </div>
     * ```
     *
     * `.FwxveW_root` is `display:flex; justify-content:center; gap:12px;
     * width:100%`, and the pills are ordinary flex children of it. Nothing is
     * absolutely positioned and no offset is hand-computed, which is exactly why
     * that row stays correct at any font size or zoom.
     *
     * This entry cannot be a child of that container: `StatsPills` registers on
     * `conversation.composer.dock` without declaring `children`, so the slot
     * registry has no sub-slot to contribute to. Fighting that with absolute
     * positioning would mean hard-coding the row height, which breaks the moment
     * a theme changes the font metrics.
     *
     * So the component portals its pill INTO `[data-composer-stats]`, making it a
     * real flex child of the same container. Layout is then owned entirely by the
     * host's own rules, and the only styles needed are the pill's own geometry —
     * copied from `.FwxveW_pill` verbatim, including its hover treatment.
     *
     * While the row has not mounted yet (or the model is not MiMo), there is no
     * container to portal into and the component renders nothing.
     */
    const CSS = `
.mimoq_pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:24px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:default}
.mimoq_pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.mimoq_anchor{min-width:0;display:inline-flex}
.mimoq_dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.55}
.mimoq_dotWarn{opacity:1;background:var(--dsw-alias-state-warning-primary,currentColor)}
.mimoq_dotLow{opacity:1;background:var(--dsw-alias-state-error-primary,currentColor)}
.mimoq_label{min-width:0;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
`

    const tagId = 'dsh-mimo-connect/QuotaPill.module.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-mimo-connect'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * Validate a quota payload from the node half.
     *
     * @param value - the decoded response body.
     * @returns the reading, or undefined when there is nothing to show.
     */
    function readQuota(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
      if (value.available !== true) return undefined
      if (typeof value.percent !== 'number' || !Number.isFinite(value.percent)) return undefined
      return value
    }

    /**
     * Format the remaining share.
     *
     * One decimal throughout, at most: rounding to whole percent would hide the
     * small decrements a single turn actually costs on a large allowance, which
     * is precisely what this readout exists to show. A true 100 stays compact
     * so an untouched account does not read as "100.0%".
     *
     * @param percent - the remaining share.
     * @returns the display string.
     */
    function formatPercent(percent) {
      const clamped = Math.min(100, Math.max(0, percent))
      if (clamped >= 99.95) return '100'
      const fixed = clamped.toFixed(1)
      // Drop a trailing ".0" so ordinary readings stay short.
      return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
    }

    /**
     * Find the built-in stats row to contribute into.
     *
     * The row is identified by the `data-composer-stats` attribute its own
     * component sets — a stable public marker rather than a generated class name.
     * It appears only once the session has a step count or a token total, so this
     * is polled for on mount until it shows up.
     *
     * Only one composer ever renders a stats row: `conversation.composer` is a
     * `chain` slot, and the one plugin that claims it for addressed subagent
     * sessions (ui-subagent) substitutes a read-only frame that renders no
     * composer bar at all. So a single unscoped lookup cannot cross sessions.
     *
     * The `length === 1` guard is a correctness fence rather than a handling of
     * today's behaviour: if a future surface ever mounts two rows, this returns
     * null and the pill simply does not render, which is strictly better than
     * showing one session's quota inside another session's composer.
     *
     * @returns the stats row, or null when it is absent or ambiguous.
     */
    function findStatsRow() {
      if (typeof document === 'undefined') return null
      const rows = document.querySelectorAll('[data-composer-stats]')
      return rows.length === 1 ? rows[0] : null
    }

    /**
     * The remaining-quota pill.
     *
     * Renders nothing unless the session's current route is MiMo *and* a figure
     * is available, so an unrelated conversation never grows a control for a
     * quota it is not spending.
     *
     * When it does render, it renders INTO the built-in stats row rather than
     * beside it, so the host's own flex rules place it on that line. See the
     * stylesheet comment above for why that is the only layout-stable option.
     *
     * @param props - slot currency: the session-scoped model directory plus the
     *        namespace translator.
     * @returns the portalled pill, or null.
     */
    function QuotaPill({ directory, t, sessionId }) {
      // `directory` is the per-session model directory store (getSnapshot /
      // subscribe), the same instance the model picker writes to.
      const [routed, setRouted] = useState(() => providerOf(directory) === MIMO_PROVIDER)
      const [quota, setQuota] = useState(undefined)
      const [row, setRow] = useState(() => findStatsRow())
      const lifetime = useRef(undefined)

      const refresh = useCallback((signal) => {
        return fetch(QUOTA_ROUTE, { signal })
          .then(response => (response.ok ? response.json() : undefined))
          .then(body => {
            if (signal.aborted) return
            setQuota(readQuota(body))
          })
          .catch(() => {
            // Offline, aborted, or signed out: show nothing rather than an error.
            if (!signal.aborted) setQuota(undefined)
          })
      }, [])

      // Follow the session's model selection.
      useEffect(() => {
        if (directory === undefined) {
          setRouted(false)
          return undefined
        }
        const sync = () => setRouted(providerOf(directory) === MIMO_PROVIDER)
        sync()
        return directory.subscribe(sync)
      }, [directory])

      // The stats row mounts and unmounts on its own schedule: it renders nothing
      // until the session has a step or a token total, and the host replaces it
      // outright on some re-renders.
      //
      // Two mechanisms cover that:
      //
      //   - a per-frame poll until a row is found (the initial appearance);
      //   - a `MutationObserver` while a row is held, so a host swap is noticed
      //     at once instead of leaving the pill rendering into a detached node.
      //
      // Only runs while the session is routed to MiMo, so a DeepSeek
      // conversation never schedules anything.
      useEffect(() => {
        if (!routed) return undefined

        // Resolve scheduling primitives off the page rather than as bare
        // globals: a bundle can be evaluated in a scope where the bare
        // identifiers are absent even though the window carries them.
        const view = typeof window === 'undefined' ? undefined : window
        const raf = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : typeof view?.requestAnimationFrame === 'function'
            ? view.requestAnimationFrame.bind(view)
            : (cb) => setTimeout(() => cb(Date.now()), 16)
        const cancel = typeof cancelAnimationFrame === 'function'
          ? cancelAnimationFrame
          : typeof view?.cancelAnimationFrame === 'function'
            ? view.cancelAnimationFrame.bind(view)
            : clearTimeout
        const observerCtor = typeof MutationObserver === 'function'
          ? MutationObserver
          : view?.MutationObserver

        let cancelled = false
        let handle
        let observer

        /**
         * Look for a row, and keep looking while none is usable.
         *
         * Stops only once the held row IS the one in the document: holding a
         * detached node or a stale one means there is still work to do.
         */
        const poll = () => {
          if (cancelled) return
          const found = findStatsRow()
          if (found !== null) {
            if (row !== found) setRow(found)
            return
          }
          handle = raf(poll)
        }

        if (row === null || !row.isConnected) {
          // Nothing usable is held: look for one each frame.
          handle = raf(poll)
        } else if (observerCtor !== undefined) {
          // A live row is held. Watch for the host swapping it out. Restarting
          // the poll here rather than waiting on a state round-trip means the
          // replacement is picked up even if React batches the null update.
          observer = new observerCtor(() => {
            if (cancelled) return
            if (row.isConnected && row === findStatsRow()) return
            setRow(null)
            handle = raf(poll)
          })
          observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true })
        }

        return () => {
          cancelled = true
          cancel(handle)
          observer?.disconnect()
        }
      }, [row, routed])

      // Fetch only while routed to MiMo, and keep the figure fresh while it is.
      useEffect(() => {
        if (!routed) {
          setQuota(undefined)
          return undefined
        }
        const controller = new AbortController()
        lifetime.current = controller
        refresh(controller.signal)
        const timer = setInterval(() => {
          if (!controller.signal.aborted) refresh(controller.signal)
        }, REFRESH_MS)
        return () => {
          clearInterval(timer)
          controller.abort()
        }
      }, [routed, refresh])

      if (!routed || quota === undefined || row === null || !row.isConnected) return null

      const percent = formatPercent(quota.percent)
      const label = t('quota.label', { percent })
      const title = quota.resetDate === undefined
        ? t('quota.title', { percent })
        : `${t('quota.title', { percent })} · ${t('quota.reset', { date: quota.resetDate })}`
      const tone = quota.percent <= 5 ? 'mimoq_dotLow' : quota.percent <= 20 ? 'mimoq_dotWarn' : undefined

      return createPortal(
        h(
          'span',
          { className: 'mimoq_anchor', 'data-mimo-quota': true, 'data-session-id': sessionId },
          h(
            'span',
            { className: 'mimoq_pill', title, 'aria-label': title, role: 'note' },
            h('span', { className: tone === undefined ? 'mimoq_dot' : `mimoq_dot ${tone}`, 'aria-hidden': true }),
            h('span', { className: 'mimoq_label' }, label),
          ),
        ),
        row,
      )
    }

    /**
     * Read the provider a model directory currently routes to.
     *
     * @param directory - the per-session model directory store.
     * @returns the provider id, or undefined when unknown.
     */
    function providerOf(directory) {
      try {
        const state = directory.getSnapshot()
        return state?.current?.provider
      } catch {
        return undefined
      }
    }

    /** Services required to register the dictionary and the composer pill. */
    const inject = ['slots', 'locale', 'modelDirectories']

    /**
     * Client plugin body.
     *
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mimo-connect: dictionaries')

      ctx.inject(['slots', 'modelDirectories'], (scope) => {
        const models = scope.modelDirectories
        scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
          name: 'conversation.composer.dock',
          id: 'mimo-quota',
          // The built-in stats pills sit at order 0; land just after them so the
          // row reads: session stats, then quota, then the row ends.
          order: 10,
          locale: NS,
          inject: (sessionId) => {
            const directory = models.directoryFor(sessionId)
            return {
              sessionId,
              directory: directory?.store,
            }
          },
        }, QuotaPill))
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

//# sourceMappingURL=client.js.map
