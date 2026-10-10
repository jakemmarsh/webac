/**
 * Evaluate .github/workflows/ci.yml `on.<event>.paths` filters with GitHub's
 * documented semantics (OPS.ci-and-hooks-gaps, 2026-09-26), so the filter set
 * can be checked (tests/verify-ci-path-filters.ts) or a commit simulated
 * ("would this push run CI?") without pushing:
 *
 *   - a changed file counts when the LAST pattern it matches is positive
 *     (a `!` pattern excludes, a later positive one re-includes);
 *   - `**` spans directory separators, a `**\/` segment may match zero
 *     directories, `*` stays inside one segment, `?` is one character;
 *   - a push runs CI when ANY of its changed files counts.
 *
 *   node tools/ci-path-filter-lib.mjs <file>...   # prints run / skip
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CI_YML = resolve(REPO, '.github', 'workflows', 'ci.yml');

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** `paths` semantics: the file triggers iff the last matching pattern is positive. */
export function fileTriggers(patterns, file) {
  let hit = false;
  for (const p of patterns) {
    const neg = p.startsWith('!');
    if (globToRegExp(neg ? p.slice(1) : p).test(file)) hit = !neg;
  }
  return hit;
}

export function pushTriggers(patterns, files) {
  return files.some((f) => fileTriggers(patterns, f));
}

/**
 * The `paths:` list under `on.<event>` in the workflow text. A small
 * line parser for this file's layout (two-space `on:` events, four-space
 * keys, six-space `- '<glob>'` items); no YAML dependency in the repo.
 * Returns null when the event has no `paths:` key.
 */
export function pathsFor(yml, event) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l === `  ${event}:`);
  if (start < 0) return null;
  let out = null;
  let inPaths = false;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^ {2}\S/.test(l) || /^\S/.test(l)) break; // next event / top-level key
    if (/^ {4}paths:\s*$/.test(l)) { inPaths = true; out = []; continue; }
    if (/^ {4}\S/.test(l)) { inPaths = false; continue; }
    const m = /^ {6}- '(.*)'\s*$/.exec(l);
    if (inPaths && m) out.push(m[1]);
  }
  return out;
}

/** { yml, push, pull_request } read from the committed workflow. */
export function loadCiFilters(file = CI_YML) {
  const yml = readFileSync(file, 'utf8');
  return { yml, push: pathsFor(yml, 'push'), pull_request: pathsFor(yml, 'pull_request') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  const { push } = loadCiFilters();
  if (!push) { console.error('ci.yml: no on.push.paths list'); process.exit(2); }
  for (const f of files) console.log(`${fileTriggers(push, f) ? 'run ' : 'skip'}  ${f}`);
  console.log(pushTriggers(push, files) ? 'CI would RUN for this push' : 'CI would be SKIPPED for this push');
}
