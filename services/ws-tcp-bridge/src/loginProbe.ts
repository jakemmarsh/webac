/**
 * Live login-version detection: which LoginRequest version literal a server
 * accepts, so the launcher can pick the right era profile without a
 * per-server table (docs/dark-majesty-support.md, "Detecting a server's era").
 *
 * The probe sends ONE LoginRequest with a random account and an EMPTY
 * password and reads the server's first game message:
 *   - ClassicACE (AuthenticationHandler.cs DoLogin / AccountSelectCallback)
 *     auto-creates accounts only for a non-empty password, and checks the
 *     client version before "account doesn't exist". A wrong literal gets
 *     AccountBoot " because you are not running the correct executable file
 *     version for this server"; the right one gets CharacterError
 *     AccountDoesntExist (0x0A).
 *   - Stock ACE checks "1802" BEFORE sending ConnectRequest and boots with
 *     " because your client is not the correct version for this server…";
 *     "1802" also gets AccountDoesntExist. No account is created either way.
 * GDL/GDLE servers are never probed: they have no version check, and an
 * empty password is not known to be safe there.
 *
 * Self-contained on purpose: the bridge image bundles no workspace package
 * (Dockerfile). The LoginRequest bytes are held equal to ClientConnection's
 * by tests/verify-bridge-login-probe.ts.
 */
import * as dgram from 'dgram';
import { CHECKSUM_SENTINEL, FLAG_CONNECT_REQUEST, buildDisconnectPacket, hash32, readPacketFlags } from './bridgeUtil.js';

const FLAG_LOGIN_REQUEST = 0x00010000;
const FLAG_BLOB_FRAGMENTS = 0x00000004;
const HEADER_SIZE = 20;
const FRAGMENT_HEADER_SIZE = 16;
const NET_AUTH_ACCOUNT_PASSWORD = 2;
const OPCODE_ACCOUNT_BOOT = 0xf7dc;
const OPCODE_CHARACTER_ERROR = 0xf659;
const CHAR_ERROR_ACCOUNT_DOESNT_EXIST = 0x0a;

export type LoginVerdict =
  /** The literal passed the version check (AccountDoesntExist for the random account). */
  | { kind: 'accepted' }
  /** Booted for the version; `classicAce` from the boot's wording. */
  | { kind: 'version-rejected'; classicAce: boolean; reason: string }
  /** Any other boot or CharacterError (e.g. 0x15 server full): says nothing about the version. */
  | { kind: 'other'; detail: string }
  | { kind: 'timeout' };

function string16(s: string): Buffer {
  const bytes = Buffer.from(s, 'latin1');
  const pad = (4 - ((2 + bytes.length) % 4)) % 4;
  const out = Buffer.alloc(2 + bytes.length + pad);
  out.writeUInt16LE(bytes.length, 0);
  bytes.copy(out, 2);
  return out;
}

/**
 * A complete LoginRequest datagram (header + payload), auth type 2 with an
 * empty password, laid out as ClientConnection.sendLoginRequest lays it out.
 */
export function buildProbeLoginRequest(version: string, account: string): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt32LE(NET_AUTH_ACCOUNT_PASSWORD, 0);
  head.writeUInt32LE(0, 4); // AuthFlags
  head.writeUInt32LE(0, 8); // timestamp
  // Password String32L: length 1, packed-word length 0, then zero padding to 4.
  const password = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]);
  const rest = Buffer.concat([head, string16(account), string16(''), password]);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(rest.length, 0);
  const payload = Buffer.concat([string16(version), len, rest]);

  const pkt = Buffer.alloc(HEADER_SIZE + payload.length);
  pkt.writeUInt32LE(0, 0); // sequence 0, as every pre-handshake packet
  pkt.writeUInt32LE(FLAG_LOGIN_REQUEST, 4);
  pkt.writeUInt32LE(CHECKSUM_SENTINEL, 8);
  pkt.writeUInt16LE(0, 12); // id
  pkt.writeUInt16LE(0, 14); // time
  pkt.writeUInt16LE(payload.length, 16);
  pkt.writeUInt16LE(0, 18); // iteration
  payload.copy(pkt, HEADER_SIZE);
  const checksum = (hash32(pkt, 0, HEADER_SIZE) + hash32(pkt, HEADER_SIZE, payload.length)) >>> 0;
  pkt.writeUInt32LE(checksum, 8);
  return pkt;
}

/** Bytes of the optional headers a server packet carries before its fragments (PacketBuilder.readOptionalHeaders order). */
function optionalHeaderSize(flags: number, buf: Buffer, start: number): number | null {
  let pos = start;
  const need = (n: number) => pos + n <= buf.length;
  const fixed: Array<[number, number]> = [[0x100, 8]];
  for (const [flag, size] of fixed) if (flags & flag) { if (!need(size)) return null; pos += size; }
  for (const flag of [0x1000, 0x2000]) {
    if (flags & flag) {
      if (!need(4)) return null;
      const n = buf.readUInt32LE(pos);
      pos += 4 + 4 * n;
    }
  }
  const rest: Array<[number, number]> = [
    [0x4000, 4], [0x20000, 8], [0x80000, 8], [0x400000, 8], [0x1000000, 8], [0x2000000, 4], [0x4000000, 12], [0x8000000, 6],
  ];
  for (const [flag, size] of rest) if (flags & flag) pos += size;
  return pos <= buf.length ? pos - start : null;
}

/** The verdict a server datagram carries, or null when it carries none (ConnectRequest, ACKs…). */
export function readLoginVerdict(buf: Buffer): LoginVerdict | null {
  if (buf.length < HEADER_SIZE) return null;
  const flags = readPacketFlags(buf);
  if (!(flags & FLAG_BLOB_FRAGMENTS)) return null;
  const opt = optionalHeaderSize(flags, buf, HEADER_SIZE);
  if (opt === null) return null;
  const frag = HEADER_SIZE + opt;
  if (buf.length < frag + FRAGMENT_HEADER_SIZE + 4) return null;
  const fragSize = buf.readUInt16LE(frag + 10);
  const index = buf.readUInt16LE(frag + 12);
  if (index !== 0) return null;
  const data = frag + FRAGMENT_HEADER_SIZE;
  const end = Math.min(buf.length, frag + fragSize);
  const opcode = buf.readUInt32LE(data);
  if (opcode === OPCODE_CHARACTER_ERROR && data + 8 <= end) {
    const code = buf.readUInt32LE(data + 4);
    return code === CHAR_ERROR_ACCOUNT_DOESNT_EXIST ? { kind: 'accepted' } : { kind: 'other', detail: `CharacterError 0x${code.toString(16)}` };
  }
  if (opcode === OPCODE_ACCOUNT_BOOT) {
    let reason = '';
    if (data + 6 <= end) {
      const n = buf.readUInt16LE(data + 4);
      reason = buf.toString('latin1', data + 6, Math.min(end, data + 6 + n)).trim();
    }
    if (reason.includes('correct executable file version')) return { kind: 'version-rejected', classicAce: true, reason };
    if (reason.includes('not the correct version')) return { kind: 'version-rejected', classicAce: false, reason };
    return { kind: 'other', detail: `boot: ${reason}` };
  }
  return null;
}

export type ProbeLogin = (address: string, port: number, version: string) => Promise<LoginVerdict>;

/** One probe over UDP: send the LoginRequest, wait for the verdict, then tell the server we left. */
export const udpProbeLogin = (timeoutMs = 8000): ProbeLogin => (address, port, version) =>
  new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let clientId: number | null = null;
    let settled = false;
    const finish = (v: LoginVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ClassicACE has already sent its ConnectRequest; close that session cleanly.
      if (clientId !== null) sock.send(buildDisconnectPacket(clientId), port, address, () => sock.close());
      else sock.close();
      resolve(v);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    sock.on('error', () => finish({ kind: 'timeout' }));
    sock.on('message', (msg, rinfo) => {
      if (rinfo.address !== address) return;
      if ((readPacketFlags(msg) & FLAG_CONNECT_REQUEST) && msg.length >= HEADER_SIZE + 20) {
        clientId = msg.readUInt32LE(HEADER_SIZE + 16) & 0xffff;
      }
      const v = readLoginVerdict(msg);
      if (v) finish(v);
    });
    const account = `probe${Math.random().toString(36).slice(2, 10)}`;
    sock.send(buildProbeLoginRequest(version, account), port, address);
  });
