/**
 * AGENT.routine-data — the per-account routine document: validation with
 * paths, the plain-language explanation, the store, and the ac_routines
 * tool Claude configures a player's routines with (docs/agent-play.md).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EXAMPLE_HUNT_PROFILE, ROUTINE_SCHEMA_VERSION, emptyRoutineDoc, explainProfile, validateRoutineDoc, type RoutineDoc,
} from '../packages/shared/src/routines/index.ts';
import { RoutineStore } from '../tools/ac-agent/routineStore.ts';
import { TOOL_BY_NAME } from '../tools/ac-agent/tools.ts';

const doc = (over: Partial<RoutineDoc> = {}): RoutineDoc => ({
  ...emptyRoutineDoc('local-eor', 'testacjs', new Date(0)), profiles: [structuredClone(EXAMPLE_HUNT_PROFILE)], ...over,
});

describe('routine document validation', () => {
  it('accepts the worked example', () => {
    expect(validateRoutineDoc(doc())).toEqual([]);
  });

  it('reports each problem with its path', () => {
    const d = doc();
    const p = d.profiles[0];
    p.initialState = 'Nowhere';
    p.states[0].rules[0].do = [{ kind: 'set-state', state: 'Rest' }];
    p.states[0].rules[1].when = [{ kind: 'vital-below', vital: 'health', percent: 140 }];
    p.states[0].rules[2].do = [{ kind: 'say', text: '@teleloc 0 0 0' }];
    p.loot[0].match.name = '([';
    p.routes[0].points = ['somewhere'];
    p.states[0].rules[4].do = [{ kind: 'train', plan: [{ stat: 'Strength', upTo: 0 }] }];
    const where = validateRoutineDoc(d).map((i) => `${i.path}: ${i.message}`);
    expect(where).toEqual(expect.arrayContaining([
      'profiles[0].initialState: no state named "Nowhere"',
      'profiles[0].states[0].rules[0].do[0]: set-state: no state named "Rest"',
      'profiles[0].states[0].rules[1].when[0]: vital-below: percent must be 0..100',
      'profiles[0].states[0].rules[2].do[0]: say: "@" server commands are not allowed (routines play as a player)',
      'profiles[0].loot[0].match.name: must be a valid regex',
      'profiles[0].routes[0].points: needs coordinates like "42.1N, 33.6E"',
      'profiles[0].states[0].rules[4].do[0]: train: plan[0]: upTo must be 1..10000',
    ]));
  });

  it('checks the document shell, duplicate names and character assignments', () => {
    expect(validateRoutineDoc(null)[0].message).toMatch(/JSON object/);
    const d = doc({ schemaVersion: 99, characters: { Claude: 'Nope' } });
    d.profiles.push(structuredClone(EXAMPLE_HUNT_PROFILE));
    const msgs = validateRoutineDoc(d).map((i) => i.message);
    expect(msgs).toEqual(expect.arrayContaining([`must be ${ROUTINE_SCHEMA_VERSION}`, `duplicate profile "${EXAMPLE_HUNT_PROFILE.name}"`, 'no profile named "Nope"']));
  });

  it('explains a profile in plain words', () => {
    const text = explainProfile(EXAMPLE_HUNT_PROFILE);
    expect(text).toContain('starts in "Hunt"');
    expect(text).toContain('1. Low health: when health below 40% → switch to "Recover"');
    expect(text).toContain('attack the nearest Drudge within 40 m, then loot corpses within 20 m by the loot rules');
    expect(text).toContain('3. Healing kits: keep-up-to 5: name /Healing Kit/');
    expect(text).toContain('5. Spend XP: when more than 5,000 unassigned XP → spend XP raising Strength to 100, Endurance to 100, Coordination to 100, Health to 150');
    expect(text).toContain('route "Lifestone loop" (circular): 42.0N, 33.5E → 41.6N, 33.9E → 41.2N, 33.4E');
  });
});

describe('routine store and ac_routines', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acjs-routines-'));
    process.env.ACJS_ROUTINES_DIR = dir;
  });

  it('stores valid documents per server/account and refuses invalid or mismatched ones', () => {
    const s = new RoutineStore(dir);
    expect(s.get('local-eor', 'testacjs').profiles).toEqual([]);
    const r = s.put('local-eor', 'testacjs', doc(), new Date(5));
    expect(r.ok).toBe(true);
    expect(s.get('local-eor', 'TestAcjs').profiles[0].name).toBe(EXAMPLE_HUNT_PROFILE.name);
    expect(s.accounts('local-eor')).toEqual(['testacjs']);
    const bad = s.put('local-eor', 'testacjs', { ...doc(), schemaVersion: 2 });
    expect(bad.ok).toBe(false);
    const other = s.put('local-eor', 'someoneelse', doc());
    expect(other.ok ? '' : other.issues[0].message).toMatch(/not local-eor\/someoneelse/);
    expect(() => s.path('..', 'x')).toThrow();
  });

  it('lets Claude configure an account with no game session: example → set → list → explain', async () => {
    const tool = TOOL_BY_NAME.get('ac_routines')!;
    const example = await tool.run({ action: 'example' });
    const file = join(dir, 'mine.json');
    writeFileSync(file, JSON.stringify({ ...emptyRoutineDoc('local-eor', 'testacjs'), profiles: [JSON.parse(example.text)] }));
    expect((await tool.run({ action: 'validate', file })).text).toBe('valid');
    const set = await tool.run({ action: 'set', file, account: 'testacjs', server: 'local-eor', profile: 'no-such-session' });
    expect(set.isError).toBeFalsy();
    expect(set.text).toContain('stored 1 profile(s) for local-eor/testacjs');
    expect((await tool.run({ action: 'list', account: 'testacjs', server: 'local-eor', profile: 'no-such-session' })).text).toContain(EXAMPLE_HUNT_PROFILE.name);
    writeFileSync(file, JSON.stringify({ ...emptyRoutineDoc('local-eor', 'testacjs'), profiles: [{ ...JSON.parse(example.text), initialState: 'X' }] }));
    const refused = await tool.run({ action: 'set', file, account: 'testacjs', server: 'local-eor', profile: 'no-such-session' });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain('profiles[0].initialState: no state named "X"');
  });
});
