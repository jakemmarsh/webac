/**
 * UtilityBelt's Nametags (docs/vtank-parity-gaps.md §11.7; scene/Nametags.ts, ported from UB
 * Tools/Nametags.cs + Lib/Settings/NametagDisplay.cs): which objects get tags, their text,
 * colours, sizes and heights, distance culling, the assess pacing, the settings, and the
 * sprite overlay (pooled, redrawn only on change, nothing in the scene while off).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  NAMETAG_ASSESS_TRIES, NAMETAG_MAX, NametagAssessQueue, NametagOverlay, argbToCss, chooseNametags, monarchNameFromTitle,
  nametagAllegiance, nametagAppraisal, nametagBaseType, nametagHeight, nametagLabel, nametagNeedsAssess, nametagObjectHeight,
  nametagTextureFromCanvas, readNametagSettings, type NametagSettings, type NametagSource,
} from '../packages/renderer/src/scene/Nametags.ts';
import { UB_SETTING_DEFAULTS, UbStore, type UbStorage } from '../packages/renderer/src/agent/ub/ubSettings.ts';

function memStorage(): UbStorage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}
function store(): UbStore {
  const st = memStorage();
  return new UbStore(() => ({ server: 'S', character: 'C' }), () => st);
}
function settingsOn(edit?: (s: UbStore) => void): NametagSettings {
  const s = store();
  s.setText('Nametags.Enabled', 'true');
  edit?.(s);
  return readNametagSettings((n) => s.get(n));
}

const PLAYER = 0x8, ATTACKABLE = 0x10, VENDOR = 0x200, PORTAL = 0x40000, CREATURE = 0x10;
const src = (guid: number, base: NametagSource['base'], x: number, extra: Partial<NametagSource> = {}): NametagSource => ({
  guid, name: `Obj${guid}`, base, x, y: 0, z: 0, height: 1.8, appraisal: null, ...extra,
});

describe('settings (UB NametagDisplay defaults through the /ub opt store)', () => {
  it('has UB\'s per-type colours and sizes; Enabled starts off (UB\'s is on)', () => {
    const s = readNametagSettings((n) => store().get(n));
    expect(s.enabled).toBe(false);
    expect(s.maxRange).toBe(35);
    expect(s.types.Player).toEqual({ enabled: true, tagColor: -16711681, tagSize: 0.15, tickerColor: -16711681, tickerSize: 0.1 });
    expect(s.types.Pet.tagColor).toBe(-16711681);
    expect(s.types.AllegiancePlayer.tagColor).toBe(-16711936);
    expect(s.types.Portal.tagColor).toBe(-16711936);
    expect(s.types.Npc.tagColor).toBe(-256);
    expect(s.types.Vendor.tagColor).toBe(-65281);
    expect(s.types.Monster.tagColor).toBe(-65536);
    expect(Object.keys(UB_SETTING_DEFAULTS).filter((k) => k.startsWith('Nametags.')).length).toBe(2 + 7 * 5);
  });
  it('reads changes made with /ub opt set', () => {
    const s = settingsOn((st) => { st.setText('Nametags.MaxRange', '10'); st.setText('Nametags.Monster.Enabled', 'false'); });
    expect(s.enabled).toBe(true);
    expect(s.maxRange).toBe(10);
    expect(s.types.Monster.enabled).toBe(false);
  });
  it('turns UB\'s signed ARGB colours into CSS', () => {
    expect(argbToCss(-16711681)).toEqual({ css: '#00ffff', alpha: 1 });
    expect(argbToCss(-65536)).toEqual({ css: '#ff0000', alpha: 1 });
    expect(argbToCss(-256)).toEqual({ css: '#ffff00', alpha: 1 });
    expect(argbToCss(-65281)).toEqual({ css: '#ff00ff', alpha: 1 });
    expect(argbToCss(0x8000ff00).alpha).toBeCloseTo(128 / 255);
  });
});

describe('which objects get tags (Decal ObjectClass)', () => {
  it('players, monsters, pets, NPCs, vendors and portals; nothing else', () => {
    expect(nametagBaseType(CREATURE, PLAYER | ATTACKABLE)).toBe('Player');
    expect(nametagBaseType(CREATURE, ATTACKABLE)).toBe('Monster');
    expect(nametagBaseType(CREATURE, ATTACKABLE, 0x50000001)).toBe('Pet');
    expect(nametagBaseType(CREATURE, 0)).toBe('Npc');
    expect(nametagBaseType(CREATURE, VENDOR)).toBe('Vendor');
    expect(nametagBaseType(0x10000, PORTAL)).toBe('Portal');
    expect(nametagBaseType(0x1, 0)).toBeNull(); // a sword
    expect(nametagBaseType(0x200, 0x2000)).toBeNull(); // a corpse
    expect(nametagBaseType(0, 0x1000)).toBeNull(); // a door
  });
});

describe('tag text (BitcoinMiner.UpdateData)', () => {
  it('a player: name, then [level] and <monarch> once appraised', () => {
    expect(nametagLabel('Player', 1, 'Bob', null, null)).toEqual({ type: 'Player', tag: 'Bob', ticker: null });
    expect(nametagLabel('Player', 1, 'Bob', { level: 42, monarchTitle: 'Grand Duke Sir Al' }, null))
      .toEqual({ type: 'Player', tag: 'Bob [42]', ticker: '<Sir Al>' });
    // A monarch shows their own name.
    expect(nametagLabel('Player', 1, 'Al', { level: 200, allegianceFollowers: 12 }, null).ticker).toBe('<Al>');
  });
  it('a player in your allegiance is an AllegiancePlayer', () => {
    const mine = nametagAllegiance({ members: [{ guid: 10, parentGuid: 0, name: 'Queen Bee' }, { guid: 11, parentGuid: 10, name: 'Me' }] });
    expect(mine?.monarchName).toBe('Queen Bee');
    expect(nametagLabel('Player', 99, 'Stranger', { level: 5, monarchTitle: 'King Queen Bee' }, mine).type).toBe('AllegiancePlayer');
    expect(nametagLabel('Player', 10, 'Queen Bee', { level: 5, allegianceFollowers: 3 }, mine).type).toBe('AllegiancePlayer');
    expect(nametagLabel('Player', 98, 'Other', { level: 5, monarchTitle: 'King Someone' }, mine).type).toBe('Player');
    expect(nametagLabel('Player', 98, 'Other', { level: 5 }, mine).type).toBe('Player');
    expect(nametagAllegiance({ members: [] })).toBeNull();
  });
  it('monsters get [level]; portals a <destination> ticker; NPCs, vendors and pets the name', () => {
    expect(nametagLabel('Monster', 1, 'Drudge Slinker', { level: 8 }, null).tag).toBe('Drudge Slinker [8]');
    expect(nametagLabel('Portal', 1, 'Portal to Holtburg', { portalDestination: 'Holtburg' }, null).ticker).toBe('<Holtburg>');
    expect(nametagLabel('Portal', 1, 'Portal', null, null).ticker).toBeNull();
    expect(nametagLabel('Npc', 1, 'Town Crier', { level: 30 }, null)).toEqual({ type: 'Npc', tag: 'Town Crier', ticker: null });
    expect(nametagLabel('Vendor', 1, 'Grocer', null, null).type).toBe('Vendor');
    expect(nametagLabel('Pet', 1, 'Wolf', { level: 50 }, null).tag).toBe('Wolf');
  });
  it('strips ACE allegiance titles (one or two words) from MonarchsTitle', () => {
    expect(monarchNameFromTitle('King Bob')).toBe('Bob');
    expect(monarchNameFromTitle('High Queen Mary Ann')).toBe('Mary Ann');
    expect(monarchNameFromTitle("Mu'allima Zara")).toBe('Zara');
    expect(monarchNameFromTitle('Nobody')).toBe('Nobody');
  });
  it('reads level, heritage, allegiance and destination from an appraisal', () => {
    expect(nametagAppraisal({ int: { 25: 12, 188: 8, 35: 4 }, string: { 21: 'Lord X', 38: 'Arwic' } }))
      .toEqual({ level: 12, heritage: 8, allegianceFollowers: 4, monarchTitle: 'Lord X', portalDestination: 'Arwic' });
    expect(nametagAppraisal(undefined)).toBeNull();
  });
});

describe('height above the object (UpdateDisplay)', () => {
  it('1.1 object heights, more for Lugians and other non-humans, not Tumeroks', () => {
    expect(nametagHeight(2)).toBeCloseTo(2.2);
    expect(nametagHeight(2, 8)).toBeCloseTo(2.62);
    expect(nametagHeight(2, 6)).toBeCloseTo(2.4);
    expect(nametagHeight(2, 7)).toBeCloseTo(2.2);
    expect(nametagHeight(2, 1)).toBeCloseTo(2.2);
    expect(nametagHeight(0)).toBeCloseTo(1.1);
  });
});

describe('choosing tags', () => {
  const me = { x: 0, y: 0, z: 0 };
  it('nothing while off', () => {
    const off = readNametagSettings((n) => store().get(n));
    expect(chooseNametags([src(1, 'Monster', 5)], off, me, 0, null)).toEqual([]);
  });
  it('within MaxRange, nearest first, never yourself, only enabled types, with the type\'s display', () => {
    const s = settingsOn((st) => st.setText('Nametags.Npc.Enabled', 'false'));
    const got = chooseNametags([
      src(1, 'Monster', 20), src(2, 'Player', 5), src(3, 'Portal', 36), src(4, 'Npc', 3), src(7, 'Player', 1), src(5, 'Vendor', 0, { y: 34.9 }),
    ], s, me, 7, null);
    expect(got.map((e) => e.guid)).toEqual([2, 1, 5]);
    expect(got[1]).toMatchObject({ type: 'Monster', tag: 'Obj1', dist: 20, display: { tagColor: -65536, tagSize: 0.15 } });
    expect(got[0].lift).toBeCloseTo(1.98);
  });
  it('caps the count at the nearest NAMETAG_MAX', () => {
    const many = Array.from({ length: NAMETAG_MAX + 20 }, (_, i) => src(i + 1, 'Monster', 30 - i * 0.1));
    const got = chooseNametags(many, settingsOn(), me, 0, null);
    expect(got.length).toBe(NAMETAG_MAX);
    expect(got[0].guid).toBe(NAMETAG_MAX + 20);
  });
  it('an allegiance member takes the AllegiancePlayer colours, and that type can be turned off alone', () => {
    const al = nametagAllegiance({ members: [{ guid: 2, parentGuid: 0, name: 'Obj2' }] });
    const on = chooseNametags([src(2, 'Player', 5, { appraisal: { level: 3, allegianceFollowers: 1 } })], settingsOn(), me, 0, al);
    expect(on[0]).toMatchObject({ type: 'AllegiancePlayer', ticker: '<Obj2>', display: { tagColor: -16711936 } });
    const off = settingsOn((st) => st.setText('Nametags.AllegiancePlayer.Enabled', 'false'));
    expect(chooseNametags([src(2, 'Player', 5, { appraisal: { level: 3, allegianceFollowers: 1 } })], off, me, 0, al)).toEqual([]);
  });
});

describe('assessing what lacks a level or destination (UB TryAssess)', () => {
  it('who needs it', () => {
    expect(nametagNeedsAssess('Player', null, false)).toBe(true);
    expect(nametagNeedsAssess('Player', { level: 3 }, true)).toBe(false);
    expect(nametagNeedsAssess('Monster', {}, true)).toBe(true);
    expect(nametagNeedsAssess('Portal', null, false)).toBe(true);
    expect(nametagNeedsAssess('Portal', {}, true)).toBe(false);
    expect(nametagNeedsAssess('Npc', null, false)).toBe(false);
    expect(nametagNeedsAssess('Pet', null, false)).toBe(false);
  });
  it('5 s apart, only when closer than the last try, at most 10 tries', () => {
    const q = new NametagAssessQueue();
    expect(q.want(1, 30, 0)).toBe(true);
    expect(q.want(1, 20, 1000)).toBe(false); // too soon
    expect(q.want(1, 30, 6000)).toBe(false); // not closer
    expect(q.want(1, 29, 6000)).toBe(true);
    let tries = 2;
    for (let i = 0; i < 20; i++) if (q.want(1, 28 - i, 12000 + i * 6000)) tries++;
    expect(tries).toBe(NAMETAG_ASSESS_TRIES);
  });
});

describe('the sprite overlay', () => {
  const factory = () => {
    const draws: string[] = [];
    return {
      draws,
      make: (text: string, css: string) => { draws.push(`${css}|${text}`); return { texture: new THREE.Texture(), width: text.length * 6, height: 12 }; },
    };
  };
  const entry = (guid: number, tag: string, ticker: string | null = null) => ({
    guid, type: 'Monster' as const, tag, ticker, lift: 2, dist: 1,
    display: { enabled: true, tagColor: -65536, tagSize: 0.15, tickerColor: -16711936, tickerSize: 0.1 },
  });

  it('adds a group only while there are tags; ticker under the tag; follows the object', () => {
    const scene = new THREE.Scene();
    const f = factory();
    const o = new NametagOverlay(scene, f.make);
    expect(scene.children).not.toContain(o.group);
    o.setTags([entry(1, 'Rat [2]', '<x>')]);
    expect(scene.children).toContain(o.group);
    expect(f.draws).toEqual(['#ff0000|Rat [2]', '#00ff00|<x>']);
    o.follow(() => ({ x: 10, y: 1, z: 20 }));
    const s = o.spritesOf(1)!;
    expect(s.ticker.position.toArray()).toEqual([10, 3, 20]);
    expect(s.tag.position.y).toBeCloseTo(3.1);
    expect(s.tag.scale.y).toBeCloseTo(0.15);
    expect(s.tag.scale.x).toBeCloseTo(0.15 * (7 * 6) / 12);
    expect(s.tag.visible && s.ticker.visible).toBe(true);
    // No ticker: the tag sits at the anchor.
    o.setTags([entry(1, 'Rat [2]')]);
    o.follow(() => ({ x: 0, y: 0, z: 0 }));
    expect(s.tag.position.y).toBeCloseTo(2);
    expect(s.ticker.visible).toBe(false);
    // A lost object hides its tag for the frame.
    o.follow(() => null);
    expect(s.tag.visible).toBe(false);
    o.clear();
    expect(scene.children).not.toContain(o.group);
    expect(o.count).toBe(0);
  });

  it('redraws a texture only when its text or colour changes, and reuses pooled sprites', () => {
    const scene = new THREE.Scene();
    const f = factory();
    const o = new NametagOverlay(scene, f.make);
    o.setTags([entry(1, 'A'), entry(2, 'B')]);
    const before = o.textureDraws;
    o.setTags([entry(1, 'A'), entry(2, 'B')]);
    expect(o.textureDraws).toBe(before);
    o.setTags([entry(1, 'A [5]'), entry(2, 'B')]);
    expect(o.textureDraws).toBe(before + 1);
    const spriteOf2 = o.spritesOf(2)!.tag;
    o.setTags([entry(1, 'A [5]')]);
    expect(o.count).toBe(1);
    o.setTags([entry(1, 'A [5]'), entry(3, 'C')]);
    const reused = [o.spritesOf(3)!.tag, o.spritesOf(3)!.ticker];
    expect(reused).toContain(spriteOf2);
  });

  it('skips a tag until the font is ready, then draws it', () => {
    const scene = new THREE.Scene();
    let ready = false;
    const o = new NametagOverlay(scene, (t) => (ready ? { texture: new THREE.Texture(), width: t.length * 6, height: 12 } : null));
    o.setTags([entry(1, 'A')]);
    o.follow(() => ({ x: 0, y: 0, z: 0 }));
    expect(o.spritesOf(1)!.tag.visible).toBe(false);
    ready = true;
    o.setTags([entry(1, 'A')]);
    o.follow(() => ({ x: 0, y: 0, z: 0 }));
    expect(o.spritesOf(1)!.tag.visible).toBe(true);
  });
});

describe('live fixes (2026-10-12, the training hall)', () => {
  it('a tag goes over the higher of the physics height and the drawn model (a golem\'s cylinder is lower than its trunk)', () => {
    expect(nametagObjectHeight(1.8, 2.9)).toBe(2.9);
    expect(nametagObjectHeight(2.2, 1.5)).toBe(2.2);
    expect(nametagObjectHeight(undefined, 0)).toBe(0);
  });

  it('the text texture is flipped once on X, against the world camera\'s mirror (WorldMirror), so tags read forwards', () => {
    const t = nametagTextureFromCanvas({ width: 40, height: 10 } as unknown as HTMLCanvasElement);
    expect([t.texture.repeat.x, t.texture.offset.x]).toEqual([-1, 1]);
  });
});

