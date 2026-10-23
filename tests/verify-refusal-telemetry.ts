/**
 * TELEMETRY.refusal-events — every refusal a player sees reaches the bridge log as one
 * `client_refusal` line, tagged by era (webac#12: "You can only move or use one item at a
 * time", printed by our own inventory-request lock, never reached our logs; webac#9's
 * "You must select a suitable target before casting this spell" was client-printed too).
 *
 * Driven through shipped code: the RefusalReporter aggregator, the GameUI spew tap, the real
 * inventory-request gate, the real ServerMessageHandler fed end-of-retail WeenieError /
 * WeenieErrorWithString / UseDone / InventoryServerSaveFailed bytes and AC1999 0x1C / 0xA0 /
 * 0xF62C / 0x2EB bytes through the real 1999 adapter, the bridge's whitelist, the bridge's
 * route, and tools/watch-refusals.sh.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RefusalReporter, REFUSAL_ROLLUP_MS, MAX_REFUSAL_CODES, refusalHash, refusalTemplate, scrubNames, weenieCode,
  type RefusalEvent,
} from '../packages/renderer/src/telemetry/RefusalReporter';
import { sanitizeClientRefusal } from '../services/ws-tcp-bridge/src/clientRefusal';
import { resolveBridgeConfig, type BridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { createBridgeServer } from '../services/ws-tcp-bridge/src/server';
import { GameUI } from '../packages/renderer/src/ui/GameUI';
import { InventoryRequestTracker, InventoryRequest, weenieErrorText, weenieErrorWithStringText } from '../packages/shared/src/index';
import { gateInventoryRequestSend } from '../packages/renderer/src/inventory/InventoryRequests';
import { GameActionType } from '../packages/network/src/GameActionType';
import { deserializeMessage, serializeGameEvent, BinaryWriter } from '../packages/network/src/MessageSerializer';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler';
import { deliverWeenieError } from '../packages/renderer/src/ui/WeenieErrorNotices';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999';
import { registerCombat1999 } from '../packages/network/src/era1999/codecs/Combat1999';
import { registerInventory1999 } from '../packages/network/src/era1999/codecs/Inventory1999';
import { registerMovement1999 } from '../packages/network/src/era1999/codecs/Movement1999';
import type { Player1999State } from '../packages/network/src/era1999/codecs/Player1999';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999';

const LOCK_TEXT = 'You can only move or use one item at a time';

function rig(era = 'eor', scrub?: (t: string) => string) {
  const clock = { t: 1000 };
  const events: RefusalEvent[] = [];
  const r = new RefusalReporter({
    endpoint: 'http://x/client-preworld', build: 'b1', trace: 'feedc0de12345678',
    era: () => era, server: () => 'levistras', now: () => clock.t, scrub,
    send: (_url, body) => { events.push(JSON.parse(body) as RefusalEvent); },
  });
  return { r, clock, events };
}

describe('RefusalReporter: first at once, repeats rolled up', () => {
  it('sends the first of a client refusal at once, then one count per minute', () => {
    const g = rig('ac1999-retail');
    g.r.clientSpew(LOCK_TEXT);
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({
      outcome: 'refusal', era: 'ac1999-retail', server: 'levistras', trace: 'feedc0de12345678', build: 'b1',
      source: 'client', code: `c:${refusalHash(LOCK_TEXT)}`, text: LOCK_TEXT, context: 'spew', sink: 'spew',
      action: null, count: 1, first: true, windowMs: 0,
    });
    for (let i = 0; i < 40; i++) { g.clock.t += 500; g.r.clientSpew(LOCK_TEXT); g.r.tick(); }
    expect(g.events).toHaveLength(1); // 20 s: nothing more yet
    g.clock.t += REFUSAL_ROLLUP_MS;
    g.r.tick();
    expect(g.events).toHaveLength(2);
    expect(g.events[1]).toMatchObject({ code: g.events[0].code, count: 40, first: false, windowMs: 39 * 500 });
    // Nothing pending: the next minute sends nothing.
    g.clock.t += REFUSAL_ROLLUP_MS;
    g.r.tick();
    expect(g.events).toHaveLength(2);
  });

  it('flush sends what is pending (the world session ended, the page is going)', () => {
    const g = rig();
    g.r.serverCode('weenie_error', 0x1d, "You're too busy!", 'spew');
    g.r.serverCode('weenie_error', 0x1d, "You're too busy!", 'spew');
    g.r.serverCode('weenie_error', 0x1d, "You're too busy!", 'spew');
    g.r.flush();
    expect(g.events.map((e) => [e.code, e.count, e.first])).toEqual([['we:0x001d', 1, true], ['we:0x001d', 2, false]]);
  });

  it('caps the distinct codes per page', () => {
    const g = rig();
    for (let i = 0; i < MAX_REFUSAL_CODES + 10; i++) g.r.serverCode('weenie_error', i + 1, null, 'none');
    expect(g.events).toHaveLength(MAX_REFUSAL_CODES);
  });

  it('skips spew notices that are not refusals, and anything raised quietly', () => {
    const g = rig();
    for (const t of ['AutoRun ON', 'AutoRun OFF', 'Casting Flame Bolt I', 'A Portal Storm is imminent - leave this crowded area!', 'In Portal Space - Please Wait...']) g.r.clientSpew(t);
    g.r.quietly(() => g.r.clientSpew('Use comma after the name for targeted chat.'));
    expect(g.events).toEqual([]);
  });

  it('carries the refused action when the gate ran inside forAction', () => {
    const g = rig();
    const tracker = new InventoryRequestTracker();
    tracker.record(0x6000001, InventoryRequest.Move);
    const sent = g.r.forAction(GameActionType.PutItemInContainer, () => gateInventoryRequestSend(tracker, GameActionType.PutItemInContainer, (t) => g.r.clientSpew(t)));
    expect(sent).toBe(false);
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ source: 'client', text: LOCK_TEXT, action: GameActionType.PutItemInContainer });
  });
});

describe('templates: no names, no numbers', () => {
  it('scrubs every name the client knows, longest first, and numbers become #', () => {
    expect(scrubNames('Bob the Great is too busy to accept gifts right now.', ['Bob', 'Bob the Great', 'x'])).toBe('_ is too busy to accept gifts right now.');
    expect(refusalTemplate('You need 25 more Pyreals (0x1A2B).é')).toBe('You need # more Pyreals (#).');
    const g = rig('eor', (t) => scrubNames(t, ['Gromnie', 'Bulwark']));
    g.r.clientSpew('You cannot use the Gromnie on Bulwark');
    expect(g.events[0].text).toBe('You cannot use the _ on _');
    // The same refusal on another object keeps its code.
    g.r.clientSpew('You cannot use the Bulwark on Gromnie');
    expect(g.events).toHaveLength(1);
  });

  it('WeenieErrorWithString sends the template, never the substituted value', () => {
    const g = rig();
    g.r.serverCode('weenie_error_str', 0x1e, weenieErrorWithStringText(0x1e) || null, 'spew');
    expect(g.events[0].text).toMatch(/^_ /);
  });
});

describe('the client spew tap (GameUI.displayErrorText)', () => {
  it('every spew line goes to the tap, then to the spew box and chat', () => {
    const g = rig();
    const shown: string[] = [];
    const fake = {
      refusalTap: (t: string) => g.r.clientSpew(t),
      spewNotice: (t: string) => { shown.push(`spew:${t}`); },
      addSystemMessage: (t: string) => { shown.push(`chat:${t}`); },
    };
    GameUI.prototype.displayErrorText.call(fake as unknown as GameUI, 'You must select a suitable target before casting this spell');
    expect(shown).toEqual(['spew:You must select a suitable target before casting this spell', 'chat:You must select a suitable target before casting this spell']);
    expect(g.events[0]).toMatchObject({ source: 'client', text: 'You must select a suitable target before casting this spell' });
    // A throwing tap never stops the notice.
    const shown2: string[] = [];
    GameUI.prototype.displayErrorText.call({ ...fake, refusalTap: () => { throw new Error('x'); }, spewNotice: (t: string) => shown2.push(t) } as unknown as GameUI, 'x');
    expect(shown2).toEqual(['x']);
  });
});

/** main.ts's server hooks, around the REAL handler: deliver quietly, then report by code / text. */
function serverHooks(r: RefusalReporter, ui: { displayErrorText(t: string): void; addSystemMessage(t: string): void }) {
  const h = new ServerMessageHandler();
  h.setHandlers({
    onWeenieError: (d: { errorType: number }) => {
      const shown = r.quietly(() => deliverWeenieError(ui, d.errorType, weenieErrorText(d.errorType)));
      r.serverCode('weenie_error', d.errorType, weenieErrorText(d.errorType), shown.sink);
    },
    onWeenieErrorWithString: (d: { errorType: number; message: string }) => {
      const shown = r.quietly(() => deliverWeenieError(ui, d.errorType, d.message));
      r.serverCode('weenie_error_str', d.errorType, weenieErrorWithStringText(d.errorType) || null, shown.sink);
    },
    onUseDone: (d: { errorType: number }) => {
      if (d.errorType) r.serverCode('use_done', d.errorType, weenieErrorText(d.errorType), 'spew');
    },
    onInventoryServerSaveFailed: (d: { itemGuid: number; errorType: number }) => {
      r.serverCode('inventory_failed', d.errorType, d.errorType ? weenieErrorText(d.errorType) : null, 'spew');
    },
    onServerMessage: (d: { message: string; chatType: number }) => { r.serverText('server_text', d.message, d.chatType); },
    onCommunicationTransientString: (d: { message: string }) => { r.serverText('transient', d.message, null); },
    onTransientString: (d: { message: string }) => { r.serverText('transient', d.message, null); },
  } as never);
  return h;
}

describe('end of retail: the server refusals ACE / GDLE send', () => {
  it('WeenieError, WeenieErrorWithString, UseDone and InventoryServerSaveFailed each report their code', () => {
    const g = rig('eor');
    const spew: string[] = [];
    const ui = { displayErrorText: (t: string) => { spew.push(t); g.r.clientSpew(t); }, addSystemMessage: () => {} };
    const h = serverHooks(g.r, ui);
    const ev = (type: number, body: (w: BinaryWriter) => void) => {
      const w = new BinaryWriter(64); body(w);
      h.handleMessage(deserializeMessage(serializeGameEvent(1, type, w.toBuffer(), 0x50000001)));
    };
    ev(0x028a, (w) => w.writeUInt32(0x1d)); // You're too busy!
    ev(0x028b, (w) => { w.writeUInt32(0x1e); w.writeString16('Bob'); });
    ev(0x01c7, (w) => w.writeUInt32(0x3ee));
    ev(0x00a0, (w) => { w.writeUInt32(0x6000004); w.writeUInt32(0x2b); });
    expect(g.events.map((e) => [e.source, e.code, e.context])).toEqual([
      ['server', 'we:0x001d', 'weenie_error'],
      ['server', 'we:0x001e', 'weenie_error_str'],
      ['server', 'we:0x03ee', 'use_done'],
      ['server', 'we:0x002b', 'inventory_failed'],
    ]);
    expect(g.events[0]).toMatchObject({ text: "You're too busy!", sink: 'spew' });
    expect(JSON.stringify(g.events)).not.toContain('Bob');
    // The server's spew line was shown but not counted again as a client refusal.
    expect(spew).toContain("You're too busy!");
    expect(g.events.filter((e) => e.source === 'client')).toEqual([]);
  });
});

describe('AC1999: the 1999 server refusals reach the same reporter', () => {
  const PLAYER = 0x50000003;
  function feed1999(r: RefusalReporter) {
    const c = emptyCodecs();
    registerCombat1999(c, { player: () => ({ guid: PLAYER, eventSequence: 0 }) });
    registerInventory1999(c, { player: () => ({ guid: PLAYER, eventSequence: 100 } as Player1999State) });
    registerMovement1999(c);
    const adapter = new Adapter1999(c, { account: 'acjs', log: () => {} });
    const h = serverHooks(r, { displayErrorText: (t) => r.clientSpew(t), addSystemMessage: () => {} });
    return (bytes: Uint8Array) => { for (const e of adapter.inbound(bytes, 4)) h.handleMessage(deserializeMessage(e)); };
  }

  it('0x1C AttemptFailed, 0xA0 NotifyInventoryFailed, 0xF62C text refusals and 0x2EB overlay text', () => {
    const g = rig('ac1999-retail');
    const feed = feed1999(g.r);
    feed(new Writer1999().u32(0x1c).i32(0x402).toBytes()); // Your spell fizzled.
    feed(new Writer1999().u32(0xf7b0).u32(PLAYER).u32(42).u32(0xa0).u32(0x6000004).i32(0x29).toBytes());
    feed(new Writer1999().u32(0xf62c).acString('You do not have permission to loot that corpse!').u32(4).toBytes());
    feed(new Writer1999().u32(0xf62c).acString('Welcome to Asheron\'s Call!').u32(0).toBytes()); // not a refusal
    feed(new Writer1999().u32(0x2eb).acString("You can't do that yet!").toBytes());
    expect(g.events.map((e) => [e.era, e.source, e.code, e.context])).toEqual([
      ['ac1999-retail', 'server', weenieCode(0x402), 'weenie_error'],
      ['ac1999-retail', 'server', weenieCode(0x29), 'inventory_failed'],
      ['ac1999-retail', 'server', `t:${refusalHash('You do not have permission to loot that corpse!')}`, 'server_text'],
      ['ac1999-retail', 'server', `t:${refusalHash("You can't do that yet!")}`, 'transient'],
    ]);
  });

  it('the 1999 lock line (webac#12) goes out as a client refusal tagged ac1999', () => {
    const g = rig('ac1999-retail');
    const tracker = new InventoryRequestTracker();
    tracker.record(0x6000001, InventoryRequest.Give);
    g.r.forAction(GameActionType.GiveObjectRequest, () => gateInventoryRequestSend(tracker, GameActionType.GiveObjectRequest, (t) => g.r.clientSpew(t)));
    expect(g.events[0]).toMatchObject({ era: 'ac1999-retail', source: 'client', text: LOCK_TEXT, action: GameActionType.GiveObjectRequest });
  });
});

describe('the bridge keeps the refusal fields and drops the rest', () => {
  it('sanitizeClientRefusal round-trips what the page sends', () => {
    const g = rig('classic-dereth');
    g.r.clientSpew(LOCK_TEXT);
    g.r.serverCode('weenie_error', 0x402, 'Your spell fizzled.', 'chat');
    for (const e of g.events) expect(sanitizeClientRefusal(e)).toEqual(e);
  });

  it('rejects a missing or malformed code, and junk fields', () => {
    expect(sanitizeClientRefusal({ outcome: 'refusal' })).toBeNull();
    expect(sanitizeClientRefusal({ outcome: 'refusal', code: 'Bob' })).toBeNull();
    expect(sanitizeClientRefusal({ outcome: 'first_minute', code: 'we:0x1' })).toBeNull();
    const junk = sanitizeClientRefusal({
      outcome: 'refusal', code: 'c:0123abcd', name: 'Bob', text: 'Bob has 3 pyreals', source: 'player', context: 'tell',
      sink: 'popup', action: 1 << 20, count: 0, first: 'yes', era: 'EOR!',
    }) as unknown as Record<string, unknown>;
    expect(junk).not.toHaveProperty('name');
    expect(junk).toMatchObject({ code: 'c:0123abcd', text: null, source: null, context: null, sink: null, action: null, count: null, first: null, era: null });
  });

  it('POST /client-preworld logs a refusal as one client_refusal line', async () => {
    const c: BridgeConfig = resolveBridgeConfig([], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none' });
    c.wsPort = 0;
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    const bridge = createBridgeServer(c, { log: (level, event, fields) => { logs.push([level, event, fields ?? {}]); } });
    const port = await bridge.listen();
    try {
      const g = rig('ac1999-retail');
      g.r.clientSpew(LOCK_TEXT);
      const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/client-preworld`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
      expect((await post(g.events[0])).status).toBe(204);
      const line = logs.find((l) => l[1] === 'client_refusal')!;
      const { ip, ...fields } = line[2];
      expect(ip).toEqual(expect.any(String));
      expect(fields).toEqual(Object.fromEntries(Object.entries(g.events[0]).filter(([, v]) => v !== null)));
      // The same event id again is logged once.
      expect((await post(g.events[0])).status).toBe(204);
      expect(logs.filter((l) => l[1] === 'client_refusal')).toHaveLength(1);
      expect((await post({ outcome: 'refusal', code: 'nope' })).status).toBe(400);
    } finally {
      await bridge.shutdown();
    }
  });
});

describe('tools/watch-refusals.sh prints each new (era, code) once', () => {
  it('reads client_refusal lines, prints the new pairs, and remembers them in the state file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acjs-refusal-watch-'));
    try {
      const state = join(dir, 'seen.tsv');
      const input = join(dir, 'in.jsonl');
      const line = (o: Record<string, unknown>) => JSON.stringify({ level: 'info', event: 'client_refusal', ip: '1.2.3.4', ...o });
      writeFileSync(input, [
        line({ era: 'ac1999-retail', server: 'ac1999', source: 'client', code: 'c:0123abcd', text: LOCK_TEXT, context: 'spew', count: 1, first: true }),
        line({ era: 'ac1999-retail', server: 'ac1999', source: 'client', code: 'c:0123abcd', text: LOCK_TEXT, context: 'spew', count: 9, first: false }),
        line({ era: 'eor', server: 'levistras', source: 'server', code: 'we:0x001d', text: "You're too busy!", context: 'weenie_error', count: 1, first: true }),
        JSON.stringify({ level: 'info', event: 'client_world', era: 'eor' }),
        'not json',
      ].join('\n') + '\n');
      const run = () => execFileSync('bash', ['tools/watch-refusals.sh', state, '--input', input], { encoding: 'utf8' });
      const out1 = run();
      expect(out1.trim().split('\n')).toHaveLength(2);
      expect(out1).toContain('ac1999-retail');
      expect(out1).toContain('c:0123abcd');
      expect(out1).toContain(LOCK_TEXT);
      expect(out1).toContain('we:0x001d');
      expect(readFileSync(state, 'utf8').trim().split('\n')).toHaveLength(2);
      // Nothing new the second time.
      expect(run().trim()).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
