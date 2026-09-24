/**
 * Produce the browser bundle the host serves at `/plugins`.
 *
 * `src/client.js` is already written in the built `__ModuleLoader__.load`
 * shape — plain CJS-in-a-closure that the vendored loader materialises on
 * demand — so "building" it is a copy. The step is kept explicit and separate
 * so the two facts that matter stay true:
 *
 *   - `lib/client.js` is the artifact the host reads, never a source file;
 *   - `pnpm run build` regenerates it, matching how every bundled client
 *     package in the DSH tree behaves.
 *
 * A source map is emitted alongside so the browser devtools resolve frames back
 * to `src/client.js` rather than into a single anonymous closure.
 *
 * @module dsh-mimo-connect/tools/build-client
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const sourcePath = join(root, 'src', 'client.js')
const outDir = join(root, 'lib')
const outPath = join(outDir, 'client.js')

const source = readFileSync(sourcePath, 'utf8')

// The bundle's bytes are served verbatim, so the only build-time transformation
// is appending the source-map pointer.
const mapName = 'client.js.map'
const bundle = `${source}\n//# sourceMappingURL=${mapName}\n`

/**
 * One identity section mapping the whole file, which is all a same-line-shape
 * copy needs. `sources` is relative so the map works from any mount point.
 */
const map = JSON.stringify({
  version: 3,
  file: 'client.js',
  sources: [relative(outDir, sourcePath).replace(/\\/g, '/')],
  sourcesContent: [source],
  names: [],
  mappings: '',
})

mkdirSync(outDir, { recursive: true })
writeFileSync(outPath, bundle)
writeFileSync(join(outDir, mapName), map)

console.log(`dsh-mimo-connect: wrote ${relative(root, outPath)} (${bundle.length} bytes)`)
