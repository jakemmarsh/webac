/**
 * FAITHFUL.498 — `/squelch list` preserves original proper-noun case.
 *
 *  Pre-fix `squelchedNames` was a `Set<string>` keyed by lowercase, so
 *  every list-output rendered names lowercased ("Squelched: bob, frith")
 *  instead of the proper-noun case retail used ("Squelched: Bob, Frith").
 *
 *  Fix: switch to `Map<lowercaseKey, originalCase>`. `.has(lowercase)`
 *  lookups still match case-insensitively for the hot path (every
 *  incoming chat line); the Map's values are the first-seen casing used
 *  only when rendering `/squelch list`.
 *
 *  Also covers the SetSquelchDB login-restore path — server-truth names
 *  must preserve their stored case when seeded back into the local map.
 *
 *  BUG.squelch-mask-per-channel-discarded — onSetSquelchDB now iterates
 *  `data.entries` ({name, mask}[]) instead of `data.names` (string[]), and
 *  passes each entry's mask through as SquelchState.set()'s third arg.
 *
 *  BUG.squelch-db-snapshot-treated-as-merge — onSetSquelchDB now calls
 *  SquelchState.replaceAll(data.entries) (full-snapshot semantics) instead
 *  of per-entry .set() calls (additive-merge semantics). The actual
 *  replace-vs-merge behavior is covered behaviorally by
 *  verify-set-squelch-db.ts's "SquelchState.replaceAll" describe block —
 *  main.ts itself isn't unit-callable (a single main() that boots the
 *  whole app on import), so this file's assertions stay wiring pins that
 *  just confirm the call site exists, per this file's established pattern.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('FAITHFUL.498 — squelchedNames uses Map<lowercase, originalCase>', () => {
  it('declares SquelchState (Map<lowercase, originalCase>-shaped), not Set<string>', () => {
    // BUG.squelch-list-stale-char-switch — squelchedNames is now a
    // SquelchState instance (packages/renderer/src/session/SquelchState.ts)
    // wrapping the exact same Map<lowercaseKey, originalCase> semantics
    // this test covers, plus a clear() teardownWorldState calls on
    // logoff/character-switch; see verify-squelch-state-clear.ts for the
    // behavioral coverage of that class.
    expect(MAIN).toMatch(/squelchedNames = new SquelchState\(\)/);
    // Ensure the old Set declaration is gone.
    expect(MAIN).not.toMatch(/squelchedNames = new Set<string>\(\)/);
  });

  it('onSetSquelchDB seeds server-truth names via full-replace (not additive .set())', () => {
    expect(MAIN).toMatch(/squelchedNames\.replaceAll\(data\.entries\)/);
    // The old per-entry additive-merge call must be gone.
    expect(MAIN).not.toMatch(/squelchedNames\.set\(entry\.name\.toLowerCase\(\), entry\.name, entry\.mask\)/);
  });

  it('chat-line filter lookups still use lowercase keys (case-insensitive match)', () => {
    expect(MAIN).toMatch(/squelchedNames\.has\(data\.senderName\.toLowerCase\(\)\)/);
  });

  it('cites FAITHFUL.498', () => {
    expect(MAIN).toMatch(/FAITHFUL\.498/);
  });
});
