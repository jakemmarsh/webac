/**
 * Stream segment 13:09–14:11Z, 2026-10-17, end-of-retail local ACE, build 02c73fb0: Claude Arcanist (mage) and Claude
 * Bulwark (soldier) farming Dread Mu-miyahs in Mountain Keep (dungeon 0x01D2). Reports
 * stream/reports/{mage-2026-10-17T14-11-19-982Z,soldier-2026-10-17T14-11-15-541Z}-seg1.md, transcripts
 * stream/sessions/{mage,soldier}-2026-10-17-seg1.jsonl, page traces mage.log / soldier.log (game clock = Z − 4 h).
 *
 * 1. "Targets dropped (out of sight)": three cases, none a live monster let go in view. #80009ce8 (13:41:45Z) stood in
 *    0x01D2010C–010F, 30 m N of Arcanist's 0x01D20114, whose stab list doesn't hold those cells (the DAT test below:
 *    ObjectMaint's isCellLoaded, retail CEnvCell::grab_visible_cells, ACE EnvCell.IsVisibleIndoors all read the same
 *    VisibleCells); Bulwark killed it 5 s later from 0x01D2010C. #80007acb (13:49:50Z) was let go the same way and died to
 *    Bulwark (its corpse lay at its last spot). #80009827 (13:58:31Z) was a floor below after Arcanist went up the ramp.
 *    The refusal said "too far from you for the server to keep you updated" in a dungeon: it now says the dungeon's rule,
 *    where it was last seen, and that it died when its corpse lies there.
 * 2. Impenetrability V and Bludgeon Bane V on Arcanist's armour ran out unnoticed (13:40Z; ACE's twelve "The spell … on …
 *    has expired." lines sat in his 13:41:11 observe's chat). A buff-expired event now wakes a wait for one of your own
 *    enchantments ending (the client's "<Spell> has expired.", NotifyOfEnchantmentRemoval) or your gear's (ACE's line,
 *    one event per spell for all its items), and observe says which buffs have 2 min or less left, and the spells you cast
 *    on your gear with the time since (no timer reaches the client for an item's spells; its duration is the spell's).
 * 3. "Coming at you" for Dreads that couldn't reach him, held only after ~55 s (#800090d1, 6–12 m down): the stall check
 *    sat behind the 10-s forget window, so a chase that never let up was held only when it next re-raised, and its walks
 *    about the floor below counted as closing in. Now held after AGGRO_STALL_MS whatever the chase did, and a storey off
 *    after AGGRO_STALL_FLOOR_MS, until it is on your floor and closes in.
 * 4. stay_with: (a) 13:33:31Z Bulwark's walk to #800097a5 went back 16 m to Arcanist, who stood where he had set off
 *    (waiting for his call: "nothing was wrong"), then stopped "you went back for them once already … the way you take is
 *    one they don't come by". A fellow on the way you came is on your way: no going back, and the stop says they aren't
 *    following. (b) 13:57:47Z the going-back ended in 3 s with Arcanist still 21 m off on the floor below, and the walk on
 *    stalled and ended "went back for them once already": a going-back now has to end beside them, or it says it didn't.
 * 5. "/t Claude Arcanist Here, right beside you…" went to a "Claude Arcanist Here" (13:09:49Z). Retail DoTell takes the
 *    name up to the first comma ("Use comma after the name for targeted chat."; HelpTell "you must put a comma after the
 *    character's name"); the agent tool now puts the comma in when the tell starts with exactly one player you know.
 * Driven through the real modules (AgentApi on the fake host, formatObservation, ObjectMaint, the cell DAT's EnvCells).
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, type AgentHostObject } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { isCellLoaded } from '../packages/renderer/src/world/ObjectMaint.ts';
import { DatReader } from '../packages/dat-parser/src/DatReader.ts';
import { EnvCell } from '../packages/dat-parser/src/file-types/EnvCell.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

/** Mountain Keep stand-ins: interior cells of the fake host's landblock (0xA9B4). */
const ROOM = 0xa9b40150;
const ARC = 0x500000a3, BULWARK = 0x500000a4;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, maxMs = 60_000): Promise<T> {
  let out: T | undefined;
  let done = false;
  void p.then((r) => { out = r; done = true; });
  for (let t = 0; t < maxMs && !done; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
  if (!done) throw new Error('never answered');
  return out as T;
}

describe('stream reports 2026-10-17 14:11Z', () => {
  let host: FakeHost;
  let api: AgentApi;
  const dread = (guid: number, x: number, y: number, z = 0, extra: Partial<AgentHostObject> = {}): AgentHostObject =>
    host.add({ guid, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: ROOM, x, y, z, level: 60, ...extra });
  const fellow = (name: string, guid: number): void => {
    host.fellows = () => [{ guid, name, health: { cur: 174, max: 174 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 } }];
  };
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    host.me.cell = ROOM; host.me.x = 80; host.me.y = 20; host.me.z = 0;
    host.cellSealed = () => true;
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  describe('1. a monster the client let go in a dungeon', () => {
    it('a cast at it names the dungeon rule and where it was last seen, not "too far for the server"', async () => {
      const d = dread(0x80009ce8, 80, 47);
      run(api, host, 1000); // seen in sight: its last spot is kept
      d.lost = true; d.heardAt = host.t - 10_000; // ObjectMaint let it go: its room is out of your cell's stab list
      run(api, host, 3000);
      const r = await settle(api, host, api.cast('Flame Bolt I', 0x80009ce8));
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Dread Mu-miyah #80009ce8 is out of sight: your client let it go: in a dungeon you see only the rooms in sight of yours, and it is in one yours can't see; last seen 27 m N of you, \d s ago\. Go where it can be seen from \(walk_to #80009ce8 goes to where it was\), or let it come to you$/);
      expect(r.message).not.toMatch(/keep you updated/);
      // An attack goes there first (2026-10-19 18:20:35Z): the cast can't, a bolt needs it in sight.
      expect(api.attack(0x80009ce8).message).toMatch(/^Dread Mu-miyah #80009ce8 is out of your client's sight \(it let it go\): going to where it was last seen \(27 m N of you/);
    });

    it('one that died out of sight: its corpse at its last spot says so', () => {
      const d = dread(0x80007acb, 80, 34);
      run(api, host, 1000);
      d.lost = true; d.heardAt = host.t - 10_000;
      run(api, host, 1000);
      host.add({ guid: 0x8000a5b0, name: 'Corpse of Dread Mu-miyah', itemType: 0x200, cell: ROOM, x: 81, y: 34, z: 0 });
      run(api, host, 500);
      expect(api.attack(0x80007acb).message).toMatch(/^Dread Mu-miyah #80007acb died out of your client's sight: its corpse is #8000a5b0, 14 m N, where it was last seen/);
    });

    it('on the landscape it is still the server\'s update range (an attack goes to its last spot)', () => {
      host.me.cell = 0xa9b40019; host.me.z = 94; host.cellSealed = undefined;
      const d = host.add({ guid: 0x80001234, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 60, z: 94, level: 5 });
      run(api, host, 1000);
      d.lost = true; d.heardAt = host.t - 10_000;
      run(api, host, 500);
      // An attack goes there first (2026-10-19).
      expect(api.attack(0x80001234).message).toMatch(/out of your client's sight \(it let it go\): going to where it was last seen \(40 m N/);
    });

    describe.skipIf(!existsSync(DAT_PATHS.cell))('the Keep\'s stab lists (cell DAT)', () => {
      let read: (id: number) => EnvCell | null;
      beforeEach(() => {
        const db = openDat(DAT_PATHS.cell);
        read = (id) => { const b = db.getFileData(id); return b ? new EnvCell(new DatReader(b)) : null; };
      });
      it('0x01D2010C–010F (30 m N, where #80009ce8 stood) are not loaded for a viewer in 0x01D20114; 0x0110–0x0113 are', () => {
        const viewer = 0x01d20114;
        const vis = new Set(read(viewer)!.visibleCells);
        const v = { viewerCellId: viewer, sealed: true, midRadius: 1, isSeenOutside: () => false, visibleCells: () => vis };
        for (const c of [0x10c, 0x10d, 0x10e, 0x10f]) expect(isCellLoaded(0x01d20000 | c, v), c.toString(16)).toBe(false);
        for (const c of [0x110, 0x111, 0x112, 0x113]) expect(isCellLoaded(0x01d20000 | c, v), c.toString(16)).toBe(true);
        // …and 30 m due north of it, the same floor: in reach of a bolt by distance, but in a room the viewer's can't see.
        const a = read(viewer)!.position.origin, b = read(0x01d2010c)!.position.origin;
        expect([b.x - a.x, b.y - a.y, b.z - a.z]).toEqual([0, 30, 0]);
      });
    });
  });

  describe('2. buffs running out', () => {
    beforeEach(() => {
      host.inv = [
        { guid: 0x80000101, name: 'Leather Gauntlets', where: 'equipped', slot: 'Hands' },
        { guid: 0x80000102, name: 'Pathwarden Helm', where: 'equipped', slot: 'Head' },
        { guid: 0x80000103, name: 'Leather Boots', where: 'pack' },
      ];
      Object.assign(host, { spellTableData: () => ({ spells: new Map([[1510, { name: 'Impenetrability V', desc: '', category: 0, school: 3, bitfield: 0, power: 250, duration: 1800 }]]) }) });
    });

    it('your own buff ending wakes a buff-expired wait, naming the others running low', async () => {
      host.buffs = [{ name: 'Piercing Protection Self V', remaining: 3, beneficial: true }, { name: 'Armor Self VI', remaining: 70, beneficial: true }, { name: 'Focus Self V', remaining: 900, beneficial: true }];
      run(api, host, 1500);
      host.buffs = host.buffs.slice(1);
      const w = api.wait({ types: ['buff-expired'] }, 5000);
      api.pushChat('Piercing Protection Self V has expired.', 0x07);
      expect((await w).map((e) => e.text)).toEqual(['your Piercing Protection Self V has expired (one of your buffs): recast it (ac_cast spell="Piercing Protection Self V"); running low: Armor Self VI 1m10s']);
      const text = formatObservation(api.observe());
      expect(text).toContain('  BUFFS RUNNING LOW (2 min or less left): Armor Self VI 1m10s: recast before they end (ac_wait types=buff-expired wakes when one does)');
      expect(text).not.toMatch(/RUNNING LOW[^\n]*Focus Self V/);
    });

    it('a harmful spell on you wearing off is said as that; the vitae line is no buff', () => {
      host.buffs = [{ name: 'Vulnerability Other III', remaining: 4, beneficial: false }];
      run(api, host, 1500);
      host.buffs = [];
      api.pushChat('Vulnerability Other III has expired.', 0x07);
      api.pushChat('Vitae penalty has expired.', 0x07);
      expect(api.eventsSince().filter((e) => e.type === 'buff-expired').map((e) => e.text)).toEqual(['Vulnerability Other III has worn off you (a harmful spell on you ended)']);
    });

    it('your gear\'s spell: the casts are reckoned on the observe, and its expiry lines are one event', async () => {
      api.pushChat('You cast Impenetrability V on Leather Gauntlets, refreshing Impenetrability V', 0x07);
      api.pushChat('You cast Impenetrability V on Pathwarden Helm', 0x07);
      api.pushChat('You cast Impenetrability V on Leather Boots', 0x07); // not worn
      api.pushChat('You cast Impenetrability V on Claude Bulwark, but it is surpassed by Incantation of Impenetrability', 0x07);
      host.t += 29 * 60_000;
      expect(formatObservation(api.observe())).toContain('  spells on your gear (no timer for them reaches you: reckoned from your casts): Impenetrability V on 2 items, cast 29m ago (RUNNING LOW: about 1m left by its duration)');
      const w = api.wait({ types: ['buff-expired'] }, 5000);
      api.pushChat('The spell Impenetrability V on Leather Gauntlets has expired.', 0x07);
      api.pushChat('The spell Impenetrability V on Pathwarden Helm has expired.', 0x07);
      run(api, host, 600);
      const evs = await w;
      expect(evs.map((e) => e.text)).toEqual(['Impenetrability V has expired on your Leather Gauntlets, Pathwarden Helm (an item spell on your gear, 2 items): recast it (ac_cast spell="Impenetrability V")']);
      expect(api.observe().gearSpells).toBeUndefined();
    });
  });

  describe('3. aggro from a monster that can\'t reach you goes quiet sooner', () => {
    let seen = 0;
    const aggros = (): string[] => {
      const evs = api.eventsSince(seen);
      if (evs.length) seen = evs[evs.length - 1].seq;
      return evs.filter((e) => e.type === 'aggro').map((e) => e.text);
    };
    beforeEach(() => { seen = 0; });

    it('a chase that never lets up and gets no nearer is held at 20 s, not at its next re-raise', () => {
      const d = dread(0x80009794, 80, 35, 0, { seeks: { guid: host.me.guid, kind: 'move' } });
      run(api, host, 500);
      expect(aggros()).toEqual(['Dread Mu-miyah #80009794 (level 60) is coming at you, 15 m N (running at you)']);
      run(api, host, 19_000);
      expect(aggros()).toEqual([]);
      run(api, host, 1000);
      expect(aggros()).toEqual(["Dread Mu-miyah #80009794 (level 60) keeps facing you, 15 m N (running at you), but it hasn't come closer in 20 s: stuck, or it can't path round to you. No more aggro for it until it closes in or attacks."]);
      for (let i = 0; i < 6; i++) { d.seeks = undefined; run(api, host, 11_000); d.seeks = { guid: host.me.guid, kind: 'move' }; run(api, host, 1000); }
      expect(aggros()).toEqual([]);
    });

    it('a storey off: held after 8 s, its walking about the floor below is no closing in, and on your floor it is', () => {
      const d = dread(0x800090d1, 81, 20, -12, { seeks: { guid: host.me.guid, kind: 'move' } });
      run(api, host, 500);
      expect(aggros()).toEqual(['Dread Mu-miyah #800090d1 (level 60) is coming at you, 1 m E (running at you), 12 m down: another floor']);
      run(api, host, 8000);
      expect(aggros()).toEqual(["Dread Mu-miyah #800090d1 (level 60) keeps coming at you from another floor, 1 m E (running at you), 12 m down: another floor, and in 8 s it hasn't reached yours: no melee from there, and it may find no way down or up. No more aggro for it until it is on your floor and closes in, or attacks."]);
      // It walks off and back about the room below: no new alert (it was 55 s of them).
      for (const [x, y, z] of [[86, 14, -6], [90, 20, -6], [80, 26, -6], [84, 22, -6]]) { Object.assign(d, { x, y, z }); run(api, host, 3000); }
      expect(aggros()).toEqual([]);
      // Up on your floor and coming: said again at once, the moment it is on your floor (since 2026-10-18; it was said
      // only once it had come 3 m nearer there).
      Object.assign(d, { x: 80, y: 32, z: 0 }); run(api, host, 1000);
      for (let i = 0; i < 4; i++) { d.y -= 1; run(api, host, 300); }
      expect(aggros()).toEqual(['Dread Mu-miyah #800090d1 (level 60) is coming at you, 12 m N (running at you)']);
    });
  });

  describe('4. stay_with', () => {
    beforeEach(() => {
      host.me.name = 'Claude Bulwark'; host.me.guid = BULWARK; host.me.level = 44;
      fellow('Claude Arcanist', ARC);
      host.add({ guid: 0x80000070, name: 'Far Post', cell: ROOM, x: 80, y: 60, z: 0 });
    });

    it('a fellow still standing where the walk set off is on your way: no going back, and the stop says they aren\'t following', async () => {
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: ROOM, x: 81.2, y: 20, z: 0 });
      // A wall beside the way, between the walk and her once it is past it (the doorway frame of the real case).
      host.wall = (x, y) => x > 80.4 && x < 80.8 && y > 21.5 && y < 50;
      const r = await settle(api, host, api.walkTo('Far Post', { stayWith: 'Claude Arcanist' }), 90_000);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/^stopped \d+\.\d m short: Claude Arcanist is \d+ m S of you and hasn't moved for 1\d s \(fighting, busy, stuck or waiting for you\?\); they stand on the way you came \(where this walk set off\), so they can come: they aren't following\. stay_with doesn't tell them you set off/);
      expect(r.message).not.toMatch(/went back for them/);
      expect(api.eventsSince().some((e) => /going back to them first/.test(e.text))).toBe(false);
    });

    it('a going-back that ends away from them says so, not "went back for them once already"', async () => {
      // Arcanist a floor below, 20 m behind, standing: the walk goes back for her. That walk "arrives" (as one to where she
      // was last seen does, out of sight of her), and she is still 20 m off and 6 m down.
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: ROOM, x: 80, y: 0, z: -6 });
      const walk = api.walkTo.bind(api);
      const spy = vi.spyOn(api, 'walkTo').mockImplementation((t, o) => (t === 'Claude Arcanist' ? Promise.resolve({ ok: true, message: 'arrived (0.4 m away)' }) : walk(t, o)));
      const r = await settle(api, host, api.walkTo('Far Post', { stayWith: 'Claude Arcanist' }), 90_000);
      expect(spy.mock.calls.some(([t]) => t === 'Claude Arcanist')).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/: Claude Arcanist, \d+ m S of you, hadn't moved for 1\d s and wasn't on your way \(on another floor \(6 m down\)\)\. Going back to them didn't get to them \(arrived \(0\.4 m away\)\): they are \d+ m S of you, 6 m down: another floor\. Ask them in \/f to come to you/);
      expect(r.message).not.toMatch(/went back for them once already/);
      const done = api.eventsSince().filter((e) => e.type === 'task-done');
      expect(done).toHaveLength(1);
    });
  });

  describe('5. /tell without the comma after the name', () => {
    it('starting with the one player you know: the comma goes in, said so', () => {
      fellow('Claude Arcanist', ARC);
      const r = api.say('/t Claude Arcanist Here, right beside you in the Keep, 0x01D20107.');
      expect(r).toEqual({ ok: true, message: 'sent: /t Claude Arcanist, Here, right beside you in the Keep, 0x01D20107.\n  (a comma went in after Claude Arcanist: retail\'s /tell takes the name up to the first comma, so "/t Claude Arcanist Here, right beside you in the Keep, 0x01D20107." would have gone to "Claude Arcanist Here". Write /tell Name, message)' });
      expect(host.chats).toEqual(['/t Claude Arcanist, Here, right beside you in the Keep, 0x01D20107.']);
      expect(api.say('/tell Claude Arcanist msg').message).toMatch(/^sent: \/tell Claude Arcanist, msg\n  \(a comma went in after Claude Arcanist: .*, or with no comma at all nowhere\. Write \/tell Name, message\)$/);
    });

    it('two players it could start with: not sent, and the comma\'s place named; an unknown name is sent as typed', () => {
      host.fellows = () => [ARC, BULWARK].map((guid, i) => ({ guid, name: i ? 'Claude' : 'Claude Arcanist', health: { cur: 1, max: 1 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 } }));
      expect(api.say('/tell Claude Arcanist come up').message).toBe('not sent: a tell\'s name is everything before the first comma, and "Claude Arcanist come up" starts with more than one player you know (Claude Arcanist, Claude): put the comma after the one you mean, e.g. /tell Claude Arcanist, come up');
      expect(host.chats).toEqual([]);
      expect(api.say('/tell Somebody Else hi')).toMatchObject({ ok: false, message: expect.stringContaining('/tell Their Name, your message') });
      expect(api.say('/tell Claude, hi')).toEqual({ ok: true, message: 'sent: /tell Claude, hi' });
    });
  });
});
