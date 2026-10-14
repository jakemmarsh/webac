/**
 * AGENT.routine-beyond-vtank — routine conditions and actions beyond VTank (Jake 2026-10-12): attacked by N,
 * being cast at, no monster near a point / object, my corpse within, pull, hold position, loot a named corpse,
 * an abortable recall and flee-to. Each runs on the real engine and agent API (FakeHost), validates, explains,
 * exports as "not VirindiTank" and has a meta-editor entry with help text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, MAP_COORD_ORIGIN, parseMapCoords } from '../packages/renderer/src/agent/AgentApi.ts';
import { mapCoordsText } from '../packages/renderer/src/agent/RoutineEngine.ts';
import { BEING_CAST_AT_S, awayWord, holdAllows, pullLanded } from '../packages/renderer/src/agent/beyondVtank.ts';
import { ALL_MODULES_OFF, explainProfile, validateRoutineDoc, emptyRoutineDoc, type RoutineAction, type RoutineCondition, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { exportMet } from '../packages/shared/src/routines/vtankExport.ts';
import { VT_ACTIONS, VT_CONDITIONS, vtActDef, vtCondDef } from '../packages/renderer/src/ui/automation/VTankWindow.ts';
import { VT_ACTION_HELP, VT_CONDITION_HELP } from '../packages/renderer/src/ui/automation/metaHelp.ts';
import { actDef, condDef } from '../packages/renderer/src/ui/automation/AutomationPanel.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';

const OX = ((HOLTBURG >>> 24) & 0xff) * 192;
const OY = ((HOLTBURG >>> 16) & 0xff) * 192;
/** Map coordinates of a landblock-local point in the fake Holtburg. */
const at = (x: number, y: number): string => mapCoordsText({ x: OX + x, y: OY + y });

const profile = (when: RoutineCondition[], act: RoutineAction[], over: Partial<RoutineProfile> = {}): RoutineProfile => ({
  name: 'Beyond', modules: { ...ALL_MODULES_OFF, combat: true, looting: true, navigation: true, vitals: true },
  initialState: 'Default', loot: [], buffSets: [], routes: [],
  states: [{ name: 'Default', rules: [{ label: 'R', when, do: act }] }],
  ...over,
});

/** The engine's action runner (private): each action runs exactly as a firing rule runs it. */
type Act = { act(a: RoutineAction, p: RoutineProfile): Promise<{ ok: boolean; message: string; idle?: boolean } | null> };
const engine = (api: AgentApi): Act => api.routine as unknown as Act;

describe('beyond-VTank helpers', () => {
  it('hold position allows only monsters within range of the anchor', () => {
    const hold = { x: 100, y: 100, meters: 10 };
    expect(holdAllows(hold, { x: 100, y: 100 }, { dist: 8, bearing: 0 })).toBe(true);
    expect(holdAllows(hold, { x: 100, y: 100 }, { dist: 12, bearing: 90 })).toBe(false);
    // You stand away from the anchor: the monster's own distance from the anchor counts, not yours.
    expect(holdAllows(hold, { x: 100, y: 120 }, { dist: 15, bearing: 180 })).toBe(true);
  });
  it('a pull lands on our own second-person line naming it, or when it turns on us', () => {
    const t = { guid: 0x80001001, name: 'Drudge Skulker' };
    const ev = (text: string, chatType?: number) => ({ seq: 1, t: 0, type: 'chat' as const, text: `(combat) ${text}`, ...(chatType !== undefined ? { chatType } : {}) });
    expect(pullLanded(t, [], new Map())).toBeNull();
    expect(pullLanded(t, [ev('Drudge Skulker hits you for 3 points!', 0x15)], new Map())).toBeNull();
    expect(pullLanded(t, [ev('You hit Drudge Skulker for 6 points of slashing damage!', 0x16)], new Map())).toMatch(/You hit/);
    expect(pullLanded(t, [ev('Drudge Skulker evaded your attack.', 0x16)], new Map())).toMatch(/evaded/);
    expect(pullLanded(t, [], new Map([[t.guid, 1]]))).toBe('Drudge Skulker turned on you');
  });
  it('the way away from attackers is the opposite of their mean bearing', () => {
    expect(awayWord([])).toBeNull();
    expect(awayWord([{ bearing: 0 }])).toBe('south');
    expect(awayWord([{ bearing: 80 }, { bearing: 100 }])).toBe('west');
    expect(awayWord([{ bearing: 0 }, { bearing: 180 }])).toBe('east'); // surrounded: a side way out
  });
});

describe('beyond-VTank validation, explanation and export', () => {
  const doc = (p: RoutineProfile) => ({ ...emptyRoutineDoc('local-eor', 'testacjs', new Date(0)), profiles: [p] });
  const all = profile(
    [{ kind: 'attackers-at-least', count: 2 }, { kind: 'being-cast-at' }, { kind: 'no-monster-near', meters: 10, coords: '42.1N, 33.6E' }, { kind: 'my-corpse-within', meters: 30 }],
    [{ kind: 'pull', pattern: 'Drudge', back: '42.1N, 33.6E', holdMeters: 12 }, { kind: 'hold-position', meters: 15 }, { kind: 'release-position' },
      { kind: 'loot-corpse', name: 'Corpse of Azreath Lightbringer' }, { kind: 'recall', via: '/ls', abortAttackers: 2 }, { kind: 'flee-to', coords: '42.1N, 33.6E' }],
  );
  it('accepts well-formed ones and reports bad ones with their paths', () => {
    expect(validateRoutineDoc(doc(all))).toEqual([]);
    const bad = profile(
      [{ kind: 'attackers-at-least', count: 0 }, { kind: 'no-monster-near', meters: 10 }, { kind: 'no-monster-near', meters: 10, coords: '1N, 1E', object: 'Lifestone' }, { kind: 'being-cast-at', seconds: 600 }],
      [{ kind: 'pull', pattern: '(', back: 'here' }, { kind: 'recall', via: '' }, { kind: 'flee-to', coords: 'nowhere' }, { kind: 'hold-position', meters: 0 }],
    );
    const msgs = validateRoutineDoc(doc(bad)).map((i) => `${i.path}: ${i.message}`);
    expect(msgs).toEqual([
      'profiles[0].states[0].rules[0].when[0]: attackers-at-least: count must be 1..50',
      'profiles[0].states[0].rules[0].when[1]: no-monster-near: give either coords or object (not both)',
      'profiles[0].states[0].rules[0].when[2]: no-monster-near: give either coords or object (not both)',
      'profiles[0].states[0].rules[0].when[3]: being-cast-at: seconds must be 1..60',
      'profiles[0].states[0].rules[0].do[0]: pull: pattern must be a valid regex',
      'profiles[0].states[0].rules[0].do[0]: pull: back must look like "42.1N, 33.6E"',
      'profiles[0].states[0].rules[0].do[1]: recall: via is required: a recall command ("/ls") or a recall spell',
      'profiles[0].states[0].rules[0].do[2]: flee-to: coords must look like "42.1N, 33.6E" (or be empty when a portal is named)',
      'profiles[0].states[0].rules[0].do[3]: hold-position: meters must be 1..500',
    ]);
  });
  it('explains them in plain words', () => {
    const t = explainProfile(all);
    expect(t).toContain('2+ creatures attacking you (last 10 s)');
    expect(t).toContain(`a spell came at you in the last ${BEING_CAST_AT_S} s`);
    expect(t).toContain('pull the nearest /Drudge/ back to 42.1N, 33.6E and hold there (12 m)');
    expect(t).toContain('recall (/ls), giving up if 2+ creatures attack first');
  });
  it('a VirindiTank export says each has no VirindiTank equivalent instead of dropping it silently', () => {
    const out = exportMet(all);
    const problems = out.problems.join('\n');
    expect(problems).toContain("2+ creatures attacking you isn't a VirindiTank condition; written as Never");
    expect(problems).toContain("your corpse within 30 m isn't a VirindiTank condition");
    for (const w of ['pulling a monster', 'holding position', 'looting a named corpse', 'an abortable recall', 'fleeing to coordinates']) expect(problems).toContain(`${w} isn't a VirindiTank meta action; left out`);
  });
});

describe('beyond-VTank meta editor entries', () => {
  it('each kind has an Edit Meta Rule entry and "?" help, and its params round-trip', () => {
    const conds: RoutineCondition[] = [{ kind: 'attackers-at-least', count: 3 }, { kind: 'being-cast-at', seconds: 8 }, { kind: 'no-monster-near', meters: 12, coords: '1.0N, 2.0E' },
      { kind: 'no-monster-near', meters: 7, object: 'Lifestone' }, { kind: 'my-corpse-within', meters: 40 }];
    for (const c of conds) {
      const d = vtCondDef(c)!;
      expect(d, c.kind).toBeTruthy();
      expect(VT_CONDITION_HELP[d.label]).toBeTruthy();
      const v = Object.fromEntries(Object.entries(d.get!(c)).map(([k, x]) => [k, String(x)]));
      expect(d.set!(v)).toEqual(c);
    }
    const acts: RoutineAction[] = [{ kind: 'pull', pattern: 'Drudge', back: '1.0N, 2.0E', meters: 30, holdMeters: 12 }, { kind: 'hold-position', meters: 15, coords: '1.0N, 2.0E' },
      { kind: 'hold-position', meters: 15 }, { kind: 'release-position' }, { kind: 'loot-corpse', name: 'Corpse of Azreath Lightbringer' }, { kind: 'recall', via: '/ls', abortAttackers: 2 }, { kind: 'flee-to', coords: '1.0N, 2.0E' }];
    for (const a of acts) {
      const d = vtActDef([a])!;
      expect(d, a.kind).toBeTruthy();
      expect(VT_ACTION_HELP[d.label]).toBeTruthy();
      if (d.get) { const v = Object.fromEntries(Object.entries(d.get([a])).map(([k, x]) => [k, String(x)])); expect(d.set!(v, profile([], []))).toEqual([a]); }
    }
    // The Automation editor has each too (its sentence pickers).
    for (const c of conds) expect(condDef(c)?.group, c.kind).toBeTruthy();
    for (const a of acts) expect(actDef(a)?.group, a.kind).toBeTruthy();
    expect(condDef({ kind: 'no-monster-near', meters: 5, object: 'Lifestone' })?.id).toBe('nomon-object');
    // No player-facing "beyond VTank" label (the provenance note lives in code and docs).
    for (const d of [...VT_CONDITIONS, ...VT_ACTIONS]) expect(d.label).not.toMatch(/vtank|virindi/i);
    expect(Object.values({ ...VT_CONDITION_HELP, ...VT_ACTION_HELP }).join(' ')).not.toMatch(/beyond/i);
  });
});

describe('beyond-VTank conditions on the engine', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
  afterEach(() => vi.useRealTimers());
  const fires = (c: RoutineCondition): { fires: boolean; why: string[] } => { api.routine.start(profile([c], [{ kind: 'stop' }])); return api.routine.dryRun()[0]; };

  it('attacked by at least N counts the creatures the attack lines of the last 10 s name', () => {
    host.add({ guid: 0x80001001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 22 });
    host.add({ guid: 0x80001002, name: 'Mosswart', itemType: 0x10, objectDescFlags: 0x10, x: 82, y: 20 });
    expect(fires({ kind: 'attackers-at-least', count: 1 })).toMatchObject({ fires: false, why: ['✗ nothing attacking you'] });
    api.pushChat('Drudge Skulker hits you for 3 points of bludgeoning damage!', 0x15);
    expect(fires({ kind: 'attackers-at-least', count: 1 }).fires).toBe(true);
    expect(fires({ kind: 'attackers-at-least', count: 2 }).fires).toBe(false);
    api.pushChat('You evaded Mosswart!', 0x15);
    expect(fires({ kind: 'attackers-at-least', count: 2 })).toMatchObject({ fires: true, why: ['✓ 2 attacking you (Drudge Skulker, Mosswart)'] });
    host.t += AgentApi.ATTACKER_WINDOW_MS + 100;
    expect(fires({ kind: 'attackers-at-least', count: 1 }).fires).toBe(false);
  });

  it('being cast at holds for its window after a spell at you, then lapses', () => {
    host.add({ guid: 0x80005001, name: 'Lich', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 45 });
    expect(fires({ kind: 'being-cast-at' }).fires).toBe(false);
    api.pushChat('You resist the spell cast by Lich', 0x11);
    expect(fires({ kind: 'being-cast-at' }).fires).toBe(true);
    host.t += (BEING_CAST_AT_S - 1) * 1000;
    expect(fires({ kind: 'being-cast-at' }).fires).toBe(true);
    host.t += 2000;
    expect(fires({ kind: 'being-cast-at' }).fires).toBe(false);
    expect(fires({ kind: 'being-cast-at', seconds: 10 }).fires).toBe(true);
  });

  it('no monster near a point, or near a named object, measures from there, not from you', () => {
    host.add({ guid: 0x80001001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 60 });
    host.add({ guid: 0x80003001, name: 'Lifestone', itemType: 0x80, x: 80, y: 62 });
    // You at (80, 20): the drudge is 40 m off, but 2 m from the lifestone and the point.
    expect(fires({ kind: 'no-monster-within', meters: 10 }).fires).toBe(true);
    expect(fires({ kind: 'no-monster-near', meters: 10, coords: at(80, 62) })).toMatchObject({ fires: false });
    expect(fires({ kind: 'no-monster-near', meters: 10, coords: at(80, 20) }).fires).toBe(true);
    expect(fires({ kind: 'no-monster-near', meters: 10, object: 'Lifestone' })).toMatchObject({ fires: false, why: ['✗ Drudge Skulker 2 m from Lifestone'] });
    expect(fires({ kind: 'no-monster-near', meters: 1, object: 'Lifestone' }).fires).toBe(true);
    // An object out of sight can't be measured from: never holds.
    expect(fires({ kind: 'no-monster-near', meters: 10, object: 'Portal to Nowhere' })).toMatchObject({ fires: false, why: ['✗ Portal to Nowhere not in sight'] });
  });

  it('my corpse within R: only "Corpse of <me>"', () => {
    host.add({ guid: 0x80002001, name: 'Corpse of Drudge Skulker', objectDescFlags: 0x2000, x: 80, y: 23 });
    expect(fires({ kind: 'my-corpse-within', meters: 30 }).fires).toBe(false);
    host.add({ guid: 0x80002002, name: `Corpse of ${host.me.name}`, objectDescFlags: 0x2000, x: 80, y: 45 });
    expect(fires({ kind: 'my-corpse-within', meters: 30 })).toMatchObject({ fires: true, why: ['✓ your corpse 25 m away'] });
    expect(fires({ kind: 'my-corpse-within', meters: 10 }).fires).toBe(false);
  });

  // BUG.my-corpse-within-beyond-sight (Dark Majesty, 2026-10-13): a corpse 425 m back never held at 500 m.
  /** The server's corpse line for a landblock-local point: ACE GetMapCoordStr, one decimal (±12 m). */
  const corpseLine = (x: number, y: number): string => {
    const ns = (OY + y) / 240 - MAP_COORD_ORIGIN, ew = (OX + x) / 240 - MAP_COORD_ORIGIN;
    return `Your corpse is located at (${Math.abs(ns).toFixed(1)}${ns < 0 ? 'S' : 'N'}, ${Math.abs(ew).toFixed(1)}${ew < 0 ? 'W' : 'E'}).`;
  };
  const meG = () => ({ x: OX + host.me.x, y: OY + host.me.y });

  it('my corpse within R: the server\'s "Your corpse is located at" line counts past the objects in view', () => {
    // You at (80, 20); the corpse 288 m west and 312 m north, far past anything the client holds (the live case: 425 m).
    const line = corpseLine(80 - 288, 20 + 312);
    api.pushChat(line, 0);
    const g = parseMapCoords(line)!;
    const d = Math.round(Math.hypot(g.x - meG().x, g.y - meG().y));
    expect(d).toBeGreaterThan(400);
    expect(d).toBeLessThan(450);
    expect(fires({ kind: 'my-corpse-within', meters: 500 })).toMatchObject({ fires: true, why: [`✓ your corpse ${d} m away (where the server said it is)`] });
    expect(fires({ kind: 'my-corpse-within', meters: 100 })).toMatchObject({ fires: false, why: [`✗ your corpse ${d} m away (where the server said it is)`] });
    // Only the server's own line: someone saying it doesn't count.
    const other = new AgentApi(new FakeHost());
    other.pushChat(`Bulwark says, "${corpseLine(80, 40)}"`, 2);
    expect(other.myCorpse()).toBeNull();
    // A death without the space (the retail capture quoted in ClassicDereth Player.cpp) parses too.
    other.pushChat('Your corpse is located at(42.1N, 33.6E).', 0);
    expect(other.myCorpse()).toMatchObject(parseMapCoords('42.1N, 33.6E')!);
  });

  it('my corpse within R: the next death\'s line replaces it, and it rots on ACE\'s player-corpse timer', () => {
    api.pushChat(corpseLine(80 - 288, 20 + 312), 0);
    // Died again, 80 m north: past CORPSE_SIGHT_M, so only the rot timer forgets it (standing at it would prove it gone).
    api.pushChat(corpseLine(80, 100), 0);
    expect(fires({ kind: 'my-corpse-within', meters: 100 }).fires).toBe(true);
    // Level 5: max(3600, 5 × 300) s (ACE Corpse.RecalculateDecayTime).
    expect(AgentApi.corpseRotSeconds(5)).toBe(3600);
    expect(AgentApi.corpseRotSeconds(30)).toBe(9000);
    host.t += 3600 * 1000 - 1000;
    expect(fires({ kind: 'my-corpse-within', meters: 100 }).fires).toBe(true);
    host.t += 2000;
    expect(fires({ kind: 'my-corpse-within', meters: 100 })).toMatchObject({ fires: false, why: ['✗ no corpse of yours within 100 m'] });
  });

  it('my corpse within R: a corpse the server removes while in view (looted empty) stops holding; one the client let go out of range does not', () => {
    api.pushChat(corpseLine(80, 60), 0);
    host.add({ guid: 0x80002002, name: `Corpse of ${host.me.name}`, objectDescFlags: 0x2000, x: 81, y: 62 });
    run(api, host, 200);
    expect(api.myCorpse()).toMatchObject({ guid: 0x80002002, x: OX + 81, y: OY + 62 });
    expect(fires({ kind: 'my-corpse-within', meters: 100 })).toMatchObject({ fires: true, why: ['✓ your corpse 42 m away'] });
    host.objs.delete(0x80002002); // looted empty: ACE rots it in Corpse.EmptyDecayTime and deletes it
    run(api, host, 200);
    expect(fires({ kind: 'my-corpse-within', meters: 100 })).toMatchObject({ fires: false, why: ['✗ no corpse of yours within 100 m'] });

    // Released out of range (lost), then the client's object upkeep deletes it: still there, where it was.
    api.pushChat(corpseLine(80, 60), 0);
    const k = host.add({ guid: 0x80002003, name: `Corpse of ${host.me.name}`, objectDescFlags: 0x2000, x: 81, y: 62 });
    run(api, host, 200);
    k.lost = true;
    run(api, host, 200);
    host.objs.delete(0x80002003);
    run(api, host, 200);
    expect(fires({ kind: 'my-corpse-within', meters: 100 })).toMatchObject({ fires: true, why: ['✓ your corpse 42 m away (where the server said it is)'] });
  });

  // BUG.my-corpse-rotted-empty (local ACE, 2026-10-14): ACE's default corpse_destroy_pyreals left a level-8 death's
  // corpse empty, it rotted in 10 s, and "my corpse within 300" held 11 m from a spot with nothing there.
  it('my corpse within R: standing at the reported spot with no corpse there forgets it (rotted empty)', () => {
    api.pushChat(corpseLine(80, 30), 0); // 10 m north of you
    run(api, host, AgentApi.CORPSE_ABSENT_GRACE_MS - 500);
    // Within the grace (its CreateObject may still be on the way): kept.
    expect(api.myCorpse()).not.toBeNull();
    expect(fires({ kind: 'my-corpse-within', meters: 300 }).fires).toBe(true);
    run(api, host, 1000);
    expect(api.myCorpse()).toBeNull();
    expect(fires({ kind: 'my-corpse-within', meters: 300 })).toMatchObject({ fires: false, why: ['✗ no corpse of yours within 300 m'] });
  });

  it('my corpse within R: a reported corpse past the sight margin, or while in portal space, or while dead, is kept', () => {
    // 100 m off (past CORPSE_SIGHT_M, inside 112.5 m): the client may not hold it yet.
    expect(AgentApi.CORPSE_SIGHT_M).toBeLessThan(100);
    api.pushChat(corpseLine(80, 120), 0);
    run(api, host, 30_000);
    expect(api.myCorpse()).not.toBeNull();
    expect(fires({ kind: 'my-corpse-within', meters: 300 }).fires).toBe(true);
    // At the spot, but in portal space or dead: nothing is streaming in, so nothing is proved.
    api.pushChat(corpseLine(80, 25), 0);
    host.screenName = 'portal-space';
    run(api, host, 30_000);
    expect(api.myCorpse()).not.toBeNull();
    host.screenName = 'world';
    host.me.dead = true;
    run(api, host, 30_000);
    expect(api.myCorpse()).not.toBeNull();
    host.me.dead = false;
    // Arrived (the portal set you down): the grace counts from now.
    run(api, host, AgentApi.CORPSE_ABSENT_GRACE_MS - 500);
    expect(api.myCorpse()).not.toBeNull();
    run(api, host, 1000);
    expect(api.myCorpse()).toBeNull();
  });

  it('my corpse within R: a teleport onto the spot restarts the grace', () => {
    api.pushChat(corpseLine(80, 30), 0);
    run(api, host, 3000);
    // Recalled and back (a 100 m jump within one look, still beside the spot): objects stream in again.
    host.me.y = 75; api.tick(); host.me.y = 25; api.tick();
    run(api, host, AgentApi.CORPSE_ABSENT_GRACE_MS - 500);
    expect(api.myCorpse()).not.toBeNull();
    run(api, host, 1000);
    expect(api.myCorpse()).toBeNull();
  });

  it('my corpse within R: a matching corpse at the spot is tied and kept past the grace', () => {
    api.pushChat(corpseLine(80, 30), 0);
    host.add({ guid: 0x80002004, name: `Corpse of ${host.me.name}`, objectDescFlags: 0x2000, x: 82, y: 33 });
    run(api, host, 30_000);
    expect(api.myCorpse()).toMatchObject({ guid: 0x80002004, x: OX + 82, y: OY + 33 });
    expect(fires({ kind: 'my-corpse-within', meters: 300 })).toMatchObject({ fires: true, why: ['✓ your corpse 13 m away'] });
    // Someone else's corpse at the spot doesn't keep yours.
    api.pushChat(corpseLine(80 - 300, 30), 0);
    host.add({ guid: 0x80002005, name: 'Corpse of Drudge Skulker', objectDescFlags: 0x2000, x: 82, y: 33 });
    host.me.x = 80 - 300;
    run(api, host, 30_000);
    expect(api.myCorpse()).toBeNull();
  });

  it('my corpse within R: a corpse in view past the 120 m shared look holds', () => {
    host.add({ guid: 0x80002002, name: `Corpse of ${host.me.name}`, objectDescFlags: 0x2000, x: 80, y: 170 });
    expect(fires({ kind: 'my-corpse-within', meters: 200 })).toMatchObject({ fires: true, why: ['✓ your corpse 150 m away'] });
    expect(fires({ kind: 'my-corpse-within', meters: 100 }).fires).toBe(false);
  });

  it('monster conditions see as far as they say, past the 120 m shared look and past its 60 objects', () => {
    host.add({ guid: 0x80001001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 180 });
    expect(fires({ kind: 'monster-within', meters: 200 })).toMatchObject({ fires: true, why: ['✓ Drudge Skulker at 160 m'] });
    expect(fires({ kind: 'no-monster-within', meters: 200 }).fires).toBe(false);
    expect(fires({ kind: 'monster-within', meters: 150 }).fires).toBe(false);
    expect(fires({ kind: 'monster-count', pattern: 'Drudge', count: 1, meters: 200 }).fires).toBe(true);
    // A lifestone 150 m off with the drudge beside it.
    host.add({ guid: 0x80003001, name: 'Lifestone', itemType: 0x80, x: 80, y: 170 });
    expect(fires({ kind: 'no-monster-near', meters: 20, object: 'Lifestone' })).toMatchObject({ fires: false, why: ['✗ Drudge Skulker 10 m from Lifestone'] });
    expect(fires({ kind: 'no-monster-near', meters: 20, coords: at(80, 175) }).fires).toBe(false);
    // 61 corpses at your feet fill the shared look's 60: the drudge 30 m off still counts.
    host.objs.get(0x80001001)!.y = 50;
    for (let i = 0; i < 61; i++) host.add({ guid: 0x80004000 + i, name: 'Corpse of Mite', objectDescFlags: 0x2000, x: 80, y: 21 });
    expect(fires({ kind: 'monster-within', meters: 40 }).fires).toBe(true);
    expect(fires({ kind: 'monster-count', pattern: 'Drudge', count: 1, meters: 40 }).fires).toBe(true);
  });
});

describe('beyond-VTank actions on the engine', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
  afterEach(() => vi.useRealTimers());

  it('flee-to walks with flee on (keeps going while hit)', async () => {
    const walk = vi.spyOn(api, 'walkTo').mockResolvedValue({ ok: true, message: 'arrived' });
    const p = profile([], []);
    api.routine.start(p);
    const r = await engine(api).act({ kind: 'flee-to', coords: at(80, 80) }, p);
    expect(r?.ok).toBe(true);
    expect(walk).toHaveBeenCalledWith(at(80, 80), expect.objectContaining({ flee: true }));
  });

  it('flee-to with a portal: runs to the coords, then uses the portal, both through hits; a portal alone is enough', async () => {
    const walk = vi.spyOn(api, 'walkTo').mockResolvedValue({ ok: true, message: 'arrived' });
    const use = vi.spyOn(api, 'use').mockResolvedValue({ ok: true, message: 'used' });
    const p = profile([], []);
    api.routine.start(p);
    await engine(api).act({ kind: 'flee-to', coords: at(80, 80), portal: 'Portal to Holtburg' }, p);
    expect(walk).toHaveBeenCalledWith(at(80, 80), expect.objectContaining({ flee: true }));
    expect(use).toHaveBeenCalledWith('Portal to Holtburg', { flee: true });
    walk.mockClear(); use.mockClear();
    await engine(api).act({ kind: 'flee-to', coords: '', portal: 'Portal to Holtburg' }, p);
    expect(walk).not.toHaveBeenCalled();
    expect(use).toHaveBeenCalledWith('Portal to Holtburg', { flee: true });
    // A failed run never goes on to the portal.
    walk.mockResolvedValueOnce({ ok: false, message: 'stuck' }); use.mockClear();
    await engine(api).act({ kind: 'flee-to', coords: at(80, 80), portal: 'Portal to Holtburg' }, p);
    expect(use).not.toHaveBeenCalled();
  });

  it('hold position keeps attack-nearest off monsters past the anchor; release lets it fight them', async () => {
    host.add({ guid: 0x80001001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 31.5 });
    const p = profile([], []);
    api.routine.start(p);
    expect((await engine(api).act({ kind: 'hold-position', meters: 10 }, p))?.message).toMatch(/holding position/);
    const r = await engine(api).act({ kind: 'attack-nearest', meters: 60 }, p);
    // Idle: its rule rests, so a rule below it ("clear: move on") runs instead of this one firing twice a second (live, 2026-10-13).
    expect(r).toMatchObject({ ok: false, message: 'no monster in reach within 10 m of the held position', idle: true });
    expect(host.sent.some((s) => s.startsWith('attack'))).toBe(false);
    await engine(api).act({ kind: 'release-position' }, p);
    const fight = engine(api).act({ kind: 'attack-nearest', meters: 60 }, p);
    for (let i = 0; i < 10; i++) { run(api, host, 200); await vi.advanceTimersByTimeAsync(0); }
    expect(host.sent.some((s) => s.startsWith('attack 80001001'))).toBe(true);
    host.dying.add(0x80001001);
    run(api, host, 300);
    await vi.advanceTimersByTimeAsync(0);
    expect((await fight)?.ok).toBe(true);
  });

  it('hold position breaks off a fight whose target runs past the anchor', async () => {
    host.add({ guid: 0x80001001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 25 });
    const p = profile([], []);
    api.routine.start(p);
    await engine(api).act({ kind: 'hold-position', meters: 10 }, p);
    const fight = engine(api).act({ kind: 'attack-nearest', meters: 60 }, p);
    run(api, host, 300);
    expect(host.sent.some((s) => s.startsWith('attack 80001001'))).toBe(true);
    host.objs.get(0x80001001)!.y = 50; // it runs off down the hill
    for (let i = 0; i < 6; i++) { run(api, host, 200); await vi.advanceTimersByTimeAsync(0); }
    expect(await fight).toMatchObject({ ok: false, message: "Drudge Skulker went past the held position's 10 m: left it" });
    expect(host.sent).toContain('cancel');
  });

  it('hold position breaks off a target that runs past a held range wider than 120 m', async () => {
    host.add({ guid: 0x80001001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 25 });
    const p = profile([], []);
    api.routine.start(p);
    await engine(api).act({ kind: 'hold-position', meters: 130 }, p);
    const fight = engine(api).act({ kind: 'attack-nearest', meters: 60 }, p);
    run(api, host, 300);
    expect(host.sent.some((s) => s.startsWith('attack 80001001'))).toBe(true);
    host.objs.get(0x80001001)!.y = 170; // 150 m off: past the 130 m hold, and past a 120 m look
    for (let i = 0; i < 6; i++) { run(api, host, 200); await vi.advanceTimersByTimeAsync(0); }
    expect(await fight).toMatchObject({ ok: false, message: "Drudge Skulker went past the held position's 130 m: left it" });
  });

  it('the macro, holding position, fights nothing past the anchor; released, it does', async () => {
    host.add({ guid: 0x80001001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    const p = profile([], [], { macro: true, states: [{ name: 'Default', rules: [] }], settings: { AttackDistance: 20 } });
    api.routine.start(p);
    await engine(api).act({ kind: 'hold-position', meters: 5 }, p);
    run(api, host, 2000);
    expect(host.sent.some((s) => s.startsWith('attack'))).toBe(false);
    await engine(api).act({ kind: 'release-position' }, p);
    run(api, host, 2000);
    expect(host.sent.some((s) => s.startsWith('attack 80001001'))).toBe(true);
  });

  it('pull: one attack until a swing lands, break off, run back with flee, then hold there', async () => {
    host.add({ guid: 0x80001001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    host.add({ guid: 0x80001002, name: 'Mosswart', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 28 });
    const walk = vi.spyOn(api, 'walkTo').mockResolvedValue({ ok: true, message: 'arrived' });
    const p = profile([], []);
    api.routine.start(p);
    const pulled = engine(api).act({ kind: 'pull', pattern: '^Drudge', back: at(80, 5), holdMeters: 8 }, p);
    run(api, host, 300);
    expect(host.sent.some((s) => s.startsWith('attack 80001001'))).toBe(true);
    expect(host.sent.some((s) => s.startsWith('attack 80001002'))).toBe(false);
    api.pushChat('You hit Drudge Skulker for 6 points of slashing damage!', 0x16);
    for (let i = 0; i < 3; i++) { run(api, host, 200); await vi.advanceTimersByTimeAsync(0); }
    const r = await pulled;
    expect(r?.message).toMatch(/^pulled Drudge Skulker \(You hit Drudge Skulker/);
    expect(host.sent).toContain('cancel');
    expect(walk).toHaveBeenCalledWith(at(80, 5), expect.objectContaining({ flee: true }));
    // Held at the fallback point: the Mosswart (23 m from it) is left alone.
    expect(await engine(api).act({ kind: 'attack-nearest', meters: 60 }, p)).toMatchObject({ ok: false });
  });

  it('pull with nothing matching does nothing', async () => {
    const p = profile([], []);
    api.routine.start(p);
    expect(await engine(api).act({ kind: 'pull', pattern: 'Olthoi', back: at(80, 5) }, p)).toMatchObject({ ok: false, idle: true });
    expect(host.sent.some((s) => s.startsWith('attack'))).toBe(false);
  });

  it('loot-corpse loots the corpse of that name through the loot path, not the nearest corpse', async () => {
    host.add({ guid: 0x80002001, name: 'Corpse of Drudge Skulker', objectDescFlags: 0x2000, x: 80, y: 21 });
    host.add({ guid: 0x80002002, name: 'Corpse of Azreath Lightbringer', objectDescFlags: 0x2000, x: 80, y: 30 });
    const loot = vi.spyOn(api, 'loot').mockResolvedValue({ ok: true, message: 'looted' });
    const p = profile([], []);
    api.routine.start(p);
    expect(await engine(api).act({ kind: 'loot-corpse', name: 'corpse of azreath lightbringer' }, p)).toMatchObject({ ok: true });
    expect(loot).toHaveBeenCalledTimes(1);
    expect(loot.mock.calls[0][0]).toBe(0x80002002);
    expect(await engine(api).act({ kind: 'loot-corpse', name: 'Corpse of Nobody' }, p)).toMatchObject({ ok: true, idle: true });
  });

  it('recall: a command recall goes through when nothing attacks', async () => {
    const say = vi.spyOn(api, 'say');
    const p = profile([], []);
    api.routine.start(p);
    const r = engine(api).act({ kind: 'recall', via: '/ls' }, p);
    run(api, host, 500);
    expect(say).toHaveBeenCalledWith('/ls');
    host.screenName = 'portal-space';
    run(api, host, 300); await vi.advanceTimersByTimeAsync(0);
    host.screenName = 'world';
    run(api, host, 300); await vi.advanceTimersByTimeAsync(300);
    expect(await r).toMatchObject({ ok: true, message: 'recalled (/ls)' });
  });

  it('recall: aborted with a jump and a run away once enough creatures attack during the kneel', async () => {
    host.add({ guid: 0x80001001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 22 });
    host.add({ guid: 0x80001002, name: 'Mosswart', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 22 });
    const jump = vi.spyOn(api, 'jump');
    const walk = vi.spyOn(api, 'walkTo').mockResolvedValue({ ok: true, message: 'arrived' });
    const p = profile([], []);
    api.routine.start(p);
    const r = engine(api).act({ kind: 'recall', via: '/ls', abortAttackers: 2 }, p);
    run(api, host, 500); await vi.advanceTimersByTimeAsync(0);
    api.pushChat('Drudge Skulker hits you for 3 points of bludgeoning damage!', 0x15);
    run(api, host, 500); await vi.advanceTimersByTimeAsync(0);
    expect(jump).not.toHaveBeenCalled(); // one attacker: still kneeling
    api.pushChat('Mosswart hits you for 2 points of bludgeoning damage!', 0x15);
    for (let i = 0; i < 4; i++) { run(api, host, 200); await vi.advanceTimersByTimeAsync(200); }
    const res = await r;
    expect(jump).toHaveBeenCalled();
    expect(walk).toHaveBeenCalledWith('10m south', expect.objectContaining({ flee: true }));
    expect(res).toMatchObject({ ok: false });
    expect(res?.message).toMatch(/^recall aborted: 2 creature\(s\) attacking you; ran south/);
  });

  it('recall: not started at all while already over the limit; a recall spell is cast by name', async () => {
    host.add({ guid: 0x80001001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 22 });
    api.pushChat('Drudge Skulker hits you for 3 points of bludgeoning damage!', 0x15);
    const p = profile([], []);
    api.routine.start(p);
    const say = vi.spyOn(api, 'say');
    expect(await engine(api).act({ kind: 'recall', via: '/ls' }, p)).toMatchObject({ ok: false, message: 'not recalling: 1 creature(s) attacking you' });
    expect(say).not.toHaveBeenCalled();
    host.t += AgentApi.ATTACKER_WINDOW_MS + 100;
    const cast = vi.spyOn(api, 'cast').mockResolvedValue({ ok: false, message: "you don't know a spell named Lifestone Recall" });
    const r = engine(api).act({ kind: 'recall', via: 'Lifestone Recall' }, p);
    await vi.advanceTimersByTimeAsync(300);
    expect(await r).toMatchObject({ ok: false, message: "you don't know a spell named Lifestone Recall" });
    expect(cast).toHaveBeenCalledWith('Lifestone Recall', 'self');
  });
});
