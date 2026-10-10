/**
 * Ambient declarations for the DSH browser plugin host.
 *
 * These describe globals the host provides in the page but that no npm package
 * declares, so a JSDoc typecheck (`tsc --checkJs`) can see them.
 *
 * This file is declarations only — it has no runtime effect and is never
 * imported. `src/client.js` is loaded by the host's vendored module loader, not
 * by Node, which is why the global has to be described rather than imported.
 */

/**
 * The loader the host publishes on the page. A client bundle is a single call
 * to `load`, whose factory receives the host's `require`.
 */
interface DshModuleLoader {
  /**
   * Materialize one client bundle.
   *
   * @param definition - the bundle's id and factory.
   */
  load(definition: {
    id: string
    factory: (require: (specifier: string) => any) => unknown
  }): void
}

interface Window {
  /**
   * Published by the host before any client bundle is materialized. Present in
   * the DSH page only; a bundle evaluated outside it would fail here.
   */
  __ModuleLoader__: DshModuleLoader
}
