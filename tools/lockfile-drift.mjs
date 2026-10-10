#!/usr/bin/env node
/**
 * Lockfile drift check for tools/ci-local.sh (OPS.ci-and-hooks-gaps).
 *
 * CI runs `npm ci` from package-lock.json; ci-local.sh reuses this machine's
 * node_modules. When the lockfile moved (a pulled dependency bump) but
 * `npm install` was not re-run, the local gate tests a different dependency
 * tree than CI will. npm records what is actually installed in the hidden
 * lockfile node_modules/.package-lock.json, keyed the same way as
 * package-lock.json's `packages`, so the two can be compared directly:
 *
 *   - a lockfile entry missing from the install is drift, unless it is
 *     `optional` (platform binaries such as @esbuild/linux-x64 are never
 *     installed on a Mac: 71 such entries on 2026-09-26, all legitimate);
 *   - a version / resolved / link mismatch is drift;
 *   - an installed entry the lockfile no longer lists is drift (extraneous).
 *
 *   node tools/lockfile-drift.mjs [lockfile] [hidden-lockfile]
 *     exit 0 = in sync, 1 = drift (first differences printed), 2 = can't tell
 *     (no hidden lockfile: node_modules missing or installed by an old npm).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Differences between package-lock.json and the installed hidden lockfile, as strings. */
export function lockfileDrift(lock, hidden) {
  const want = lock.packages ?? {};
  const have = hidden.packages ?? {};
  const out = [];
  for (const [k, v] of Object.entries(want)) {
    if (k === '') continue; // the root project itself is never in the hidden lockfile
    const h = have[k];
    if (!h) { if (!v.optional) out.push(`missing ${k}@${v.version ?? v.resolved ?? '?'}`); continue; }
    for (const f of ['version', 'resolved', 'link']) {
      if ((v[f] ?? null) !== (h[f] ?? null)) { out.push(`${k}: ${f} ${h[f] ?? '(none)'} installed, lockfile wants ${v[f] ?? '(none)'}`); break; }
    }
  }
  for (const k of Object.keys(have)) if (!(k in want)) out.push(`extraneous ${k}@${have[k].version ?? '?'}`);
  return out;
}

function main([lockPath = 'package-lock.json', hiddenPath = 'node_modules/.package-lock.json']) {
  if (!existsSync(hiddenPath)) { console.log(`lockfile-drift: no ${hiddenPath} — cannot compare`); process.exit(2); }
  const drift = lockfileDrift(JSON.parse(readFileSync(lockPath, 'utf8')), JSON.parse(readFileSync(hiddenPath, 'utf8')));
  if (!drift.length) { console.log('lockfile-drift: node_modules matches package-lock.json'); return; }
  console.log(`lockfile-drift: ${drift.length} difference(s) between package-lock.json and node_modules:`);
  for (const d of drift.slice(0, 10)) console.log(`  ${d}`);
  if (drift.length > 10) console.log(`  ... and ${drift.length - 10} more`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
