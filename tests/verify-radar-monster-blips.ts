/**
 * BUG.radar-monsters-missing — "monsters don't appear on my radar, they
 * should as orange".
 *
 * ACE sends no RadarBlipColor for monsters (drudgeskulker, ratsewer,
 * mosswartyoung … carry only PropertyInt.ShowableOnRadar = 2 in the world
 * DB), so the wire color is 0. Our radar treated color 0 as "no dot".
 * Retail never gates on the color: gmRadarUI::AddObject @ 004d9a00 needs
 * InqShowableOnRadar @ 0058c250 (radar_enum 2/3/4) and not UI-hidden, and
 * gmRadarUI::GetBlipColor @ 004d76f0 colors a 0-color attackable
 * non-player creature RGBAColor_RadarCreature = RadarGold {1, 0.67, 0}.
 *
 * Drives the real CreateObject parser → ServerObjectManager.radarDotEligible
 * → RadarDotFeed → GameUI-ready CSS color.
 */
import { describe, it, expect } from 'vitest';
import { ObjectDescriptionFlag, ItemType, RadarBehavior } from '@ac/shared';
import { parseCreateObject } from '../packages/network/src/MessageSerializer.js';
import {
  RadarDotFeed, selectBlipColor, radarRgbaToCss, showableOnRadar, RADAR_RGBA,
  type BlipColorInputs, type RadarFeedContext, type RadarFeedObject,
} from '../packages/renderer/src/ui/RadarBlips.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';

const WEENIE_FLAG_RADAR_BLIP_COLOR = 0x00100000;
const WEENIE_FLAG_RADAR_BEHAVIOR = 0x00800000;

class Writer {
  private bytes: number[] = [];
  private get pos(): number { return this.bytes.length; }
  u8(v: number): this { this.bytes.push(v & 0xff); return this; }
  u16(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  align(boundary = 4): this { const rem = this.pos % boundary; if (rem !== 0) for (let i = 0; i < boundary - rem; i++) this.u8(0); return this; }
  string16(s: string): this {
    this.u16(s.length);
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this.align(4);
  }
  toUint8Array(): Uint8Array { return new Uint8Array(this.bytes); }
}

/** A CreateObject as ACE writes it (WorldObject_Networking.cs), header fields only. */
function createObject(opts: {
  name: string; itemType: number; odf: number; radarColor?: number; radarBehavior?: number;
}): Uint8Array {
  let flags = 0;
  if (opts.radarColor !== undefined) flags |= WEENIE_FLAG_RADAR_BLIP_COLOR;
  if (opts.radarBehavior !== undefined) flags |= WEENIE_FLAG_RADAR_BEHAVIOR;
  const w = new Writer();
  w.u32(0x80001234);
  w.u8(0x11).u8(0).u8(0).u8(0);
  w.align(4);
  w.u32(0); w.u32(0);
  for (let i = 0; i < 9; i++) w.u16(0);
  w.align(4);
  w.u32(flags);
  w.string16(opts.name);
  w.u16(1);                 // weenieClassId (packed)
  w.u16(1);                 // iconId (packed)
  w.u32(opts.itemType);
  w.u32(opts.odf);
  w.align(4);
  if (opts.radarColor !== undefined) w.u8(opts.radarColor);
  if (opts.radarBehavior !== undefined) w.u8(opts.radarBehavior);
  w.align(4);
  return w.toUint8Array();
}

function colorInputs(over: Partial<BlipColorInputs>): BlipColorInputs {
  return { blipColor: 0, objectDescFlags: 0, itemType: 0, isFellow: false, isFellowshipLeader: false, ...over };
}

const A = ObjectDescriptionFlag;

describe('BUG.radar-monsters-missing — a monster (no RadarBlipColor) gets an orange blip', () => {
  it('the retail palette converts via GetColor32 (×255, truncate): Creature gold is #ffaa00', () => {
    expect(radarRgbaToCss(RADAR_RGBA.Gold)).toBe('#ffaa00');
    expect(radarRgbaToCss(RADAR_RGBA.White)).toBe('#ffffff');
    expect(radarRgbaToCss(RADAR_RGBA.Blue)).toBe('#3fa8ff');
    expect(radarRgbaToCss(RADAR_RGBA.Purple)).toBe('#bf63ff');
    expect(radarRgbaToCss(RADAR_RGBA.Red)).toBe('#ff3f63');
    expect(radarRgbaToCss(RADAR_RGBA.Yellow)).toBe('#ffff7f');
    expect(radarRgbaToCss(RADAR_RGBA.BrightGreen)).toBe('#00ff00');
  });

  it('parsed drudge CreateObject → eligible → one #ffaa00 dot on the radar', () => {
    const parsed = parseCreateObject(createObject({
      name: 'Drudge Skulker', itemType: ItemType.Creature, odf: A.Attackable,
      radarBehavior: RadarBehavior.ShowMovement,
    }))!;
    expect(parsed.radarColor).toBe(0);
    expect(parsed.radarBehavior).toBe(RadarBehavior.ShowMovement);
    const obj: RadarFeedObject & { radarBehavior: number; uiHidden: boolean } = {
      guid: parsed.guid, name: parsed.name, worldX: 10, worldY: 0, worldZ: 10,
      radarColor: parsed.radarColor, radarBehavior: parsed.radarBehavior,
      objectDescFlags: parsed.objectDescFlags, itemType: parsed.itemType, uiHidden: false,
    };
    const ctx: RadarFeedContext<typeof obj> = {
      playerWorldX: 0, playerWorldZ: 0, playerFeetY: 0, range: 75,
      fellows: null, fellowshipLeaderGuid: 0, playerMonarchGuid: undefined, playerPKStatus: undefined,
      eligible: (o) => ServerObjectManager.radarDotEligible(o),
    };
    const dots = new RadarDotFeed<typeof obj>().build([obj], ctx);
    expect(dots).toHaveLength(1);
    expect(dots[0].guid).toBe(0x80001234);
    expect(dots[0].color).toBe('#ffaa00');
  });

  it('no RadarBehavior on the wire (Undefined) → no blip, as retail InqShowableOnRadar', () => {
    const parsed = parseCreateObject(createObject({ name: 'Rock', itemType: ItemType.Misc, odf: 0 }))!;
    expect(showableOnRadar(parsed.radarBehavior, false)).toBe(false);
    expect(showableOnRadar(RadarBehavior.ShowNever, false)).toBe(false);
    expect(showableOnRadar(RadarBehavior.ShowAttacking, false)).toBe(true);
    expect(showableOnRadar(RadarBehavior.ShowAlways, true)).toBe(false);   // UI-hidden
  });
});

describe('gmRadarUI::GetBlipColor @ 004d76f0 branch order', () => {
  it('an explicit blip color wins over the type rules (NPC yellow, lifestone blue)', () => {
    expect(selectBlipColor(colorInputs({ blipColor: 8, itemType: ItemType.Creature, objectDescFlags: A.Attackable }))).toBe(RADAR_RGBA.Yellow);
    expect(selectBlipColor(colorInputs({ blipColor: 1 }))).toBe(RADAR_RGBA.Blue);
    expect(selectBlipColor(colorInputs({ blipColor: 10 }))).toBe(RADAR_RGBA.BrightGreen); // case 10 decimal
    expect(selectBlipColor(colorInputs({ blipColor: 0x10 }))).toBe(RADAR_RGBA.White);     // ACE's 0x10 → default
  });

  it('portal → purple, vendor → yellow, before the creature test', () => {
    expect(selectBlipColor(colorInputs({ objectDescFlags: A.Portal }))).toBe(RADAR_RGBA.Purple);
    expect(selectBlipColor(colorInputs({ objectDescFlags: A.Vendor | A.Attackable, itemType: ItemType.Creature }))).toBe(RADAR_RGBA.Yellow);
  });

  it('creature needs Attackable: a non-attackable creature (peaceful NPC without color) is white', () => {
    expect(selectBlipColor(colorInputs({ itemType: ItemType.Creature, objectDescFlags: A.Attackable }))).toBe(RADAR_RGBA.Gold);
    expect(selectBlipColor(colorInputs({ itemType: ItemType.Creature, objectDescFlags: 0 }))).toBe(RADAR_RGBA.White);
    expect(selectBlipColor(colorInputs({ itemType: ItemType.Misc, objectDescFlags: A.Attackable }))).toBe(RADAR_RGBA.White);
  });

  it('players: admin (not hidden) cyan, PK red, PKLite pink, else white; fellows bright green', () => {
    const P = A.Player | A.Attackable;
    const player = (odf: number, over: Partial<BlipColorInputs> = {}) =>
      selectBlipColor(colorInputs({ itemType: ItemType.Creature, objectDescFlags: P | odf, ...over }));
    expect(player(0)).toBe(RADAR_RGBA.White);                 // an attackable player is not "creature gold"
    expect(player(A.Admin)).toBe(RADAR_RGBA.Cyan);
    expect(player(A.Admin | A.HiddenAdmin)).toBe(RADAR_RGBA.White);
    expect(player(A.PlayerKiller)).toBe(RADAR_RGBA.Red);
    expect(player(A.PkLiteStatus)).toBe(RADAR_RGBA.Pink);
    expect(player(A.FreePkStatus)).toBe(RADAR_RGBA.Gold);
    expect(player(A.PlayerKiller, { isFellow: true })).toBe(RADAR_RGBA.BrightGreen);
    expect(player(0, { isFellowshipLeader: true })).toBe(RADAR_RGBA.BrightGreen);
    // Fellowship override applies to players only.
    expect(selectBlipColor(colorInputs({ itemType: ItemType.Creature, objectDescFlags: A.Attackable, isFellow: true }))).toBe(RADAR_RGBA.Gold);
  });
});
