/**
 * FAITHFUL.474 — drop 2 main.ts orphan helpers.
 *
 *  Continuing the FAITHFUL.468-473 orphan-helper audit, now in
 *  main.ts:
 *
 *  - `cycleTarget()` — was an unused Tab-cycle-target helper. Retail
 *    AC's Tab is Enter/Exit Chat Mode (BUG.tab-toggles-combat); Home selects the
 *    last attacker (FAITHFUL.382); mouse-click handles discrete
 *    target selection. No keybind for target-cycling exists or
 *    should exist per the retail layout.
 *
 *  - `detachAllWieldedFromPlayer()` — was an unused mass-detach
 *    helper. Wielded items detach per-item via the FAITHFUL.276
 *    ObjectDelete path. No call site for the "detach everything"
 *    flow currently exists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('FAITHFUL.474 — main.ts orphans removed', () => {
  it('cycleTarget function definition is gone', () => {
    expect(MAIN).not.toMatch(/function cycleTarget\(\): void \{/);
  });

  it('detachAllWieldedFromPlayer function definition is gone', () => {
    expect(MAIN).not.toMatch(/function detachAllWieldedFromPlayer\(\): void \{/);
  });

  it('cites FAITHFUL.474', () => {
    expect(MAIN).toMatch(/FAITHFUL\.474/);
  });
});
