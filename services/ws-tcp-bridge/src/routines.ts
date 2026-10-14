/**
 * AGENT.routine-store-auth — the game client loads and saves its account's
 * automation routines through the bridge, and a hosted bridge serves an
 * account's routines only to a session its game server logged in as that
 * account.
 *
 * Proof of login: the server's CharacterList (0xF658). ACE sends it only
 * after the password check (AuthenticationHandler.HandleLoginRequest →
 * … → GameMessageCharacterList), and it names the account as the server
 * knows it (`session.Account`), so the bridge never trusts a name the
 * client typed. The client asks for a token with the WebSocket text message
 * "routines"; the bridge answers {"routines":{token,server,account}} once
 * the CharacterList has passed, else {"routines":null,"reason":…}. The token
 * opens GET / PUT /routines (Authorization: Bearer) for that one server and
 * account while the session lives, and ten minutes after it ends.
 */
import { randomBytes } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { readPacketFlags } from './bridgeUtil.js';
import { F1999, HEADER_SIZE_1999, optionBytes1999, readFragments1999 } from '../../../packages/network/src/era1999/Packet1999.js';
import type { RoutineStore } from './routineStore.js';

const HEADER_SIZE = 20;
const FRAGMENT_HEADER_SIZE = 16;
const FLAG_BLOB_FRAGMENTS = 0x00000004;
const OPCODE_CHARACTER_LIST = 0xf658;
const MAX_BODY = 256 * 1024;
export const TOKEN_GRACE_MS = 10 * 60_000;

/** Bytes of the optional headers before a server packet's fragments (PacketBuilder.readOptionalHeaders order). */
function optionalHeaderSize(flags: number, buf: Buffer, start: number): number | null {
  let pos = start;
  if (flags & 0x100) pos += 8;
  for (const flag of [0x1000, 0x2000]) {
    if (flags & flag) {
      if (pos + 4 > buf.length) return null;
      pos += 4 + 4 * buf.readUInt32LE(pos);
    }
  }
  for (const [flag, size] of [[0x4000, 4], [0x20000, 8], [0x80000, 8], [0x400000, 8], [0x1000000, 8], [0x2000000, 4], [0x4000000, 12], [0x8000000, 6]]) {
    if (flags & flag) pos += size;
  }
  return pos <= buf.length ? pos - start : null;
}

/**
 * The account a server datagram's CharacterList names, or null. Reads every
 * single-fragment message in the packet (a CharacterList is a few hundred
 * bytes, one fragment): u32 0, u32 count, count × (u32 id, String16L name,
 * u32 delete time), u32 0, u32 slots, String16L account
 * (GameMessageCharacterList.cs).
 */
export function readCharacterListAccount(buf: Buffer): string | null {
  if (buf.length < HEADER_SIZE) return null;
  const flags = readPacketFlags(buf);
  if (!(flags & FLAG_BLOB_FRAGMENTS)) return null;
  const opt = optionalHeaderSize(flags, buf, HEADER_SIZE);
  if (opt === null) return null;
  let frag = HEADER_SIZE + opt;
  while (frag + FRAGMENT_HEADER_SIZE <= buf.length) {
    const count = buf.readUInt16LE(frag + 8);
    const size = buf.readUInt16LE(frag + 10);
    if (size < FRAGMENT_HEADER_SIZE) return null;
    const end = Math.min(buf.length, frag + size);
    const data = frag + FRAGMENT_HEADER_SIZE;
    if (count === 1 && data + 4 <= end && buf.readUInt32LE(data) === OPCODE_CHARACTER_LIST) return parseCharacterList(buf, data + 4, end);
    frag += size;
  }
  return null;
}

function parseCharacterList(buf: Buffer, start: number, end: number): string | null {
  let pos = start;
  const u32 = (): number | null => { if (pos + 4 > end) return null; const v = buf.readUInt32LE(pos); pos += 4; return v; };
  const str16 = (): string | null => {
    if (pos + 2 > end) return null;
    const n = buf.readUInt16LE(pos);
    if (pos + 2 + n > end) return null;
    const s = buf.toString('latin1', pos + 2, pos + 2 + n);
    pos += 2 + n + ((4 - ((2 + n) % 4)) % 4); // String16L pads its own length to a multiple of 4
    return s;
  };
  if (u32() === null) return null;
  const count = u32();
  if (count === null || count > 64) return null;
  for (let i = 0; i < count; i++) {
    if (u32() === null || str16() === null || u32() === null) return null;
  }
  if (u32() === null || u32() === null) return null;
  const account = str16();
  return account && /^[\x20-\x7e]{1,64}$/.test(account) ? account : null;
}

/**
 * The same for an AC1999 server: its CharacterList is u32 count, u32 0,
 * count × (u32 slot, u32 guid, AcString name, u32 deleteTimeout), u32 0,
 * char[20] account (codecs/CharSelect1999.ts), in 0x800 fragments.
 */
export function readCharacterListAccount1999(buf: Buffer): string | null {
  if (buf.length < HEADER_SIZE_1999) return null;
  const flags = buf.readUInt32LE(4);
  if (!(flags & F1999.Referral)) return null;
  const body = buf.subarray(HEADER_SIZE_1999 + optionBytes1999(flags));
  for (const f of readFragments1999(body)) {
    const d = Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength);
    if (f.count !== 1 || d.length < 12 || d.readUInt32LE(0) !== OPCODE_CHARACTER_LIST) continue;
    let pos = 4;
    const end = d.length;
    const count = d.readUInt32LE(pos); pos += 8;
    if (count > 16) return null;
    for (let i = 0; i < count; i++) {
      if (pos + 10 > end) return null;
      pos += 8; // slot, guid
      const n = d.readUInt16LE(pos);
      pos += 2 + n;
      pos += (4 - (pos % 4)) % 4; // AcString aligns to 4 in the message
      pos += 4; // delete timeout
    }
    pos += 4;
    if (pos + 20 > end) return null;
    const raw = d.subarray(pos, pos + 20);
    const z = raw.indexOf(0);
    const account = raw.toString('latin1', 0, z >= 0 ? z : 20);
    return /^[\x20-\x7e]{1,20}$/.test(account) ? account : null;
  }
  return null;
}

interface Grant { server: string; account: string; sessionId: number; expiresAt: number | null }

/** Tokens the bridge issued to logged-in sessions: one per session, valid until TOKEN_GRACE_MS after it ends. */
export class RoutineTokens {
  private readonly grants = new Map<string, Grant>();
  private readonly bySession = new Map<number, string>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(sessionId: number, server: string, account: string): string {
    const had = this.bySession.get(sessionId);
    if (had) {
      const g = this.grants.get(had);
      if (g && g.server === server && g.account === account) return had;
      this.grants.delete(had);
    }
    const token = randomBytes(24).toString('hex');
    this.grants.set(token, { server, account, sessionId, expiresAt: null });
    this.bySession.set(sessionId, token);
    return token;
  }

  /** The session ended: its token keeps working a little longer (a save as the player logs out). */
  sessionEnded(sessionId: number): void {
    const t = this.bySession.get(sessionId);
    if (!t) return;
    this.bySession.delete(sessionId);
    const g = this.grants.get(t);
    if (g) g.expiresAt = this.now() + TOKEN_GRACE_MS;
  }

  lookup(token: string): { server: string; account: string } | null {
    const g = this.grants.get(token);
    if (!g) return null;
    if (g.expiresAt !== null && this.now() > g.expiresAt) { this.grants.delete(token); return null; }
    return { server: g.server, account: g.account };
  }

  sweep(): void {
    const t = this.now();
    for (const [k, g] of this.grants) if (g.expiresAt !== null && t > g.expiresAt) this.grants.delete(k);
  }
}

/**
 * GET /routines → the token's account document (an empty one when none is
 * stored), or {unchanged: true} when ?since= names its updatedAt; PUT /routines
 * with a document → validated and stored, 422 with
 * the issues when invalid. 401 without a valid token. CORS is open (the page
 * and the bridge differ in origin); the bearer token is the gate.
 */
export function handleRoutines(req: IncomingMessage, res: ServerResponse, tokens: RoutineTokens, store: RoutineStore | null): void {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, PUT', 'access-control-allow-headers': 'authorization, content-type' };
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (!store) return send(404, { error: 'routines are not kept on this bridge' });
  if (req.method !== 'GET' && req.method !== 'PUT') return send(405, { error: 'method not allowed' });
  const auth = /^Bearer\s+([0-9a-f]{48})$/i.exec(req.headers.authorization ?? '');
  const who = auth ? tokens.lookup(auth[1].toLowerCase()) : null;
  if (!who) return send(401, { error: 'log in to the game first: the token comes from your session' });
  if (req.method === 'GET') {
    const doc = store.get(who.server, who.account);
    // ?since=<updatedAt> (the page re-checking for a change made elsewhere): the same document is not sent again.
    const since = new URL(req.url ?? '/', 'http://bridge').searchParams.get('since');
    if (since !== null && since === doc.updatedAt) return send(200, { unchanged: true, updatedAt: doc.updatedAt });
    return send(200, doc);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) tooBig = true; else chunks.push(c); });
  req.on('end', () => {
    if (tooBig) return send(413, { error: `routines are limited to ${MAX_BODY / 1024} KB` });
    let doc: unknown;
    try { doc = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'body must be JSON' }); }
    const r = store.put(who.server, who.account, doc);
    return r.ok ? send(200, r.doc) : send(422, { issues: r.issues });
  });
}
