/**
 * The agent API (packages/renderer/src/agent/AgentApi.ts) against a fake
 * host: perception, the event ring, the motor tasks and the no-cheating
 * refusals. docs/agent-play.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentApi, agentApiEnabled, automationUiEnabled, bearing, classify, compassToYaw, MAP_COORD_ORIGIN, parseMapCoords, relDeg, toGlobal, yawToCompass,
  type AgentHost, type AgentHostObject, type AgentHostSelf, fixtureReach } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatChat, formatObservation, relativeDirection, compassPoint } from '../packages/renderer/src/agent/format.ts';
import { formatMapCoord } from '../packages/shared/src/types.ts';
import { mapCoordinateText, mapCoordsOfCell } from '../packages/renderer/src/ui/MapMarkers.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';


describe('agent geometry', () => {
  it('converts landblock-local positions to global metres', () => {
    expect(toGlobal(HOLTBURG, 10, 20)).toEqual({ x: 0xa9 * 192 + 10, y: 0xb4 * 192 + 20 });
  });
  it('bearings are compass degrees (0 = north, 90 = east)', () => {
    expect(bearing({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(0);
    expect(bearing({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(90);
    expect(bearing({ x: 0, y: 0 }, { x: 0, y: -10 })).toBeCloseTo(180);
    expect(bearing({ x: 0, y: 0 }, { x: -10, y: 0 })).toBeCloseTo(270);
    expect(relDeg(350 - 10)).toBe(-20);
  });
  it('yaw ↔ compass agrees with the client moving along (−sin yaw, −cos yaw)', () => {
    for (const deg of [0, 45, 90, 180, 270]) {
      const yaw = compassToYaw(deg);
      const move = { x: -Math.sin(yaw), y: -Math.cos(yaw) };
      expect(bearing({ x: 0, y: 0 }, move)).toBeCloseTo(deg, 5);
      expect(yawToCompass(yaw)).toBeCloseTo(deg, 5);
    }
  });
  it('parses map coordinates to the centre of the 24 m cell the radar prints them for', () => {
    const p = parseMapCoords('42.1N, 33.6E')!;
    // Cell 1355 × 1440: (c − 1024) × 0.1 + 0.5 = 33.6E / 42.1N; its centre is 1355.5 × 24, 1440.5 × 24.
    expect(p.x).toBeCloseTo(1355.5 * 24, 6);
    expect(p.y).toBeCloseTo(1440.5 * 24, 6);
    expect(mapCoordinateText(mapCoordsOfCell(Math.floor(p.x / 24), Math.floor(p.y / 24)))).toBe('42.1N, 33.6E');
    const sw = parseMapCoords('12.5S 40.2W')!;
    expect(sw.x).toBeCloseTo((-40.2 + 101.95) * 240, 6);
    expect(sw.y).toBeCloseTo((-12.5 + 101.95) * 240, 6);
    expect(parseMapCoords('#8000123a')).toBeNull();
  });
  it('classifies objects from their description flags and item type', () => {
    expect(classify({ guid: 1, itemType: 0x10, objectDescFlags: 0x10 }, true)).toBe('monster');
    expect(classify({ guid: 1, itemType: 0x10, objectDescFlags: 0 }, false)).toBe('npc');
    expect(classify({ guid: 1, itemType: 0x10, objectDescFlags: 0x8 | 0x10 }, true)).toBe('player');
    expect(classify({ guid: 1, itemType: 0, objectDescFlags: 0x2000 }, false)).toBe('corpse');
    expect(classify({ guid: 1, itemType: 0, objectDescFlags: 0x40000 }, false)).toBe('portal');
    expect(classify({ guid: 1, itemType: 0, objectDescFlags: 0x4000 }, false)).toBe('lifestone');
    expect(classify({ guid: 1, itemType: 0, objectDescFlags: 0x1000 }, false)).toBe('door');
    expect(classify({ guid: 1, itemType: 0x10, objectDescFlags: 0x200 }, false)).toBe('vendor');
    expect(classify({ guid: 1, itemType: 1, objectDescFlags: 0 }, false)).toBe('item');
  });
  it('the API is on with ?agent on every build; the automation UI only where URL overrides are honored', () => {
    expect(agentApiEnabled('?ace&agent&bridge=x')).toBe(true);
    expect(agentApiEnabled('?agent')).toBe(true);
    expect(agentApiEnabled('?ace&agentx=1')).toBe(false);
    expect(agentApiEnabled('?ace')).toBe(false);
    // Jake, 2026-10-07: agent tools on playwebac.com too, but not the automation panel / command yet.
    expect(automationUiEnabled(false)).toBe(false);
    expect(automationUiEnabled(true)).toBe(true);
  });
});

describe('AgentApi', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
  });
  afterEach(() => vi.useRealTimers());

  it('observes nearby objects nearest first, relative to facing, skipping carried ones', () => {
    host.add({ guid: 0x80000001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 }); // 10 m north
    host.add({ guid: 0x80000002, name: 'Town Crier', itemType: 0x10, x: 75, y: 20 }); // 5 m west
    host.add({ guid: 0x80000003, name: 'Pack Sword', itemType: 1, x: 81, y: 20 });
    host.inv.push({ guid: 0x80000003, name: 'Pack Sword', where: 'main pack' });
    const obs = api.observe();
    expect(obs.nearby.map((o) => o.name)).toEqual(['Town Crier', 'Drudge Skulker']);
    expect(obs.nearby[0]).toMatchObject({ kind: 'npc', dist: 5, bearing: 270, relBearing: -90 });
    expect(obs.nearby[1]).toMatchObject({ kind: 'monster', dist: 10, bearing: 0, relBearing: 0 });
    // The radar's text, not ACE's server formula (which reads 42.0N, 33.5E here):
    // cell 0xa9·8 + 3 = 1355 → 33.6E, 0xb4·8 + 0 = 1440 → 42.1N.
    expect(obs.me?.coords).toBe('42.1N, 33.6E');
    expect(obs.me?.coords).not.toBe(formatMapCoord(0xa9 * 192 + 80, 0xb4 * 192 + 20));
    const back = parseMapCoords(obs.me!.coords!)!;
    expect([Math.floor(back.x / 24), Math.floor(back.y / 24)]).toEqual([Math.floor((0xa9 * 192 + 80) / 24), Math.floor((0xb4 * 192 + 20) / 24)]);
    expect(obs.me?.heading).toBe(0);
    const text = formatObservation(obs);
    expect(text).toContain('Town Crier  [npc]  5.0m left (W)');
    expect(text).toContain('Drudge Skulker  [monster]  10.0m ahead (N)');
  });

  it('unspent XP asks to be spent', () => {
    host.me.xpTotal = 20_000; host.me.xpUnassigned = 15_238;
    expect(formatObservation(api.observe())).toContain('unassigned xp 15,238 (spend it: ac_raise)');
    host.me.xpUnassigned = 300;
    expect(formatObservation(api.observe())).not.toContain('spend it');
  });

  it('an incoming attack (CombatEnemy 0x15 line) is an "attacked" event, a 0-damage hit or a miss included', () => {
    const since = api.observe().seq;
    api.pushChat('Drudge Skulker hits you for 0 points of bludgeoning damage!', 0x15);
    api.pushChat('You evaded Drudge Skulker!', 0x15);
    api.pushChat('You hit Drudge Skulker for 5 points of slashing damage!', 0x16); // your own swing: not an attack on you
    const ev = api.eventsSince(since).filter((e) => e.type === 'attacked').map((e) => e.text);
    expect(ev).toEqual(['Drudge Skulker hits you for 0 points of bludgeoning damage!', 'You evaded Drudge Skulker!']);
  });

  it('chat lines arrive once, in the next observation', () => {
    api.pushChat('Town Crier says, "Welcome to Holtburg!"', 0x02);
    api.pushChat('You have 5 free slots.', 0x05);
    const first = api.observe();
    expect(first.chat.map((c) => [c.kind, c.text])).toEqual([
      ['say', 'Town Crier says, "Welcome to Holtburg!"'],
      ['system', 'You have 5 free slots.'],
    ]);
    expect(api.observe().chat).toEqual([]);
  });
  it('observations list open windows and pending dialogs with how to clear them; ac_close closes them', () => {
    host.windowList = ['Social (fellowship)', 'Container'];
    host.dialogList = [{ text: 'You have acquired the Academy Token.', buttons: ['OK'] }];
    const text = formatObservation(api.observe());
    expect(text).toContain('DIALOG 0 [OK]: You have acquired the Academy Token.');
    expect(text).toContain('(answer or dismiss each with ac_dialog, e.g. button=OK');
    expect(text).toContain('windows open: Social (fellowship), Container  (ac_close name=… or all');
    expect(api.closeWindow('social')).toEqual({ ok: true, message: 'closed social; still open: Container' });
    expect(api.closeWindow('Trade')).toEqual({ ok: false, message: 'no open window "Trade"' });
    expect(api.closeWindow()).toEqual({ ok: true, message: 'closed every window' });
    // The surface key is the tool's name without ac_ (tools.ts act()), as for every action.
    expect(typeof (api.surface() as Record<string, unknown>).close).toBe('function');
    host.dialogList = [];
    expect(formatObservation(api.observe())).not.toMatch(/windows open|ac_dialog, e\.g\./);
  });

  it('observations name the buffs you know that are not up (highest level of each, self-only first)', () => {
    host.spells = () => [
      { id: 1, name: 'Strength Other I', school: 'Creature', level: 1, buff: true },
      { id: 2, name: 'Armor Self I', school: 'Life', level: 1, self: true, buff: true },
      { id: 3, name: 'Armor Self II', school: 'Life', level: 2, self: true, buff: true },
      { id: 4, name: 'Heal Self I', school: 'Life', level: 1, self: true }, // instant: not a buff
      { id: 5, name: 'Focus Self I', school: 'Creature', level: 1, self: true, buff: true },
    ];
    host.buffs = [{ name: 'Focus Self I', remaining: 600 }];
    const text = formatObservation(api.observe());
    expect(text).toContain("buffs you know that aren't up: Armor Self II, Strength Other I (ac_cast;");
    expect(text).not.toMatch(/aren't up:.*(Heal Self|Focus Self|Armor Self I,)/);
  });

  it('observations show your active buffs, soonest to expire first, and say how to buff when there are none', () => {
    expect(formatObservation(api.observe())).toContain('buffs: none (ac_spells finds buffs you know; ac_cast casts them');
    host.buffs = [{ name: 'Strength Self I', remaining: 1810 }, { name: 'Heritage Bonus', remaining: -1 }, { name: 'Blood Drinker I', remaining: 42 }];
    expect(formatObservation(api.observe())).toContain('buffs (3): Blood Drinker I 42s, Strength Self I 30m10s, Heritage Bonus permanent');
    // Vitae and other harmful enchantments are debuffs, on their own line.
    host.buffs = [{ name: 'Vitae', remaining: -1, beneficial: false }, { name: 'Armor Self I', remaining: 600, beneficial: true }];
    const text = formatObservation(api.observe());
    expect(text).toContain('buffs (1): Armor Self I 10m');
    expect(text).toContain('debuffs (1): Vitae permanent');
  });

  it('fellowship: creates by name, recruits a nearby player by selecting them (back within 5 s for their dialog)', async () => {
    const created = api.fellowship('create', 'Tinkers');
    await vi.advanceTimersByTimeAsync(200);
    host.fellowshipText = 'fellowship "Tinkers": 1/9 fellows';
    await vi.advanceTimersByTimeAsync(400);
    expect(await created).toMatchObject({ ok: true, message: expect.stringMatching(/^done: create[\s\S]*fellowship "Tinkers"/) });
    host.add({ guid: 0x5000000a, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8 | 0x10, x: 81, y: 21 });
    const recruited = api.fellowship('recruit', 'Claude Arcanist');
    await vi.advanceTimersByTimeAsync(5200);
    const r = await recruited;
    expect(host.sent).toContain('fellowship recruit Claude Arcanist 5000000a');
    expect(r.message).toMatch(/^asked Claude Arcanist to join\. They have 30 s .* ac_dialog button=Yes/);
    expect((await api.fellowship('show')).message).toBe('fellowship "Tinkers": 1/9 fellows');
  });

  it('swears allegiance to a nearby player by name and reports the new allegiance once it arrives', async () => {
    host.add({ guid: 0x50000009, name: 'Jake Main', itemType: 0x10, objectDescFlags: 0x8 | 0x10, x: 82, y: 22 });
    const p = api.swearAllegiance('Jake Main');
    await vi.advanceTimersByTimeAsync(400);
    host.allegianceText = 'allegiance: 2 members, your rank 1\npatron: Jake Main (L50, online)';
    await vi.advanceTimersByTimeAsync(400);
    const r = await p;
    expect(host.sent).toContain('swear 50000009');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^swore allegiance to Jake Main\.[\s\S]*patron: Jake Main/);
    expect(api.breakAllegiance()).toEqual({ ok: true, message: 'broke from your patron' });
    expect(api.breakAllegiance('Tink')).toEqual({ ok: true, message: 'broke allegiance with Tink' });
    // No answer yet: back within 5 s (the server's offer lasts 30 s), saying how to accept on the patron.
    host.allegianceText = 'no allegiance (no patron, no vassals)';
    const pending = api.swearAllegiance('Jake Main');
    await vi.advanceTimersByTimeAsync(5200);
    const asked = await pending;
    expect(asked.ok).toBe(true);
    expect(asked.message).toMatch(/^asked to swear to Jake Main\. They now have 30 s .* ac_dialog button=Yes on their profile/);
    host.swearRefusal = 'you already have a patron (break from them first)';
    expect(await api.swearAllegiance('Jake Main')).toEqual({ ok: false, message: 'you already have a patron (break from them first)' });
  });

  it('the surface\'s self() names you without reading the chat (an attached daemon waits on it)', () => {
    const surface = api.surface() as { self: () => { name: string } | null };
    api.pushChat('Town Crier says, "Welcome to Holtburg!"', 0x02);
    expect(surface.self()?.name).toBe(api.observe({}).me?.name);
    api.pushChat('You have 5 free slots.', 0x05);
    expect(surface.self()).not.toBeNull();
    expect(api.observe().chat.map((c) => c.text)).toEqual(['You have 5 free slots.']);
  });

  it('refuses "@" server commands but sends ordinary chat and "/" commands', () => {
    expect(api.say('@teleloc 0xA9B40019 [80 20 94]').ok).toBe(false);
    expect(api.say('  @grantxp 1000000').ok).toBe(false);
    expect(api.say('Hello Dereth').ok).toBe(true);
    expect(api.say('/tell Jake, hi').ok).toBe(true);
    expect(host.chats).toEqual(['Hello Dereth', '/tell Jake, hi']);
  });

  it('resolves names to the nearest matching object, and inventory items for item arguments', () => {
    host.add({ guid: 0x80000010, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 60 });
    host.add({ guid: 0x80000011, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 25 });
    host.inv.push({ guid: 0x80000020, name: 'Healing Kit', where: 'main pack' });
    expect(api.resolve('drudge')).toBe(0x80000011);
    expect(api.resolve('Healing Kit', 'inventory')).toBe(0x80000020);
    expect(api.resolve('self')).toBe(0x50000001);
    expect(api.resolve(0x80000010)).toBe(0x80000010);
    expect(api.resolve('Nonexistent')).toBeNull();
  });

  it('walkTo steers toward the goal and arrives', async () => {
    host.add({ guid: 0x80000030, name: 'Life Stone', objectDescFlags: 0x4000, x: 110, y: 50 });
    const p = api.walkTo('Life Stone', { within: 2 });
    expect(api.observe().me?.task).toBe('walking to Life Stone');
    run(api, host, 20_000);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/arrived/);
    expect(host.keys.has('KeyW')).toBe(false);
    expect(Math.hypot(host.me.x - 110, host.me.y - 50)).toBeLessThanOrEqual(2);
    expect(api.eventsSince(0).some((e) => e.type === 'task-done')).toBe(true);
  });

  it('walkTo follows doorway waypoints between interior cells', async () => {
    const DUNGEON = 0x86020100;
    host.me.cell = DUNGEON + 0xad; host.me.x = 10; host.me.y = 10;
    host.add({ guid: 0x800000b0, name: 'Jonathan', itemType: 0x10, cell: DUNGEON + 0xb2, x: 30, y: 10 });
    host.routeTo = [{ x: 10, y: 20, z: 94 }, { x: 30, y: 20, z: 94 }]; // north through one door, east through the next
    const p = api.walkTo('Jonathan', { within: 1 });
    const visited: Array<[number, number]> = [];
    for (let i = 0; i < 200; i++) { run(api, host, 100); visited.push([host.me.x, host.me.y]); }
    expect((await p).ok).toBe(true);
    // it went north to y≈20 before heading east (never cut the corner through the wall)
    expect(visited.some(([x, y]) => x < 11 && y > 19)).toBe(true);
    expect(visited.every(([x, y]) => !(x > 12 && x < 28 && y < 15))).toBe(true);
  });

  it.each([[83, 46.5], [77, 46.5], [85.5, 49], [74.5, 49.2], [80.2, 47]])('walkTo goes through a narrow doorway from (%d, %d) without pressing into the jamb (the Holtburg bowyer, 2026-10-09)', async (sx, sy) => {
    // The bowyer's door: a 1.50 m opening and a 0.96 m body leave the body's centre a ±0.27 m window; off it the jamb stops a head-on move.
    const DUNGEON = 0xa9b40100;
    host.me.cell = DUNGEON + 0x21; host.me.x = sx; host.me.y = sy;
    host.wall = (x, y) => Math.abs(y - 50) < 0.48 && Math.abs(x - 80) > 0.27;
    host.add({ guid: 0x800000b1, name: 'Bowyer Yard', cell: DUNGEON + 0x22, x: 80, y: 60 });
    host.routeTo = [{ x: 80, y: 50, z: 94 }]; // the door's centroid
    const keys: string[] = [];
    const key = host.key;
    host.key = (k: string, down: boolean) => { if (down) keys.push(k); return key(k, down); };
    const p = api.walkTo('Bowyer Yard', { within: 1 });
    run(api, host, 12_000);
    expect((await p).ok).toBe(true);
    expect(keys.filter((k) => k !== 'KeyW')).toEqual([]); // no stall dodges
  });

  it('walkTo leaves a building through its doorway for an outdoor goal', async () => {
    host.me.cell = 0xa9b40105; host.me.x = 50; host.me.y = 50;
    host.routeTo = [{ x: 50, y: 40, z: 94 }]; // the front door, south
    const goal = toGlobal(0xa9b40001, 80, 30);
    const seen: Array<{ to: unknown; toCell: number }> = [];
    const route = host.route;
    host.route = (fc, f, tc, to) => { seen.push({ to, toCell: tc }); return route(fc, f, tc, to); };
    const p = api.walkTo(`${(goal.y / 240 - MAP_COORD_ORIGIN).toFixed(4)}N, ${(goal.x / 240 - MAP_COORD_ORIGIN).toFixed(4)}E`, { within: 1 });
    run(api, host, 20_000);
    expect((await p).ok).toBe(true);
    expect(seen[0].toCell).toBe(0xa9b40001);
    expect(seen[0].to).toMatchObject({ x: expect.closeTo(80, 0), y: expect.closeTo(30, 0) });
  });

  it('walkTo to map coordinates', async () => {
    const goal = toGlobal(HOLTBURG, 80, 60);
    const ns = goal.y / 240 - MAP_COORD_ORIGIN, ew = goal.x / 240 - MAP_COORD_ORIGIN;
    const p = api.walkTo(`${ns.toFixed(3)}N, ${ew.toFixed(3)}E`, { within: 1 });
    run(api, host, 15_000);
    expect((await p).ok).toBe(true);
    expect(host.me.y).toBeGreaterThan(58);
  });

  it('walkTo finds the doorway in a wall instead of pressing into it (collision-probe path)', async () => {
    // A wall along y = 30 (local) with a 1.6 m gap at x 90..91.6; we stand at (80, 20), the goal is north of the wall.
    host.wall = (x, y) => Math.abs(y - 30) < 0.4 && !(x > 90.4 && x < 91.2);
    host.add({ guid: 0x80000042, name: 'Beyond', x: 80, y: 40 });
    const p = api.walkTo('Beyond');
    run(api, host, 30_000);
    const r = await p;
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toMatch(/^arrived/);
    expect(host.me.y).toBeGreaterThan(30);
    // The old straight line would have stopped at the wall and needed sidesteps: no door, no dodge keys here.
    expect(host.sent.filter((s) => s.startsWith('use '))).toEqual([]);
  });

  it('map draws the floor you can reach, the wall and its doorway, you and lettered objects', () => {
    host.wall = (x, y) => Math.abs(y - 26) < 0.4 && !(x > 82.4 && x < 83.6);
    host.add({ guid: 0x80000043, name: 'Society Greeter', itemType: 0x10, x: 80, y: 28 }); // 8 m north, beyond the wall
    const r = api.map({ radius: 8 });
    expect(r.ok).toBe(true);
    const lines = r.message.split('\n');
    expect(lines[0]).toMatch(/^map 17 m square around you, north up/);
    const grid = lines.slice(1, 18);
    const at = (dx: number, dy: number): string => grid[8 - dy][8 + dx];
    expect(at(0, 0)).toBe('@');
    expect(at(0, 6)).toBe('#'); // the wall, 6 m north
    expect(at(3, 6)).toBe('.'); // its doorway at x 83
    expect(at(0, 7)).toBe('.'); // the room beyond, reached through the doorway
    expect(at(0, 8)).toBe('A');
    expect(r.message).toMatch(/legend:\n {2}A Society Greeter \[npc\] #80000043/);
  });

  it('walkTo walks round to a closed door, opens it and goes in when no way is open (the Holtburg blacksmith)', async () => {
    // A 7 m box round the goal (80, 40); its only opening is a doorway on the west wall at y 39.4..40.6, shut until used.
    let open = false;
    const inBand = (v: number, c: number, half: number) => Math.abs(v - c) < half;
    host.wall = (x, y) => {
      const onWall = (inBand(x, 76.5, 0.4) || inBand(x, 83.5, 0.4)) && y > 36.1 && y < 43.9 || (inBand(y, 36.5, 0.4) || inBand(y, 43.5, 0.4)) && x > 76.1 && x < 83.9;
      const doorway = inBand(x, 76.5, 0.5) && y > 39.4 && y < 40.6;
      return onWall && !(doorway && open);
    };
    host.add({ guid: 0x80000045, name: 'Door', objectDescFlags: 0x1000, x: 75.8, y: 40 });
    host.add({ guid: 0x80000046, name: 'Blacksmith', itemType: 0x10, x: 80, y: 40 });
    const use = host.use;
    host.use = (g: number) => { if (g === 0x80000045) open = true; return use(g); };
    const p = api.walkTo('Blacksmith', { within: 1.5 });
    run(api, host, 60_000);
    const r = await p;
    expect(r).toMatchObject({ ok: true });
    expect(host.sent).toContain('use 80000045');
    expect(Math.hypot(host.me.x - 80, host.me.y - 40)).toBeLessThan(1.6);
  });

  it('a fixture reaches as far as its part-array radius; creatures and radius-less things reach 0', () => {
    expect(fixtureReach({ itemType: 0, collisionRadius: 1.6 })).toBe(1.6); // the lifestone (Setup radius × scale)
    expect(fixtureReach({ itemType: 0x10, collisionRadius: 0.6 })).toBe(0); // a creature
    expect(fixtureReach({ itemType: 0x80, collisionRadius: 0 })).toBe(0);
    expect(fixtureReach({})).toBe(0);
  });

  it('walkTo a fixture arrives at its edge: the lifestone\'s middle is inside its own collision (Holtburg, 2026-10-09)', async () => {
    // A 1.6 m-radius stone at (80, 40); the body (0.4 m) can't get its centre nearer than 2.0 m.
    host.wall = (x, y) => Math.hypot(x - 80, y - 40) < 2.0;
    host.add({ guid: 0x8000004b, name: 'Life Stone', objectDescFlags: 0x4000, x: 80, y: 40 });
    host.add({ guid: 0x8000004c, name: 'Door', objectDescFlags: 0x1000, x: 84, y: 34 });
    host.objectReach = (g) => (g === 0x8000004b ? 1.6 : 0);
    const p = api.walkTo('Life Stone');
    run(api, host, 20_000);
    const r = await p;
    expect(r).toMatchObject({ ok: true });
    expect(Math.hypot(host.me.x - 80, host.me.y - 40)).toBeLessThanOrEqual(3.6 + 0.1);
    expect(host.sent.filter((x) => x.startsWith('use '))).toEqual([]); // no door tried
  });

  it('outdoors, a blocked walk never goes off to open a building\'s door that is off the way (the Holtburg tavern, 2026-10-09)', async () => {
    // A goal sealed by walls; a house door 10 m off to the side; nothing on the line to the goal.
    host.wall = (x, y) => Math.abs(y - 40) < 3.4 && Math.abs(x - 80) < 3.4 && !(Math.abs(y - 40) < 2.6 && Math.abs(x - 80) < 2.6);
    host.add({ guid: 0x8000004d, name: 'Sealed Post', x: 80, y: 40 });
    host.add({ guid: 0x8000004e, name: 'Door', objectDescFlags: 0x1000, x: 70, y: 28 });
    const p = api.walkTo('Sealed Post', { timeoutMs: 60_000 });
    run(api, host, 90_000);
    expect((await p).ok).toBe(false);
    expect(host.sent.filter((x) => x.startsWith('use '))).toEqual([]);
  });

  it('walkTo says there is no walkable way when the collision probe finds walls all round', async () => {
    // Sealed: a closed box around the goal.
    host.wall = (x, y) => (Math.abs(y - 40) < 3.4 && Math.abs(x - 80) < 3.4) && !(Math.abs(y - 40) < 2.6 && Math.abs(x - 80) < 2.6);
    host.add({ guid: 0x80000044, name: 'Sealed Chest', x: 80, y: 40 });
    const p = api.walkTo('Sealed Chest', { timeoutMs: 90_000 });
    run(api, host, 90_000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^stuck [0-9.]+ m short \(no walkable way from here/);
  });

  it('a cast returns once it has landed and the client is free again, so the next cast is not "too busy"', async () => {
    let busy = true;
    host.busy = () => busy;
    const p = api.cast('Heal Self I', 'self');
    await vi.advanceTimersByTimeAsync(600); // the previous action is still winding down
    busy = false;
    await vi.advanceTimersByTimeAsync(400);
    expect(host.sent).toContain('cast 6 self');
    busy = true;
    api.pushChat('You say, "Equin Quasith"', 0x11);
    await vi.advanceTimersByTimeAsync(1000);
    api.pushChat('You cast Heal Self I and restore 12 points of your health.', 0x11);
    await vi.advanceTimersByTimeAsync(600);
    let done = false;
    void p.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(400);
    expect(done).toBe(false); // still busy: the cast's motion
    busy = false;
    await vi.advanceTimersByTimeAsync(400);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/casting Heal Self I on yourself\n {2}You say[\s\S]*You cast Heal Self I/);
  });

  it('a walk that carries you through a portal ends there instead of reporting thousands of metres short', async () => {
    host.add({ guid: 0x8000004a, name: 'Redoubt Portal', objectDescFlags: 0x40000, x: 80, y: 60 });
    const p = api.walkTo('Redoubt Portal');
    run(api, host, 1000);
    host.me.cell = 0x01630188; host.me.x = 40; host.me.y = 30; // the portal took us into the dungeon
    run(api, host, 300);
    expect((await p).message).toMatch(/^went through a portal on the way: you're now in an interior \(cell 0x1630188\)/);
  });

  it('death ends the running task (no walking off from the lifestone after the respawn); a dead target is named as dead', async () => {
    host.add({ guid: 0x80000047, name: 'Far Post', x: 80, y: 120 });
    const p = api.walkTo('Far Post');
    run(api, host, 500);
    host.me.dead = true;
    run(api, host, 200);
    expect(await p).toEqual({ ok: false, message: 'walking to Far Post: you died' });
    expect([...host.keys]).toEqual([]);
    host.me.dead = false;
    host.add({ guid: 0x80000048, name: 'Drudge Slinker', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 22 });
    host.dying.add(0x80000048);
    expect(api.attack('Drudge Slinker')).toEqual({ ok: false, message: 'Drudge Slinker is dead (loot its corpse, or pick another target)' });
    // A bare attack with the dead one still selected goes for the next live monster.
    host.target = 0x80000048;
    host.add({ guid: 0x80000049, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 82, y: 22 });
    expect(api.attack(null).message).toMatch(/^attacking Drudge Skulker \(#80000049\)/);
  });

  it('walkTo gives up when blocked, after trying a door and sidesteps', async () => {
    host.add({ guid: 0x80000040, name: 'Door', objectDescFlags: 0x1000, x: 81, y: 21 });
    host.add({ guid: 0x80000041, name: 'Far Thing', x: 80, y: 120 });
    const p = api.walkTo('Far Thing');
    run(api, host, 40_000, { physics: false }); // the body never moves
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^stuck .* tried the door Door, which did not let you through .* ac_map shows the room/);
    expect(host.sent).toContain('use 80000040');
    expect([...host.keys]).toEqual([]);
  });

  it('a stuck walk never Uses a door that already stands open (Using it would close it on you); observe marks it open', async () => {
    // Fispur's at Holtburg, 2026-10-09: two leaves, both open (Ethereal, ACE Door.Open), right beside the body.
    host.add({ guid: 0x80000042, name: 'Door', objectDescFlags: 0x1000, x: 80.5, y: 21, physicsState: 0x4 });
    host.add({ guid: 0x80000043, name: 'Door', objectDescFlags: 0x1000, x: 79.5, y: 21, physicsState: 0x4 | 0x8 });
    host.add({ guid: 0x80000041, name: 'Far Thing', x: 80, y: 120 });
    const doors = api.nearby(5, 'Door');
    expect(doors.map((d) => d.open)).toEqual([true, true]);
    expect(formatObservation(api.observe())).toMatch(/#80000042  Door  \[door\]  .*  open/);
    const p = api.walkTo('Far Thing');
    run(api, host, 40_000, { physics: false }); // the body never moves
    expect((await p).ok).toBe(false);
    expect(host.sent.filter((s) => s.startsWith('use 8000004'))).toEqual([]);
    // A shut one (Ethereal clear) is still tried.
    host.objs.get(0x80000042)!.physicsState = 0x8;
    expect(api.nearby(5, 'Door')[0].open).toBe(false);
  });

  it('attack sends one request, lets the server repeat, and re-sends only after the chain ends', async () => {
    host.add({ guid: 0x80000050, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 25 });
    const r = api.attack('Drudge Skulker', { height: 'high', power: 0.8 });
    expect(r.ok).toBe(true);
    expect(host.target).toBe(0x80000050);
    const wait = api.waitFor({ types: ['target-died'] }, 60_000);
    const swings = () => host.sent.filter((s) => s.startsWith('attack 80000050 0.8 high')).length;
    for (let i = 0; i < 20; i++) { run(api, host, 500); api.pushChat('You hit Drudge Skulker for 3 points!', 0x16); }
    expect(swings()).toBe(1); // the server's chain is running: no re-sends
    host.pending = false; // AttackDone ended the chain (the target stepped out of reach)
    run(api, host, 1000);
    expect(swings()).toBe(1);
    run(api, host, 700);
    expect(swings()).toBe(2);
    host.dying.add(0x80000050);
    run(api, host, 200);
    const evs = await wait;
    expect(evs.map((e) => e.type)).toEqual(['target-died']);
    // the creature's object then leaves: no second target-died
    host.objs.delete(0x80000050);
    run(api, host, 200);
    expect(api.eventsSince(0).filter((e) => e.type === 'target-died')).toHaveLength(1);
  });

  it('surfaces dialogs in observe and events, and answers them by label', () => {
    run(api, host, 100);
    host.dialogList.push({ text: 'Read the text in your chat window.', buttons: ['OK'] });
    run(api, host, 100);
    expect(api.eventsSince(0).find((e) => e.type === 'dialog')?.text).toBe('[OK] Read the text in your chat window.');
    expect(formatObservation(api.observe())).toContain('DIALOG 0 [OK]: Read the text in your chat window.');
    expect(api.dialog('Yes').ok).toBe(false);
    expect(api.dialog('OK', null).ok).toBe(true); // an omitted index arrives as JSON null
    expect(api.observe().dialogs).toEqual([]);
    expect(api.dialog('OK').message).toBe('no dialog is open');
  });

  it('attack gives up after 20 s without a swing either way', async () => {
    host.add({ guid: 0x80000051, name: 'Thieving Thrungus', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 25 });
    api.attack('Thieving Thrungus');
    const done = api.waitFor({ types: ['task-done'] }, 60_000);
    run(api, host, 21_000);
    expect((await done)[0].text).toMatch(/no swings .* for 20 s/);
    expect(host.sent).toContain('cancel');
  });

  it('buys and sells through an open vendor, refusing with none open', async () => {
    expect(api.buy('Healing Kit').ok).toBe(false);
    host.vendorOpen = { name: 'Academy Shopkeeper', guid: 0x80000c00, currency: 'Pyreals', items: [{ guid: 0x80000c01, name: 'Healing Kit', price: 30 }, { guid: 0x80000c02, name: 'Bread', price: 2 }] };
    expect(api.vendorView().message).toContain('#80000c01 Healing Kit  30');
    expect(api.buy('bread', 3).ok).toBe(true);
    host.inv.push({ guid: 0x80000c10, name: 'Carpenter Wasp Wing', where: 'main pack', stack: 4 });
    // The server takes it: the item leaves the pack.
    host.vendorSell = (g: number, n: number) => { host.sent.push(`sell ${g.toString(16)} x${n}`); setTimeout(() => { host.inv = host.inv.filter((i) => i.guid !== g); }, 300); return true; };
    const sold = api.sell('Wasp Wing');
    await vi.advanceTimersByTimeAsync(2000);
    expect((await sold).message).toMatch(/^sold Carpenter Wasp Wing/);
    // The server refuses: the item stays and the reply is reported.
    host.inv.push({ guid: 0x80000c11, name: 'Water', where: 'main pack', stack: 2 });
    host.vendorSell = (g: number) => { setTimeout(() => api.pushChat('The Flasks of Water is unsellable.', 0x05), 300); return g > 0; };
    const refused = api.sell('Water');
    await vi.advanceTimersByTimeAsync(6000);
    expect(await refused).toMatchObject({ ok: false, message: 'Water was not sold\nThe Flasks of Water is unsellable.' });
    expect(host.sent).toEqual(['buy 80000c02 x3', 'sell 80000c10 x4']);
    expect(api.buy('Plate Armor').ok).toBe(false);
  });

  it('sells part of a stack: the amount reaches the client, and the pyreals (not the stack leaving) mark the sale', async () => {
    host.vendorOpen = { name: 'Academy Shopkeeper', guid: 0x80000c00, currency: 'Pyreals', items: [] };
    host.inv.push({ guid: 0x80000c20, name: 'Grapes', where: 'main pack', stack: 5 });
    const before = host.me.pyreals ?? 0;
    // The split-off 2 are sold; the original stays with 3.
    host.vendorSell = (g: number, n: number) => {
      host.sent.push(`sell ${g.toString(16)} x${n}`);
      setTimeout(() => { host.me = { ...host.me, pyreals: before + 4 }; host.inv = host.inv.map((i) => (i.guid === g ? { ...i, stack: 3 } : i)); }, 300);
      return true;
    };
    const sold = api.sell('Grapes', 2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await sold).toMatchObject({ ok: true, message: 'sold 2 of Grapes for 4 pyreals' });
    expect(host.sent).toEqual(['sell 80000c20 x2']);
  });

  it('trades only with an open trade window', () => {
    expect(api.trade('view').ok).toBe(false);
    host.tradeOpen = { partner: 'Jake', yours: [], theirs: ['Pyreal'], youAccepted: false, theyAccepted: true };
    host.inv.push({ guid: 0x80000d01, name: 'Bread', where: 'main pack' });
    expect(api.trade('view').message).toBe('trading with Jake\n  you offer: nothing\n  they offer: Pyreal  (accepted)');
    expect(api.trade('add', 'Bread').ok).toBe(true);
    expect(api.trade('accept').ok).toBe(true);
    expect(host.sent).toEqual(['trade add 80000d01', 'trade accept']);
  });

  it('presses keys and lists bindings', () => {
    expect(api.press('Show/Hide Inventory').ok).toBe(true);
    expect(host.pressed).toEqual(['Show/Hide Inventory']);
    expect(api.keys('inventory')).toBe('Show/Hide Inventory: F12');
    expect(api.keys('autorun')).toBe('Toggle Autorun: (unbound)');
  });

  it('keeps a 0.5 s position trace', () => {
    for (let i = 0; i < 10; i++) { host.me.x += 1; run(api, host, 500, { physics: false }); }
    const t = api.traceView(3);
    expect(t.length).toBeGreaterThanOrEqual(6);
    expect(t.length).toBeLessThanOrEqual(7);
    expect(t[t.length - 1].ago).toBeLessThan(0.6);
    expect(t[t.length - 1].x - t[0].x).toBeGreaterThan(4);
    expect(t[0].camera).toEqual([2.5, 2.75]);
  });

  it('a target that leaves view without dying is lost, not killed', () => {
    host.add({ guid: 0x80000e01, name: 'Thieving Thrungus', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 25 });
    api.attack('Thieving Thrungus');
    run(api, host, 1000);
    host.objs.delete(0x80000e01);
    run(api, host, 3500); // no corpse within 3 s: lost
    const types = api.eventsSince(0).map((e) => e.type);
    expect(types).toContain('target-lost');
    expect(types).not.toContain('target-died');
  });

  it('use waits for the reply and returns it', async () => {
    host.add({ guid: 0x80000e10, name: 'Academy Foreman', itemType: 0x10, x: 82, y: 22 });
    const p = api.use('Academy Foreman');
    await vi.advanceTimersByTimeAsync(300);
    api.pushChat('Approaching Academy Foreman', 0x00);
    api.pushChat('Academy Foreman tells you, "Kill three wasps."', 0x03);
    await vi.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(r.message).toBe('used Academy Foreman:\n  Academy Foreman tells you, "Kill three wasps."');
    expect(host.sent).toContain('use 80000e10');
  });

  it('use on a player reports the trade window it opens', async () => {
    host.add({ guid: 0x50000077, name: 'Jake', itemType: 0x10, objectDescFlags: 0x8, x: 81, y: 21 });
    const p = api.use('Jake');
    await vi.advanceTimersByTimeAsync(400);
    host.tradeOpen = { partner: 'Jake', yours: [], theirs: [], youAccepted: false, theyAccepted: false };
    await vi.advanceTimersByTimeAsync(3000);
    expect((await p).message).toBe('used Jake:\n  trade window open with Jake (ac_trade)');
  });

  it('use walks the doorway route first when walls are in the way', async () => {
    host.me.cell = 0x860201ad; host.me.x = 10; host.me.y = 10;
    host.add({ guid: 0x80000e20, name: 'Academy Blacksmith', itemType: 0x10, cell: 0x860201b0, x: 30, y: 10 });
    host.routeTo = [{ x: 10, y: 20, z: 94 }, { x: 30, y: 20, z: 94 }];
    const p = api.use('Academy Blacksmith');
    for (let i = 0; i < 200 && !host.sent.includes('use 80000e20'); i++) { host.t += 100; host.physics(100); api.tick(); await vi.advanceTimersByTimeAsync(100); }
    expect(host.sent).toContain('use 80000e20');
    expect(Math.hypot(host.me.x - 30, host.me.y - 10)).toBeLessThan(3);
    await vi.advanceTimersByTimeAsync(11_000);
    expect((await p).message).toMatch(/no reply/);
  });

  it('forgets a remembered NPC once it is back in view under a new id (relog, respawn)', () => {
    host.add({ guid: 0x80000e40, name: 'Tirenia', itemType: 0x10, x: 80, y: 60 });
    run(api, host, 200);
    host.objs.delete(0x80000e40);
    run(api, host, 200);
    expect(api.observe().remembered.map((o) => o.name)).toEqual(['Tirenia']);
    host.add({ guid: 0x80000e41, name: 'Tirenia', itemType: 0x10, x: 80.5, y: 60 });
    run(api, host, 200);
    const obs = api.observe();
    expect(obs.remembered).toEqual([]);
    expect(obs.nearby.filter((o) => o.name === 'Tirenia').map((o) => o.guid)).toEqual([0x80000e41]);
  });

  it('remembers NPCs that leave view and can walk back to them', async () => {
    host.add({ guid: 0x80000e30, name: 'Academy Blacksmith', itemType: 0x10, x: 80, y: 60 });
    run(api, host, 200);
    host.objs.delete(0x80000e30);
    run(api, host, 200);
    const obs = api.observe();
    expect(obs.remembered.map((o) => o.name)).toEqual(['Academy Blacksmith']);
    expect(formatObservation(obs)).toContain('remembered, out of view');
    // A place in another space (a dungeon landblock) is not listed from here.
    host.add({ guid: 0x80000e31, name: 'Training Master', itemType: 0x10, cell: 0x86020240, x: 10, y: 10 });
    run(api, host, 200);
    host.objs.delete(0x80000e31);
    run(api, host, 200);
    expect(api.observe().remembered.map((o) => o.name)).toEqual(['Academy Blacksmith']);
    const p = api.walkTo('Academy Blacksmith', { within: 2 });
    run(api, host, 20_000);
    expect((await p).ok).toBe(true);
    expect(host.me.y).toBeGreaterThan(57);
  });

  it('raise reports from → to and the total XP, and why it stopped', () => {
    expect(api.raise('Heavy Weapons', 5).message).toBe('Heavy Weapons 77 → 80 (3 raises, 60 XP); stopped: raising Heavy Weapons costs 90 XP; you have 10 unassigned');
  });

  it('move accepts left/right as strafes and names the valid directions', async () => {
    const p = api.move('left', 0.5);
    expect(host.keys.has('KeyZ')).toBe(true);
    vi.advanceTimersByTime(600);
    expect((await p).ok).toBe(true);
    expect((await api.move('sideways')).message).toMatch(/forward, backward, left, right/);
  });

  it('attack runs up to a distant target before sending the attack', async () => {
    host.add({ guid: 0x80000f01, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 60 }); // 40 m north
    const r = api.attack('Drudge Skulker');
    expect(r.message).toMatch(/running up to Drudge Skulker/);
    expect(host.sent.filter((s) => s.startsWith('attack'))).toEqual([]);
    for (let i = 0; i < 150 && !host.sent.some((s) => s.startsWith('attack')); i++) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
    expect(host.me.y).toBeGreaterThan(55);
    expect(host.sent.some((s) => s.startsWith('attack 80000f01'))).toBe(true);
  });

  it('attack refuses non-attackable targets', () => {
    host.add({ guid: 0x80000060, name: 'Town Crier', itemType: 0x10, x: 80, y: 25 });
    expect(api.attack('Town Crier').ok).toBe(false);
  });

  it('loot leaves combat, opens the corpse and takes matching items', async () => {
    host.me.combatMode = 'melee';
    host.add({ guid: 0x80000070, name: 'Corpse of Drudge Skulker', objectDescFlags: 0x2000, x: 82, y: 22 });
    host.add({ guid: 0x80000071, name: 'Pyreals', cell: null, containerId: 0x80000070 });
    host.add({ guid: 0x80000072, name: 'Drudge Charm', cell: null, containerId: 0x80000070 });
    const p = api.loot(null, 'charm');
    expect(host.sent).toContain('mode peace');
    run(api, host, 2000);
    expect(host.sent).toContain('use 80000070');
    host.container = { guid: 0x80000070, items: [{ guid: 0x80000071, name: 'Pyreals' }, { guid: 0x80000072, name: 'Drudge Charm' }] };
    run(api, host, 3000);
    const r = await p;
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toContain('Drudge Charm');
    expect(host.sent).toContain('pickup 80000072');
    expect(host.sent).not.toContain('pickup 80000071');
  });

  it('loot reports names as they are once the items land (1999 lists "???" before the creates)', async () => {
    host.add({ guid: 0x80000ab0, name: 'Corpse of Brown Rabbit', objectDescFlags: 0x2000, x: 81, y: 21 });
    const p = api.loot('Corpse of Brown Rabbit', null);
    run(api, host, 2000);
    host.container = { guid: 0x80000ab0, items: [{ guid: 0x80000ab1, name: '???' }, { guid: 0x80000ab2, name: '???' }] };
    host.pickUp = (g: number) => { host.sent.push(`pickup ${g.toString(16)}`); host.inv.push({ guid: g, name: g === 0x80000ab1 ? 'Smoky Quartz' : 'Leather Shirt', where: 'main pack' }); return true; };
    run(api, host, 5000);
    expect((await p).message).toBe('took 2: Smoky Quartz, Leather Shirt');
  });

  it('cast resolves spells by name, self-casts self-only spells, never targets an item, and reports replies', async () => {
    host.spells = () => [{ id: 27, name: 'Flame Bolt I', school: 'War', level: 1 }, { id: 6, name: 'Heal Self I', school: 'Life', level: 1, self: true }];
    host.add({ guid: 0x80000080, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 25 });
    host.add({ guid: 0x80000081, name: 'Aluvian Wand', itemType: 0x100, x: 80, y: 21 });
    const bolt = api.cast('flame bolt', 'Drudge Skulker');
    await vi.advanceTimersByTimeAsync(3500);
    expect((await bolt).ok).toBe(true);
    expect(host.sent).toContain('cast 27 80000080');
    // The selection is the wand (after a use): a self-only spell still goes on you.
    host.target = 0x80000081;
    const heal = api.cast('Heal Self I', null);
    setTimeout(() => api.pushChat("You do not have all of this spell's components", 0x05), 300);
    await vi.advanceTimersByTimeAsync(3500);
    const r = await heal;
    expect(host.sent).toContain('cast 6 self');
    expect(r).toMatchObject({ ok: false, message: "casting Heal Self I on yourself\n  You do not have all of this spell's components" });
    // A targeted spell with only an item selected asks for a target instead of casting at the wand.
    expect((await api.cast('Flame Bolt I', null)).message).toMatch(/needs a target/);
    expect(await api.cast('Incantation of Something', null)).toMatchObject({ ok: false });
  });

  it('a target deleted without a death start (1999) still counts as killed when its corpse appears', () => {
    host.add({ guid: 0x80000090, name: 'Brown Rabbit', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 22 });
    api.attack('Brown Rabbit');
    run(api, host, 1000);
    host.objs.delete(0x80000090);
    run(api, host, 300);
    host.add({ guid: 0x80000091, name: 'Corpse of Brown Rabbit', objectDescFlags: 0x2000, x: 81, y: 22 });
    run(api, host, 300);
    const types = api.eventsSince(0).map((e) => e.type);
    expect(types).toContain('target-died');
    expect(types).not.toContain('target-lost');
  });

  it('a kill line naming the target also settles it as killed', () => {
    host.add({ guid: 0x80000092, name: 'Brown Rabbit', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 22 });
    api.attack('Brown Rabbit');
    run(api, host, 1000);
    api.pushChat('Your killing blow nearly turns Brown Rabbit inside-out!', 0x16);
    host.objs.delete(0x80000092);
    run(api, host, 300);
    expect(api.eventsSince(0).filter((e) => e.type === 'target-died')).toHaveLength(1);
  });

  it('waitFor wakes on a matching event, filters by chat regex, and times out empty', async () => {
    const w1 = api.waitFor({ chatMatch: 'tells you' }, 5000);
    api.pushChat('Drudge Skulker hits you for 3 points.', 0x15);
    api.pushChat('Jake tells you, "hi"', 0x03);
    expect((await w1).map((e) => e.text)).toEqual(['(tell) Jake tells you, "hi"']);
    const w2 = api.waitFor({ types: ['death'] }, 1000);
    vi.advanceTimersByTime(1100);
    expect(await w2).toEqual([]);
  });

  it('emits vitals-low, death and object-added events from tick', () => {
    run(api, host, 100);
    host.add({ guid: 0x80000090, name: 'Mosswart', itemType: 0x10, objectDescFlags: 0x10, x: 90, y: 30 });
    host.me.health.current = 10;
    run(api, host, 100);
    host.me.dead = true;
    run(api, host, 100);
    expect(api.eventsSince(0).map((e) => e.type)).toEqual(expect.arrayContaining(['object-added', 'vitals-low', 'death']));
  });

  it('a new task interrupts the running one', async () => {
    host.add({ guid: 0x800000a0, name: 'Far Thing', x: 80, y: 180 });
    const first = api.walkTo('Far Thing');
    const second = api.walkTo('Far Thing');
    expect((await first).message).toMatch(/interrupted/);
    api.stopMoving();
    expect((await second).message).toMatch(/interrupted \(stopped\)/);
  });
});

describe('agent text format', () => {
  it('collapses repeated chat lines', () => {
    const l = (seq: number, text: string) => ({ seq, t: 0, kind: 'other' as const, text });
    expect(formatChat([l(1, 'In Portal Space'), l(2, 'In Portal Space'), l(3, 'In Portal Space'), l(4, 'Welcome')]))
      .toBe('  (other) In Portal Space (×3)\n  (other) Welcome');
  });
  it('names relative directions and compass points', () => {
    expect(relativeDirection(0)).toBe('ahead');
    expect(relativeDirection(-45)).toBe('ahead-left');
    expect(relativeDirection(90)).toBe('right');
    expect(relativeDirection(-135)).toBe('behind-left');
    expect(relativeDirection(179)).toBe('behind');
    expect(compassPoint(359)).toBe('N');
    expect(compassPoint(225)).toBe('SW');
  });
});

describe('examineText', () => {
  it('renders the examination window as a player reads it', async () => {
    const { examineText } = await import('../packages/renderer/src/agent/examineText.ts');
    const item = {
      guid: 1, title: 'Training Dirk', page: 'item',
      item: { value: 'Value: 25', burden: '50 Burden Units', runs: [], lines: [], paragraphs: [], text: 'Value: 25\nBurden: 50\n\nSkill: Heavy Weapons (Dagger)\n' },
      inscription: { visible: true, text: '<Inscribe here>', signature: '', scribe: '', inscription: '' },
    } as never;
    expect(examineText(item)).toBe('Training Dirk\nValue: 25\nBurden: 50\n\nSkill: Heavy Weapons (Dagger)');
    const creature = {
      guid: 2, title: 'Drudge Skulker', page: 'creature',
      creature: { page: 'creature', headerPanel: 0, level: '5', creatureDisplayName: 'Drudge', allegianceName: '',
        stats: [{ kind: 'vital', id: 2, label: 'Health', value: '40/40', color: 0 }], miscInfo: [] },
    } as never;
    expect(examineText(creature)).toBe('Drudge Skulker\nDrudge\nLevel 5\nHealth: 40/40');
  });
});
