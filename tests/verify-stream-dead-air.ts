/**
 * Dead air in the stream (2026-10-14): stretches where viewers watch a character doing nothing visible. Measured over
 * the two rehearsals of 2026-10-13 by tools/stream/dead-air.ts (rehearsal 2: each character still for about half of
 * its time, both at once for 30%: waits that slept through the partner's lines, standing in town for mana, a portal
 * hand-off, a follow that held the player two minutes). Here: the measuring script on a made-up run, the follow that
 * now says which portal a leader went through (real AgentApi on the fake host), the player's 30 s reply deadline
 * (the daemon's real deadline code, the real CLI client against a stand-in daemon, the real wrapper script), and the
 * brief's mana facts as the player receives them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activitySpans, analyzeRun, walkMarks, analyzeSegment, causeOf, chatMarks, classifySeconds, formatReport, pairDeadAir, parseSession,
} from '../tools/stream/dead-air.ts';
import { systemChannel } from '../tools/stream/feed.ts';
import { DAEMON_REPLY_MS, replyDeadlineMs, withCallDeadline } from '../tools/ac-agent/callDeadline.ts';
import { AgentClient, replyMsFromEnv } from '../tools/ac-agent/client.ts';
import { pageLogLine } from '../tools/ac-agent/daemon.ts';
import { PLAYER_REPLY_S, playerScripts } from '../tools/stream/player.ts';
import { playerToolNames, systemPrompt } from '../tools/stream/prompt.ts';
import { parseStreamConfig } from '../tools/stream/config.ts';
import { TOOLS } from '../tools/ac-agent/tools.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const T0 = Date.parse('2026-10-13T21:20:00.000Z');
const iso = (s: number): string => new Date(T0 + s * 1000).toISOString();
const SID = 'sess-1';
let n = 0;
const use = (s: number, command: string) => {
  const id = `toolu_${++n}`;
  return { id, line: JSON.stringify({ type: 'assistant', session_id: SID, timestamp: iso(s), message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }) };
};
const result = (s: number, id: string, text: string, isError = false) => JSON.stringify({ type: 'user', session_id: SID, timestamp: iso(s), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
const say = (s: number, text: string) => JSON.stringify({ type: 'assistant', session_id: SID, timestamp: iso(s), message: { content: [{ type: 'text', text }] } });
/** A call from `a` to `b` seconds, answering `text`. */
const call = (a: number, b: number, command: string, text: string, isError = false): string[] => { const u = use(a, command); return [u.line, result(b, u.id, text, isError)]; };

// One minute of a mage: observe, a 20 s wait that sleeps through the partner's /f line at 12 s, a walk, a repeat cast
// with its bolts in the chat log, a /f line, and a thought.
const SESSION = [
  ...call(0, 1, './ac observe max=10', 'Claude Arcanist (L17) MA 41/186'),
  say(3, "Mana's low, so I'll let it regen while Bulwark answers."),
  ...call(4, 24, './ac wait types=tell chat_match="] Claude Bulwark says" timeout_s=20', '(nothing within 20 s)'),
  ...call(26, 36, './ac walk_to target="Claude Bulwark" within=3', 'arrived (1.1 m away)'),
  ...call(37, 45, './ac cast spell="Flame Bolt III" target=#80007d18 repeat=true', 'cast Flame Bolt III 2 times (repeat); stopped: Bronze Statue of a Reedshark died'),
  ...call(46, 47, './ac say text="/f Melted!"', 'sent: /f Melted!'),
  ...call(59, 60, './ac observe max=5', 'Claude Arcanist (L17)'),
  JSON.stringify({ type: 'assistant', session_id: 'another-session', timestamp: iso(30), message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: './ac observe' } }] } }),
];
const CHAT = [
  `${iso(-30)} Welcome to Asheron's Call`,
  `${iso(12)} [Fellowship] Claude Bulwark says, "Ready when you are."`,
  `${iso(38)} Casting Flame Bolt III`,
  `${iso(38.5)} You say, "Zojak Quaguz"`,
  `${iso(40)} You burn Bronze Statue of a Reedshark for 43 points with Flame Bolt III.`,
  `${iso(41)} Casting Flame Bolt III`,
  `${iso(43)} Bronze Statue of a Reedshark is incinerated by your assault!`,
  `${iso(46.5)} [Fellowship] You say, "Melted!"`,
];
const CAST = ['Claude Arcanist', 'Claude Bulwark'];

describe('tools/stream/dead-air.ts: what each second of a segment showed', () => {
  const session = parseSession(SESSION, SID);
  const marks = chatMarks(CHAT, 'mage', 'Claude Arcanist', CAST, T0, T0 + 60_000);
  it('reads the tool calls with their times and results, the narration, and only this session', () => {
    expect(session.calls.map((c) => [c.tool, (c.end - c.start) / 1000])).toEqual([['observe', 1], ['wait', 20], ['walk_to', 10], ['cast', 8], ['say', 1], ['observe', 1]]);
    expect(session.texts).toHaveLength(1);
  });
  it('a war spell\'s damage and kill lines are combat (the overlay showed them as system chat), not speech', () => {
    expect(systemChannel('You burn Bronze Statue of a Reedshark for 43 points with Flame Bolt III.')).toBe('combat');
    expect(systemChannel('Bronze Statue of a Reedshark is incinerated by your assault!')).toBe('combat');
    expect(systemChannel('You bring Bronze Statue of a Drudge to a fiery end!')).toBe('combat');
    expect(systemChannel("Bronze Statue of a Reedshark's seared corpse smolders before you!")).toBe('combat');
    expect(systemChannel('Your Bracelet is low on Mana.')).toBe('system');
    expect(systemChannel('You have entered the Allegiance channel.')).toBe('system');
  });
  it('the chat log: own combat and magic lines, own speech (not the spell words), the partner\'s line', () => {
    expect(marks.map((m) => [m.kind, (m.t - T0) / 1000])).toEqual([
      ['partner', 12], ['combat', 38], ['combat', 38.5], ['combat', 40], ['combat', 41], ['combat', 43], ['talk', 46.5],
    ]);
  });
  it('classifies each second: fighting > moving > talking > waiting > tools > thinking', () => {
    const secs = classifySeconds(T0, T0 + 60_000, activitySpans(session, marks));
    const at = (s: number) => secs[s];
    expect(at(0)).toBe('tools');
    expect(at(2)).toBe('thinking');
    expect(at(10)).toBe('waiting');
    expect(at(30)).toBe('moving');
    expect(at(39)).toBe('fighting');
    expect(at(48)).toBe('talking');
    expect(at(55)).toBe('thinking');
  });
  it('reports totals, the idle stretches with their cause, and the wait that slept after the partner spoke', () => {
    const r = analyzeSegment({ profile: 'mage', character: 'Claude Arcanist', segment: 1, start: T0, end: T0 + 60_000, session, chat: marks, wrapUp: null });
    expect(r.totals.waiting).toBe(20);
    expect(r.totals.moving).toBe(10);
    expect(r.timeline).toHaveLength(60);
    const first = r.stretches[0];
    expect(first.seconds).toBeGreaterThanOrEqual(25);
    expect(first.cause).toBe('waiting for mana');
    expect(r.missedWakes).toEqual({ count: 1, seconds: 12 });
    expect(r.thinkGaps.count).toBe(5);
  });
  it('a walk that ended stuck is "stuck", not travel; an attack fights until the wait hears its target die', () => {
    const s = parseSession([
      ...call(0, 45, './ac use target=#7a9b404a', "couldn't reach Mannikin Foundry Portal: walking to it took longer than 45 s and stopped 19.2 m away", true),
      ...call(46, 47, './ac attack target=#80007d18', 'running up to Bronze Statue of a Reedshark: 32 m NE, then attacking'),
      ...call(48, 70, './ac wait types=target-died', '[89] target-died: Bronze Statue of a Reedshark died'),
    ], SID);
    const secs = classifySeconds(T0, T0 + 80_000, activitySpans(s, []));
    expect(secs[20]).toBe('stuck');
    expect(secs[60]).toBe('fighting');
    expect(secs[75]).toBe('thinking');
  });
  it('the daemon log\'s timed walk trace: a walk that "arrived" after standing through failed searches is stuck meanwhile', () => {
    const at = (sec: number, text: string) => pageLogLine(text, new Date(T0 + sec * 1000))!.trimEnd();
    const log = [
      `${iso(-5)} entering world as agentmage`,
      at(1, '[AC:Agent] walk leg blocked straight; searching 1.4 m to (32509.0, 34716.5), 4 doorway(s) ahead'),
      at(15, '[AC:Agent] walk search none after 4721 points'),
      at(15, '[AC:Agent] walk route: no doorway route from cell 0xa9b40017 to cell 0xa9b40176'),
      at(28, '[AC:Agent] walk search found after 16 points: (32523.8, 34716.2)'),
      at(30, '[AC:Agent] walk leg straight 4.9 m to (16143.0, 17230.0), 8 doorway(s) ahead'),
      '[page] [AC:Agent] walk stall 1 (an untimed line from an older daemon)',
      at(31, '[AC] UseDone: errorType=0'),
    ];
    expect(pageLogLine('[AC:Chat] hello')).toBeNull();
    expect(pageLogLine('some page noise')).toBeNull();
    const walks = walkMarks(log, T0, T0 + 60_000);
    expect(walks.map((w) => [(w.t - T0) / 1000, w.failed])).toEqual([[1, false], [15, true], [15, true], [28, false], [30, false]]);
    const s = parseSession(call(0, 40, './ac walk_to target=#7a9b404a', 'arrived (3.2 m away)'), SID);
    const secs = classifySeconds(T0, T0 + 40_000, activitySpans(s, [], walks));
    expect(secs.slice(1, 15).every((x) => x === 'stuck')).toBe(true);
    expect(secs[20]).toBe('moving');
    expect(secs[35]).toBe('moving');
  });
  it('names causes from what the player wrote and called', () => {
    expect(causeOf("Mana's low (41/186), so I'll let it regen")).toBe('waiting for mana');
    expect(causeOf('walking to Mannikin Foundry Portal took longer than 45 s')).toBe('stuck walk / portal hand-off');
    expect(causeOf('Still no Arcanist. Sending a tell in case she missed the /f.')).toBe('waiting for the partner');
    expect(causeOf('Looking at the sky.')).toBe('other');
  });
  it('both players idle at once, over the overlap of their windows', () => {
    const r = (start: number, timeline: string) => ({ start, timeline }) as Parameters<typeof pairDeadAir>[0];
    expect(pairDeadAir(r(T0, 'wwwfffwww'), r(T0 + 1000, 'kkkkmmmm'))).toEqual({ overlap: 8, bothIdle: 2 });
  });
  it('reads a supervisor run directory: segments, sessions, the chat log beside it, the wrap-up from supervisor.log', () => {
    const root = mkdtempSync(join(tmpdir(), 'acjs-deadair-'));
    try {
      const dir = join(root, 'stream');
      mkdirSync(join(dir, 'sessions'), { recursive: true });
      writeFileSync(join(dir, 'segments.jsonl'), [
        { profile: 'mage', character: 'Claude Arcanist', segment: 1, start: iso(0), end: iso(60), sessionId: SID },
        { profile: 'soldier', character: 'Claude Bulwark', segment: 1, start: iso(0), end: iso(60), sessionId: 'sess-2' },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n');
      writeFileSync(join(dir, 'sessions', 'mage-2026-10-13-seg1.jsonl'), SESSION.join('\n') + '\n');
      writeFileSync(join(root, 'mage.chat.log'), CHAT.join('\n') + '\n');
      writeFileSync(join(dir, 'supervisor.log'), `${iso(50)} Claude Arcanist: segment 1: wrap-up sent\n`);
      const [r, partner] = analyzeRun(dir);
      expect(partner.character).toBe('Claude Bulwark');
      expect(r.wrapUp).toBe(T0 + 50_000);
      expect(r.timeline).toHaveLength(50);
      expect(r.totals.fighting).toBeGreaterThan(0);
      const text = formatReport([r, partner]);
      expect(text).toMatch(/Segment 1, both players idle at once: 0:\d\d of 0:50/);
      expect(text).toMatch(/Claude Arcanist #1 +1:00 +visible/);
      expect(text).toMatch(/waiting for mana/);
      expect(text).toMatch(/slept on after the partner spoke[\s\S]*Claude Arcanist #1: 1, 0:12/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('follow: a leader who vanished beside a portal (rehearsal 2026-10-13: "last seen 23954 m SW")', () => {
  let host: FakeHost;
  let api: AgentApi;
  const BUL = 0x500000a4;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 40 });
    host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 50, max: 50 }, stamina: { cur: 50, max: 50 }, mana: { cur: 10, max: 10 } }];
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  async function settle<T>(p: Promise<T>, ms: number): Promise<T | null> {
    let out: T | null = null, done = false;
    void p.then((x) => { out = x; done = true; });
    for (let t = 0; t < ms && !done; t += 100) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
    return out;
  }
  it('names the portal beside where they were last seen, with where it is from you, and how to follow', async () => {
    host.add({ guid: 0x7a9b404a, name: 'Mannikin Foundry Portal', itemType: 0x10000, objectDescFlags: 0x40000, x: 80, y: 43 });
    const p = api.follow('Claude Bulwark', { durationMs: 120_000 });
    await settle(Promise.resolve(), 3000);
    // Through the portal: the object's cell moves on into the dungeon before the client lets it go.
    const b = host.objs.get(BUL)!;
    b.cell = 0x545a013c; b.x = 10; b.y = -20;
    const r = await settle(p, 20_000);
    expect(r!.ok).toBe(false);
    // From the landscape into a dungeon (2026-10-17 21:55Z reports): the portal, and where the client now places them.
    expect(r!.message).toMatch(/^stopped following: Claude Bulwark went out of sight beside Mannikin Foundry Portal #7a9b404a \(\d+ m N of you\): they most likely went through it \(the client now places them inside a dungeon\)\. ac_use it to follow/);
  });
  it('with no portal there: where they were last seen in sight, not their new cell\'s far-off coordinates', async () => {
    const p = api.follow('Claude Bulwark', { durationMs: 120_000 });
    await settle(Promise.resolve(), 3000);
    const b = host.objs.get(BUL)!;
    b.cell = 0x545a013c; b.x = 10; b.y = -20;
    const r = await settle(p, 20_000);
    // Their new cell is a dungeon's: that, never its far-off distance (2026-10-17 21:55Z reports, "32233 m W").
    expect(r!.message).toMatch(/went through a portal or recalled: the client now places them inside a dungeon/);
    expect(r!.message).not.toMatch(/\d{3,} m/);
    expect(r!.message).not.toMatch(/beside/);
  });
});

describe('a stream player\'s acting calls answer within 30 s and keep going', () => {
  it('the deadline: the caller\'s for acting calls, the daemon\'s for waits and reads, clamped', () => {
    expect(replyDeadlineMs('walkTo', 30_000)).toBe(30_000);
    expect(replyDeadlineMs('follow', 30_000)).toBe(30_000);
    expect(replyDeadlineMs('wait', 30_000)).toBe(DAEMON_REPLY_MS);
    expect(replyDeadlineMs('observe', 30_000)).toBe(DAEMON_REPLY_MS);
    expect(replyDeadlineMs('walkTo', undefined)).toBe(DAEMON_REPLY_MS);
    expect(replyDeadlineMs('walkTo', 100)).toBe(5000);
    expect(replyDeadlineMs('walkTo', 10_000_000)).toBe(DAEMON_REPLY_MS);
    expect(replyMsFromEnv('30')).toBe(30_000);
    expect(replyMsFromEnv(undefined)).toBeUndefined();
    expect(replyMsFromEnv('soon')).toBeUndefined();
  });
  it('a follow still running at the deadline answers "still in progress" (ok) while its work goes on', async () => {
    vi.useFakeTimers();
    try {
      let finished = false;
      const work = new Promise<{ ok: boolean; message: string }>((res) => setTimeout(() => { finished = true; res({ ok: true, message: 'followed' }); }, 120_000));
      const p = withCallDeadline(work, 'follow', 640_000, replyDeadlineMs('follow', PLAYER_REPLY_S * 1000));
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(p).resolves.toEqual({ ok: true, message: expect.stringMatching(/^follow is still in progress after 30 s and keeps going/) });
      expect(finished).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('the CLI client sends AC_AGENT_REPLY_S as replyMs (and nothing without it)', async () => {
    const bodies: any[] = [];
    const server = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => { bodies.push(JSON.parse(b)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: 1 })); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const before = process.env.AC_AGENT_REPLY_S;
    try {
      const client = new AgentClient({ profile: 'mage', pid: 1, port, account: 'a', character: 'c' } as any);
      process.env.AC_AGENT_REPLY_S = '30';
      await client.call('walkTo', ['x'], 60_000);
      delete process.env.AC_AGENT_REPLY_S;
      await client.call('walkTo', ['x'], 60_000);
      expect(bodies[0]).toMatchObject({ method: 'walkTo', timeoutMs: 60_000, replyMs: 30_000 });
      expect(bodies[1]).not.toHaveProperty('replyMs');
    } finally {
      if (before === undefined) delete process.env.AC_AGENT_REPLY_S; else process.env.AC_AGENT_REPLY_S = before;
      server.close();
    }
  });
  it('the player\'s ./ac wrapper exports it before running the CLI', () => {
    const s = playerScripts('/repo', 'mage');
    const lines = s.ac.split('\n');
    const at = lines.findIndex((l) => l === `AC_AGENT_REPLY_S=${PLAYER_REPLY_S}; export AC_AGENT_REPLY_S`);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(lines.findIndex((l) => l.startsWith('exec ')));
  });
});

describe('the brief as a player gets it: what dead air is, and how mana comes back', () => {
  const cast = parseStreamConfig(JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'stream', 'cast.json'), 'utf8')));
  const sys = systemPrompt(readFileSync(join(__dirname, '..', 'tools', 'stream', 'brief.md'), 'utf8'), cast.characters[0], 'Claude Bulwark', playerToolNames(TOOLS.map((t) => t.name)));
  it('mana regenerates the same standing or walking (ACE GetStanceMod), no meditation, and the ways to restore it', () => {
    expect(sys).toMatch(/Mana\*\* comes back at the same rate whether you stand, walk or fight/);
    expect(sys).toMatch(/no meditation/);
    for (const spell of ['Mana Boost Self', 'Stamina to Mana Self', 'Health to Mana Self', 'Mana Renewal Self']) expect(sys).toContain(spell);
    expect(sys).toMatch(/mana potion/);
  });
  it('a caster\'s routine mana is Stamina to Mana Self between fights, Mana Conversion cuts costs, potions are the emergency (Jake 2026-10-14)', () => {
    expect(sys).toContain('For a caster the routine way to get it back is **Stamina to Mana Self** (Life Magic, `spells filter=Mana`): stamina refills fast, so cast it between fights and walk on.');
    expect(sys).toContain('Mana Conversion lowers what each spell costs.');
    expect(sys).toContain('Mana potions are for emergencies, a quick refill mid-fight');
    expect(sys.indexOf('Stamina to Mana Self')).toBeLessThan(sys.indexOf('Mana potions are for emergencies'));
    expect(sys).not.toMatch(/Temple of Forgetfulness|Warden of Forgetfulness/);
  });
  it('buffs as judgement, not a gate: pull anyway when buffing stalls, and go to a partner who isn\'t coming', () => {
    expect(sys).not.toMatch(/never pulls unbuffed/);
    expect(sys).toMatch(/If buffing stalls \(Arcanist out of mana, fizzling, or far away\), pull anyway with healing kits and potions ready, and say so in \/f/);
    expect(sys).toMatch(/stay within ~15 m \(if your partner isn't coming, go to them\)/);
  });
  it('no longer pushes 30–60 s waits; calls answer by 30 s; preparing is good play, and dead air is only standing idle', () => {
    expect(sys).not.toMatch(/30–60 s/);
    expect(sys).toContain(`still running after ${PLAYER_REPLY_S} s answers "still in progress"`);
    // Jake 2026-10-14: "i want to optimize for good players over entertainment; entertainment follows".
    expect(sys).toMatch(/Preparing \(shopping, buffing, appraising, equipping, healing up\) is good play, not dead air; dead air is standing idle with nothing being done/);
    expect(sys).not.toMatch(/still picture|shopping and buffing stops|Variety is the show|matters as much as the rules/);
  });
});
