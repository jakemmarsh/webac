/**
 * TELEMETRY.refusal-name-keying + TELEMETRY.refusal-context — production's first day of
 * `client_refusal` lines (2026-10-23) made one code per item ("You must remove your Tunic to wear
 * that", "The Leather Leggings is already being worn", "Using the Scroll of Shock Arc IV", the ACE
 * transient "You must remove your Breeches to wield Pants"), counted UseObject hints ("To attack _,
 * click on the dove icon first") as refusals, and gave no way to tell a legitimate "one item at a
 * time" / "select a suitable target" from a bug. Driven through the shipped reporter, the real
 * request gate, the era tables and the bridge's whitelist.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat';
import { ActionMap } from '../packages/dat-parser/src/file-types/ActionMap';
import { DatReader } from '../packages/dat-parser/src/DatReader';
import { ACT, keyRepeatDispatches } from '../packages/renderer/src/input/KeybindDefaults';
import { KEY_REPEAT_ACTIONS } from '../packages/renderer/src/input/KeybindActions.generated';
import { RefusalReporter, refusalHash, scrubNames, SERVER_REFUSAL_ACTION_MS, type RefusalEvent } from '../packages/renderer/src/telemetry/RefusalReporter';
import {
  matchClientTemplate, matchTemplates, CLIENT_LINE_TEMPLATES, USE_HINT_TEMPLATES, isUseHintNotice, knownObjectNames,
  pendingRequestDetail, castRefusalDetail, cleanRefusalDetail, MAX_DETAIL_MS,
} from '../packages/renderer/src/telemetry/RefusalTemplates';
import { EOR_USE_OBJECT_RULES, AC1999_USE_OBJECT_RULES, decideUseObject, type UseSubject, type UseObjectContext } from '../packages/renderer/src/input/UseObject';
import { PAPERDOLL_STRINGS } from '../packages/renderer/src/inventory/PaperdollDragObject';
import { InventoryRequestTracker, InventoryRequest, attemptFailedText } from '../packages/shared/src/index';
import { gateInventoryRequestSend } from '../packages/renderer/src/inventory/InventoryRequests';
import { SelectionHistory } from '../packages/renderer/src/inventory/GiveDropCommands';
import { GameActionType } from '../packages/network/src/GameActionType';
import { sanitizeClientRefusal } from '../services/ws-tcp-bridge/src/clientRefusal';

function rig(scrub?: (t: string) => string) {
  const clock = { t: 1000 };
  const events: RefusalEvent[] = [];
  const r = new RefusalReporter({
    endpoint: 'http://x/client-preworld', build: 'b1', trace: 'feedc0de12345678',
    era: () => 'eor', server: () => 'bb791cc4', now: () => clock.t, scrub,
    send: (_url, body) => { events.push(JSON.parse(body) as RefusalEvent); },
  });
  return { r, clock, events };
}

const fill = (t: string, ...names: string[]): string => names.reduce((s, n) => s.replace(/%[hl]?s/, n), t);

describe('a client line is keyed by the template it was built from', () => {
  it('the production lines: worn / pack item names never make a new code', () => {
    const g = rig();
    g.r.clientSpew(fill(PAPERDOLL_STRINGS.mustRemoveToWear, 'Tunic'));
    g.r.clientSpew(fill(PAPERDOLL_STRINGS.mustRemoveToWear, 'Leather Boots'));
    g.r.clientSpew(fill(PAPERDOLL_STRINGS.alreadyBeingWorn, 'Leather Leggings'));
    g.r.clientSpew(fill(PAPERDOLL_STRINGS.alreadyBeingWorn, 'Pants'));
    expect(g.events.map((e) => e.text)).toEqual(['You must remove your _ to wear that', 'The _ is already being worn']);
    expect(g.events[0].code).toBe(`c:${refusalHash('You must remove your _ to wear that')}`);
  });

  it('ServerSaysAttemptFailed\'s verb line keeps its suffix, loses the name (the 0x00A0 text too)', () => {
    const line = attemptFailedText(InventoryRequest.Wield, 0x1d, { name: 'Pants' });
    expect(line).toBe("The Pants can't be wielded - you're too busy");
    expect(matchClientTemplate(line)).toBe("The _ can't be wielded - you're too busy");
    const g = rig();
    g.r.serverCode('inventory_failed', 0, attemptFailedText(InventoryRequest.Wield, 0, { name: 'Pants' }), 'spew');
    g.r.serverCode('inventory_failed', 0, attemptFailedText(InventoryRequest.Wield, 0, { name: 'Tunic' }), 'spew');
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ code: 'we:0x0000', text: "The _ can't be wielded" });
  });

  it('the UseObject lines of both eras key by template (refusals still reported)', () => {
    const g = rig();
    for (const rules of [EOR_USE_OBJECT_RULES, AC1999_USE_OBJECT_RULES]) {
      g.r.clientSpew(fill(rules.door, 'Door'));
      g.r.clientSpew(fill(rules.door, 'Gate'));
      g.r.clientSpew(fill(rules.mustWield, 'Wand of Frost'));
    }
    g.r.clientSpew('The Statue of Asheron cannot be used');
    g.r.clientSpew('The Well cannot be used');
    expect(g.events.map((e) => e.text)).toEqual([
      "You can't open or close this _ that way", 'You must wield the _ to use it',
      "You can't open or close this _ that way.", 'You must wield the _ to use it.',
      'The _ cannot be used',
    ]);
  });

  it('every table template has a slot, and a line matching no template is left to the name scrub', () => {
    expect(CLIENT_LINE_TEMPLATES.length).toBeGreaterThan(15);
    for (const t of CLIENT_LINE_TEMPLATES) expect(t).toMatch(/%[hl]?s/);
    expect(matchClientTemplate('You can only move or use one item at a time')).toBe('You can only move or use one item at a time');
    expect(matchTemplates('Give Bob the Sword now', ['Give %s the %s now'])).toBe('Give _ the _ now');
  });
});

describe('server lines: names of every object the client knows, the pack and paperdoll included', () => {
  it('the ACE transient "You must remove your %s to wield %s" keeps one code', () => {
    const world = [{ name: 'Drudge Sneak', pluralName: 'Drudge Sneaks' }];
    const pack = [{ name: 'Pants' }, { name: 'Tunic' }];
    const worn = [{ name: 'Breeches' }, { name: 'Leather Leggings', pluralName: null }];
    const names = knownObjectNames('Hero', world, pack, worn);
    expect(names).toEqual(expect.arrayContaining(['Hero', 'Drudge Sneak', 'Drudge Sneaks', 'Pants', 'Tunic', 'Breeches', 'Leather Leggings']));
    const g = rig((t) => scrubNames(t, names));
    g.r.serverText('transient', 'You must remove your Breeches to wield Pants', null);
    g.r.serverText('transient', 'You must remove your Tunic to wield Tunic', null);
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ source: 'server', context: 'transient', text: 'You must remove your _ to wield _' });
  });
});

describe('UseObject hints are notices, keyed off the eras\' rules tables', () => {
  it('the dove hint (end of retail) and the 1999 chat / attack / Cast hints never report', () => {
    expect(USE_HINT_TEMPLATES).toEqual(expect.arrayContaining([
      EOR_USE_OBJECT_RULES.dove, AC1999_USE_OBJECT_RULES.dove, AC1999_USE_OBJECT_RULES.chatHint,
      AC1999_USE_OBJECT_RULES.combatAttackHint, AC1999_USE_OBJECT_RULES.combatAffectHint,
    ]));
    const g = rig();
    for (const t of USE_HINT_TEMPLATES) {
      const line = fill(t, 'Drudge Sneak');
      expect(isUseHintNotice(line)).toBe(true);
      g.r.clientSpew(line);
    }
    expect(g.events).toEqual([]);
    // A refusal from the same table still reports.
    expect(isUseHintNotice(fill(EOR_USE_OBJECT_RULES.door, 'Door'))).toBe(false);
  });

  it('the line decideUseObject posts for an attackable creature in peace mode is that hint', () => {
    const subject: UseSubject = {
      guid: 0x80001234, name: 'Drudge Sneak', itemType: 0x10, useability: 0x1, bitfield: 0x10, location: 0,
      combatUse: 0, validLocations: 0, beingTraded: false,
    } as unknown as UseSubject;
    const ctx = {
      playerGuid: 0x50000001, groundObject: 0, allowSelection: false, skipDetermine: true, selectedGuid: 0,
      attackable: true, peaceMode: true, confirmVolatileRare: false, selectionCompatible: false,
    } as unknown as UseObjectContext;
    const d = decideUseObject(subject, ctx, EOR_USE_OBJECT_RULES);
    expect(d).toEqual({ kind: 'message', text: 'To attack Drudge Sneak, click on the dove icon first' });
    expect(isUseHintNotice((d as { text: string }).text)).toBe(true);
  });
});

describe('context: the pending request behind "one item at a time"', () => {
  it('the real gate inside withDetail reports the pending kind and age', () => {
    const g = rig();
    const now = { s: 500 };
    const tracker = new InventoryRequestTracker({ now: () => now.s });
    tracker.record(0x80000b01, InventoryRequest.Wield, 498.75);
    const sent = g.r.forAction(GameActionType.Use, () => g.r.withDetail(pendingRequestDetail(tracker.pending, now.s),
      () => gateInventoryRequestSend(tracker, GameActionType.Use, (t) => g.r.clientSpew(t))));
    expect(sent).toBe(false);
    expect(g.events[0]).toMatchObject({ text: 'You can only move or use one item at a time', action: GameActionType.Use, pending: 'wield', pendingMs: 1250 });
  });

  it('every request kind has a token; nothing pending adds nothing; repeats keep the first context', () => {
    for (const k of [InventoryRequest.Merge, InventoryRequest.Split, InventoryRequest.Move, InventoryRequest.PickUp,
      InventoryRequest.PutInContainer, InventoryRequest.Drop, InventoryRequest.Wield, InventoryRequest.ShopEvent, InventoryRequest.Give]) {
      expect(pendingRequestDetail({ request: k, time: 0 }, 1).pending).toBeTruthy();
    }
    expect(pendingRequestDetail(null, 1)).toEqual({});
    const g = rig();
    g.r.withDetail({ pending: 'give', pendingMs: 10 }, () => g.r.clientSpew('You can only move or use one item at a time'));
    g.r.withDetail({ pending: 'drop', pendingMs: 20 }, () => g.r.clientSpew('You can only move or use one item at a time'));
    g.clock.t += 61_000; g.r.tick();
    expect(g.events).toHaveLength(2);
    expect(g.events[1]).toMatchObject({ count: 1, pending: 'drop', pendingMs: 20 });
    // Outside withDetail nothing leaks into later refusals.
    g.r.clientSpew('Not enough pack space');
    expect(g.events[2].pending).toBeUndefined();
  });
});

describe('context: what a cast needed and what was selected', () => {
  const placeOf = (guid: number) => guid === 0x50000001 ? { place: 'self' as const, itemType: 0x10 }
    : guid === 0x80000b02 ? { place: 'pack' as const, itemType: 0x1 }
      : guid === 0x80000f01 ? { place: 'world' as const, itemType: 0x10 } : { place: 'unknown' as const };

  it('nothing selected: the spell\'s target type, where the last selection resolves now and how long ago it went', () => {
    expect(castRefusalDetail({ spellTargetType: 0x10, selectedGuid: 0, prevSelectedGuid: 0x80000a99, msSinceSelectionChange: 812.4, placeOf }))
      .toEqual({ spellTargetType: 0x10, selection: 'none', prevSelection: 'unknown', selectionGoneMs: 812 });
    expect(castRefusalDetail({ spellTargetType: 0x10, selectedGuid: 0, prevSelectedGuid: 0x80000f01, msSinceSelectionChange: null, placeOf }))
      .toEqual({ spellTargetType: 0x10, selection: 'none', prevSelection: 'world', prevSelectionType: 0x10 });
  });

  it('a selection: where it is and its ItemType (a pack item for an item spell, webac#9)', () => {
    expect(castRefusalDetail({ spellTargetType: 0x1, selectedGuid: 0x80000b02, prevSelectedGuid: 0, msSinceSelectionChange: 5, placeOf }))
      .toEqual({ spellTargetType: 0x1, selection: 'pack', selectionType: 0x1 });
  });

  it('SelectionHistory stamps each change', () => {
    const clock = { t: 100 };
    const h = new SelectionHistory(() => clock.t);
    expect(h.msSinceChange()).toBeNull();
    h.select(0x80000f01);
    clock.t = 400;
    h.select(0);
    clock.t = 1150;
    expect(h.prevSelectedId).toBe(0x80000f01);
    expect(h.msSinceChange()).toBe(750);
    expect(new SelectionHistory().msSinceChange()).toBeNull();
  });

  it('the reporter sends it on the castNoTarget line', () => {
    const g = rig();
    const d = castRefusalDetail({ spellTargetType: 0x10, selectedGuid: 0, prevSelectedGuid: 0x80000a99, msSinceSelectionChange: 3000, placeOf });
    g.r.withDetail(d, () => g.r.clientSpew('You must select a suitable target before casting this spell'));
    expect(g.events[0]).toMatchObject({ code: 'c:f83d60a2', spellTargetType: 0x10, selection: 'none', prevSelection: 'unknown', selectionGoneMs: 3000 });
  });
});

describe('the bridge keeps only valid context fields', () => {
  it('round-trips the closed tokens and bounded numbers, drops junk', () => {
    const base = { outcome: 'refusal', code: 'c:ae4a37b3', era: 'eor', source: 'client', context: 'spew', sink: 'spew', count: 1, first: true, windowMs: 0 };
    const ok = sanitizeClientRefusal({ ...base, pending: 'wield', pendingMs: 1250, spellTargetType: 0x10, selection: 'none', prevSelection: 'world', prevSelectionType: 16, selectionGoneMs: 3000 });
    expect(ok).toMatchObject({ pending: 'wield', pendingMs: 1250, spellTargetType: 16, selection: 'none', prevSelection: 'world', prevSelectionType: 16, selectionGoneMs: 3000 });
    const bad = sanitizeClientRefusal({ ...base, pending: 'Pants', pendingMs: -1, spellTargetType: 'x', selection: 'Bob', selectionType: 2 ** 33, selectionGoneMs: MAX_DETAIL_MS + 1, name: 'Bob' })!;
    for (const k of ['pending', 'pendingMs', 'spellTargetType', 'selection', 'selectionType', 'selectionGoneMs', 'name']) expect(bad).not.toHaveProperty(k);
    // The page cleans the same way before sending.
    expect(cleanRefusalDetail({ pending: 'Pants', selection: 'pack', selectionType: 1 })).toEqual({ selection: 'pack', selectionType: 1 });
  });
});

describe('a server refusal names the request it answered', () => {
  it('the last GameAction within SERVER_REFUSAL_ACTION_MS rides as `action`', () => {
    const g = rig();
    g.r.noteActionSent(GameActionType.CastTargetedSpell);
    g.clock.t += 400;
    g.r.serverCode('weenie_error', 0x1d, "You're too busy!", 'spew');
    expect(g.events[0]).toMatchObject({ code: 'we:0x001d', action: GameActionType.CastTargetedSpell });
    // Long after the request, the refusal is not pinned on it.
    g.clock.t += SERVER_REFUSAL_ACTION_MS + 1;
    g.r.serverCode('weenie_error', 0x402, 'Your spell fizzled.', 'chat');
    expect(g.events[1].action).toBeNull();
  });
});

describe('OS key repeat: only the actions retail repeats (ActionMap toggle type 4)', () => {
  it('a held cast, use or panel key fires once; the repeat-type actions repeat', () => {
    for (const id of [ACT.SpellSlot1, ACT.SpellSlot9, ACT.UseSelected, ACT.ShowHideWorldPanel, ACT.ZoomCameraIn]) {
      expect(keyRepeatDispatches(id)).toBe(false);
    }
    expect(KEY_REPEAT_ACTIONS.size).toBeGreaterThan(0);
    for (const id of KEY_REPEAT_ACTIONS) expect(keyRepeatDispatches(id)).toBe(true);
  });

  describe.skipIf(!existsSync(DAT_PATHS.portal))('KEY_REPEAT_ACTIONS is the DAT\'s toggle-4 set', () => {
    let repeat: Set<number>;
    let spellSlotToggle: number | undefined;
    beforeAll(() => {
      const am = ActionMap.read(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x26000000)!));
      repeat = new Set();
      for (const vals of am.inputMaps.values()) for (const [id, v] of vals) {
        if (v.unknownInt2 === 4) repeat.add(id);
        if (id === ACT.SpellSlot1) spellSlotToggle = v.unknownInt2;
      }
    });
    it('matches, and a spell slot is a press (3)', () => {
      expect([...KEY_REPEAT_ACTIONS].sort((a, b) => a - b)).toEqual([...repeat].sort((a, b) => a - b));
      expect(spellSlotToggle).toBe(3);
    });
  });
});
