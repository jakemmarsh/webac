/**
 * BUG.invented-landing-dust-footstep — main.ts spawned a brown dust puff
 * (FAITHFUL.207) and played Sound.Footstep1 from the human table
 * (FAITHFUL.423) whenever the player landed. Neither exists in retail.
 *
 * Retail landing (decompiled acclient, build ac1_sep13):
 * CPhysicsObj::set_on_walkable @ 00511310 → MovementManager::HitGround
 * @ 00524300 → CMotionInterp::HitGround @ 00528ac0, which only removes the
 * link animations and re-applies the current movement. There is no sound
 * or particle call; anything heard or seen on landing would be a hook on
 * the animations the motion table plays next — and for humans there is
 * none. This test pins that DAT evidence (the removed code was inline
 * frame-loop code; the old test only regex-matched it).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sound } from '@ac/shared';
import { openDat } from './_harness/dat.js';

const PORTAL = resolve(__dirname, '..', 'dat/client_portal.dat');
const hasDat = existsSync(PORTAL);
const FALLING = 0x40000015;

describe.skipIf(!hasDat)('human landing plays nothing (needs DAT)', () => {
  let links: Array<{ from: number; to: number; hooks: number }> = [];
  let footstep: boolean[] = [];
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { MotionTable } = await import('../packages/dat-parser/src/file-types/MotionTable.js');
    const { Animation } = await import('../packages/dat-parser/src/file-types/Animation.js');
    const { SoundTable } = await import('../packages/dat-parser/src/file-types/SoundTable.js');
    const db = openDat(PORTAL);
    const mt = new MotionTable(new DatReader(db.getFileData(0x09000001)!));
    const hookCount = (animId: number) => {
      const a = new Animation(new DatReader(db.getFileData(animId)!));
      return a.partFrames.reduce((n, f) => n + f.hooks.length, 0);
    };
    for (const [outer, inner] of mt.links) {
      for (const [to, md] of inner) {
        // Landing = a link OUT of Falling (style << 16 | Falling's low bits).
        if ((outer & 0xffff) === (FALLING & 0xffff)) {
          links.push({ from: outer, to, hooks: md.anims.reduce((n, a) => n + hookCount(a.animId), 0) });
        }
      }
    }
    const human = SoundTable.read(new DatReader(db.getFileData(0x20000001)!));
    footstep = [Sound.Footstep1, Sound.Footstep2].map((s) => human.data.has(s));
  });

  it('every landing link (out of Falling) in the human motion table 0x09000001 carries no hooks', () => {
    expect(links.length).toBeGreaterThan(0);
    expect(links.some((l) => l.to === 0x41000003)).toBe(true); // Falling → Ready
    expect(links.filter((l) => l.hooks > 0)).toEqual([]);
  });

  it('the human sound table 0x20000001 has no Footstep1/2 entry to thud with', () => {
    expect(footstep).toEqual([false, false]);
  });
});
