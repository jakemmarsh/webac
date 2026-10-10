/**
 * CORE.retail-select-keys + CORE.retail-radar-click-select.
 *
 * CPlayerSystem::OnAction @ 00561890 cases 3–0x14 drive
 * CPlayerSystem::SelectNext @ 0055f9a0 per UI_SELECTION_TYPE (Item, Compass
 * Item, Monster, Player, Unopened Corpse) and the fellowship walks
 * (SelectNextFellow @ 005694f0 / SelectPreviousFellow @ 005695c0);
 * gmRadarUI::ListenToElementMessage @ 004d75b0 selects the blip under the
 * mouse on a click. Every default key here is the KeyMap DAT's
 * (KeybindDefaults.generated.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  selectNext, selectCycle, selectNextCompassItem, matchesSelectionType, fellowIterationOrder,
  selectNextFellow, selectPreviousFellow, SelectionType,
  type SelectNextCandidate, type SelectNextContext, type SelectNextReference,
} from '../packages/renderer/src/controllers/SelectNext.js';
import { ACT, DEFAULT_KEYBINDS } from '../packages/renderer/src/input/KeybindDefaults.js';
import { parseFellowshipFullUpdate } from '../packages/network/src/MessageSerializer.js';
import { bindRadarClickSelect } from '../packages/renderer/src/ui/RadarBlips.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

const PLAYER = 0x50000001;
const MONSTER_BITS = 0x10; // BF_ATTACKABLE-ish: not player / vendor / corpse

function cand(over: Partial<SelectNextCandidate>): SelectNextCandidate {
  return {
    guid: 0x80000010, dx: 5, dy: 0, dz: 0, bitfield: MONSTER_BITS, physicsState: 0,
    showableOnRadar: true, present: true, radarEnum: 2, wielderId: 0, corpseOpened: false, ...over,
  };
}
const ctx = (over: Partial<SelectNextContext> = {}): SelectNextContext => ({
  playerGuid: PLAYER, outside: true, meleeOrMissile: false,
  isAttackable: () => true, isFellow: () => false, ...over,
});
const NONE: SelectNextReference = { guid: 0, offset: null };
const at = (c: SelectNextCandidate): SelectNextReference => ({ guid: c.guid, offset: { dx: c.dx, dy: c.dy, dz: c.dz } });

// Three monsters at 10 / 20 / 30 m.
const m10 = cand({ guid: 0x80000001, dx: 10 });
const m20 = cand({ guid: 0x80000002, dx: 20 });
const m30 = cand({ guid: 0x80000003, dx: 30 });
const monsters = [m20, m30, m10];

describe('KeyMap defaults reach handled actions', () => {
  it('every retail selection key resolves to an ACT id the router dispatches', () => {
    const keys: Array<[number, string]> = [
      [ACT.SelectPreviousSelection, 'KeyP'],
      [ACT.SelectClosestCompassItem, 'Backspace'], [ACT.SelectPrevCompassItem, 'Minus'], [ACT.SelectNextCompassItem, 'Equal'],
      [ACT.SelectClosestItem, 'Backslash'], [ACT.SelectPrevItem, 'BracketLeft'], [ACT.SelectNextItem, 'BracketRight'],
      [ACT.SelectClosestMonster, 'Quote'], [ACT.SelectPrevMonster, 'KeyL'], [ACT.SelectNextMonster, 'Semicolon'],
      [ACT.SelectClosestPlayer, 'Slash'], [ACT.SelectPrevPlayer, 'Comma'], [ACT.SelectNextPlayer, 'Period'],
      [ACT.SelectPrevFellow, 'KeyN'], [ACT.SelectNextFellow, 'KeyM'],
    ];
    for (const [id, code] of keys) expect(DEFAULT_KEYBINDS[id], `0x${id.toString(16)}`).toContain(code);
    expect(ACT.SelectClosestUnopenedCorpse).toBe(0x10000121);
    expect(ACT.SelectNextUnopenedCorpse).toBe(0x10000122);
  });
});

describe('CPlayerSystem::SelectNext @ 0055f9a0 — direction and reference', () => {
  it('Closest = SelectNext(1, 1): the nearest, whatever is selected', () => {
    expect(selectCycle(monsters, ctx(), NONE, SelectionType.Monster, 'closest')).toBe(m10.guid);
    expect(selectCycle(monsters, ctx(), at(m30), SelectionType.Monster, 'closest')).toBe(m10.guid);
  });

  it('Next = SelectNext(0, 0): the next one farther than the selection', () => {
    expect(selectCycle(monsters, ctx(), at(m10), SelectionType.Monster, 'next')).toBe(m20.guid);
    expect(selectCycle(monsters, ctx(), at(m20), SelectionType.Monster, 'next')).toBe(m30.guid);
  });

  it('Next from the farthest wraps to the nearest (SelectNext(1, 1))', () => {
    expect(selectCycle(monsters, ctx(), at(m30), SelectionType.Monster, 'next')).toBe(m10.guid);
  });

  it('Previous = SelectNext(1, 0): the next one nearer; from the nearest it wraps to the farthest (SelectNext(0, 1))', () => {
    expect(selectCycle(monsters, ctx(), at(m30), SelectionType.Monster, 'previous')).toBe(m20.guid);
    expect(selectCycle(monsters, ctx(), at(m20), SelectionType.Monster, 'previous')).toBe(m10.guid);
    expect(selectCycle(monsters, ctx(), at(m10), SelectionType.Monster, 'previous')).toBe(m30.guid);
  });

  it('a reference not in the world inverts the direction: Next picks the farthest, Previous the nearest', () => {
    expect(selectNext(monsters, ctx(), NONE, false, false, SelectionType.Monster)).toBe(m30.guid);
    expect(selectNext(monsters, ctx(), NONE, true, false, SelectionType.Monster)).toBe(m10.guid);
  });

  it('the reference is measured where it is, even when it is not of the walked type', () => {
    const npc = cand({ guid: 0x80000050, dx: 15, bitfield: 0x10 | 0x200 }); // vendor: not a Monster
    expect(selectCycle([...monsters, npc], ctx(), at(npc), SelectionType.Monster, 'next')).toBe(m20.guid);
    expect(selectCycle([...monsters, npc], ctx(), at(npc), SelectionType.Monster, 'previous')).toBe(m10.guid);
  });

  it('equal distances order by guid (Farther @ 0055d830), so cycling visits both', () => {
    const a = cand({ guid: 0x80000007, dx: 12 });
    const b = cand({ guid: 0x80000004, dx: 0, dy: 12 });
    expect(selectCycle([a, b], ctx(), NONE, SelectionType.Monster, 'closest')).toBe(b.guid);
    expect(selectCycle([a, b], ctx(), at(b), SelectionType.Monster, 'next')).toBe(a.guid);
    expect(selectCycle([a, b], ctx(), at(a), SelectionType.Monster, 'next')).toBe(b.guid);
  });

  it('weighs |dz| × 1.2 and stops at the radar radius (75 m outside, 25 m inside)', () => {
    const up = cand({ guid: 0x80000020, dx: 8, dz: 3 }); // 11.6
    expect(selectCycle([m10, up], ctx(), NONE, SelectionType.Monster, 'closest')).toBe(m10.guid);
    expect(selectCycle([m30], ctx({ outside: false }), NONE, SelectionType.Monster, 'closest')).toBe(0);
    expect(selectCycle([cand({ dx: 76 })], ctx(), NONE, SelectionType.Monster, 'closest')).toBe(0);
  });

  it('nothing eligible leaves the selection alone (0)', () => {
    expect(selectCycle([], ctx(), at(m10), SelectionType.Monster, 'next')).toBe(0);
  });

  it('the Auto Target pick is still the nearest compass item', () => {
    expect(selectNextCompassItem(monsters, ctx())).toBe(m10.guid);
  });
});

describe('SelectNext per UI_SELECTION_TYPE', () => {
  it('Monster: attackable, not a vendor, on the radar, not a fellow', () => {
    expect(matchesSelectionType(SelectionType.Monster, cand({}), ctx())).toBe(true);
    expect(matchesSelectionType(SelectionType.Monster, cand({}), ctx({ isAttackable: () => false }))).toBe(false);
    expect(matchesSelectionType(SelectionType.Monster, cand({ bitfield: 0x200 }), ctx())).toBe(false);
    expect(matchesSelectionType(SelectionType.Monster, cand({ showableOnRadar: false }), ctx())).toBe(false);
    expect(matchesSelectionType(SelectionType.Monster, cand({}), ctx({ isFellow: () => true }))).toBe(false);
  });

  it('Player: BF_PLAYER (0x8) and on the radar', () => {
    expect(matchesSelectionType(SelectionType.Player, cand({ bitfield: 0x8 }), ctx())).toBe(true);
    expect(matchesSelectionType(SelectionType.Player, cand({ bitfield: 0x10 }), ctx())).toBe(false);
    expect(matchesSelectionType(SelectionType.Player, cand({ bitfield: 0x8, showableOnRadar: false }), ctx())).toBe(false);
  });

  it('Item: unwielded with no radar behavior, or a lifestone / portal / bindstone', () => {
    expect(matchesSelectionType(SelectionType.Item, cand({ radarEnum: 0 }), ctx())).toBe(true);
    expect(matchesSelectionType(SelectionType.Item, cand({ radarEnum: 2 }), ctx())).toBe(false);
    expect(matchesSelectionType(SelectionType.Item, cand({ radarEnum: 4, bitfield: 0x40000 }), ctx())).toBe(true);
    expect(matchesSelectionType(SelectionType.Item, cand({ radarEnum: 0, wielderId: 0x50000009 }), ctx())).toBe(false);
  });

  it('Unopened Corpse: BF_CORPSE (0x2000) not yet opened', () => {
    expect(matchesSelectionType(SelectionType.UnopenedCorpse, cand({ bitfield: 0x2000 }), ctx())).toBe(true);
    expect(matchesSelectionType(SelectionType.UnopenedCorpse, cand({ bitfield: 0x2000, corpseOpened: true }), ctx())).toBe(false);
    expect(matchesSelectionType(SelectionType.UnopenedCorpse, cand({}), ctx())).toBe(false);
  });

  it('Compass Item outside combat is anything on the radar; in melee / missile only attackable non-fellows', () => {
    const vendor = cand({ bitfield: 0x200 });
    expect(matchesSelectionType(SelectionType.CompassItem, vendor, ctx())).toBe(true);
    expect(matchesSelectionType(SelectionType.CompassItem, vendor, ctx({ meleeOrMissile: true }))).toBe(false);
    expect(matchesSelectionType(SelectionType.CompassItem, cand({ showableOnRadar: false, bitfield: 0x4000 }), ctx())).toBe(true);
  });

  it('skips the player, UI-hidden, cloaked and absent objects for every type', () => {
    for (const c of [cand({ guid: PLAYER }), cand({ bitfield: 0x10 | 0x80 }), cand({ physicsState: 0x100000 }), cand({ present: false })]) {
      expect(selectCycle([c], ctx(), NONE, SelectionType.Monster, 'closest')).toBe(0);
    }
  });
});

describe('ClientFellowshipSystem fellow walks', () => {
  it('iterates the fellows hash table: bucket guid % tableSize, each chain newest-first', () => {
    // 0x50000011 and 0x50000001 share bucket 1 of 16; the later-added one is the chain head.
    expect(fellowIterationOrder([0x50000003, 0x50000001, 0x50000011, 0x50000002], 16))
      .toEqual([0x50000011, 0x50000001, 0x50000002, 0x50000003]);
  });

  it('SelectNextFellow @ 005694f0: the next fellow, wrapping to the first; a non-fellow selection takes the first', () => {
    const order = [1, 2, 3];
    expect(selectNextFellow(order, 1)).toBe(2);
    expect(selectNextFellow(order, 3)).toBe(1);
    expect(selectNextFellow(order, 99)).toBe(1);
    expect(selectNextFellow([], 1)).toBeNull();
  });

  it('SelectPreviousFellow @ 005695c0: the previous fellow, wrapping to the last; a non-fellow selection takes the last', () => {
    const order = [1, 2, 3];
    expect(selectPreviousFellow(order, 3)).toBe(2);
    expect(selectPreviousFellow(order, 1)).toBe(3);
    expect(selectPreviousFellow(order, 99)).toBe(3);
    expect(selectPreviousFellow([], 1)).toBe(0);
  });

  it('FellowshipFullUpdate keeps the hash table size the walk iterates by', () => {
    const bytes = new Uint8Array(4 + 2 + 4 * 5 + 2);
    const v = new DataView(bytes.buffer);
    v.setUint16(0, 0, true); v.setUint16(2, 16, true); // 0 fellows, 16 buckets
    v.setUint16(4, 0, true); // empty name (u16 length 0) + align
    const r = parseFellowshipFullUpdate(bytes);
    expect(r?.tableSize).toBe(16);
  });
});

describe('gmRadarUI::ListenToElementMessage @ 004d75b0 — a click selects the blip under the mouse', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let domWindow: any;
  const saved: Record<string, unknown> = {};
  const GLOBALS = ['window', 'document', 'HTMLElement', 'MouseEvent'];
  beforeAll(async () => {
    domWindow = await loadDomWindow();
    installDomGlobals(domWindow, GLOBALS, saved);
  });
  afterAll(() => restoreDomGlobals(GLOBALS, saved));

  it('maps the click through the HUD scale and selects; a click on empty radar selects nothing', () => {
    const canvas = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(canvas);
    // Rendered at 2× (240 px for the 120 px disc) at (100, 50).
    canvas.getBoundingClientRect = () => ({ left: 100, top: 50, width: 240, height: 240, right: 340, bottom: 290, x: 100, y: 50 });
    const picks: Array<[number, number]> = [];
    const selected: number[] = [];
    bindRadarClickSelect(canvas, 120, (mx, my) => { picks.push([mx, my]); return mx > 50 ? 0x81000001 : 0; }, (g) => selected.push(g));
    canvas.dispatchEvent(new domWindow.MouseEvent('mouseup', { clientX: 100 + 122, clientY: 50 + 80, button: 0 }));
    expect(picks[0]).toEqual([61, 40]);
    expect(selected).toEqual([0x81000001]);
    canvas.dispatchEvent(new domWindow.MouseEvent('mouseup', { clientX: 110, clientY: 60, button: 2 }));
    expect(selected).toEqual([0x81000001]);
    const menu = new domWindow.MouseEvent('contextmenu', { cancelable: true });
    canvas.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
  });
});
