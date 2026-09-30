/**
 * dsh-mimo-connect — browser half.
 *
 * Adds a remaining-quota readout to the composer dock row, immediately after the
 * host's own stats pill, and shows it **only while the session is routed to
 * MiMo**.
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
    const { createElement: h, useCallback, useEffect, useState } = react

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
     * The readout is an ordinary entry of `conversation.composer.dock`, the
     * `kind: "list"` slot that already owns the composer stats row: the host's
     * own `StatsPills` registers there as `id: "stats", order: 0`, and the dock
     * container is the flex row `{justify-content:center; align-items:center;
     * gap:12px; display:flex}` that holds it. An entry at `order: 10` therefore
     * lands directly beside the stats pill, laid out by the host's own flex
     * rules — no offset is computed here.
     *
     * Only the pill's own geometry is declared, copied from the host's stats
     * pill so the two read as one row at any font size or zoom. The stylesheet
     * is rendered as a React element by the component rather than appended to
     * `document.head`, because the host's `claimStyles` attributes every
     * untagged `<style>` in the document to whichever plugin is materializing
     * and then removes them when that plugin unloads.
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
     * The remaining-quota pill.
     *
     * Renders nothing unless the session's current route is MiMo *and* a figure
     * is available, so an unrelated conversation never grows a control for a
     * quota it is not spending.
     *
     * When it does render it is a normal entry of `conversation.composer.dock`,
     * the `kind: "list"` slot that already owns the composer stats row, so the
     * host's own flex rules place it beside the stats pill.
     *
     * @param props - slot currency: the session-scoped model directory plus the
     *        namespace translator.
     * @returns the pill, or null.
     */
    function QuotaPill({ directory, t, sessionId }) {
      // `directory` is the per-session model directory store (getSnapshot /
      // subscribe), the same instance the model picker writes to.
      const [routed, setRouted] = useState(() => providerOf(directory) === MIMO_PROVIDER)
      const [quota, setQuota] = useState(undefined)

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

      // Fetch only while routed to MiMo, and keep the figure fresh while it is.
      useEffect(() => {
        if (!routed) {
          setQuota(undefined)
          return undefined
        }
        const controller = new AbortController()
        refresh(controller.signal)
        const timer = setInterval(() => {
          if (!controller.signal.aborted) refresh(controller.signal)
        }, REFRESH_MS)
        return () => {
          clearInterval(timer)
          controller.abort()
        }
      }, [routed, refresh])

      if (!routed || quota === undefined) return null

      const percent = formatPercent(quota.percent)
      const label = t('quota.label', { percent })
      const title = quota.resetDate === undefined
        ? t('quota.title', { percent })
        : `${t('quota.title', { percent })} · ${t('quota.reset', { date: quota.resetDate })}`
      const tone = quota.percent <= 5 ? 'mimoq_dotLow' : quota.percent <= 20 ? 'mimoq_dotWarn' : undefined

      // The stylesheet rides in this component's own tree, so React inserts it
      // with the first render and removes it on unmount. Appending to
      // `document.head` from factory scope instead would let the host's
      // `claimStyles` attribute an untagged `<style>` to whichever plugin is
      // materializing and then delete it on that plugin's unload.
      return h(
        react.Fragment,
        null,
        h('style', { key: 'css', 'data-plugin-css': 'dsh-mimo-connect/QuotaPill.module.css' }, CSS),
        h(
          'span',
          { key: 'pill', className: 'mimoq_anchor', 'data-mimo-quota': true, 'data-session-id': sessionId },
          h(
            'span',
            { className: 'mimoq_pill', title, 'aria-label': title, role: 'note' },
            h('span', { className: tone === undefined ? 'mimoq_dot' : `mimoq_dot ${tone}`, 'aria-hidden': true }),
            h('span', { className: 'mimoq_label' }, label),
          ),
        ),
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
