#!/usr/bin/env npx tsx
/**
 * Pull the promo videos' sound effects out of the game's own portal.dat as .wav files.
 *
 *   npx tsx tools/video/extract-sfx.ts --out <dir> [--dat dat/client_portal.dat]
 *
 * The capture (CDP screencast) records no audio, so build-promo.mjs lays these under the cuts
 * from each clip's `sfx` list. Named after the Sound enum (ACE Sound.cs); UI sounds come from the
 * client's UI table 0x2000004B (RetailLocalSounds.ts), the player's from the human male table 0x20000001.
 * Every variant is written (`launch-0.wav`, `launch-1.wav` …) so an edit can pick by ear.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../../packages/dat-parser/src/node/FileDatBytes.js';
import { SoundTable } from '../../packages/dat-parser/src/file-types/SoundTable.js';
import { Wave } from '../../packages/dat-parser/src/file-types/Wave.js';
import { Sound } from '@ac/shared';

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const out = resolve(opt('out', 'sfx')!);
const db = new DatDatabase(new FileDatBytes(resolve(opt('dat', 'dat/client_portal.dat')!)));
mkdirSync(out, { recursive: true });

const UI_TABLE = 0x2000004b;
// The human male player's table (the Setup carries none; the player weenie's SoundTable DID).
const humanTable = 0x20000001;
const WANT: [number, Sound[]][] = [
  [UI_TABLE, [Sound.UI_EnterPortal, Sound.UI_ExitPortal, Sound.UI_ButtonPress]],
  [humanTable, [Sound.Launch, Sound.Fizzle, Sound.Swoosh1, Sound.Swoosh2, Sound.HitFlesh1, Sound.Footstep1]],
];
for (const [tableId, sounds] of WANT) {
  const table = SoundTable.read(db.getReader(tableId));
  for (const s of sounds) {
    const variants = table.data.get(s)?.data ?? [];
    variants.forEach((v, i) => {
      if (!v.soundId) return;
      const wave = new Wave(db.getReader(v.soundId));
      const name = `${Sound[s].replace(/^UI_/, '').toLowerCase()}-${i}`;
      const file = join(out, `${name}.${wave.isMP3 ? 'mp3' : 'wav'}`);
      writeFileSync(file, wave.isMP3 ? wave.data : new Uint8Array(wave.toWavBuffer()));
      console.log(`${file}  (wave 0x${v.soundId.toString(16)}, table 0x${tableId.toString(16)})`);
    });
  }
}
