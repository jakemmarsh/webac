/**
 * ASSESS: meta-test enforcing the 2026-06-10 "no new source-grep tests" rule
 * (CLAUDE.md "Never Break Tests"; docs/fresh-eyes-assessment-2026-06-10.md §tests).
 *
 * Background: 304+/543 test files imported nothing from packages/ and only
 * regex-matched source text read via readFileSync — a deliberate GameUI
 * display regression passed all 10,252 tests because nothing executed the
 * shipped code. New tests must import the real module and assert behavior
 * (or drive real parsers with hand-built bytes).
 *
 * What counts as a violation (deliberately conservative to avoid false
 * positives — only packages/**\/*.ts source reads count):
 *   1. fs read + a string literal pointing at packages/…/*.ts(x)
 *      (e.g. resolve(REPO, 'packages/renderer/src/main.ts')).
 *   2. fs read + a literal referencing packages (incl. join-style split
 *      segments: join(REPO, 'packages', 'renderer', 'src') + 'main.ts')
 *      + a literal ending in .ts/.tsx.
 *   3. fs dir-scan (readdirSync) under packages/ with zero imports from
 *      packages (no @ac/* or ../packages/* import specifiers).
 *
 * Explicitly FINE (not flagged): reading reference/ACE *.cs for parity
 * tests, reading JSON fixtures, reading dat/ binaries, reading tests/ files.
 *
 * Ratchet mechanics: tests/source-grep-baseline.json holds the grandfathered
 * offender list. This test FAILS if
 *   (a) a file NOT in the baseline violates (new source-grep test), or
 *   (b) a baseline entry no longer violates (it was fixed or deleted —
 *       remove it from the baseline so it can never regress).
 * To regenerate after legitimately fixing offenders:
 *   REGEN_SOURCE_GREP_BASELINE=1 npx vitest run tests/verify-test-suite-hygiene.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TESTS_DIR = resolve(__dirname);
const BASELINE_PATH = join(TESTS_DIR, 'source-grep-baseline.json');
// Self-exclusion: this file's own error messages/regexes mention packages/
// paths, and it legitimately fs-reads every tests/*.ts file.
const SELF = 'verify-test-suite-hygiene.ts';

/* ------------------------------------------------------------------ */
/*  Lightweight TS scanner: strip comments, collect string literals    */
/* ------------------------------------------------------------------ */

interface ScanResult {
  /** Source with comments removed and string contents replaced by 'STR'. */
  code: string;
  /** Contents of every '…' / "…" / `…` literal (template exprs elided). */
  strings: string[];
}

function scanSource(src: string): ScanResult {
  const strings: string[] = [];
  let code = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      let s = '';
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { s += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          // Template expression — skip to the matching brace (shallow nesting
          // is enough here; we only need the literal text segments).
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
          }
          continue;
        }
        s += src[i];
        i++;
      }
      i++; // closing quote
      strings.push(s);
      code += quote + 'STR' + quote;
      continue;
    }
    code += c;
    i++;
  }
  return { code, strings };
}

/** Module specifiers from import/export-from/dynamic-import/require. */
function importSpecifiers(src: string): Set<string> {
  const specs = new Set<string>();
  const re = /(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const s = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (s) specs.add(s);
  }
  return specs;
}

/** Returns a violation reason, or null when the file is clean. */
export function classifyTestFile(src: string): string | null {
  const { code, strings } = scanSource(src);
  const specs = importSpecifiers(src);
  const hasFsRead = /\breadFileSync\s*\(|\breadFile\s*\(/.test(code);
  if (!hasFsRead) return null;
  // Import specifiers also appear in `strings`; exclude them so a file that
  // properly imports '../packages/…/Foo.js' isn't penalized for the import.
  const lits = strings.filter(s => !specs.has(s));
  const packagesTs = lits.find(s => s.includes('packages/') && /\.tsx?$/.test(s));
  if (packagesTs !== undefined) {
    return `fs-reads ${packagesTs}`;
  }
  const hasPackagesRef = lits.some(s => s.includes('packages/') || s === 'packages');
  const tsLit = lits.find(s => /\.tsx?$/.test(s));
  if (hasPackagesRef && tsLit !== undefined) {
    return `fs-reads a packages/ path joined with '${tsLit}'`;
  }
  const importsPackages = [...specs].some(s => s.startsWith('@ac/') || /(^|\/)packages\//.test(s));
  if (!importsPackages && hasPackagesRef && /\breaddirSync\s*\(/.test(code)) {
    return 'dir-scans packages/ sources with zero imports from packages';
  }
  return null;
}

function currentOffenders(): Map<string, string> {
  const offenders = new Map<string, string>();
  const files = readdirSync(TESTS_DIR).filter(f => f.endsWith('.ts') && f !== SELF).sort();
  for (const f of files) {
    const reason = classifyTestFile(readFileSync(join(TESTS_DIR, f), 'utf-8'));
    if (reason !== null) offenders.set(f, reason);
  }
  return offenders;
}

interface Baseline {
  comment: string;
  files: string[];
}

const offenders = currentOffenders();

if (process.env.REGEN_SOURCE_GREP_BASELINE === '1') {
  const regenerated: Baseline = {
    comment: 'Grandfathered source-grep test files. Ratchet enforced by '
      + 'tests/verify-test-suite-hygiene.ts — entries may only be REMOVED '
      + '(when a test is rewritten to execute real code, delete its entry). '
      + 'Never add entries; new source-grep tests are banned (CLAUDE.md).',
    files: [...offenders.keys()].sort(),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(regenerated, null, 2) + '\n');
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Baseline;
const baselineSet = new Set(baseline.files);

describe('test-suite hygiene — source-grep ratchet', () => {
  it('baseline file is sorted and duplicate-free', () => {
    expect(baseline.files).toEqual([...new Set(baseline.files)].sort());
  });

  it('no NEW test file source-greps packages/**/*.ts', () => {
    const fresh = [...offenders.entries()]
      .filter(([f]) => !baselineSet.has(f))
      .map(([f, reason]) => `${f} — ${reason}`);
    expect(
      fresh,
      'New tests must EXECUTE the shipped code (import the real module and '
      + 'assert behavior, or drive the real parser/handler with hand-built '
      + 'bytes) — regex-matching packages/ source text is banned (CLAUDE.md '
      + '"Never Break Tests", 2026-06-10). If the logic lives inside an '
      + 'un-importable monolith (e.g. main.ts), extract it into a small '
      + 'importable module and have the monolith call it. Offending files:\n'
      + fresh.join('\n'),
    ).toEqual([]);
  });

  it('baseline only ratchets downward (stale entries must be removed)', () => {
    const stale = baseline.files.filter(f => !offenders.has(f));
    expect(
      stale,
      'These tests/source-grep-baseline.json entries no longer source-grep '
      + 'packages/ (rewritten or deleted) — delete the stale entries so the '
      + 'pattern can never creep back in. Or regenerate the baseline:\n'
      + '  REGEN_SOURCE_GREP_BASELINE=1 npx vitest run tests/verify-test-suite-hygiene.ts\n'
      + 'Stale entries:\n' + stale.join('\n'),
    ).toEqual([]);
  });

  /* Detector self-checks — synthetic sources prove each rule fires (and
   * doesn't fire) where intended, so a future refactor can't silently
   * neuter the ratchet. */
  it('detector flags direct packages .ts reads', () => {
    expect(classifyTestFile(
      `import { readFileSync } from 'node:fs';\n`
      + `const src = readFileSync('packages/renderer/src/main.ts', 'utf-8');\n`,
    )).toMatch(/main\.ts/);
  });

  it('detector flags join-style split-path packages .ts reads', () => {
    expect(classifyTestFile(
      `import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\n`
      + `const SRC = join(__dirname, '..', 'packages', 'renderer', 'src');\n`
      + `const src = readFileSync(join(SRC, 'main.ts'), 'utf8');\n`,
    )).toMatch(/main\.ts/);
  });

  it('detector flags zero-import dir scans over packages/', () => {
    expect(classifyTestFile(
      `import { readFileSync, readdirSync } from 'fs';\n`
      + `for (const f of readdirSync('packages/network/src')) {\n`
      + `  const src = readFileSync(f, 'utf8');\n}\n`,
    )).toMatch(/dir-scans/);
  });

  it('detector does NOT flag ACE .cs parity reads or fixture reads', () => {
    expect(classifyTestFile(
      `import { readFileSync } from 'node:fs';\n`
      + `import { RadarColor } from '../packages/shared/src/game-types.js';\n`
      + `const cs = readFileSync('reference/ACE/Source/ACE.Entity/Enum/RadarColor.cs', 'utf-8');\n`,
    )).toBeNull();
    expect(classifyTestFile(
      `import { readFileSync } from 'node:fs';\n`
      + `const fixture = JSON.parse(readFileSync('verification/texture-index.json', 'utf-8'));\n`,
    )).toBeNull();
  });

  it('detector does NOT flag tests with no fs reads at all', () => {
    expect(classifyTestFile(
      `import { GameUI } from '../packages/renderer/src/ui/GameUI.js';\n`
      + `// mentions packages/renderer/src/main.ts only in this comment\n`,
    )).toBeNull();
  });
});
