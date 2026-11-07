/**
 * BUG.dreamweave-per-ip-enter (2026-11-07): DreamWeave (ACE, modified) lets
 * one character into its world per source address, and every webAC player
 * reaches it from the bridge's one address. A second webAC player's enter is
 * refused with CharacterError 0x0D (EnterGameCharacterInWorld), and retail's
 * text ("One of your characters is still in the world") sent players looking
 * for a character they never had in.
 *
 * The per-address rules are a world property (CompatEntry.perIpLimits), not an
 * AC1999 special case: DreamWeave's row carries `characters: 1`, the client
 * reads a 0x0D there as another webAC player in the world, and AC1999's
 * `{ accounts: 2, sessions: 2 }` reads exactly as before.
 *
 * Drives the real modules: the bridge's compat overlay and directory rows
 * (through JSON, as GET /servers sends them), the client's world parsing,
 * loginFailureText, a real ClientConnection fed ACE's 0xF659 bytes, and
 * InWorldEnterWait wired as main.ts wires it (a real SessionLifecycle).
 * Egress config parsing and the bridge's close frame: verify-bridge-egress.ts.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { CharacterError } from '@ac/shared';
import {
  ClientConnection, type ConnectionEvent, SessionState, PacketHeaderFlags, type PacketHeaderData,
  PACKET_HEADER_SIZE, FRAGMENT_HEADER_SIZE, writePacketHeader, fragmentMessage, writeFragment, GameMessageGroup,
} from '../packages/network/src/index.js';
import {
  compatFor, SERVER_COMPAT, DREAMWEAVE_COMPAT, AC1999_PUBLIC_COMPAT,
} from '../services/ws-tcp-bridge/src/serverCompat';
import { buildDirectory } from '../services/ws-tcp-bridge/src/serverDirectory';
import type { ServerEntry } from '../services/ws-tcp-bridge/src/serverList';
import {
  worldFromEntry, perIpLimitsFrom, perIpCharacterLimit, perIpInWorldText, perIpInWorldStatus, loginFailureText,
  LOGON_FAILED_HINT, perIpLogonFailedText, perIpServerFullText, type World,
} from '../packages/renderer/src/launcher/worldDirectory';
import { firstTimeLoginRetryAllowed } from '../packages/renderer/src/session/ProvenLoginRetry';
import { InWorldEnterWait, IN_WORLD_WAIT_STATUS, otherAccountStatus } from '../packages/renderer/src/session/InWorldHolder';
import type { WorldHolder } from '../packages/renderer/src/session/AccountTabGuard';
import { SessionLifecycle, IN_WORLD_RETRY_DELAY_MS } from '../packages/renderer/src/session/SessionLifecycle';
import { characterErrorNotice, netErrorNotice } from '../packages/renderer/src/ui/ConnectionNotices';

const DW_ID = '1f069f0d-1b2a-421b-a723-297486a82cd7';
const DW_ENTRY: ServerEntry = { id: DW_ID, name: 'DreamWeave', emu: 'ACE', host: 'dreamweave.example', port: 9000, source: 'list' };
const AC1999_ENTRY: ServerEntry = { id: 'ac1999', name: 'AC1999', emu: 'AC1999', host: 'ac1999.example', port: 9110, source: 'overlay' };
const COLDEVE_ENTRY: ServerEntry = { id: 'a94b42cb-898c-4209-9246-82d21211aac1', name: 'Coldeve', emu: 'ACE', host: 'coldeve.example', port: 9000, source: 'list' };

/** The launcher's World for a bridge row, through the JSON GET /servers sends. */
function worldOf(entry: ServerEntry, egressWorlds?: Set<string>): World {
  const row = buildDirectory([entry], new Map(), new Map(), { now: 0, egressWorlds })[0];
  const w = worldFromEntry(JSON.parse(JSON.stringify(row)));
  expect(w).not.toBeNull();
  return w!;
}

describe('BUG.dreamweave-per-ip-enter — the per-address rule is a world property', () => {
  it('DreamWeave\'s compat entry: one character in the world per address, no login caps, enterable', () => {
    expect(compatFor(DW_ID, 'ACE')).toBe(DREAMWEAVE_COMPAT);
    expect(compatFor(DW_ID.toUpperCase(), 'ACE')).toBe(DREAMWEAVE_COMPAT);
    expect(SERVER_COMPAT.byId[DW_ID]).toBe(DREAMWEAVE_COMPAT);
    expect(DREAMWEAVE_COMPAT).toEqual({
      compat: 'ok', warning: 'Only one webAC player can be in this world at a time.',
      perIpLimits: { accounts: 0, sessions: 0, characters: 1 },
    });
    expect(DREAMWEAVE_COMPAT.reason).toBeUndefined();
  });

  it('its row reaches the launcher with the rule; an egress row, AC1999\'s and an ordinary world\'s are as before', () => {
    const dw = worldOf(DW_ENTRY);
    expect(dw.perIpLimits).toEqual({ accounts: 0, sessions: 0, characters: 1 });
    expect(dw.compatWarning).toBe('Only one webAC player can be in this world at a time.');
    expect(perIpCharacterLimit(dw)).toBe(1);
    // Per-session egress: the bridge applies the rule per real IP, the shared reading goes.
    const dwEgress = worldOf(DW_ENTRY, new Set([DW_ID]));
    expect(dwEgress.perIpLimits).toBeNull();
    expect(perIpCharacterLimit(dwEgress)).toBe(0);
    // AC1999 (pinned unchanged): the same two caps, no character rule, not even a `characters` key.
    const ac = worldOf(AC1999_ENTRY);
    expect(ac.perIpLimits).toEqual({ accounts: 2, sessions: 2 });
    expect(AC1999_PUBLIC_COMPAT.perIpLimits).toEqual({ accounts: 2, sessions: 2 });
    expect(perIpCharacterLimit(ac)).toBe(0);
    expect(worldOf(COLDEVE_ENTRY).perIpLimits).toBeNull();
    expect(perIpCharacterLimit(null)).toBe(0);
  });

  it('perIpLimitsFrom: characters is optional; a characters-only rule is a rule; malformed is no rule', () => {
    expect(perIpLimitsFrom({ accounts: 0, sessions: 0, characters: 1 })).toEqual({ accounts: 0, sessions: 0, characters: 1 });
    expect(perIpLimitsFrom({ accounts: 2, sessions: 2 })).toEqual({ accounts: 2, sessions: 2 });
    expect(perIpLimitsFrom({ accounts: 2, sessions: 2, characters: 0 })).toEqual({ accounts: 2, sessions: 2 });
    expect(perIpLimitsFrom({ accounts: 0, sessions: 0, characters: 0 })).toBeNull();
    expect(perIpLimitsFrom({ accounts: 0, sessions: 0 })).toBeNull();
    for (const bad of [-1, 1.5, '1', null]) {
      expect(perIpLimitsFrom({ accounts: 0, sessions: 0, characters: bad })).toBeNull();
      expect(perIpLimitsFrom({ accounts: 2, sessions: 2, characters: bad })).toEqual({ accounts: 2, sessions: 2 });
    }
  });

  it('its login refusals keep their usual reading (no account or session cap there); AC1999\'s keep the per-IP texts', () => {
    const dw = worldOf(DW_ENTRY);
    const logonFailed = netErrorNotice('ID_ConnectionError_ClientLogOnFailed');
    const full = netErrorNotice('ID_ConnectionError_ServerFull');
    expect(loginFailureText(logonFailed, dw, false)).toBe(loginFailureText(logonFailed, worldOf(COLDEVE_ENTRY), false));
    expect(loginFailureText(logonFailed, dw, false)).toContain(LOGON_FAILED_HINT);
    expect(loginFailureText(full, dw, false)).toBe(loginFailureText(full, worldOf(COLDEVE_ENTRY), false));
    const ac = worldOf(AC1999_ENTRY);
    expect(loginFailureText(logonFailed, ac, false)).toBe(`${logonFailed.text}\n\n${perIpLogonFailedText({ accounts: 2, sessions: 2 })}`);
    expect(loginFailureText(full, ac, false)).toBe(`${full.text}\n\n${perIpServerFullText({ accounts: 2, sessions: 2 })}`);
    // A character rule alone never stops a GDLE first-time retry (no account / session cap behind the refusal).
    expect(firstTimeLoginRetryAllowed({ emu: 'GDLE', registration: null, registrationUrl: null, perIpLimits: { accounts: 0, sessions: 0, characters: 1 } })).toBe(true);
  });
});

// ─── The enter ─────────────────────────────────────────

/** One server packet carrying `msg` as a single fragment. */
function packetFor(msg: Uint8Array, seq: number): Uint8Array {
  const [frag] = fragmentMessage(msg, seq, GameMessageGroup.UIQueue, seq);
  const payload = new Uint8Array(FRAGMENT_HEADER_SIZE + frag.data.length);
  writeFragment(frag, payload, 0);
  const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
  const header: PacketHeaderData = { sequence: seq, flags: PacketHeaderFlags.BlobFragments, checksum: 0, id: 0x42, time: 0, size: payload.length, iteration: 1 };
  writePacketHeader(header, buf, 0);
  buf.set(payload, PACKET_HEADER_SIZE);
  return buf;
}

/** ACE's CharacterError (0xF659) for the given code, as bytes, decoded by a real ClientConnection. */
function decodeCharacterError(code: number): ConnectionEvent[] {
  const conn = new ClientConnection('ws://test-not-connected');
  const internals = conn as unknown as { connectionData: { state: SessionState; cryptoClient: unknown }; handlePacket(p: Uint8Array): void };
  internals.connectionData.state = SessionState.AuthConnected;
  internals.connectionData.cryptoClient = {};
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(0, 0xF659, true);
  new DataView(msg.buffer).setUint32(4, code, true);
  internals.handlePacket(packetFor(msg, 2));
  return events.filter((e) => e.type === 'error');
}

/** The page around InWorldEnterWait, as main.ts wires it (charactersPerAddress = perIpCharacterLimit(launcherWorld)). */
function makeEnterPage(world: World | null, holders: WorldHolder[] = []) {
  const life = new SessionLifecycle();
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const page = {
    life, sent: 0, status: [] as (string | null)[],
    fireRetry(): number {
      const t = [...timers].reverse().find((x) => x.live);
      if (!t) return -1;
      t.live = false;
      t.fn();
      return t.ms;
    },
    enter(): void { life.noteEnterWorldRequested(0x50000002); page.sent++; },
    wait: undefined as unknown as InWorldEnterWait,
  };
  page.wait = new InWorldEnterWait({
    verdict: () => life.characterInWorldRefusal(),
    retryDelay: () => life.inWorldRetryDelay(),
    refusalCount: () => life.inWorldRefusalCount,
    enterSerial: () => life.enterSerial,
    resuming: () => life.resumingAfterDrop,
    waitingOnHolder: () => life.waitingOnHolder,
    mayRetry: () => life.mayRetryEnterWorld(),
    holderLeaving: () => life.noteHolderLeaving(),
    queryHolders: () => Promise.resolve(holders),
    requestLogout: () => false,
    sendRetry: () => { page.sent++; },
    schedule: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; },
    now: () => 0,
    setStatus: (text) => { page.status.push(text); },
    showEnteringWorld: () => {},
    confirm: () => () => {},
    charactersPerAddress: () => perIpCharacterLimit(world),
  });
  return page;
}
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
const IN_WORLD_NOTICE = (): string => characterErrorNotice(CharacterError.EnterGameCharacterInWorld).text;
const retailOf = (notice: string): string => notice.split('\n\n')[0];

/** Refuse every retry until the budget ends the enter; returns the final dialog's text. */
function spendBudget(page: ReturnType<typeof makeEnterPage>): string {
  let verdict = 'retry';
  while (verdict === 'retry') {
    expect(page.fireRetry()).toBeGreaterThan(0);
    verdict = page.wait.onRefusal();
  }
  expect(verdict).toBe('dialog');
  const notice = IN_WORLD_NOTICE();
  return page.wait.finalText(notice, retailOf(notice));
}

describe('BUG.dreamweave-per-ip-enter — a 0x0D on a one-character-per-address world', () => {
  beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); });

  it('ACE\'s 0xF659 bytes decode to the 0x0D the wait reads', () => {
    const [err] = decodeCharacterError(CharacterError.EnterGameCharacterInWorld);
    expect(err).toMatchObject({ type: 'error', characterError: 0x0D });
  });

  it('DreamWeave: the line says another webAC player is in the world; the retries go on; the final dialog says so, not "one of your characters"', async () => {
    const p = makeEnterPage(worldOf(DW_ENTRY));
    p.enter();
    expect(p.wait.onRefusal()).toBe('retry');
    await flush();
    expect(p.status).toEqual([perIpInWorldStatus(1)]);
    expect(p.status[0]).toBe('This server lets one character in per network address, and every webAC player shares ours: '
      + 'waiting for the webAC player in the world to leave…');
    expect(p.fireRetry()).toBe(IN_WORLD_RETRY_DELAY_MS);
    expect(p.sent).toBe(2);
    expect(p.wait.onRefusal()).toBe('retry');
    const text = spendBudget(p);
    expect(text).toBe(perIpInWorldText(1));
    expect(text).toBe('Another webAC player is in this world right now. This server lets one character in per network address, '
      + 'and every webAC player shares ours.\n\nTry again later, or pick another world.');
    expect(text).not.toContain(retailOf(IN_WORLD_NOTICE()));
  });

  it('the other player leaves: the next retry gets in, nothing pending', async () => {
    const p = makeEnterPage(worldOf(DW_ENTRY));
    p.enter();
    p.wait.onRefusal();
    await flush();
    expect(p.fireRetry()).toBe(IN_WORLD_RETRY_DELAY_MS);
    p.life.noteWorldEntered();
    p.wait.end();
    expect(p.fireRetry()).toBe(-1);
  });

  it('a tab of this browser in the world still wins with its own line (the more exact answer)', async () => {
    const holder: WorldHolder = { tab: 'tab-a', character: '+Partner', sameAccount: false };
    const p = makeEnterPage(worldOf(DW_ENTRY), [holder]);
    p.enter();
    p.wait.onRefusal();
    await flush();
    expect(p.status).toEqual([perIpInWorldStatus(1), otherAccountStatus(holder)]);
    const text = spendBudget(p);
    expect(text).toContain('Another tab of this browser is in the world on this server as +Partner.');
  });

  it('a resume after a drop (our own character logging out): retail\'s wait and text, as before', async () => {
    const p = makeEnterPage(worldOf(DW_ENTRY));
    p.life.noteEnterWorldRequested(0x50000002);
    p.life.noteWorldEntered();
    p.life.noteDisconnected();
    expect(p.life.nextResumeDelay()).not.toBeNull();
    p.enter();
    expect(p.wait.onRefusal()).toBe('retry');
    await flush();
    expect(p.status).toEqual([IN_WORLD_WAIT_STATUS]);
    // The resume's final word (its budget) keeps retail's notice.
    const notice = IN_WORLD_NOTICE();
    expect(p.wait.finalText(notice, retailOf(notice))).toBe(notice);
  });

  it('AC1999, an egress DreamWeave, an ordinary world and a URL login: retail\'s wait and text, unchanged', async () => {
    for (const world of [worldOf(AC1999_ENTRY), worldOf(DW_ENTRY, new Set([DW_ID])), worldOf(COLDEVE_ENTRY), null]) {
      const p = makeEnterPage(world);
      p.enter();
      p.wait.onRefusal();
      await flush();
      expect(p.status).toEqual([IN_WORLD_WAIT_STATUS]);
      expect(spendBudget(p)).toBe(IN_WORLD_NOTICE());
    }
  });

  it('a world that let more in names the number', () => {
    expect(perIpInWorldText(2)).toBe('Two other webAC players are in this world right now. This server lets two characters in per network address, '
      + 'and every webAC player shares ours.\n\nTry again later, or pick another world.');
    expect(perIpInWorldStatus(2)).toContain('waiting for a webAC player in the world to leave');
  });
});
