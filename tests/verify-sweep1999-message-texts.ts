/**
 * SWEEP1999.messages — the texts a 1999 world shows come from the 1999 client.exe, as era data in
 * eraClientRules(); end of retail and Dark Majesty keep theirs. Each case runs the shipped code.
 *
 * - HC-1 / HC-8: server text lines (0xF7E0). Every era: a type-0x1a line reaches the spew box
 *   (it showed nowhere). 1999: the raw 14-slot colour table, 0x1a and everything from 14 up a
 *   green chat line.
 * - HC-6 / VTE-2 / MAG-9: the 1999 failure switch (UI_HandleFailureEvent @ 0x004ccd10): only its
 *   codes, its wording; INV-3: 0xA0 skips the switch in 1999.
 * - HC-5 / CM-2: 1999 hit lines have no crit / conditions / body part and go on channel 6.
 * - HC-9: the encumbrance notice, every era (end of retail once per crossing, 1999 every 60 s).
 * - VTE-4 / INV-7 / INV-11: the 1999 UseObject (cases 0-4, the chat hint, the periods) and the
 *   placement / merge wording.
 * - PW-9: the 1999 delete prompt is a Yes / No question with no restore promise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { eraProfile, EOR_ERA_ID } from '../packages/renderer/src/era/EraProfiles.js';
import { eraClientRules, SERVER_TEXT_SLOTS_1999, type EraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import {
  addServerTextLine, attackerNotificationLine, defenderNotificationLine, evasionAttackerLine, evasionDefenderLine,
  addTextToScroll,
} from '../packages/renderer/src/ui/ServerMessageText.js';
import { deliverWeenieError } from '../packages/renderer/src/ui/WeenieErrorNotices.js';
import { FAILURE_EVENT_TEXT_1999 } from '../packages/renderer/src/ui/FailureEventText1999.js';
import { EncumbranceNotice, AC1999_ENCUMBRANCE_NOTICE, EOR_ENCUMBRANCE_NOTICE } from '../packages/renderer/src/ui/EncumbranceNotice.js';
import {
  decideUseObject, determineUseResult, AC1999_USE_OBJECT_RULES, EOR_USE_OBJECT_RULES, type UseSubject, type UseObjectContext,
} from '../packages/renderer/src/input/UseObject.js';
import { placementFullNotice, isItemLegalHead, type PlacementWorld, type PlacementObject } from '../packages/renderer/src/inventory/ItemHolderPlacement.js';
import { mergeAttemptRefusal } from '../packages/renderer/src/inventory/AttemptPlaceIn3D.js';
import { weenieErrorText, chatColorFor, ChatMessageType, DamageType, AttackConditions, DamageLocation } from '../packages/shared/src/index.js';

const AC1999 = eraClientRules(eraProfile('ac1999-retail'));
const EOR = eraClientRules(eraProfile(EOR_ERA_ID));
/** Dark Majesty: every classic profile runs the end-of-retail exe. */
const CLASSIC_IDS = ['classic-dereth', 'classic-dereth-1-0', 'classicace-customdm', 'classicace-infiltration'];
const LATER_ERAS: Array<[string, EraClientRules]> = [[EOR_ERA_ID, EOR], ...CLASSIC_IDS.map((id) => [id, eraClientRules(eraProfile(id))] as [string, EraClientRules]), ['none', eraClientRules(null)]];

interface Line { kind: 'spew' | 'chat'; text: string; color?: string; type?: number }
function surface(): { lines: Line[]; ui: { displayErrorText(t: string): void; addSystemMessage(t: string, c?: string, ty?: number): void } } {
  const lines: Line[] = [];
  return {
    lines,
    ui: {
      displayErrorText: (text) => { lines.push({ kind: 'spew', text }); },
      addSystemMessage: (text, color, type) => { lines.push({ kind: 'chat', text, color, type }); },
    },
  };
}

describe('HC-1 / HC-8: server text lines (0xF7E0)', () => {
  it('end of retail and Dark Majesty: a type-0x1a line goes to the spew box; other types keep their type and colour', () => {
    for (const [, rules] of LATER_ERAS) {
      expect(rules.serverTextSlots).toBeNull();
      const s = surface();
      addServerTextLine(s.ui, rules.serverTextSlots, 'Your movement disrupted spell casting!', 0x1a);
      addServerTextLine(s.ui, rules.serverTextSlots, 'You tell Bob, "hi"', ChatMessageType.OutgoingTell);
      addServerTextLine(s.ui, rules.serverTextSlots, 'Welcome', ChatMessageType.Broadcast);
      expect(s.lines).toEqual([
        { kind: 'spew', text: 'Your movement disrupted spell casting!' },
        { kind: 'chat', text: 'You tell Bob, "hi"', color: chatColorFor(ChatMessageType.OutgoingTell), type: ChatMessageType.OutgoingTell },
        { kind: 'chat', text: 'Welcome', color: '#80ff7f', type: 0 },
      ]);
    }
  });

  it('1999: the raw slot table; 0x1a and every channel from 14 up are a green type-0 chat line', () => {
    expect(AC1999.serverTextSlots).toBe(SERVER_TEXT_SLOTS_1999);
    const s = surface();
    for (const t of [0x1a, 0x0f, 0x11, 0x15, 0x16, 0x18, 0]) addServerTextLine(s.ui, AC1999.serverTextSlots, `t${t}`, t);
    for (const l of s.lines) expect(l).toMatchObject({ kind: 'chat', color: '#80ff7f', type: 0 });
    const r = surface();
    const expected: Record<number, string> = { 1: '#ffffff', 2: '#ffff3f', 3: '#d2d264', 4: '#ff7fff', 9: '#dca0a0', 13: '#3fffff', 6: '#ff3f3f', 7: '#3fbfff' };
    for (const [t, color] of Object.entries(expected)) addServerTextLine(r.ui, AC1999.serverTextSlots, 'x', Number(t));
    expect(r.lines.map((l) => [l.type, l.color])).toEqual(Object.entries(expected).map(([t, c]) => [Number(t), c]));
  });
});

describe('HC-6 / VTE-2 / MAG-9: the failure switch', () => {
  it('1999 prints only its own codes, in its wording; the rest print nothing', () => {
    expect(AC1999.failureEventText).toBe(FAILURE_EVENT_TEXT_1999);
    const s = surface();
    // Codes the AC1999 server sends that the 1999 client never printed.
    for (const code of [0x498 /* MOVED_TOO_FAR */, 0x4af, 0x4b2 /* chest / key */, 0x4fc /* HEAL_NOT_TRAINED */, 0x550, 0x4a1, 0x49e, 0x50f, 0x3a, 0x43]) {
      expect(deliverWeenieError(s.ui, code, weenieErrorText(code), AC1999.failureEventText).sink).toBe('none');
    }
    expect(s.lines).toEqual([]);
    deliverWeenieError(s.ui, 0x3e, weenieErrorText(0x3e), AC1999.failureEventText);
    deliverWeenieError(s.ui, 0x434, weenieErrorText(0x434), AC1999.failureEventText);
    deliverWeenieError(s.ui, 0x437, weenieErrorText(0x437), AC1999.failureEventText);
    deliverWeenieError(s.ui, 0x38, null, AC1999.failureEventText);
    deliverWeenieError(s.ui, 0x402, weenieErrorText(0x402), AC1999.failureEventText);
    deliverWeenieError(s.ui, 0x4a, weenieErrorText(0x4a), AC1999.failureEventText);
    expect(s.lines).toEqual([
      { kind: 'spew', text: 'You are too fatigued to attack!' },
      { kind: 'spew', text: 'Given that number of goods, you cannot craft anything.' },
      { kind: 'spew', text: 'Your craft goods are unsatisfactory.' },
      { kind: 'spew', text: 'Unable to move to object!' },
      { kind: 'chat', text: 'Your spell fizzled.', color: chatColorFor(7), type: 7 },
      { kind: 'chat', text: 'Ack! You killed yourself!', color: chatColorFor(0), type: 0 },
    ]);
  });

  it('end of retail and Dark Majesty keep end of retail\'s switch and wording', () => {
    for (const [, rules] of LATER_ERAS) {
      expect(rules.failureEventText).toBeNull();
      expect(rules.inventoryFailedRunsFailureEvent).toBe(true);
      const s = surface();
      deliverWeenieError(s.ui, 0x3e, weenieErrorText(0x3e), rules.failureEventText);
      deliverWeenieError(s.ui, 0x4b2, weenieErrorText(0x4b2), rules.failureEventText);
      expect(s.lines.map((l) => l.text)).toEqual([weenieErrorText(0x3e), weenieErrorText(0x4b2)]);
      expect(weenieErrorText(0x3e)).not.toBe('You are too fatigued to attack!');
    }
  });

  it('INV-3: 1999 runs no failure switch on 0xA0', () => {
    expect(AC1999.inventoryFailedRunsFailureEvent).toBe(false);
  });
});

describe('HC-5 / CM-2: combat hit lines', () => {
  const hit = { name: 'Drudge Skulker', damageType: DamageType.Bludgeon, severity: 0.3, damage: 12, critical: true, attackConditions: AttackConditions.SneakAttack, bodyPart: DamageLocation.UpperArm };
  it('1999: no crit / Sneak Attack prefix, no body part, all four on channel 6 (#ff3f3f)', () => {
    expect(AC1999.hitLineText).toBe('ac1999');
    const a = attackerNotificationLine(AC1999.hitLineText, hit);
    const d = defenderNotificationLine(AC1999.hitLineText, hit);
    expect(a.text).toMatch(/^You \w+ Drudge Skulker for 12 points of bludgeoning damage!$/);
    expect(d.text).toMatch(/^Drudge Skulker \w+ you for 12 points of bludgeoning damage!$/);
    const lines = [a, d, evasionAttackerLine('Drudge Skulker', AC1999.hitLineText), evasionDefenderLine('Drudge Skulker', AC1999.hitLineText)];
    for (const l of lines) expect(l.type).toBe(ChatMessageType.Combat);
    const s = surface();
    for (const l of lines) addTextToScroll(s.ui, l);
    for (const l of s.lines) expect(l.color).toBe('#ff3f3f');
  });
  it('end of retail and Dark Majesty: the prefixes, the body part and the CombatSelf / CombatEnemy types stay', () => {
    for (const [, rules] of LATER_ERAS) {
      expect(rules.hitLineText).toBe('eor');
      const a = attackerNotificationLine(rules.hitLineText, hit);
      const d = defenderNotificationLine(rules.hitLineText, hit);
      expect(a.text.startsWith('Critical hit!  Sneak Attack! You ')).toBe(true);
      expect(a.type).toBe(ChatMessageType.CombatSelf);
      expect(d.text).toContain('your upper arm');
      expect(d.type).toBe(ChatMessageType.CombatEnemy);
      expect(evasionAttackerLine('X', rules.hitLineText).type).toBe(ChatMessageType.CombatSelf);
      expect(evasionDefenderLine('X', rules.hitLineText).type).toBe(ChatMessageType.CombatEnemy);
    }
  });
});

describe('HC-9: the encumbrance notice', () => {
  it('end of retail (every later era): once per upward crossing, with "!"', () => {
    for (const [, rules] of LATER_ERAS) expect(rules.encumbranceNotice).toBe(EOR_ENCUMBRANCE_NOTICE);
    const shown: string[] = [];
    const n = new EncumbranceNotice(EOR_ENCUMBRANCE_NOTICE, (t) => shown.push(t));
    n.onLoad(0.5, 0); n.onLoad(1.2, 1); n.onLoad(1.5, 2); n.tick(500);
    n.onLoad(2.4, 3); n.onLoad(1.5, 4); n.onLoad(0.4, 5); n.onLoad(2.5, 6);
    expect(shown).toEqual(['You are encumbered!', 'You are severely encumbered!', 'You are severely encumbered!']);
  });
  it('1999: at once on crossing, then every 60 s while loaded, no "!"', () => {
    expect(AC1999.encumbranceNotice).toBe(AC1999_ENCUMBRANCE_NOTICE);
    const shown: Array<[number, string]> = [];
    let now = 1000;
    const n = new EncumbranceNotice(AC1999_ENCUMBRANCE_NOTICE, (t) => shown.push([now, t]));
    n.onLoad(0.5, now);
    now = 1001; n.onLoad(1.3, now);
    now = 1030; n.tick(now);
    now = 1061; n.tick(now);
    now = 1070; n.onLoad(2.2, now); // crossing 2: at once
    now = 1100; n.tick(now);
    now = 1130; n.tick(now);
    now = 1140; n.onLoad(0.9, now);
    now = 1300; n.tick(now);
    expect(shown).toEqual([
      [1001, 'You are encumbered'], [1061, 'You are encumbered'], [1070, 'You are severely encumbered'], [1130, 'You are severely encumbered'],
    ]);
  });
});

function subject(over: Partial<UseSubject>): UseSubject {
  return {
    guid: 0x50000002, name: 'Bob', containerId: 0, wielderId: 0, bitfield: 0, itemsCapacity: 0, containersCapacity: 0,
    itemType: 0x10, combatUse: 0, validLocations: 0, location: 0, useability: 0x1, ownedByPlayer: false, isPlayer: true, ...over,
  };
}
const useCtx = (over: Partial<UseObjectContext> = {}): UseObjectContext => ({
  playerGuid: 0x50000001, groundObject: 0, allowSelection: false, skipDetermine: false, selectedGuid: 0,
  attackable: false, peaceMode: true, confirmVolatileRare: false, selectionCompatible: false, ...over,
});

describe('VTE-4 / INV-7 / INV-11: UseObject', () => {
  it('1999: another player or an NPC that can\'t be used gets the chat hint; no trade case', () => {
    expect(AC1999.useObject).toBe(AC1999_USE_OBJECT_RULES);
    // bitfield 0x4 Stuck (a creature), 0x8 Player.
    const player = subject({ bitfield: 0x8 | 0x4 });
    expect(determineUseResult(player, useCtx(), AC1999.useObject)).toBe(0);
    expect(decideUseObject(player, useCtx(), AC1999.useObject)).toEqual({ kind: 'message', text: 'To chat, click in the chat box and type a message.' });
    const npc = subject({ isPlayer: false, name: 'Scribe', bitfield: 0x4 });
    expect(decideUseObject(npc, useCtx(), AC1999.useObject)).toEqual({ kind: 'message', text: 'To chat, click in the chat box and type a message.' });
    // An attackable monster in peace mode: the dove line, with 1999's period.
    expect(decideUseObject(subject({ isPlayer: false, name: 'Drudge', bitfield: 0x4 }), useCtx({ attackable: true }), AC1999.useObject))
      .toEqual({ kind: 'message', text: 'To attack Drudge, click on the dove icon first.' });
    // A door: 1999's period.
    expect(decideUseObject(subject({ isPlayer: false, itemType: 0x80, name: 'Door', bitfield: 0x1000 | 0x4 }), useCtx(), AC1999.useObject))
      .toEqual({ kind: 'message', text: "You can't open or close this Door that way." });
    // A WieldLeft caster we own: 1999 has no case 8, so it is a plain wield (3).
    const shield = subject({ isPlayer: false, itemType: 0x8000, name: 'Orb', ownedByPlayer: true, containerId: 0x50000001, bitfield: 0x40000000, useability: 0 });
    expect(determineUseResult(shield, useCtx(), AC1999.useObject)).toBe(3);
  });

  it('end of retail and Dark Majesty: the trade case (5), "The X cannot be used", no periods', () => {
    for (const [, rules] of LATER_ERAS) {
      expect(rules.useObject).toBe(EOR_USE_OBJECT_RULES);
      const player = subject({ bitfield: 0x8 | 0x4 });
      expect(decideUseObject(player, useCtx(), rules.useObject)).toEqual({ kind: 'usingItem', result: 5 });
      const npc = subject({ isPlayer: false, name: 'Scribe', bitfield: 0x4 });
      expect(decideUseObject(npc, useCtx(), rules.useObject)).toEqual({ kind: 'message', text: 'The Scribe cannot be used' });
      expect(decideUseObject(subject({ isPlayer: false, name: 'Drudge', bitfield: 0x4 }), useCtx({ attackable: true }), rules.useObject))
        .toEqual({ kind: 'message', text: 'To attack Drudge, click on the dove icon first' });
      const shield = subject({ isPlayer: false, itemType: 0x8000, name: 'Orb', ownedByPlayer: true, containerId: 0x50000001, bitfield: 0x40000000, useability: 0 });
      expect(determineUseResult(shield, useCtx(), rules.useObject)).toBe(8);
    }
  });

  it('INV-11: placement and merge refusals in each era\'s wording', () => {
    const holder = (isPlayer: boolean): PlacementObject => ({
      id: 1, name: isPlayer ? 'Bob' : 'Pack', weenieClassId: 0, stackSize: 0, maxStackSize: 0, itemsCapacity: 24, containersCapacity: 0,
      isContainer: true, holder: true, inTrade: false, isPlayer,
    });
    expect(placementFullNotice(holder(false), false, AC1999.placementText)).toBe('The Pack is full');
    expect(placementFullNotice(holder(true), false, AC1999.placementText)).toBe('Bob is full');
    expect(placementFullNotice(holder(true), true, AC1999.placementText)).toBe('Bob can carry no more containers');
    const w = (rules: EraClientRules): PlacementWorld => ({
      playerId: 0x50000001,
      object: (id) => (id === 7 ? { id: 7, name: 'Drudge', weenieClassId: 1, stackSize: 0, maxStackSize: 0, itemsCapacity: 0, containersCapacity: 0, isContainer: false, holder: false, inTrade: false, isPlayer: false, itemType: 0x10 } as PlacementObject : undefined),
      itemsOf: () => [], containersOf: () => [], splitSize: 1, maxSplitSize: 1, objectSplitSize: () => 1, dragSplit: () => ({ amount: 1, partial: false }),
      text: rules.placementText,
    });
    expect(isItemLegalHead(7, w(AC1999))).toBe("The creature can't be picked up");
    const a = { id: 1, inTrade: false, weenieClassId: 10, maxStackSize: 100 };
    expect(mergeAttemptRefusal(a, { id: 2, inTrade: false, weenieClassId: 11, stackSize: 5, maxStackSize: 100 }, AC1999.placementText)).toBe('Cannot Merge Different Stack Types.');
    expect(mergeAttemptRefusal(a, { id: 2, inTrade: false, weenieClassId: 10, stackSize: 100, maxStackSize: 100 }, AC1999.placementText)).toBe("This stack's too big to add to");
    for (const [, rules] of LATER_ERAS) {
      expect(placementFullNotice(holder(false), false, rules.placementText)).toBe('The Pack is completely full!');
      expect(isItemLegalHead(7, w(rules))).toBe('You cannot pick up creatures!');
      expect(mergeAttemptRefusal(a, { id: 2, inTrade: false, weenieClassId: 11, stackSize: 5, maxStackSize: 100 }, rules.placementText)).toBe('You cannot merge different types of items.');
      expect(mergeAttemptRefusal(a, { id: 2, inTrade: false, weenieClassId: 10, stackSize: 100, maxStackSize: 100 }, rules.placementText)).toBe('The destination stack is already full.');
    }
  });
});

// ── GameUI: the delete prompt and the encumbrance notice through the real panel code ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI: PW-9 delete prompt, HC-9 encumbrance notice', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const g2 = globalThis as Record<string, unknown>;
    if (typeof g2.requestAnimationFrame !== 'function') {
      g2.requestAnimationFrame = (cb: (t: number) => void) => { cb(0); return 0; };
      g2.cancelAnimationFrame = () => {};
    }
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS, saved); });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function selectScreen(rules: EraClientRules): { ui: any; container: any; deleted: string[] } {
    const deleted: string[] = [];
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container, { onDeleteCharacter: (slot: { name: string }) => { deleted.push(slot.name); return true; } });
    ui.setClientRules(rules);
    ui.showCharacterSelect([{ id: '12345', name: 'Deleteme Test', deleteTime: 0 }]);
    ui.selectScreen.selectCharacter(0);
    ui.renderCharacterSelect();
    const buttons = Array.from(container.querySelectorAll('button')) as Array<{ textContent: string; dispatchEvent(e: unknown): void }>;
    buttons.find((b) => (b.textContent ?? '').toUpperCase().includes('DELETE'))!.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    return { ui, container, deleted };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dialogButtons = (): any[] => Array.from(domWindow.document.querySelectorAll('.ac-dialog-button'));

  it('1999: a Yes / No "Deleting X cannot be undone.  Are you sure?"; Yes deletes, No does not', () => {
    const first = selectScreen(AC1999);
    expect(domWindow.document.querySelector('.ac-dialog-entry')).toBeNull();
    expect(domWindow.document.querySelector('.ac-dialog-text').textContent).toContain('Deleting Deleteme Test cannot be undone.');
    dialogButtons()[1].dispatchEvent(new domWindow.Event('click', { bubbles: true })); // No
    expect(first.deleted).toEqual([]);
    const second = selectScreen(AC1999);
    dialogButtons()[0].dispatchEvent(new domWindow.Event('click', { bubbles: true })); // Yes
    expect(second.deleted).toEqual(['Deleteme Test']);
  });

  it('end of retail and Dark Majesty keep the typed-DELETE dialog', () => {
    for (const [, rules] of LATER_ERAS) {
      expect(rules.deleteCharacterConfirm).toBeNull();
      selectScreen(rules);
      expect(domWindow.document.querySelector('.ac-dialog-entry')).toBeTruthy();
    }
  });

  it('the burden update says the era\'s notice on the spew line', () => {
    for (const [rules, want] of [[EOR, 'You are encumbered!'], [AC1999, 'You are encumbered']] as const) {
      domWindow.document.body.innerHTML = '';
      const ui = new GameUICtor(domWindow.document.body, {});
      const spew: string[] = [];
      ui.displayErrorText = (t: string) => { spew.push(t); };
      ui.setClientRules(rules);
      ui.setBurden(100, 150);
      expect(spew).toEqual([]);
      ui.setBurden(200, 150);
      expect(spew).toEqual([want]);
      ui.setClientRules(EOR); // stops the 1999 repeat timer
    }
  });
});
