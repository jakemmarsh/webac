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
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  RefusalReporter, REFUSAL_ROLLUP_MS, MAX_REFUSAL_CODES, NOT_REFUSAL_CODES, isNoticeCode, refusalHash, refusalTemplate, scrubNames, weenieCode,
  REFUSAL_TEXT, NAME_FIRST_REFUSAL, isServerTextRefusal, type RefusalEvent,
} from '../packages/renderer/src/telemetry/RefusalReporter';
import { REFUSAL_VOCABULARY, isTargetPromptNotice } from '../packages/renderer/src/telemetry/RefusalTemplates';
import { BASE_REFUSAL_VOCABULARY } from '../packages/shared/src/util/RefusalTextSafety';
import { aceReferenceExists } from './_harness/reference';
import { sanitizeClientRefusal } from '../services/ws-tcp-bridge/src/clientRefusal';
import { resolveBridgeConfig, type BridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { createBridgeServer } from '../services/ws-tcp-bridge/src/server';
import { GameUI } from '../packages/renderer/src/ui/GameUI';
import { InventoryRequestTracker, InventoryRequest, weenieErrorText, weenieErrorWithStringText } from '../packages/shared/src/index';
import { gateInventoryRequestSend } from '../packages/renderer/src/inventory/InventoryRequests';
import { USE_STATUS_TEMPLATES, USE_TARGET_PROMPT_TEMPLATE, isUseStatusNotice } from '../packages/renderer/src/input/UseObject';
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

  it('skips the notices ACE sends as WeenieErrors at every login (0x51D Turbine Chat is enabled, 0x51B entered the channel); a real refusal is still reported', () => {
    const g = rig();
    g.r.serverCode('weenie_error', 0x051d, 'Turbine Chat is enabled.', 'none');
    g.r.serverCode('weenie_error_str', 0x051b, 'You have entered the _ channel.', 'chat');
    g.r.serverCode('weenie_error_str', 0x050d, ' is now the leader of this fellowship.', 'chat');
    expect(g.events).toEqual([]);
    g.r.serverCode('weenie_error', 0x001c, null, 'none');
    // The channel refusals stay refusals.
    g.r.serverCode('weenie_error', 0x0423, "You can't use that channel.", 'chat');
    expect(g.events.map((e) => e.code)).toEqual(['we:0x001c', 'we:0x0423']);
    expect(NOT_REFUSAL_CODES.weenie_error.has(0x051d)).toBe(true);
    expect(NOT_REFUSAL_CODES.weenie_error_str.has(0x051b)).toBe(true);
    // A code's set is its context's: 0x51B as a plain WeenieError is not a notice.
    expect(isNoticeCode('weenie_error', 0x051b)).toBe(false);
  });

  it('skips a use\'s own status lines (UseObject USE_STATUS_TEMPLATES), which every use posted as a refusal before 2026-10-23', () => {
    const g = rig();
    for (const t of ['Approaching Hudriffa', 'Using the Bread', 'Using the Door', 'Using the Healing Kit on Bob']) g.r.clientSpew(t);
    expect(g.events).toEqual([]);
    // The use decision posts exactly those templates; a door that won't open by hand is still a refusal.
    expect(isUseStatusNotice(USE_STATUS_TEMPLATES.approaching.replace('%s', 'Hudriffa'))).toBe(true);
    expect(isUseStatusNotice("You can't open or close this Door that way")).toBe(false);
    g.r.clientSpew("You can't open or close this Door that way");
    expect(g.events).toHaveLength(1);
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

/* ── TELEMETRY.refusal-name-safety ─────────────────────────────────────── */

describe('name safety: no character or object name ever leaves in a refusal', () => {
  const PLAYERS = ['Reemer', 'Ming Masun', 'Danath', 'Nimic', 'Nsight'];
  const noName = (events: RefusalEvent[]) => {
    const all = JSON.stringify(events);
    for (const n of PLAYERS) for (const part of n.split(' ')) expect(all).not.toContain(part);
  };

  it('the loot-consent family (production, build 1e71a1abb705) is not reported and never carries the name', () => {
    const g = rig('eor');
    for (const n of PLAYERS) {
      g.r.serverText('server_text', `${n} has given you permission to loot his or her kills.`, 0);
      g.r.serverText('server_text', `${n} does not have permission to loot your kills.`, 0);
      g.r.serverText('server_text', `You have lost permission to loot the kills of ${n}.`, 0);
      g.r.serverText('server_text', `${n} doesn't have permission to loot your corpse.`, 0);
      g.r.serverText('server_text', `${n}'s permission to loot your corpse has been revoked.`, 0);
      g.r.serverText('server_text', `You don't have permission to loot ${n}'s corpse.`, 0);
      g.r.serverText('server_text', `You don't have corpse looting permission from ${n}.`, 0);
      // Even as an error-type line or a transient, a consent notice is a notice.
      g.r.serverText('server_text', `${n} has given you permission to loot his or her kills.`, 0x1a);
      g.r.serverText('transient', `${n} does not have permission to loot your kills.`, null);
    }
    g.r.serverText('server_text', "You no longer have permission to loot anyone else's kills.", 0);
    g.r.serverText('server_text', `You have permissions to loot a corpse from these players:\n${PLAYERS.join('\n')}`, 0);
    g.r.serverText('server_text', 'You have cleared your consent list. Players will have to permit you again to allow you access to their corpse.', 0);
    g.r.serverText('server_text', "You do not have permission to loot anyone's corpse.", 0);
    expect(g.events).toEqual([]);
  });

  it('a real refusal\'s server text is still reported, its words intact', () => {
    const g = rig('eor');
    g.r.serverText('server_text', 'You do not have enough Arcane Lore to learn this spell.', 0);
    g.r.serverText('server_text', 'You do not have permission to loot that corpse!', 0);
    g.r.serverText('server_text', 'You are encumbered!', 0);
    g.r.serverText('server_text', 'You must pick that up first', 0x1a);
    g.r.serverText('server_text', 'You have solved this quest too recently!', 0);
    expect(g.events.map((e) => e.text)).toEqual([
      'You do not have enough Arcane Lore to learn this spell.',
      'You do not have permission to loot that corpse!',
      'You are encumbered!',
      'You must pick that up first',
      'You have solved this quest too recently!',
    ]);
  });

  it('a refusal led by an unknown name (one word or two) is reported with the name scrubbed, one code for all', () => {
    const g = rig('eor');
    g.r.serverText('server_text', 'Reemer is too busy to accept gifts right now.', 0);
    g.r.serverText('server_text', 'Ming Masun is too busy to accept gifts right now.', 0);
    g.r.serverText('server_text', 'Nimic is not accepting fellowship requests.', 0);
    expect(g.events.map((e) => e.text)).toEqual(['_ is too busy to accept gifts right now.', '_ is not accepting fellowship requests.']);
    g.r.flush();
    expect(g.events[2]).toMatchObject({ code: g.events[0].code, count: 1 });
    noName(g.events);
  });

  it('a name the scrub doesn\'t know, anywhere in the line, leaves as _; a speech shape or a mostly-name line sends no text', () => {
    const g = rig('eor');
    g.r.serverText('transient', 'You cannot give that to Danath while Danath is trading with Nsight.', null);
    g.r.serverText('transient', 'You tell Reemer, "meet me at the lifestone"', null);
    g.r.serverText('transient', 'Ming Masun Danath Nimic!', null);
    g.r.serverText('server_text', 'You cannot use "Nsight Blade" here.', 0);
    expect(g.events).toHaveLength(4);
    expect(g.events[0].text).toBe('You cannot give that to _ while _ is trading with _.');
    expect(g.events[1]).toMatchObject({ text: null, context: 'transient' });
    expect(g.events[2]).toMatchObject({ text: null, context: 'transient' });
    expect(g.events[3].text).toBe('You cannot use _ here.');
    for (const e of g.events) expect(e.code).toMatch(/^t:[0-9a-f]{8}$/);
    noName(g.events);
  });

  it('client spew lines are held to the same rule (an unknown object name in a client line)', () => {
    const g = rig('eor');
    g.r.clientSpew('You cannot use the Nsight Blade because you are trading it');
    g.r.clientSpew('Reemer is too busy to accept gifts right now.');
    expect(g.events.map((e) => e.text)).toEqual(['You cannot use the _ because you are trading it', '_ is too busy to accept gifts right now.']);
    noName(g.events);
  });

  it('the target-mode prompt "Choose a target for the _" is a prompt, not a refusal (both eras, the UseObject literal)', () => {
    expect(USE_TARGET_PROMPT_TEMPLATE).toBe('Choose a target for the %s');
    const g = rig('eor');
    g.r.clientSpew(USE_TARGET_PROMPT_TEMPLATE.replace('%s', 'Healing Kit'));
    g.r.serverText('transient', 'Choose a target for the Lockpick', null);
    expect(g.events).toEqual([]);
    expect(isTargetPromptNotice('Choose a target for the Mana Stone')).toBe(true);
    // The "select first" message stays a refusal.
    g.r.clientSpew('Select your target before using the Healing Kit');
    expect(g.events.map((e) => e.text)).toEqual(['Select your target before using the _']);
  });

  it('REFUSAL_TEXT is anchored: notice wording with "permission" / "too busy" / "not allowed" mid-line is not a refusal', () => {
    expect(REFUSAL_TEXT.test('Reemer has given you permission to loot his or her kills.')).toBe(false);
    expect(REFUSAL_TEXT.test('Your fellow is not allowed to see this.')).toBe(true);
    expect(isServerTextRefusal('The vendor says the shop is not allowed to open.', 0)).toBe(false);
    expect(isServerTextRefusal('Bob tells you, "you are too busy"', 0)).toBe(false);
    expect(isServerTextRefusal('Reemer is too busy to accept gifts right now.', 0)).toBe(true);
    expect(NAME_FIRST_REFUSAL.test('Ming Masun cannot be banned from the allegiance!')).toBe(true);
  });

  it('every capitalized word the page may send is one the bridge vouches for', () => {
    const extra = [...REFUSAL_VOCABULARY.exact].filter((w) => /^[A-Z]/.test(w) && !BASE_REFUSAL_VOCABULARY.exact.has(w));
    expect(extra).toEqual([]);
  });

  it('the bridge drops a text that still carries a name (an old page), keeping the code', () => {
    const old = sanitizeClientRefusal({
      outcome: 'refusal', code: 't:0123abcd', source: 'server', context: 'server_text', sink: 'chat', count: 1, first: true,
      text: 'Reemer has given you permission to loot his or her kills.',
    })!;
    expect(old).toMatchObject({ code: 't:0123abcd', context: 'server_text', text: null });
    expect(sanitizeClientRefusal({ outcome: 'refusal', code: 't:0123abcd', text: 'You tell _, hi' })!.text).toBeNull();
    expect(sanitizeClientRefusal({ outcome: 'refusal', code: 't:0123abcd', text: 'You cannot use "Blade" here.' })!.text).toBeNull();
    expect(sanitizeClientRefusal({ outcome: 'refusal', code: 't:0123abcd', text: '_ is too busy to accept gifts right now.' })!.text)
      .toBe('_ is too busy to accept gifts right now.');
    expect(sanitizeClientRefusal({ outcome: 'refusal', code: 't:0123abcd', text: 'You do not have enough Arcane Lore to learn this spell.' })!.text)
      .toBe('You do not have enough Arcane Lore to learn this spell.');
  });

  describe.skipIf(!aceReferenceExists(resolve(__dirname, '..', 'reference/ACE/Source/ACE.Server/Entity/Fellowship.cs')))(
    'every loot-consent line ACE sends is a known notice or a real refusal',
    () => {
      let lines: string[] = [];
      beforeAll(() => {
        const root = resolve(__dirname, '..', 'reference/ACE/Source/ACE.Server');
        for (const f of ['Entity/Fellowship.cs', 'WorldObjects/Player_Death.cs']) {
          const src = readFileSync(join(root, f), 'utf8');
          for (const m of src.matchAll(/GameMessageSystemChat\(\s*\$?"((?:[^"\\]|\\.)*)"/g)) {
            if (/permission|consent/i.test(m[1])) lines.push(m[1].replace(/\{[^}]*\}/g, 'Ming Masun').replace(/\\n/g, '\nReemer'));
          }
        }
        lines = [...new Set(lines)];
      });
      it('scans them, and only the refusals are reported, name-free', () => {
        expect(lines.length).toBeGreaterThan(10);
        const g = rig('eor');
        const reported: string[] = [];
        for (const l of lines) {
          const before = g.events.length;
          g.r.serverText('server_text', l, 0);
          if (g.events.length > before) reported.push(l);
        }
        // Not accepting permissions is the one refusal of the family (the other player's choice).
        expect(reported).toEqual(['Ming Masun is not accepting corpse looting permissions from other players.']);
        noName(g.events);
      });
    },
  );
});
