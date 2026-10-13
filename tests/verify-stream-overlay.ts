/**
 * Stream overlay (tools/stream/): feed parsing + tailing, replay buffer, SSE framing, the HTTP/SSE
 * server end to end, and the event → view-model reducer the page uses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get, type IncomingMessage } from 'node:http';
import type { FeedEvent, FeedStatus } from '../tools/stream/feed-types.ts';
import {
  FeedTailer, ReplayBuffer, feedFrame, formatSse, parseFeedLine, parseLastEventId, splitLines,
} from '../tools/stream/feed-tail.ts';
import {
  OVERLAY_DIR, SAMPLE_FEED, demoDelay, loadFeedFile, parseArgs, startOverlayServer, transpileForBrowser, type OverlayServer,
} from '../tools/stream/overlay-server.ts';
import {
  CALLOUT_MS, CARD_LAYOUT, applyEvent, cardContentHeight, cardLayoutCssVars, chatOpacity, createState, formatClock, formatXp, parseChatText, xpFraction,
} from '../tools/stream/overlay/model.ts';

const T0 = 1_792_000_000_000;
let n = 0;
const at = (dt: number) => T0 + dt;

function status(char: string, over: Partial<FeedStatus> = {}): FeedStatus {
  return {
    v: 1, t: at(n++), type: 'status', char, name: char === 'mage' ? 'Claude Arcanist' : 'Claude Bulwark', level: 16,
    health: { cur: 100, max: 118 }, stamina: { cur: 150, max: 150 }, mana: { cur: 200, max: 210 },
    xp: { total: 548_120, toNext: 23_642, levelStart: 452_925 }, location: 'Holtburg', goal: 'Hunt drudges', ...over,
  };
}
const line = (ev: object) => JSON.stringify(ev) + '\n';

describe('feed parsing', () => {
  it('accepts valid events and rejects blank, malformed, wrong-version, unknown-type and char-less lines', () => {
    expect(parseFeedLine(JSON.stringify({ v: 1, t: 5, type: 'narration', char: 'mage', text: 'hi' }))?.type).toBe('narration');
    expect(parseFeedLine(JSON.stringify({ v: 1, t: 5, type: 'session-start' }))?.type).toBe('session-start');
    expect(parseFeedLine(JSON.stringify({ v: 1, t: 5, type: 'segment-start', title: 'x' }))?.type).toBe('segment-start');
    expect(parseFeedLine('')).toBeNull();
    expect(parseFeedLine('{"v":1,"t":5,"type":"narr')).toBeNull();
    expect(parseFeedLine(JSON.stringify({ v: 2, t: 5, type: 'narration', char: 'mage', text: 'x' }))).toBeNull();
    expect(parseFeedLine(JSON.stringify({ v: 1, t: 5, type: 'teleport', char: 'mage' }))).toBeNull();
    expect(parseFeedLine(JSON.stringify({ v: 1, t: 5, type: 'narration', text: 'x' }))).toBeNull();
    expect(parseFeedLine(JSON.stringify({ v: 1, t: 'soon', type: 'narration', char: 'mage', text: 'x' }))).toBeNull();
    expect(parseFeedLine('[1,2]')).toBeNull();
  });

  it('splitLines keeps a partial tail and strips CR', () => {
    expect(splitLines('', 'a\r\nb\nc')).toEqual({ lines: ['a', 'b'], rest: 'c' });
    expect(splitLines('c', 'd\n')).toEqual({ lines: ['cd'], rest: '' });
  });

  it('every line of the sample feed parses', () => {
    const raw = readFileSync(SAMPLE_FEED, 'utf8').split('\n').filter(Boolean);
    expect(raw.length).toBeGreaterThanOrEqual(55);
    expect(loadFeedFile(SAMPLE_FEED)).toHaveLength(raw.length);
  });
});

describe('FeedTailer', () => {
  let dir: string;
  let file: string;
  let got: FeedEvent[];
  let rotations: number;
  let tailer: FeedTailer;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acjs-overlay-test-'));
    file = join(dir, 'feed.jsonl');
    got = [];
    rotations = 0;
    tailer = new FeedTailer(file, { onEvent: (e) => got.push(e), onRotate: () => rotations++ });
  });
  afterEach(() => { tailer.stop(); rmSync(dir, { recursive: true, force: true }); });

  const narr = (text: string) => ({ v: 1, t: T0, type: 'narration', char: 'mage', text });

  it('waits for a missing file, then reads existing lines', () => {
    expect(tailer.poll()).toBe(0);
    writeFileSync(file, line(narr('a')) + line(narr('b')));
    expect(tailer.poll()).toBe(2);
    expect(got.map((e) => (e as { text: string }).text)).toEqual(['a', 'b']);
  });

  it('holds a partial line until its newline arrives (even split inside a multi-byte char)', () => {
    const full = line(narr('Läuft — ok'));
    const buf = Buffer.from(full, 'utf8');
    const cut = buf.indexOf(Buffer.from('ä')) + 1; // inside the 2-byte ä
    writeFileSync(file, buf.subarray(0, cut));
    expect(tailer.poll()).toBe(0);
    appendFileSync(file, buf.subarray(cut, buf.length - 1));
    expect(tailer.poll()).toBe(0);
    appendFileSync(file, '\n');
    expect(tailer.poll()).toBe(1);
    expect((got[0] as { text: string }).text).toBe('Läuft — ok');
  });

  it('skips malformed lines without losing the next ones', () => {
    writeFileSync(file, 'not json\n' + line(narr('x')) + '{"v":1}\n');
    expect(tailer.poll()).toBe(1);
  });

  it('restarts from the top after truncation', () => {
    writeFileSync(file, line(narr('one')) + line(narr('two')));
    tailer.poll();
    writeFileSync(file, line(narr('three')));
    expect(tailer.poll()).toBe(1);
    expect(rotations).toBe(1);
    expect((got.at(-1) as { text: string }).text).toBe('three');
  });

  it('follows a rotation (rename + new file), dropping the old partial line', () => {
    writeFileSync(file, line(narr('old')) + '{"v":1,"t":1,"type":"narr');
    tailer.poll();
    renameSync(file, file + '.1');
    // New file bigger than the old offset, so only the inode reveals the rotation.
    writeFileSync(file, line(narr('new-1-' + 'x'.repeat(200))) + line(narr('new-2')));
    expect(tailer.poll()).toBe(2);
    expect(rotations).toBe(1);
    expect(got.map((e) => (e as { text: string }).text.slice(0, 5))).toEqual(['old', 'new-1', 'new-2']);
  });

  it('starts a huge backlog near its end, at a line boundary', () => {
    const lines = Array.from({ length: 400 }, (_, i) => line(narr(`n${i}`))).join('');
    writeFileSync(file, lines);
    const t2 = new FeedTailer(file, { onEvent: (e) => got.push(e), maxBacklogBytes: 1000 });
    t2.poll();
    expect(got.length).toBeGreaterThan(5);
    expect(got.length).toBeLessThan(30);
    expect((got.at(-1) as { text: string }).text).toBe('n399');
  });
});

describe('ReplayBuffer', () => {
  const ev = (i: number): FeedEvent => ({ v: 1, t: i, type: 'narration', char: 'mage', text: String(i) });

  it('keeps the last N with increasing seq numbers', () => {
    const b = new ReplayBuffer(3);
    for (let i = 1; i <= 5; i++) b.push(ev(i));
    expect(b.size).toBe(3);
    expect(b.last().map((x) => x.seq)).toEqual([3, 4, 5]);
    expect(b.last(2).map((x) => x.seq)).toEqual([4, 5]);
    expect(b.last(0)).toEqual([]);
  });

  it('catches a reconnecting client up, or says it cannot', () => {
    const b = new ReplayBuffer(3);
    for (let i = 1; i <= 5; i++) b.push(ev(i));
    expect(b.since(5)).toEqual([]);
    expect(b.since(3)!.map((x) => x.seq)).toEqual([4, 5]);
    expect(b.since(2)!.map((x) => x.seq)).toEqual([3, 4, 5]);
    expect(b.since(1)).toBeNull(); // event 2 fell out of the buffer
    expect(b.since(9)).toBeNull(); // from the future: a previous server run
  });
});

describe('SSE framing', () => {
  it('frames event, id, retry, comments and multi-line data', () => {
    expect(formatSse({ event: 'feed', id: 7, data: 'a\nb' })).toBe('event: feed\nid: 7\ndata: a\ndata: b\n\n');
    expect(formatSse({ retry: 2000 })).toBe('retry: 2000\n\n');
    expect(formatSse({ comment: 'ping' })).toBe(': ping\n\n');
    expect(formatSse({ event: 'x\ny', data: '' })).toBe('event: xy\ndata: \n\n');
  });

  it('feed frames carry run.seq ids that round-trip only for the same run', () => {
    const ev: FeedEvent = { v: 1, t: 1, type: 'narration', char: 'mage', text: 'line\nwith newline' };
    const f = feedFrame({ seq: 12, ev }, 'abcd');
    expect(f.startsWith('event: feed\nid: abcd.12\ndata: ')).toBe(true);
    const data = f.split('\n').find((l) => l.startsWith('data: '))!.slice(6);
    expect(JSON.parse(data)).toEqual(ev); // JSON escapes the newline: one data line
    expect(parseLastEventId('abcd.12', 'abcd')).toBe(12);
    expect(parseLastEventId('ffff.12', 'abcd')).toBeNull();
    expect(parseLastEventId(undefined, 'abcd')).toBeNull();
  });
});

// ---------- server end to end ----------

interface SseFrame { event: string; id?: string; data: string }

/** Open /events and collect frames until `until` says stop. */
function readSse(url: string, until: (frames: SseFrame[]) => boolean, headers: Record<string, string> = {}): Promise<SseFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: SseFrame[] = [];
    let buf = '';
    const req = get(url, { headers }, (res: IncomingMessage) => {
      expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const f: SseFrame = { event: 'message', data: '' };
          const data: string[] = [];
          let any = false;
          for (const l of block.split('\n')) {
            if (l.startsWith('event: ')) { f.event = l.slice(7); any = true; } else if (l.startsWith('id: ')) f.id = l.slice(4);
            else if (l.startsWith('data: ')) { data.push(l.slice(6)); any = true; }
          }
          if (!any) continue; // retry / comment frames
          f.data = data.join('\n');
          frames.push(f);
          if (until(frames)) { req.destroy(); resolve(frames); return; }
        }
      });
    });
    req.on('error', (e) => { if (!(e as NodeJS.ErrnoException).code?.includes('ECONNRESET')) reject(e); });
    setTimeout(() => { req.destroy(); reject(new Error(`timeout; got ${JSON.stringify(frames)}`)); }, 5000);
  });
}

function fetchText(url: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }));
    }).on('error', reject);
  });
}

describe('overlay server', () => {
  let dir: string;
  let srv: OverlayServer;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'acjs-overlay-srv-'));
    const feed = join(dir, 'feed.jsonl');
    writeFileSync(feed, Array.from({ length: 5 }, (_, i) => line({ v: 1, t: T0 + i, type: 'narration', char: 'mage', text: `pre${i}` })).join(''));
    srv = await startOverlayServer({ port: 0, feedPath: feed, replay: 3, pollMs: 20, log: () => {} });
  });
  afterEach(async () => { await srv.close(); rmSync(dir, { recursive: true, force: true }); });

  it('replays the last N on connect after a reset, then streams appended lines live', async () => {
    const live = readSse(`${srv.url}events`, (f) => f.length >= 5);
    await new Promise((r) => setTimeout(r, 100));
    appendFileSync(join(dir, 'feed.jsonl'), line({ v: 1, t: T0 + 9, type: 'narration', char: 'soldier', text: 'live' }));
    const frames = await live;
    expect(frames[0].event).toBe('reset');
    expect(frames.slice(1, 4).map((f) => JSON.parse(f.data).text)).toEqual(['pre2', 'pre3', 'pre4']);
    expect(JSON.parse(frames[4].data).text).toBe('live');
    expect(frames[4].id).toBe(`${srv.runId}.6`);
  });

  it('catches a reconnect up from Last-Event-ID without a reset; a foreign id gets a reset', async () => {
    srv.push({ v: 1, t: T0 + 20, type: 'narration', char: 'mage', text: 'pushed' });
    const resumed = await readSse(`${srv.url}events`, (f) => f.length >= 2, { 'Last-Event-ID': `${srv.runId}.4` });
    expect(resumed.map((f) => f.event)).toEqual(['feed', 'feed']);
    expect(resumed.map((f) => JSON.parse(f.data).text)).toEqual(['pre4', 'pushed']);
    const foreign = await readSse(`${srv.url}events`, (f) => f.length >= 1, { 'Last-Event-ID': 'zzzz.4' });
    expect(foreign[0].event).toBe('reset');
  });

  it('serves the page and browser JS transpiled from the TS modules, and nothing else', async () => {
    const page = await fetchText(srv.url);
    expect(page.status).toBe(200);
    expect(page.body).toContain('class="game-region"');
    expect(page.body).toContain('src="app.ts"');
    const app = await fetchText(`${srv.url}app.ts`);
    expect(app.type).toMatch(/javascript/);
    expect(app.body).toMatch(/from ['"]\.\/model\.ts['"]/);
    expect(app.body).not.toMatch(/\binterface\s+CardEls/);
    expect((await fetchText(`${srv.url}overlay.css`)).status).toBe(200);
    expect((await fetchText(`${srv.url}../feed-types.ts`)).status).toBe(404);
    expect((await fetchText(`${srv.url}overlay-server.ts`)).status).toBe(404);
  });
});

describe('demo mode', () => {
  it('parses --demo with and without a file, and paces the loop from recorded gaps', () => {
    expect(parseArgs(['--demo']).demoFile).toBe(SAMPLE_FEED);
    expect(parseArgs(['--demo', '/x.jsonl', '--port', '8000'])).toMatchObject({ demoFile: '/x.jsonl', port: 8000 });
    expect(() => parseArgs(['--bogus'])).toThrow();
    const e = (t: number): FeedEvent => ({ v: 1, t, type: 'session-start' });
    expect(demoDelay(e(0), e(2000))).toBe(2000);
    expect(demoDelay(e(0), e(2000), 2)).toBe(1000);
    expect(demoDelay(e(0), e(10))).toBe(250);
    expect(demoDelay(e(0), e(60_000))).toBe(6000);
  });

  it('a demo server streams the sample with fresh timestamps', async () => {
    const srv = await startOverlayServer({ port: 0, demoFile: SAMPLE_FEED, log: () => {} });
    try {
      const before = Date.now();
      const frames = await readSse(`${srv.url}events`, (f) => f.some((x) => x.event === 'feed'));
      const first = JSON.parse(frames.find((f) => f.event === 'feed')!.data) as FeedEvent;
      expect(first.type).toBe('session-start');
      expect(first.t).toBeGreaterThanOrEqual(before - 1000);
    } finally { await srv.close(); }
  });
});

// ---------- reducer ----------

describe('overlay model', () => {
  it('parses retail chat shapes', () => {
    expect(parseChatText('[Fellowship] Claude Bulwark says, "Target: Drudge Servant #800058e3. Behind me."'))
      .toEqual({ channel: 'fellowship', speaker: 'Claude Bulwark', to: null, body: 'Target: Drudge Servant #800058e3. Behind me.' });
    expect(parseChatText('[Fellowship] You say, "Hi"')).toMatchObject({ channel: 'fellowship', speaker: 'You', body: 'Hi' });
    expect(parseChatText('Claude Arcanist tells you, "Mind it."')).toMatchObject({ channel: 'tell-in', speaker: 'Claude Arcanist', to: 'You' });
    expect(parseChatText('You tell Claude Bulwark, "Mind it."')).toMatchObject({ channel: 'tell-out', speaker: 'You', to: 'Claude Bulwark' });
    expect(parseChatText('Eyrlwen says, "hello"')).toMatchObject({ channel: 'say', speaker: 'Eyrlwen' });
    expect(parseChatText('You are now level 17!')).toMatchObject({ channel: null, speaker: null, body: 'You are now level 17!' });
  });

  it('first status sets the level without a callout; a rise is a level-up with a callout', () => {
    const s = createState();
    applyEvent(s, status('mage', { t: at(0), level: 16 }));
    expect(s.chars.mage.level).toBe(16);
    expect(s.callouts).toHaveLength(0);
    applyEvent(s, status('mage', { t: at(1000), level: 17 }));
    expect(s.chars.mage.levelUps).toBe(1);
    expect(s.callouts).toMatchObject([{ kind: 'level-up', char: 'mage', text: 'LEVEL 17' }]);
  });

  it('chat, explicit event, fellowship broadcast and status for one level-up count once', () => {
    const s = createState();
    applyEvent(s, status('mage', { t: at(0), level: 16 }));
    applyEvent(s, { v: 1, t: at(100), type: 'chat', char: 'mage', channel: 'system', text: 'You are now level 17!' });
    applyEvent(s, { v: 1, t: at(120), type: 'level-up', char: 'mage', level: 17 });
    applyEvent(s, { v: 1, t: at(150), type: 'chat', char: 'soldier', channel: 'system', text: 'Claude Arcanist is now level 17!' });
    applyEvent(s, status('mage', { t: at(400), level: 17 }));
    expect(s.chars.mage.levelUps).toBe(1);
    expect(s.callouts.filter((c) => c.kind === 'level-up')).toHaveLength(1);
    // The other character's broadcast alone also levels the named character.
    applyEvent(s, status('soldier', { t: at(500), level: 15 }));
    applyEvent(s, { v: 1, t: at(600), type: 'chat', char: 'mage', channel: 'system', text: 'Claude Bulwark is now level 16!' });
    expect(s.chars.soldier.level).toBe(16);
    expect(s.chars.soldier.levelUps).toBe(1);
  });

  it('death signals for one death (victim line, explicit event, broadcast, status) count once; a later death counts again', () => {
    const s = createState();
    applyEvent(s, status('mage', { t: at(0) }));
    applyEvent(s, { v: 1, t: at(1000), type: 'chat', char: 'mage', channel: 'system', text: 'Your death is preceded by a sharp, stabbing pain, courtesy of Drudge Skulker!' });
    applyEvent(s, { v: 1, t: at(1050), type: 'death', char: 'mage', killer: 'Drudge Skulker' });
    applyEvent(s, { v: 1, t: at(1100), type: 'chat', char: 'soldier', channel: 'system', text: "Claude Arcanist's death is preceded by a sharp, stabbing pain, courtesy of Drudge Skulker!" });
    applyEvent(s, status('mage', { t: at(1400), health: { cur: 0, max: 118 }, dead: true }));
    expect(s.chars.mage.deaths).toBe(1);
    expect(s.chars.mage.dead).toBe(true);
    const death = s.callouts.find((c) => c.kind === 'death')!;
    expect(death.sub).toContain('Drudge Skulker');
    applyEvent(s, status('mage', { t: at(5000) }));
    expect(s.chars.mage.dead).toBe(false);
    // Status-only death detection (alive → dead), well after the first.
    applyEvent(s, status('mage', { t: at(60_000), health: { cur: 0, max: 118 } }));
    expect(s.chars.mage.deaths).toBe(2);
    expect(s.chars.soldier.deaths).toBe(0);
  });

  it('XP this session counts from the first total seen; session-start resets clock, deaths and baseline', () => {
    const s = createState();
    applyEvent(s, status('mage', { t: at(0), xp: { total: 548_120, toNext: 23_642, levelStart: 452_925 } }));
    applyEvent(s, status('mage', { t: at(1000), xp: { total: 552_300, toNext: 19_462, levelStart: 452_925 } }));
    expect(s.chars.mage.xpSession).toBe(4180);
    expect(xpFraction(s.chars.mage)).toBeCloseTo((552_300 - 452_925) / (571_762 - 452_925), 6);
    applyEvent(s, { v: 1, t: at(2000), type: 'death', char: 'mage' });
    expect(s.sessionStart).toBe(at(0));
    applyEvent(s, { v: 1, t: at(10_000), type: 'session-start', title: 'Round two' });
    expect(s.sessionStart).toBe(at(10_000));
    expect(s.sessionTitle).toBe('Round two');
    expect(s.chars.mage.deaths).toBe(0);
    expect(s.chars.mage.xpSession).toBe(0);
    applyEvent(s, status('mage', { t: at(11_000), xp: { total: 553_300, toNext: 18_462, levelStart: 452_925 } }));
    expect(s.chars.mage.xpSession).toBe(1000);
  });

  it('XP bar is unknown without levelStart, full at max level', () => {
    const s = createState();
    applyEvent(s, status('mage', { xp: { total: 10, toNext: 5 } }));
    expect(xpFraction(s.chars.mage)).toBeNull();
    applyEvent(s, status('mage', { xp: { total: 10, toNext: 0 } }));
    expect(xpFraction(s.chars.mage)).toBe(1);
  });

  it('chat seen by both clients shows once, tells from either end once, combat spam hidden', () => {
    const s = createState();
    const chat = (dt: number, char: string, channel: 'fellowship' | 'tell-in' | 'tell-out' | 'combat' | 'system', text: string) =>
      applyEvent(s, { v: 1, t: at(dt), type: 'chat', char, channel, text });
    chat(0, 'soldier', 'fellowship', '[Fellowship] You say, "Behind me."');
    chat(50, 'mage', 'fellowship', '[Fellowship] Claude Bulwark says, "Behind me."');
    chat(100, 'mage', 'tell-out', 'You tell Claude Bulwark, "Mind it."');
    chat(150, 'soldier', 'tell-in', 'Claude Arcanist tells you, "Mind it."');
    chat(200, 'mage', 'combat', 'You hit Drudge Servant for 14 points of fire damage!');
    chat(300, 'mage', 'system', "You've earned 1,540 experience.");
    expect(s.chat).toHaveLength(3);
    expect(s.chat[0]).toMatchObject({ channel: 'fellowship', speaker: 'Claude Bulwark', speakerId: 'soldier', body: 'Behind me.' });
    expect(s.chat[1]).toMatchObject({ channel: 'tell-out', speaker: 'Claude Arcanist', speakerId: 'mage', to: 'Claude Bulwark' });
    expect(s.chat[2]).toMatchObject({ speaker: null, seenBy: 'mage' });
    // The same words again much later are a new line.
    chat(60_000, 'soldier', 'fellowship', '[Fellowship] You say, "Behind me."');
    expect(s.chat).toHaveLength(4);
  });

  it('narration and tool summaries land on the right character; unknown profiles get a slot of their own', () => {
    const s = createState();
    applyEvent(s, { v: 1, t: at(0), type: 'narration', char: 'soldier', text: 'Taking point.' });
    applyEvent(s, { v: 1, t: at(1), type: 'tool', char: 'mage', tool: 'ac_cast', summary: 'Flame Bolt II', ok: false });
    applyEvent(s, { v: 1, t: at(2), type: 'narration', char: 'healer', text: 'Hello.' });
    expect(s.narration.map((x) => x.name)).toEqual(['Claude Bulwark', 'healer']);
    expect(s.chars.mage.lastTool).toMatchObject({ tool: 'ac_cast', ok: false });
    expect(s.roster.map((r) => r.id)).toEqual(['mage', 'soldier', 'healer']);
  });

  it('replayed history (page opened later) shows no stale callouts; fresh ones expire after CALLOUT_MS', () => {
    const s = createState();
    applyEvent(s, status('mage', { t: at(0), level: 16 }), at(600_000));
    applyEvent(s, { v: 1, t: at(1000), type: 'level-up', char: 'mage', level: 17 }, at(600_000));
    expect(s.chars.mage.levelUps).toBe(1);
    expect(s.callouts).toHaveLength(0);
    applyEvent(s, { v: 1, t: at(700_000), type: 'death', char: 'mage' }, at(700_000));
    expect(s.callouts).toHaveLength(1);
    applyEvent(s, { v: 1, t: at(700_000 + CALLOUT_MS), type: 'narration', char: 'mage', text: 'later' }, at(700_000 + CALLOUT_MS));
    expect(s.callouts).toHaveLength(0);
  });

  it('the sample feed folds into the expected end state', () => {
    const s = createState();
    for (const ev of loadFeedFile(SAMPLE_FEED)) applyEvent(s, ev);
    const m = s.chars.mage, b = s.chars.soldier;
    expect(m).toMatchObject({ level: 17, levelUps: 1, deaths: 1, dead: false, xpSession: 573_110 - 548_120 });
    expect(b).toMatchObject({ level: 15, levelUps: 0, deaths: 0, xpSession: 436_900 - 430_100 });
    expect(s.segment).toBeNull();
    expect(s.sessionTitle).toBe('Drudges of the Holtburg Hills');
    const fellowship = s.chat.filter((c) => c.channel === 'fellowship');
    expect(new Set(fellowship.map((c) => c.body)).size).toBe(fellowship.length);
    expect(s.chat.some((c) => c.channel === 'combat' || c.channel === 'magic')).toBe(false);
  });

  it('the browser build of model.ts (as served) runs the same reducer', async () => {
    const js = transpileForBrowser(readFileSync(join(OVERLAY_DIR, 'model.ts'), 'utf8'), 'model.ts');
    expect(js).not.toMatch(/^import /m); // type-only imports erased: no module graph in the browser
    const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`) as typeof import('../tools/stream/overlay/model.ts');
    const s = mod.createState();
    for (const ev of loadFeedFile(SAMPLE_FEED)) mod.applyEvent(s, ev);
    expect(s.chars.mage.level).toBe(17);
    expect(s.chars.mage.deaths).toBe(1);
  });

  it('character cards fit: rows + gaps + padding within the card, between the game region and the bottom row', () => {
    expect(cardContentHeight()).toBeLessThanOrEqual(CARD_LAYOUT.height);
    expect(CARD_LAYOUT.top + CARD_LAYOUT.height).toBeLessThanOrEqual(CARD_LAYOUT.bottomRowTop);
    const css = readFileSync(join(OVERLAY_DIR, 'overlay.css'), 'utf8');
    const px = (name: string) => Number(new RegExp(`${name}:\\s*(\\d+)px`).exec(css)?.[1]);
    expect(px('--region-y') + px('--region-h')).toBeLessThanOrEqual(CARD_LAYOUT.top);
    // Each text row holds one line of its font.
    for (const r of Object.values(CARD_LAYOUT.rows)) expect(r.font * 1.15).toBeLessThanOrEqual(r.h);
    // The stylesheet actually consumes every variable the page sets (a renamed var would silently fall back).
    for (const k of Object.keys(cardLayoutCssVars())) expect(css).toContain(`var(${k})`);
    // The card template has exactly the rows CARD_LAYOUT budgets for, in that order.
    const html = readFileSync(join(OVERLAY_DIR, 'index.html'), 'utf8');
    const tpl = /<template id="card-template">([\s\S]*?)<\/template>/.exec(html)![1];
    const top = [...tpl.matchAll(/^  <div class="([^"]+)"/gm)].map((m) => m[1].split(' ').at(-1));
    expect(top).toEqual(['card-head', 'vitals', 'xp', 'location', 'goal', 'tool']);
    expect(Object.keys(CARD_LAYOUT.rows)).toEqual(['head', 'vitals', 'xp', 'location', 'goal', 'tool']);
  });

  it('formatting helpers', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatXp(950)).toBe('950');
    expect(formatXp(12_345)).toBe('12,345');
    expect(formatXp(1_234_567)).toBe('1.23M');
    expect(chatOpacity(9, 10, 0)).toBe(1);
    expect(chatOpacity(0, 20, 0)).toBeLessThan(0.5);
    expect(chatOpacity(9, 10, 400_000)).toBe(0.35);
  });
});
