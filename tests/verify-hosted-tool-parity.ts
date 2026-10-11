/**
 * AGENT.hosted-mcp-connector — the hosted connector serves the CLI's tools
 * (Jake, 2026-10-10: "why doesn't it have all the same tools as the CLI"):
 * ac_look / ac_screenshot from the tab's 3D view, ac_journal / ac_note kept in
 * the player's browser, ac_routines / ac_routine through the game's routine
 * store. Only starting/stopping a session and ac_click stay local. Plus the
 * play guide it now gets, and the narrower player takeover.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi';
import { FakeHost } from './_harness/agentFake';
import { LOCAL_ONLY_TOOLS, TOOLS, TOOL_CALLER, type ToolCaller } from '../tools/ac-agent/tools';
import { HOSTED_INSTRUCTIONS } from '../tools/ac-agent/mcp-server';
import { isTakeoverInput } from '../packages/renderer/src/agent/claudeControl';
import { EXAMPLE_HUNT_PROFILE, emptyRoutineDoc, validateRoutineDoc } from '../packages/shared/src/routines/index';

function hostedTab() {
  const host = new FakeHost();
  const journal = new Map<string, unknown>();
  let routines: unknown = emptyRoutineDoc('26d9ec3d', 'enkarta');
  const started: string[] = [];
  Object.assign(host, {
    screenshot: async () => 'SkpFRw==',
    journalLoad: () => journal.get('j') ?? null,
    journalSave: (j: unknown) => { journal.set('j', j); return true; },
    accountRoutines: {
      load: async () => ({ ok: true, doc: routines, account: 'enkarta', server: '26d9ec3d' }),
      save: async (doc: unknown) => { const issues = validateRoutineDoc(doc); if (issues.length) return { ok: false, message: 'invalid', issues }; routines = doc; return { ok: true, doc, account: 'enkarta', server: '26d9ec3d' }; },
    },
  });
  const api = new AgentApi(host);
  const surface = api.surface() as Record<string, (...a: unknown[]) => unknown>;
  const realStart = surface.routineStart;
  surface.routineStart = (p: unknown) => { started.push((p as { name: string }).name); return realStart(p); };
  const calls: string[] = [];
  const c: ToolCaller = {
    notice: null, maxWaitMs: 20_000,
    connection: () => ({ account: 'enkarta', characters: 'any', tab: 'on', character: host.me.name, screen: 'world' }),
    call: async <T>(m: string, args: unknown[] = []) => { calls.push(m); const f = surface[m]; if (typeof f !== 'function') throw new Error(`unknown method ${m}`); return (await f(...args)) as T; },
  };
  return { c, calls, journal, started, host, routines: () => routines };
}
const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
const run = (c: ToolCaller, n: string, a: Record<string, unknown> = {}) => TOOL_CALLER.run(c, () => tool(n).run(a));

describe('the hosted connector has the CLI\'s tools', () => {
  it('only session start/stop and pixel clicks stay local', () => {
    expect([...LOCAL_ONLY_TOOLS].sort()).toEqual(['ac_click', 'ac_sessions', 'ac_start', 'ac_stop']);
    for (const n of ['ac_look', 'ac_screenshot', 'ac_journal', 'ac_note', 'ac_routines', 'ac_routine']) expect(LOCAL_ONLY_TOOLS.has(n)).toBe(false);
  });

  it('ac_screenshot and ac_look: the tab\'s 3D view (with the observation for ac_look)', async () => {
    const t = hostedTab();
    expect(await run(t.c, 'ac_screenshot')).toEqual({ text: 'screenshot (the 3D view; panels and chat are not in it)', jpegBase64: 'SkpFRw==' });
    const look = await run(t.c, 'ac_look');
    expect(look.jpegBase64).toBe('SkpFRw==');
    expect(look.text).toMatch(/Claude Test \(L5\)/);
    expect(t.calls).toEqual(['screenshot', 'screenshot', 'observe']);
  });

  it('ac_note and ac_journal: kept in the player\'s browser through the tab, read back next time', async () => {
    const t = hostedTab();
    expect((await run(t.c, 'ac_journal')).text).toMatch(/Claude Test/);
    expect((await run(t.c, 'ac_note', { kind: 'place', text: 'Holtburg blacksmith: Sedor Wystan, buys weapons and armor' })).text).toBe('noted (place). 1 notes in Claude Test\'s journal.');
    expect(t.journal.get('j')).toMatchObject({ character: 'Claude Test', account: 'enkarta', notes: [{ kind: 'place', text: 'Holtburg blacksmith: Sedor Wystan, buys weapons and armor' }] });
    expect((await run(t.c, 'ac_journal')).text).toMatch(/Sedor Wystan/);
  });

  it('ac_routines: list / example / set (JSON text) / explain / validate in the game\'s store; ac_routine runs it', async () => {
    const t = hostedTab();
    expect((await run(t.c, 'ac_routines', { action: 'list' })).text).toBe('enkarta has no routines yet (start from: ac_routines action=example)');
    expect((await run(t.c, 'ac_routines', { action: 'set' })).isError).toBe(true);
    expect((await run(t.c, 'ac_routines', { action: 'validate', doc: '{"profiles":3}' })).isError).toBe(true);
    const doc = { ...emptyRoutineDoc('26d9ec3d', 'enkarta'), profiles: [EXAMPLE_HUNT_PROFILE] };
    const set = await run(t.c, 'ac_routines', { action: 'set', doc: JSON.stringify(doc) });
    expect(set.isError).toBeUndefined();
    expect(set.text).toMatch(/^stored 1 profile\(s\) in your game/);
    expect((await run(t.c, 'ac_routines', { action: 'list' })).text).toContain(EXAMPLE_HUNT_PROFILE.name);
    const r = await run(t.c, 'ac_routine', { action: 'run' });
    expect(r.text).toMatch(/from your game/);
    expect(t.started).toEqual([EXAMPLE_HUNT_PROFILE.name]);
  });

  it('ac_routines import takes the VirindiTank files\' text', async () => {
    const t = hostedTab();
    expect((await run(t.c, 'ac_routines', { action: 'import', files_json: 'nope' })).isError).toBe(true);
    const nav = 'uTank2 NAV 1.2\n4\n2\n0\n0\n0\n0\n0\n0\n0\n';
    const out = await run(t.c, 'ac_routines', { action: 'import', name: 'Patrol', files_json: JSON.stringify([{ name: 'Patrol.nav', text: nav }]) });
    expect(out.text).toMatch(/^imported into "Patrol" in your game/);
    expect((t.routines() as { profiles: Array<{ name: string }> }).profiles.map((p) => p.name)).toEqual(['Patrol']);
  });

  it('ac_routines export gives the player\'s VirindiTank file back as text (AGENT.vtank-export)', async () => {
    const t = hostedTab();
    const nav = 'uTank2 NAV 1.2\r\n4\r\n2\r\n0\r\n33.6\r\n42.1\r\n0.39\r\n0\r\n3\r\n33.7\r\n42\r\n0.39\r\n0\r\n5000\r\n';
    await run(t.c, 'ac_routines', { action: 'import', name: 'Patrol', files_json: JSON.stringify([{ name: 'Patrol.nav', text: nav }]) });
    const out = await run(t.c, 'ac_routines', { action: 'export', kind: 'nav' });
    expect(out.isError).toBeUndefined();
    expect(out.text).toBe(['Patrol.nav from "Patrol"', 'everything carried over', '', '--- Patrol.nav ---', nav].join('\n'));
    expect((await run(t.c, 'ac_routines', { action: 'export', kind: 'zip' })).isError).toBe(true);
  });

  it('ac_routines imports a .usd and metaf .af text, and exports kind=usd / af (docs/vtank-parity-gaps.md §10.2–10.3)', async () => {
    const t = hostedTab();
    const fx = (n: string) => readFileSync(resolve(__dirname, 'fixtures/vtank', n), 'latin1');
    const out = await run(t.c, 'ac_routines', { action: 'import', files_json: JSON.stringify([{ name: 'hunt.af', text: fx('hunt.af') }, { name: 'hunter.usd', text: fx('hunter.usd') }]) });
    expect(out.text).toMatch(/^imported into "hunt" in your game/);
    const p = (t.routines() as { profiles: Array<{ name: string; states: unknown[]; settings?: Record<string, unknown>; vtank?: { consumables: string[] } }> }).profiles[0];
    expect(p.states).toHaveLength(3);
    expect(p.settings?.AttackDistance).toBe(20);
    expect(p.vtank?.consumables).toEqual(['Handy Healing Kit', 'Mana Draught']);
    const usd = await run(t.c, 'ac_routines', { action: 'export', kind: 'usd' });
    expect(usd.text).toMatch(/^hunt\.usd from "hunt"/);
    expect(usd.text).toContain('--- hunt.usd ---\n9\r\nAntiExtraBuffSpells\r\n');
    const af = await run(t.c, 'ac_routines', { action: 'export', kind: 'af' });
    expect(af.text).toContain('--- hunt.af ---');
    expect(af.text).toContain('STATE: {Default}');
    expect((await run(t.c, 'ac_routines', { action: 'export', kind: 'af', which: 'Holtburg loop' })).text).toContain('NAV: nav0 circular');
    expect((await run(t.c, 'ac_routines', { action: 'export', kind: 'af', which: 'nowhere' })).isError).toBe(true);
  });
});

describe('the play guide and the takeover', () => {
  it('the connector\'s instructions carry the play guide, adapted to the hosted connector', () => {
    for (const s of ['ac_status', 'ac_journal', 'ac_look', 'filter=vendor', 'still in progress', 'ac_wait types=task-done', 'ac_routines', 'ac_note', 'ac_say text=/ls', 'No cheating']) expect(HOSTED_INSTRUCTIONS).toContain(s);
    expect(HOSTED_INSTRUCTIONS).not.toContain('ac_start');
  });

  it('only moving / fighting keys and presses on the 3D world take over', () => {
    for (const code of ['KeyW', 'KeyA', 'Space', 'ArrowUp', 'Delete', 'Backquote']) expect(isTakeoverInput({ kind: 'key', code, inTextField: false })).toBe(true);
    for (const code of ['KeyI', 'KeyP', 'Enter', 'Tab', 'Escape', 'F2', 'Numpad8', 'ShiftLeft']) expect(isTakeoverInput({ kind: 'key', code, inTextField: false })).toBe(false);
    expect(isTakeoverInput({ kind: 'key', code: 'KeyW', inTextField: true })).toBe(false);
    expect(isTakeoverInput({ kind: 'mouse', onWorld: true })).toBe(true);
    expect(isTakeoverInput({ kind: 'mouse', onWorld: false })).toBe(false);
  });
});
