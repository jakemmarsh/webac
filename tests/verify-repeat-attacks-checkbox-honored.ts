/**
 * FAITHFUL.369 — "Repeat Attacks" combat-bar checkbox actually controls
 *  the swing chain.
 *
 * Retail HandleAttackDoneEvent @ 0056c500 keeps repeating only while
 * PlayerModule::AutoRepeatAttack is on; with it off every AttackDone ends
 * the chain and clears the meter. BUG.combat-attack-charge-build.b moved
 * the rule into AttackRequest.ts (attackDoneEndsChain + the controller),
 * so this file drives the real code instead of regex-matching main.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AttackRequestController, attackDoneEndsChain, type AttackRequestDeps } from '../packages/renderer/src/controllers/AttackRequest.js';

const REPO = resolve(__dirname, '..');
const UI = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf8');

function controller(repeat: boolean) {
  const state = { t: 10, sent: 0, bar: [] as number[] };
  const deps: AttackRequestDeps = {
    now: () => state.t,
    getTarget: () => 0x80000001,
    isAttackable: () => true,
    inReadyPosition: () => true,
    combatMode: () => 'melee',
    currentStyle: () => 0,
    sliderPower: () => 0.5,
    autoRepeat: () => repeat,
    sendAttack: () => { state.sent++; },
    setPowerBarLevel: (l) => state.bar.push(l),
    showError: () => {},
    sendCancelAttack: () => {},
    autoTarget: () => false,
    lastAttacker: () => 0,
    objectPresent: () => false,
    selectObject: () => {},
    selectNextCompassItem: () => {},
  };
  return { c: new AttackRequestController(deps), state };
}

describe('Repeat Attacks decides whether the chain survives AttackDone (FAITHFUL.369)', () => {
  it('attackDoneEndsChain: only code 0 with Repeat Attacks on keeps the chain', () => {
    expect(attackDoneEndsChain(0, true)).toBe(false);
    expect(attackDoneEndsChain(0, false)).toBe(true);
    expect(attackDoneEndsChain(0x36, true)).toBe(true);
    expect(attackDoneEndsChain(0x36, false)).toBe(true);
  });

  it('with the checkbox off, AttackDone clears the meter and no repeat builds', () => {
    const h = controller(false);
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.6; h.c.useTime();
    h.c.endAttackRequest();
    expect(h.state.sent).toBe(2); // the bar's 0.6, then the slider's 0.5 (EndAttackRequest)
    expect(h.c.repeatAttacking).toBe(false);
    h.c.handleAttackDone(0);
    expect(h.state.bar[h.state.bar.length - 1]).toBe(0);
    h.state.t += 1; h.c.useTime();
    expect(h.c.buildInProgress).toBe(false);
    expect(h.state.sent).toBe(2);
  });

  it('with the checkbox on, AttackDone(0) rebuilds the meter', () => {
    const h = controller(true);
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.6; h.c.useTime();
    h.c.endAttackRequest();
    h.c.handleAttackDone(0);
    expect(h.c.repeatAttacking).toBe(true);
    expect(h.c.buildInProgress).toBe(true);
  });
});

describe('GameUI exposes optionsSettings publicly for the consumer', () => {
  it('optionsSettings is declared public-read', () => {
    expect(UI).toMatch(/public optionsSettings:/);
  });

  it('cites FAITHFUL.369 in the access-modifier change docblock', () => {
    expect(UI).toMatch(/FAITHFUL\.369[\s\S]+?optionsSettings/);
  });
});
