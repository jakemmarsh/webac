/**
 * FAITHFUL.274 → CORE.5.b — the 'peace-war'/Status busy indicator was a
 * WRONG-PREMISE feature and is removed (correction recorded).
 *
 * FAITHFUL.274 invented a "busy state" indicator on classic statusbar
 * element 0x100000f5, driven by a once/sec setInterval in main.ts ORing
 * pendingCasts/meleeAttackPending/meleeApproachTarget. The decompiled EoL
 * client shows element 0x100000f5's registered element class is
 * gmUIElement_EffectsIndicator (RegisterElementClass(0x10000002, …) @
 * 004e6a30) with p268435468=1 — the BENEFICIAL-EFFECTS indicator — and no
 * retail indicator anywhere shows an outbound-busy state.
 *
 * This suite pins the removal so the invented feature cannot creep back:
 * no 'peace-war' indicator def in GameUI, no busy-interval driver in
 * main.ts. The element's real role is covered behaviorally in
 * tests/verify-vitae-indicator.ts (effects pair) and
 * tests/verify-enchantment-indicator-refactor.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN_TS = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');
const GAMEUI_TS = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf-8');

describe("CORE.5.b — 'peace-war' busy indicator removed (wrong premise)", () => {
  it('GameUI defines no peace-war indicator', () => {
    expect(GAMEUI_TS).not.toContain("id: 'peace-war'");
  });

  it('main.ts no longer drives a peace-war busy interval', () => {
    expect(MAIN_TS).not.toContain("setIndicatorActive('peace-war'");
  });

  it('element 0x100000f5 is wired as the beneficial-effects indicator instead', () => {
    expect(GAMEUI_TS).toMatch(/id: 'effects-beneficial', elementId: 0x100000f5/);
  });
});
