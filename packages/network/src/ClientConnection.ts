/**
 * ClientConnection — browser-side connection manager for the AC protocol.
 *
 * Handles the full connection lifecycle:
 *   1. Connect to bridge WebSocket
 *   2. Send LoginRequest
 *   3. Receive ConnectRequest (handshake with seeds + cookie)
 *   4. Send ConnectResponse (echo cookie)
 *   5. Receive character list and enter world
 *   6. Ongoing packet send/receive with ISAAC-encrypted checksums
 *
 * Works through the WS-TCP bridge for connecting to ACE C# servers.
 */

/** Set to true to enable verbose packet-level logging (very noisy). */
const PKT_DEBUG = false;

import { PacketHeaderFlags } from './PacketHeaderFlags.js';
import { hash32 } from './Hash32.js';
import {
  PacketHeaderData,
  PACKET_HEADER_SIZE,
  readPacketHeader,
  writePacketHeader,
  calculateHeaderChecksum,
  hasFlag,
} from './PacketHeader.js';
import {
  Fragment,
  FRAGMENT_HEADER_SIZE,
  readFragment,
  writeFragment,
  hashFragment,
  fragmentMessage,
} from './PacketFragment.js';
import { GameMessageOpcode } from './GameMessageOpcode.js';
import { GameMessageGroup } from './GameMessageGroup.js';
import { NetAuthType } from './NetAuthType.js';
import { type LoginProfile, EOR_LOGIN_PROFILE, isValidClientVersion } from './LoginProfile.js';
import { AuthFlags } from './AuthFlags.js';
import { CharacterError, characterErrorMessage } from '@ac/shared';
import {
  BinaryWriter, BinaryReader, deserializeMessage,
  buildDDDInterrogationResponse, parseCharacterCreateResponse,
  parseCharacterRestoreResponse,
  parseCreateObject, parseServerName,
  parseDDDBeginDDD, parseDDDDataMessage,
} from './MessageSerializer.js';
import { ConnectionData, SessionState, ConnectRequestData } from './ConnectionData.js';
import { OrderedPacketBuffer, MAX_SEQUENCE_WINDOW } from './OrderedPacketBuffer.js';
import { OrderedFragmentBuffer } from './OrderedFragmentBuffer.js';
import { FragmentAssembler } from './FragmentAssembler.js';
import { MAX_SERVER_PACKET_SIZE } from './PacketBuilder.js';
import { LinkStatusAverages } from './LinkStatusAverages.js';
import type { GameMessage, CharacterCreateResponseData, CharacterRestoreResponseData, CreateObjectData } from './MessageSerializer.js';

/**
 * What the bridge grants for /routines (services/ws-tcp-bridge/src/routines.ts). `local`: the bridge
 * keeps no routines (production), so the page keeps them in browser storage under this server and
 * account, both as the game server reported them; `token` is empty then.
 */
export interface RoutinesGrant { token: string; server: string; account: string; local?: true }

/** The bridge's `{"routines": …}` text answer, or null for any other text. */
/** AGENT.hosted-mcp-connector — a relay call frame from the bridge (services/ws-tcp-bridge/src/relay.ts), or null. */
export interface AgentCallFrame { id: number; method: string; args: unknown[]; deadlineMs: number }
export function parseAgentCall(text: string): AgentCallFrame | null {
  if (!text.startsWith('{"agent"')) return null;
  try {
    const a = (JSON.parse(text) as { agent?: { id?: unknown; method?: unknown; args?: unknown; deadlineMs?: unknown } }).agent;
    if (!a || typeof a.id !== 'number' || typeof a.method !== 'string') return null;
    return { id: a.id, method: a.method, args: Array.isArray(a.args) ? a.args : [], deadlineMs: typeof a.deadlineMs === 'number' ? a.deadlineMs : 30_000 };
  } catch { return null; }
}

/** AGENT.hosted-mcp-connector, step 3 — the bridge's answer to a pairing code or an unpair, or null. */
export interface PairingReply { kind: 'paired' | 'unpaired'; ok: boolean; message: string; /** unpaired: the bridge's time of the unpair (the tab's revokedBefore). */ at?: number }
export function parsePairingReply(text: string): PairingReply | null {
  if (!text.startsWith('{"paired"') && !text.startsWith('{"unpaired"')) return null;
  try {
    const j = JSON.parse(text) as { paired?: { ok?: unknown; message?: unknown; at?: unknown }; unpaired?: { ok?: unknown; message?: unknown; at?: unknown } };
    const kind = j.paired ? 'paired' : 'unpaired';
    const r = j.paired ?? j.unpaired;
    if (!r || typeof r !== 'object') return null;
    return { kind, ok: r.ok === true, message: typeof r.message === 'string' ? r.message : '', ...(typeof r.at === 'number' && Number.isFinite(r.at) ? { at: r.at } : {}) };
  } catch { return null; }
}

export function parseRoutinesGrant(text: string): { grant: RoutinesGrant | null; reason: string | null; automation: boolean } | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object' || !('routines' in j)) return null;
  const o = j as { routines: unknown; reason?: unknown; automation?: unknown; server?: unknown; account?: unknown };
  const r = o.routines;
  const reason = typeof o.reason === 'string' ? o.reason : null;
  // AGENT.automation-allowlist — the bridge allowlists this account for the automation UI.
  const automation = o.automation === true;
  if (r && typeof r === 'object' && typeof (r as RoutinesGrant).token === 'string' && typeof (r as RoutinesGrant).account === 'string' && typeof (r as RoutinesGrant).server === 'string') {
    const g = r as RoutinesGrant;
    return { grant: { token: g.token, server: g.server, account: g.account }, reason: null, automation };
  }
  if (r === null && typeof o.server === 'string' && typeof o.account === 'string' && reason === 'routines are not kept on this bridge') {
    return { grant: { token: '', server: o.server, account: o.account, local: true }, reason: null, automation };
  }
  return { grant: null, reason: reason ?? 'no grant', automation };
}

export type ConnectionEventType =
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'error'
  | 'handshakeComplete'
  | 'characterList'
  | 'serverName'
  | 'characterCreateResponse'
  // FAITHFUL.581 — ACE reuses opcode 0xF643 for both CharacterCreateResponse
  // and CharacterRestoreResponse (GameMessageOpcode.ts). Disambiguated at
  // send-time via awaitingCharacterCreateResponse (see sendMessage below):
  // an unsolicited 0xF643 (no CharacterCreate outstanding) is a restore
  // notice, not a response to us creating anything.
  | 'characterRestoreResponse'
  | 'enterWorldReady'
  | 'playerCreate'
  | 'objectCreate'
  | 'gameEvent'
  // ASSESS: one-shot dead-server signal — no packet received for 30s
  // post-handshake. Re-arms when traffic resumes.
  | 'serverTimeout'
  // ASSESS: scheduled fresh-login retry after CharacterError.Logon ("two
  // accounts logged on") — ACE holds the account until the abandoned
  // session's player logoff + cleanup completes (~10-60s), so a timed
  // retry recovers without a manual page reload.
  | 'loginRetry'
  // FAITHFUL: DDD_BeginDDD/DDD_DataMessage previously fell through to the
  // generic no-op case (see MessageSerializer.ts DDD parser comments) — now
  // parsed and dispatched so a future patching UI (or at minimum a visible
  // player-facing notice) has real data to consume instead of silence.
  | 'dddBeginDDD'
  | 'dddDataMessage'
  // BUG.daynight-phase-not-server-synced — the TimeSync optional header
  // carries the server's game clock (ACE Timers.PortalYearTicks, seconds on
  // the Derethian calendar; NetworkSession.cs sends one every 20s). Retail
  // ClientNet::HandleTimeSynch (00543d30) feeds it straight into
  // Timer::set_time, which drives GameTime::UseTime → the day/night cycle.
  // data = the float64 tick value.
  | 'timeSync'
  // AGENT.routine-store-auth — the bridge's answer to requestRoutinesGrant():
  // data = { token, server, account } | null, error = its reason when null.
  | 'routinesGrant'
  // AGENT.automation-allowlist — sent with every routines answer: data = true when the bridge
  // allowlists this account for the automation UI.
  | 'automationAccess'
  // AGENT.hosted-mcp-connector — a relay call from the bridge's /mcp (data = { id, method, args, deadlineMs }).
  | 'agentCall'
  // Step 3: the bridge's answer to a pairing code or an unpair (data = PairingReply).
  | 'agentPairing'
  | 'message';

export interface ConnectionEvent {
  type: ConnectionEventType;
  data?: unknown;
  error?: string;
  /** FAITHFUL.269 — populated on type==='reconnecting' only. */
  reconnectAttempt?: number;
  reconnectMax?: number;
  reconnectDelaySec?: number;
  /**
   * CORE.17.k.b — on type==='disconnected': whether the socket ever opened
   * (retail only raises ServerDied for a live recipient) and whether this
   * close was our own disconnect() (retail's logOffSent_ guard in
   * ClientNet::RemoveConnection @ 005453c0).
   */
  everOpened?: boolean;
  deliberate?: boolean;
  /** CORE.17.k.b — on type==='error' from a CharacterError (0xF659): the code. */
  characterError?: number;
  /** CORE.17.k.b — on a CharacterError.Logon: a timed fresh login is already scheduled. */
  loginRetryScheduled?: boolean;
  /**
   * CORE.17.k.b — on a client-side connection failure: the retail
   * ClientNet NetError token (table 0x23000010) that names it, e.g.
   * 'ID_ConnectionError_ClientTimedOutServer'.
   */
  netErrorId?: string;
}

export type ConnectionListener = (event: ConnectionEvent) => void;

/** The bridge's answer to a text "health" message (ws-tcp-bridge). */
export interface BridgeHealth {
  bridge: string; ace: string; sessions: number;
  /** A pinned bridge's server era (BRIDGE_ERA, docs/dark-majesty-support.md); absent = end of retail. */
  era?: string;
}

/** A WebSocket-shaped constructor (the browser global, or a fake under test). */
export interface HealthSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

/**
 * Probe the bridge without opening a game session: one WebSocket, the text
 * "health", the bridge's JSON status back, then close — the bridge answers
 * a text message before any UDP packet reaches ACE, so no ACE session is
 * created. Rejects on a connection error, an unparsable answer, or after
 * `timeoutMs`. The patch screen's connect meter (CORE.17.k.b.b.a.a.a) and
 * the pre-flight check at login both use it.
 */
export function probeBridgeHealth(
  url: string,
  timeoutMs = 3000,
  socketCtor: new (url: string) => HealthSocketLike = WebSocket as unknown as new (url: string) => HealthSocketLike,
): Promise<BridgeHealth> {
  return new Promise((resolve, reject) => {
    const ws = new socketCtor(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Bridge not reachable'));
    }, timeoutMs);

    ws.onopen = () => {
      ws.send('health');
    };
    ws.onmessage = (event) => {
      clearTimeout(timeout);
      try {
        const data = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
        resolve(data);
      } catch {
        reject(new Error('Invalid health response'));
      }
      ws.close();
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      // Detach first: Node's WebSocket (undici) fires 'error' again from
      // close() on a socket that never connected, which re-entered this
      // handler until the stack overflowed.
      ws.onerror = null;
      ws.close();
      reject(new Error('Bridge not reachable'));
    };
    ws.onclose = () => {
      clearTimeout(timeout);
    };
  });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class ClientConnection {
  private ws: WebSocket | null = null;
  private connectionData: ConnectionData;
  private listeners: ConnectionListener[] = [];
  private fragmentAssembler: FragmentAssembler = new FragmentAssembler();
  private url: string;
  private packetSequence: number = 1; // ACE server initializes lastReceivedPacketSequence=1, expects first C2S packet seq=2
  private fragmentSequence: number = 0;
  // FAITHFUL.581 — set when a CharacterCreate request is outstanding, so an
  // incoming 0xF643 (aliased opcode) is known to be its response rather
  // than an unsolicited CharacterRestoreResponse. Cleared once consumed.
  private awaitingCharacterCreateResponse: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 2000; // ms, doubles each attempt
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAccount: string = '';
  private lastPassword: string = '';
  autoReconnect: boolean = true;
  /** Post-handshake receiver service tick (ACK/NAK, fragment unstick, dead-server). */
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  // ── Receive-sequence tracking (NET.ack-only-seq-marks-lost-received) ──
  // ONE authority: orderedBuffer (below). A server packet counts as received
  // only once orderedBuffer keeps it; the ACK value is its lastSequence and
  // the NAK list is its missingSequences. Retail keeps the same split —
  // SharedNet::ProcessNewestSeqNum @ 00541930 tracks highestIDReceived_ and
  // puts every skipped id in m_SeqIDsWeNAKed.
  //
  // announcedServerSeq: the highest sequence the server says it has SENT.
  // ACE FlushPackets (NetworkSession.cs) stamps ACK-only and NAK packets with
  // PacketSequence.CurrentValue — the seq of its last real packet — so such a
  // packet is never itself "received", but it proves every seq up to it was
  // sent. Retail does exactly this: for a cleartext packet (header_ & 2 == 0)
  // ProcessNewestSeqNum NAKs through seqID INCLUSIVE, for an encrypted one
  // only up to seqID-1.
  private announcedServerSeq: number = 0;

  // Sent packet cache for server-requested retransmit
  private sentPacketCache: Map<number, Uint8Array> = new Map();

  /** Shared ACK/NAK send stamp — retail ReceiverData::timeStamp_ is shared by
   *  SharedNet::EnqueuePak @ 00543b10 and SharedNet::EnqueueNaks @ 00543bd0. */
  private lastAckNakSentAt: number = 0;
  /** Retail ClientNet::ProcessConnection @ 00545450: while ids are NAKed,
   *  EnqueueNaks; otherwise EnqueuePak. NAKs go at most every 0.6 s
   *  (EnqueueNaks: cur_time - timeStamp_ > 0.6)… */
  private static readonly NAK_MIN_INTERVAL_MS = 600;
  /** …and PAKs (AckSequence) every 2.0 s (EnqueuePak: >= 2.0). */
  private static readonly ACK_INTERVAL_MS = 2000;
  /** ReceiverData::GetNaks @ 005490c0 caps one NAK at 0x72 ids. */
  private static readonly MAX_NAK_IDS = 114;
  // No time limit on NAKing a missing sequence: retail keeps it in
  // m_SeqIDsWeNAKed until it arrives or the server's EmptyAck
  // (RejectRetransmit, SharedNet::HandleEmptyAck @ 005448f0) drops it, and
  // ACE answers every NAK with one or the other (NetworkSession.cs
  // Retransmit → PacketRejectRetransmit for anything no longer cached). A
  // link that answers nothing ends in the 140 s dead-server drop below.
  /** How often the receiver service runs (retail runs it every frame). */
  private static readonly SERVICE_INTERVAL_MS = 100;
  /**
   * RELEASE.gdle-30s-idle-drop — ClientFlowQueue::IncrementLocalInterval
   * @ 00547f10 queues a CTimeSyncHeader + CEchoRequestHeader every 6 local
   * intervals (~3 s); both are TimeSensitive|ShouldPiggyBack (m_Flags 0x18),
   * so they ride a sequenced, ISAAC-checksummed packet. GDLE only counts a
   * session alive on an in-order sequenced packet (PacketController.cpp
   * ThinkInbound: lastactivity) and drops it after 30 s without one; our
   * cleartext ACKs (sequence 0) never reset it.
   */
  static readonly FLOW_KEEPALIVE_INTERVAL_MS = 3000;
  private lastFlowKeepaliveAt = 0;
  /** Origin of the EchoRequest client clock (seconds since the session's handshake). */
  private echoEpochMs = 0;
  /** The fragment-order gate may legitimately wait only for the rest of an
   *  ACE bundle, which is flushed in one FlushPackets burst. Held messages
   *  with no gate progress for this long, while no packet is missing, can
   *  only be waiting on a message that rode a lost packet. */
  private static readonly FRAGMENT_STALL_MS = 2000;
  private fragmentGateSeenSeq: number = -1;
  private fragmentGateProgressAt: number = 0;

  // ASSESS: ordered+deduped packet processing — mirrors ACE's reordering stage
  // (ACE.Server/Network/NetworkSession.cs ~336-397) so out-of-order/duplicate
  // UDP delivery on a real network can't reorder or double-apply messages.
  private orderedBuffer = new OrderedPacketBuffer<{ header: PacketHeaderData; data: Uint8Array }>();

  // BUG.fragment-sequence-not-reordered — a second, inner ordering stream
  // nested inside the packet-sequence one above: ACE gates dispatch of a
  // reassembled fragment message on its own fragment-sequence counter (see
  // OrderedFragmentBuffer.ts), independent of packet-sequence order.
  private orderedFragments = new OrderedFragmentBuffer<Uint8Array>();

  // ASSESS: partial multi-fragment messages older than this are permanently lost
  // (a lost last piece the server could not resend) — evict on the service tick.
  private static readonly STALE_FRAGMENT_MS = 30_000;

  // ASSESS: pre-handshake sendMessage calls are queued until ISAAC is keyed.
  // ACE drops any EncryptedChecksum-flagged packet whose checksum doesn't
  // match an ISAAC key (ClientPacket.cs VerifyCRC ~136-147), and the burned
  // sequence number then wedges the session in an endless NAK loop.
  private preHandshakeQueue: Array<{ bytes: Uint8Array; queue: GameMessageGroup }> = [];
  private static readonly PRE_HANDSHAKE_QUEUE_MAX = 64;

  // ASSESS: dead-server detection — one-shot 'serverTimeout' event when no
  // packet has arrived for SERVER_TIMEOUT_MS post-handshake (checked on the
  // receiver service tick); re-arms when traffic resumes.
  private static readonly SERVER_TIMEOUT_MS = 30_000;
  private lastPacketReceivedAt: number = 0;
  /** Retail ClientNet::m_LinkStatusAverages — the packet counters behind the
   *  Link Status panel's packet-loss line (LinkStatusAverages.ts). */
  private linkStatusAverages = new LinkStatusAverages();
  private serverTimeoutEmitted: boolean = false;
  /** NET.duplicate-connectrequest-rekeys — retail ClientNet::ProcessConnection
   *  @ 00545450 drops the connection once 140.0 s pass without data from the
   *  server (ending in RemoveConnection → ECM_Login::SendNotice_ServerDied);
   *  it skips the check when its own clock stalled that long. */
  private static readonly SERVER_DEAD_MS = 140_000;
  private lastServiceAt: number = 0;
  /** The socket whose end was already reported with 'disconnected' (so the
   *  later onclose of a socket we closed ourselves doesn't report it twice). */
  private sessionEndedFor: unknown = null;

  // ConnectResponse retry timer — ACE sets session state AFTER sending ConnectRequest,
  // so on localhost the ConnectResponse can arrive before ACE is ready. Retry until we
  // get a response (character list) from the world port.
  private connectResponseRetryTimer: ReturnType<typeof setInterval> | null = null;
  private connectResponsePayload: Uint8Array | null = null;
  private static readonly CONNECT_RESPONSE_RETRY_INTERVAL = 500; // ms
  private static readonly CONNECT_RESPONSE_MAX_RETRIES = 20; // 10 seconds total
  private connectResponseRetryCount: number = 0;

  // LoginRequest retry — if ACE rejects login because old session still exists,
  // retry until the old session times out or gets booted.
  private loginRetryTimer: ReturnType<typeof setInterval> | null = null;
  private loginRetryCount: number = 0;
  private static readonly LOGIN_RETRY_INTERVAL = 5000; // 5 seconds
  private static readonly LOGIN_MAX_RETRIES = 4;


  /** DAT iteration counts for DDD_InterrogationResponse (must match server's DATs). */
  datIterations: { portal: number; cell: number; language: number } = { portal: 0, cell: 0, language: 0 };

  private wsEverOpened: boolean = false;
  /** CORE.17.k.b — set by disconnect() before closing so the onclose event reports deliberate:true. */
  private deliberateClose: boolean = false;

  /**
   * The server's LoginRequest expectations (LoginProfile.ts): version string
   * and credential encoding. End of retail unless a classic-era world sets it.
   */
  loginProfile: LoginProfile = EOR_LOGIN_PROFILE;

  constructor(url: string = 'ws://localhost:9090', opts: { loginProfile?: LoginProfile } = {}) {
    this.url = url;
    this.connectionData = new ConnectionData();
    if (opts.loginProfile) this.loginProfile = opts.loginProfile;
  }

  /** The bridge URL the next connect() opens. */
  get bridgeUrl(): string { return this.url; }

  /**
   * RELEASE.launcher-screen — point the next connect() at another bridge URL
   * (a different `?server=<id>` world, or a custom bridge). Takes effect on
   * the next connect; call disconnect() first to leave the current world.
   */
  setUrl(url: string): void {
    this.url = url;
  }

  /**
   * Check bridge and ACE server health via the bridge's text health endpoint.
   * Returns { bridge, ace, sessions } or throws if bridge is unreachable.
   * Console-only diagnostics — never surfaces to in-game chat.
   */
  async checkHealth(): Promise<BridgeHealth> {
    return probeBridgeHealth(this.url);
  }

  get state(): SessionState {
    return this.connectionData.state;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * CORE.17.k — the retail LinkStatusHolder::GetConnectionStatus sample:
   * whether the session is attached to a server (LinkStatus_Connected ≈ the
   * auth handshake completed on an open socket) and the seconds since the
   * last packet arrived from it. Drives the HUD Link Indicator's 4-state
   * model (LinkStatusModel.ts); retail never reports link trouble in chat.
   */
  getLinkStatus(now: number = Date.now()): { connected: boolean; secondsSinceLastPacket: number } {
    const connected = this.isConnected && this.connectionData.state >= SessionState.AuthConnected;
    return {
      connected,
      secondsSinceLastPacket: connected ? Math.max(0, (now - this.lastPacketReceivedAt) / 1000) : 0,
    };
  }

  /**
   * Retail LinkStatusHolder::GetPacketLossPercentage @ 00411370 — the
   * doubled (NAKed + retransmitted) / (received + sent) ratio over the last
   * 40 two-second heartbeats (LinkStatusAverages.ts). Shown by the Link
   * Status panel.
   */
  getPacketLossPercentage(): number {
    return this.linkStatusAverages.getPacketLossPercentage();
  }

  /**
   * Register an event listener.
   */
  on(listener: ConnectionListener): void {
    this.listeners.push(listener);
  }

  /**
   * Remove an event listener.
   */
  off(listener: ConnectionListener): void {
    this.listeners = this.listeners.filter(l => l !== listener);
  }

  /** Bridge text frames (not game packets): the routines grant, relay calls. */
  private handleBridgeText(text: string): void {
    const grant = parseRoutinesGrant(text);
    if (grant) {
      this.emit({ type: 'routinesGrant', data: grant.grant, error: grant.reason ?? undefined });
      this.emit({ type: 'automationAccess', data: grant.automation });
      return;
    }
    const call = parseAgentCall(text);
    if (call) { this.emit({ type: 'agentCall', data: call }); return; }
    const pairing = parsePairingReply(text);
    if (pairing) this.emit({ type: 'agentPairing', data: pairing });
  }

  /** AGENT.hosted-mcp-connector — a text frame to the bridge (a relay answer or the tab's relay state). */
  sendBridgeText(text: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
  }

  private emit(event: ConnectionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error(`[AC:EMIT] Listener error for ${event.type}:`, err);
      }
    }
  }

  /**
   * Connect to the server and begin the login sequence.
   */
  connect(account: string, password: string): void {
    this.lastAccount = account;
    this.lastPassword = password;
    this.reconnectAttempts = 0;
    this.doConnect(account, password);
  }

  /** Max timed login retries after a "two accounts" rejection (~2 min). */
  private static readonly MAX_LOGIN_REJECT_RETRIES = 12;
  private loginRejectRetryAttempts = 0;
  /**
   * This socket's login succeeded (a CharacterList arrived). A Logon error
   * after that is not a refused login but ACE booting this session because
   * the account logged in elsewhere (account_login_boots_in_use): never
   * retried, or two pages take turns booting each other (2026-10-10).
   */
  private sessionPastLogin = false;
  private loginRejectRetryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * ASSESS: after CharacterError.Logon, ACE frees the account once the
   * abandoned session's player logoff finishes — retry a full fresh login
   * every 10s until it succeeds or the budget runs out.
   */
  private scheduleLoginRetryAfterReject(): boolean {
    // NB: deliberately NOT gated on autoReconnect — the app disables
    // autoReconnect at startup to avoid cascading duplicate sessions, but
    // the stale-session login retry is the initial-login recovery path and
    // must still run. disconnect() clears loginRejectRetryTimer explicitly.
    if (this.loginRejectRetryTimer) return true;
    if (this.loginRejectRetryAttempts >= ClientConnection.MAX_LOGIN_REJECT_RETRIES) {
      console.warn('[AC:NET] Giving up on stale-session login retries — reload the page to try again.');
      return false;
    }
    this.loginRejectRetryAttempts++;
    this.emit({
      type: 'loginRetry',
      reconnectAttempt: this.loginRejectRetryAttempts,
      reconnectMax: ClientConnection.MAX_LOGIN_REJECT_RETRIES,
      reconnectDelaySec: 10,
    });
    this.loginRejectRetryTimer = setTimeout(() => {
      this.loginRejectRetryTimer = null;
      this.doConnect(this.lastAccount, this.lastPassword);
    }, 10_000);
    return true;
  }

  private doConnect(account: string, password: string): void {
    // ASSESS: never leak a previous socket — orphaned sockets kept logging
    // in concurrently (the "two accounts" wedge) and double-processed packets.
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.onopen = null;
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      try { old.close(); } catch { /* already closing */ }
    }

    // Reset protocol state for new connection
    this.stopLoginRetry();
    this.stopConnectResponseRetry();
    this.resetSequencingState();
    this.preHandshakeQueue = [];
    this.sessionPastLogin = false;
    this.lastPacketReceivedAt = Date.now();
    this.serverTimeoutEmitted = false;
    this.linkStatusAverages = new LinkStatusAverages();
    this.connectionData = new ConnectionData();

    this.wsEverOpened = false;
    this.deliberateClose = false;
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.wsEverOpened = true;
      this.reconnectAttempts = 0;
      this.emit({ type: 'connected' });
      this.sendLoginRequest(account, password);
      this.startLoginRetry(account, password);
    };

    this.ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') { this.handleBridgeText(event.data); return; }
      const data = new Uint8Array(event.data as ArrayBuffer);
      try {
        this.handlePacket(data);
      } catch (err) {
        console.error('[AC:PKT] EXCEPTION in handlePacket:', err, 'packet len=', data.length, 'hex=', Array.from(data.slice(0, 40)).map(b => b.toString(16).padStart(2, '0')).join(' '));
      }
    };

    const socket = this.ws;
    this.ws.onclose = () => this.handleSocketEnded(socket);

    this.ws.onerror = () => {
      if (!this.wsEverOpened) {
        console.warn(`[AC:NET] Bridge not reachable at ${this.url} — start: npx tsx services/ws-tcp-bridge/src/bridge.ts`);
        // CORE.17.k.b — the browser client's local socket layer could not be
        // opened: retail ClientNet::InitAddresses' ID_NetError_CantSocket.
        this.emit({ type: 'error', error: 'WebSocket error', netErrorId: 'ID_NetError_CantSocket' });
        return;
      }
      this.emit({ type: 'error', error: 'WebSocket error' });
    };
  }

  /** Reset every send/receive sequence counter and buffer (new session). */
  private resetSequencingState(): void {
    this.packetSequence = 1; // ACE expects first C2S fragment packet to be seq=2
    this.fragmentSequence = 0;
    this.sentPacketCache.clear();
    this.fragmentAssembler.reset();
    this.orderedBuffer.reset();
    this.orderedFragments.reset();
    this.announcedServerSeq = 0;
    this.lastAckNakSentAt = 0;
    this.fragmentGateSeenSeq = -1;
    this.fragmentGateProgressAt = Date.now();
  }

  /**
   * Report the end of a socket's session exactly once: its own onclose, a
   * server Disconnect, and the dead-server timeout all funnel here, so a
   * session we end ourselves doesn't emit 'disconnected' again when the
   * socket's onclose fires afterwards.
   */
  private handleSocketEnded(socket: unknown): void {
    if (this.sessionEndedFor === socket) return;
    this.sessionEndedFor = socket;
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    this.stopConnectResponseRetry();
    this.stopLoginRetry();
    this.emit({ type: 'disconnected', everOpened: this.wsEverOpened, deliberate: this.deliberateClose });
    if (this.ws === socket) this.ws = null;
    this.attemptReconnect();
  }

  /** The server ended (or abandoned) the session: close our socket and report it once. */
  private endSessionFromServer(): void {
    const socket = this.ws;
    if (!socket) return;
    this.handleSocketEnded(socket);
    try { socket.close(); } catch { /* already closing */ }
  }

  /** Attempt auto-reconnect with exponential backoff. */
  private attemptReconnect(): void {
    if (!this.autoReconnect) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit({ type: 'error', error: 'Max reconnection attempts reached', netErrorId: 'ID_ConnectionError_ClientTimedOutServer' });
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;
    // FAITHFUL.269 — auto-reconnect is recovery, not an error. Emit a
    // structured 'reconnecting' event so the renderer can color it as a
    // benign System message rather than a red ACE-error chat line.
    this.emit({
      type: 'reconnecting',
      reconnectAttempt: this.reconnectAttempts,
      reconnectMax: this.maxReconnectAttempts,
      reconnectDelaySec: Math.round(delay / 1000),
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect(this.lastAccount, this.lastPassword);
    }, delay);
  }

  /** Start LoginRequest retry timer — retries if no ConnectRequest received. */
  private startLoginRetry(account: string, password: string): void {
    this.loginRetryCount = 0;
    this.stopLoginRetry();
    this.loginRetryTimer = setInterval(() => {
      if (this.connectionData.state !== SessionState.AuthLoginRequest) {
        this.stopLoginRetry(); // Got past login phase, stop retrying
        return;
      }
      this.loginRetryCount++;
      if (this.loginRetryCount > ClientConnection.LOGIN_MAX_RETRIES) {
        this.stopLoginRetry();
        console.warn('[AC:NET] ACE server not responding — bridge connected but no reply to LoginRequest after ' +
          `${ClientConnection.LOGIN_MAX_RETRIES} attempts. Check: docker ps | grep ace-server`);
        // CORE.17.k.b — retail ClientNet::LogonUseTime @ 00544a10 ends the
        // logon with ID_ConnectionError_ClientTimedOutServer once its login
        // request budget is spent.
        this.emit({ type: 'error', error: 'Login timed out', netErrorId: 'ID_ConnectionError_ClientTimedOutServer' });
        return;
      }
      console.log(`[AC:NET] No ConnectRequest received, retrying LoginRequest (${this.loginRetryCount}/${ClientConnection.LOGIN_MAX_RETRIES})`);
      this.sendLoginRequest(this.lastAccount, this.lastPassword);
    }, ClientConnection.LOGIN_RETRY_INTERVAL);
  }

  /** Stop the LoginRequest retry timer. */
  private stopLoginRetry(): void {
    if (this.loginRetryTimer) {
      clearInterval(this.loginRetryTimer);
      this.loginRetryTimer = null;
    }
  }

  /** Stop the ConnectResponse retry timer (called when handshake succeeds). */
  private stopConnectResponseRetry(): void {
    if (this.connectResponseRetryTimer) {
      clearInterval(this.connectResponseRetryTimer);
      this.connectResponseRetryTimer = null;
    }
    this.connectResponsePayload = null;
  }

  /**
   * Send a CharacterLogOff game message (0xF653) so the ACE server
   * immediately frees the character session. Without this, the server
   * waits ~60s for the session to time out, blocking re-login.
   */
  /**
   * AGENT.routine-store-auth — ask the bridge for this account's /routines
   * token (it answers once the server's CharacterList has passed): a
   * 'routinesGrant' event follows.
   */
  requestRoutinesGrant(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send('routines');
    else this.emit({ type: 'routinesGrant', data: null, error: 'not connected' });
  }

  sendCharacterLogOff(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, 0xF653, true); // CharacterLogOff opcode
    this.sendMessage(buf);
  }

  disconnect(): void {
    this.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.loginRejectRetryTimer) {
      clearTimeout(this.loginRejectRetryTimer);
      this.loginRejectRetryTimer = null;
    }
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.stopLoginRetry();
    this.stopConnectResponseRetry();
    if (this.ws) {
      this.deliberateClose = true;
      // Send CharacterLogOff so ACE frees the session immediately
      this.sendCharacterLogOff();
      // Send disconnect packet
      this.sendPacket(PacketHeaderFlags.Disconnect, new Uint8Array(0));
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Send an ACK (AckSequence) for the last server sequence received in
   * order. Retail SharedNet::EnqueuePak @ 00543b10 sends highestIDReceived_,
   * but only while nothing is NAKed — i.e. when every sequence up to it has
   * arrived — which is exactly orderedBuffer.lastSequence here. ACKing past a
   * hole would let ACE prune the missing packet from its retransmit cache
   * (NetworkSession AcknowledgeSequence).
   */
  private sendAck(now: number = Date.now()): void {
    const acked = this.orderedBuffer.lastSequence;
    if (acked <= 0) return;
    PKT_DEBUG && console.log(`[AC:PKT] Sending ACK for server seq ${acked}`);
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint32(0, acked, true);
    this.sendPacket(PacketHeaderFlags.AckSequence, payload);
    this.lastAckNakSentAt = now;
  }

  /** Send a RequestRetransmit (NAK) for missing server packet sequences. */
  private sendRequestRetransmit(missingSeqs: number[], now: number = Date.now()): void {
    if (missingSeqs.length === 0) return;
    const payload = new Uint8Array(4 + missingSeqs.length * 4);
    const view = new DataView(payload.buffer);
    view.setUint32(0, missingSeqs.length, true);
    for (let i = 0; i < missingSeqs.length; i++) {
      view.setUint32(4 + i * 4, missingSeqs[i], true);
    }
    PKT_DEBUG && console.log(`[AC:PKT] Requesting retransmit of server seqs: ${missingSeqs.join(', ')}`);
    this.sendPacket(PacketHeaderFlags.RequestRetransmit, payload);
    this.lastAckNakSentAt = now;
  }

  /**
   * A server packet stamped with ACE's CurrentValue (ACK-only or cleartext
   * NAK — FlushPackets) proves the server has sent every sequence up to
   * `seq`; it is NOT itself a received packet. Garbage beyond the reorder
   * window is ignored.
   */
  private noteServerAnnouncedSeq(seq: number): void {
    if (seq <= this.announcedServerSeq) return;
    if (seq - this.orderedBuffer.lastSequence > MAX_SEQUENCE_WINDOW) return;
    this.announcedServerSeq = seq;
  }

  /**
   * The server sequences still missing (never kept by orderedBuffer), oldest
   * first, capped at one NAK's worth (ReceiverData::GetNaks @ 005490c0).
   */
  private collectMissingServerSeqs(): number[] {
    const top = Math.max(this.orderedBuffer.highestBufferedSequence ?? 0, this.announcedServerSeq);
    if (top <= this.orderedBuffer.lastSequence) return [];
    return this.orderedBuffer.missingSequences(top, ClientConnection.MAX_NAK_IDS);
  }

  /**
   * NAK every missing server sequence now, rate-limited like retail
   * SharedNet::EnqueueNaks @ 00543bd0 (0.6 s). Called the moment a gap is
   * seen (retail ProcessNewestSeqNum adds the ids to m_SeqIDsWeNAKed and the
   * same frame's ProcessConnection sends them) and from the service tick.
   * Returns false if nothing is missing.
   */
  private requestMissingServerSeqs(now: number = Date.now()): boolean {
    const missing = this.collectMissingServerSeqs();
    if (missing.length === 0) return false;
    if (now - this.lastAckNakSentAt > ClientConnection.NAK_MIN_INTERVAL_MS) {
      this.sendRequestRetransmit(missing, now);
    }
    return true;
  }

  /** Start the post-handshake receiver service (ACK/NAK cadence, etc.). */
  private startKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    // Send first ACK immediately
    this.sendAck();
    this.lastServiceAt = Date.now();
    this.lastFlowKeepaliveAt = this.lastServiceAt;
    this.echoEpochMs = performance.now();
    this.keepaliveTimer = setInterval(() => {
      if (this.isConnected) this.serviceReceiver();
    }, ClientConnection.SERVICE_INTERVAL_MS);
  }

  /**
   * One receiver service pass — retail ClientNet::ProcessConnection
   * @ 00545450 (cs_Connected): NAK while anything is missing, otherwise ACK
   * every 2 s; plus the fragment-gate unstick and dead-server checks.
   */
  private serviceReceiver(now: number = Date.now()): void {
    const clockStalled = now - this.lastServiceAt > ClientConnection.SERVER_DEAD_MS;
    this.lastServiceAt = now;

    const anyMissing = this.requestMissingServerSeqs(now);
    if (!anyMissing && now - this.lastAckNakSentAt >= ClientConnection.ACK_INTERVAL_MS) {
      this.sendAck(now);
    }
    if (now - this.lastFlowKeepaliveAt >= ClientConnection.FLOW_KEEPALIVE_INTERVAL_MS) {
      this.lastFlowKeepaliveAt = now;
      this.sendFlowKeepalive();
    }

    // Partial messages that will never complete: tell the fragment gate.
    for (const seq of this.fragmentAssembler.evictStale(ClientConnection.STALE_FRAGMENT_MS, now)) {
      console.warn(`[AC:FRAG] Evicting stale partial message fragSeq=${seq} (incomplete after ${ClientConnection.STALE_FRAGMENT_MS / 1000}s)`);
      for (const ready of this.orderedFragments.skip(seq)) this.processMessage(ready);
    }
    this.checkFragmentGateStall(now, anyMissing);

    this.checkServerTimeout(now);
    if (!clockStalled) this.checkServerDead(now);

    // ClientNet::ProcessConnection (cs_Connected): the 2 s link-status
    // heartbeat → CLinkStatusAverages::AddSnapshot + LinkStatusHolder::OnHeartbeat.
    this.linkStatusAverages.heartbeat(now);
  }

  /**
   * NET.giveup-evict-no-fragment-unstick — a message whose packet was lost
   * for good leaves its fragment sequence missing forever, holding every
   * later message behind it. Once no packet is missing and the gate has made
   * no progress for FRAGMENT_STALL_MS, skip to the lowest held message.
   */
  private checkFragmentGateStall(now: number, packetsMissing: boolean): void {
    const gate = this.orderedFragments.lastSequence;
    if (gate !== this.fragmentGateSeenSeq || this.orderedFragments.bufferedCount === 0 || packetsMissing) {
      this.fragmentGateSeenSeq = gate;
      this.fragmentGateProgressAt = now;
      return;
    }
    if (now - this.fragmentGateProgressAt < ClientConnection.FRAGMENT_STALL_MS) return;
    this.unstickFragmentGate();
    this.fragmentGateSeenSeq = this.orderedFragments.lastSequence;
    this.fragmentGateProgressAt = now;
  }

  /** Skip the fragment gate to its lowest held message, dropping partials it passes. */
  private unstickFragmentGate(): void {
    const stuckAt = this.orderedFragments.lowestBufferedSequence;
    if (stuckAt === null) return;
    console.warn(`[AC:FRAG] Fragment sequence(s) ${this.orderedFragments.lastSequence + 1}..${stuckAt - 1} lost with their packet — skipping ahead`);
    const ready = this.orderedFragments.acceptGap(stuckAt);
    this.fragmentAssembler.discardThrough(this.orderedFragments.lastSequence);
    for (const msg of ready) this.processMessage(msg);
  }

  /** Emit a one-shot 'serverTimeout' if no packet has arrived for 30s post-handshake. */
  private checkServerTimeout(now: number = Date.now()): void {
    if (this.connectionData.state < SessionState.AuthConnected) return;
    if (this.serverTimeoutEmitted) return;
    if (now - this.lastPacketReceivedAt > ClientConnection.SERVER_TIMEOUT_MS) {
      this.serverTimeoutEmitted = true;
      console.warn(`[AC:NET] No packet from server for ${ClientConnection.SERVER_TIMEOUT_MS / 1000}s — server may be down`);
      this.emit({ type: 'serverTimeout' });
    }
  }

  /**
   * End the session once the server has been silent for SERVER_DEAD_MS —
   * retail's dead-connection drop (ClientNet::ProcessConnection @ 00545450,
   * 140.0 s → RemoveConnection → SendNotice_ServerDied). Reported as a
   * non-deliberate 'disconnected' so the renderer raises ServerDied.
   */
  private checkServerDead(now: number = Date.now()): void {
    if (this.connectionData.state < SessionState.AuthConnected) return;
    if (now - this.lastPacketReceivedAt <= ClientConnection.SERVER_DEAD_MS) return;
    console.warn(`[AC:NET] No packet from server for ${ClientConnection.SERVER_DEAD_MS / 1000}s — ending the session`);
    this.endSessionFromServer();
  }

  /**
   * Send a game message through the connection.
   *
   * Pre-handshake calls are queued and flushed once the handshake completes:
   * fragment packets carry the EncryptedChecksum flag, and ACE's VerifyCRC
   * (ClientPacket.cs ~136-147) only accepts those when the checksum matches an
   * ISAAC key — which we can't compute until the ConnectRequest seeds arrive.
   * Sending early burns a sequence number on a packet the server drops,
   * wedging the session in an endless NAK loop.
   */
  sendMessage(messageBytes: Uint8Array, queue: GameMessageGroup = GameMessageGroup.WeenieQueue): void {
    if (this.connectionData.state < SessionState.AuthConnected || !this.connectionData.cryptoClient) {
      if (this.preHandshakeQueue.length >= ClientConnection.PRE_HANDSHAKE_QUEUE_MAX) {
        console.warn('[AC:NET] Pre-handshake send queue full — dropping message');
        return;
      }
      console.warn('[AC:NET] sendMessage before handshake — queueing until ISAAC is keyed');
      this.preHandshakeQueue.push({ bytes: messageBytes, queue });
      return;
    }
    // Log outgoing message opcode and first 64 bytes for debugging (PKT_DEBUG
    // only — a per-message hex dump is real overhead at movement rates).
    if (messageBytes.length >= 4) {
      const opcode = new DataView(messageBytes.buffer, messageBytes.byteOffset).getUint32(0, true);
      PKT_DEBUG && console.log(`[AC:MSG] sendMessage opcode=0x${opcode.toString(16)} totalLen=${messageBytes.length} hex=${Array.from(messageBytes.slice(0, Math.min(64, messageBytes.length))).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
      // FAITHFUL.581 — mark the aliased 0xF643 response as a create-response
      // until it arrives; see the CharacterCreateResponse case below.
      if (opcode === GameMessageOpcode.CharacterCreate) {
        this.awaitingCharacterCreateResponse = true;
      }
    }
    const fragId = ++this.fragmentSequence;
    const fragments = fragmentMessage(messageBytes, fragId, queue, fragId);
    this.sendFragmentPacket(fragments);
  }

  // ─── Internal Packet Handling ──────────────────────

  private sendLoginRequest(account: string, password: string): void {
    const profile = this.loginProfile;
    const version = isValidClientVersion(profile.clientVersion) ? profile.clientVersion : EOR_LOGIN_PROFILE.clientVersion;
    if (profile.authStyle === 'account-colon-password') {
      this.sendAccountColonPasswordLogin(version, account, password);
      return;
    }
    // ACE LoginRequest format (from PacketInboundLoginRequest.cs):
    //   1. ClientVersion (String16L) — "1802" (the login profile's literal)
    //   2. DataLength (uint32) — remaining payload bytes
    //   3. NetAuthType (uint32) — 0x00000002 = AccountPassword
    //   4. AuthFlags (uint32) — 0
    //   5. Timestamp (uint32) — 0
    //   6. Account (String16L)
    //   7. AccountToLoginAs (String16L) — EMPTY. Retail never sets it
    //      (NetAuthenticator ctor @ 005407f0 leaves m_AccountToLogonAs the
    //      null buffer; it is an admin-only "log on as" field, ACE comment
    //      "special admin only, AuthFlags has 2"). GDLE parses this slot as a
    //      fixed uint32 (Network.cpp AuthenticateUserQuery, auth type 2), so
    //      a non-empty string shifts the password read and auto-creates the
    //      account with a garbage password.
    //   8. Password (String32L) — packed word encoding

    const encoder = new TextEncoder();
    const acctBytes = encoder.encode(account);
    const passBytes = encoder.encode(password);

    const writer = new BinaryWriter(256);

    // 1. ClientVersion (String16L with 4-byte alignment)
    writer.writeString16(version);

    // Calculate DataLength: everything after this field
    const acctAlign = Math.ceil((2 + acctBytes.length) / 4) * 4;
    const loginAsAlign = 4; // empty String16L: u16 length 0 + 2 pad bytes
    const passDataLen = 1 + passBytes.length; // packed word + string
    // At least one zero byte follows the password (see the padding below).
    const passAlign = Math.floor((4 + passDataLen) / 4) * 4 + 4;
    const dataLength = 4 + 4 + 4 + acctAlign + loginAsAlign + passAlign;

    // 2. DataLength
    writer.writeUInt32(dataLength);

    // 3. NetAuthType = AccountPassword
    writer.writeUInt32(NetAuthType.AccountPassword);

    // 4. AuthFlags = None
    writer.writeUInt32(AuthFlags.None);

    // 5. Timestamp = 0
    writer.writeUInt32(0);

    // 6. Account (String16L)
    writer.writeString16(account);

    // 7. AccountToLoginAs (String16L) — empty, as retail sends it
    writer.writeString16('');

    // 8. Password (String32L): 4-byte data length + packed word byte + string bytes
    const passLen = 1 + passBytes.length; // packed word prefix byte + string
    writer.writeUInt32(passLen);
    writer.writeUInt8(passBytes.length); // packed word: string length (for <= 255 chars)
    writer.writeBytes(passBytes);
    // Pad to the next 4-byte boundary, always with at least one zero byte.
    // GDLE copies the password into a std::string from the bare char*
    // (Network.cpp AuthenticateUserQuery: m_password = login_credentials),
    // so it reads up to the first NUL: a password whose 4-byte prefix + packed
    // length + chars ended exactly on a boundary (e.g. 7 characters) picked
    // up whatever its reused receive buffer held next, and every login but
    // the first after a GDLE restart failed as "Invalid login". ACE reads
    // exactly the String32L length and ignores the padding.
    const rawPassSize = 4 + passLen;
    writer.writeBytes(new Uint8Array(4 - (rawPassSize % 4)));

    // LoginRequest uses sequence 0 (ACE special-cases seq=0 for connect packets)
    this.sendPacket(PacketHeaderFlags.LoginRequest, writer.toBuffer(), 0);
    this.connectionData.state = SessionState.AuthLoginRequest;
  }

  /**
   * Auth type 1, retail's "-a user:password" (NetAuthenticator::StreamPack @
   * 00540a10): the Account string carries "account:password", then the empty
   * CryptoData and ExtraData buffers — two zero dwords. GDL-Classic reads them
   * as "two empty ints"; Seedsow reads them as portal/cell stamps and drops a
   * request that ends early.
   */
  private sendAccountColonPasswordLogin(version: string, account: string, password: string): void {
    const body = new BinaryWriter(256);
    body.writeUInt32(NetAuthType.Account);
    body.writeUInt32(AuthFlags.None);
    body.writeUInt32(0); // timestamp (connection sequence), 0 as above
    body.writeString16(`${account}:${password}`);
    body.writeUInt32(0); // CryptoData: empty
    body.writeUInt32(0); // ExtraData: empty
    const bodyBytes = body.toBuffer();
    const writer = new BinaryWriter(16 + bodyBytes.length);
    writer.writeString16(version);
    writer.writeUInt32(bodyBytes.length); // DataLength: the bytes that follow
    writer.writeBytes(bodyBytes);
    this.sendPacket(PacketHeaderFlags.LoginRequest, writer.toBuffer(), 0);
    this.connectionData.state = SessionState.AuthLoginRequest;
  }

  private handlePacket(data: Uint8Array): void {
    if (data.length < PACKET_HEADER_SIZE) return;

    const header = readPacketHeader(data, 0);

    // Debug: log all incoming packets
    const flagNames: string[] = [];
    if (hasFlag(header, PacketHeaderFlags.AckSequence)) flagNames.push('ACK');
    if (hasFlag(header, PacketHeaderFlags.TimeSync)) flagNames.push('TimeSync');
    if (hasFlag(header, PacketHeaderFlags.EchoRequest)) flagNames.push('EchoReq');
    if (hasFlag(header, PacketHeaderFlags.BlobFragments)) flagNames.push('Blob');
    if (hasFlag(header, PacketHeaderFlags.ConnectRequest)) flagNames.push('ConnReq');
    if (hasFlag(header, PacketHeaderFlags.Disconnect)) flagNames.push('Discon');
    if (hasFlag(header, PacketHeaderFlags.RequestRetransmit)) flagNames.push('ReqRT');
    if (hasFlag(header, PacketHeaderFlags.RejectRetransmit)) flagNames.push('RejRT');
    if (hasFlag(header, PacketHeaderFlags.Flow)) flagNames.push('Flow');
    PKT_DEBUG && console.log(`[AC:PKT] recv seq=${header.sequence} flags=0x${header.flags.toString(16)} [${flagNames.join(',')}] size=${header.size} (${data.length}B)`);

    // Dead-server detection: any inbound packet counts as traffic; re-arm the
    // one-shot 'serverTimeout' event when traffic resumes.
    this.lastPacketReceivedAt = Date.now();
    this.serverTimeoutEmitted = false;
    // SharedNet::SplitPacketData: *PacketsReceivedCounter (3/4/5) per packet.
    this.linkStatusAverages.countReceived();

    // ── Order-insensitive handling — mirrors ACE's pre-reordering stage
    //    (NetworkSession.cs ~283-334: NAK + Disconnect are handled before the
    //    reordering gate, because ACE's FlushPackets reuses the current
    //    sequence for ACK/NAK packets, which the dedup gate would discard).

    // Handle ConnectRequest (handshake step 2)
    if (hasFlag(header, PacketHeaderFlags.ConnectRequest)) {
      this.handleConnectRequest(data, PACKET_HEADER_SIZE);
      return;
    }

    // NET.ack-only-seq-marks-lost-received — ACE FlushPackets stamps an
    // ACK-only packet (flags exactly AckSequence) and a NAK with
    // PacketSequence.CurrentValue: the seq of the server's LAST REAL packet,
    // not a sequence of their own. Counting one as "received" marked a lost
    // packet N received as soon as the 2 s ACK-only packet stamped N arrived
    // — we ACKed it, ACE dropped it from its cache, and ordered delivery
    // waited on it forever. Such a packet only announces how far the server
    // has sent (retail ProcessNewestSeqNum NAKs through a cleartext packet's
    // seqID inclusive); it never enters the reorder buffer.
    const cleartextNak = hasFlag(header, PacketHeaderFlags.RequestRetransmit) &&
      !hasFlag(header, PacketHeaderFlags.EncryptedChecksum);
    if (cleartextNak || header.flags === PacketHeaderFlags.AckSequence) {
      this.noteServerAnnouncedSeq(header.sequence);
      if (cleartextNak) {
        // Exactly like ACE handles a cleartext client NAK (NetworkSession.cs
        // ProcessPacket: "cleartext crc NAK is never accompanied by
        // additional data").
        this.handleRetransmitRequest(this.readSequenceList(data, PACKET_HEADER_SIZE));
      } else if (data.length >= PACKET_HEADER_SIZE + 4) {
        this.handleServerAck(new DataView(data.buffer, data.byteOffset + PACKET_HEADER_SIZE).getUint32(0, true));
      }
      this.requestMissingServerSeqs();
      return;
    }

    // Standalone RejectRetransmit (ACE PacketRejectRetransmit.cs — flags are
    // exactly RejectRetransmit): pre-process order-insensitively. The reject
    // typically refers to the very gap that would block its own ordered
    // delivery, so waiting for ordering would deadlock it.
    if (header.flags === PacketHeaderFlags.RejectRetransmit) {
      this.acceptLostServerSeqs(this.readSequenceList(data, PACKET_HEADER_SIZE));
    }

    // Handle Disconnect (order-insensitive — ACE NetworkSession.cs ~312-316)
    // CORE.17.k.b — a server-sent Disconnect is the other side dropping a
    // live session: everOpened, not deliberate → ServerDied in the renderer.
    // Reported once: the socket's own onclose that follows is suppressed.
    if (hasFlag(header, PacketHeaderFlags.Disconnect)) {
      this.endSessionFromServer();
      return;
    }

    // ── Reordering stage (ACE NetworkSession.cs ~336-397) — discard
    //    duplicates, buffer out-of-order packets, replay strictly in order.
    const result = this.orderedBuffer.submit(header.sequence, header.flags, { header, data });
    if (result.verdict === 'duplicate') {
      PKT_DEBUG && console.log(`[AC:PKT] Packet seq=${header.sequence} received again — discarding`);
      return;
    }
    if (result.verdict === 'buffered' || result.verdict === 'dropped') {
      PKT_DEBUG && console.log(`[AC:PKT] Packet seq=${header.sequence} out of order (expecting ${this.orderedBuffer.lastSequence + 1}) — ${result.verdict}`);
      // NET.nak-latency-5s — NAK the gap now (rate-limited 0.6 s, like retail
      // SharedNet::EnqueueNaks), not on a 5 s keepalive. Our NAK is a
      // cleartext seq-0 control packet, which ACE handles before its
      // reordering stage without touching its sequence tracking.
      this.requestMissingServerSeqs();
      return;
    }
    for (const pkt of result.ready) {
      this.processOrderedPacket(pkt.header, pkt.data);
    }
  }

  /**
   * The server has everything we sent before `ackedSeq`: drop those from the
   * retransmit cache — the same rule ACE applies to its own cache on our ACKs
   * (NetworkSession AcknowledgeSequence removes keys < sequence).
   */
  private handleServerAck(ackedSeq: number): void {
    PKT_DEBUG && console.log(`[AC:PKT] Server acked our seq ${ackedSeq}`);
    for (const seq of this.sentPacketCache.keys()) {
      if (seq < ackedSeq) this.sentPacketCache.delete(seq);
    }
  }

  /** Read a uint32 count + count×uint32 sequence list (NAK/reject payload). */
  private readSequenceList(data: Uint8Array, offset: number): number[] {
    if (offset + 4 > data.length) return [];
    const view = new DataView(data.buffer, data.byteOffset + offset);
    const count = view.getUint32(0, true);
    const seqs: number[] = [];
    for (let i = 0; i < count && offset + 4 + (i + 1) * 4 <= data.length; i++) {
      seqs.push(view.getUint32(4 + i * 4, true));
    }
    return seqs;
  }

  /**
   * Server wants us to resend packets. Resend exact cached bytes; for
   * sequences no longer cached, send RejectRetransmit so the server stops
   * NAKing (mirrors ACE's own behavior when IT can't retransmit —
   * NetworkSession.cs ~292-304 + Packets/PacketRejectRetransmit.cs:7-17:
   * flags=RejectRetransmit, payload = uint32 count + count×uint32 sequences).
   */
  private handleRetransmitRequest(requestedSeqs: number[]): void {
    PKT_DEBUG && console.log(`[AC:PKT] Server requests retransmit of our seqs: ${requestedSeqs.join(', ')}`);

    // Retransmit strategy: ALWAYS send exact cached bytes (no modification).
    // ACE processes packets in sequence order (buffering out-of-order packets),
    // so the ISAAC key for retransmitted encrypted packets will match the
    // original key — the server verifies them in the same order they were sent.
    const uncached: number[] = [];
    const retransmitOne = (seq: number) => {
      const cached = this.sentPacketCache.get(seq);
      if (!cached || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.warn(`[AC:PKT] Cannot retransmit seq=${seq} — not in cache`);
        return;
      }

      PKT_DEBUG && console.log(`[AC:PKT] Retransmitting seq=${seq} (${cached.length}B) [exact cached bytes]`);
      this.ws.send(cached);
      // SharedNet::SendPacket counts (9, 1); FlowQueue::TransmitAcks counts
      // the resend as RetransmitsSentCounter (10).
      this.linkStatusAverages.countSent();
      this.linkStatusAverages.countRetransmitted();
    };

    // Stagger retransmissions with 50ms delay
    let staggered = 0;
    for (const seq of requestedSeqs) {
      if (!this.sentPacketCache.has(seq)) {
        uncached.push(seq);
        continue;
      }
      if (staggered === 0) {
        retransmitOne(seq);
      } else {
        setTimeout(() => retransmitOne(seq), staggered * 50);
      }
      staggered++;
    }

    if (uncached.length > 0) {
      console.warn(`[AC:PKT] Server NAKed uncached seqs ${uncached.join(', ')} — sending RejectRetransmit`);
      const payload = new Uint8Array(4 + uncached.length * 4);
      const view = new DataView(payload.buffer);
      view.setUint32(0, uncached.length, true);
      for (let i = 0; i < uncached.length; i++) {
        view.setUint32(4 + i * 4, uncached[i], true);
      }
      this.sendPacket(PacketHeaderFlags.RejectRetransmit, payload);
    }
  }

  /**
   * Server sequences that will never arrive — the server rejected their
   * retransmit (RejectRetransmit; retail SharedNet::HandleEmptyAck
   * @ 005448f0 drops them from the NAK set). Skip
   * exactly those in ordered delivery (never the still-in-flight ones below
   * them), delivering whatever was buffered behind. Idempotent (the
   * standalone pre-processing path and the ordered optional-header walk may
   * both invoke it for the same packet).
   */
  private acceptLostServerSeqs(lostSeqs: number[]): void {
    if (lostSeqs.length === 0) return;
    PKT_DEBUG && console.log(`[AC:PKT] Accepting lost server seqs: ${lostSeqs.join(', ')}`);
    for (const seq of lostSeqs) {
      for (const pkt of this.orderedBuffer.markLost(seq)) {
        this.processOrderedPacket(pkt.header, pkt.data);
      }
    }
    // NET.giveup-evict-no-fragment-unstick — the lost packet(s) may have
    // carried a fragment whose sequence we'll never learn. Once no packet is
    // still missing, anything the fragment gate holds is waiting on exactly
    // that: unstick it now. (If packets are still missing, the missing
    // fragment may yet arrive; the service tick's stall check covers the
    // rest, including messages that only arrive after this point.)
    const packetsMissing = this.orderedBuffer.bufferedCount > 0 ||
      this.announcedServerSeq > this.orderedBuffer.lastSequence;
    if (!packetsMissing) this.unstickFragmentGate();
  }

  /**
   * Process a packet that has passed the reordering stage (ACE's
   * HandleOrderedPacket equivalent — NetworkSession.cs ~430-474).
   * Optional headers are walked in the order ACE writes them
   * (WriteOptionalHeaders — NetworkSession.cs ~921-948).
   */
  private processOrderedPacket(header: PacketHeaderData, data: Uint8Array): void {
    let offset = PACKET_HEADER_SIZE;

    // Handle AckSequence — server tells us which of our packets it has received
    if (hasFlag(header, PacketHeaderFlags.AckSequence)) {
      const ackView = new DataView(data.buffer, data.byteOffset + offset);
      this.handleServerAck(ackView.getUint32(0, true));
      offset += 4;
    }

    // Handle TimeSync — float64 PortalYearTicks (the server game clock).
    // Retail sets its global timer from this (Timer::set_time via
    // ClientNet::HandleTimeSynch); we surface it so the renderer can sync
    // the day/night cycle instead of free-running from a hardcoded phase.
    if (hasFlag(header, PacketHeaderFlags.TimeSync)) {
      const tsView = new DataView(data.buffer, data.byteOffset + offset);
      const portalYearTicks = tsView.getFloat64(0, true);
      offset += 8;
      this.emit({ type: 'timeSync', data: portalYearTicks });
    }

    // Handle EchoRequest — server sends a ping; we must reply with EchoResponse
    if (hasFlag(header, PacketHeaderFlags.EchoRequest)) {
      const echoView = new DataView(data.buffer, data.byteOffset + offset);
      const serverTime = echoView.getFloat32(0, true);
      offset += 4;
      // Reply with EchoResponse: float32 serverTime + float64 clientTime
      const echoPayload = new Uint8Array(12);
      const echoWriter = new DataView(echoPayload.buffer);
      echoWriter.setFloat32(0, serverTime, true);
      echoWriter.setFloat64(4, performance.now() / 1000.0, true);
      this.sendPacket(PacketHeaderFlags.EchoResponse, echoPayload);
    }

    // Handle Flow
    if (hasFlag(header, PacketHeaderFlags.Flow)) {
      offset += 6; // uint32 + uint16
    }

    // Handle RequestRetransmit — encrypted variant only; cleartext NAKs are
    // handled order-insensitively in handlePacket before reaching here.
    if (hasFlag(header, PacketHeaderFlags.RequestRetransmit)) {
      const requestedSeqs = this.readSequenceList(data, offset);
      offset += 4 + requestedSeqs.length * 4;
      this.handleRetransmitRequest(requestedSeqs);
    }

    // Handle RejectRetransmit — server says it can't resend those packets
    if (hasFlag(header, PacketHeaderFlags.RejectRetransmit)) {
      const rejectedSeqs = this.readSequenceList(data, offset);
      offset += 4 + rejectedSeqs.length * 4;
      this.acceptLostServerSeqs(rejectedSeqs);
    }

    // Handle EchoResponse — ACE writes ClientTime (float32) + serverTime delta
    // (float32) = 8 bytes (NetworkSession.cs WriteOptionalHeaders ~941-947).
    // ASSESS: was 12 (assumed float32+float64), which misaligned every
    // optional header / fragment after it.
    if (hasFlag(header, PacketHeaderFlags.EchoResponse)) {
      offset += 8; // float32 + float32
    }

    // Handle ServerSwitch
    if (hasFlag(header, PacketHeaderFlags.ServerSwitch)) {
      offset += 8;
    }

    // Handle BlobFragments
    if (hasFlag(header, PacketHeaderFlags.BlobFragments)) {
      // Server is sending us real data — handshake succeeded, stop retrying ConnectResponse
      this.stopConnectResponseRetry();
      const endOffset = PACKET_HEADER_SIZE + header.size;
      PKT_DEBUG && console.log(`[AC:PKT:DBG] BlobFragments: offset=${offset} endOffset=${endOffset} dataLen=${data.length}`);
      const fragments: Fragment[] = [];
      while (offset < endOffset && offset + FRAGMENT_HEADER_SIZE <= data.length) {
        const fragment = readFragment(data, offset);
        PKT_DEBUG && console.log(`[AC:PKT:DBG] Fragment: seq=${fragment.header.sequence} id=${fragment.header.id} count=${fragment.header.count} size=${fragment.header.size} index=${fragment.header.index} queue=${fragment.header.queue} dataLen=${fragment.data.length}`);
        // ASSESS: a corrupt fragment size below the 16-byte header size would
        // never advance offset (infinite loop, frozen tab); one past the
        // packet end indicates a truncated/garbled walk. Abort the packet.
        if (fragment.header.size < FRAGMENT_HEADER_SIZE || offset + fragment.header.size > data.length) {
          console.warn(`[AC:PKT] Corrupt fragment size=${fragment.header.size} at offset=${offset} (packet len=${data.length}) — aborting packet`);
          break;
        }
        offset += fragment.header.size;
        fragments.push(fragment);
      }
      // The session's first fragment-bearing packet sets where the fragment
      // gate starts (GDLE's first fragment sequence is 2, ACE's 0).
      if (fragments.length > 0) {
        this.orderedFragments.adoptFirstSequence(Math.min(...fragments.map((f) => f.header.sequence)));
      }
      for (const fragment of fragments) this.handleFragment(fragment);
    }
  }

  private handleConnectRequest(data: Uint8Array, offset: number): void {
    const connectData = ConnectionData.parseConnectRequest(
      data.slice(offset, offset + 32)
    );

    // NET.duplicate-connectrequest-rekeys — a repeated ConnectRequest for the
    // session we already joined (same cookie; e.g. a delayed duplicate
    // datagram) must not re-key ISAAC, reset our sequences, or stack a second
    // ConnectResponse retry timer: that desynced every later checksum. Retail
    // treats the handshake as done once acked (ReceiverData connection state
    // cs_ConnectionRequestAcked → cs_Connected in ClientNet::ProcessConnection
    // @ 00545450). A DIFFERENT cookie is a new server session (ACE replaced
    // ours) and is joined from scratch below.
    if (this.connectionData.state >= SessionState.AuthConnectResponse &&
        sameBytes(connectData.cookie, this.connectionData.connectionCookie)) {
      PKT_DEBUG && console.log('[AC:PKT] Duplicate ConnectRequest for the current session — ignored');
      return;
    }

    this.stopLoginRetry(); // Login succeeded — stop retrying
    this.stopConnectResponseRetry();
    if (this.connectionData.state >= SessionState.AuthConnectResponse) {
      console.warn('[AC:NET] ConnectRequest with a new cookie — the server replaced our session; re-handshaking');
      this.resetSequencingState();
    }

    // Initialize crypto with received seeds
    PKT_DEBUG && console.log(`[AC:PKT:DBG] ConnectRequest seeds — clientSeed=${Array.from(connectData.clientSeed).map(b => b.toString(16).padStart(2, '0')).join('')} serverSeed=${Array.from(connectData.serverSeed).map(b => b.toString(16).padStart(2, '0')).join('')} clientId=0x${connectData.clientId.toString(16)}`);
    this.connectionData.initializeCryptoFromConnect(connectData);
    // Log first few ISAAC keys (peek, don't consume)
    if (this.connectionData.cryptoClient) {
      PKT_DEBUG && console.log(`[AC:PKT:DBG] First cryptoClient key (peek): 0x${(this.connectionData.cryptoClient.peek() >>> 0).toString(16)}`);
    }
    this.connectionData.state = SessionState.AuthConnectResponse;

    // Send ConnectResponse (echo cookie) — must use sequence 0 (connect phase)
    const response = this.connectionData.buildConnectResponse();
    this.connectResponsePayload = response;
    this.sendPacket(PacketHeaderFlags.ConnectResponse, response, 0);

    this.connectionData.state = SessionState.AuthConnected;

    // ACE server initializes lastSentPacketSequence = 1, so the first S2C
    // packet is seq 2 (seq 1 is never sent). orderedBuffer starts with
    // lastSequence = 1 for exactly that reason (OrderedPacketBuffer
    // INITIAL_SEQUENCE), so the first ACK is 1, never 0 — a 0 ACK made ACE's
    // flow control think we had received nothing.

    this.startKeepalive();

    // Start ConnectResponse retry timer. On localhost (through relay), the
    // ConnectResponse can arrive at ACE's world port before the session state
    // is set to AuthConnectResponse (race condition). Retry until we receive
    // server data with blob fragments (indicating the handshake succeeded).
    this.connectResponseRetryCount = 0;
    this.connectResponseRetryTimer = setInterval(() => {
      this.connectResponseRetryCount++;
      if (this.connectResponseRetryCount >= ClientConnection.CONNECT_RESPONSE_MAX_RETRIES) {
        console.warn('[AC:PKT] ConnectResponse retry limit reached — giving up');
        this.stopConnectResponseRetry();
        return;
      }
      if (this.connectResponsePayload) {
        PKT_DEBUG && console.log(`[AC:PKT] Retrying ConnectResponse (attempt ${this.connectResponseRetryCount})`);
        this.sendPacket(PacketHeaderFlags.ConnectResponse, this.connectResponsePayload, 0);
      }
    }, ClientConnection.CONNECT_RESPONSE_RETRY_INTERVAL);

    // Flush messages queued before the handshake — ISAAC is keyed now, so
    // they can be sent with valid encrypted checksums, in original order.
    const queued = this.preHandshakeQueue;
    this.preHandshakeQueue = [];
    for (const { bytes, queue } of queued) {
      this.sendMessage(bytes, queue);
    }

    this.emit({ type: 'handshakeComplete' });
  }

  private handleFragment(fragment: Fragment): void {
    const id = fragment.header.id;
    let message: Uint8Array | null;

    // The fragment gate already moved past this sequence (delivered, or
    // skipped as lost) — don't start or grow a partial that can never be
    // dispatched in order.
    if (fragment.header.sequence <= this.orderedFragments.lastSequence) {
      PKT_DEBUG && console.log(`[AC:FRAG] Fragment seq=${fragment.header.sequence} is behind the gate (${this.orderedFragments.lastSequence}) — dropping`);
      return;
    }

    if (fragment.header.count === 1) {
      message = fragment.data;
    } else {
      // Multi-fragment message — accumulate (FragmentAssembler ignores duplicate
      // indices and evicts stale partial messages via the receiver service tick)
      PKT_DEBUG && console.log(`[AC:FRAG] Multi-frag: id=${id} index=${fragment.header.index}/${fragment.header.count} seq=${fragment.header.sequence} dataLen=${fragment.data.length}`);
      message = this.fragmentAssembler.add(fragment);
      if (message) {
        PKT_DEBUG && console.log(`[AC:FRAG] Assembled ${message.length} bytes for id=${id}`);
      }
    }

    if (!message) return; // still assembling a split message

    // BUG.fragment-sequence-not-reordered — gate dispatch on the fragment's
    // own sequence stream (ACE ProcessFragment ~547-563), independent of the
    // outer packet-sequence order already enforced upstream. A message packed
    // ahead of an earlier bundle-mate (ACE SendBundle ~897-929) is buffered
    // here until its predecessor arrives, instead of dispatching immediately.
    const result = this.orderedFragments.submit(fragment.header.sequence, message);
    if (result.verdict === 'buffered') {
      PKT_DEBUG && console.log(`[AC:FRAG] Fragment seq=${fragment.header.sequence} out of order (lastReceivedFragmentSequence=${this.orderedFragments.lastSequence}), buffering`);
      return;
    }
    for (const ready of result.ready) {
      this.processMessage(ready);
    }
  }

  private processMessage(data: Uint8Array): void {
    PKT_DEBUG && console.log(`[AC:PKT:DBG] processMessage: ${data.length} bytes, hex=${Array.from(data.slice(0, Math.min(data.length, 24))).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    const msg = deserializeMessage(data);
    PKT_DEBUG && console.log(`[AC:PKT:DBG] deserialized: type=${msg.type} opcode=0x${(msg.opcode ?? 0).toString(16)}`);

    // Emit dedicated event for GameEvent messages so handlers can receive them
    // without relying on the generic 'message' path (which can be missed due to
    // HMR/instance binding issues in dev mode)
    if (msg.type === 'event') {
      this.emit({ type: 'gameEvent', data: msg });
    }

    // Handle specific message types
    if (msg.type === 'direct') {
      switch (msg.opcode) {
        case GameMessageOpcode.CharacterList:
          // A character list means the login fully succeeded — clear any
          // pending stale-session retry budget (ASSESS).
          this.loginRejectRetryAttempts = 0;
          this.sessionPastLogin = true;
          if (this.loginRejectRetryTimer) {
            clearTimeout(this.loginRejectRetryTimer);
            this.loginRejectRetryTimer = null;
          }
          this.emit({ type: 'characterList', data: msg.payload });
          break;
        // ServerName (0xF7E1) — the world/realm identity for the char-select
        // world plate. Previously fell through to the generic 'message' event
        // (silently dropped); ServerMessageHandler's stale comment claimed it
        // was "handled by ClientConnection directly" but there was no case.
        case GameMessageOpcode.ServerName:
          this.emit({ type: 'serverName', data: parseServerName(msg.payload) });
          break;

        case GameMessageOpcode.DDD_Interrogation:
          // Respond with actual DAT iteration counts — must match server's DATs
          // or server will terminate session (if DAT patching is disabled)
          console.log('[AC] Received DDD_Interrogation, sending response...');
          this.sendMessage(
            buildDDDInterrogationResponse(
              this.datIterations.portal,
              this.datIterations.cell,
              this.datIterations.language,
            ),
            GameMessageGroup.LoginQueue,
          );
          break;

        case GameMessageOpcode.DDD_EndDDD:
          console.log('[AC] Received DDD_EndDDD — no DAT updates needed');
          break;

        // FAITHFUL: server only sends BeginDDD/DataMessage when
        // DDD.EnableDATPatching=true AND our reported iterations (sent via
        // DDD_InterrogationResponse above) are older than the server's —
        // this client's DATs are provisioned pinned to the EoR iteration, so
        // in practice this is a config/version mismatch worth surfacing
        // loudly rather than a normal patch flow. We don't implement
        // client-side DAT patching (there's no writable local DAT store to
        // patch into in a browser — DATs are fetched read-only static
        // assets), so this is the "at minimum surface a console warning"
        // floor: parse for real (dispatch coverage) and warn instead of
        // silently discarding server-pushed patch data.
        case GameMessageOpcode.DDD_BeginDDD: {
          const beginDDD = parseDDDBeginDDD(msg.payload);
          console.warn(
            `[AC] DDD_BeginDDD: server wants to push ${beginDDD.totalMissingIterations} DAT iteration update(s) `
            + `(${beginDDD.totalFileSize} bytes) — this client does not support live DAT patching; `
            + 'DAT iteration mismatch must be resolved by re-provisioning the local DAT files.',
          );
          this.emit({ type: 'dddBeginDDD', data: beginDDD });
          break;
        }

        case GameMessageOpcode.DDD_DataMessage: {
          const dataMessage = parseDDDDataMessage(msg.payload);
          console.warn(
            `[AC] DDD_DataMessage: dropped unpatchable ${dataMessage.datType} DAT patch for file 0x${dataMessage.fileId.toString(16)} `
            + `(iteration ${dataMessage.iteration}, ${dataMessage.contents.length} bytes) — see DDD_BeginDDD warning above.`,
          );
          this.emit({ type: 'dddDataMessage', data: dataMessage });
          break;
        }

        case GameMessageOpcode.CharacterError: {
          // CharacterError (0xF659): uint32 error code. The 21 retail
          // CharacterError codes + their canonical AC executable messages
          // live in @ac/shared CharacterError + characterErrorMessage,
          // sourced from reference/ACE/Source/ACE.Server/Network/Enum/CharacterError.cs.
          // FAITHFUL.278 — pre-fix this had a local ad-hoc errorNames map
          // with wrong code → wrong text (e.g. 0x01 was mislabeled "Server full"
          // when it's actually "Cannot have two accounts logged on at the same
          // time"; LogonServerFull is 0x15). Now uses the ACE-canonical wording.
          const errorCode = msg.payload && msg.payload.length >= 4
            ? new DataView(msg.payload.buffer, msg.payload.byteOffset).getUint32(0, true)
            : 0;
          const enumName = CharacterError[errorCode] ?? 'unknown';
          const userText = characterErrorMessage(errorCode);
          console.error(`[AC] CharacterError: code=0x${errorCode.toString(16)} (${errorCode}) = ${enumName}: ${userText}`);
          console.error(`[AC] CharacterError context: aceCharGuid was sent, raw payload hex: ${msg.payload ? Array.from(msg.payload).map(b => b.toString(16).padStart(2, '0')).join(' ') : 'none'}`);
          // ASSESS: CharacterError.Logon (0x1, "Cannot have two accounts
          // logged on at the same time") happens whenever a page is closed
          // mid-world: ACE only frees the account after the abandoned
          // player's logoff completes (Session.Terminate → player LogOut,
          // reference/ACE/Source/ACE.Server/Network/Managers/NetworkManager.cs
          // duplicate-account check). Pre-fix the client gave up into a dead
          // empty char-select and the user had to reload. Retry the login on
          // a 10s timer until ACE lets us in (budget ~2 min).
          // CORE.17.k.b — the event carries the code and whether a retry is
          // pending, so the renderer can pick the retail surface (Disconnected
          // screen / char-select dialog) when it is not.
          // Booted after a successful login (the account logged in elsewhere): the Disconnected screen, no retry.
          const loginRetryScheduled = errorCode === CharacterError.Logon && !this.sessionPastLogin && this.scheduleLoginRetryAfterReject();
          this.emit({ type: 'error', error: `Server: ${userText}`, characterError: errorCode, loginRetryScheduled });
          break;
        }

        case GameMessageOpcode.CharacterCreateResponse:
          // FAITHFUL.581 — ACE reuses 0xF643 for CharacterRestoreResponse
          // too (GameMessageOpcode.ts). Only treat this as a response to
          // OUR create request if one is actually outstanding; otherwise
          // it's an unsolicited admin-restore notice.
          if (this.awaitingCharacterCreateResponse) {
            this.awaitingCharacterCreateResponse = false;
            this.emit({ type: 'characterCreateResponse', data: parseCharacterCreateResponse(msg.payload) });
          } else {
            this.emit({ type: 'characterRestoreResponse', data: parseCharacterRestoreResponse(msg.payload) });
          }
          break;

        case GameMessageOpcode.CharacterEnterWorldServerReady:
          this.emit({ type: 'enterWorldReady' });
          break;

        case GameMessageOpcode.PlayerCreate:
          this.emit({ type: 'playerCreate', data: msg.payload });
          break;

        case GameMessageOpcode.ObjectCreate: {
          const obj = parseCreateObject(msg.payload);
          if (obj) {
            this.emit({ type: 'objectCreate', data: obj });
          }
          break;
        }
      }
    }

    // Always emit to generic listeners
    this.emit({ type: 'message', data: msg });
  }

  /**
   * Send a non-fragment control packet (LoginRequest, ConnectResponse, ACK, Disconnect, etc.).
   *
   * Control packets ALWAYS use cleartext checksums and seq=0.
   * ACE processes cleartext packet flags (ACK, RequestRetransmit, etc.) regardless of
   * crypto state — they just don't update lastReceivedPacketSequence.
   * By using seq=0 instead of incrementing sequences, we avoid creating gaps in the
   * server's sequence tracking. Only sendFragmentPacket uses ISAAC + incrementing seqs.
   *
   * Pre-handshake packets (LoginRequest, ConnectResponse) also use cleartext/seq=0.
   */
  private sendPacket(flags: PacketHeaderFlags, payload: Uint8Array, sequence?: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const totalSize = PACKET_HEADER_SIZE + payload.length;
    const buf = new Uint8Array(totalSize);

    // Write payload
    buf.set(payload, PACKET_HEADER_SIZE);

    // Control packets use seq=0 (no sequence tracking needed).
    // Only pre-handshake packets (LoginRequest) pass an explicit sequence.
    const seq = sequence ?? 0;

    const header: PacketHeaderData = {
      sequence: seq,
      flags,
      checksum: 0,
      id: this.connectionData.clientId & 0xFFFF,
      time: 0,
      size: payload.length,
      iteration: 0,
    };

    // Cleartext checksum: headerChecksum + payloadChecksum (no ISAAC)
    const headerChecksum = calculateHeaderChecksum(header);
    let payloadChecksum = 0;
    if (payload.length > 0) {
      payloadChecksum = hash32(payload, 0, payload.length);
    }
    header.checksum = (headerChecksum + payloadChecksum) >>> 0;

    writePacketHeader(header, buf, 0);
    PKT_DEBUG && console.log(`[AC:PKT] send seq=${header.sequence} flags=0x${header.flags.toString(16)} size=${header.size} checksum=0x${header.checksum.toString(16)} cleartext`);

    // Don't cache control packets (they use seq=0, no retransmission needed)

    this.ws.send(buf.buffer);
    this.linkStatusAverages.countSent(); // SharedNet::SendPacket: PacketsSentCounter (9)
  }

  /**
   * The ~3 s flow keepalive (FLOW_KEEPALIVE_INTERVAL_MS): TimeSync (float64,
   * the client clock) + EchoRequest (float32, the client clock) on the next
   * client sequence with the ISAAC checksum, as retail piggybacks them. ACE
   * reads both (PacketHeaderOptional.Unpack), answers the echo with an
   * EchoResponse and checks the client clock against its own in VerifyEcho,
   * so the clock is monotonic seconds since the handshake. Cached for
   * retransmit like any sequenced packet.
   */
  private sendFlowKeepalive(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.connectionData.state < SessionState.AuthConnected || !this.connectionData.cryptoClient) return;

    const clientTime = (performance.now() - this.echoEpochMs) / 1000;
    const payload = new Uint8Array(12);
    const view = new DataView(payload.buffer);
    view.setFloat64(0, clientTime, true); // TimeSync
    view.setFloat32(8, clientTime, true); // EchoRequest
    const header: PacketHeaderData = {
      sequence: ++this.packetSequence,
      flags: PacketHeaderFlags.TimeSync | PacketHeaderFlags.EchoRequest | PacketHeaderFlags.EncryptedChecksum,
      checksum: 0,
      id: this.connectionData.clientId & 0xFFFF,
      time: 0,
      size: payload.length,
      iteration: 1,
    };
    const headerChecksum = calculateHeaderChecksum(header);
    const xorKey = this.connectionData.cryptoClient.next();
    header.checksum = (headerChecksum + ((hash32(payload, 0, payload.length) ^ xorKey) >>> 0)) >>> 0;

    const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
    writePacketHeader(header, buf, 0);
    buf.set(payload, PACKET_HEADER_SIZE);
    this.sentPacketCache.set(header.sequence, new Uint8Array(buf));
    if (this.sentPacketCache.size > MAX_SEQUENCE_WINDOW) {
      const oldest = Math.min(...this.sentPacketCache.keys());
      this.sentPacketCache.delete(oldest);
    }
    this.ws.send(buf.buffer);
    this.linkStatusAverages.countSent();
  }

  /**
   * NET.outbound-multifragment-exceeds-1024 — the most fragment bytes one
   * packet carries, mirroring how ACE packs its own outgoing packets
   * (NetworkSession SendBundle: availableSpace = ServerPacket.MaxPacketSize =
   * 464 = MAX_SERVER_PACKET_SIZE, i.e. one full 16 + 448-byte fragment). ACE
   * reads client datagrams into a ClientPacket.MaxPacketSize = 1024-byte
   * buffer (ConnectionListener = MAX_CLIENT_PACKET_SIZE), so the old "every
   * fragment in one datagram" packing got any message over ~1000 bytes
   * truncated and dropped — and retransmitted forever.
   */
  static readonly MAX_PACKET_FRAGMENT_BYTES = MAX_SERVER_PACKET_SIZE;

  /**
   * Send a message's fragments, packed into as many packets as needed (each
   * ≤ MAX_PACKET_FRAGMENT_BYTES of fragments). Every packet gets its own
   * sequence number and its own ISAAC key, consumed in sequence order — ACE
   * verifies each against its CryptoSystem key window (ClientPacket.VerifyCRC).
   */
  private sendFragmentPacket(fragments: Fragment[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    let batch: Fragment[] = [];
    let batchBytes = 0;
    for (const frag of fragments) {
      const size = FRAGMENT_HEADER_SIZE + frag.data.length;
      if (batch.length > 0 && batchBytes + size > ClientConnection.MAX_PACKET_FRAGMENT_BYTES) {
        this.sendOneFragmentPacket(batch, batchBytes);
        batch = [];
        batchBytes = 0;
      }
      batch.push(frag);
      batchBytes += size;
    }
    if (batch.length > 0) this.sendOneFragmentPacket(batch, batchBytes);
  }

  /**
   * Send one fragment-carrying packet with ISAAC-encrypted checksum.
   * Uses ACE formula: Header.Checksum = headerChecksum + (payloadChecksum ^ issacXor)
   */
  private sendOneFragmentPacket(fragments: Fragment[], fragmentsSize: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const totalSize = PACKET_HEADER_SIZE + fragmentsSize;
    const buf = new Uint8Array(totalSize);

    // Write fragments
    let offset = PACKET_HEADER_SIZE;
    for (const frag of fragments) {
      writeFragment(frag, buf, offset);
      offset += FRAGMENT_HEADER_SIZE + frag.data.length;
    }
    // Build header — BlobFragments + EncryptedChecksum flags
    const header: PacketHeaderData = {
      sequence: ++this.packetSequence,
      flags: PacketHeaderFlags.BlobFragments | PacketHeaderFlags.EncryptedChecksum,
      checksum: 0,
      id: this.connectionData.clientId & 0xFFFF,
      time: 0,
      size: fragmentsSize,
      iteration: 1,
    };

    // Calculate checksum using ACE formula:
    //   Header.Checksum = headerChecksum + (payloadChecksum ^ issacXor)
    const headerChecksum = calculateHeaderChecksum(header);
    let payloadChecksum = 0;
    for (const frag of fragments) {
      payloadChecksum = (payloadChecksum + hashFragment(frag)) >>> 0;
    }

    if (this.connectionData.state >= SessionState.AuthConnected && this.connectionData.cryptoClient) {
      const xorKey = this.connectionData.cryptoClient.next();
      header.checksum = (headerChecksum + ((payloadChecksum ^ xorKey) >>> 0)) >>> 0;
      PKT_DEBUG && console.log(`[AC:PKT:DBG] send FRAG seq=${header.sequence} headerCk=0x${headerChecksum.toString(16)} payloadCk=0x${payloadChecksum.toString(16)} isaacKey=0x${(xorKey >>> 0).toString(16)} finalCk=0x${header.checksum.toString(16)}`);
    } else {
      // Pre-handshake: cleartext checksum (shouldn't normally happen for fragment packets)
      header.checksum = (headerChecksum + payloadChecksum) >>> 0;
    }

    writePacketHeader(header, buf, 0);
    PKT_DEBUG && console.log(`[AC:PKT] send FRAG seq=${header.sequence} flags=0x${header.flags.toString(16)} size=${header.size} checksum=0x${header.checksum.toString(16)} isaac=${this.connectionData.cryptoClient ? 'yes' : 'no'}`);
    if (PKT_DEBUG) {
      // Dump full packet header (20 bytes) + fragment header (16 bytes) for debugging
      const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(' ');
      console.log(`[AC:PKT:HEX] pktHdr: ${hex(buf.slice(0, 20))}`);
      console.log(`[AC:PKT:HEX] fragHdr: ${hex(buf.slice(20, 36))}`);
      console.log(`[AC:PKT:HEX] fragData(first64): ${hex(buf.slice(36, Math.min(100, buf.length)))}`);
    }

    // Cache for potential retransmit (pruned by the server's ACKs —
    // handleServerAck — and capped at the reorder window ACE tolerates).
    this.sentPacketCache.set(header.sequence, new Uint8Array(buf));
    if (this.sentPacketCache.size > MAX_SEQUENCE_WINDOW) {
      const oldest = Math.min(...this.sentPacketCache.keys());
      this.sentPacketCache.delete(oldest);
    }

    this.ws.send(buf.buffer);
    this.linkStatusAverages.countSent(); // SharedNet::SendPacket: PacketsSentCounter (9)
  }
}
