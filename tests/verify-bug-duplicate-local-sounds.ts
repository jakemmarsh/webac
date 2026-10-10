/**
 * BUG.duplicate-local-sounds + BUG.nonpositional-human-table-sounds
 * (2026-09-28) — the client plays by itself exactly what the retail client
 * plays by itself, and nothing the server (or a DAT hook) already plays.
 *
 * Retail's own sounds — every caller of SoundManager::PlaySoundFromCenter
 * @ 00550950 / 005509e0 in the EoL decomp:
 *   gmSmartBoxUI::BeginTeleportAnimation @ 004d6300 → UI_EnterPortal,
 *   gmSmartBoxUI::UseTime @ 004d6e30 → UI_ExitPortal,
 *   CPlayerSystem::Handle_Admin__Environs @ 0055de20 → UI_Roar … UI_Thunder6,
 *   MediaMachine::Update_Sound @ 004658b0 → LayoutDesc Sound media.
 * Everything we used to add on top is a server Sound message on the player
 * (wield / unwield / raise / spell expire / lifestone — see
 * audio/RetailLocalSounds for the ACE file:line of each) or an animation
 * hook (the human Dead links' Knockdown3 — no human animation plays
 * Death1), or nothing at all in retail
 * (error / transient / tell / new-target / icon pick-up-drop / container
 * open-close chimes).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import { Sound } from '@ac/shared';
import { RETAIL_CLIENT_LOCAL_SOUNDS, isRetailClientLocalSound } from '../packages/renderer/src/audio/RetailLocalSounds.js';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import {
  parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes, MediaType, type ElementDesc, type MediaDesc,
} from '@ac/dat-parser/file-types/LayoutDesc.js';
import { MotionTable } from '@ac/dat-parser/file-types/MotionTable.js';
import { Animation } from '@ac/dat-parser/file-types/Animation.js';
import { AnimationHookType } from '@ac/dat-parser/file-types/AnimationHook.js';
import { openDat } from './_harness/dat.js';

describe('the retail client-local sound set', () => {
  it('is the teleport tunnel pair, the Environs sounds and the layout button press — nothing else', () => {
    const environs: Sound[] = [];
    for (let s = Sound.UI_Roar; s <= Sound.UI_Thunder6; s++) environs.push(s);
    expect([...RETAIL_CLIENT_LOCAL_SOUNDS].sort((a, b) => a - b)).toEqual(
      [Sound.UI_EnterPortal, Sound.UI_ExitPortal, Sound.UI_ButtonPress, ...environs].sort((a, b) => a - b));
  });

  it.each([
    ['WieldObject', Sound.WieldObject], ['UnwieldObject', Sound.UnwieldObject], ['RaiseTrait', Sound.RaiseTrait],
    ['SpellExpire', Sound.SpellExpire], ['LifestoneOn', Sound.LifestoneOn], ['Death1', Sound.Death1],
    ['EnchantUp', Sound.EnchantUp], ['Open', Sound.Open], ['Close', Sound.Close],
    ['UI_GeneralError', Sound.UI_GeneralError], ['UI_TransientMessage', Sound.UI_TransientMessage],
    ['UI_NewTargetSelected', Sound.UI_NewTargetSelected], ['UI_IconPickUp', Sound.UI_IconPickUp],
    ['UI_IconSuccessfulDrop', Sound.UI_IconSuccessfulDrop],
  ])('%s is not played locally', (_name, sound) => {
    expect(isRetailClientLocalSound(sound)).toBe(false);
  });
});

const hasDat = fs.existsSync('dat/client_portal.dat') && fs.existsSync('dat/client_local_English.dat');

describe.skipIf(!hasDat)('DAT ground truth', () => {
  let portal: DatDatabase;
  let local: DatDatabase;
  beforeAll(() => {
    portal = openDat('dat/client_portal.dat');
    local = openDat('dat/client_local_English.dat');
    setMasterPropertyTypes(parseMasterProperty(new DatReader(portal.getFileData(0x39000001)!)));
  });

  it('every LayoutDesc Sound media item (MediaMachine::Update_Sound) is a retail client-local sound from the UI table', () => {
    const found: Array<{ layout: number; sType: number; table: number }> = [];
    const scan = (layout: number, media: MediaDesc[]) => {
      for (const m of media) if (m.type === MediaType.Sound) found.push({ layout, sType: m.sType ?? 0, table: m.file ?? 0 });
    };
    const walk = (layout: number, el: ElementDesc) => {
      scan(layout, el.media);
      for (const st of el.states.values()) scan(layout, st.media);
      for (const c of el.children.values()) walk(layout, c);
    };
    for (const id of local.listFileIds(0x21)) {
      const l = parseLayoutDesc(new DatReader(local.getFileData(id)!));
      for (const el of l.elements.values()) walk(id, el);
    }
    expect(found.length).toBe(3);
    for (const f of found) {
      expect(f.sType).toBe(Sound.UI_ButtonPress);
      expect(f.table >>> 0).toBe(0x2000004b);
      expect(isRetailClientLocalSound(f.sType)).toBe(true);
    }
    expect(new Set(found.map((f) => f.layout))).toEqual(new Set([0x21000006, 0x21000040, 0x2100006f]));
  });

  it('death: the human Dead links (0x09000001 → 0x030000C6) play Knockdown3 from the object\'s own table; nothing plays Death1', () => {
    const mt = new MotionTable(new DatReader(portal.getFileData(0x09000001)!));
    const DEAD = 0x40000011 & 0xffffff;
    const deadAnims = new Set<number>();
    for (const inner of mt.links.values()) {
      for (const [to, md] of inner) if ((to & 0xffffff) === DEAD) for (const a of md.anims) deadAnims.add(a.animId >>> 0);
    }
    expect(deadAnims.has(0x030000c6)).toBe(true);
    const anim = new Animation(new DatReader(portal.getFileData(0x030000c6)!));
    const hooks = anim.partFrames[0].hooks as unknown as Array<{ hookType: number; soundType?: number }>;
    expect(hooks.find((h) => h.hookType === AnimationHookType.SoundTable)?.soundType).toBe(Sound.Knockdown3);
    // No animation anywhere in the human table carries a Death1 hook.
    const anims = new Set<number>();
    for (const md of [...mt.cycles.values(), ...mt.modifiers.values()]) for (const a of md.anims) anims.add(a.animId >>> 0);
    for (const inner of mt.links.values()) for (const md of inner.values()) for (const a of md.anims) anims.add(a.animId >>> 0);
    let death1 = 0;
    for (const id of anims) {
      const d = portal.getFileData(id);
      if (!d) continue;
      for (const f of new Animation(new DatReader(d)).partFrames) {
        for (const h of f.hooks as unknown as Array<{ hookType: number; soundType?: number }>) {
          if (h.hookType === AnimationHookType.SoundTable && h.soundType === Sound.Death1) death1++;
        }
      }
    }
    expect(death1).toBe(0);
  });
});
