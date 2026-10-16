/**
 * The segment opening's "where your time went" block (tools/stream/own-time.ts, Jake 2026-10-16): from a character's
 * previous segment, minutes travelling / fighting / buffing / shopping / waiting, the longest trip and how often it went
 * there today, XP per hour by spot, waiting split into no-monster time and resting, offensive casts refused for line of
 * fire, and time apart from the partner. Facts only: no advice words. Here: a made-up hour of a mage (the real
 * stream-json and feed shapes) through the real parsers, the run-directory loader, and the opening's placement.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSession } from '../tools/stream/dead-air.ts';
import type { FeedChat, FeedStatus } from '../tools/stream/feed-types.ts';
import {
  apartLine, castIsBuff, castRefusalLine, fellowSample, loadOwnTime, monstersInObserve, ownTimeBlock, ownTimeLine, placeText, segmentTime, spotOf, waitingLine, xpLine,
  type OwnTimeSegment,
} from '../tools/stream/own-time.ts';
import { segmentOpening } from '../tools/stream/prompt.ts';
import { localDay } from '../tools/stream/policy.ts';
import { parseStreamConfig } from '../tools/stream/config.ts';

const CAST = ['Claude Arcanist', 'Claude Bulwark'];
const ADVICE = /\b(?:should|consider|try|recommend|better to|you could|might want)\b/i;

/** A session's stream-json lines, built call by call (times in seconds from `t0`). */
function sessionBuilder(t0: number, sid: string) {
  const lines: string[] = [];
  let n = 0;
  const iso = (s: number) => new Date(t0 + s * 1000).toISOString();
  const call = (a: number, b: number, command: string, text: string, isError = false) => {
    const id = `toolu_${sid}_${++n}`;
    lines.push(JSON.stringify({ type: 'assistant', session_id: sid, timestamp: iso(a), message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }));
    lines.push(JSON.stringify({ type: 'user', session_id: sid, timestamp: iso(b), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } }));
  };
  return { lines, call };
}

const status = (t: number, location: string, xp: number, v: { st?: number; mp?: number } = {}): FeedStatus => ({
  v: 1, t, type: 'status', char: 'mage', name: 'Claude Arcanist', level: 38,
  health: { cur: 200, max: 200 }, stamina: { cur: v.st ?? 300, max: 300 }, mana: { cur: v.mp ?? 400, max: 400 },
  xp: { total: xp, toNext: 1e6 }, location, goal: null,
});
const chat = (t: number, channel: FeedChat['channel'], text: string): FeedChat => ({ v: 1, t, type: 'chat', char: 'mage', channel, text });

const observe = (fellow: string, monsters: number) => [
  'Claude Arcanist (L38)  HP 200/200  ST 300/300  MA 400/400  mode magic',
  `fellows: Claude Bulwark 98% HP, ${fellow}`,
  `nearby (${monsters}, nearest first):`,
  ...Array.from({ length: monsters }, (_, i) => `  #8000${(0x0a00 + i).toString(16)}  Dread Mu-miyah  [monster L60]  ${10 + i}.0m ahead (N)`),
].join('\n');

const HOLTBURG = '42.1N, 33.6E';
const KEEP_DOOR = '54.7N, 32.9E';
const KEEP_IN = 'indoors (0x01D20110)';

/**
 * One hour (3600 s) of Claude Arcanist from `t0`:
 *   0–120   buffing Bulwark in Holtburg
 *   200–700 a walk to the Mountain Keep portal (54.7N 32.9E): "in progress", then 20 s waits until task-done
 *   702–706 into the Mountain Keep portal (portal space)
 *   720–1500 bolts at Dreads (combat lines; 10 refused for no line of fire, 40 cast), +600k XP
 *   1500–1800 waiting with mana at 1/8 (resting)
 *   1800–2100 waiting, the last look showed no monster
 *   2100–2400 Bulwark 40 m away; 2400–2520 Bulwark 12 m up (another floor); then 2 m away
 */
function hour(t0: number, sid: string): { seg: OwnTimeSegment; lines: string[]; feed: Array<FeedStatus | FeedChat> } {
  const b = sessionBuilder(t0, sid);
  const at = (s: number) => t0 + s * 1000;
  const feed: Array<FeedStatus | FeedChat> = [];
  b.call(0, 1, './ac observe max=10', observe('2 m N', 0));
  b.call(2, 120, './ac cast spell="Armor Other V" target="Claude Bulwark"', 'casting Armor Other V at Claude Bulwark #500000a4 You cast Armor Other V on Claude Bulwark');
  b.call(200, 230, './ac walk_to target="54.7N 32.9E"', 'walkTo is still in progress after 30 s and keeps going: ac_wait types=task-done to hear when it finishes');
  for (let s = 232; s < 680; s += 22) b.call(s, s + 20, './ac wait types=task-done timeout_s=20', '(nothing within 20 s)');
  b.call(680, 700, './ac wait types=task-done timeout_s=20', '  [123] task-done: walking to 54.7N 32.9E: arrived');
  b.call(702, 706, './ac use target="Mountain Keep"', 'used Mountain Keep: In Portal Space - Please Wait... portal: entered portal space');
  for (let s = 703; s <= 706; s++) feed.push(chat(at(s), 'system', 'In Portal Space - Please Wait...'));
  // Status every 10 s: Holtburg, the walk north, then inside the Keep.
  for (let s = 0; s < 3600; s += 10) {
    const ns = s < 200 ? 42.1 : s < 700 ? 42.1 + ((s - 200) / 500) * 12.6 : 54.7;
    const ew = s < 200 ? 33.6 : s < 700 ? 33.6 - ((s - 200) / 500) * 0.7 : 32.9;
    const loc = s < 710 ? `${ns.toFixed(1)}N, ${ew.toFixed(1)}E` : KEEP_IN;
    const xp = 10_000_000 + (s <= 720 ? 0 : s >= 1500 ? 600_000 : Math.round(((s - 720) / 780) * 600_000));
    feed.push(status(at(s), loc, xp, s >= 1500 && s < 1800 ? { mp: 50 } : {}));
  }
  // The fight: 40 bolts that landed (10 calls × 4), 10 refused.
  for (let k = 0; k < 20; k++) {
    const s = 720 + k * 39;
    if (k % 2 === 0) b.call(s, s + 12, `./ac cast spell="Flame Bolt IV" target=0x8000${(0x0b00 + k).toString(16)} repeat=true`, 'cast Flame Bolt IV at Dread Mu-miyah 4 times (repeat); stopped: Dread Mu-miyah died');
    else b.call(s, s + 1, `./ac cast spell="Flame Bolt IV" target=0x8000${(0x0b00 + k).toString(16)} repeat=true`, 'Exit code 1 cast Flame Bolt IV at Dread Mu-miyah 0 times (repeat); stopped: the cast was refused: Flame Bolt IV not cast: no line of fire to Dread Mu-miyah (12.9 m away)', true);
    for (let c = 0; c < 10; c++) feed.push(chat(at(s + 2 + c * 4), 'combat', 'You burn Dread Mu-miyah for 78 points with Flame Bolt IV.'));
  }
  // Resting, then no monster in sight (5 min here, plus the 80 s in Holtburg after the first look showed none).
  b.call(1500, 1501, './ac observe max=6 filter=monster', observe('2 m N', 2));
  for (let s = 1502; s < 1800; s += 22) b.call(s, s + 20, './ac wait types=aggro timeout_s=20', '(nothing within 20 s)');
  b.call(1800, 1801, './ac observe max=6 filter=monster', observe('2 m N', 0));
  for (let s = 1802; s < 2100; s += 22) b.call(s, s + 20, './ac wait types=aggro timeout_s=20', '(nothing within 20 s)');
  // Apart: 40 m off, then on another floor, then together.
  b.call(2100, 2101, './ac observe max=6 filter=monster', observe('40 m N', 3));
  b.call(2220, 2221, './ac observe max=6 filter=monster', observe('41 m N', 3));
  b.call(2340, 2341, './ac observe max=6 filter=monster', observe('40 m N', 3));
  b.call(2400, 2401, './ac observe max=6 filter=monster', observe('3 m N, up 12 m', 3));
  b.call(2520, 2521, './ac observe max=6 filter=monster', observe('2 m N', 3));
  feed.sort((x, y) => x.t - y.t);
  const session = parseSession(b.lines, sid);
  return { seg: { start: t0, end: t0 + 3600_000, session, feed }, lines: b.lines, feed };
}

const T0 = Date.parse('2026-10-16T18:00:00.000Z');

describe('own time: one hour of a mage', () => {
  const { seg } = hour(T0, 'sess-2');
  const earlier = hour(T0 - 2 * 3600_000, 'sess-1').seg;

  it('splits the hour: travel (the walk + portal space), fighting, buffing, the rest waiting', () => {
    const t = segmentTime(seg, CAST);
    expect(Math.round(t.seconds.buffing / 60)).toBe(2);
    expect(Math.round(t.seconds.travelling / 60)).toBe(8);
    expect(Math.round(t.seconds.fighting / 60)).toBe(13);
    expect(t.portals).toBe(1);
    expect(t.seconds.travelling + t.seconds.fighting + t.seconds.buffing + t.seconds.shopping + t.seconds['looting/gear'] + t.seconds['waiting/idle']).toBe(3600);
  });

  it('a cast at the caster or a cast member is a buff; one at a monster is fighting', () => {
    expect(castIsBuff('./ac cast spell="Armor Other V" target="Claude Bulwark"', 'casting Armor Other V at Claude Bulwark #500000a4', CAST)).toBe(true);
    expect(castIsBuff('./ac cast spell="War Magic Mastery Self V"', 'casting War Magic Mastery Self V on yourself', CAST)).toBe(true);
    expect(castIsBuff('./ac cast spell="Flame Bolt IV" target=0x80000da3 repeat=true', 'cast Flame Bolt IV at Dread Mu-miyah 4 times (repeat)', CAST)).toBe(false);
  });

  it('places: a town by name, the open map by coordinates, a dungeon by the portal that led into it', () => {
    expect(placeText(HOLTBURG)).toBe('Holtburg');
    expect(placeText(KEEP_DOOR)).toBe('54.7N 32.9E');
    expect(placeText(KEEP_IN, new Map([[0x01d2, 'Mountain Keep']]))).toBe('Mountain Keep');
    expect(placeText(KEEP_IN)).toBe('indoors (landblock 0x01D2)');
    expect(spotOf(KEEP_IN, new Map([[0x01d2, 'Mountain Keep']]))).toBe('Mountain Keep');
  });

  it('the time line, with the longest trip and how many trips went there today', () => {
    expect(ownTimeLine(seg, [earlier], CAST)).toBe(
      '- last hour: travelling 8 min (1 portal trip), fighting 13 min, buffing 2 min, waiting/idle 37 min; longest trip Holtburg → Mountain Keep (54.7N 32.9E), 8 min, 2nd time today');
    expect(ownTimeLine(seg, [], CAST)).toMatch(/, 1st time today$/);
  });

  it('a segment cut short by a restart is labelled by its real length, not "last hour"', () => {
    const short = { ...seg, end: seg.start + 7 * 60_000 };
    expect(ownTimeLine(short, [], CAST)).toMatch(/^- last 7 min: /);
    expect(ownTimeLine(seg, [], CAST)).toMatch(/^- last hour: /);
  });

  // Holtburg: the buffing and the first of the walk (within 3 map units of it); no XP there.
  it('XP per hour by spot, the hour and today', () => {
    const st = (s: OwnTimeSegment) => s.feed.filter((e): e is FeedStatus => e.type === 'status');
    const names = new Map([[0x01d2, 'Mountain Keep']]);
    expect(xpLine(st(seg), st(seg), names)).toBe('- XP per hour: Mountain Keep 747k/h over 48 min, Holtburg 0/h over 5 min');
    expect(xpLine(st(seg), [...st(earlier), ...st(seg)], names)).toBe('- XP per hour: Mountain Keep 747k/h over 48 min (today 747k/h over 1.6 h), Holtburg 0/h over 5 min (today 0/h over 11 min)');
  });

  it('waiting: resting while a vital is under half, and time whose last look showed no monster', () => {
    expect(monstersInObserve(observe('2 m N', 0))).toBe(0);
    expect(monstersInObserve(observe('2 m N', 3))).toBe(3);
    expect(monstersInObserve('Claude Arcanist (L38)')).toBeNull();
    expect(waitingLine(seg, segmentTime(seg, CAST))).toBe('- waiting: 6 min with no monster in sight, 5 min resting (mana)');
  });

  it('offensive casts refused for line of fire, by place', () => {
    expect(castRefusalLine(seg, CAST, new Map([[0x01d2, 'Mountain Keep']]))).toBe('- offensive casts refused for no line of fire or out of range: Mountain Keep 20% (10/50)');
    // A soldier (no offensive casts): no line.
    expect(castRefusalLine({ ...seg, session: { ...seg.session, calls: seg.session.calls.filter((c) => c.tool !== 'cast') } }, CAST, new Map())).toBeNull();
  });

  it('time apart from the partner, from the looks\' fellows lines', () => {
    expect(fellowSample(observe('40 m N', 0), 'Claude Bulwark')).toEqual({ far: true, floor: false });
    expect(fellowSample(observe('3 m N, up 12 m', 0), 'Claude Bulwark')).toEqual({ far: false, floor: true });
    expect(fellowSample('fellows: Claude Bulwark 90% HP, out of sight (far away: go to them, or ask where they are)', 'Claude Bulwark')).toEqual({ far: true, floor: false });
    expect(fellowSample(observe('3 m N', 0), 'Claude Arcanist')).toBeNull();
    expect(apartLine(seg, ['Claude Bulwark'])).toBe('- apart from Claude Bulwark (over 30 m, another floor or out of sight): 7 min (different floors 2)');
  });

  it('the whole block: facts only, one short line each', () => {
    const block = ownTimeBlock(seg, [earlier], CAST, 'Claude Arcanist')!;
    expect(block.split('\n')).toEqual([
      '- last hour: travelling 8 min (1 portal trip), fighting 13 min, buffing 2 min, waiting/idle 37 min; longest trip Holtburg → Mountain Keep (54.7N 32.9E), 8 min, 2nd time today',
      '- XP per hour: Mountain Keep 747k/h over 48 min (today 747k/h over 1.6 h), Holtburg 0/h over 5 min (today 0/h over 11 min)',
      '- waiting: 6 min with no monster in sight, 5 min resting (mana)',
      '- offensive casts refused for no line of fire or out of range: Mountain Keep 20% (10/50)',
      '- apart from Claude Bulwark (over 30 m, another floor or out of sight): 7 min (different floors 2)',
    ]);
    expect(block).not.toMatch(ADVICE);
  });
});

describe('own time: read from a run directory (segments.jsonl, sessions/, the feed)', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'acjs-owntime-'));
    mkdirSync(join(dir, 'sessions'));
    const a = hour(T0 - 2 * 3600_000, 'sess-1'), b = hour(T0, 'sess-2');
    const row = (t0: number, sessionId: string, segment: number) => ({ profile: 'mage', character: 'Claude Arcanist', segment, start: new Date(t0).toISOString(), end: new Date(t0 + 3600_000).toISOString(), minutes: 60, reason: 'done', model: 'm', sessionId, usage: null, finalText: '' });
    writeFileSync(join(dir, 'segments.jsonl'), [row(T0 - 2 * 3600_000, 'sess-1', 1), row(T0, 'sess-2', 2)].map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeFileSync(join(dir, 'sessions', `mage-${localDay(new Date(T0 - 2 * 3600_000))}-seg1.jsonl`), a.lines.join('\n') + '\n');
    writeFileSync(join(dir, 'sessions', `mage-${localDay(new Date(T0))}-seg2.jsonl`), b.lines.join('\n') + '\n');
    // The partner's feed lines are ignored (another char).
    const other = { ...status(T0 + 5000, HOLTBURG, 1), char: 'soldier' };
    writeFileSync(join(dir, 'feed.jsonl'), [...a.feed, ...b.feed, other].map((e) => JSON.stringify(e)).join('\n') + '\n');
  };

  it('the latest segment, counted against the day\'s earlier ones', () => {
    setup();
    const got = loadOwnTime({ streamDir: dir, feedFile: join(dir, 'feed.jsonl'), profile: 'mage', cast: CAST, nowMs: T0 + 3600_000 + 30_000 });
    expect(got).toBe(ownTimeBlock(hour(T0, 'sess-2').seg, [hour(T0 - 2 * 3600_000, 'sess-1').seg], CAST, 'Claude Arcanist'));
    expect(got).toMatch(/2nd time today/);
  });

  it('nothing when there is no previous segment, or it ended hours ago', () => {
    setup();
    expect(loadOwnTime({ streamDir: dir, feedFile: join(dir, 'feed.jsonl'), profile: 'soldier', cast: CAST, nowMs: T0 + 3600_000 })).toBeNull();
    expect(loadOwnTime({ streamDir: dir, feedFile: join(dir, 'feed.jsonl'), profile: 'mage', cast: CAST, nowMs: T0 + 8 * 3600_000 })).toBeNull();
    expect(loadOwnTime({ streamDir: join(dir, 'missing'), feedFile: join(dir, 'feed.jsonl'), profile: 'mage', cast: CAST, nowMs: T0 })).toBeNull();
    // A segment still running (ends after now) isn't "previous": the one before it is.
    expect(loadOwnTime({ streamDir: dir, feedFile: join(dir, 'feed.jsonl'), profile: 'mage', cast: CAST, nowMs: T0 + 60_000 })).toMatch(/1st time today/);
  });
});

describe('own time in the segment opening', () => {
  const c = parseStreamConfig({ characters: [{ profile: 'mage', character: 'Claude Arcanist' }, { profile: 'soldier', character: 'Claude Bulwark' }] }).characters[0];
  const base = { c, partner: 'Claude Bulwark', segment: 2, nowMs: 0, playMinutes: 60, journal: 'j', lastReport: null };
  it('right after the readiness block', () => {
    const o = segmentOpening({ ...base, readiness: 'Your readiness right now:\n- in your pack: 3 healing kits', ownTime: '- last hour: travelling 8 min' });
    expect(o).toContain('Your readiness right now:\n- in your pack: 3 healing kits\n- last hour: travelling 8 min\n\nYour journal:');
  });
  it('on its own when readiness could not be read, and not at all without a previous segment', () => {
    expect(segmentOpening({ ...base, readiness: null, ownTime: '- last hour: travelling 8 min' })).toContain('\nYour last segment:\n- last hour: travelling 8 min\n');
    expect(segmentOpening({ ...base, readiness: 'Your readiness right now:\n- x', ownTime: null })).not.toMatch(/last hour|last segment/);
  });
});
