/**
 * Agent-tool fixes from the stream players' segment 17:10–17:54Z on 2026-10-17 (end-of-retail local ACE, Tusker Habitat
 * 0x5B47; build 1980be57; reports stream/reports/{soldier-2026-10-17T17-53-28-836Z,mage-2026-10-17T17-54-04-210Z}-seg1.md;
 * transcripts stream/sessions/{soldier,mage}-2026-10-17-seg1.jsonl; page logs soldier.log / mage.log):
 *   1. Bulwark: "On ramps, attacking gives 'Unable to move to object!' or target-lost". The page log shows two different
 *      things. (a) Both "Unable to move to object!" lines were WeenieError 0x37 ObjectGone (soldier.log 17:43:12.364Z,
 *      17:49:03.447Z), each a second after his target died (#8000cfb4 died 17:43:11; #80000806 read DYING at 17:49:02):
 *      ACE's charge approach (Player.MoveTo → MoveToManager.HandleUpdateTarget → CancelMoveTo(ObjectGone) →
 *      Player.OnMoveComplete → SendWeenieError) ending because the target left the server's tracking. Nothing went
 *      wrong, but nothing said so. (b) #8000032f, 2–3 m off and 2–3 m below on the ramp: TargetedMeleeAttack at
 *      17:49:06.886Z, then no swing, no AttackDone and no WeenieError for 20 s until the agent's own target-lost cancel
 *      (17:49:26Z, answered "Action cancelled!"). ACE's player charge MoveTo has no progress give-up (FailProgressCount
 *      is a monster's), so a straight line it can't walk waits silently. walk_to Arcanist (the planner: down through
 *      the 1.7 m floor opening) then the attack worked (17:49:35–17:50:09Z).
 *      Now: an approach the server gave up on (those WeenieErrors) or left stuck (8 s, no answer, no nearer) is run up
 *      to with the walk planner and attacked once more, and the reply says which; one after a target's death is said
 *      to be that death's.
 *   2. Bulwark: `ac_press key=Sitting` → "no key or keymap action" (17:20:25Z), right after the /sit hint's "take the
 *      Sitting stance". The ActionMap's emote input actions answer to their posture motion's name (ACCmdInterp::
 *      InitializeEmoteInputActionHash), names to their squashed and inflected forms, and a refusal names the closest.
 *   3. Arcanist: `follow … timeout_s=40` → unknown argument (17:52:51Z); each tool with one time argument takes the
 *      others' names for it.
 * Each drives the shipped modules (AgentApi on the fake host, the keybind lookup over the real ActionMap table, the
 * CLI tool table).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, type AgentHostObject } from '../packages/renderer/src/agent/AgentApi.ts';
import { findKeybindAction, resolvePress, EMOTE_INPUT_ACTION_MOTIONS } from '../packages/renderer/src/input/KeybindActionLookup.ts';
import { KEYBIND_ACTIONS } from '../packages/renderer/src/input/KeybindActions.generated.ts';
import { KeybindRegistry } from '../packages/renderer/src/input/KeybindRegistry.ts';
import { ACT, DEFAULT_KEYBINDS } from '../packages/renderer/src/input/KeybindDefaults.ts';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.ts';
import { TOOL_BY_NAME, TOOL_CALLER, inputSchema, unknownArgs } from '../tools/ac-agent/tools.ts';
import { parseCliArgs } from '../tools/ac-agent/cli.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const LIB = (guid: number, o: Partial<AgentHostObject> = {}): Partial<AgentHostObject> & { guid: number; name: string } =>
  ({ guid, name: 'Tusker Liberator', itemType: 0x10, objectDescFlags: 0x10, level: 60, ...o });
const texts = (api: AgentApi, since = 0): string[] => api.eventsSince(since).map((e) => `${e.type}: ${e.text}`);
const attacks = (host: FakeHost, g: number): number => host.sent.filter((x) => x.startsWith(`attack ${g.toString(16)}`)).length;

describe('1. a melee approach the server gives up on, or leaves stuck', () => {
  const C32F = 0x8000032f, CFB4 = 0x8000cfb4, D187 = 0x8000d187;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    api = new AgentApi(host);
    host.me.combatMode = 'melee';
    host.me.health = { current: 181, max: 181 };
    // The server answers a CancelAttack with AttackDone(ActionCancelled): the client's request is no longer pending.
    host.cancelAttack = () => { host.sent.push('cancel'); host.pending = false; };
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('stuck 8 s (no swing, no AttackDone, no nearer: #8000032f 2.3 m off, 2 m down): run up with the planner, attack again', async () => {
    host.add(LIB(C32F, { x: 80, y: 22.3, z: 92 }));
    run(api, host, 200, { physics: false });
    const since = api.observe().seq;
    const r = api.attack(C32F);
    expect(r.message).toMatch(/^attacking Tusker Liberator \(#8000032f\)/);
    // The server's charge MoveTo never gets there and never answers (soldier.log 17:49:06.886–17:49:26Z).
    run(api, host, 7000, { physics: false });
    expect(host.sent).not.toContain('cancel');
    run(api, host, 1500, { physics: false });
    expect(host.sent).toContain('cancel');
    const done = texts(api, since).filter((t) => t.startsWith('task-done'));
    expect(done).toEqual(['task-done: attacking Tusker Liberator: the server\'s walk to Tusker Liberator (3.0 m off, 2.0 m below you) got you no nearer in 8 s, with no swing and no answer (its MoveTo goes in a straight line, and that line doesn\'t get there); running up to it with the walk planner (the way round, down or up that it finds), then attacking it once more (an "Action cancelled!" now is the server answering the stop of its walk)']);
    expect(texts(api, since).filter((t) => t.startsWith('target-lost'))).toEqual([]);
    // The planner's run-up (the fake's body runs), then the attack again.
    for (let t = 0; t < 10_000 && attacks(host, C32F) < 2; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
    expect(attacks(host, C32F)).toBe(2);
    expect(Math.hypot(host.me.x - 80, host.me.y - 22.3)).toBeLessThanOrEqual(1.6);
    expect(texts(api, since).some((t) => /^chat: \(system\) \[Agent\] Tusker Liberator #8000032f: ran up to it with the walk planner \(arrived \(1\.\d m from [^)]+\)\); attacking it again$/.test(t))).toBe(true);
    // Swinging now: no second stall while the server swings.
    host.pending = false;
    for (let i = 0; i < 12; i++) {
      api.pushAttackDone(0);
      api.pushChat('Recklessness! You bash Tusker Liberator for 30 points of bludgeoning damage!', 0x15);
      run(api, host, 1000, { physics: false });
    }
    expect(texts(api, since).filter((t) => t.startsWith('target-lost'))).toEqual([]);
    expect(api.hasTask).toBe(true);
  });

  it('stuck again after the planner\'s run-up: target-lost says so (one retry only)', async () => {
    host.add(LIB(C32F, { x: 80, y: 22.3, z: 92 }));
    run(api, host, 200, { physics: false });
    const since = api.observe().seq;
    api.attack(C32F);
    run(api, host, 8500, { physics: false });
    for (let t = 0; t < 10_000 && attacks(host, C32F) < 2; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
    expect(attacks(host, C32F)).toBe(2);
    run(api, host, 9000, { physics: false });
    const lost = texts(api, since).filter((t) => t.startsWith('target-lost'));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatch(/^target-lost: Tusker Liberator #8000032f: the server's walk to Tusker Liberator \(\d\.\d m off, 2\.0 m below you\) got you no nearer in 8 s, with no swing and no answer .*, again after the walk planner's run-up: the server can't bring you to it from where the planner reaches\./);
    expect(attacks(host, C32F)).toBe(2);
  });

  it('"Unable to move to object!" (ObjectGone) on a live target: the same run-up and retry, naming the WeenieError', async () => {
    host.add(LIB(C32F, { x: 80, y: 25, z: 92 }));
    run(api, host, 200, { physics: false });
    const since = api.observe().seq;
    api.attack(C32F);
    run(api, host, 1000, { physics: false });
    // ACE: OnMoveComplete → SendWeenieError(status), then HandleActionCancelAttack's AttackDone(ActionCancelled).
    api.pushChat('Unable to move to object!', 0);
    api.pushWeenieError(0x37);
    api.pushAttackDone(0x36);
    run(api, host, 200, { physics: false });
    expect(texts(api, since).filter((t) => t.startsWith('task-done'))).toEqual(['task-done: attacking Tusker Liberator: the server answered "Unable to move to object!" (WeenieError ObjectGone): its walk to Tusker Liberator (5.4 m off, 2.0 m below you) gave up; running up to it with the walk planner (the way round, down or up that it finds), then attacking it once more (an "Action cancelled!" now is the server answering the stop of its walk)']);
    for (let t = 0; t < 10_000 && attacks(host, C32F) < 2; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
    expect(attacks(host, C32F)).toBe(2);
  });

  it('"You charged too far!" (YouChargedTooFar, ACE FailDistance 15 m) is the same shape', () => {
    host.add(LIB(C32F, { x: 80, y: 25 }));
    run(api, host, 200, { physics: false });
    const since = api.observe().seq;
    api.attack(C32F);
    run(api, host, 1000, { physics: false });
    api.pushWeenieError(0x3d);
    run(api, host, 200, { physics: false });
    expect(texts(api, since).find((t) => t.startsWith('task-done'))).toMatch(/^task-done: attacking Tusker Liberator: the server answered "You charged too far!" \(WeenieError YouChargedTooFar\): its walk to Tusker Liberator \(5\.0 m off\) gave up; running up to it with the walk planner/);
  });

  it('ObjectGone a second after the target died (#8000cfb4, 17:43:11–12Z): said to be its death; the next attack is untouched', () => {
    host.add(LIB(CFB4, { x: 80, y: 22.5 }));
    host.add(LIB(D187, { x: 81, y: 22.5 }));
    run(api, host, 200, { physics: false });
    const since = api.observe().seq;
    api.attack(CFB4);
    run(api, host, 1000, { physics: false });
    host.dying.add(CFB4);
    run(api, host, 200, { physics: false });
    expect(texts(api, since)).toContain('target-died: Tusker Liberator #8000cfb4 died');
    // The next target at once, then the dead one's approach end arrives.
    api.attack(D187);
    run(api, host, 300, { physics: false });
    api.pushChat('Unable to move to object!', 0);
    api.pushWeenieError(0x37);
    run(api, host, 3000, { physics: false });
    expect(texts(api, since)).toContain('chat: (system) [Agent] "Unable to move to object!" is the server\'s approach to Tusker Liberator #8000cfb4 ending because it died (WeenieError ObjectGone: the target left the server\'s tracking): nothing went wrong, and it says nothing about where you stand');
    expect(host.sent.filter((x) => x === 'cancel')).toEqual([]);
    expect(api.hasTask).toBe(true);
    expect(texts(api, since).filter((t) => /task-done: attacking Tusker Liberator: the server answered/.test(t))).toEqual([]);
  });

  it('an approach under way (nearer each second) is not stuck, however long it takes', () => {
    host.add(LIB(C32F, { x: 80, y: 31 }));
    run(api, host, 200, { physics: false });
    api.attack(C32F);
    // The server's charge brings you closer: 1 m a second.
    for (let i = 0; i < 9; i++) { host.me.y += 1; run(api, host, 1000, { physics: false }); }
    expect(host.sent).not.toContain('cancel');
    expect(api.hasTask).toBe(true);
  });

  it('a server that swings (AttackDone 0 between swings) is never called stuck', () => {
    host.add(LIB(C32F, { x: 80, y: 22.3 }));
    run(api, host, 200, { physics: false });
    api.attack(C32F);
    for (let i = 0; i < 10; i++) {
      api.pushAttackDone(0);
      api.pushChat('Recklessness! You graze Tusker Liberator for 12 points of bludgeoning damage!', 0x15);
      run(api, host, 1000, { physics: false });
    }
    expect(host.sent).not.toContain('cancel');
  });

  it('ranged attacks keep their own close-in (the server never walks an archer)', () => {
    host.me.combatMode = 'missile';
    host.inv = [{ guid: 0x8000aaaa, name: 'Longbow', where: 'equipped', itemType: 0x100, slot: 'Missile Weapon' }];
    host.add(LIB(C32F, { x: 80, y: 30 }));
    run(api, host, 200, { physics: false });
    api.attack(C32F);
    run(api, host, 9000, { physics: false });
    expect(texts(api).filter((t) => /running up to it with the walk planner/.test(t))).toEqual([]);
  });
});

describe('2. ac_press takes the action\'s other names (ActionMap 0x26000000 names)', () => {
  const reg = new KeybindRegistry(DEFAULT_KEYBINDS);
  const mappings = (id: number): readonly (string | null | undefined)[] => reg.getMappings(id);

  it('"Sitting" (the posture motion the Sit action holds) presses Sit: KeyG in the end-of-retail KeyMap', () => {
    expect(EMOTE_INPUT_ACTION_MOTIONS.get(ACT.Sitting)).toBe(MotionCommand.Sitting);
    const r = resolvePress(reg.actions(), mappings, 'Sitting');
    expect(r).toMatchObject({ ok: true, code: 'KeyG', action: { name: 'Sit' } });
    expect(resolvePress(reg.actions(), mappings, 'Sit')).toMatchObject({ ok: true, code: 'KeyG', action: { name: 'Sit' } });
  });

  it('each emote input action by its motion\'s name, and names squashed or inflected', () => {
    const name = (s: string): string | null => findKeybindAction(KEYBIND_ACTIONS, s).action?.name ?? null;
    expect(name('Sleeping')).toBe('Lay Down');
    expect(name('crouching')).toBe('Crouch');
    expect(name('ready')).toBe('Ready');
    expect(name('lay_down')).toBe('Lay Down');
    expect(name('LayDown')).toBe('Lay Down');
    expect(name('ShowHideInventoryPanel')).toBe('Show/Hide Inventory Panel');
    expect(name('Jumping')).toBe('Jump');
    expect(name('Toggling Combat Mode')).toBe('Toggle Combat Mode');
    // The old lookup's part of a name still works.
    expect(name('Inventory Panel')).toBe('Show/Hide Inventory Panel');
  });

  it('a name nothing matches is refused with the closest names', () => {
    const r = resolvePress(reg.actions(), mappings, 'Lie Down');
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/^no key or keymap action "Lie Down"; closest: "Lay Down"(, "[^"]+")* \(ac_keys lists them\)$/);
    const s = resolvePress(reg.actions(), mappings, 'Sitt');
    expect((s as { message?: string }).message ?? '').toMatch(/closest: "Sit"/);
  });

  it('a key code is pressed as given', () => {
    expect(resolvePress(reg.actions(), mappings, 'Ctrl+KeyI')).toMatchObject({ ok: true, code: 'Ctrl+KeyI' });
    expect(resolvePress(reg.actions(), mappings, 'F9')).toMatchObject({ ok: true, code: 'F9' });
  });
});

describe('3. a tool\'s time argument by the other tools\' names', () => {
  it('follow timeout_s=40 is duration_s=40 (Arcanist 17:52:51Z), on the CLI and in the MCP schema', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const caller = { notice: null, call: async <T,>(m: string, a: unknown[]) => { calls.push([m, a]); return { ok: true, message: 'x' } as T; } };
    const follow = TOOL_BY_NAME.get('ac_follow')!;
    await TOOL_CALLER.run(caller, () => follow.run(parseCliArgs(follow, ['target=Claude Bulwark', 'flee=true', 'timeout_s=40'])));
    expect(calls[0]).toEqual(['follow', ['Claude Bulwark', { within: null, durationMs: 40_000, flee: true }]]);
    // duration_s wins when both are given.
    await TOOL_CALLER.run(caller, () => follow.run(parseCliArgs(follow, ['target=Claude Bulwark', 'duration_s=20', 'timeout_s=40'])));
    expect((calls[1][1][1] as { durationMs: number }).durationMs).toBe(20_000);
    expect((inputSchema(follow).properties as Record<string, { type: string }>).timeout_s.type).toBe('number');
    expect(unknownArgs(follow, { target: 'x', timeout_s: 40 })).toBeNull();
  });

  it('wait, walk_to, move and cast take the same names for theirs; trace\'s look-back is left alone', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const caller = { notice: null, call: async <T,>(m: string, a: unknown[]) => { calls.push([m, a]); return (m === 'wait' ? [] : { ok: true, message: 'x' }) as T; } };
    const walk = TOOL_BY_NAME.get('ac_walk_to')!;
    await TOOL_CALLER.run(caller, () => walk.run(parseCliArgs(walk, ['target=10m north', 'duration_s=30'])));
    expect((calls.at(-1)![1][1] as { timeoutMs: number }).timeoutMs).toBe(30_000);
    const move = TOOL_BY_NAME.get('ac_move')!;
    await TOOL_CALLER.run(caller, () => move.run(parseCliArgs(move, ['direction=back', 'duration_s=2'])));
    expect(calls.at(-1)).toEqual(['move', ['back', 2]]);
    for (const [tool, alias, real] of [['ac_wait', 'duration_s', 'timeout_s'], ['ac_wait', 'seconds', 'timeout_s'], ['ac_cast', 'timeout_s', 'max_s'], ['ac_follow', 'seconds', 'duration_s']] as const) {
      const t = TOOL_BY_NAME.get(tool)!;
      expect(unknownArgs(t, { [alias]: 5 }), `${tool} ${alias}`).toBeNull();
      expect(t.aliases?.[alias], `${tool} ${alias}`).toBe(real);
    }
    // ac_trace's seconds= is how far back, not how long: no alias; a timeout_s there points at it.
    const trace = TOOL_BY_NAME.get('ac_trace')!;
    expect(unknownArgs(trace, { timeout_s: 5 })).toMatch(/trace takes seconds=, not timeout_s=/);
  });
});
