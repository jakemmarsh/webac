/**
 * BUG.webac11-radar-1999 (jakemmarsh/webac#11, "[AC1999] Radar adjustments needed").
 *
 * 1. Which objects get a radar blip. The end-of-retail client's
 *    ACCWeenieObject::InqShowableOnRadar @ 0058c250 shows RadarBehavior
 *    ShowMovement (2), ShowAttacking (3) and ShowAlways (4) alike. The 1999
 *    client.exe's @ 0x4e2f20 (read from its machine code) gates 2 and 3:
 *    ShowAlways always; the selected creature always; ShowAttacking within
 *    10 m (PublicWeenieDesc +0x7c, Reset's 10.0f @ 0x617b10) or in a combat
 *    stance (0x4e3160); ShowMovement within 10 m, or while its velocity is not
 *    zero, an action is pending, it turns, or it holds a combat stance. 226 of
 *    the AC1999 world's 294 fightable creatures are ShowMovement, so an idle
 *    one is off the 1999 radar. The same predicate gates Closest Compass Item
 *    (1999 PanelUI_SelectNext case 2).
 * 2. The coordinates under the radar and the remaining spell durations: the
 *    1999 client drew neither (RadarUI_Update @ 0x527fc0 has no coordinate
 *    text; the exe has no "%d:%02d"), so a 1999 world hides both readouts and
 *    their option rows / Keyboard Config commands. End of retail and Dark
 *    Majesty keep them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RadarBehavior, ItemType } from '@ac/shared';
import {
  inqShowableOnRadar1999, isCombatStyle1999, RadarVisibility, RadarDotFeed, showableOnRadar,
  RADAR_REVEAL_DISTANCE_1999, type RadarShowFacts1999, type RadarFeedContext, type RadarMotionSource,
} from '../packages/renderer/src/ui/RadarBlips.js';
import { MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';
import {
  eraClientRules, unsupportedFeatures, hiddenBy, FEATURE_CHARACTER_OPTIONS, FEATURE_KEYBIND_ACTIONS,
} from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const facts = (over: Partial<RadarShowFacts1999> = {}): RadarShowFacts1999 => ({
  radarBehavior: RadarBehavior.ShowMovement, uiHidden: false, distance: 40, selected: false,
  isCreature: true, moving: false, motion: { style: MotionStance.NonCombat, turning: false, actionsPending: false },
  ...over,
});

describe('the 1999 InqShowableOnRadar (@ 0x4e2f20)', () => {
  it('ShowNever and Undefined never show; ShowAlways always does', () => {
    expect(inqShowableOnRadar1999(facts({ radarBehavior: RadarBehavior.ShowNever, distance: 1, selected: true }))).toBe(false);
    expect(inqShowableOnRadar1999(facts({ radarBehavior: RadarBehavior.Undefined, distance: 1 }))).toBe(false);
    expect(inqShowableOnRadar1999(facts({ radarBehavior: RadarBehavior.ShowAlways, distance: 70 }))).toBe(true);
    // RadarUI_Update skips a UI-hidden object (bitfield 0x80) before asking.
    expect(inqShowableOnRadar1999(facts({ radarBehavior: RadarBehavior.ShowAlways, uiHidden: true }))).toBe(false);
  });

  it('an idle ShowMovement monster past 10 m is off the radar; near, moving, turning, acting or in combat it shows', () => {
    expect(inqShowableOnRadar1999(facts())).toBe(false);
    expect(RADAR_REVEAL_DISTANCE_1999).toBe(10);
    expect(inqShowableOnRadar1999(facts({ distance: 9.99 }))).toBe(true);
    expect(inqShowableOnRadar1999(facts({ distance: 10 }))).toBe(false);
    expect(inqShowableOnRadar1999(facts({ moving: true }))).toBe(true);
    expect(inqShowableOnRadar1999(facts({ motion: { style: MotionStance.NonCombat, turning: true, actionsPending: false } }))).toBe(true);
    expect(inqShowableOnRadar1999(facts({ motion: { style: MotionStance.NonCombat, turning: false, actionsPending: true } }))).toBe(true);
    expect(inqShowableOnRadar1999(facts({ motion: { style: MotionStance.HandCombat, turning: false, actionsPending: false } }))).toBe(true);
    // No motion interpreter: the 1999 client shows it.
    expect(inqShowableOnRadar1999(facts({ motion: null }))).toBe(true);
  });

  it('ShowAttacking shows only near or in a combat stance (moving / turning / acting do not count)', () => {
    const atk = (over: Partial<RadarShowFacts1999>) => facts({ radarBehavior: RadarBehavior.ShowAttacking, ...over });
    expect(inqShowableOnRadar1999(atk({}))).toBe(false);
    expect(inqShowableOnRadar1999(atk({ moving: true, motion: { style: MotionStance.NonCombat, turning: true, actionsPending: true } }))).toBe(false);
    expect(inqShowableOnRadar1999(atk({ distance: 5 }))).toBe(true);
    expect(inqShowableOnRadar1999(atk({ motion: { style: MotionStance.SwordCombat, turning: false, actionsPending: false } }))).toBe(true);
  });

  it('the selected creature always shows; a selected non-creature does not', () => {
    expect(inqShowableOnRadar1999(facts({ selected: true }))).toBe(true);
    expect(inqShowableOnRadar1999(facts({ selected: true, isCreature: false }))).toBe(false);
  });

  it('combat styles are 0x4e3160\'s list: not NonCombat or Graze', () => {
    for (const s of [0x8000003c, 0x8000003e, 0x8000003f, 0x80000040, 0x80000041, 0x80000042, 0x80000043,
      0x80000044, 0x80000045, 0x80000046, 0x80000047, 0x80000049]) expect(isCombatStyle1999(s), s.toString(16)).toBe(true);
    for (const s of [0x8000003d, 0x80000048, 0, 0x41000003]) expect(isCombatStyle1999(s), s.toString(16)).toBe(false);
  });
});

interface Obj {
  guid: number; worldX: number; worldY: number; worldZ: number; radarBehavior: number; uiHidden?: boolean;
  itemType?: number; motionState?: { turn: number }; radarColor: number; objectDescFlags?: number; name: string;
}
const mk = (guid: number, x: number, z: number, radarBehavior: number, itemType = ItemType.Creature): Obj => ({
  guid, worldX: x, worldY: 0, worldZ: z, radarBehavior, itemType, motionState: { turn: 0 }, radarColor: 0, objectDescFlags: 0x10, name: `obj${guid}`,
});

/** Drive the real RadarDotFeed + RadarVisibility one frame, as main.ts's animate() does. */
function frame(vis: RadarVisibility<Obj>, feed: RadarDotFeed<Obj>, objs: Obj[], now: number, selected = 0): number[] {
  vis.beginFrame(now);
  const ctx: RadarFeedContext<Obj> = {
    playerWorldX: 0, playerWorldZ: 0, playerFeetY: 0, range: 75,
    fellows: null, fellowshipLeaderGuid: 0, playerMonarchGuid: undefined, playerPKStatus: undefined,
    eligible: (o, dx, dy, dz) => vis.showable(o, dx, dy, dz, selected),
  };
  return feed.build(objs, ctx).map((d) => d.guid).sort((a, b) => a - b);
}

describe('RadarVisibility + RadarDotFeed: which blips each era draws', () => {
  const motions = new Map<number, { currentStyleId: number; motionsPending: boolean }>();
  const motionOf = (g: number): RadarMotionSource | undefined => motions.get(g);
  const drudge = mk(1, 30, 0, RadarBehavior.ShowMovement);   // idle, 30 m east
  const near = mk(2, 0, 8, RadarBehavior.ShowMovement);      // idle, 8 m south
  const guard = mk(3, 0, -40, RadarBehavior.ShowAttacking);  // idle, 40 m north
  const portal = mk(4, -50, 0, RadarBehavior.ShowAlways, ItemType.Portal);
  const hidden = mk(5, 5, 5, RadarBehavior.ShowNever);
  const all = () => [drudge, near, guard, portal, hidden];
  for (const o of all()) motions.set(o.guid, { currentStyleId: MotionStance.NonCombat, motionsPending: false });

  it('end of retail (and Dark Majesty, which runs that exe): every ShowMovement / ShowAttacking / ShowAlways object shows', () => {
    for (const id of ['eor', 'classic-dereth']) {
      const vis = new RadarVisibility<Obj>(motionOf);
      vis.rule = eraClientRules(eraProfile(id)).radarVisibility;
      expect(vis.rule, id).toBe('eor');
      expect(frame(vis, new RadarDotFeed<Obj>(), all(), 1)).toEqual([1, 2, 3, 4]);
      // Unchanged from the end-of-retail predicate.
      for (const o of all()) expect(vis.showable(o, 0, 0, 0, 0)).toBe(showableOnRadar(o.radarBehavior, false));
    }
  });

  it('1999: idle far monsters are off the radar; the near one, the portal (ShowAlways) show', () => {
    const vis = new RadarVisibility<Obj>(motionOf);
    vis.rule = eraClientRules(eraProfile('ac1999-retail')).radarVisibility;
    expect(vis.rule).toBe('ac1999');
    const feed = new RadarDotFeed<Obj>();
    expect(frame(vis, feed, all(), 1)).toEqual([2, 4]);
    expect(frame(vis, feed, all(), 1.016)).toEqual([2, 4]);
  });

  it('1999: the drudge shows while it walks and drops off once it stands still', () => {
    const vis = new RadarVisibility<Obj>(motionOf);
    vis.rule = 'ac1999';
    const feed = new RadarDotFeed<Obj>();
    const d = mk(10, 30, 0, RadarBehavior.ShowMovement);
    motions.set(10, { currentStyleId: MotionStance.NonCombat, motionsPending: false });
    expect(frame(vis, feed, [d], 1)).toEqual([]);      // first sight: no velocity yet
    d.worldX += 0.05;                                 // walked this frame
    expect(frame(vis, feed, [d], 1.016)).toEqual([10]);
    expect(frame(vis, feed, [d], 1.032)).toEqual([]);  // stood still
    // A select key between frames reads the last frame's answer, it does not resample.
    d.worldX += 0.05;
    expect(frame(vis, feed, [d], 1.048)).toEqual([10]);
    expect(vis.showable(d, 30, 0, 0, 0)).toBe(true);
    expect(vis.showable(d, 30, 0, 0, 0)).toBe(true);
  });

  it('1999: combat stance, a pending swing, a turn and selection each bring a far monster back', () => {
    const vis = new RadarVisibility<Obj>(motionOf);
    vis.rule = 'ac1999';
    const feed = new RadarDotFeed<Obj>();
    const g = mk(20, 40, 0, RadarBehavior.ShowMovement);
    const st = { currentStyleId: MotionStance.NonCombat as number, motionsPending: false };
    motions.set(20, st);
    expect(frame(vis, feed, [g], 1)).toEqual([]);
    st.currentStyleId = MotionStance.HandCombat;
    expect(frame(vis, feed, [g], 2)).toEqual([20]);
    st.currentStyleId = MotionStance.NonCombat; st.motionsPending = true;
    expect(frame(vis, feed, [g], 3)).toEqual([20]);
    st.motionsPending = false; g.motionState = { turn: 0x6500000d };
    expect(frame(vis, feed, [g], 4)).toEqual([20]);
    g.motionState = { turn: 0 };
    expect(frame(vis, feed, [g], 5)).toEqual([]);
    expect(frame(vis, feed, [g], 6, 20)).toEqual([20]);
    // 3D distance from the player's feet: 6 m east and 8 m up is 10 m, not near.
    const up = mk(21, 6, 0, RadarBehavior.ShowMovement);
    up.worldY = 8;
    motions.set(21, { currentStyleId: MotionStance.NonCombat, motionsPending: false });
    expect(frame(vis, feed, [up], 7)).toEqual([]);
    up.worldY = 7.9;
    expect(frame(vis, feed, [up], 8)).toEqual([21]);
  });
});

describe('radar coordinates and spell durations: 1999 hides them, end of retail and Dark Majesty keep them', () => {
  it('the era tables', () => {
    const f1999 = unsupportedFeatures(eraProfile('ac1999-retail'));
    expect(f1999.has('radarCoordinates')).toBe(true);
    expect(f1999.has('spellDurations')).toBe(true);
    for (const id of ['eor', 'classic-dereth']) {
      const f = unsupportedFeatures(eraProfile(id));
      expect(f.has('radarCoordinates'), id).toBe(false);
      expect(f.has('spellDurations'), id).toBe(false);
    }
    const rows = hiddenBy(FEATURE_CHARACTER_OPTIONS, f1999);
    expect(rows.has('CoordinatesOnRadar')).toBe(true);
    expect(rows.has('SpellDuration')).toBe(true);
    const keys = hiddenBy(FEATURE_KEYBIND_ACTIONS, f1999);
    expect(keys.has(0x10000085)).toBe(true); // Show Coordinates By the Radar
    expect(keys.has(0x10000086)).toBe(true); // Display Spell Durations
    expect(hiddenBy(FEATURE_KEYBIND_ACTIONS, unsupportedFeatures(eraProfile('eor'))).has(0x10000085)).toBe(false);
  });

  for (const era of ['ac1999-retail', 'eor', 'classic-dereth'] as const) {
    const is1999 = era === 'ac1999-retail';
    describe(`GameUI on ${era}`, () => {
      let H: GameUIFixture;
      beforeAll(async () => {
        H = await mountGameUI();
        H.ui.setUnsupportedFeatures(unsupportedFeatures(eraProfile(era)));
        H.ui.setClientRules(eraClientRules(eraProfile(era)));
        H.ui.showGame();
      }, 60_000);
      afterAll(() => H?.teardown());

      it(is1999 ? 'no coordinates under the radar, even with the option on' : 'the coordinates show under the radar', () => {
        expect(H.ui.optionsSettings.showCoordinatesByTheRadar).toBe(true);
        H.ui.setPlayerMapCell(1587, 1355, true);
        H.ui.updateHUD();
        const coord = H.container.querySelector('#radar-coord') as HTMLElement;
        expect(coord).toBeTruthy();
        expect(coord.style.display === 'none').toBe(is1999);
        if (!is1999) expect(H.ui.lastCoordText).toBe('33.6N,56.8E');
      });

      it(is1999 ? 'an effect row shows no remaining time' : 'an effect row shows its remaining time', () => {
        const host = H.win.document.createElement('div');
        H.ui.fillEffectsValue(host, 125);
        expect(host.dataset.effectsDuration).toBe(is1999 ? '' : '2:05');
      });
    });
  }
});
