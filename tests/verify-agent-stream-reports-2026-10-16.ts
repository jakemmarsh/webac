/**
 * The item and tool bugs the stream players (Claude Arcanist / Claude Bulwark, end-of-retail local ACE) reported in
 * the doll dungeon, landblock 0x0290, 2026-10-16 03:23–04:24 UTC (docs/agent-play.md; progress.md 2026-10-16):
 *  1. `./ac routines` answered "unknown action undefined"; any tool missing a required argument went out anyway.
 *  2. give: a fellow's spell words read as the server's reply, the 8 s wait gave up before ACE's 15 s walk did, an id
 *     not in the pack left the client's one pending request stuck, and a give past 30 s never said how it ended.
 *  3. equip had no slot choice and there was no unequip.
 *  4. a corpse named in full ("Treasure of Narrow Rift") was refused as "not in view … Name the corpse".
 *  5. observe filter=monster showed nothing while dolls stood in rooms out of sight of yours.
 *  6. aggro events from before a portal were handed back after it.
 *  7. the quest portal's "too long ago" line (ACE's own) read as a missing flag.
 *  8. "Quickness 79 (base 94)" with nothing saying why (Slowness Other II).
 * 10. a target on another floor: the line says so.
 * Each drives the shipped AgentApi / tools / GameUI code against the fake host (tests/_harness/agentFake.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, equipSlotMask, portalQuestNote, slotText } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import type { AgentEvent, AgentItem, AgentResult } from '../packages/renderer/src/agent/types.ts';
import { TOOL_BY_NAME, missingRequired, routinesAction } from '../tools/ac-agent/tools.ts';
import { parseCliArgs } from '../tools/ac-agent/cli.ts';
import { handle } from '../tools/ac-agent/mcp-server.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { installDomGlobals, loadDomWindow, restoreDomGlobals } from './_harness/dom.ts';

const ARCANIST = 0x500000a3;
const NECKLACE = 0x8000e9e5;

/** Run the page's ticks (and the fake clock) until the promise settles, or `ms` pass. */
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('1. routines with no action, and tools missing a required argument', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'acjs-routines-')); process.env.ACJS_ROUTINES_DIR = dir; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('`routines` alone lists the profiles (was "unknown action undefined"); a bad action names the good ones', async () => {
    const tool = TOOL_BY_NAME.get('ac_routines')!;
    const args = parseCliArgs(tool, ['account=testacjs', 'server=local-eor', 'profile=no-such-session']);
    expect(missingRequired(tool, args)).toBeNull();
    const r = await tool.run(args);
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('local-eor/testacjs has no routines yet (start from: ac_routines action=example)');
    const bad = await tool.run({ ...args, action: 'lst' });
    expect(bad).toEqual({ text: 'unknown action "lst" (list, show, explain, example, validate, set, import, export)', isError: true });
    expect(routinesAction(undefined)).toBe('list');
    expect(routinesAction('', 'status')).toBe('status');
    expect(routinesAction(' Show ')).toBe('show');
    expect(TOOL_BY_NAME.get('ac_routine')!.required ?? []).toEqual([]);
  });

  it('a required argument left out answers with the usage line, on the CLI and over MCP, before anything is sent', async () => {
    const raise = TOOL_BY_NAME.get('ac_raise')!;
    expect(missingRequired(raise, parseCliArgs(raise, []))).toBe('ac_raise: missing stat (usage: raise stat=… [times=…])');
    expect(missingRequired(raise, { stat: 'Quickness' })).toBeNull();
    const r = await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'ac_give', arguments: { item: 'Necklace' } } }) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toBe('ac_give: missing target (usage: give item=… target=… [amount=…])');
  });
});

describe('2. give waits for the server\'s own answer and says how it ended', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.inv = [{ guid: NECKLACE, name: 'Necklace', where: 'main pack', materialType: 0x3e }];
  });
  afterEach(() => vi.useRealTimers());
  const arcanistAt = (x: number, y: number) => host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x, y });

  it('a fellow\'s spell words are not the reply: the server\'s "You give" 10 s later is (the Necklace, 04:02)', async () => {
    arcanistAt(80.8, 20);
    host.give = (t, i, n) => {
      host.sent.push(`give ${i.toString(16)} to ${t.toString(16)} x${n}`);
      setTimeout(() => api.pushChat('Claude Arcanist says, "Malar Eati"', 0x11), 300);
      setTimeout(() => api.pushChat('[Fellowship] Claude Arcanist says, "Send the bracelet too please."', 0x12), 2000);
      setTimeout(() => { host.inv = []; api.pushChat('You give Claude Arcanist Silver Necklace.', 0x0); }, 10_000);
      return true;
    };
    const r = await settle(api, host, api.give('Necklace', 'Claude Arcanist', null), 30_000);
    expect(r).toEqual({ ok: true, message: 'gave 1 Necklace to Claude Arcanist\n  You give Claude Arcanist Silver Necklace.' });
  });

  it('no answer in ACE\'s 15 s says so truthfully (no chat line passed off as the server\'s)', async () => {
    arcanistAt(80.8, 20);
    host.give = () => { setTimeout(() => api.pushChat('You evaded Broken Doll!', 0x15), 500); return true; };
    const r = await settle(api, host, api.give('Necklace', 'Claude Arcanist', null), 30_000);
    expect(r).toEqual({ ok: false, message: 'Claude Arcanist did not get your Necklace (no answer from the server in 17 s, and it is still in your pack: ac_inventory in a moment shows whether it went)' });
  });

  it('it walks up beside a recipient 1.8 m off first, so the server has no walk to time out', async () => {
    arcanistAt(81.8, 20);
    let gapAtSend = -1;
    host.give = () => { gapAtSend = Math.hypot(host.me.x - 81.8, host.me.y - 20); setTimeout(() => { host.inv = []; api.pushChat('You give Claude Arcanist Silver Necklace.', 0x0); }, 500); return true; };
    const r = await settle(api, host, api.give('Necklace', 'Claude Arcanist', null), 30_000);
    expect(r?.ok).toBe(true);
    expect(gapAtSend).toBeGreaterThan(0);
    expect(gapAtSend).toBeLessThanOrEqual(AgentApi.GIVE_BESIDE_M);
  });

  it('an id not in your pack is refused before it is sent (the stuck "one item at a time", 2026-10-15)', async () => {
    arcanistAt(80.8, 20);
    const r = await settle(api, host, api.give(0x800093fc, 'Claude Arcanist', null), 2000);
    expect(r).toEqual({ ok: false, message: '#800093fc is not in your inventory (ac_inventory lists what you carry; a corpse\'s or chest\'s items are taken with ac_loot)' });
    expect(host.sent.filter((x) => x.startsWith('give'))).toEqual([]);
  });

  it('a send the client gates (a request still pending) is a refusal with its line, not "gave"', async () => {
    arcanistAt(80.8, 20);
    host.give = () => { api.pushChat('You can only move or use one item at a time', 0x1a); return false; };
    const r = await settle(api, host, api.give('Necklace', 'Claude Arcanist', null), 2000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toBe('not given: your client refused to send it:\n  You can only move or use one item at a time\n  (another move of yours was still going: wait for it, then give again)');
  });

  it('a give that waits out a pending request and the server\'s walk ends with a task-done event', async () => {
    arcanistAt(80.8, 20);
    host.busy = () => host.t < 10_000;
    host.give = () => { setTimeout(() => { host.inv = []; api.pushChat('You give Claude Arcanist Silver Necklace.', 0x0); }, 16_000); return true; };
    const r = await settle(api, host, api.give('Necklace', 'Claude Arcanist', null), 40_000);
    expect(r?.ok).toBe(true);
    const done = api.eventsSince(0).filter((e: AgentEvent) => e.type === 'task-done');
    expect(done.map((e) => e.text)).toEqual(['give: gave 1 Necklace to Claude Arcanist\n  You give Claude Arcanist Silver Necklace.']);
  });

  it('a give answered at once pushes no task-done', async () => {
    arcanistAt(80.8, 20);
    host.give = () => { setTimeout(() => { host.inv = []; api.pushChat('You give Claude Arcanist Silver Necklace.', 0x0); }, 300); return true; };
    await settle(api, host, api.give('Necklace', 'Claude Arcanist', null), 10_000);
    expect(api.eventsSince(0).some((e) => e.type === 'task-done')).toBe(false);
  });
});

describe('3. equip onto a chosen slot, and unequip', () => {
  let host: FakeHost;
  let api: AgentApi;
  const ENDURANCE: AgentItem = { guid: 0x8000e760, name: 'Heavy Bracelet', where: 'equipped', mask: 0x10000, validLocations: 0x30000 };
  const DEAD: AgentItem = { guid: 0x8000e111, name: 'Heavy Bracelet', where: 'equipped', mask: 0x20000, validLocations: 0x30000 };
  const NEW: AgentItem = { guid: 0x8000e96c, name: 'Bracelet', where: 'main pack', validLocations: 0x30000, materialType: 0x3a };
  const moves: string[] = [];
  const setWorn = (g: number, mask: number | null) => {
    host.inv = host.inv.map((i) => (i.guid !== g ? i : mask === null ? { ...i, where: 'main pack', mask: undefined } : { ...i, where: 'equipped', mask }));
  };
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    moves.length = 0;
    host.inv = [{ ...ENDURANCE }, { ...DEAD }, { ...NEW }];
    Object.assign(host, {
      // The drag off the paperdoll onto the main pack (AttemptToPlaceInContainer), confirmed 300 ms later.
      placeItem: (g: number, to: { packSlot: number }) => { moves.push(`off ${g.toString(16)} → pack ${to.packSlot}`); setTimeout(() => setWorn(g, null), 300); return true; },
      // The drag onto one paperdoll slot.
      wieldAt: (g: number, mask: number) => { moves.push(`on ${g.toString(16)} @ ${mask.toString(16)}`); setTimeout(() => setWorn(g, mask), 300); return true; },
    });
  });
  afterEach(() => vi.useRealTimers());

  it('slot="right wrist" takes the dead bracelet off into the pack, then puts the new one there; the Endurance one stays', async () => {
    const r = await settle(api, host, api.equip('Bracelet', 'right wrist'), 20_000);
    expect(moves).toEqual(['off 8000e111 → pack 0', 'on 8000e96c @ 20000']);
    expect(r).toEqual({ ok: true, message: 'took off Heavy Bracelet #8000e111 into your pack\nequipped Bracelet on the right wrist' });
    expect(host.inv.find((i) => i.guid === ENDURANCE.guid)?.mask).toBe(0x10000);
  });

  it('without slot= the reply names where it went and what it replaced (the double-click took the wrong wrist)', async () => {
    host.wield = (g: number) => { setWorn(DEAD.guid, null); setWorn(g, 0x20000); return true; };
    const r = await settle(api, host, api.equip(NEW.guid), 20_000);
    expect(r).toEqual({ ok: true, message: 'equipped Bracelet (right wrist), taking off Heavy Bracelet #8000e111 into your pack' });
  });

  it('a swing or a fellow\'s spell words during the wait are not the answer; the item\'s own spell is', async () => {
    host.wield = (g: number) => {
      setTimeout(() => api.pushChat('You evaded Broken Doll!', 0x15), 100);
      setTimeout(() => api.pushChat('Claude Bulwark says, "Zojak Quaguz"', 0x11), 200);
      setTimeout(() => { setWorn(DEAD.guid, null); setWorn(g, 0x20000); api.pushChat('Bracelet cast Strength Self IV on you', 0x11); }, 900);
      return true;
    };
    const r = await settle(api, host, api.equip(NEW.guid), 20_000);
    expect(r).toEqual({ ok: true, message: 'equipped Bracelet (right wrist), taking off Heavy Bracelet #8000e111 into your pack\n  Bracelet cast Strength Self IV on you' });
  });

  it('unequip is the drag off the paperdoll into the pack', async () => {
    const r = await settle(api, host, api.unequip(DEAD.guid), 10_000);
    expect(moves).toEqual(['off 8000e111 → pack 0']);
    expect(r).toEqual({ ok: true, message: 'took off Heavy Bracelet (right wrist): it is in your pack' });
    expect(await settle(api, host, api.unequip('Bracelet'), 1000)).toEqual({ ok: true, message: 'Bracelet is not worn (it is in your main pack)' });
  });

  it('a slot the item doesn\'t fit, or an unknown slot word, is refused before anything is sent', async () => {
    expect(await settle(api, host, api.equip('Bracelet', 'neck'), 1000)).toEqual({ ok: false, message: "not equipped: Bracelet doesn't go on the neck (it fits: left wrist + right wrist)" });
    expect((await settle(api, host, api.equip('Bracelet', 'elbow'), 1000))?.message).toMatch(/^no slot "elbow" \(slots: left wrist, right wrist, left ring/);
    expect(moves).toEqual([]);
  });

  it('slot words: the player\'s and the EquipMask names; labels back', () => {
    expect(equipSlotMask('left wrist')).toBe(0x10000);
    expect(equipSlotMask('WristWearLeft')).toBe(0x10000);
    expect(equipSlotMask('right_ring')).toBe(0x80000);
    expect(equipSlotMask('Shield')).toBe(0x200000);
    expect(equipSlotMask('two-handed')).toBe(0x2000000);
    expect(equipSlotMask('')).toBe(0);
    expect(slotText(0x30000)).toBe('left wrist + right wrist');
    expect(slotText(0x1)).toBe('HeadWear');
  });

  it('an item is found by its material name too, as the server\'s lines say it ("Bronze Bracelet")', () => {
    expect(api.resolve('Bronze Bracelet', 'inventory')).toBe(NEW.guid);
    expect(api.resolve('Bracelet', 'inventory')).toBe(NEW.guid);
  });

  it('the tool takes slot= and there is an ac_unequip', () => {
    expect(TOOL_BY_NAME.get('ac_equip')!.props).toHaveProperty('slot');
    expect(TOOL_BY_NAME.get('ac_unequip')!.required).toEqual(['item']);
  });
});

describe('4. a corpse named in full is the one asked for', () => {
  it('"Treasure of Narrow Rift" selects it; "Claude Bulwark" still doesn\'t take his corpse', () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.add({ guid: 0x8000e43d, name: 'Treasure of Narrow Rift', objectDescFlags: 0x2000, x: 82, y: 22 });
    expect(api.select('Treasure of Narrow Rift')).toEqual({ ok: true, message: 'selected Treasure of Narrow Rift' });
    host.add({ guid: 0x8000e43e, name: 'Corpse of Claude Bulwark', objectDescFlags: 0x2000, x: 83, y: 22 });
    expect(api.select('Claude Bulwark').message).toMatch(/^Claude Bulwark is not in view; only Corpse of Claude Bulwark #8000e43e matches/);
  });
});

describe('5 and 10. observe: creatures in rooms out of sight, and a target on another floor', () => {
  it('a doll in a room yours can\'t see is listed apart, not dropped; a target 20 m down says so', () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.me.cell = 0x02900302;
    host.me.z = 0;
    Object.assign(host, { cellSees: (a: number, b: number) => a === b });
    host.add({ guid: 0x8000e860, name: 'Broken Doll', itemType: 0x10, objectDescFlags: 0x10, cell: 0x02900306, x: 80, y: 6, z: 0 });
    host.add({ guid: 0x8000e57a, name: 'Battered Doll', itemType: 0x10, objectDescFlags: 0x10, cell: 0x02900302, x: 90, y: 30, z: -20 });
    host.target = 0x8000e57a;
    const obs = api.observe({ filter: 'monster', radius: 60 });
    expect(obs.nearby.map((o) => o.name)).toEqual(['Battered Doll']);
    expect(obs.unseen?.map((o) => o.name)).toEqual(['Broken Doll']);
    expect(obs.target?.otherFloor).toBe(-20);
    const text = formatObservation(obs);
    expect(text).toContain('also in range, in rooms out of sight of yours (1; where the server last placed them, they may have moved):\n  #8000e860  Broken Doll  [monster]  14.0m behind (S)');
    // Whether a walk gets there is the planner's answer (floorRoute); one room with no doorway between can't say.
    expect(text).toMatch(/target: #8000e57a {2}Battered Doll .* {2}ON ANOTHER FLOOR, 20 m down: no melee from here; not a step from this floor \(walk_to finds out whether a way gets there\)/);
  });
});

describe('6. threat events from before a portal are dropped', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.add({ guid: 0x80008216, name: 'Shore Armoredillo', itemType: 0x10, objectDescFlags: 0x10, x: 95, y: 20 });
  });
  afterEach(() => vi.useRealTimers());
  async function waitFor(types: AgentEvent['type'][]): Promise<AgentEvent[]> {
    const p = api.wait({ types }, 500);
    await vi.advanceTimersByTimeAsync(600);
    return p;
  }

  it('portal space drops the queued aggro; a new one after arrival is delivered', async () => {
    api.push('aggro', 'Shore Armoredillo is coming at you', 0x80008216);
    host.screenName = 'portal-space';
    run(api, host, 300, { physics: false });
    host.screenName = 'world';
    run(api, host, 300, { physics: false });
    expect(await waitFor(['aggro'])).toEqual([]);
    api.push('aggro', 'Shore Armoredillo is coming at you', 0x80008216);
    expect((await waitFor(['aggro'])).map((e) => e.guid)).toEqual([0x80008216]);
  });

  it('a recall (a jump of hundreds of metres in a tick) drops them too; a walk does not', async () => {
    run(api, host, 200, { physics: false });
    api.push('attackers-up', '1 creature attacking you now (+Shore Armoredillo)', 0x80008216);
    host.me.x += 3;
    run(api, host, 200, { physics: false });
    expect((await waitFor(['attackers-up'])).length).toBe(1);
    api.push('attackers-up', '1 creature attacking you now (+Shore Armoredillo)', 0x80008216);
    host.me.cell = 0x7d64000d;
    run(api, host, 200, { physics: false });
    expect(await waitFor(['attackers-up'])).toEqual([]);
  });
});

describe('7. a quest portal\'s refusal is explained by what ACE means', () => {
  it('"too long ago" is a flag whose time ran out; "must complete a quest" is no flag', () => {
    expect(portalQuestNote(['You completed the quest this portal requires too long ago!'])).toMatch(/^\(the portal opens only for a while after its quest step: you did that step once, but long enough ago that it no longer counts/);
    expect(portalQuestNote(['You must complete a quest to interact with that portal.'])).toMatch(/^\(you have never done the quest step this portal asks for/);
    expect(portalQuestNote(['Using the Portal'])).toBeNull();
  });
});

describe('8. the character sheet names what moved a stat (real GameUI)', () => {
  const domWindow = { w: null as unknown };
  const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  beforeAll(async () => {
    domWindow.w = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
    installDomGlobals(domWindow.w, DOM_GLOBALS, saved);
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (domWindow.w as any).document;
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    ui = new GameUI(container);
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('"Quickness 79 (base 94; Slowness Other II -15, 60s left)"; vitae on every stat it lowers', () => {
    const base = { iconId: 0, isBeneficial: false, isCooldown: false, casterGuid: 0, startTime: 0 };
    ui.addEnchantment({ ...base, spellId: 1324, layer: 1, name: 'Slowness Other II', isVitae: false, duration: 60, statModType: 0x9001, statModKey: 3, statModValue: -15 });
    ui.addEnchantment({ ...base, spellId: 1, layer: 2, name: 'Clumsiness Other I', isVitae: false, duration: 60, statModType: 0x9001, statModKey: 4, statModValue: -10 });
    ui.charInfo.attributes.quickness = { base: 94, buffed: 79, raises: 0 };
    ui.charInfo.attributes.strength = { base: 95, buffed: 95, raises: 0 };
    const sheet: string = ui.agentCharacterSheet();
    expect(sheet).toMatch(/Quickness 79 \(base 94; Slowness Other II -15, 60s left\)/);
    // An unchanged stat names nothing.
    expect(sheet).toMatch(/Strength 95, /);
    ui.addEnchantment({ ...base, spellId: 666, layer: 1, name: 'Vitae', isVitae: true, duration: -1, statModType: 0x804000, statModKey: 0, statModValue: 0.95 });
    expect(ui.statCauses(0x10, 6)).toBe('; Vitae -5%');
  });
});

// The type import is used by the helpers' signatures.
export type { AgentResult };
