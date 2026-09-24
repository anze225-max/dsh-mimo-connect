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
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const filter = process.argv[2]

const suites = readdirSync(here)
  .filter(f => f.endsWith('.mjs') && f !== 'run.mjs')
  .filter(f => filter === undefined || f.includes(filter))
  .sort()

if (suites.length === 0) {
  console.error(`没有匹配的测试套件${filter === undefined ? '' : `（过滤: ${filter}）`}`)
  process.exit(1)
}

let passed = 0
let failed = 0
const failures = []

for (const suite of suites) {
  process.stdout.write(`\n${'='.repeat(60)}\n${suite}\n${'='.repeat(60)}\n`)
  const result = spawnSync(process.execPath, [join(here, suite)], {
    stdio: 'inherit',
    cwd: join(here, '..'),
  })
  if (result.status === 0) passed++
  else {
    failed++
    failures.push(suite)
  }
  if (result.signal !== null) {
    console.error(`\n${suite} 被信号终止: ${result.signal}`)
  }
}

console.log(`\n${'='.repeat(60)}`)
console.log(`${passed} 个套件通过, ${failed} 个失败`)
if (failures.length > 0) {
  console.log('\n失败的套件:')
  for (const f of failures) console.log(`  ${f}`)
}
process.exitCode = failed === 0 ? 0 : 1
