/**
 * FAITHFUL.350 — MagicPurgeBadEnchantments dispatches separately from
 *  MagicPurgeEnchantments and removes only negative enchantments.
 *
 * ACE has two distinct purge events:
 *   - `GameEventMagicPurgeEnchantments.cs:7-10` (0x02C6) — "Silently
 *     remove all enchantments from your character, e.g. when you die"
 *   - `GameEventMagicPurgeBadEnchantments.cs:7-10` (0x0312) — "Silently
 *     remove all negative enchantments from a player"
 *
 * Pre-FAITHFUL.350 the dispatcher routed BOTH events to the same
 * `onMagicPurgeEnchantments` handler which calls `gameUI.clearEnchantments`
 * (wipes ALL). Any GM-issued "purge debuffs" command, a Cleric NPC's
 * scripted debuff-cleanse, or a quest scripted event firing the
 * BadEnchantments variant would incorrectly nuke beneficial buffs too.
 *
 * Fix: distinct handler + new `gameUI.clearBadEnchantments()` that
 * filters on `!isBeneficial && !isVitae && !isCooldown`.
 *
 * GAP.86 (2026-07-23) — converted from source-text regex pins to
 * behavioral tests:
 *   - ServerMessageHandler dispatch distinctness is exercised with real
 *     wire bytes (mirroring the existing coverage in
 *     verify-enchantment-lifecycle-wireformat.ts, extended here with the
 *     reverse direction: the ALL-purge event must not also fire the Bad
 *     handler).
 *   - GameUI.clearBadEnchantments is exercised against a REAL GameUI
 *     instance (happy-dom, per verify-gameui-dom-smoke.ts) with a mixed
 *     set of beneficial/vitae/cooldown/harmful enchantments added via the
 *     real addEnchantment() API, then asserts on the real resulting
 *     internal state — not a regex match on the method's source text.
 * main.ts's own wiring (which of clearEnchantments/clearBadEnchantments
 * each handler calls) can't be driven behaviorally without importing the
 * whole app (see verify-gameui-dom-smoke.ts's docblock on why main.ts is
 * never imported in this suite), so that one fact stays a narrow citation
 * check below.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameMessageOpcode, GameEventType } from '@ac/network';

const REPO = resolve(__dirname, '..');

function event(eventType: number, payload: Uint8Array) {
  return {
    type: 'event' as const,
    opcode: GameMessageOpcode.GameEvent as GameMessageOpcode.GameEvent,
    objectGuid: 0,
    sequence: 1,
    eventType,
    payload,
  };
}

describe('ServerMessageHandler dispatches the two purge events distinctly (FAITHFUL.350)', () => {
  it('MagicPurgeEnchantments fires onMagicPurgeEnchantments only (not the Bad variant)', () => {
    const h = new ServerMessageHandler();
    let purgeAll = false;
    let purgeBad = false;
    h.setHandlers({
      onMagicPurgeEnchantments: () => { purgeAll = true; },
      onMagicPurgeBadEnchantments: () => { purgeBad = true; },
    });

    h.handleMessage(event(GameEventType.MagicPurgeEnchantments, new Uint8Array(0)));

    expect(purgeAll).toBe(true);
    expect(purgeBad).toBe(false);
  });

  it('MagicPurgeBadEnchantments fires onMagicPurgeBadEnchantments only (not the all-purge variant)', () => {
    const h = new ServerMessageHandler();
    let purgeAll = false;
    let purgeBad = false;
    h.setHandlers({
      onMagicPurgeEnchantments: () => { purgeAll = true; },
      onMagicPurgeBadEnchantments: () => { purgeBad = true; },
    });

    h.handleMessage(event(GameEventType.MagicPurgeBadEnchantments, new Uint8Array(0)));

    expect(purgeBad).toBe(true);
    expect(purgeAll).toBe(false);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI.clearBadEnchantments removes only harmful enchantments (requires happy-dom devDep)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('keeps beneficial, vitae, and cooldown entries; removes only the harmful ones', () => {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui: any = new GameUICtor(container);

    ui.addEnchantment({
      spellId: 1, layer: 1, name: 'Strength Other I', iconId: 0x06001000,
      isBeneficial: true, isVitae: false, isCooldown: false, duration: 60, startTime: 0,
    });
    ui.addEnchantment({
      spellId: 2, layer: 1, name: 'Vitae', iconId: 0x06001001,
      isBeneficial: false, isVitae: true, isCooldown: false, duration: -1, startTime: 0,
    });
    ui.addEnchantment({
      spellId: 3, layer: 1, name: 'Spell Recharge', iconId: 0x06001002,
      isBeneficial: false, isVitae: false, isCooldown: true, duration: 5, startTime: 0,
    });
    ui.addEnchantment({
      spellId: 4, layer: 1, name: 'Blood Loather', iconId: 0x06001003,
      isBeneficial: false, isVitae: false, isCooldown: false, duration: 30, startTime: 0,
    });
    ui.addEnchantment({
      spellId: 5, layer: 2, name: 'Nether Prot Weakness', iconId: 0x06001004,
      isBeneficial: false, isVitae: false, isCooldown: false, duration: 30, startTime: 0,
    });

    expect(ui.activeEnchantments.size).toBe(5);

    ui.clearBadEnchantments();

    const remaining = Array.from((ui.activeEnchantments as Map<string, { spellId: number }>).values())
      .map(e => e.spellId)
      .sort();
    expect(remaining).toEqual([1, 2, 3]);
  });

  it('purgeEnchantments (death purge) removes buffs AND debuffs but keeps vitae + cooldowns (CORE.5.b.a)', () => {
    // ACE RemoveAllEnchantments: "Removes all enchantments except for
    // vitae and item spells"; retail CEnchantmentRegistry::PurgeEnchantments
    // @ 00594de0 purges only mult_list + add_list — vitae slot + cooldown
    // list survive.
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui: any = new GameUICtor(container);

    ui.addEnchantment({
      spellId: 1, layer: 1, name: 'Strength Other I', iconId: 0x06001000,
      isBeneficial: true, isVitae: false, isCooldown: false, duration: 60, startTime: 0,
    });
    ui.addEnchantment({
      spellId: 666, layer: 1, name: 'Vitae', iconId: 0x06001001,
      isBeneficial: false, isVitae: true, isCooldown: false, duration: -1, startTime: 0,
    });
    ui.addEnchantment({
      spellId: 3, layer: 1, name: 'Spell Recharge', iconId: 0x06001002,
      isBeneficial: false, isVitae: false, isCooldown: true, duration: 5, startTime: 0,
    });
    ui.addEnchantment({
      spellId: 4, layer: 1, name: 'Blood Loather', iconId: 0x06001003,
      isBeneficial: false, isVitae: false, isCooldown: false, duration: 30, startTime: 0,
    });

    ui.purgeEnchantments();

    const remaining = Array.from((ui.activeEnchantments as Map<string, { spellId: number }>).values())
      .map(e => e.spellId)
      .sort((a: number, b: number) => a - b);
    expect(remaining).toEqual([3, 666]);
  });

  it('is a no-op when only beneficial/vitae/cooldown entries are active', () => {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui: any = new GameUICtor(container);

    ui.addEnchantment({
      spellId: 10, layer: 1, name: 'Armor Other I', iconId: 0x06001005,
      isBeneficial: true, isVitae: false, isCooldown: false, duration: 60, startTime: 0,
    });

    ui.clearBadEnchantments();

    expect(ui.activeEnchantments.size).toBe(1);
  });
});

describe('main.ts wiring — narrowly-scoped citation', () => {
  // main.ts has WebSocket/game-loop side effects at module scope and is
  // never imported in this test tree (see verify-gameui-dom-smoke.ts);
  // the *behavior* of clearBadEnchantments and the dispatcher's
  // distinctness are both proven above against the real classes. This
  // check is scoped to the one fact that can't be driven behaviorally
  // without importing the whole app: which GameUI method each handler
  // calls.
  const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

  it('onMagicPurgeBadEnchantments calls gameUI.clearBadEnchantments (not the all-clear variant)', () => {
    const block = MAIN.match(/onMagicPurgeBadEnchantments:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toContain('gameUI.clearBadEnchantments()');
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('gameUI.clearEnchantments()');
    expect(code).not.toContain('vitae.setVitaePenalty');
  });

  it('onMagicPurgeEnchantments calls gameUI.purgeEnchantments (spares vitae + cooldowns — CORE.5.b.a)', () => {
    const block = MAIN.match(/onMagicPurgeEnchantments:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toContain('gameUI.purgeEnchantments()');
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('gameUI.clearEnchantments()');
    expect(code).not.toContain('vitae.setVitaePenalty');
  });
});
