/**
 * Stream segment 09:11–10:15Z, 2026-10-17, end-of-retail local ACE, build 7cfeb418: Claude Arcanist (mage) and Claude
 * Bulwark (soldier) farming Dread Mu-miyahs in Mountain Keep (dungeon 0x01D2). Reports
 * stream/reports/{mage-2026-10-17T10-12-27-049Z,soldier-2026-10-17T10-14-34-607Z}-seg1.md, transcripts
 * stream/sessions/{mage,soldier}-2026-10-17-seg1.jsonl, page traces mage.log / soldier.log (game clock = Z − 4 h).
 *
 * 1. use on the Holtburg portal (#701D2027, 0x01D201F7 at z −6) from Bulwark's spot a floor under it (0x01D2010C,
 *    z −12): the use's own walk took the doorway route up a floor and down a floor opening (34 doorways, the drop
 *    into 0x01D201F7 at 10:13:26Z), then stood its last 5.9 m leg searching for 19 s; USE_APPROACH_MS (45 s) stopped
 *    it 2.8 m from the portal, and the only task-done said "interrupted (ac_use stopped waiting for it)". The use
 *    typed next went in at once. Now: a use whose walk runs out of time within reach uses it from there; the walk's
 *    own end is quiet and a late use says how it ended.
 * 2. MONSTERS AT THEM listed Dreads stuck behind walls "running at" Arcanist for half a minute (one 6 m up from
 *    Bulwark, so "a floor away" to him): a chase no closer to the fellow in AGGRO_STALL_MS is AIMED AT THEM BUT NOT
 *    REACHING THEM now, with its height from you; a fellow-aggro read late about a monster gone a floor off them is
 *    history; a monster a storey off a fellow is no fight of theirs.
 * 3. A wait handed Arcanist Bulwark's "Three in a row on me…" (seq 2253) and his next observe printed it again.
 * 4. "cast Flame Bolt V at #80005bc4 0 times (repeat); stopped: #80005bc4 died" when Bulwark's swing killed it first.
 * 5. raise's 256,117 unassigned vs observe's 206,375: both AvailableExperience; three kills came between (the CE raise
 *    of 249,064 then left 7,053, observe's next figure). No change.
 * 6. /sit: retail has no such command (it goes to the server: "Unknown command: sit"); "sit" is a ChatPoseTable pose
 *    (*sit*), and resting is the Sit key's stance, refused in a combat stance (CMotionInterp::DoMotion).
 *    And AC1999's ChatPoseTable kept each string's NUL ("wave\0"): no pose worked there; the 1999 overlay translates it.
 * 9. stay_with's "going back to them first" read "Claude Arcanist is the way on is a 6 m drop …" (the wording is
 *    pinned by verify-agent-mountain-keep-2026-10-17.ts's stay_with walk).
 * Driven through the real modules (AgentApi on the fake host, ClientNotices, the command table, the DAT's ChatPoseTable).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, type AgentHostObject } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { RetailCommandSystem, type RetailCommandContext } from '../packages/renderer/src/chat/commands/index.ts';
import { CLIENT_NOTICES, combatMotionRefusal } from '../packages/renderer/src/ui/ClientNotices.ts';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.ts';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.ts';
import { DatReader } from '../packages/dat-parser/src/DatReader.ts';
import { ChatPoseTable } from '../packages/dat-parser/src/file-types/ChatPoseTable.ts';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.ts';
import { DatWriter } from '../packages/dat-parser/src/era1999/DatWriter.ts';
import { transcodeChatPoseTable1999 } from '../packages/dat-parser/src/era1999/Tables1999.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';
import { ac1999Dats } from './_harness/dungeonNav.ts';

/** Mountain Keep stand-ins: interior cells of the fake host's landblock (0xA9B4; floors a storey, 6 m, apart). */
const ROOM = 0xa9b40150, UPPER = 0xa9b40151;
const ARC = 0x500000a3, BULWARK = 0x500000a4;
const PORTAL = 0x701d2027;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, maxMs = 60_000): Promise<T> {
  let out: T | undefined;
  let done = false;
  void p.then((r) => { out = r; done = true; });
  for (let t = 0; t < maxMs && !done; t += 100) { run(api, host, 100, { physics: false }); await vi.advanceTimersByTimeAsync(0); }
  if (!done) throw new Error('never answered');
  return out as T;
}

describe('the fake Keep', () => {
  let host: FakeHost;
  let api: AgentApi;
  const dread = (guid: number, x: number, y: number, z: number, extra: Partial<AgentHostObject> = {}): AgentHostObject =>
    host.add({ guid, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: ROOM, x, y, z, level: 60, ...extra });
  const fellow = (name: string, guid: number): void => {
    host.fellows = () => [{ guid, name, health: { cur: 174, max: 174 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 } }];
  };
  let saved: { approach: number; late: number };
  beforeEach(() => {
    vi.useFakeTimers();
    saved = { approach: AgentApi.USE_APPROACH_MS, late: AgentApi.USE_LATE_MS };
    host = new FakeHost();
    host.me.cell = ROOM; host.me.x = 80; host.me.y = 20; host.me.z = 0;
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    AgentApi.USE_APPROACH_MS = saved.approach; AgentApi.USE_LATE_MS = saved.late;
    vi.useRealTimers(); vi.restoreAllMocks();
  });

  describe('1. a use whose walk runs out of time', () => {
    beforeEach(() => {
      host.me.name = 'Claude Bulwark'; host.me.guid = BULWARK; host.me.level = 43;
      // A doorway route to the portal's room, so the use walks the planner's way first (approach), as in the Keep.
      host.routeTo = [{ x: 81, y: 21, z: 0 }];
    });

    it('stopped 2.8 m from the portal on its floor: the use goes from there (the server walks the last metres)', async () => {
      host.add({ guid: PORTAL, name: 'Holtburg', objectDescFlags: 0x40000, cell: UPPER, x: 82.3, y: 21.65, z: 0 });
      AgentApi.USE_APPROACH_MS = 0; // the walk's 45 s, run out at once
      AgentApi.USE_LATE_MS = 0; // every use is a late one here
      const r = await settle(api, host, api.use(PORTAL));
      expect(host.sent).toContain(`use ${PORTAL.toString(16)}`);
      expect(r.message).toMatch(/\(walking to Holtburg took longer than 0 s and stopped 2\.8 m away, within reach, so the use went from there\)$/);
      const done = api.eventsSince().filter((e) => e.type === 'task-done').map((e) => e.text);
      // The use's own end, once; never the walk's "interrupted (ac_use stopped waiting for it)".
      expect(done).toEqual([`use: ${r.message}`]);
    });

    it('stopped 20 m off: not used, and the late answer reaches a wait as the use\'s task-done', async () => {
      host.add({ guid: PORTAL, name: 'Holtburg', objectDescFlags: 0x40000, cell: UPPER, x: 80, y: 40, z: 0 });
      AgentApi.USE_APPROACH_MS = 0;
      AgentApi.USE_LATE_MS = 0;
      const r = await settle(api, host, api.use(PORTAL));
      expect(r.ok).toBe(false);
      expect(r.message).toBe("couldn't reach Holtburg: walking to Holtburg took longer than 0 s and stopped 20.0 m away; ac_walk_to it first (it can take longer), then use it");
      expect(host.sent).not.toContain(`use ${PORTAL.toString(16)}`);
      const done = api.eventsSince().filter((e) => e.type === 'task-done').map((e) => e.text);
      expect(done).toEqual([`use: ${r.message}`]);
      expect(done.some((t) => /stopped waiting for it/.test(t))).toBe(false);
    });

    it('within reach but a floor up: still not used from there', async () => {
      host.add({ guid: PORTAL, name: 'Holtburg', objectDescFlags: 0x40000, cell: UPPER, x: 82.3, y: 21.65, z: 6 });
      AgentApi.USE_APPROACH_MS = 0;
      const r = await settle(api, host, api.use(PORTAL));
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/^couldn't reach Holtburg: walking to Holtburg took longer than 0 s and stopped 2\.8 m away/);
      expect(host.sent).not.toContain(`use ${PORTAL.toString(16)}`);
    });

    it('a use answered quickly says nothing more (no extra task-done)', async () => {
      host.routeTo = null;
      host.add({ guid: 0x701d2057, name: 'Fountain of Strength', cell: ROOM, x: 81, y: 20, z: 0 });
      const p = api.use(0x701d2057);
      run(api, host, 300, { physics: false });
      api.pushChat('You feel stronger!', 0);
      const r = await settle(api, host, p);
      expect(r.ok).toBe(true);
      expect(api.eventsSince().filter((e) => e.type === 'task-done')).toEqual([]);
    });
  });

  describe('2. the fellows line: a chase at a fellow that gets nowhere is not a monster at them', () => {
    beforeEach(() => {
      host.me.name = 'Claude Bulwark'; host.me.guid = BULWARK; host.me.level = 43;
      fellow('Claude Arcanist', ARC);
    });

    it('a Dread "running at" Arcanist 18 m off for 39 s, on her floor 6 m above you: AIMED AT THEM BUT NOT REACHING THEM (#80003576, 09:27Z)', () => {
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: ROOM, x: 72, y: 20, z: 6 });
      dread(0x80003576, 90, 20, 6, { seeks: { guid: ARC, kind: 'move' } });
      run(api, host, 1000, { physics: false });
      expect(formatObservation(api.observe())).toMatch(/fellows: Claude Arcanist 100% HP, 8 m W, up 6 m, MONSTERS AT THEM: Dread Mu-miyah L60 #80003576 running at them, 18 m from them, 6 m up from you$/m);
      run(api, host, 38_000, { physics: false });
      const line = formatObservation(api.observe()).split('\n').find((l) => l.startsWith('fellows:'))!;
      expect(line).toMatch(/^fellows: Claude Arcanist 100% HP, 8 m W, up 6 m, AIMED AT THEM BUT NOT REACHING THEM: Dread Mu-miyah L60 #80003576 \(running at them, no closer to them in 3\d s, 18 m from them, 6 m up from you\)$/);
      expect(line).not.toMatch(/MONSTERS AT THEM/);
    });

    it('one that comes on stays MONSTERS AT THEM; one on them is never held', () => {
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: ROOM, x: 80, y: 30, z: 0 });
      const d = dread(0x80005c95, 80, 50, 0, { seeks: { guid: ARC, kind: 'move' } });
      dread(0x800058bb, 81, 31, 0, { seeks: { guid: ARC, kind: 'move' } });
      for (let i = 0; i < 30; i++) { run(api, host, 1000, { physics: false }); d.y -= 0.5; }
      const line = formatObservation(api.observe()).split('\n').find((l) => l.startsWith('fellows:'))!;
      expect(line).toMatch(/MONSTERS AT THEM: Dread Mu-miyah L60 #800058bb on them, Dread Mu-miyah L60 #80005c95 running at them, 5 m from them$/);
      expect(line).not.toMatch(/NOT REACHING/);
    });

    it('a fellow-aggro read late, about a Dread gone a floor off them since: history, not delivered', async () => {
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: ROOM, x: 80, y: 30, z: 0 });
      const d = dread(0x80004e4e, 80, 40, 0, { seeks: { guid: ARC, kind: 'move' } });
      run(api, host, 300, { physics: false });
      const seq = api.eventsSince().find((e) => e.type === 'fellow-aggro')!.seq;
      host.t += 6000;
      d.z = 12; d.seeks = undefined;
      const p = api.waitFor({ types: ['fellow-aggro'], sinceSeq: seq - 1 }, 10);
      vi.advanceTimersByTime(20);
      expect(await p).toEqual([]);
    });

    it('a Dread a storey over a fellow with a weapon out is no fight of theirs; one beside them on their floor is', () => {
      const a = host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: ROOM, x: 80, y: 30, z: 0, combatStance: true });
      const d = dread(0x80005da3, 82, 31, 6);
      const fighting = (): string | null => (api as unknown as { fellowFighting(g: number): string | null }).fellowFighting(a.guid);
      expect(fighting()).toBeNull();
      d.z = 0;
      expect(fighting()).toBe('fighting');
    });
  });

  describe('3. a chat line a wait handed over is not "new" in the next observe', () => {
    it("Bulwark's /f line once (seq 2253: by the wait, then not in the observe)", async () => {
      host.me.name = 'Claude Arcanist'; host.me.guid = ARC;
      api.observe();
      api.pushChat('[Fellowship] Claude Bulwark says, "Three in a row on me: c90, c8b down, now f5a. Where are you?"', 0x12);
      api.pushChat('Dread Mu-miyah grazes your chest for 2 points of bludgeoning damage!', 0x15);
      const p = api.wait({ chatMatch: '\\] Claude Bulwark says' }, 10);
      vi.advanceTimersByTime(20);
      const got = await p;
      expect(got.map((e) => e.text)).toEqual(['(channel) [Fellowship] Claude Bulwark says, "Three in a row on me: c90, c8b down, now f5a. Where are you?"']);
      api.pushChat('Dread Mu-miyah is reduced to cinders!', 0);
      const chat = api.observe().chat.map((c) => c.text);
      expect(chat.some((t) => t.includes('Three in a row'))).toBe(false);
      // The lines the wait didn't hand over are still new.
      expect(chat).toEqual(['Dread Mu-miyah grazes your chest for 2 points of bludgeoning damage!', 'Dread Mu-miyah is reduced to cinders!']);
      expect(api.observe().chat).toEqual([]);
    });

    it("a routine's snapshot leaves the player's unread lines (and the wait's marks) as they were", async () => {
      api.observe();
      api.pushChat('[Fellowship] Claude Bulwark says, "on me"', 0x12);
      api.pushChat('[Fellowship] Claude Bulwark says, "two now"', 0x12);
      const p = api.wait({ chatMatch: 'on me' }, 10);
      vi.advanceTimersByTime(20);
      expect((await p).map((e) => e.text)).toEqual(['(channel) [Fellowship] Claude Bulwark says, "on me"']);
      api.pushChat('[Fellowship] Claude Bulwark says, "three"', 0x12);
      const left = ['[Fellowship] Claude Bulwark says, "two now"', '[Fellowship] Claude Bulwark says, "three"'];
      expect(api.snapshot().chat.map((c) => c.text)).toEqual(left);
      expect(api.observe().chat.map((c) => c.text)).toEqual(left);
      expect(api.observe().chat).toEqual([]);
    });
  });

  describe('4. a repeat at a target someone else killed first', () => {
    const MU = 0x80005bc4;
    beforeEach(() => {
      host.me.name = 'Claude Arcanist'; host.me.guid = ARC; host.me.level = 45;
      host.spells = () => [{ id: 84, name: 'Flame Bolt V', school: 'War', level: 5, projectile: true, range: 60 }];
      host.me.mana = { current: 263, max: 319 };
      fellow('Claude Bulwark', BULWARK);
    });

    it('dead before the first cast, Bulwark on it: says so, no tally (10:10:20Z)', async () => {
      host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: ROOM, x: 80, y: 38, z: 0, seeks: { guid: MU, kind: 'move' } });
      dread(MU, 80, 41, 0);
      run(api, host, 300, { physics: false });
      host.dying.add(MU);
      const r = await settle(api, host, api.cast('Flame Bolt V', MU, { repeat: true }));
      expect(r.message.split('\n')[0]).toBe('Flame Bolt V not needed: Dread Mu-miyah died (killed by Claude Bulwark, most likely: they were attacking it) before your first cast at it (no cast made, no mana spent; pick the next target)');
      expect(r.targetGone).toBe(true);
      expect(host.sent.some((s) => s.startsWith('cast '))).toBe(false);
    });

    it('no fellow by it: just that it died first', async () => {
      dread(MU, 80, 41, 0);
      run(api, host, 300, { physics: false });
      host.dying.add(MU);
      const r = await settle(api, host, api.cast('Flame Bolt V', MU, { repeat: true }));
      expect(r.message.split('\n')[0]).toBe('Flame Bolt V not needed: Dread Mu-miyah died before your first cast at it (no cast made, no mana spent; pick the next target)');
    });
  });

  describe('6. "/sit" is no retail command: the pose and the Sit key instead', () => {
    const table = new Map([['sit', 'SitState'], ['wave', 'Wave'], ['afk', 'AFKState']]);
    const commands = new RetailCommandSystem({} as RetailCommandContext);
    beforeEach(() => {
      host.chatPose = (w) => table.get(w.toLowerCase()) ?? null;
      host.clientCommand = (w) => !!commands.lookup(w);
      host.keyBindings = (f) => [{ name: 'Sit', keys: ['KeyG'] }, { name: 'Show/Hide Inventory', keys: ['F12'] }].filter((k) => k.name.toLowerCase().includes(f.toLowerCase()));
    });

    it('/sit: not sent; *sit* plays the pose; the Sit key (G) rests, out of combat mode, 2.5× in ACE', () => {
      const r = api.say('/sit');
      expect(r.ok).toBe(false);
      expect(host.chats).toEqual([]);
      expect(r.message).toBe('not sent: retail has no /sit command (the client passes it to the server, which answers "Unknown command: sit"). "sit" is a chat pose: put it between asterisks in what you say (ac_say text="*sit*") and your character plays it. A pose is only an emote. To rest, take the Sitting stance: ac_press key="Sit" (KeyG), in peace mode (in a combat stance the client says "You can\'t sit down while in combat mode"); a step stands you up. ACE regenerates health and stamina 2.5× sitting (Crouch 2×, Sleeping 3×), and at half the rate in a combat stance or running (Creature_Vitals.GetStanceMod).');
    });

    it('/wave: the pose note alone; /afk (a client command) and /f lines go as typed', () => {
      expect(api.say('/wave').message).toBe('not sent: retail has no /wave command (the client passes it to the server, which answers "Unknown command: wave"). "wave" is a chat pose: put it between asterisks in what you say (ac_say text="*wave*") and your character plays it.');
      expect(api.say('/afk').ok).toBe(true);
      expect(api.say('/f sit tight, I\'m coming').ok).toBe(true);
      expect(api.say('*sit*').ok).toBe(true);
      expect(host.chats).toEqual(['/afk', '/f sit tight, I\'m coming', '*sit*']);
    });

    it('the retail command table has no sit, wave or bow, and has afk, emote and me (InitializeCommands)', () => {
      for (const w of ['sit', 'sitting', 'wave', 'bow']) expect(commands.lookup(w)).toBeUndefined();
      for (const w of ['afk', 'emote', 'me', 'e', 'lifestone']) expect(commands.lookup(w)).toBeDefined();
    });

    it('a host that can\'t say sends it as before', () => {
      host.chatPose = undefined;
      expect(api.say('/sit').ok).toBe(true);
      expect(host.chats).toEqual(['/sit']);
    });
  });
});

describe('6. combatMotionRefusal (CMotionInterp::DoMotion @ 00528d20): postures and emotes need the NonCombat style', () => {
  it('in a combat stance: crouch, sit, lie down and chat emotes are refused with retail\'s lines', () => {
    expect(combatMotionRefusal(MotionCommand.Crouch, false)).toBe(CLIENT_NOTICES.cantCrouchCombat);
    expect(combatMotionRefusal(MotionCommand.Sitting, false)).toBe(CLIENT_NOTICES.cantSitCombat);
    expect(combatMotionRefusal(MotionCommand.Sleeping, false)).toBe(CLIENT_NOTICES.cantLieDownCombat);
    expect(CLIENT_NOTICES.cantSitCombat.text).toBe("You can't sit down while in combat mode");
    expect(CLIENT_NOTICES.cantSitCombat.sink).toBe('spew');
    expect(combatMotionRefusal(0x13000087, false)).toBe(CLIENT_NOTICES.cantEmoteCombat); // Wave
    expect(CLIENT_NOTICES.cantEmoteCombat.text).toBe("You can't use chat emotes in combat mode");
  });
  it('in peace mode all go; Ready and movement are never refused', () => {
    for (const m of [MotionCommand.Crouch, MotionCommand.Sitting, MotionCommand.Sleeping, 0x13000087]) expect(combatMotionRefusal(m, true)).toBeNull();
    expect(combatMotionRefusal(MotionCommand.Ready, false)).toBeNull();
    expect(combatMotionRefusal(MotionCommand.RunForward, false)).toBeNull();
  });
});

const REPO = resolve(__dirname, '..');
const CLASSIC_PORTAL = resolve(REPO, 'dat-sets/classicace-customdm-1.60/client_portal.dat');

describe.skipIf(!existsSync(DAT_PATHS.portal))('6. each era\'s ChatPoseTable: "sit" is a pose (SitState) where the era has one', () => {
  let tables: Array<{ era: string; t: ChatPoseTable }> = [];
  beforeAll(() => {
    const read = (db: DatDatabase): ChatPoseTable => ChatPoseTable.read(new DatReader(db.getFileData(0x0e000007)!));
    tables = [{ era: 'end of retail', t: read(openDat(DAT_PATHS.portal)) }];
    if (existsSync(CLASSIC_PORTAL)) tables.push({ era: 'Dark Majesty (classicace-customdm)', t: read(new DatDatabase(new FileDatBytes(CLASSIC_PORTAL))) });
    const y99 = ac1999Dats();
    if (y99 && y99.portal.getFileData(0x0e000007)) tables.push({ era: 'AC1999', t: read(y99.portal) });
  });
  it('end of retail: sit / sits / sitdown → SitState; "sit cross legged" too; no "rest" pose', () => {
    const eol = tables[0].t;
    expect(eol.stateFor('sit')).toBe('SitState');
    expect(eol.stateFor('sitdown')).toBe('SitState');
    expect(eol.stateFor('sit cross legged')).toBe('SitCrossleggedState');
    expect(eol.stateFor('rest')).toBeNull();
  });
  it('each era names sit a pose, except AC1999, whose 1999 table has no sit pose (kneel is its rest-like pose)', () => {
    for (const { era, t } of tables) {
      if (!t.commandToState.size) continue;
      if (era === 'AC1999') {
        // Period-correct, not a gap: the 1999 ChatPoseTable (202 poses) has no sit, sits or sitdown.
        expect(t.stateFor('sit'), era).toBeNull();
        expect(t.stateFor('kneel'), era).toMatch(/Kneel/);
      } else {
        expect(t.stateFor('sit'), era).toMatch(/^Sit/);
      }
    }
  });
});

describe('6. AC1999\'s ChatPoseTable: AcStrings (length counting a NUL) translated, so its poses match', () => {
  /** A 1999-format ChatPoseTable: id, u16 count + buckets, AcString pairs; then the emote triples. */
  const table1999 = (poses: Array<[string, string]>, emotes: Array<[string, string, string]>): ArrayBuffer => {
    const w = new DatWriter();
    const ac = (t: string): void => { const b = new Uint8Array([...Buffer.from(t, 'latin1'), 0]); w.writeUInt16(b.length).writeBytes(b).align(4); };
    w.writeUInt32(0x0e000007).writeUInt16(poses.length).writeUInt16(64);
    for (const [k, v] of poses) { ac(k); ac(v); }
    w.writeUInt16(emotes.length).writeUInt16(64);
    for (const [k, a, b] of emotes) { ac(k); ac(a); ac(b); }
    return w.toArrayBuffer();
  };
  const raw = table1999([['wave', 'Wave'], ['sit', 'SitState']], [['Wave', 'wave.', 'waves.'], ['SitState', 'sit down.', 'sits down.']]);

  it('through the overlay\'s transcoder: "sit" → SitState, "wave" → "You wave." / "waves."', () => {
    const t = ChatPoseTable.read(new DatReader(transcodeChatPoseTable1999(raw)));
    expect(t.stateFor('sit')).toBe('SitState');
    expect(t.myEmoteFor('wave')).toBe('wave.');
    expect(t.otherEmoteFor('wave')).toBe('waves.');
  });

  it('read untranslated (a streamed set published before): the NULs are dropped all the same', () => {
    const t = ChatPoseTable.read(new DatReader(raw));
    expect(t.commands()).toEqual(['wave', 'sit']);
    expect(t.stateFor('sit')).toBe('SitState');
    expect(t.otherEmoteFor('sit')).toBe('sits down.');
  });

  it('end of retail\'s own table reads as before (no NUL to drop)', () => {
    const w = new DatWriter();
    const ps = (t: string): void => { w.writePString(new Uint8Array(Buffer.from(t, 'latin1'))).align(4); };
    w.writeUInt32(0x0e000007).writeUInt16(1).writeUInt16(64); ps('wave'); ps('Wave');
    w.writeUInt16(1).writeUInt16(64); ps('Wave'); ps('wave.'); ps('waves.');
    const t = ChatPoseTable.read(new DatReader(w.toArrayBuffer()));
    expect(t.stateFor('wave')).toBe('Wave');
    expect(t.myEmoteFor('wave')).toBe('wave.');
  });
});

