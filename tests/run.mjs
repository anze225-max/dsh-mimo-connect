#!/usr/bin/env node
/**
 * Test runner.
 *
 * Runs every suite in `tests/` in its own process so a suite that hangs or
 * exits non-zero cannot mask the others. Suites that need a real MiMo
 * credential skip themselves when none is present.
 *
 *   node tests/run.mjs          run everything
 *   node tests/run.mjs cookie   run suites whose name contains "cookie"
 *
 * Three outcomes are reported separately, because "the suite ran and passed"
 * and "the suite had nothing to check" are not the same claim:
 *
 *   - **pass** — the suite ran and exited 0.
 *   - **skip** — the suite found nothing to verify and said so, by exiting with
 *     `SKIP_EXIT_CODE` (see `./exit-codes.mjs`). Skipped suites are reported on
 *     their own line and never folded into the pass count.
 *   - **fail** — any other non-zero exit, or a signal.
 *
 * A suite that skips is not a failure, so it does not fail the run. But it is
 * also not evidence, so it must not be counted as one. The summary below is
 * the only place that distinction is visible to a human, so it is made
 * explicit there.
 *
 * ## Suites that can skip
 *
 * These depend on the machine, not on the code, and skip on CI:
 *
 *   - `layout-parity` — needs a DSH installation to extract the host CSS.
 *   - `e2e-live`      — needs a signed-in MiMo desktop credential.
 *   - `boot-safety`   — needs a DSH profile with the plugin installed.
 *
 * Every one of them is therefore *not* covered by CI. See
 * `.github/workflows/ci.yml` for what does run there.
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKIP_EXIT_CODE } from './exit-codes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const filter = process.argv[2]

/**
 * Files in `tests/` that are infrastructure rather than suites, and so must
 * never be executed as one.
 */
const NON_SUITES = new Set(['run.mjs', 'exit-codes.mjs'])

const suites = readdirSync(here)
  .filter(f => f.endsWith('.mjs') && !NON_SUITES.has(f))
  .filter(f => filter === undefined || f.includes(filter))
  .sort()

if (suites.length === 0) {
  console.error(`没有匹配的测试套件${filter === undefined ? '' : `（过滤: ${filter}）`}`)
  process.exit(1)
}

/** @type {string[]} */
const passed = []
/** @type {string[]} */
const skipped = []
/** @type {Array<{suite: string, reason: string}>} */
const failures = []

for (const suite of suites) {
  process.stdout.write(`\n${'='.repeat(60)}\n${suite}\n${'='.repeat(60)}\n`)
  const result = spawnSync(process.execPath, [join(here, suite)], {
    stdio: 'inherit',
    cwd: join(here, '..'),
  })

  if (result.signal !== null) {
    failures.push({ suite, reason: `被信号终止: ${result.signal}` })
    continue
  }

  // A suite that could not run its checks reports SKIP_EXIT_CODE. Skip before
  // looking at exit 0, because a skip is a stronger statement than "exited 0".
  if (result.status === SKIP_EXIT_CODE) {
    skipped.push(suite)
    continue
  }

  if (result.status === 0) {
    passed.push(suite)
    continue
  }

  failures.push({ suite, reason: `退出码 ${result.status}` })
}

console.log(`\n${'='.repeat(60)}`)
// Report the three outcomes on their own lines. A combined "N passed" total
// that quietly includes suites which verified nothing is exactly the reporting
// failure this runner exists to avoid.
console.log(`${passed.length} 个套件通过`)
console.log(`${skipped.length} 个套件跳过（本机无可验证对象，不计入通过）`)
console.log(`${failures.length} 个套件失败`)

if (skipped.length > 0) {
  console.log('\n跳过的套件（未被验证）:')
  for (const s of skipped) console.log(`  ${s}`)
}
if (failures.length > 0) {
  console.log('\n失败的套件:')
  for (const f of failures) console.log(`  ${f.suite}（${f.reason}）`)
}

if (passed.length === 0 && failures.length === 0) {
  console.log('\n警告：没有任何套件真正执行了检查。')
}

process.exitCode = failures.length === 0 ? 0 : 1
