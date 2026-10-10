/**
 * The 1999 transport's packet layer against the REAL 1999 client's session
 * (tests/fixtures/ac1999-session-001.jsonl.gz, captured from client.exe
 * "4.35752" against the local AC1999 server; docs/ac1999-support.md):
 * every checksum, both directions, the login body byte for byte, the grant,
 * fragments and sequence lists. Runs in CI (the fixture is committed).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ISAAC } from '../packages/network/src/ISAAC.js';
import {
  buildPacket1999, buildSeqList1999, checksum1999, F1999, fragmentMessage1999, Isaac1999Keys,
  readFragments1999, readHeader1999, readSeqList1999,
} from '../packages/network/src/era1999/Packet1999.js';
import { buildLoginBody1999, readGrant1999 } from '../packages/network/src/era1999/Login1999.js';
import { withProto1999 } from '../packages/network/src/era1999/Connection1999.js';

interface Datagram { d: 'c2s' | 's2c'; b: Uint8Array }
const session: Datagram[] = gunzipSync(readFileSync(resolve(__dirname, 'fixtures', 'ac1999-session-001.jsonl.gz')))
  .toString().trim().split('\n')
  .map((l) => { const j = JSON.parse(l); return { d: j.d, b: new Uint8Array(Buffer.from(j.b, 'base64')) }; });

const keys = () => { const isaac = new ISAAC(new Uint8Array(4)); return new Isaac1999Keys(() => isaac.next()); };

describe('the 1999 checksum reproduces every captured packet', () => {
  it('ISAAC seeded 0 gives the measured server words', () => {
    const k = keys();
    expect(k.forSequence(2)).toBe(0x182600f3);
    expect(k.forSequence(3)).toBe(0x300b4a8d);
    expect(k.forSequence(1)).toBe(0);
  });

  it('server→client: every packet', () => {
    const k = keys();
    let checked = 0;
    for (const { d, b } of session) {
      if (d !== 's2c') continue;
      const h = readHeader1999(b);
      const xor = h.sequence >= 2 && (h.flags & F1999.Checksum) ? k.forSequence(h.sequence) : 0;
      expect(checksum1999(b, xor), `s2c seq ${h.sequence} flags 0x${h.flags.toString(16)}`).toBe(h.checksum);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('client→server: every checksummed packet (strobes carry none)', () => {
    const k = keys();
    let checked = 0;
    for (const { d, b } of session) {
      if (d !== 'c2s') continue;
      const h = readHeader1999(b);
      if (h.flags === (F1999.Strobe | F1999.Checksum)) { expect(h.checksum).toBe(0); continue; }
      const data = (h.flags & (F1999.OrderedData | F1999.Referral)) !== 0;
      // Only 0x800 data is keyed; the 0x22 heartbeat carries its flow word but no ISAAC word.
      const xor = (h.flags & F1999.Referral) && h.sequence >= 2 ? k.forSequence(h.sequence) : 0;
      expect(checksum1999(b, xor, data ? 4 : 0), `c2s seq ${h.sequence} flags 0x${h.flags.toString(16)}`).toBe(h.checksum);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe('login and grant', () => {
  const login = session.find((p) => p.d === 'c2s' && readHeader1999(p.b).flags === F1999.Checksum)!.b;
  const credentials = String.fromCharCode(...login.subarray(20 + 20, 20 + 40)).replace(/\0+$/, '');
  const [account, password] = credentials.split(':');

  it('the login body is the real client\'s, byte for byte, and so is the packet', () => {
    const body = buildLoginBody1999({ version: '4.35752', account, password, portalIteration: 102, cellIteration: 67 });
    expect(Array.from(body)).toEqual(Array.from(login.subarray(20)));
    const packet = buildPacket1999({ sequence: 1, flags: F1999.Checksum, recipient: 0, time: 0, body });
    expect(Array.from(packet)).toEqual(Array.from(login));
  });

  it('refuses credentials over the 20-byte field', () => {
    expect(() => buildLoginBody1999({ version: '4.35752', account: 'a'.repeat(10), password: 'b'.repeat(10), portalIteration: 1, cellIteration: 1 })).toThrow(/19/);
  });

  it('reads the grant: slot, version, world clock delta', () => {
    const grant = session.find((p) => p.d === 's2c' && readHeader1999(p.b).flags === (F1999.Connect | F1999.Checksum) && p.b.length > 20)!.b;
    const g = readGrant1999(grant.subarray(20))!;
    expect(g.version).toBe('4.35752');
    expect(g.adoptRecipient).toBe(readHeader1999(session.find((p) => p.d === 'c2s' && readHeader1999(p.b).recipient !== 0)!.b).recipient);
    expect(g.worldClockDelta).toBeGreaterThan(0);
  });

  it('builds the client control packets the real client sends (connect ack, ServerSwitch reply)', () => {
    for (const flags of [F1999.Connect | F1999.Checksum, F1999.ServerSwitch | F1999.Checksum]) {
      const real = session.find((p) => p.d === 'c2s' && readHeader1999(p.b).flags === flags)!.b;
      const h = readHeader1999(real);
      expect(Array.from(buildPacket1999({ sequence: 0, flags, recipient: h.recipient, time: h.time }))).toEqual(Array.from(real));
    }
  });
});

describe('fragments and lists', () => {
  it('reads every server data packet into whole fragments with 1999 groups (3, 4, 7)', () => {
    const groups = new Set<number>();
    for (const { d, b } of session) {
      const h = readHeader1999(b);
      if (d !== 's2c' || !(h.flags & F1999.Referral)) continue;
      const frags = readFragments1999(b.subarray(20));
      expect(frags.reduce((n, f) => n + 16 + f.data.length, 0)).toBe(h.size);
      for (const f of frags) { expect(f.id).toBe(0x80000000); groups.add(f.group); }
    }
    expect([...groups].sort()).toEqual([3, 4, 7]);
  });

  it('rebuilds the real client\'s CharacterCreate data packet exactly', () => {
    const real = session.find((p) => p.d === 'c2s' && readHeader1999(p.b).flags === (F1999.Referral | F1999.Checksum))!.b;
    const h = readHeader1999(real);
    const flow = new DataView(real.buffer, real.byteOffset).getUint32(20, true);
    const [frag] = readFragments1999(real.subarray(24));
    const rebuilt = fragmentMessage1999(frag.data, frag.sequence, frag.group);
    expect(rebuilt).toHaveLength(1);
    const packet = buildPacket1999({ sequence: h.sequence, flags: h.flags, recipient: h.recipient, time: h.time, flowWord: flow, body: rebuilt[0], xor: keys().forSequence(h.sequence) });
    expect(Array.from(packet)).toEqual(Array.from(real));
  });

  it('splits long messages at the client stride and round-trips seq lists', () => {
    const msg = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);
    const frags = fragmentMessage1999(msg, 9, 5);
    expect(frags.map((f) => f.length)).toEqual([16 + 0x1bc, 16 + 0x1bc, 16 + (1000 - 2 * 0x1bc)]);
    const back = readFragments1999(Uint8Array.from(frags.flatMap((f) => Array.from(f))));
    expect(back.map((f) => [f.count, f.index, f.group, f.sequence])).toEqual([[3, 0, 5, 9], [3, 1, 5, 9], [3, 2, 5, 9]]);
    expect(readSeqList1999(buildSeqList1999([5, 7, 9]))).toEqual([5, 7, 9]);
    const serverAck = session.find((p) => p.d === 's2c' && readHeader1999(p.b).flags === (F1999.ResendList | F1999.Checksum))!.b;
    expect(readSeqList1999(serverAck.subarray(20))).toHaveLength(1);
  });
});

describe('Connection1999 helpers', () => {
  it('checksums a Node Buffer without corrupting it (slice is a view there)', () => {
    const real = session.find((p) => p.d === 'c2s' && readHeader1999(p.b).flags === F1999.Checksum)!.b;
    const buf = Buffer.from(real);
    const before = Buffer.from(buf);
    expect(checksum1999(buf)).toBe(readHeader1999(real).checksum);
    expect(buf.equals(before)).toBe(true);
  });

  it('tells the bridge the session is 1999 (?proto=ac1999), once', () => {
    expect(withProto1999('ws://localhost:9101')).toBe('ws://localhost:9101?proto=ac1999');
    expect(withProto1999('wss://b/connect?server=x')).toBe('wss://b/connect?server=x&proto=ac1999');
    expect(withProto1999('ws://h?proto=ac1999')).toBe('ws://h?proto=ac1999');
  });
});
