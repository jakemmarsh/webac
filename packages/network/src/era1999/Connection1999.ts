/**
 * Connection1999 — a session with a 1999-protocol server (AC1999), behind the
 * same NetConnection surface and ConnectionEvents as ClientConnection, so the
 * page cannot tell the two apart (docs/ac1999-support-scope.md Phase 3). It
 * runs the 1999 transport (Packet1999, Login1999) over the same WebSocket
 * bridge, and the Adapter1999 translates every message both ways, so the page
 * only ever sees end-of-retail messages.
 *
 * Session, measured against the real client (tests/fixtures/ac1999-session-001.jsonl.gz):
 *  1. LoginRequest (seq 1, flags 0x2, recipient 0), resent until answered.
 *  2. Grant 0x202 + body → our slot (the recipient we stamp), version check, ack with a bare 0x202.
 *  3. ServerSwitch 0x102 → answer a bare 0x102 (its 8-byte body is ignored).
 *  4. Sequenced server packets: options (0x4000 ack, 0x1000000 time) and 0x800 fragments, applied in
 *     sequence order; holes are asked for with 0x8 lists at most every 250 ms.
 *  5. The server's bare 0x202 keepalive (every 5 s) is answered with a bare 0x202.
 *  6. Our data: 0x802, a flow word, fragments (group 6 login / 5 actions), ISAAC-keyed checksum.
 *
 * Resends. The AC1999 server answers our data with a 0x8 list naming the last
 * sequence it processed (it uses "resend these" as its ack, PacketController.cpp
 * SendAckSequence), and the same list shape for a real gap. So: every sequence
 * below the one named is received (dropped from our cache); the named one is
 * resent at most once a second. The real client resends everything every
 * frame instead (LoginComplete ×872 in one session); we don't copy that.
 */
import { characterErrorMessage } from '@ac/shared';
import {
  parseAgentCall, parsePairingReply, parseRelayLinkNotice, parseRoutinesGrant, probeBridgeHealth, type BridgeHealth, type ConnectionEvent, type ConnectionListener,
} from '../ClientConnection.js';
import type { GameMessageGroup } from '../GameMessageGroup.js';
import { EOR_LOGIN_PROFILE, type LoginProfile } from '../LoginProfile.js';
import {
  deserializeMessage, parseCharacterCreateResponse, parseCharacterRestoreResponse, parseCreateObject,
} from '../MessageSerializer.js';
import { GameMessageOpcode } from '../GameMessageOpcode.js';
import { ISAAC } from '../ISAAC.js';
import type { NetConnection } from '../NetWorker.js';
import { Adapter1999, Group1999 } from './Adapter1999.js';
import { codecs1999 } from './codecs/index.js';
import { buildLoginBody1999, readGrant1999 } from './Login1999.js';
import {
  buildPacket1999, buildSeqList1999, checksum1999, F1999, fragmentMessage1999, HEADER_SIZE_1999, Isaac1999Keys,
  MAX_DATAGRAM_1999, optionBytes1999, readFragments1999, readHeader1999, readSeqList1999, type Fragment1999,
} from './Packet1999.js';

/** The 1999 release client's version string; the server requires it exactly. */
export const VERSION_1999 = '4.35752';

/**
 * A server DAT file pushed during login (0xF7B7): which DAT, the file id, and
 * its 1999-format bytes, zlib-compressed: the AC1999 server always compresses
 * (the page inflates them, as the browser's inflate is async, and still
 * accepts a stored file of rawLength bytes).
 */
export interface DatPatch1999 { dat: 'portal' | 'cell'; fileId: number; compressed: Uint8Array; rawLength: number }

/** What Connection1999 adds to the ConnectionEvent stream (the page ignores types it doesn't know). */
export interface DatPatchEvent { type: 'datPatch1999'; patches: DatPatch1999[]; portalIteration: number; cellIteration: number }

const LOGIN_RESEND_MS = 2000;
const LOGIN_MAX_SENDS = 6;
const NAK_MIN_MS = 250;
const OUR_RESEND_MIN_MS = 1000;
const SERVICE_MS = 100;
const SERVER_TIMEOUT_MS = 60_000;
/** A server data packet's body budget (the 484-byte datagram less the header and our flow word). */
const MAX_DATA_BODY = MAX_DATAGRAM_1999 - HEADER_SIZE_1999 - 4;

/** The bridge URL with `proto=ac1999` added (kept if already present). */
export function withProto1999(url: string): string {
  if (/[?&]proto=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}proto=ac1999`;
}

export class Connection1999 implements NetConnection {
  autoReconnect = false;
  datIterations = { portal: 0, cell: 0, language: 0 };
  loginProfile: LoginProfile;

  private ws: WebSocket | null = null;
  private url: string;
  private listeners: ConnectionListener[] = [];
  private adapter: Adapter1999 | null = null;
  private account = '';
  private password = '';

  private recipient = 0;
  private granted = false;
  private serverTime = 0;
  private loginSends = 0;
  private loginTimer: ReturnType<typeof setInterval> | null = null;
  private serviceTimer: ReturnType<typeof setInterval> | null = null;

  // Receive side
  private serverKeys!: Isaac1999Keys;
  private readonly held = new Map<number, Uint8Array>();
  private nextServerSeq = 1;
  private highestServerSeq = 0;
  private lastNakAt = 0;
  private readonly partial = new Map<number, Map<number, Uint8Array>>();
  private lastPacketAt = 0;
  private checksumFailures = 0;
  private received = 0;
  private lost = 0;

  // Send side
  private clientKeys!: Isaac1999Keys;
  private sequence = 1; // the login is sequence 1; our first data is 2 (as the real client's)
  private fragmentSequence = 2;
  private flowBytes = 0;
  private readonly resendCache = new Map<number, { packet: Uint8Array; lastSent: number }>();
  private awaitingCreate = false;
  /**
   * The server answered our enter-world request (0xF7C7) and has not left the
   * world since (0xF653). The AC1999 server sets bInWorld on the request
   * (CClient::EnterWorld) and clears it only in ExitWorld, so after a refused
   * enter ("One of your characters is still in the world") it ignores every
   * further 0xF7C8: the retry and a second ENTER waited for a ready reply
   * that never came (BUG.ac1999-enter-world-retry-hangs). The 1999 client
   * keeps the same flag (char screen +0x290, set by 0xF7C7), so its next
   * Enter sends 0xF657 straight away; a request while it is set is answered
   * here as ready.
   */
  private enterWorldGranted = false;
  private deliberate = false;
  private everOpened = false;
  private dddFiles: DatPatch1999[] = [];
  private dddExpected = 0;
  private dddIterations = { portal: 0, cell: 0 };
  private dddFinished = false;

  constructor(url: string, opts: { loginProfile?: LoginProfile } = {}) {
    this.url = url;
    this.loginProfile = opts.loginProfile ?? { ...EOR_LOGIN_PROFILE, clientVersion: VERSION_1999, protocol: 'ac1999' };
    this.resetSession();
  }

  /**
   * Fresh per-session state: every login is a new 1999 session (sequences and
   * both ISAAC streams restart, the grant and DAT sync happen again). The
   * page's auto-resume calls disconnect() then connect() on this same object
   * (SessionLifecycle), so connect() must not inherit the dropped session.
   */
  private resetSession(): void {
    const s = new ISAAC(new Uint8Array(4));
    const c = new ISAAC(new Uint8Array(4));
    this.serverKeys = new Isaac1999Keys(() => s.next());
    this.clientKeys = new Isaac1999Keys(() => c.next());
    this.recipient = 0;
    this.granted = false;
    this.serverTime = 0;
    this.loginSends = 0;
    this.held.clear();
    this.nextServerSeq = 1;
    this.highestServerSeq = 0;
    this.lastNakAt = 0;
    this.partial.clear();
    this.lastPacketAt = 0;
    this.sequence = 1;
    this.fragmentSequence = 2;
    this.flowBytes = 0;
    this.resendCache.clear();
    this.awaitingCreate = false;
    this.enterWorldGranted = false;
    this.dddFiles = [];
    this.dddExpected = 0;
    this.dddIterations = { portal: 0, cell: 0 };
    this.dddFinished = false;
  }

  get bridgeUrl(): string { return this.url; }
  get isConnected(): boolean { return this.granted && this.ws?.readyState === WebSocket.OPEN; }
  /** Server packets whose checksum didn't verify (should stay 0). */
  get badChecksums(): number { return this.checksumFailures; }

  setUrl(url: string): void { this.url = url; }
  checkHealth(): Promise<BridgeHealth> { return probeBridgeHealth(this.url); }
  getLinkStatus(now = Date.now()): { connected: boolean; secondsSinceLastPacket: number } {
    return { connected: this.isConnected, secondsSinceLastPacket: this.lastPacketAt ? (now - this.lastPacketAt) / 1000 : 0 };
  }
  getPacketLossPercentage(): number { return this.received ? (100 * this.lost) / (this.received + this.lost) : 0; }
  on(l: ConnectionListener): void { this.listeners.push(l); }
  off(l: ConnectionListener): void { this.listeners = this.listeners.filter((x) => x !== l); }
  private emit(e: ConnectionEvent | DatPatchEvent): void {
    for (const l of [...this.listeners]) {
      try { l(e as ConnectionEvent); } catch (err) { console.error('[1999] listener threw', err); }
    }
  }

  connect(account: string, password: string): void {
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    this.stopLoginTimer();
    if (this.serviceTimer) clearInterval(this.serviceTimer);
    this.serviceTimer = null;
    this.resetSession();
    this.account = account;
    this.password = password;
    this.deliberate = false;
    this.adapter = new Adapter1999(codecs1999(), { account, log: (m) => console.log(m) });
    // ?proto=ac1999 tells the bridge this session speaks the 1999 protocol (one port, its own
    // disconnect) even where it can't tell from the world (a Custom… bridge pinned to end of retail).
    const ws = new WebSocket(withProto1999(this.url));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.everOpened = true;
      this.emit({ type: 'connected' });
      this.sendLogin();
      this.loginTimer = setInterval(() => {
        if (this.granted) { this.stopLoginTimer(); return; }
        if (this.loginSends >= LOGIN_MAX_SENDS) { this.loginTimedOut(); return; }
        this.sendLogin();
      }, LOGIN_RESEND_MS);
      this.serviceTimer = setInterval(() => this.service(), SERVICE_MS);
    };
    ws.onmessage = (ev) => {
      // A closed session's socket can still deliver queued frames; only the current one counts.
      if (ws !== this.ws) return;
      if (typeof ev.data === 'string') {
        // Bridge text: the routines grant (AGENT.routine-store-auth); health answers are ignored.
        const grant = parseRoutinesGrant(ev.data);
        if (grant) {
          this.emit({ type: 'routinesGrant', data: grant.grant, error: grant.reason ?? undefined });
          this.emit({ type: 'automationAccess', data: grant.automation });
          this.emit({ type: 'previewAccess', data: grant.preview });
        }
        const call = grant ? null : parseAgentCall(ev.data);
        if (call) this.emit({ type: 'agentCall', data: call });
        const pairing = grant || call ? null : parsePairingReply(ev.data);
        if (pairing) this.emit({ type: 'agentPairing', data: pairing });
        const link = grant || call || pairing ? null : parseRelayLinkNotice(ev.data);
        if (link) this.emit({ type: 'relayLink', data: link });
        return;
      }
      this.handleDatagram(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onerror = () => { if (ws === this.ws) this.emit({ type: 'error', error: 'Bridge connection error' }); };
    ws.onclose = () => { if (ws === this.ws) this.ended(); };
  }

  private stopLoginTimer(): void {
    if (this.loginTimer) clearInterval(this.loginTimer);
    this.loginTimer = null;
  }

  private ended(): void {
    this.stopLoginTimer();
    if (this.serviceTimer) clearInterval(this.serviceTimer);
    this.serviceTimer = null;
    const wasOpen = this.ws !== null;
    this.ws = null;
    this.granted = false;
    if (wasOpen) this.emit({ type: 'disconnected', everOpened: this.everOpened, deliberate: this.deliberate });
  }

  disconnect(): void {
    this.deliberate = true;
    if (this.granted) this.sendControl(F1999.Disconnect | F1999.Checksum);
    this.ws?.close();
    this.ended();
  }

  sendCharacterLogOff(): void {
    this.sendMessage(new Uint8Array([0x53, 0xf6, 0, 0]));
  }

  /** AGENT.hosted-mcp-connector — as ClientConnection.sendBridgeText. */
  sendBridgeText(text: string): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(text);
  }

  /** AGENT.routine-store-auth — as ClientConnection.requestRoutinesGrant. */
  requestRoutinesGrant(): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send('routines');
    else this.emit({ type: 'routinesGrant', data: null, error: 'not connected' });
  }

  private raw(packet: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(packet);
  }

  private sendLogin(): void {
    this.loginSends++;
    // Credentials past the 20-byte field are truncated, as the retail client did (Login1999.ts).
    const body = buildLoginBody1999({
      version: this.loginProfile.clientVersion || VERSION_1999,
      account: this.account, password: this.password,
      portalIteration: this.datIterations.portal, cellIteration: this.datIterations.cell,
    });
    this.raw(buildPacket1999({ sequence: 1, flags: F1999.Checksum, recipient: 0, time: 0, body }));
  }

  private sendControl(flags: number, body?: Uint8Array): void {
    this.raw(buildPacket1999({ sequence: 0, flags, recipient: this.recipient, time: this.serverTime, body }));
  }

  // ── Receive ─────────────────────────────────────────────

  private handleDatagram(b: Uint8Array): void {
    if (b.length < HEADER_SIZE_1999) return;
    const h = readHeader1999(b);
    this.lastPacketAt = Date.now();
    this.serverTime = h.time;
    if (h.flags & F1999.Checksum) {
      const xor = h.sequence >= 2 ? this.serverKeys.forSequence(h.sequence) : 0;
      if (checksum1999(b, xor) !== h.checksum) {
        this.checksumFailures++;
        if (this.checksumFailures <= 5) console.warn(`[1999] checksum mismatch seq ${h.sequence} flags 0x${h.flags.toString(16)}`);
      }
    }
    if (h.flags & F1999.NetError) { this.onNetError(b); return; }
    if (h.flags & F1999.Disconnect) { this.ws?.close(); return; }
    const body = b.subarray(HEADER_SIZE_1999);

    if ((h.flags & F1999.Connect) && h.sequence === 0) {
      if (body.length >= 24 && !this.granted) { this.onGrant(body); return; }
      if (body.length === 0) { this.sendControl(F1999.Connect | F1999.Checksum); return; }
    }
    if ((h.flags & F1999.ServerSwitch) && h.sequence === 0) { this.sendControl(F1999.ServerSwitch | F1999.Checksum); return; }
    if ((h.flags & F1999.ResendList) && h.sequence === 0) {
      const list = readSeqList1999(body);
      if (list) this.onServerResendList(list);
      return;
    }
    if (h.sequence === 0) return;

    // Sequenced: apply in order.
    if (h.sequence < this.nextServerSeq || this.held.has(h.sequence)) return;
    this.received++;
    this.held.set(h.sequence, b);
    if (h.sequence > this.highestServerSeq) this.highestServerSeq = h.sequence;
    while (this.held.has(this.nextServerSeq)) {
      const p = this.held.get(this.nextServerSeq)!;
      this.held.delete(this.nextServerSeq);
      this.nextServerSeq++;
      this.applySequenced(p);
    }
  }

  private onGrant(body: Uint8Array): void {
    const grant = readGrant1999(body);
    if (!grant) return;
    const expected = this.loginProfile.clientVersion || VERSION_1999;
    if (parseFloat(grant.version) !== parseFloat(expected)) {
      // The AC1999 server's answer to a build it doesn't serve (Network.cpp:576 SendVersionRejectGrant):
      // a grant carrying its own version, which the 1999 client's exact check refuses with "You do not
      // have the current version of Asheron's Call installed." (Net_RecvLogonAccept @ 0x418550). This
      // used to raise no notice at all.
      this.emit({
        type: 'error', error: `Server version ${grant.version} does not match this client (${expected})`,
        netErrorId: 'ID_ConnectionError_NetVersionMismatch',
      });
      this.disconnect();
      return;
    }
    this.recipient = grant.adoptRecipient;
    this.granted = true;
    this.stopLoginTimer();
    this.sendControl(F1999.Connect | F1999.Checksum);
    this.emit({ type: 'handshakeComplete' });
  }

  /**
   * A NetError packet (flag 0x100000, connectionless): the AC1999 server's
   * login refusal. CNetwork::SendConnectLoginFailure (reference/ac1999/
   * Server/Source/Network.cpp:555) sends 28 bytes: the 20-byte header (seq
   * 0, flags exactly 0x100000) and {u32 error, u32 ST_SERVER_ERRORS = 8},
   * the error one of NetworkDefs.h:139-142, each the compute_str_hash of an
   * ID_ConnectionError_* token in table 0x23000010:
   *   STR_LOGIN_FAILED 0x04DF9C54 (ClientLogOnFailed): a wrong password for an
   *     existing account, a failed account query, or a failed auto-create
   *     (AuthenticateUserQuery::PerformQuery, Network.cpp:1222-1237);
   *   STR_LOGIN_SERVER_FULL 0x00F9982C (ServerFull, Network.cpp:692);
   *   STR_LOGIN_ACCOUNT_ONLINE 0x0C559B1E (PlayerAlreadyLoggedOn, Network.cpp:661);
   *   STR_LOGIN_INVALID_AUTH 0x082E3779 (BadCryptoKey): no "account:password"
   *     credential in the request (Network.cpp:1216).
   * The page shows it as it shows GDLE's refusal (serverNetError →
   * serverNetErrorNotice). It used to be CharacterError.AccountDoesntExist
   * for every reason: "The account you specified doesn't exist." for a
   * wrong password too (2026-10-12, live). The 1999 client itself ignored a
   * NetError at login and sat waiting (reference/ac1999/knowledge/kb/
   * networking/connection-handshake.md); the server's string ids name the
   * reason, so they are shown.
   * After the grant (the server never sends one there: SendCriticalError has
   * no caller) it ends the session like a server Disconnect.
   */
  private onNetError(b: Uint8Array): void {
    if (this.granted) { this.ws?.close(); return; }
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const stringId = b.length >= HEADER_SIZE_1999 + 4 ? v.getUint32(HEADER_SIZE_1999, true) : 0;
    const tableId = b.length >= HEADER_SIZE_1999 + 8 ? v.getUint32(HEADER_SIZE_1999 + 4, true) : 0;
    if (stringId === 0 && tableId === 0) return; // ID_NetError_None
    console.warn(`[1999] login refused by the server: NetError 0x${stringId.toString(16)} (table ${tableId})`);
    this.emit({
      type: 'error',
      error: `Login refused by the server (NetError 0x${stringId.toString(16)}, table ${tableId})`,
      serverNetError: { stringId, tableId },
    });
    this.disconnect();
  }

  /**
   * Every LoginRequest went unanswered (LOGIN_MAX_SENDS, LOGIN_RESEND_MS
   * apart): the end-of-retail lane's ClientTimedOutServer. The 1999 client
   * gave up too ("Server has not responded. Please try again later.", its
   * client.exe strings); this lane used to stop resending and leave the
   * connecting screen up with nothing said.
   */
  private loginTimedOut(): void {
    this.stopLoginTimer();
    this.emit({ type: 'error', error: 'Login timed out', netErrorId: 'ID_ConnectionError_ClientTimedOutServer' });
    this.disconnect();
  }

  private applySequenced(b: Uint8Array): void {
    const h = readHeader1999(b);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    // Option headers lead the body in a fixed order (Packet1999 optionBytes1999); fragments follow.
    let o = HEADER_SIZE_1999;
    if (h.flags & F1999.AckSequence) this.onServerAck(v.getUint32(o, true));
    if (h.flags & F1999.TimeUpdate) {
      const at = o + (h.flags & F1999.AckSequence ? 4 : 0);
      this.emit({ type: 'timeSync', data: v.getFloat64(at, true) });
    }
    o += optionBytes1999(h.flags);
    if (h.flags & F1999.Referral) {
      for (const f of readFragments1999(b.subarray(o))) this.onFragment(f);
    }
  }

  private onFragment(f: Fragment1999): void {
    let data: Uint8Array | null = f.data;
    if (f.count > 1) {
      const parts = this.partial.get(f.sequence) ?? new Map<number, Uint8Array>();
      parts.set(f.index, f.data);
      this.partial.set(f.sequence, parts);
      if (parts.size < f.count) return;
      const total = [...parts.values()].reduce((n, p) => n + p.length, 0);
      data = new Uint8Array(total);
      let at = 0;
      for (let i = 0; i < f.count; i++) { const p = parts.get(i)!; data.set(p, at); at += p.length; }
      this.partial.delete(f.sequence);
    }
    this.onMessage1999(data, f.group);
  }

  private onMessage1999(message: Uint8Array, group: number): void {
    const opcode = message.length >= 4 ? new DataView(message.buffer, message.byteOffset).getUint32(0, true) : 0;
    if (opcode === 0xf7b8) { this.onDddBegin(message); return; }
    if (opcode === 0xf7b7) { this.onDddFile(message); return; }
    for (const m of this.adapter?.inbound(message, group) ?? []) this.dispatchEoL(m);
  }

  /** 0xF7B8: {portalIteration, portalFiles, cellIteration, cellFiles, portalBytes, cellBytes}; sent twice (the first is sacrificial). */
  private onDddBegin(m: Uint8Array): void {
    if (m.length < 28 || this.dddFinished) return;
    const v = new DataView(m.buffer, m.byteOffset);
    this.dddIterations = { portal: v.getUint32(4, true), cell: v.getUint32(12, true) };
    this.dddExpected = v.getUint32(8, true) + v.getUint32(16, true);
    if (this.dddExpected === 0) this.finishDdd();
  }

  /** 0xF7B7: {u32 fileId, u32 dbType, u32 compressedLength, u32 rawLength, zlib data}; dbType 0–2 cell, 3+ portal. */
  private onDddFile(m: Uint8Array): void {
    const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
    const fileId = v.getUint32(4, true);
    const dbType = v.getUint32(8, true);
    const compressed = v.getUint32(12, true);
    const rawLength = v.getUint32(16, true);
    this.dddFiles.push({ dat: dbType <= 2 ? 'cell' : 'portal', fileId, compressed: m.slice(20, 20 + compressed), rawLength });
    if (this.dddFiles.length >= this.dddExpected) this.finishDdd();
  }

  private finishDdd(): void {
    if (this.dddFinished) return;
    this.dddFinished = true;
    this.emit({ type: 'datPatch1999', patches: this.dddFiles, portalIteration: this.dddIterations.portal, cellIteration: this.dddIterations.cell });
  }

  /** Emit what ClientConnection.processMessage emits for the same end-of-retail message. */
  private dispatchEoL(data: Uint8Array): void {
    try {
      this.dispatchEoLUnchecked(data);
    } catch (err) {
      console.warn(`[1999] translated message 0x${new DataView(data.buffer, data.byteOffset).getUint32(0, true).toString(16)} did not parse: ${(err as Error).message}`);
    }
  }

  private dispatchEoLUnchecked(data: Uint8Array): void {
    const msg = deserializeMessage(data);
    if (msg.type === 'event') this.emit({ type: 'gameEvent', data: msg });
    if (msg.type === 'direct') {
      switch (msg.opcode) {
        case GameMessageOpcode.CharacterList: this.emit({ type: 'characterList', data: msg.payload }); break;
        case GameMessageOpcode.CharacterError: {
          const code = msg.payload.length >= 4 ? new DataView(msg.payload.buffer, msg.payload.byteOffset).getUint32(0, true) : 0;
          this.emit({ type: 'error', error: `Server: ${characterErrorMessage(code)}`, characterError: code, loginRetryScheduled: false });
          break;
        }
        case GameMessageOpcode.CharacterCreateResponse:
          if (this.awaitingCreate) {
            this.awaitingCreate = false;
            this.emit({ type: 'characterCreateResponse', data: parseCharacterCreateResponse(msg.payload) });
          } else {
            this.emit({ type: 'characterRestoreResponse', data: parseCharacterRestoreResponse(msg.payload) });
          }
          break;
        case GameMessageOpcode.CharacterEnterWorldServerReady: this.enterWorldGranted = true; this.emit({ type: 'enterWorldReady' }); break;
        case GameMessageOpcode.CharacterLogOff: this.enterWorldGranted = false; break;
        case GameMessageOpcode.PlayerCreate: this.emit({ type: 'playerCreate', data: msg.payload }); break;
        case GameMessageOpcode.ObjectCreate: {
          const obj = parseCreateObject(msg.payload);
          if (obj) this.emit({ type: 'objectCreate', data: obj });
          break;
        }
        default: break;
      }
    }
    this.emit({ type: 'message', data: msg });
  }

  // ── Send ────────────────────────────────────────────────

  /** `queue` is the end-of-retail group; 1999 picks its own (5 actions / 6 login) per message. */
  sendMessage(messageBytes: Uint8Array, _queue?: GameMessageGroup): void {
    if (!this.adapter) return;
    const opcode = messageBytes.length >= 4 ? new DataView(messageBytes.buffer, messageBytes.byteOffset).getUint32(0, true) : 0;
    if (opcode === GameMessageOpcode.CharacterEnterWorldRequest && this.enterWorldGranted) {
      setTimeout(() => this.emit({ type: 'enterWorldReady' }), 0);
      return;
    }
    const out = this.adapter.outbound(messageBytes);
    if (!out) return;
    if (opcode === GameMessageOpcode.CharacterCreate) this.awaitingCreate = true;
    for (const { message, group } of out) {
      const frags = fragmentMessage1999(message, this.fragmentSequence++, group);
      // One fragment per packet keeps every packet under the 484-byte datagram.
      for (const f of frags) {
        if (f.length > MAX_DATA_BODY) throw new Error('1999 fragment over the datagram limit');
        this.sendData(f);
      }
    }
  }

  private sendData(fragment: Uint8Array): void {
    const seq = ++this.sequence;
    this.flowBytes += fragment.length;
    const packet = buildPacket1999({
      sequence: seq, flags: F1999.Referral | F1999.Checksum, recipient: this.recipient, time: this.serverTime,
      flowWord: this.flowBytes, body: fragment, xor: this.clientKeys.forSequence(seq),
    });
    this.resendCache.set(seq, { packet, lastSent: Date.now() });
    this.raw(packet);
  }

  private onServerAck(seq: number): void {
    for (const k of [...this.resendCache.keys()]) if (k <= seq) this.resendCache.delete(k);
  }

  /** See the file comment: everything below the named sequence is received; the named one may be a gap. */
  private onServerResendList(seqs: number[]): void {
    if (!seqs.length) return;
    const low = Math.min(...seqs);
    for (const k of [...this.resendCache.keys()]) if (k < low) this.resendCache.delete(k);
    const now = Date.now();
    for (const s of seqs) {
      const entry = this.resendCache.get(s);
      if (!entry || now - entry.lastSent < OUR_RESEND_MIN_MS) continue;
      entry.lastSent = now;
      const p = entry.packet.slice();
      const v = new DataView(p.buffer);
      v.setUint32(4, (v.getUint32(4, true) | F1999.Resent) >>> 0, true);
      v.setUint32(12, checksum1999(p, this.clientKeys.forSequence(s), 4), true);
      this.raw(p);
    }
  }

  // ── Service ─────────────────────────────────────────────

  private service(now = Date.now()): void {
    if (!this.granted) return;
    if (this.highestServerSeq >= this.nextServerSeq && now - this.lastNakAt >= NAK_MIN_MS) {
      const missing: number[] = [];
      for (let s = this.nextServerSeq; s < this.highestServerSeq && missing.length < 0x71; s++) {
        if (!this.held.has(s)) missing.push(s);
      }
      if (missing.length) {
        this.lastNakAt = now;
        this.lost += missing.length;
        this.sendControl(F1999.ResendList | F1999.Checksum, buildSeqList1999(missing));
      }
    }
    if (this.lastPacketAt && now - this.lastPacketAt > SERVER_TIMEOUT_MS) {
      this.emit({ type: 'serverTimeout' });
      this.ws?.close();
    }
  }
}

export { Group1999 };
