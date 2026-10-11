/**
 * The AC1999 server's placed objects in one landblock (its landblock_instance rows,
 * reference/ac1999/Server/Database/AC1999-World/3-Core/6 LandBlockExtendedData/SQL/<XXYY>.sql), each with what
 * its weenie (3-Core/9 WeenieDefaults/SQL/**) says about it: name, Setup, ItemType, PhysicsState, Locked.
 * The offline walk (dungeonWalk.ts) collides with the ones that aren't creatures, as the live client does
 * with its "fixtures" (main.ts agentNav: ServerObjectManager.getBlockersNear stills): signs, doors, the
 * lifestone. Absent reference data: an empty list.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Ac1999Fixture {
  guid: number;
  wcid: number;
  name: string;
  cell: number;
  x: number; y: number; z: number;
  quat: { w: number; x: number; y: number; z: number };
  setupId: number;
  itemType: number;
  physicsState: number;
  locked: boolean;
  door: boolean;
}

const WORLD = resolve(__dirname, '..', '..', 'reference/ac1999/Server/Database/AC1999-World/3-Core');

export const ac1999WorldPresent = (): boolean => existsSync(WORLD);

let weenieFiles: Map<number, string> | null = null;
function weenieFile(wcid: number): string | null {
  if (!weenieFiles) {
    weenieFiles = new Map();
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else { const m = /^(\d+) /.exec(f); if (m) weenieFiles!.set(Number(m[1]), p); }
      }
    };
    walk(join(WORLD, '9 WeenieDefaults/SQL'));
  }
  return weenieFiles.get(wcid) ?? null;
}

export function ac1999Fixtures(landblock: number): Ac1999Fixture[] {
  const lb = ((landblock >>> 16) & 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const file = join(WORLD, '6 LandBlockExtendedData/SQL', `${lb}.sql`);
  if (!existsSync(file)) return [];
  const out: Ac1999Fixture[] = [];
  const row = /VALUES \((0x[0-9A-F]+),\s*(\d+),\s*(0x[0-9A-F]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),/gi;
  for (const m of readFileSync(file, 'utf8').matchAll(row)) {
    const wcid = Number(m[2]);
    const wf = weenieFile(wcid);
    if (!wf) continue;
    const w = readFileSync(wf, 'utf8');
    const num = (re: RegExp): number | null => { const r = re.exec(w); return r ? Number(r[1]) : null; };
    const setupId = num(new RegExp(`\\(${wcid},\\s+1,\\s+(0x[0-9A-F]+)\\) /\\* Setup \\*/`, 'i'));
    if (!setupId) continue;
    // WeenieType 19 = Door (ACE WeenieType.Door).
    const door = new RegExp(`VALUES \\(${wcid}, '[^']*', 19,`).test(w);
    out.push({
      guid: Number(m[1]) >>> 0, wcid,
      name: /\(\d+,\s+1, '([^']*)'\) \/\* Name \*\//.exec(w)?.[1]?.trim() ?? '',
      cell: Number(m[3]) >>> 0,
      x: Number(m[4]), y: Number(m[5]), z: Number(m[6]),
      quat: { w: Number(m[7]), x: Number(m[8]), y: Number(m[9]), z: Number(m[10]) },
      setupId: setupId >>> 0,
      itemType: num(new RegExp(`\\(${wcid},\\s+1,\\s+(\\d+)\\) /\\* ItemType`)) ?? 0,
      physicsState: num(new RegExp(`\\(${wcid},\\s+93,\\s+(\\d+)\\) /\\* PhysicsState`)) ?? 0,
      locked: new RegExp(`\\(${wcid},\\s+3, True \\) /\\* Locked \\*/`).test(w),
      door,
    });
  }
  return out;
}
