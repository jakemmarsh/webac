/**
 * 1999 logout / login effects (Jake, 2026-10-06: "logout animation is wrong
 * too? it seems to use an emote effect instead of the bubbly purply effect").
 *
 * Verdict: our client plays what the 1999 server and 1999 DATs say, and that
 * is the 1999 behaviour.
 *  - Login / teleport bubbles are the object's OWN PhysicsScriptTable (the
 *    wire PeTable from its CreateObject) through set_hidden's Hidden / UnHide,
 *    never a hardcoded table id. The 1999 human table (0x34000004, served
 *    with EoL PlayScript keys by transcodePhysicsScriptTable1999) maps them
 *    to the same purple-bubble scripts as end of retail.
 *  - Logout: the purple-bubble logout ("Added new logout motion and
 *    animation. Now, when a player logs out, they get purple bubbly effects
 *    and fade out.") arrived in the September 2000 Twilight's Gleaming patch.
 *    The 1999 motion tables have no LogOut motion, so the AC1999 server
 *    (Player.cpp CPlayerWeenie::OnLogout) plays Motion_Sanctuary, the
 *    lifestone gesture whose animation carries its own hand particles. That
 *    gesture is the "emote" Jake saw, and it is correct for 1999.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PlayScript } from '@ac/shared';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { PhysicsScript, PhysicsScriptTable } from '../packages/dat-parser/src/file-types/PhysicsScript.js';
import { MotionTable } from '../packages/dat-parser/src/file-types/MotionTable.js';
import { Animation } from '../packages/dat-parser/src/file-types/Animation.js';
import { AnimationHookType } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';
import { playScriptType, type PlayScriptSink } from '../packages/renderer/src/effects/PlayScriptResolve.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const table = (id: number, entries: Array<[number, number]>): PhysicsScriptTable => {
  const t = new PhysicsScriptTable();
  t.id = id;
  for (const [k, scriptId] of entries) t.scripts.set(k, [{ mod: 1, scriptId }]);
  return t;
};

describe('a PlayScript resolves through the TARGET object\'s own PhysicsScriptTable', () => {
  // Two tables loaded side by side: the end-of-retail human id and another era's.
  const tables = new Map<number, PhysicsScriptTable>([
    [0x34000004, table(0x34000004, [[PlayScript.Hidden, 0x33000331], [PlayScript.UnHide, 0x3300032f]])],
    [0x34000042, table(0x34000042, [[PlayScript.Hidden, 0x33000999], [PlayScript.UnHide, 0x33000998]])],
  ]);
  const sink = (peTableId: number, loaded: number[]): PlayScriptSink<string> => ({
    target: () => ({ anchor: 'player', peTableId, setupId: 0x02000001 }),
    loadTable: (id) => { loaded.push(id); return tables.get(id) ?? null; },
    setupScriptTable: () => 0,
    loadScript: (id) => ({ id, steps: [] }) as unknown as PhysicsScript,
    play: () => {},
  });

  it('end of retail (wire PeTable 0x34000004) is unchanged: Hidden / UnHide → 0x33000331 / 0x3300032F', () => {
    const loaded: number[] = [];
    expect(playScriptType(sink(0x34000004, loaded), 1, PlayScript.Hidden, 1)).toMatchObject({ played: true, scriptId: 0x33000331, tableId: 0x34000004 });
    expect(playScriptType(sink(0x34000004, loaded), 1, PlayScript.UnHide, 1)).toMatchObject({ played: true, scriptId: 0x3300032f, tableId: 0x34000004 });
    expect(new Set(loaded)).toEqual(new Set([0x34000004]));
  });

  it('a different wire PeTable is the one used; 0x34000004 is never consulted', () => {
    const loaded: number[] = [];
    expect(playScriptType(sink(0x34000042, loaded), 1, PlayScript.Hidden, 1)).toMatchObject({ played: true, scriptId: 0x33000999, tableId: 0x34000042 });
    expect(playScriptType(sink(0x34000042, loaded), 1, PlayScript.UnHide, 1)).toMatchObject({ played: true, scriptId: 0x33000998, tableId: 0x34000042 });
    expect(loaded).not.toContain(0x34000004);
  });
});

const AC1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail', 'portal.dat');
const HAS_1999 = existsSync(AC1999);
const HAS_EOL = existsSync(DAT_PATHS.portal);

type Hook = { hookType: number; emitterInfoId?: number; emitterId?: number; start?: number; end?: number; time?: number };

describe.skipIf(!HAS_1999)('1999 portal.dat: the login / teleport bubbles and the logout gesture', () => {
  let portal: DatDatabase;
  const served = (id: number): ArrayBuffer => {
    const b = ac1999PortalOverlay().get(id, (i) => portal.getFileData(i)) ?? portal.getFileData(id);
    if (!b) throw new Error(`missing 0x${id.toString(16)}`);
    return b;
  };
  const script = (id: number) => PhysicsScript.read(new DatReader(served(id)));
  const hooks = (id: number) => script(id).steps.map((s) => s.hook as unknown as Hook);
  beforeAll(() => { portal = openDat(AC1999); });

  it('the human table (as served, EoL keys) plays the purple-bubble scripts for Hidden / UnHide / Hide', () => {
    const human = PhysicsScriptTable.read(new DatReader(served(0x34000004)));
    const sink: PlayScriptSink<string> = {
      target: () => ({ anchor: 'player', peTableId: 0x34000004, setupId: 0 }),
      loadTable: (id) => (id === 0x34000004 ? human : null),
      setupScriptTable: () => 0,
      loadScript: (id) => script(id),
      play: () => {},
    };
    expect(playScriptType(sink, 1, PlayScript.Hidden, 1)).toMatchObject({ played: true, scriptId: 0x33000331 });
    expect(playScriptType(sink, 1, PlayScript.UnHide, 1)).toMatchObject({ played: true, scriptId: 0x3300032f });
    expect(playScriptType(sink, 1, PlayScript.Hide, 1)).toMatchObject({ played: true, scriptId: 0x33000332 });
  });

  it('Hidden builds the 14 bubble emitters 0x3200028B / 0x3200028C; UnHide stops them all and fades in', () => {
    const created = hooks(0x33000331).filter((h) => h.hookType === AnimationHookType.CreateParticle);
    expect(created).toHaveLength(14);
    expect(new Set(created.map((h) => h.emitterInfoId))).toEqual(new Set([0x3200028b, 0x3200028c]));
    const unhide = hooks(0x3300032f);
    expect(unhide.filter((h) => h.hookType === AnimationHookType.StopParticle).map((h) => h.emitterId).sort())
      .toEqual(created.map((h) => h.emitterId).sort());
    expect(unhide.find((h) => h.hookType === AnimationHookType.Transparent)).toMatchObject({ start: 1, end: 0, time: 0.75 });
  });

  it('logout: no LogOut motion exists; the server\'s Sanctuary gesture carries its own hand particles', () => {
    const mt = new MotionTable(new DatReader(served(0x09000001)));
    const linkTargets = new Map<number, number[]>();
    for (const inner of mt.links.values()) for (const [cmd, data] of inner) linkTargets.set(cmd, data.anims.map((a) => a.animId));
    expect(linkTargets.has(MotionCommand.LogOut)).toBe(false);
    const sanctuary = linkTargets.get(MotionCommand.Sanctuary);
    expect(sanctuary).toContain(0x030003c2);
    const anim = new Animation(new DatReader(served(0x030003c2)));
    const particles = anim.partFrames.flatMap((f) => f.hooks as unknown as Hook[])
      .filter((h) => h.hookType === AnimationHookType.CreateParticle).map((h) => h.emitterInfoId);
    expect(particles).toContain(0x32000029);
  });

  it.skipIf(!HAS_EOL)('end of retail, by contrast, has the LogOut motion (the 2000-09 bubble logout)', () => {
    const eol = openDat(DAT_PATHS.portal);
    const mt = new MotionTable(new DatReader(eol.getFileData(0x09000001)!));
    const cmds = new Set<number>();
    for (const inner of mt.links.values()) for (const cmd of inner.keys()) cmds.add(cmd);
    expect(cmds.has(MotionCommand.LogOut)).toBe(true);
  });
});
