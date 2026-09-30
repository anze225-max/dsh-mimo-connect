#!/usr/bin/env node
/**
 * Installer-gate replica: prove this package's peer ranges admit the running dsh.
 *
 * dsh-app-boot evaluates plugin compatibility before installing or booting a
 * bundle (`lib/index.js` → `evaluatePluginCompatibility`):
 *
 *   - only peer names equal to `@deepseek-ai/dsh` or starting with
 *     `@deepseek-ai/dsh-` are examined; every other peer is ignored;
 *   - each range is tested with
 *     `semver.satisfies(dshRuntimeVersion, range, { includePrerelease: true })`
 *     against the RUNNING dsh version — not the version of that package
 *     installed locally;
 *   - `workspace:^` / `workspace:~` / `workspace:*` mean "the current runtime";
 *   - any mismatch refuses the install and, for a bundle already present,
 *     refuses profile startup.
 *
 * This script reproduces that evaluation so a version bump can be checked
 * offline. It needs a semver implementation; it prefers a local install and
 * falls back to a vendored copy if one is present.
 *
 * Usage:
 *   node tools/check-compat.mjs [package.json] [runtimeVersion]
 *   node tools/check-compat.mjs package.json 0.2.0-rc.2
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const manifestPath = process.argv[2] ?? join(root, 'package.json');
const runtimeArg = process.argv[3];

/** Load semver from the nearest install, then from any vendored copy. */
async function loadSemver() {
  const candidates = [
    'semver',                                   // normal resolution from cwd
    join(root, 'node_modules', 'semver', 'index.js'),
    join(root, 'semver-lib', 'index.js'),       // vendored fallback
  ];
  for (const spec of candidates) {
    try {
      if (spec.startsWith('/') || /^[A-Za-z]:/.test(spec)) {
        if (!existsSync(spec)) continue;
        const mod = await import(pathToFileURL(spec).href);
        return mod.default ?? mod;
      }
      const mod = await import(spec);
      return mod.default ?? mod;
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

const semver = await loadSemver();
if (semver === undefined) {
  console.error('check-compat: semver is not available.');
  console.error('  install it (npm i --no-save semver) or drop a copy into semver-lib/');
  process.exit(2);
}

if (!existsSync(manifestPath)) {
  console.error(`check-compat: manifest not found: ${manifestPath}`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));

/**
 * The runtime version to test against. Defaults to this package's own version
 * when it looks like a dsh runtime, else the newest dsh peer floor.
 */
function defaultRuntime() {
  const declared = manifest.dsh?.runtime;
  if (typeof declared === 'string' && declared.length > 0) return declared;
  return undefined;
}
const runtime = runtimeArg ?? defaultRuntime();
if (runtime === undefined) {
  console.error('check-compat: no runtime version given.');
  console.error('  pass it explicitly, e.g. `node tools/check-compat.mjs package.json 0.2.0-rc.2`');
  process.exit(2);
}
if (semver.valid(runtime) === null) {
  console.error(`check-compat: invalid semantic version: ${runtime}`);
  process.exit(2);
}

const peers = manifest.peerDependencies ?? {};
const gated = [];
for (const [name, range] of Object.entries(peers)) {
  if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
  gated.push([name, range]);
}

console.log(`manifest : ${manifestPath}`);
console.log(`plugin   : ${manifest.name}@${manifest.version}`);
console.log(`runtime  : dsh ${runtime}`);
console.log('');

if (gated.length === 0) {
  console.log('no @deepseek-ai/dsh* peerDependencies — nothing for the installer to refuse.');
  process.exit(0);
}

const failed = [];
console.log('peerDependencies gated by the installer:');
for (const [name, range] of gated) {
  const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtime : range;
  const ok = requirement.trim() !== '' && semver.satisfies(runtime, requirement, { includePrerelease: true });
  if (!ok) failed.push([name, range]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${range}`);
}

for (const [name, range] of Object.entries(peers)) {
  if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) continue;
  console.log(`  (not gated) ${name} ${range}`);
}

console.log('');
if (failed.length === 0) {
  console.log(`VERDICT: ACCEPTED — dsh ${runtime} is admitted by every gated peer range.`);
  process.exit(0);
}
console.log(`VERDICT: REJECTED — dsh ${runtime} would be refused (incompatible-version):`);
for (const [name, range] of failed) console.log(`  ${name}: ${range}`);
console.log('');
console.log('Add the runtime to each failing range, e.g. append `|| ^0.2.0-rc.2`.');
console.log('Note: with includePrerelease, a caret range matches only its own');
console.log('[major, minor, patch] tuple — `^0.2.0-rc.2` does not admit `0.2.1-rc.1`.');
process.exit(1);
