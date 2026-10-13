import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStreamConfig, DEFAULT_ALLOWED_TOOLS, DEFAULT_AUTO_COMPACT_TOKENS } from '../tools/stream/config.ts';
import { FeedWriter, FileTail, cliCalls, feedPath, isIncantation, parseChatLine, parseStreamJsonLine, shellWords, statusDraft, summarizeCliCall, type ChatParseState } from '../tools/stream/feed.ts';
import type { FeedEvent } from '../tools/stream/feed-types.ts';
import { afterTurn, dayUsage, endReason, nextSegment, type SegmentRecord } from '../tools/stream/policy.ts';
import { StreamSupervisor, claudeArgs, playerEnv, startArgs, type PlayerProcess, type SupervisorDeps, type DaemonState } from '../tools/stream/supervisor.ts';
import { playerToolNames, segmentOpening, streamEndingMessage, systemPrompt, userLine, wrapUpMessage } from '../tools/stream/prompt.ts';
import { playerScripts, preparePlayerDir } from '../tools/stream/player.ts';
import { TOOLS, TOOL_BY_NAME } from '../tools/ac-agent/tools.ts';
import { help, parseCliArgs } from '../tools/ac-agent/cli.ts';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { worldQueryRefusal, clipOutput } from '../tools/stream/world-query.ts';
import { parseArgs, pickGameTab } from '../tools/ac-agent/daemon.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { READ_METHODS } from '../packages/renderer/src/agent/claudeControl.ts';
import { FakeHost } from './_harness/agentFake.ts';
import { parseFeedLine } from '../tools/stream/feed-tail.ts';
import { applyEvent, createState } from '../tools/stream/overlay/model.ts';

// Jake (2026-10-13): run Claude Arcanist and Claude Bulwark continuously for a stream, with no human or lead session
// launching each run. tools/stream/supervisor.ts plays each as a headless `claude -p` session in segments, feeds an
// overlay, and logs everyone out on stop. Everything here runs with fakes: no claude, no browser, no daemon.

const CAST = JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'stream', 'cast.json'), 'utf8'));
const cfgWith = (over: Record<string, unknown> = {}) => parseStreamConfig({ ...CAST, ...over });

describe('stream config (tools/stream/cast.json)', () => {
  it('the shipped cast parses: Arcanist (mage) and Bulwark (soldier), each its own profile and model', () => {
    const cfg = parseStreamConfig(CAST);
    expect(cfg.characters.map((c) => [c.profile, c.character])).toEqual([['mage', 'Claude Arcanist'], ['soldier', 'Claude Bulwark']]);
    expect(cfg.characters.every((c) => c.model && c.personality.length > 20 && c.attach === null)).toBe(true);
    expect(cfg.permissionMode).toBe('dontAsk');
  });
  it('fills defaults, including permissions that allow only the agent CLI, the world query, date and Read', () => {
    const cfg = parseStreamConfig({ characters: [{ profile: 'mage', character: 'Claude Arcanist' }] });
    expect(cfg.segment.minutes).toBe(75);
    expect(cfg.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(cfg.allowedTools).toEqual(['Bash(./ac:*)', 'Bash(./world-query:*)', 'Bash(date)', 'Bash(date:*)', 'Read']);
    expect(cfg.disallowedTools).toEqual(['Bash(./ac start:*)', 'Bash(./ac stop:*)']);
    expect(cfg.segment.autoCompactTokens).toBe(DEFAULT_AUTO_COMPACT_TOKENS);
    expect(cfg.characters[0].effort).toBeNull();
    expect(cfg.tools).toEqual(['Bash', 'Read']);
    expect(cfg.characters[0].model).toBe('claude-opus-5-5');
  });
  it('refuses a typo (so a cap is never silently dropped), duplicate profiles and a bad attach', () => {
    expect(() => cfgWith({ maxSegmentz: 3 })).toThrow(/maxSegmentz is not a setting/);
    expect(() => cfgWith({ segment: { minuts: 5 } })).toThrow(/segment\.minuts/);
    expect(() => cfgWith({ characters: [CAST.characters[0], { ...CAST.characters[1], profile: 'mage' }] })).toThrow(/distinct profiles/);
    expect(() => cfgWith({ characters: [{ ...CAST.characters[0], attach: 'chrome' }] })).toThrow(/attach/);
    expect(() => cfgWith({ segment: { autoCompactTokens: 50_000 } })).toThrow(/autoCompactTokens/);
    expect(cfgWith({ segment: { autoCompactTokens: null } }).segment.autoCompactTokens).toBeNull();
    expect(() => cfgWith({ characters: [{ ...CAST.characters[0], effort: 'huge' }] })).toThrow(/effort/);
  });
  it('an attached character takes a DevTools endpoint and logs out on stop unless told not to', () => {
    const cfg = cfgWith({ characters: [{ ...CAST.characters[0], attach: { endpoint: 'http://127.0.0.1:9222' } }, { ...CAST.characters[1], attach: { endpoint: 'http://127.0.0.1:9222', logoutOnStop: false } }] });
    expect(cfg.characters[0].attach).toEqual({ endpoint: 'http://127.0.0.1:9222', logoutOnStop: true });
    expect(cfg.characters[1].attach?.logoutOnStop).toBe(false);
    expect(startArgs(cfg.characters[0])).toEqual(['start', 'profile=mage', 'character=Claude Arcanist', 'attach=http://127.0.0.1:9222']);
    expect(startArgs(parseStreamConfig(CAST).characters[1])).toEqual(['start', 'profile=soldier', 'character=Claude Bulwark']);
  });
});

describe('claude -p command line', () => {
  const cfg = cfgWith({ segment: { ...CAST.segment, budgetUsd: 12 } });
  const args = claudeArgs(cfg, cfg.characters[0], 'SYSTEM', 'stream: Claude Arcanist #1');
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  it('streams JSON both ways, on the character\'s model, with the brief appended to the system prompt', () => {
    expect(args[0]).toBe('-p');
    expect(after('--input-format')).toBe('stream-json');
    expect(after('--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(after('--model')).toBe('claude-opus-5-5');
    expect(after('--append-system-prompt')).toBe('SYSTEM');
    expect(after('--max-budget-usd')).toBe('12');
  });
  it('runs unattended without skipping permissions: allowlisted Bash only, no MCP servers', () => {
    expect(args.join(' ')).not.toMatch(/dangerously/);
    expect(after('--permission-mode')).toBe('dontAsk');
    expect(after('--tools')).toBe('Bash,Read');
    expect(args).toContain('Bash(./ac:*)');
    expect(args).not.toContain('Bash(npx tsx tools/ac-agent/cli.ts:*)');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(args).not.toContain('--effort');
    const hi = cfgWith({ characters: [{ ...CAST.characters[0], effort: 'medium' }] });
    const a2 = claudeArgs(hi, hi.characters[0], 'S', 'n');
    expect(a2[a2.indexOf('--effort') + 1]).toBe('medium');
    expect(args.slice(-2)).toEqual(['--permission-prompts', 'none']);
  });
  it('the system prompt is the brief for this character and partner, then its personality', () => {
    const c = cfg.characters[1];
    const sys = systemPrompt(readFileSync(join(__dirname, '..', 'tools', 'stream', 'brief.md'), 'utf8'), c, 'Claude Arcanist');
    expect(sys).toMatch(/You are Claude Bulwark/);
    expect(sys).toMatch(/`\.\/ac <tool> key=val …`: the game, as Claude Bulwark/);
    expect(sys).not.toMatch(/\{\{/);
    expect(sys).toMatch(/live stream/);
    expect(sys).toMatch(/repeat=true/);
    expect(sys.endsWith(c.personality.trim())).toBe(true);
    // No hard-coded worktree path, no session-specific notes.
    expect(sys).not.toMatch(/scratchpad|New since last session/);
  });
  it('the opening message carries the journal, the last report and (first segment only) the start notes', () => {
    const c = cfg.characters[0];
    const first = segmentOpening({ c, partner: 'Claude Bulwark', segment: 1, nowMs: Date.UTC(2026, 9, 13, 20), playMinutes: 75, journal: 'open goals:\n  - Undead Mechanic', lastReport: null });
    expect(first).toMatch(/Segment 1/);
    expect(first).toMatch(/Undead Mechanic/);
    expect(first).toContain(c.startNotes);
    const later = segmentOpening({ c, partner: 'Claude Bulwark', segment: 2, nowMs: 0, playMinutes: 75, journal: '', lastReport: 'We reached level 17.' });
    expect(later).not.toContain(c.startNotes);
    expect(later).toMatch(/last segment:\nWe reached level 17\./);
    expect(JSON.parse(userLine('hi'))).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  });
});

describe('feed: chat lines', () => {
  const cast = ['Claude Arcanist', 'Claude Bulwark'];
  const parse = (text: string, st: ChatParseState = {}, at = '2026-10-13T20:00:00.000Z') => parseChatLine(`${at} ${text}`, 'mage', 'Claude Arcanist', cast, st).map((x) => x.draft);
  it('the character\'s own fellowship line, say and tell', () => {
    expect(parse('[Fellowship] You say, "Buffs on you!"')).toEqual([{ type: 'chat', char: 'mage', channel: 'fellowship', text: '[Fellowship] You say, "Buffs on you!"', speaker: 'Claude Arcanist', message: 'Buffs on you!' }]);
    expect(parse('You say, "Well met, Bulwark!"')[0]).toMatchObject({ channel: 'say', speaker: 'Claude Arcanist', message: 'Well met, Bulwark!' });
    expect(parse('You tell Claude Bulwark, "at 42N 33E"')[0]).toMatchObject({ channel: 'tell-out', to: 'Claude Bulwark', message: 'at 42N 33E' });
  });
  it('a partner\'s line is left to the partner\'s own log; strangers and NPCs are kept', () => {
    expect(parse('[Fellowship] Claude Bulwark says, "Lead on."')).toEqual([]);
    expect(parse('Claude Bulwark tells you, "here"')).toEqual([]);
    expect(parse('Renald the Elder tells you, "Welcome!"')[0]).toMatchObject({ channel: 'tell-in', speaker: 'Renald the Elder', to: 'Claude Arcanist' });
    expect(parse('[General] Jake says, "hi stream"')[0]).toMatchObject({ channel: 'general', speaker: 'Jake', message: 'hi stream' });
  });
  it('lines nobody said: combat, magic, system', () => {
    expect(parse('Drudge Servant grazes your chest for 3 points of bludgeoning damage!')[0]).toMatchObject({ channel: 'combat' });
    expect(parse('Casting Flame Bolt III')[0]).toMatchObject({ channel: 'magic' });
    expect(parse('Your spell fizzled.')[0]).toMatchObject({ channel: 'magic' });
    expect(parse('You have entered the General channel.')[0]).toMatchObject({ channel: 'system' });
  });
  it('a level-up and a death (with the killer from the line before the corpse line)', () => {
    expect(parse('You are now level 16!')).toEqual([
      { type: 'chat', char: 'mage', channel: 'system', text: 'You are now level 16!' },
      { type: 'level-up', char: 'mage', level: 16 },
    ]);
    const st: ChatParseState = {};
    parse('Spikey Armoredillo splits you apart!', st, '2026-10-13T20:00:00.000Z');
    const d = parse('Your corpse is located at (36.5N, 35.9E).', st, '2026-10-13T20:00:02.000Z');
    expect(d[1]).toEqual({ type: 'death', char: 'mage', killer: 'Spikey Armoredillo', text: 'Spikey Armoredillo splits you apart!' });
    const st2: ChatParseState = {};
    parse('Your death is preceded by a sharp, stabbing pain, courtesy of Mudlurk Mosswart!', st2);
    expect(parse('Your corpse is located at (42.2N, 35.2E).', st2)[1]).toMatchObject({ type: 'death', killer: 'Mudlurk Mosswart' });
    // A hit is not a killer; with no killer line the death still comes.
    const st3: ChatParseState = {};
    parse('Drudge Skulker hits you for 0 points of bludgeoning damage!', st3);
    expect(parse('Your corpse is located at (1.0N, 2.0E).', st3)[1]).toEqual({ type: 'death', char: 'mage', text: 'Your corpse is located at (1.0N, 2.0E).' });
  });
  it('stamps each line with the time the game printed it', () => {
    expect(parseChatLine('2026-10-13T20:00:05.000Z You are now level 3!', 'mage', 'X', [], {})[0].t).toBe(Date.parse('2026-10-13T20:00:05.000Z'));
    expect(parseChatLine('garbage', 'mage', 'X', [])).toEqual([]);
  });
});

describe('feed: the player\'s stream-json', () => {
  const asst = (...content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } });
  const bash = (command: string) => ({ type: 'tool_use', id: 't1', name: 'Bash', input: { command } });
  it('its own text is narration; each agent CLI call is a summarized tool line, ids named from earlier results', () => {
    const names = new Map<string, string>();
    parseStreamJsonLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't0', content: 'nearby:\n#8000123a  Drudge Servant  [monster L5]  20.0m ahead (N)\n' }] } }), 'mage', names);
    const o = parseStreamJsonLine(asst(
      { type: 'text', text: 'Bulwark called the servant. Bolting it.' },
      bash('npx tsx tools/ac-agent/cli.ts cast spell="Flame Bolt III" target=#8000123a repeat=true profile=mage'),
    ), 'mage', names);
    expect(o.drafts).toEqual([
      { type: 'narration', char: 'mage', text: 'Bulwark called the servant. Bolting it.' },
      { type: 'tool', char: 'mage', tool: 'ac_cast', summary: 'casts Flame Bolt III at Drudge Servant (repeat)' },
    ]);
  });
  it('other commands: the world DB, date (nothing), a Read', () => {
    expect(parseStreamJsonLine(asst(bash('npx tsx tools/stream/world-query.ts "SELECT 1"')), 'soldier').drafts).toEqual([{ type: 'tool', char: 'soldier', tool: 'bash', summary: 'checks the world database' }]);
    expect(parseStreamJsonLine(asst(bash('date')), 'soldier').drafts).toEqual([]);
    expect(parseStreamJsonLine(asst({ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/acjs-agent/screenshot-1.jpg' } }), 'soldier').drafts[0]).toMatchObject({ tool: 'read', summary: 'looks at the screenshot' });
  });
  it('init gives the session id and model; result gives usage and the final text', () => {
    expect(parseStreamJsonLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc', model: 'claude-opus-5-5' }), 'mage').init).toEqual({ sessionId: 'abc', model: 'claude-opus-5-5' });
    const r = parseStreamJsonLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Report: …', total_cost_usd: 3.5, num_turns: 120, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 } }), 'mage').result;
    expect(r).toEqual({ usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheCreationTokens: 40, costUsd: 3.5, turns: 120 }, text: 'Report: …', isError: false, subtype: 'success' });
    expect(parseStreamJsonLine('not json', 'mage').drafts).toEqual([]);
  });
  it('command parsing: quoted words, chains, positional arguments', () => {
    expect(shellWords(`say text="/f hi there" profile=mage`)).toEqual(['say', 'text=/f hi there', 'profile=mage']);
    expect(shellWords(`a 'b c' d\\ e`)).toEqual(['a', 'b c', 'd e']);
    expect(cliCalls('npx tsx tools/ac-agent/cli.ts observe profile=mage && npx tsx tools/ac-agent/cli.ts say "/f go" profile=mage'))
      .toEqual([{ tool: 'observe', args: { profile: 'mage' } }, { tool: 'say', args: { _0: '/f go', profile: 'mage' } }]);
    expect(summarizeCliCall('walk_to', { target: 'Holtburg Lifestone', stay_with: 'Claude Bulwark' })).toBe('walks to Holtburg Lifestone with Claude Bulwark');
    expect(summarizeCliCall('pick_up', { item: 'Pyreals' })).toBe('picks up Pyreals');
    expect(summarizeCliCall('help', {})).toBeNull();
  });
});

describe('feed: writer, tail, status', () => {
  it('writes one JSON object per line with v: 1 and t in epoch ms, to $ACJS_STREAM_FEED when set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acjs-feed-'));
    try {
      const w = new FeedWriter(join(dir, 'f.jsonl'), () => 1234);
      w.write({ type: 'narration', char: 'mage', text: 'hello' });
      w.write({ type: 'level-up', char: 'soldier', level: 9 }, 99);
      const lines = readFileSync(join(dir, 'f.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as FeedEvent);
      expect(lines).toEqual([{ v: 1, t: 1234, type: 'narration', char: 'mage', text: 'hello' }, { v: 1, t: 99, type: 'level-up', char: 'soldier', level: 9 }]);
      const prev = process.env.ACJS_STREAM_FEED;
      try {
        process.env.ACJS_STREAM_FEED = '/x/feed.jsonl';
        expect(feedPath()).toBe('/x/feed.jsonl');
        delete process.env.ACJS_STREAM_FEED;
        expect(feedPath()).toMatch(/acjs-agent\/stream\/feed\.jsonl$/);
      } finally { if (prev === undefined) delete process.env.ACJS_STREAM_FEED; else process.env.ACJS_STREAM_FEED = prev; }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('a tail reads only what is appended after it starts, whole lines only, and starts over on truncation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acjs-tail-'));
    const f = join(dir, 'mage.chat.log');
    try {
      writeFileSync(f, 'old line\n');
      const t = new FileTail(f);
      expect(t.read()).toEqual([]);
      appendFileSync(f, 'one\ntw');
      expect(t.read()).toEqual(['one']);
      appendFileSync(f, 'o\n');
      expect(t.read()).toEqual(['two']);
      writeFileSync(f, 'new\n');
      expect(t.read()).toEqual(['new']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('status comes from the daemon\'s vitals', () => {
    expect(statusDraft('mage', null)).toBeNull();
    expect(statusDraft('mage', {
      name: 'Claude Arcanist', level: 16, health: { cur: 80, max: 100 }, stamina: { cur: 1, max: 2 }, mana: { cur: 3, max: 4 },
      xp: { total: 500, unassigned: 10, toNext: 200, levelStart: 400 }, coords: null, cell: '0x01D90105', indoors: true, dead: false,
      combatMode: 'magic', task: null, goal: 'Undead Mechanic',
    })).toEqual({
      type: 'status', char: 'mage', name: 'Claude Arcanist', level: 16, health: { cur: 80, max: 100 }, stamina: { cur: 1, max: 2 }, mana: { cur: 3, max: 4 },
      xp: { total: 500, toNext: 200, levelStart: 400 }, location: 'indoors (0x01D90105)', goal: 'Undead Mechanic',
    });
  });
});

describe('restart policy and caps', () => {
  const cfg = parseStreamConfig(CAST);
  const today = { segments: 0, minutes: 0, usd: 0 };
  it('a turn that ends early is nudged twice, then the segment ends; at time, stopping or after wrap-up it ends', () => {
    const base = { nowMs: 0, deadlineMs: 60_000, stopping: false, wrapUpSent: false, nudges: 0, maxNudges: 2 };
    expect(afterTurn(base)).toBe('nudge');
    expect(afterTurn({ ...base, nudges: 2 })).toBe('end');
    expect(afterTurn({ ...base, nowMs: 60_000 })).toBe('end');
    expect(afterTurn({ ...base, wrapUpSent: true })).toBe('end');
    expect(afterTurn({ ...base, stopping: true })).toBe('end');
    expect(afterTurn({ ...base, resultSubtype: 'error_max_budget_usd' })).toBe('end');
  });
  it('why a segment ended', () => {
    const b = { stopping: false, wrapUpSent: true, killed: false, sawResult: true, exitCode: 0 };
    expect(endReason(b)).toBe('done');
    expect(endReason({ ...b, wrapUpSent: false })).toBe('quit-early');
    expect(endReason({ ...b, sawResult: false, exitCode: 1 })).toBe('crashed');
    expect(endReason({ ...b, killed: true })).toBe('timed-out');
    expect(endReason({ ...b, stopping: true })).toBe('stopping');
    expect(endReason({ ...b, resultSubtype: 'error_max_budget_usd' })).toBe('budget');
  });
  it('the next segment after the pause; quick exits back off and then halt; caps halt', () => {
    const n = (o: Partial<Parameters<typeof nextSegment>[0]>) => nextSegment({ cfg, stopping: false, segmentsThisRun: 1, quickExits: 0, last: 'done', today, ...o });
    expect(n({ segmentsThisRun: 0, last: null })).toEqual({ action: 'start', delayMs: 0 });
    expect(n({})).toEqual({ action: 'start', delayMs: 20_000 });
    expect(n({ quickExits: 1, last: 'crashed' })).toEqual({ action: 'start', delayMs: 30_000 });
    expect(n({ quickExits: 3, last: 'crashed' })).toEqual({ action: 'start', delayMs: 120_000 });
    expect(n({ quickExits: 4, last: 'crashed' }).action).toBe('halt');
    expect(n({ segmentsThisRun: 8 })).toMatchObject({ action: 'halt', why: expect.stringMatching(/maxSegments/) });
    expect(n({ today: { segments: 16, minutes: 0, usd: 0 } })).toMatchObject({ action: 'halt', why: expect.stringMatching(/daily/) });
    expect(n({ today: { segments: 1, minutes: 720, usd: 0 } }).action).toBe('halt');
    expect(nextSegment({ cfg: cfgWith({ daily: { maxUsd: 50 } }), stopping: false, segmentsThisRun: 1, quickExits: 0, last: 'done', today: { segments: 1, minutes: 1, usd: 50 } }).action).toBe('halt');
    expect(n({ last: 'budget' }).action).toBe('halt');
    expect(n({ stopping: true }).action).toBe('halt');
  });
  it('a day\'s usage counts that profile\'s segments started that local day', () => {
    const rec = (profile: string, start: string, minutes: number, cost: number | null): SegmentRecord => ({
      profile, character: profile, segment: 1, start, end: start, minutes, reason: 'done', model: 'm', sessionId: null, finalText: '',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: cost, turns: null },
    });
    const day = (iso: string) => iso.slice(0, 10);
    const recs = [rec('mage', '2026-10-13T10:00:00Z', 70, 3), rec('mage', '2026-10-13T12:00:00Z', 75, null), rec('soldier', '2026-10-13T10:00:00Z', 70, 4), rec('mage', '2026-10-12T10:00:00Z', 70, 9)];
    expect(dayUsage(recs, 'mage', '2026-10-13', day)).toEqual({ segments: 2, minutes: 145, usd: 3 });
  });
});

// ── the supervisor itself, with fakes ──

interface FakeProc extends PlayerProcess { sent: string[]; emit(o: unknown): void; finish(code?: number): void; killed: boolean; inputEnded: boolean }

function fakeProc(onSend: (text: string, p: FakeProc) => void): FakeProc {
  const queue: string[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  let exitResolve!: (c: number | null) => void;
  const p: FakeProc = {
    sent: [], killed: false, inputEnded: false,
    lines: { [Symbol.asyncIterator]: () => ({ next: async () => { while (!queue.length && !done) await new Promise<void>((r) => (wake = r)); return queue.length ? { value: queue.shift()!, done: false } : { value: undefined, done: true }; } }) } as AsyncIterable<string>,
    send(t) { p.sent.push(JSON.parse(t).message.content[0].text); onSend(JSON.parse(t).message.content[0].text, p); },
    endInput() { p.inputEnded = true; p.finish(0); },
    kill() { p.killed = true; p.finish(143); },
    exit: new Promise((r) => (exitResolve = r)),
    emit(o) { queue.push(JSON.stringify(o)); wake?.(); },
    finish(code = 0) { if (done) return; done = true; wake?.(); exitResolve(code); },
  };
  return p;
}

const result = (text = '') => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 1, num_turns: 3, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } });

function harness(cfgOver: Record<string, unknown>, script: (profile: string, text: string, p: FakeProc) => void, opts: { stopAfterSpawns?: number; daemons?: Record<string, DaemonState | null> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acjs-sup-'));
  let now = Date.UTC(2026, 9, 13, 20);
  const cli: string[][] = [];
  const agentCalls: string[] = [];
  const procs: Array<{ profile: string; args: string[]; env: Record<string, string>; p: FakeProc }> = [];
  const segs: SegmentRecord[] = [];
  const daemons: Record<string, DaemonState | null> = { mage: { ready: true, attached: false }, soldier: { ready: true, attached: false }, ...opts.daemons };
  let stop = false;
  let screen = 'world';
  const deps: SupervisorDeps = {
    now: () => now,
    sleep: async (ms) => { now += ms; await new Promise((r) => setImmediate(r)); },
    tickMs: 5000,
    spawnPlayer: (args, env) => {
      const profile = env.AC_AGENT_PROFILE;
      const p = fakeProc((t, pp) => script(profile, t, pp));
      procs.push({ profile, args, env, p });
      if (opts.stopAfterSpawns && procs.length >= opts.stopAfterSpawns) stop = true;
      return p;
    },
    runCli: async (args) => {
      cli.push(args);
      const profile = args.find((a) => a.startsWith('profile='))!.slice(8);
      if (args[0] === 'stop') daemons[profile] = null;
      if (args[0] === 'start') daemons[profile] = { ready: true, attached: args.some((a) => a.startsWith('attach=')) };
      return { code: 0, out: '' };
    },
    daemonStatus: async (p) => daemons[p] ?? null,
    vitals: async () => ({ name: 'X', level: 5, health: { cur: 1, max: 1 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 }, xp: null, coords: '1N, 1E', cell: '0x1', indoors: false, dead: false, combatMode: 'peace', task: null, goal: null }),
    callAgent: async (p, m) => { agentCalls.push(`${p}:${m}`); if (m === 'logout') screen = 'character-select'; return m === 'status' ? { screen } : { ok: true }; },
    journal: (p) => `${p} journal`,
    brief: () => 'Brief for {{CHARACTER}} ({{PROFILE}}) with {{PARTNER}}.',
    chatLines: () => [],
    stopRequested: () => stop,
    feed: new FeedWriter(join(dir, 'feed.jsonl'), () => now),
    segments: { read: () => segs, append: (r) => segs.push(r) },
    saveReport: () => null,
    rawLine: () => {},
    log: () => {},
  };
  const feed = (): FeedEvent[] => readFileSync(join(dir, 'feed.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { deps, cli, procs, segs, agentCalls, feed, daemons, cleanup: () => rmSync(dir, { recursive: true, force: true }), cfg: cfgWith({ statusEverySeconds: 2, ...cfgOver }) };
}

describe('stream supervisor (fake players, daemons and clock)', () => {
  it('runs a segment per character: opening message with the journal, feed lines, nudges an early quit twice, then halts at maxSegments and logs everyone out', async () => {
    const h = harness({ maxSegments: 1 }, (profile, text, p) => {
      if (text.includes('Segment 1')) {
        p.emit({ type: 'system', subtype: 'init', session_id: `s-${profile}`, model: 'claude-opus-5-5' });
        p.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking around.' }, { type: 'tool_use', name: 'Bash', input: { command: `npx tsx tools/ac-agent/cli.ts observe profile=${profile}` } }] } });
      }
      p.emit(result(`report from ${profile}`)); // quits at once, every time
    });
    try {
      const sup = new StreamSupervisor(h.cfg, h.deps);
      await sup.run();
      expect(h.procs.map((x) => x.profile).sort()).toEqual(['mage', 'soldier']);
      const mage = h.procs.find((x) => x.profile === 'mage')!;
      expect(mage.env).toEqual({ AC_AGENT_PROFILE: 'mage', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' });
      expect(mage.args[mage.args.indexOf('--append-system-prompt') + 1]).toMatch(/^Brief for Claude Arcanist \(mage\) with Claude Bulwark\./);
      expect(mage.p.sent[0]).toMatch(/Segment 1[\s\S]*mage journal/);
      expect(mage.p.sent.slice(1).every((t) => /still live/.test(t))).toBe(true);
      expect(mage.p.sent).toHaveLength(3); // the opening + two nudges, then the session's input is closed
      expect(mage.p.inputEnded).toBe(true);
      expect(h.segs.map((s) => [s.profile, s.reason, s.sessionId, s.usage?.costUsd, s.finalText]).sort()).toEqual([
        ['mage', 'quit-early', 's-mage', 3, 'report from mage'], ['soldier', 'quit-early', 's-soldier', 3, 'report from soldier'],
      ]);
      // Halted (maxSegments): each character logged out with the CLI's stop.
      expect(h.cli.filter((a) => a[0] === 'stop').map((a) => a[1]).sort()).toEqual(['profile=mage', 'profile=soldier']);
      const kinds = h.feed().map((e) => e.type);
      expect(kinds[0]).toBe('session-start');
      expect(kinds).toContain('narration');
      expect(h.feed().find((e) => e.type === 'tool')).toMatchObject({ char: 'mage', tool: 'ac_observe', summary: 'looks around' });
      expect(h.feed().filter((e) => e.type === 'segment-start')).toHaveLength(2);
      expect(h.feed().filter((e) => e.type === 'segment-end' && 'char' in e && e.char === 'mage')[0]).toMatchObject({ title: 'Claude Arcanist: segment 1', detail: expect.stringMatching(/^quit-early after .* min, \$3\.00/) });
      expect(kinds).toContain('status');
      expect(h.feed().at(-1)).toMatchObject({ type: 'segment-end', title: 'Stream over' });
    } finally { h.cleanup(); }
  });

  it('at the segment\'s time the player is told to wrap up; its report ends the segment and the next one starts with it', async () => {
    let segN = 0;
    const h = harness({ maxSegments: 2, characters: [CAST.characters[0]], segment: { ...CAST.segment, minutes: 1, restartPauseSeconds: 0 } }, (_p, text, p) => {
      if (/Segment \d/.test(text)) segN++; // plays on (no result) until told to wrap up
      if (/Wrap up now/.test(text)) p.emit(result(`report ${segN}`));
    });
    try {
      await new StreamSupervisor(h.cfg, h.deps).run();
      expect(h.segs.map((s) => s.reason)).toEqual(['done', 'done']);
      expect(h.procs[1].p.sent[0]).toMatch(/Segment 2[\s\S]*last segment:\nreport 1/);
      expect(h.cli.filter((a) => a[0] === 'stop')).toEqual([['stop', 'profile=mage']]);
    } finally { h.cleanup(); }
  });

  it('a player that ignores the wrap-up is ended after the wrap-up time, and a crash backs off before the next segment', async () => {
    const h = harness({ maxSegments: 2, characters: [CAST.characters[1]], segment: { ...CAST.segment, minutes: 1, wrapUpMinutes: 1 } }, (_p, text, p) => {
      if (/Segment 2/.test(text)) p.finish(1); // crashes at once
    });
    try {
      await new StreamSupervisor(h.cfg, h.deps).run();
      expect(h.procs[0].p.killed).toBe(true);
      expect(h.segs.map((s) => s.reason)).toEqual(['timed-out', 'crashed']);
    } finally { h.cleanup(); }
  });

  it('stop: each player is told the stream is ending, its session ends, then every character is logged out (an attached tab first through the game\'s own logout)', async () => {
    const attach = { endpoint: 'http://127.0.0.1:9222' };
    const h = harness({ characters: [{ ...CAST.characters[0], attach }, CAST.characters[1]] }, (_p, text, p) => {
      if (/stream is ending/.test(text)) p.emit(result('bye'));
    }, { stopAfterSpawns: 2, daemons: { mage: { ready: true, attached: true } } });
    try {
      const sup = new StreamSupervisor(h.cfg, h.deps);
      await sup.run();
      expect(sup.stopping).toBe(true);
      for (const x of h.procs) expect(x.p.sent.some((t) => /stream is ending/.test(t))).toBe(true);
      expect(h.segs.map((s) => s.reason)).toEqual(['stopping', 'stopping']);
      expect(h.agentCalls[0]).toBe('mage:logout');
      expect(h.agentCalls).toContain('mage:status');
      expect(h.agentCalls.some((c) => c.startsWith('soldier:'))).toBe(false); // a local daemon's own stop logs it out
      expect(h.cli.filter((a) => a[0] === 'stop').map((a) => a[1]).sort()).toEqual(['profile=mage', 'profile=soldier']);
    } finally { h.cleanup(); }
  });

  it('starts a daemon that is not running (attached: with the endpoint and the character to pick its tab) and waits for the login', async () => {
    const h = harness({ maxSegments: 1, characters: [{ ...CAST.characters[0], attach: { endpoint: 'http://127.0.0.1:9222' } }] }, (_p, _t, p) => p.emit(result('r')), { daemons: { mage: null } });
    try {
      await new StreamSupervisor(h.cfg, h.deps).run();
      expect(h.cli[0]).toEqual(['start', 'profile=mage', 'character=Claude Arcanist', 'attach=http://127.0.0.1:9222']);
    } finally { h.cleanup(); }
  });
});

describe('attach: two tabs in one Chrome, one per character', () => {
  const tab = (url: string) => ({ url: () => url });
  it('picks the tab in the world as the named character, and none until that character has entered', () => {
    const a = tab('https://playwebac.com/?agent'), b = tab('https://playwebac.com/?agent');
    expect(pickGameTab([a, b], [true, true], ['Claude Arcanist', 'Claude Bulwark'], 'Claude Bulwark')).toBe(b);
    expect(pickGameTab([a, b], [true, true], ['claude arcanist', null], 'Claude Arcanist')).toBe(a);
    expect(pickGameTab([a, b], [true, true], [null, null], 'Claude Bulwark')).toBeNull();
    expect(pickGameTab([a, b], [false, true], ['Claude Bulwark', null], 'Claude Bulwark')).toBeNull();
    // Without a name: the first tab with the API, as before.
    expect(pickGameTab([a, b], [true, true])).toBe(a);
  });
  it('the daemon takes --attach-character', () => {
    expect(parseArgs(['--profile', 'soldier', '--attach', 'http://127.0.0.1:9222', '--attach-character', 'Claude Bulwark']).attachCharacter).toBe('Claude Bulwark');
    expect(parseArgs(['--profile', 'soldier']).attachCharacter).toBeNull();
  });
});

describe('vitals: the overlay\'s read that never takes the agent\'s chat', () => {
  it('returns vitals, level, XP (with the panel\'s to-next and the level\'s start), place, task and goal', () => {
    const host = new FakeHost();
    host.me = { ...host.me, xpTotal: 5000, xpUnassigned: 100, xpToNext: 1200, xpLevelStart: 4500 };
    const api = new AgentApi(host);
    api.setGoal('hunt drudges');
    const v = (api.surface() as unknown as { vitals: () => ReturnType<AgentApi['vitals']> }).vitals();
    expect(v).toMatchObject({ name: 'Claude Test', level: 5, health: { cur: 50, max: 50 }, xp: { total: 5000, unassigned: 100, toNext: 1200, levelStart: 4500 }, goal: 'hunt drudges', dead: false, task: null });
    expect(v!.coords).toMatch(/[NS], .*[EW]$/);
  });
  it('leaves the chat since the player\'s last look for its own next observe', () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    api.observe();
    api.pushChat('[Fellowship] Claude Bulwark says, "pulling"', 0x03);
    api.vitals();
    api.vitals();
    expect(api.observe().chat.map((c) => c.text).join('\n')).toMatch(/pulling/);
  });
  it('is a read (answered while the player has control) and null outside the world', () => {
    expect(READ_METHODS.has('vitals')).toBe(true);
    const host = new FakeHost();
    host.screenName = 'character-select';
    const api = new AgentApi(host);
    (host as unknown as { self: () => null }).self = () => null;
    expect(api.vitals()).toBeNull();
  });
});

describe('world query: read-only for unattended players', () => {
  it('lets one reading statement through and refuses writes, chains, comments and SELECT … INTO', () => {
    expect(worldQueryRefusal("SELECT value FROM weenie_properties_string WHERE type = 1 AND value LIKE '%Drudge; Servant%' LIMIT 5;")).toBeNull();
    expect(worldQueryRefusal('SHOW CREATE TABLE landblock_instance')).toBeNull();
    expect(worldQueryRefusal('DESCRIBE weenie')).toBeNull();
    expect(worldQueryRefusal('UPDATE weenie SET type = 1')).toMatch(/read-only/);
    expect(worldQueryRefusal('SELECT 1; DROP TABLE weenie')).toMatch(/one statement/);
    expect(worldQueryRefusal('SELECT 1 -- hi')).toMatch(/comments/);
    expect(worldQueryRefusal('SELECT * FROM weenie INTO OUTFILE "/tmp/x"')).toMatch(/INTO/);
    expect(worldQueryRefusal('WITH x AS (SELECT 1) DELETE FROM weenie')).toMatch(/change the database/);
    expect(worldQueryRefusal('')).toMatch(/one SQL statement/);
    expect(clipOutput('x'.repeat(10), 4)).toMatch(/^xxxx\n… \(6 more characters cut/);
  });
});

describe('end to end: the supervisor\'s feed through the overlay\'s parser and model', () => {
  it('a status, a narration line, a fellowship line seen by both, a level-up and a death come out as the overlay\'s view', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acjs-e2e-'));
    try {
      const t0 = Date.UTC(2026, 9, 13, 20);
      const file = join(dir, 'feed.jsonl');
      const w = new FeedWriter(file, () => t0);
      const cast = ['Claude Arcanist', 'Claude Bulwark'];
      const at = (s: number) => new Date(t0 + s * 1000).toISOString();
      const chat = (char: string, me: string, st: ChatParseState, s: number, text: string) => { for (const x of parseChatLine(`${at(s)} ${text}`, char, me, cast, st)) w.write(x.draft, x.t); };
      w.write({ type: 'session-start', title: 'Claude Arcanist & Claude Bulwark' }, t0);
      // Status from the daemon's vitals.
      w.write(statusDraft('mage', {
        name: 'Claude Arcanist', level: 16, health: { cur: 90, max: 120 }, stamina: { cur: 100, max: 100 }, mana: { cur: 50, max: 200 },
        xp: { total: 1_000_000, unassigned: 0, toNext: 50_000, levelStart: 900_000 }, coords: '42.1N, 33.6E', cell: '0xA9B40019', indoors: false,
        dead: false, combatMode: 'magic', task: null, goal: 'Undead Mechanic by the waterfall',
      })!, t0 + 1000);
      // The player's narration and a tool call, from its stream-json.
      const o = parseStreamJsonLine(JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'text', text: 'Bulwark has the servant. Bolting it.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'npx tsx tools/ac-agent/cli.ts cast spell="Flame Bolt III" target="Drudge Servant" repeat=true profile=mage' } },
      ] } }), 'mage');
      for (const d of o.drafts) w.write(d, t0 + 2000);
      // A fellowship line: in the speaker's log (written) and the hearer's (left to the speaker's).
      const ms: ChatParseState = {}, ss: ChatParseState = {};
      chat('mage', 'Claude Arcanist', ms, 3, '[Fellowship] You say, "Pull the left one."');
      chat('soldier', 'Claude Bulwark', ss, 3, '[Fellowship] Claude Arcanist says, "Pull the left one."');
      chat('mage', 'Claude Arcanist', ms, 4, 'Casting Flame Bolt III');
      chat('mage', 'Claude Arcanist', ms, 5, 'You are now level 17!');
      chat('soldier', 'Claude Bulwark', ss, 6, 'Spikey Armoredillo splits you apart!');
      chat('soldier', 'Claude Bulwark', ss, 7, 'Your corpse is located at (36.5N, 35.9E).');

      const events = readFileSync(file, 'utf8').trim().split('\n').map((l) => parseFeedLine(l));
      expect(events.every((e) => e !== null)).toBe(true); // the overlay parser takes every line we write
      const st = createState();
      for (const e of events) applyEvent(st, e!, e!.t);

      expect(st.sessionTitle).toBe('Claude Arcanist & Claude Bulwark');
      const mage = st.chars.mage;
      expect(mage).toMatchObject({ name: 'Claude Arcanist', level: 17, levelUps: 1, health: { cur: 90, max: 120 }, xpTotal: 1_000_000, xpToNext: 50_000, xpLevelStart: 900_000, location: '42.1N, 33.6E', goal: 'Undead Mechanic by the waterfall', dead: false });
      expect(mage.lastTool).toMatchObject({ tool: 'ac_cast', summary: 'casts Flame Bolt III at Drudge Servant (repeat)', ok: true });
      expect(st.narration.map((n) => [n.char, n.name, n.text])).toEqual([['mage', 'Claude Arcanist', 'Bulwark has the servant. Bolting it.']]);
      expect(st.chars.soldier).toMatchObject({ deaths: 1, dead: true });
      expect(st.callouts.map((c) => [c.kind, c.char, c.text, c.sub])).toEqual([
        ['level-up', 'mage', 'LEVEL 17', 'Claude Arcanist'],
        ['death', 'soldier', 'SLAIN', 'Claude Bulwark — by Spikey Armoredillo'],
      ]);
      // The fellowship line shows once, as Arcanist's; the cast line is magic spam the panel hides.
      const fell = st.chat.filter((c) => c.channel === 'fellowship');
      expect(fell.map((c) => [c.speaker, c.speakerId, c.body])).toEqual([['Claude Arcanist', 'mage', 'Pull the left one.']]);
      expect(st.chat.some((c) => /Casting/.test(c.body))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// Rehearsal 2026-10-13: $2–6 per 12-minute segment per character. Each model call re-read ~40k tokens before any play
// (the repo's CLAUDE.md, the account's ~/.claude/CLAUDE.md and the project's auto-memory, ~61 KB), and the context grew to
// 90–160k: two npm warnings on every CLI result, a 14 KB `help`, bare waits that woke on every chat line.
describe('player sessions: a small working directory, not the repo', () => {
  const REPO = join(__dirname, '..');
  const cfg = parseStreamConfig(CAST);
  it('the session env turns off CLAUDE.md files and auto-memory and bounds the context', () => {
    expect(playerEnv(cfg, cfg.characters[1])).toEqual({
      AC_AGENT_PROFILE: 'soldier', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000',
    });
    const off = cfgWith({ segment: { ...CAST.segment, autoCompactTokens: null } });
    expect(playerEnv(off, off.characters[0])).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  });
  it('the wrappers call the repo\'s tsx and scripts by absolute path, refuse start/stop and pin the profile', () => {
    const s = playerScripts('/r e/po', 'mage');
    expect(s.ac).toContain(`exec '/r e/po/node_modules/.bin/tsx' '/r e/po/tools/ac-agent/cli.ts' "$@" profile=mage`);
    expect(s.worldQuery).toContain(`exec '/r e/po/node_modules/.bin/tsx' '/r e/po/tools/stream/world-query.ts' "$@"`);
    expect(s.ac).not.toMatch(/npx/);
    expect(() => playerScripts('/repo', 'ma ge')).toThrow(/bad profile/);
    // The pinned profile=… comes last, and the CLI keeps the last value: a call can't drive the partner.
    expect(parseCliArgs(TOOL_BY_NAME.get('ac_observe')!, ['max=8', 'profile=soldier', 'profile=mage'])).toEqual({ max: 8, profile: 'mage' });
  });
  it('runs the real CLI from outside the repo (no npx, no npm warnings) and refuses start/stop itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'acjs-player-'));
    try {
      const p = preparePlayerDir(root, REPO, 'mage');
      expect(p).toEqual({ dir: join(root, 'mage'), ac: './ac', worldQuery: './world-query' });
      expect(statSync(join(p.dir, 'ac')).mode & 0o111).toBeTruthy();
      const run = (cmd: string, ...a: string[]) => spawnSync(cmd, a, { cwd: p.dir, encoding: 'utf8', env: { ...process.env, ACJS_AGENT_STATE_DIR: root } });
      const h = run('./ac', 'help', 'wait');
      expect(h.status).toBe(0);
      expect(h.stdout).toMatch(/^wait\s+\[types=…\]/);
      expect(h.stdout + h.stderr).not.toMatch(/npm warn|^observe/m);
      const st = run('./ac', 'stop');
      expect(st.status).toBe(2);
      expect(st.stderr).toMatch(/never run start or stop/);
      const q = run('./world-query', 'DELETE FROM weenie');
      expect(q.status).toBe(2);
      expect(q.stderr).toMatch(/read-only/);
      // Idempotent: a second prepare leaves working wrappers.
      preparePlayerDir(root, REPO, 'mage');
      expect(run('./ac', 'start').status).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
  it('`help <tool>` prints only that tool; `help` alone keeps the full list', () => {
    const one = help(['observe', 'profile=mage']);
    expect(one.split('\n')[0]).toMatch(/^observe\s/);
    expect(one).not.toMatch(/^wait\s/m);
    expect(help([]).length).toBeGreaterThan(one.length * 10);
    expect(help(['nosuch'])).toMatch(/unknown tool: nosuch/);
  });
  it('the brief: the wrappers, waits that wake only on what matters, observe max, the goal line, the tool names', () => {
    const brief = readFileSync(join(__dirname, '..', 'tools', 'stream', 'brief.md'), 'utf8');
    const sys = systemPrompt(brief, cfg.characters[0], 'Claude Bulwark', playerToolNames(TOOLS.map((t) => t.name)));
    expect(sys).not.toMatch(/npx tsx|cli\.ts|\{\{/);
    expect(sys).toContain('./ac <tool>');
    expect(sys).toContain('./world-query "SELECT');
    expect(sys).toMatch(/wait types=task-done,[^ ]*attackers-up[^ ]* chat_match="\] Claude Bulwark says"/);
    expect(sys).toMatch(/observe max=10/);
    expect(sys).toMatch(/\.\/ac goal text=/);
    expect(sys).toMatch(/The tools: observe, look, note, .*train_skill\./);
    expect(playerToolNames(TOOLS.map((t) => t.name))).not.toMatch(/\b(start|stop|sessions)\b/);
  });
  it('the wrap-up asks for the fight finished, somewhere safe, a goal note, a goodbye, and the report last', () => {
    const w = wrapUpMessage(5);
    const order = ['Finish the fight', 'somewhere safe', 'observe max=5', 'note kind=goal', 'goal text=', 'goodbye', 'report as your final message'].map((x) => w.indexOf(x));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(streamEndingMessage(120)).toMatch(/fight[\s\S]*note kind=goal[\s\S]*goodbye[\s\S]*report/);
  });
  it('the feed reads `./ac` calls like CLI calls', () => {
    expect(cliCalls('./ac cast spell="Flame Bolt III" target=#8000123a repeat=true')).toEqual([{ tool: 'cast', args: { spell: 'Flame Bolt III', target: '#8000123a', repeat: 'true' } }]);
    const o = parseStreamJsonLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: './ac goal text="Clear the foundry statues"' } }] } }), 'mage');
    expect(o.drafts).toEqual([{ type: 'tool', char: 'mage', tool: 'ac_goal', summary: 'new goal: Clear the foundry statues' }]);
    expect(parseStreamJsonLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: './world-query "SELECT 1"' } }] } }), 'mage').drafts[0]).toMatchObject({ summary: 'checks the world database' });
    expect(cliCalls('./acme observe')).toEqual([]);
  });
});

// Rehearsal 2026-10-13: "Claude Arcanist: Helkas Quasith" and sixty "Zojak Quaguz" lines filled the overlay's chat.
// Retail prints a caster's spell words as speech; the overlay's chat panel is for what the characters say.
describe('feed: a character\'s own spell words are magic, not speech', () => {
  const cast = ['Claude Arcanist', 'Claude Bulwark'];
  const t0 = Date.UTC(2026, 9, 13, 20);
  const line = (st: ChatParseState, s: number, text: string, char = 'mage', me = 'Claude Arcanist') => parseChatLine(`${new Date(t0 + s * 1000).toISOString()} ${text}`, char, me, cast, st)[0]?.draft;
  it('the say line just after "Casting …" is magic, and so is the same incantation later without one', () => {
    const shared = new Set<string>();
    const st: ChatParseState = { incantations: shared };
    expect(line(st, 0, 'Casting Flame Bolt III')).toMatchObject({ channel: 'magic' });
    expect(line(st, 1.5, 'You say, "Zojak Quaguz"')).toMatchObject({ channel: 'magic', speaker: 'Claude Arcanist', message: 'Zojak Quaguz' });
    // A repeat cast whose "Casting" line is long gone: known words.
    expect(line(st, 90, 'You say, "Zojak Quaguz"')).toMatchObject({ channel: 'magic' });
    // Another character's log, sharing the set: a stranger casting the same spell nearby.
    const st2: ChatParseState = { incantations: shared };
    expect(line(st2, 91, 'Drudge Ravener says, "Zojak Quaguz"', 'soldier', 'Claude Bulwark')).toMatchObject({ channel: 'magic', speaker: 'Drudge Ravener' });
  });
  it('real /say speech stays speech, even right after a cast', () => {
    const st: ChatParseState = {};
    line(st, 0, 'Casting Strength Other III');
    expect(line(st, 1, 'You say, "Behind me, tin can!"')).toMatchObject({ channel: 'say' });
    expect(line(st, 2, 'You say, "go left"')).toMatchObject({ channel: 'say' });
    expect(line(st, 60, 'You say, "Helkas Quasith"')).toMatchObject({ channel: 'say' }); // never seen after a cast: kept
    expect(line(st, 61, '[Fellowship] You say, "Zojak Quaguz"')).toMatchObject({ channel: 'fellowship' });
    expect(isIncantation('Helkas Quasith', 0, { castingAt: -6000 })).toBe(false);
    expect(isIncantation('Helkas Quasith', 0, { castingAt: -2000 })).toBe(true);
    expect(isIncantation('Malar Cazael Luril', 0, { incantations: new Set(['Malar Cazael Luril']) })).toBe(true);
  });
  it('end to end: the overlay\'s chat panel shows the speech and none of the spell words', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acjs-incant-'));
    try {
      const file = join(dir, 'feed.jsonl');
      const w = new FeedWriter(file, () => t0);
      const st: ChatParseState = { incantations: new Set() };
      for (const [s, text] of [[0, 'Casting Flame Bolt III'], [1, 'You say, "Zojak Quaguz"'], [2, 'You say, "Watch this, Bulwark!"'], [30, 'You say, "Zojak Quaguz"'], [31, '[Fellowship] You say, "Pull the left one."']] as const) {
        for (const x of parseChatLine(`${new Date(t0 + s * 1000).toISOString()} ${text}`, 'mage', 'Claude Arcanist', cast, st)) w.write(x.draft, x.t);
      }
      const ov = createState();
      for (const l of readFileSync(file, 'utf8').trim().split('\n')) applyEvent(ov, parseFeedLine(l)!);
      expect(ov.chat.map((c) => [c.channel, c.speaker, c.body])).toEqual([
        ['say', 'Claude Arcanist', 'Watch this, Bulwark!'],
        ['fellowship', 'Claude Arcanist', 'Pull the left one.'],
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
