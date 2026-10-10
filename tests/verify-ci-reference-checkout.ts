/**
 * DEBT.test-harness-hygiene — reference/ACE-dependent suites must never pass
 * vacuously on CI.
 *
 * ~100 test files gate on `describe.skipIf(!existsSync(<reference/ACE path>))`
 * or early-return when the ACE tree is absent. That is right for a contributor
 * without the clone, but CI ALWAYS clones reference/ACE (.github/workflows/
 * ci.yml "Clone ACE reference (pinned)"), so on CI a missing tree — or a test
 * pointing at a path that no longer exists — means those suites silently skip
 * while the run stays green. This file fails loudly instead:
 *   1. on CI, the pinned ACE tree must be present;
 *   2. wherever the tree is present, every literal reference/ACE path a test
 *      names must exist (a stale path would otherwise skip its suite forever).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ON_CI, aceReferenceExists } from './_harness/reference.js';

const REPO = resolve(__dirname, '..');
const ACE_SOURCE = join(REPO, 'reference/ACE/Source');

describe('reference/ACE checkout (CI clones it — a missing tree must fail, not skip)', () => {
  it.runIf(ON_CI)('CI has the pinned ACE source tree', () => {
    for (const sub of ['ACE.Server', 'ACE.Entity/Enum', 'ACE.DatLoader']) {
      expect(existsSync(join(ACE_SOURCE, sub)), `reference/ACE/Source/${sub}`).toBe(true);
    }
  });

  it('aceReferenceExists throws for a missing path only on CI', () => {
    const bogus = join(ACE_SOURCE, '__definitely_missing__.cs');
    if (ON_CI) expect(() => aceReferenceExists(bogus)).toThrow(/reference\/ACE input missing on CI/);
    else expect(aceReferenceExists(bogus)).toBe(false);
  });
});

describe.skipIf(!existsSync(ACE_SOURCE) && !ON_CI)('every literal reference/ACE path named by a test exists', () => {
  it('no test gates on a stale reference/ACE path', () => {
    const tests = readdirSync(__dirname).filter(f => f.endsWith('.ts'));
    const missing: string[] = [];
    let checked = 0;
    for (const f of tests) {
      const src = readFileSync(join(__dirname, f), 'utf-8');
      // Only whole path literals — citations like 'Foo.cs:120-130' and globs are prose.
      for (const m of src.matchAll(/['"`](reference\/ACE\/[\w./-]+)['"`]/g)) {
        checked++;
        if (!existsSync(join(REPO, m[1]))) missing.push(`${f}: ${m[1]}`);
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });
});
