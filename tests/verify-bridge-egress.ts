/**
 * Per-session egress addresses (services/ws-tcp-bridge/src/egress.ts): a
 * world whose per-source-address caps every webAC player would share (the
 * AC1999 server: 2 live sessions, 2 accounts created per address) gets each
 * session bound to its own slot address, an AWS Elastic IP attached for the
 * slot's lifetime, and the bridge applies the world's rules per REAL player
 * address itself.
 *
 * Drives the real modules: the config parser, the EgressManager over a temp
 * state dir (two managers on one dir stand in for the old and new bridge
 * processes of a deploy), the AWS provider with an injected fake EC2 API and
 * IMDS, the login parsers against login packets the client's own connections
 * (ClientConnection, Connection1999) send, the directory rows, and the real
 * bridge server end to end against a fake UDP game server.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import * as dgram from 'dgram';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';
import {
  resolveBridgeConfig, resolveEgressConfig, parseEgressServers, DEFAULT_EGRESS_DIR, DEFAULT_EGRESS_GRACE_MS,
  type BridgeConfig, type EgressConfig,
} from '../services/ws-tcp-bridge/src/bridgeUtil';
import {
  EgressManager, StaticEgressProvider, AwsEgressProvider, discoverImdsSlots, imdsClient, startEgress, sdkEc2Api,
  readLoginAccount, readLoginAccount1999, readLoginAccountEor, readLoginRefusal, SESSION_STALE_MS, EGRESS_TAG,
  realIpKey, ALLOC_LOCK, RECONCILE_LOCK, PENDING_MARKER_TTL_MS, ATTACH_TRIES, READY_DEADLINE_MS, READY_POLL_MS, type Ec2Api, type TaggedAddress, type EgressLease, type EgressProvider,
} from '../services/ws-tcp-bridge/src/egress';
import {
  createBridgeServer, CLOSE_IP_CAP, CLOSE_WORLD_FULL, CLOSE_NEW_ACCOUNT_CAP, CLOSE_NEW_ACCOUNT_UNAVAILABLE, type BridgeServer,
} from '../services/ws-tcp-bridge/src/server';
import { buildDirectory } from '../services/ws-tcp-bridge/src/serverDirectory';
import type { ServerEntry } from '../services/ws-tcp-bridge/src/serverList';
import type { LogFields } from '../services/ws-tcp-bridge/src/log';
import { ClientConnection, Connection1999, EOR_LOGIN_PROFILE } from '@ac/network';
import { BRIDGE_CLOSE_IP_CAP, BRIDGE_CLOSE_WORLD_FULL, BRIDGE_CLOSE_NEW_ACCOUNT_CAP } from '../packages/network/src/BridgeRefusal';
import { buildPacket1999, fragmentMessage1999, F1999 } from '../packages/network/src/era1999/Packet1999';

// ─── Helpers ──────────────────────────────────────────

const tmpDirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'acjs-egress-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function egressConfig(dir: string, servers: string, slots: string[], over: Partial<EgressConfig> = {}): EgressConfig {
  return { worlds: parseEgressServers(servers), provider: 'static', dir, slots, graceMs: 120_000, ...over };
}

/** A clock the managers share (mtimes they compare are ones they set from it). */
function fakeClock(start = Date.now()): { now: () => number; advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

interface LogLine { level: string; event: string; fields: LogFields }
function capture(): { lines: LogLine[]; log: (level: 'debug' | 'info' | 'warn' | 'error', event: string, fields?: LogFields) => void } {
  const lines: LogLine[] = [];
  return { lines, log: (level, event, fields = {}) => { lines.push({ level, event, fields }); } };
}

async function staticManager(dir: string, servers: string, slots: string[], clock = fakeClock(), log = capture().log): Promise<EgressManager> {
  const config = egressConfig(dir, servers, slots);
  const m = new EgressManager({ config, provider: new StaticEgressProvider(slots), now: clock.now, timers: false, log });
  await m.start();
  return m;
}

async function lease(m: EgressManager, world: string, ip: string): Promise<EgressLease> {
  const r = await m.acquire(world, ip);
  if (!r.ok) throw new Error(`refused: ${r.refusal} ${r.detail}`);
  return r.lease;
}

/** Every file's bytes under `dir`, concatenated (to prove nothing is stored in clear). */
function allFileText(dir: string): string {
  let out = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out += e.isDirectory() ? `${e.name}\n${allFileText(p)}` : `${e.name}\n${fs.readFileSync(p, 'latin1')}\n`;
  }
  return out;
}

// ─── The client's own login packets ───────────────────

/** A WebSocket that records what the client sends. */
class CaptureSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: CaptureSocket | null = null;
  readyState = 0;
  binaryType = '';
  sent: Buffer[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { CaptureSocket.last = this; }
  send(d: ArrayBuffer | Uint8Array | string): void {
    if (typeof d === 'string') return;
    this.sent.push(Buffer.from(d instanceof Uint8Array ? d : new Uint8Array(d)));
  }
  close(): void { this.readyState = 3; }
}

/** The first datagram the client sends on connect: its login request, built by the client's own code. */
function clientLogin(kind: 'eor' | 'eor-colon' | 'ac1999', account: string, password: string): Buffer {
  const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = CaptureSocket;
  vi.useFakeTimers();
  const quiet = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
  try {
    const conn = kind === 'ac1999'
      ? new Connection1999('wss://bridge.example/connect?server=ac1999')
      : new ClientConnection('wss://bridge.example/connect?server=x', kind === 'eor-colon' ? { loginProfile: { ...EOR_LOGIN_PROFILE, authStyle: 'account-colon-password' } } : {});
    if (conn instanceof ClientConnection) conn.autoReconnect = false;
    conn.connect(account, password);
    const ws = CaptureSocket.last!;
    ws.readyState = 1;
    ws.onopen?.();
    const login = ws.sent.find((b) => readLoginAccount(b, kind === 'ac1999' ? 'ac1999' : 'eor').login);
    conn.disconnect();
    if (!login) throw new Error('the client sent no login');
    return login;
  } finally {
    for (const q of quiet) q.mockRestore();
    vi.useRealTimers();
    (globalThis as { WebSocket?: unknown }).WebSocket = saved;
  }
}

// ─── Config ───────────────────────────────────────────

describe('egress config (BRIDGE_EGRESS_*)', () => {
  it('is off when BRIDGE_EGRESS_SERVERS is unset or empty', () => {
    expect(resolveEgressConfig({})).toBeNull();
    expect(resolveEgressConfig({ BRIDGE_EGRESS_SERVERS: ' , ' })).toBeNull();
    expect(resolveBridgeConfig([], { BRIDGE_SERVERS_URL: 'none' }).egress).toBeNull();
  });

  it('parses worlds, provider, dir, slots and grace', () => {
    const c = resolveEgressConfig({ BRIDGE_EGRESS_SERVERS: 'AC1999:2:2, coldeve:5', BRIDGE_EGRESS_SLOTS: '10.0.0.5,10.0.0.6', BRIDGE_EGRESS_GRACE_SECONDS: '30' })!;
    expect([...c.worlds.values()]).toEqual([
      { key: 'ac1999', sessionsPerAddress: 2, newAccountsPerRealIp: 2, accountsPerAddress: 2 },
      { key: 'coldeve', sessionsPerAddress: 5, newAccountsPerRealIp: null, accountsPerAddress: null },
    ]);
    // The 4th field: the world's account creations per source address (defaults to the per-IP limit).
    expect(parseEgressServers('ac1999:2:3:2').get('ac1999')).toEqual({ key: 'ac1999', sessionsPerAddress: 2, newAccountsPerRealIp: 3, accountsPerAddress: 2 });
    expect(() => parseEgressServers('ac1999:2::2')).toThrow();
    expect(c.provider).toBe('aws');
    expect(c.dir).toBe(DEFAULT_EGRESS_DIR);
    expect(c.slots).toEqual(['10.0.0.5', '10.0.0.6']);
    expect(c.graceMs).toBe(30_000);
    const d = resolveEgressConfig({ BRIDGE_EGRESS_SERVERS: 'ac1999:2:0', BRIDGE_EGRESS_PROVIDER: 'static', BRIDGE_EGRESS_SLOTS: '127.0.0.2', BRIDGE_EGRESS_DIR: '/tmp/x' })!;
    expect(d).toMatchObject({ provider: 'static', dir: '/tmp/x', slots: ['127.0.0.2'], graceMs: DEFAULT_EGRESS_GRACE_MS });
    expect(d.worlds.get('ac1999')!.newAccountsPerRealIp).toBe(0);
    expect(resolveBridgeConfig([], { BRIDGE_SERVERS_URL: 'none', BRIDGE_EGRESS_SERVERS: 'ac1999:2:2' }).egress?.worlds.has('ac1999')).toBe(true);
  });

  it('refuses malformed settings rather than silently turning the feature off', () => {
    expect(() => parseEgressServers('ac1999')).toThrow(/BRIDGE_EGRESS_SERVERS/);
    expect(() => parseEgressServers('ac1999:0')).toThrow();
    expect(() => parseEgressServers('ac1999:two')).toThrow();
    expect(() => resolveEgressConfig({ BRIDGE_EGRESS_SERVERS: 'a:1', BRIDGE_EGRESS_PROVIDER: 'gcp' })).toThrow(/aws or static/);
    expect(() => resolveEgressConfig({ BRIDGE_EGRESS_SERVERS: 'a:1', BRIDGE_EGRESS_PROVIDER: 'static' })).toThrow(/SLOTS/);
    expect(() => resolveEgressConfig({ BRIDGE_EGRESS_SERVERS: 'a:1', BRIDGE_EGRESS_SLOTS: 'eth0' })).toThrow(/IPv4/);
  });

  it('startEgress does nothing with the feature off', async () => {
    expect(await startEgress(null, () => {})).toBeNull();
  });
});

// ─── Slot selection ───────────────────────────────────

describe('slot selection and the per-real-IP session cap', () => {
  it('one player per address while any is free, then sharing up to the world\'s limit, then full', async () => {
    const m = await staticManager(tempDir(), 'w:2', ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    const got: string[] = [];
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) got.push((await lease(m, 'w', ip)).localAddress);
    expect(got).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']); // one each
    got.push((await lease(m, 'w', '198.51.100.4')).localAddress); // then shared
    got.push((await lease(m, 'w', '198.51.100.5')).localAddress);
    got.push((await lease(m, 'w', '198.51.100.6')).localAddress);
    expect(got.slice(3).sort()).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    // Every slot carries the world's 2: full.
    const full = await m.acquire('w', '198.51.100.7');
    expect(full).toMatchObject({ ok: false, refusal: 'full' });
    await m.stop();
  });

  it('a real IP holds at most the world\'s per-address limit of sessions on it', async () => {
    const m = await staticManager(tempDir(), 'w:2,other:2', ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    const a = await lease(m, 'w', '203.0.113.9');
    const b = await lease(m, 'w', '203.0.113.9');
    expect(a.localAddress).not.toBe(b.localAddress); // its own address each, while free
    expect(await m.acquire('w', '203.0.113.9')).toMatchObject({ ok: false, refusal: 'ip_cap' });
    // The cap is per world: another egress world is unaffected, and a slot carries both worlds.
    const o = await lease(m, 'other', '203.0.113.9');
    expect(o.localAddress).toBe('10.0.0.1');
    // Releasing one frees it (release is idempotent).
    a.release(); a.release();
    expect((await m.acquire('w', '203.0.113.9')).ok).toBe(true);
    await m.stop();
  });

  it('prefers a slot that already holds an address over allocating another', async () => {
    const clock = fakeClock();
    const { api, calls } = fakeEc2();
    const m = await awsManager(tempDir(), 'w:2', api, clock);
    const a = await lease(m, 'w', '198.51.100.1'); // 10.0.1.11 gets an address
    a.release();
    // In grace: the next session (another player) reuses that slot's address, though every slot is free.
    const b = await lease(m, 'w', '198.51.100.2');
    expect(b.localAddress).toBe(a.localAddress);
    expect(b.publicIp).toBe(a.publicIp);
    expect(calls.filter((c) => c[0] === 'allocate')).toHaveLength(1);
    await m.stop();
  });
});

// ─── Cross-process ────────────────────────────────────

describe('cross-process coordination (two bridges on one state dir)', () => {
  it('both processes count each other\'s sessions', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const oldBridge = await staticManager(dir, 'w:1', ['10.0.0.1', '10.0.0.2'], clock);
    const newBridge = await staticManager(dir, 'w:1', ['10.0.0.1', '10.0.0.2'], clock);
    const a = await lease(oldBridge, 'w', '198.51.100.1');
    const b = await lease(newBridge, 'w', '198.51.100.2');
    expect(b.localAddress).not.toBe(a.localAddress);
    expect(await newBridge.acquire('w', '198.51.100.3')).toMatchObject({ ok: false, refusal: 'full' });
    expect(await oldBridge.acquire('w', '198.51.100.1')).toMatchObject({ ok: false, refusal: 'ip_cap' });
    // The old bridge's session ends: the new one may use its slot.
    a.release();
    expect((await newBridge.acquire('w', '198.51.100.3')).ok).toBe(true);
    await oldBridge.stop(); await newBridge.stop();
  });

  it('a dead process\'s session lock goes stale after 120 s and is taken over; a refreshed one stays', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const dead = await staticManager(dir, 'w:1', ['10.0.0.1'], clock);
    const live = await staticManager(dir, 'w:1', ['10.0.0.1'], clock);
    await lease(dead, 'w', '198.51.100.1');
    expect(await live.acquire('w', '198.51.100.2')).toMatchObject({ ok: false, refusal: 'full' });
    // The owner refreshes every 30 s: still live at 100 s.
    clock.advance(100_000);
    dead.refresh();
    clock.advance(100_000);
    expect(await live.acquire('w', '198.51.100.2')).toMatchObject({ ok: false, refusal: 'full' });
    // The owner died (no more refreshes): stale past SESSION_STALE_MS, removed by whoever looks.
    clock.advance(SESSION_STALE_MS + 1);
    expect(live.liveSessions()).toHaveLength(0);
    expect(fs.readdirSync(path.join(dir, 'sessions'))).toHaveLength(0);
    expect((await live.acquire('w', '198.51.100.2')).ok).toBe(true);
    await live.stop();
  });

  it('a crashed holder\'s alloc lock is taken over once stale', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const m = await staticManager(dir, 'w:1', ['10.0.0.1'], clock);
    const lockFile = path.join(dir, 'alloc.lock');
    fs.writeFileSync(lockFile, '{"pid":1}');
    const old = (clock.now() - 6_000) / 1000; // held for milliseconds: stale after a few seconds
    fs.utimesSync(lockFile, old, old);
    expect((await m.acquire('w', '198.51.100.1')).ok).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(false);
    await m.stop();
  });

  it('the salt is created once and shared; real IPs and accounts never reach the disk in clear', async () => {
    const dir = tempDir();
    const a = await staticManager(dir, 'w:2:2', ['10.0.0.1']);
    const b = await staticManager(dir, 'w:2:2', ['10.0.0.1']);
    expect(a.hash('ip', '203.0.113.77')).toBe(b.hash('ip', '203.0.113.77'));
    const l = await lease(a, 'w', '203.0.113.77');
    expect(await a.checkLogin(l, 'SecretAccountName')).toBe('ok');
    a.accountConfirmed(l, 'SecretAccountName', 0);
    const text = allFileText(dir);
    expect(text).not.toMatch(/203\.0\.113\.77/);
    expect(text.toLowerCase()).not.toContain('secretaccountname');
    await a.stop(); await b.stop();
  });
});

// ─── AWS provider ─────────────────────────────────────

/** A fake EC2 API: addresses in a map, every call recorded, failures injectable. */
function fakeEc2() {
  const calls: Array<[string, unknown]> = [];
  /** Released public IPs, handed out again last-released-first. */
  const recycled: string[] = [];
  const addresses = new Map<string, TaggedAddress & { eni: string | null; privateIp: string | null }>();
  let n = 0;
  const fail: Partial<Record<'allocate' | 'associate' | 'release' | 'describe', unknown>> & { releaseOf?: Set<string> } = {};
  /** Called on each disassociate (tests read the state dir at that moment). */
  const hooks: { onDisassociate?: (associationId: string) => void } = {};
  const api: Ec2Api = {
    async allocateAddress({ tag, instanceId }) {
      calls.push(['allocate', tag]);
      if (fail.allocate) throw fail.allocate;
      n++;
      // As AWS: a recently released address comes back to the same account first.
      const publicIp = recycled.pop() ?? `54.0.0.${n}`;
      const a = { allocationId: `eipalloc-${n}`, associationId: null, publicIp, slot: tag, eni: null, privateIp: null, instance: instanceId, networkInterfaceId: null };
      addresses.set(a.allocationId, a);
      return { allocationId: a.allocationId, publicIp: a.publicIp };
    },
    async associateAddress({ allocationId, networkInterfaceId, privateIpAddress }) {
      calls.push(['associate', { allocationId, networkInterfaceId, privateIpAddress }]);
      if (fail.associate) throw fail.associate;
      for (const a of addresses.values()) if (a.privateIp === privateIpAddress) throw Object.assign(new Error('in use'), { name: 'Resource.AlreadyAssociated' });
      const a = addresses.get(allocationId)!;
      Object.assign(a, { associationId: `eipassoc-${allocationId}`, eni: networkInterfaceId, networkInterfaceId, privateIp: privateIpAddress });
      return { associationId: a.associationId! };
    },
    async disassociateAddress({ associationId }) {
      calls.push(['disassociate', associationId]);
      hooks.onDisassociate?.(associationId);
      for (const a of addresses.values()) if (a.associationId === associationId) Object.assign(a, { associationId: null, eni: null, networkInterfaceId: null, privateIp: null });
    },
    async releaseAddress({ allocationId }) {
      calls.push(['release', allocationId]);
      if (fail.release || fail.releaseOf?.has(allocationId)) throw fail.release ?? Object.assign(new Error('nope'), { name: 'UnauthorizedOperation' });
      // As AWS: an address still associated can't be released.
      if (addresses.get(allocationId)?.associationId) throw Object.assign(new Error('in use'), { name: 'InvalidIPAddress.InUse' });
      const gone = addresses.get(allocationId);
      if (!gone || !addresses.delete(allocationId)) throw Object.assign(new Error('gone'), { name: 'InvalidAllocationID.NotFound' });
      recycled.push(gone.publicIp);
    },
    async describeTaggedAddresses() {
      calls.push(['describe', null]);
      if (fail.describe) throw fail.describe;
      return [...addresses.values()].map(({ allocationId, associationId, publicIp, slot, networkInterfaceId, instance }) => ({ allocationId, associationId, publicIp, slot, networkInterfaceId, instance }));
    },
  };
  /** Another host's address in the same account (the reconciler must never touch it). */
  const foreign = (over: Partial<TaggedAddress>) => {
    n++;
    const a = { allocationId: `eipalloc-${n}`, associationId: null, publicIp: `54.9.9.${n}`, slot: '10.0.1.11', eni: null, privateIp: null, instance: 'i-other', networkInterfaceId: null, ...over };
    addresses.set(a.allocationId, a);
    return a;
  };
  return { api, calls, addresses, fail, hooks, foreign, recycled };
}

/** IMDSv2 for an instance with a primary ENI (primary 10.0.1.10 + 2 secondaries) and a second ENI (primary + 1 secondary). */
function fakeImds(): (p: string) => Promise<string> {
  const data: Record<string, string> = {
    'instance-id': 'i-self',
    'network/interfaces/macs/': '0a:00:00:00:00:01/\n0a:00:00:00:00:02/',
    'network/interfaces/macs/0a:00:00:00:00:01/interface-id': 'eni-primary',
    'network/interfaces/macs/0a:00:00:00:00:01/local-ipv4s': '10.0.1.10\n10.0.1.11\n10.0.1.12',
    'network/interfaces/macs/0a:00:00:00:00:02/interface-id': 'eni-second',
    'network/interfaces/macs/0a:00:00:00:00:02/local-ipv4s': '10.0.2.20\n10.0.2.21',
  };
  return async (p) => { if (!(p in data)) throw new Error(`IMDS ${p}: HTTP 404`); return data[p]; };
}

async function awsManager(dir: string, servers: string, api: Ec2Api, clock = fakeClock(), log = capture().log, slots: string[] | null = null): Promise<EgressManager> {
  const config: EgressConfig = { worlds: parseEgressServers(servers), provider: 'aws', dir, slots, graceMs: 120_000 };
  const provider = new AwsEgressProvider({ ec2: api, slots, imds: fakeImds(), sleep: async () => {} });
  const m = new EgressManager({ config, provider, now: clock.now, timers: false, log });
  await m.start();
  return m;
}

describe('AWS provider (fake EC2 API + IMDS)', () => {
  it('discovers every secondary private IPv4 with its ENI, never an ENI\'s primary address', async () => {
    expect(await discoverImdsSlots(fakeImds())).toEqual([
      { address: '10.0.1.11', eni: 'eni-primary' },
      { address: '10.0.1.12', eni: 'eni-primary' },
      { address: '10.0.2.21', eni: 'eni-second' },
    ]);
    // BRIDGE_EGRESS_SLOTS narrows them, and must name real secondaries.
    const p = new AwsEgressProvider({ ec2: fakeEc2().api, slots: ['10.0.2.21'], imds: fakeImds() });
    expect(await p.discoverSlots()).toEqual([{ address: '10.0.2.21', eni: 'eni-second' }]);
    await expect(new AwsEgressProvider({ ec2: fakeEc2().api, slots: ['10.0.1.10'], imds: fakeImds() }).discoverSlots()).rejects.toThrow(/not a secondary/);
  });

  it('the real SDK client sends the documented EC2 requests (imported on first use)', async () => {
    const sdk = await import('@aws-sdk/client-ec2');
    const sent: Array<{ command: string; input: unknown }> = [];
    const outputs: Record<string, unknown> = {
      AllocateAddressCommand: { AllocationId: 'eipalloc-9', PublicIp: '54.1.2.3' },
      AssociateAddressCommand: { AssociationId: 'eipassoc-9' },
      DisassociateAddressCommand: {},
      ReleaseAddressCommand: {},
      DescribeAddressesCommand: { Addresses: [
        { AllocationId: 'eipalloc-9', PublicIp: '54.1.2.3', AssociationId: 'eipassoc-9', NetworkInterfaceId: 'eni-1', Tags: [{ Key: EGRESS_TAG, Value: '10.0.1.11' }, { Key: 'webac:egress-instance', Value: 'i-self' }] },
        { AllocationId: 'eipalloc-x' }, // no public IP: skipped
      ] },
    };
    const signals: unknown[] = [];
    const spy = vi.spyOn(sdk.EC2Client.prototype, 'send').mockImplementation((async (cmd: { constructor: { name: string }; input: unknown }, options?: { abortSignal?: unknown }) => {
      sent.push({ command: cmd.constructor.name, input: cmd.input });
      signals.push(options?.abortSignal);
      return outputs[cmd.constructor.name];
    }) as never);
    try {
      let regionAsked = 0;
      const api = sdkEc2Api(async () => { regionAsked++; return 'us-east-1'; });
      expect(await api.allocateAddress({ tag: '10.0.1.11', instanceId: 'i-self' })).toEqual({ allocationId: 'eipalloc-9', publicIp: '54.1.2.3' });
      expect(await api.associateAddress({ allocationId: 'eipalloc-9', networkInterfaceId: 'eni-1', privateIpAddress: '10.0.1.11' })).toEqual({ associationId: 'eipassoc-9' });
      await api.disassociateAddress({ associationId: 'eipassoc-9' });
      await api.releaseAddress({ allocationId: 'eipalloc-9' });
      expect(await api.describeTaggedAddresses()).toEqual([{ allocationId: 'eipalloc-9', associationId: 'eipassoc-9', publicIp: '54.1.2.3', slot: '10.0.1.11', networkInterfaceId: 'eni-1', instance: 'i-self' }]);
      expect(regionAsked).toBe(1); // one client
      // Every call carries a timeout (the SDK's HTTP handler has none by default).
      expect(signals).toHaveLength(5);
      for (const sig of signals) expect(sig).toBeInstanceOf(AbortSignal);
      expect(sent).toEqual([
        { command: 'AllocateAddressCommand', input: { Domain: 'vpc', TagSpecifications: [{ ResourceType: 'elastic-ip', Tags: [{ Key: 'webac:egress', Value: '10.0.1.11' }, { Key: 'webac:egress-instance', Value: 'i-self' }] }] } },
        { command: 'AssociateAddressCommand', input: { AllocationId: 'eipalloc-9', NetworkInterfaceId: 'eni-1', PrivateIpAddress: '10.0.1.11', AllowReassociation: false } },
        { command: 'DisassociateAddressCommand', input: { AssociationId: 'eipassoc-9' } },
        { command: 'ReleaseAddressCommand', input: { AllocationId: 'eipalloc-9' } },
        { command: 'DescribeAddressesCommand', input: { Filters: [{ Name: 'tag-key', Values: ['webac:egress'] }] } },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('IMDSv2: a session token first, then metadata GETs carrying it', async () => {
    const seen: Array<{ url: string; method?: string; headers?: Record<string, string> }> = [];
    const imds = imdsClient(async (url, init) => {
      seen.push({ url, method: init?.method, headers: init?.headers });
      const body = url.endsWith('/api/token') ? 'TOKEN123' : 'us-east-1';
      return { ok: true, status: 200, text: async () => body };
    }, 'http://imds.test');
    expect(await imds('placement/region')).toBe('us-east-1');
    expect(await imds('placement/region')).toBe('us-east-1');
    expect(seen[0]).toMatchObject({ url: 'http://imds.test/latest/api/token', method: 'PUT' });
    expect(seen[0].headers?.['X-aws-ec2-metadata-token-ttl-seconds']).toBe('21600');
    expect(seen.slice(1).map((s) => s.headers?.['X-aws-ec2-metadata-token'])).toEqual(['TOKEN123', 'TOKEN123']); // one token, reused
  });

  it('a slot\'s first session allocates (tagged with the slot) and associates before acquire resolves; the last one releases after the grace', async () => {
    const clock = fakeClock();
    const { api, calls, addresses } = fakeEc2();
    const cap = capture();
    const m = await awsManager(tempDir(), 'ac1999:2:2', api, clock, cap.log);
    calls.length = 0;
    const l = await lease(m, 'ac1999', '198.51.100.1');
    expect(calls.map((c) => c[0])).toEqual(['allocate', 'associate']);
    expect(calls[0][1]).toBe('10.0.1.11');
    expect(calls[1][1]).toEqual({ allocationId: 'eipalloc-1', networkInterfaceId: 'eni-primary', privateIpAddress: '10.0.1.11' });
    expect(l).toMatchObject({ localAddress: '10.0.1.11', publicIp: '54.0.0.1', accountRule: true });
    expect(cap.lines.find((x) => x.event === 'egress_acquire')?.fields).toMatchObject({ slot: '10.0.1.11', publicIp: '54.0.0.1' });
    expect(cap.lines.find((x) => x.event === 'egress_associate')?.fields).toMatchObject({ publicIp: '54.0.0.1', allocationId: 'eipalloc-1' });
    l.release();
    // Within the grace: kept.
    clock.advance(60_000);
    expect(await m.releaseIfIdle('10.0.1.11')).toBe('busy');
    expect(addresses.size).toBe(1);
    // Past it: disassociated, released, logged.
    clock.advance(61_000);
    expect(await m.releaseIfIdle('10.0.1.11')).toBe('released');
    expect(calls.slice(-2).map((c) => c[0])).toEqual(['disassociate', 'release']);
    expect(addresses.size).toBe(0);
    expect(cap.lines.find((x) => x.event === 'egress_release')?.fields).toMatchObject({ slot: '10.0.1.11', publicIp: '54.0.0.1', ok: true });
    await m.stop();
  });

  it('a new session within the grace reuses the address, and keeps it', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const { api, calls, addresses } = fakeEc2();
    const oldBridge = await awsManager(dir, 'ac1999:2', api, clock);
    const newBridge = await awsManager(dir, 'ac1999:2', api, clock);
    const a = await lease(oldBridge, 'ac1999', '198.51.100.1');
    a.release();
    clock.advance(100_000);
    // The other process picks the slot up inside the grace: no allocation, same public IP.
    const b = await lease(newBridge, 'ac1999', '198.51.100.2');
    expect(b.publicIp).toBe(a.publicIp);
    expect(calls.filter((c) => c[0] === 'allocate')).toHaveLength(1);
    clock.advance(100_000);
    expect(await oldBridge.releaseIfIdle(a.localAddress)).toBe('busy'); // b is on it
    b.release();
    clock.advance(121_000);
    expect(await oldBridge.releaseIfIdle(a.localAddress)).toBe('released');
    expect(await newBridge.releaseIfIdle(a.localAddress)).toBe('none'); // the second check finds nothing to do
    expect(addresses.size).toBe(0);
    await oldBridge.stop(); await newBridge.stop();
  });

  it('AWS errors refuse the session as full, never throw, and leave nothing behind', async () => {
    const dir = tempDir();
    const { api, fail, calls, addresses } = fakeEc2();
    const cap = capture();
    const m = await awsManager(dir, 'ac1999:2', api, fakeClock(), cap.log);
    fail.allocate = Object.assign(new Error('The maximum number of addresses has been reached.'), { name: 'AddressLimitExceeded' });
    expect(await m.acquire('ac1999', '198.51.100.1')).toEqual({ ok: false, refusal: 'full', detail: 'aws:AddressLimitExceeded' });
    expect(cap.lines.find((x) => x.event === 'egress_refused')?.fields).toMatchObject({ refusal: 'full', reason: 'aws:AddressLimitExceeded' });
    expect(fs.readdirSync(path.join(dir, 'sessions'))).toHaveLength(0);
    // Associate fails after a successful allocate: that address is given back at once.
    delete fail.allocate;
    fail.associate = Object.assign(new Error('Rate exceeded'), { name: 'RequestLimitExceeded' });
    expect(await m.acquire('ac1999', '198.51.100.1')).toMatchObject({ ok: false, refusal: 'full', detail: 'aws:RequestLimitExceeded' });
    expect(calls.filter((c) => c[0] === 'release')).toHaveLength(1);
    expect(addresses.size).toBe(0);
    expect(fs.readdirSync(path.join(dir, 'slots')).filter((f) => f.endsWith('.addr.json'))).toHaveLength(0);
    // And it recovers once AWS does.
    delete fail.associate;
    expect((await m.acquire('ac1999', '198.51.100.1')).ok).toBe(true);
    // A release that fails is logged, not thrown.
    await m.stop();
  });

  it('a failing release during the idle check is logged, not thrown', async () => {
    const clock = fakeClock();
    const { api, fail } = fakeEc2();
    const cap = capture();
    const m = await awsManager(tempDir(), 'ac1999:2', api, clock, cap.log);
    const l = await lease(m, 'ac1999', '198.51.100.1');
    l.release();
    clock.advance(121_000);
    fail.release = Object.assign(new Error('nope'), { name: 'UnauthorizedOperation' });
    expect(await m.releaseIfIdle(l.localAddress)).toBe('error');
    expect(cap.lines.some((x) => x.event === 'egress_release' && x.fields.ok === false && x.fields.reason === 'aws:UnauthorizedOperation')).toBe(true);
    await m.stop();
  });
});

// ─── Reconciler ───────────────────────────────────────

describe('reconciler', () => {
  it('releases only orphaned tagged addresses: idle past the grace, or not the one the slot uses', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const { api, addresses, calls } = fakeEc2();
    const cap = capture();
    const m = await awsManager(dir, 'ac1999:2', api, clock, cap.log);
    // A live session's address on 10.0.1.11.
    const live = await lease(m, 'ac1999', '198.51.100.1');
    // A crash left unrecorded tagged addresses: one for 10.0.1.12, a duplicate for 10.0.1.11, and one for 10.0.2.21.
    const orphan = await api.allocateAddress({ tag: '10.0.1.12', instanceId: 'i-self' });
    const dup = await api.allocateAddress({ tag: '10.0.1.11', instanceId: 'i-self' });
    const idleOrphan = await api.allocateAddress({ tag: '10.0.2.21', instanceId: 'i-self' });
    // 10.0.1.12 was used a moment ago (its own recorded address is in its grace period).
    const recent = await lease(m, 'ac1999', '198.51.100.2');
    expect(recent.localAddress).toBe('10.0.1.12');
    const recentAddr = recent.publicIp;
    recent.release();
    calls.length = 0;
    const r = await m.reconcile();
    // Kept: the live session's address and 10.0.1.12's recorded one (in grace). Released: the
    // addresses no record names on a slot that has one, and the never-used slot's orphan.
    expect(addresses.has('eipalloc-1')).toBe(true);
    expect([...addresses.values()].some((a) => a.publicIp === recentAddr)).toBe(true);
    expect(addresses.has(dup.allocationId)).toBe(false);
    expect(addresses.has(orphan.allocationId)).toBe(false);
    expect(addresses.has(idleOrphan.allocationId)).toBe(false);
    expect(r).toMatchObject({ released: 3 });
    // Past the grace: 10.0.1.12's address goes too; the live one still stays.
    clock.advance(121_000);
    m.refresh();
    const r2 = await m.reconcile();
    expect(r2).toMatchObject({ released: 1 });
    expect([...addresses.keys()]).toEqual(['eipalloc-1']);
    expect(live.publicIp).toBe('54.0.0.1');
    expect(cap.lines.filter((x) => x.event === 'egress_reconcile').length).toBeGreaterThanOrEqual(3); // start + 2
    await m.stop();
  });

  it('adopts an associated address whose record was lost while sessions use it, and forgets a record whose address is gone', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const { api, addresses } = fakeEc2();
    const m = await awsManager(dir, 'ac1999:2', api, clock);
    const l = await lease(m, 'ac1999', '198.51.100.1');
    const addrFile = path.join(dir, 'slots', `${l.localAddress}.addr.json`);
    fs.unlinkSync(addrFile);
    clock.advance(1000);
    expect(await m.reconcile()).toMatchObject({ adopted: 1, released: 0 });
    expect(JSON.parse(fs.readFileSync(addrFile, 'utf8')).publicIp).toBe(l.publicIp);
    // Someone released it by hand. Never forgotten under live sessions, and only after two
    // consecutive listings miss it (listings are eventually consistent).
    addresses.clear();
    clock.advance(1000);
    expect(await m.reconcile()).toMatchObject({ forgotten: 0 });
    expect(await m.reconcile()).toMatchObject({ forgotten: 0 });
    expect(fs.existsSync(addrFile)).toBe(true);
    l.release();
    expect(await m.reconcile()).toMatchObject({ forgotten: 0 }); // one miss
    expect(fs.existsSync(addrFile)).toBe(true);
    expect(await m.reconcile()).toMatchObject({ forgotten: 1 }); // two
    expect(fs.existsSync(addrFile)).toBe(false);
    await m.stop();
  });

  it('runs one at a time across processes (reconcile.lock), takes over a stale lock, and survives AWS failures', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const { api, fail, calls } = fakeEc2();
    const m = await awsManager(dir, 'ac1999:2', api, clock);
    const lockFile = path.join(dir, 'reconcile.lock');
    fs.writeFileSync(lockFile, '{"pid":2}');
    const fresh = clock.now() / 1000;
    fs.utimesSync(lockFile, fresh, fresh);
    calls.length = 0;
    expect(await m.reconcile()).toBeNull(); // the other process is reconciling
    expect(calls).toEqual([]);
    clock.advance(11 * 60_000); // its holder died
    expect(await m.reconcile()).not.toBeNull();
    fail.describe = Object.assign(new Error('Throttled'), { name: 'Throttling' });
    expect(await m.reconcile()).toBeNull();
    expect(fs.existsSync(lockFile)).toBe(false);
    await m.stop();
  });

  it('the static provider has nothing to reconcile', async () => {
    const m = await staticManager(tempDir(), 'w:1', ['10.0.0.1']);
    expect(await m.reconcile()).toBeNull();
    await m.stop();
  });
});

// ─── Login requests ───────────────────────────────────

describe('the account a login request names (the client\'s own packets)', () => {
  it('end of retail (ACE, auth type 2): the Account string', () => {
    const pkt = clientLogin('eor', 'PlayerOne', 'hunter22');
    expect(readLoginAccountEor(pkt)).toEqual({ login: true, account: 'PlayerOne' });
    expect(readLoginAccount(pkt, 'eor')).toEqual({ login: true, account: 'PlayerOne' });
    // Odd lengths pad differently; still read.
    expect(readLoginAccountEor(clientLogin('eor', 'abc', 'x')).account).toBe('abc');
  });

  it('end of retail, "-a account:password" (auth type 1): the part before the colon', () => {
    const pkt = clientLogin('eor-colon', 'Classic', 'pw:with:colons');
    expect(readLoginAccountEor(pkt)).toEqual({ login: true, account: 'Classic' });
  });

  it('1999: the credential field after the 0xBEEFBEEF marker, as the AC1999 server reads it', () => {
    const pkt = clientLogin('ac1999', 'oldtimer', 'pw');
    expect(readLoginAccount1999(pkt)).toEqual({ login: true, account: 'oldtimer' });
    // The 20-byte field truncates: an account that leaves no ':' in it logs nobody in.
    expect(readLoginAccount1999(clientLogin('ac1999', 'abcdefghijklmnopqrst', 'pw'))).toEqual({ login: true, account: null });
    // 19 characters + ':' just fits.
    expect(readLoginAccount1999(clientLogin('ac1999', 'abcdefghijklmnopqrs', 'pw')).account).toBe('abcdefghijklmnopqrs');
  });

  it('other datagrams are not logins', () => {
    // 1999: the pre-login strobe, a sequenced packet to a slot, a grant-shaped packet.
    expect(readLoginAccount1999(Buffer.from(buildPacket1999({ sequence: 0, flags: 0x8002, recipient: 0, time: 0 })))).toEqual({ login: false, account: null });
    const login = clientLogin('ac1999', 'oldtimer', 'pw');
    const toSlot = Buffer.from(login); toSlot.writeUInt32LE(5, 8);
    expect(readLoginAccount1999(toSlot).login).toBe(false);
    const runt = login.subarray(0, 40);
    expect(readLoginAccount1999(runt).login).toBe(false); // the server drops a runt
    // End of retail: no LoginRequest flag.
    const eor = Buffer.from(clientLogin('eor', 'PlayerOne', 'pw'));
    eor.writeUInt32LE(0x4, 4);
    expect(readLoginAccountEor(eor).login).toBe(false);
    expect(readLoginAccountEor(Buffer.alloc(10)).login).toBe(false);
  });
});

// ─── New accounts per real IP ─────────────────────────

describe('new accounts per real IP (only accounts this bridge saw being created count)', () => {
  it('existing accounts never count: a player\'s third old account (with characters) still logs in', async () => {
    const m = await staticManager(tempDir(), 'ac1999:2:2', ['10.0.0.1', '10.0.0.2']);
    for (const [name, chars] of [['old1', 3], ['old2', 1], ['old3', 2]] as const) {
      const l = await lease(m, 'ac1999', '203.0.113.1');
      expect(await m.checkLogin(l, name)).toBe('ok');
      m.accountConfirmed(l, name, chars); // the character list lists its characters: it existed
      l.release();
    }
    // None of them used the allowance: two new accounts still may be created.
    for (const name of ['new1', 'new2']) {
      const l = await lease(m, 'ac1999', '203.0.113.1');
      expect(await m.checkLogin(l, name)).toBe('ok');
      m.accountConfirmed(l, name, 0); // a just-created account lists none
      l.release();
    }
    const l = await lease(m, 'ac1999', '203.0.113.1');
    expect(await m.checkLogin(l, 'new3')).toBe('new_account_cap'); // the third creation
    expect(await m.checkLogin(l, 'OLD1')).toBe('ok'); // known accounts (any case) always log in
    expect(await m.checkLogin(l, 'New2')).toBe('ok');
    // Documented edge: an existing account first seen through webAC once the IP is at its limit is refused
    // (the gate can't tell it from a creation before the server answers).
    expect(await m.checkLogin(l, 'old4-never-seen')).toBe('new_account_cap');
    // Another real IP has its own allowance, and may log into any known account.
    const r2 = await lease(m, 'ac1999', '203.0.113.2');
    expect(await m.checkLogin(r2, 'new1')).toBe('ok');
    expect(await m.checkLogin(r2, 'new3')).toBe('ok');
    await m.stop();
  });

  it('an account another session recorded first does not count for this one', async () => {
    const m = await staticManager(tempDir(), 'ac1999:2:1', ['10.0.0.1', '10.0.0.2']);
    const a = await lease(m, 'ac1999', '203.0.113.1');
    const b = await lease(m, 'ac1999', '203.0.113.2');
    expect(await m.checkLogin(a, 'shared')).toBe('ok');
    m.accountConfirmed(b, 'shared', 0); // b's character list arrived first (b logged in without a check here)
    m.accountConfirmed(a, 'shared', 0);
    // Neither IP used its one creation.
    expect(await m.checkLogin(a, 'mine')).toBe('ok');
    await m.stop();
  });

  it('a login for an unknown account counts at once, across processes, and stays counted if the session closes before its character list', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const a = await staticManager(dir, 'ac1999:2:1', ['10.0.0.1', '10.0.0.2'], clock);
    const b = await staticManager(dir, 'ac1999:2:1', ['10.0.0.1', '10.0.0.2'], clock);
    const s1 = await lease(a, 'ac1999', '203.0.113.5');
    const s2 = await lease(b, 'ac1999', '203.0.113.5');
    expect(await a.checkLogin(s1, 'first')).toBe('ok'); // reserved, not yet confirmed
    expect(a.loginAllowed(s1, 'first')).toBe(true); // the client's login resends pass without a lock
    expect(await b.checkLogin(s2, 'second')).toBe('new_account_cap'); // the first login counts
    // The server created 'first' while handling the login; closing before the character list
    // must not hand the allowance back (the bypass the marker closes).
    s1.release();
    expect(await b.checkLogin(s2, 'second')).toBe('new_account_cap');
    // The same name again from this IP is the same (counted) account, not a new one.
    expect(await b.checkLogin(s2, 'FIRST')).toBe('ok');
    // Its character list resolves it: characters listed means it existed, so the marker goes.
    b.accountConfirmed(s2, 'first', 2);
    expect(await b.checkLogin(s2, 'second')).toBe('ok');
    await a.stop(); await b.stop();
  });

  it('a world without the rule never limits logins', async () => {
    const m = await staticManager(tempDir(), 'w:2', ['10.0.0.1']);
    const l = await lease(m, 'w', '203.0.113.1');
    expect(l.accountRule).toBe(false);
    for (const n of ['a', 'b', 'c', 'd']) expect(await m.checkLogin(l, n)).toBe('ok');
    await m.stop();
  });
});

// ─── Directory rows ───────────────────────────────────

describe('directory rows of an egress world', () => {
  it('drop the shared per-address warning and limits', () => {
    const servers: ServerEntry[] = [{ id: 'ac1999', name: 'AC1999', emu: 'AC1999', host: 'ac1999.example', port: 9000, source: 'overlay' }];
    const plain = buildDirectory(servers, new Map(), new Map(), { now: Date.now() })[0];
    expect(plain.perIpLimits).toEqual({ accounts: 2, sessions: 2 });
    expect(plain.compatWarning).toMatch(/Existing accounts only/);
    const egress = buildDirectory(servers, new Map(), new Map(), { now: Date.now(), egressWorlds: new Set(['ac1999']) })[0];
    expect(egress.perIpLimits).toBeNull();
    expect(egress.compatWarning).toBeNull();
    expect(egress.era).toBe(plain.era);
  });
});

// ─── The real bridge, end to end ──────────────────────

interface FakeServer { port: number; sock: dgram.Socket; msgs: { msg: Buffer; rinfo: dgram.RemoteInfo }[]; close(): void }

async function fakeServer(): Promise<FakeServer> {
  const sock = dgram.createSocket('udp4');
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  const f: FakeServer = { port: sock.address().port, sock, msgs: [], close: () => { try { sock.close(); } catch { /* */ } } };
  sock.on('message', (msg, rinfo) => f.msgs.push({ msg, rinfo }));
  return f;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Open a session as `realIp` (the trusted proxy's X-Forwarded-For); resolves on open or with the close code of a refusal. */
function openAs(url: string, realIp: string): Promise<{ ws: WebSocket; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { 'x-forwarded-for': realIp } });
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    ws.once('open', () => resolve({ ws, closed }));
    ws.once('unexpected-response', (_q, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

function str16(s: string): Buffer {
  const b = Buffer.from(s, 'latin1');
  const out = Buffer.alloc(2 + b.length + ((4 - ((2 + b.length) % 4)) % 4));
  out.writeUInt16LE(b.length, 0);
  b.copy(out, 2);
  return out;
}
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };

/** ACE's CharacterList (0xF658) naming `account` and its characters, in one fragment. */
function characterListEor(account: string, names: string[] = []): Buffer {
  const body = Buffer.concat([
    u32(0xf658), u32(0), u32(names.length), ...names.flatMap((n, i) => [u32(0x50000001 + i), str16(n), u32(0)]),
    u32(0), u32(11), str16(account), u32(1), u32(1),
  ]);
  const frag = Buffer.concat([u32(7), u32(0x80000001), Buffer.from([1, 0]), Buffer.alloc(2), Buffer.alloc(4), body]);
  frag.writeUInt16LE(frag.length, 10);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(3, 0);
  head.writeUInt32LE(0x4, 4);
  return Buffer.concat([head, frag]);
}

/** The AC1999 server's CharacterList: opcode, count 0, a word, a word, then the 20-byte account. */
function characterList1999(account: string): Buffer {
  const name = Buffer.alloc(20);
  name.write(account, 'latin1');
  const msg = Buffer.concat([u32(0xf658), u32(0), u32(0), u32(0), name, u32(0)]);
  const frags = fragmentMessage1999(msg, 1, 0);
  return Buffer.from(buildPacket1999({ sequence: 2, flags: F1999.Referral | F1999.Checksum, recipient: 0x0b, time: 1, body: Buffer.concat(frags.map((f) => Buffer.from(f))) }));
}

function bridgeConfig(env: Record<string, string>, port: number): BridgeConfig {
  const c = resolveBridgeConfig(['0', '127.0.0.1', String(port)], {
    BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none', BRIDGE_TRUST_PROXY: '1', BRIDGE_ROUTINES_DIR: 'none', ...env,
  });
  c.wsPort = 0;
  return c;
}

describe('bridge end to end (static provider, one slot on 127.0.0.1)', () => {
  let server: FakeServer;
  let bridge: BridgeServer | null = null;
  let manager: EgressManager | null = null;
  const sockets: WebSocket[] = [];
  beforeEach(async () => { server = await fakeServer(); });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    if (bridge) await bridge.shutdown();
    bridge = null;
    server.close();
  });

  async function start(env: Record<string, string>): Promise<string> {
    const config = bridgeConfig({ BRIDGE_EGRESS_PROVIDER: 'static', BRIDGE_EGRESS_SLOTS: '127.0.0.1', BRIDGE_EGRESS_DIR: tempDir(), ...env }, server.port);
    manager = await startEgress(config.egress, () => {});
    bridge = createBridgeServer(config, { log: () => {}, egress: manager });
    return `ws://127.0.0.1:${await bridge.listen()}/`;
  }
  async function session(url: string, ip: string): Promise<{ ws: WebSocket; closed: Promise<number> }> {
    const s = await openAs(url, ip);
    sockets.push(s.ws);
    return s;
  }

  it('refusals close with the codes the client maps: the per-real-IP session cap, and no free slot', async () => {
    expect(CLOSE_IP_CAP).toBe(BRIDGE_CLOSE_IP_CAP);
    expect(CLOSE_WORLD_FULL).toBe(BRIDGE_CLOSE_WORLD_FULL);
    expect(CLOSE_NEW_ACCOUNT_CAP).toBe(BRIDGE_CLOSE_NEW_ACCOUNT_CAP);
    const url = await start({ BRIDGE_EGRESS_SERVERS: 'pinned:2' });
    await session(url, '203.0.113.1');
    await session(url, '203.0.113.1');
    const third = await session(url, '203.0.113.1');
    expect(await third.closed).toBe(CLOSE_IP_CAP);
    // The one slot carries the world's 2: another player is told the world is full.
    const other = await session(url, '203.0.113.2');
    expect(await other.closed).toBe(CLOSE_WORLD_FULL);
    expect(bridge!.metrics.rejects.get('egress_ip_cap')).toBe(1);
    expect(bridge!.metrics.rejects.get('egress_full')).toBe(1);
    expect(bridge!.snapshot().sessions).toBe(2); // refusals never count as sessions
  });

  it('end of retail: a new account over the real IP\'s limit is closed before its login reaches the server', async () => {
    const url = await start({ BRIDGE_EGRESS_SERVERS: 'pinned:2:1:99' }) /* the one shared slot: no per-address creation limit here */;
    const a = await session(url, '203.0.113.1');
    a.ws.send(clientLogin('eor', 'Alpha', 'pw'));
    await until(() => server.msgs.length === 1);
    // The server names the account in its CharacterList: Alpha now exists and counts for this IP.
    const r = server.msgs[0].rinfo;
    server.sock.send(characterListEor('Alpha'), r.port, r.address);
    await new Promise((res) => a.ws.once('message', res));
    const b = await session(url, '203.0.113.1');
    b.ws.send(clientLogin('eor', 'Beta', 'pw'));
    expect(await b.closed).toBe(CLOSE_NEW_ACCOUNT_CAP);
    expect(server.msgs).toHaveLength(1); // Beta's login never left the bridge
    a.ws.close();
    await until(() => bridge!.snapshot().sessions === 0);
    // A known account logs in from the same IP, any case.
    const c = await session(url, '203.0.113.1');
    c.ws.send(clientLogin('eor', 'ALPHA', 'pw'));
    await until(() => server.msgs.some((m) => readLoginAccountEor(m.msg).account === 'ALPHA'));
    // Another IP may make its own.
    const d = await session(url, '203.0.113.9');
    d.ws.send(clientLogin('eor', 'Beta', 'pw'));
    await until(() => server.msgs.some((m) => readLoginAccountEor(m.msg).account === 'Beta'));
    expect(bridge!.metrics.rejects.get('egress_new_account_cap')).toBe(1);
  });

  it('an existing account (characters listed) never uses the allowance; packets behind a login check go after it, in order', async () => {
    const url = await start({ BRIDGE_EGRESS_SERVERS: 'pinned:2:1:99' }) /* the one shared slot: no per-address creation limit here */;
    const a = await session(url, '203.0.113.1');
    const login = clientLogin('eor', 'Veteran', 'pw');
    const next = Buffer.alloc(24); next.writeUInt32LE(2, 0); next.writeUInt32LE(0x4, 4);
    a.ws.send(login);
    a.ws.send(next); // arrives while the login's check is under way
    await until(() => server.msgs.length === 2);
    expect(server.msgs[0].msg.equals(login)).toBe(true);
    expect(server.msgs[1].msg.equals(next)).toBe(true);
    const r = server.msgs[0].rinfo;
    server.sock.send(characterListEor('Veteran', ['Sir Vet', 'Alt']), r.port, r.address);
    await new Promise((res) => a.ws.once('message', res));
    // The same IP may still create its one account.
    const b = await session(url, '203.0.113.1');
    b.ws.send(clientLogin('eor', 'Fresh', 'pw'));
    await until(() => server.msgs.some((m) => readLoginAccountEor(m.msg).account === 'Fresh'));
  });

  it('closing before the character list does not hand back the allowance (the server already made the account)', async () => {
    const url = await start({ BRIDGE_EGRESS_SERVERS: 'pinned:2:1:99' }) /* the one shared slot: no per-address creation limit here */;
    const a = await session(url, '203.0.113.1');
    a.ws.send(clientLogin('eor', 'Ghost', 'pw'));
    await until(() => server.msgs.length === 1);
    a.ws.close(); // gone before the server's character list
    await until(() => bridge!.snapshot().sessions === 0);
    const b = await session(url, '203.0.113.1');
    b.ws.send(clientLogin('eor', 'Another', 'pw'));
    expect(await b.closed).toBe(CLOSE_NEW_ACCOUNT_CAP);
    expect(server.msgs).toHaveLength(1);
  });

  it('an egress state failure closes only that session (world_full), never the bridge', async () => {
    const url = await start({ BRIDGE_EGRESS_SERVERS: 'pinned:2:1:99' }) /* the one shared slot: no per-address creation limit here */;
    const boom = vi.spyOn(manager!, 'checkLogin').mockRejectedValueOnce(new Error('egress: alloc.lock is held'));
    const a = await session(url, '203.0.113.1');
    a.ws.send(clientLogin('eor', 'Alpha', 'pw'));
    expect(await a.closed).toBe(CLOSE_WORLD_FULL);
    boom.mockRestore();
    // accountConfirmed throwing (the state dir) inside the UDP handler: the same.
    const confirm = vi.spyOn(manager!, 'accountConfirmed').mockImplementationOnce(() => { throw new Error('EACCES'); });
    const b = await session(url, '203.0.113.2');
    b.ws.send(clientLogin('eor', 'Beta', 'pw'));
    await until(() => server.msgs.some((m) => readLoginAccountEor(m.msg).account === 'Beta'));
    const r = server.msgs[server.msgs.length - 1].rinfo;
    server.sock.send(characterListEor('Beta'), r.port, r.address);
    expect(await b.closed).toBe(CLOSE_WORLD_FULL);
    confirm.mockRestore();
    // The bridge still serves.
    const c = await session(url, '203.0.113.3');
    c.ws.send(clientLogin('eor', 'Gamma', 'pw'));
    await until(() => server.msgs.some((m) => readLoginAccountEor(m.msg).account === 'Gamma'));
  });

  it('a failed egress start refuses its world as full and leaves every other world working', async () => {
    const config = bridgeConfig({ BRIDGE_EGRESS_SERVERS: 'pinned:2', BRIDGE_EGRESS_PROVIDER: 'static', BRIDGE_EGRESS_SLOTS: '127.0.0.1', BRIDGE_EGRESS_DIR: tempDir() }, server.port);
    const cap = capture();
    const broken: EgressProvider = new (class extends StaticEgressProvider {
      override async discoverSlots(): Promise<never> { throw new Error('IMDS unreachable'); }
    })([]);
    manager = await startEgress(config.egress, cap.log, broken);
    expect(manager!.disabled).toMatch(/IMDS unreachable/);
    expect(cap.lines.find((l) => l.event === 'egress_start_failed')).toMatchObject({ level: 'error' });
    bridge = createBridgeServer(config, { log: () => {}, egress: manager });
    const url = `ws://127.0.0.1:${await bridge.listen()}/`;
    const a = await session(url, '203.0.113.1');
    expect(await a.closed).toBe(CLOSE_WORLD_FULL);
    await bridge.shutdown();
    // The same bridge config with egress for another world: this one plays on.
    const other = bridgeConfig({ BRIDGE_EGRESS_SERVERS: 'elsewhere:2', BRIDGE_EGRESS_PROVIDER: 'static', BRIDGE_EGRESS_SLOTS: '127.0.0.1', BRIDGE_EGRESS_DIR: tempDir() }, server.port);
    bridge = createBridgeServer(other, { log: () => {}, egress: await startEgress(other.egress, () => {}, broken) });
    const url2 = `ws://127.0.0.1:${await bridge.listen()}/`;
    const b = await session(url2, '203.0.113.1');
    b.ws.send(clientLogin('eor', 'Anyone', 'pw'));
    await until(() => server.msgs.some((m) => readLoginAccountEor(m.msg).account === 'Anyone'));
  });

  it('1999: the same rule with the 1999 client\'s login and character list', async () => {
    const url = await start({ BRIDGE_EGRESS_SERVERS: 'pinned:2:1:99', BRIDGE_ERA: 'ac1999-retail' });
    const a = await session(url, '203.0.113.1');
    a.ws.send(clientLogin('ac1999', 'oldtimer', 'pw'));
    await until(() => server.msgs.length === 1);
    const r = server.msgs[0].rinfo;
    server.sock.send(characterList1999('oldtimer'), r.port, r.address);
    await new Promise((res) => a.ws.once('message', res));
    const b = await session(url, '203.0.113.1');
    b.ws.send(clientLogin('ac1999', 'newbie', 'pw'));
    expect(await b.closed).toBe(CLOSE_NEW_ACCOUNT_CAP);
    expect(server.msgs.filter((m) => readLoginAccount1999(m.msg).login)).toHaveLength(1);
  });
});

/** Whether this host can bind loopback aliases (Linux: all of 127/8; macOS: only 127.0.0.1 unless aliased). */
async function canBind(address: string): Promise<boolean> {
  const s = dgram.createSocket('udp4');
  try {
    await new Promise<void>((resolve, reject) => { s.once('error', reject); s.bind(0, address, () => resolve()); });
    return true;
  } catch { return false; } finally { try { s.close(); } catch { /* */ } }
}
const aliasesBindable = (await canBind('127.0.0.2')) && (await canBind('127.0.0.3'));

describe.skipIf(!aliasesBindable)('bridge end to end: two slots, two source addresses (127.0.0.2 / 127.0.0.3)', () => {
  it('the game server sees each session from its own slot address', async () => {
    const server = await fakeServer();
    const config = bridgeConfig({
      BRIDGE_EGRESS_SERVERS: 'pinned:2:2', BRIDGE_EGRESS_PROVIDER: 'static', BRIDGE_EGRESS_SLOTS: '127.0.0.2,127.0.0.3', BRIDGE_EGRESS_DIR: tempDir(),
    }, server.port);
    const egress = await startEgress(config.egress, () => {});
    const bridge = createBridgeServer(config, { log: () => {}, egress });
    const url = `ws://127.0.0.1:${await bridge.listen()}/`;
    try {
      const a = await openAs(url, '203.0.113.1');
      const b = await openAs(url, '203.0.113.2');
      a.ws.send(clientLogin('eor', 'one', 'pw'));
      b.ws.send(clientLogin('eor', 'two', 'pw'));
      await until(() => server.msgs.length === 2);
      const sources = server.msgs.map((m) => m.rinfo.address).sort();
      expect(sources).toEqual(['127.0.0.2', '127.0.0.3']);
      // Replies to each address reach that session.
      for (const m of server.msgs) server.sock.send(characterListEor(readLoginAccountEor(m.msg).account!), m.rinfo.port, m.rinfo.address);
      await Promise.all([a, b].map((s) => new Promise((res) => s.ws.once('message', res))));
      a.ws.terminate(); b.ws.terminate();
    } finally {
      await bridge.shutdown();
      server.close();
    }
  });
});

it('the egress tag is the documented one', () => {
  expect(EGRESS_TAG).toBe('webac:egress');
});

// ─── Locks, shutdown, other hosts, IPv6 (review fixes) ─

describe('mutexes', () => {
  it('a held alloc lock is waited for without freezing the event loop', async () => {
    const dir = tempDir();
    const m = await staticManager(dir, 'w:2', ['10.0.0.1'], fakeClock());
    const lockFile = path.join(dir, 'alloc.lock');
    fs.writeFileSync(lockFile, 'other-process-token'); // fresh: another bridge holds it
    let ticked = false;
    setTimeout(() => { ticked = true; fs.unlinkSync(lockFile); }, 50);
    const r = await m.acquire('w', '198.51.100.1');
    expect(ticked).toBe(true); // timers ran while acquire waited
    expect(r.ok).toBe(true);
    expect(ALLOC_LOCK.staleMs).toBeLessThanOrEqual(5_000);
    await m.stop();
  });

  it('a takeover never lets the old holder delete the new holder\'s lock', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const a = await staticManager(dir, 'w:2', ['10.0.0.1'], clock);
    const b = await staticManager(dir, 'w:2', ['10.0.0.1'], clock);
    type Locker = { lock(name: string, t: typeof RECONCILE_LOCK): Promise<(() => void) | null> };
    const unlockA = await (a as unknown as Locker).lock('test.lock', RECONCILE_LOCK);
    expect(unlockA).not.toBeNull();
    expect(await (b as unknown as Locker).lock('test.lock', RECONCILE_LOCK)).toBeNull(); // held
    clock.advance(RECONCILE_LOCK.staleMs + 1); // a stalls past the stale time
    const unlockB = await (b as unknown as Locker).lock('test.lock', RECONCILE_LOCK);
    expect(unlockB).not.toBeNull(); // taken over
    unlockA!(); // a wakes up and unlocks: b's lock stays
    expect(fs.existsSync(path.join(dir, 'test.lock'))).toBe(true);
    expect(await (a as unknown as Locker).lock('test.lock', RECONCILE_LOCK)).toBeNull();
    unlockB!();
    expect(fs.existsSync(path.join(dir, 'test.lock'))).toBe(false);
    await a.stop(); await b.stop();
  });
});

describe('releasing safely', () => {
  it('the record stops claiming the association before the disassociate', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const { api, hooks } = fakeEc2();
    const m = await awsManager(dir, 'ac1999:2', api, clock);
    const l = await lease(m, 'ac1999', '198.51.100.1');
    const recordAtDisassociate: unknown[] = [];
    hooks.onDisassociate = () => recordAtDisassociate.push(JSON.parse(fs.readFileSync(path.join(dir, 'slots', `${l.localAddress}.addr.json`), 'utf8')));
    l.release();
    clock.advance(121_000);
    expect(await m.releaseIfIdle(l.localAddress)).toBe('released');
    expect(recordAtDisassociate).toEqual([expect.objectContaining({ associationId: null, releasing: true })]);
    await m.stop();
  });

  it('an exit between disassociate and release is finished by the next attach (by its listed state)', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const { api, fail, addresses } = fakeEc2();
    const m = await awsManager(dir, 'ac1999:2', api, clock);
    const l = await lease(m, 'ac1999', '198.51.100.1');
    l.release();
    clock.advance(121_000);
    fail.release = Object.assign(new Error('killed'), { name: 'UnauthorizedOperation' }); // the process "dies" after the disassociate
    expect(await m.releaseIfIdle(l.localAddress)).toBe('error');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'slots', `${l.localAddress}.addr.json`), 'utf8'))).toMatchObject({ associationId: null, releasing: true });
    delete fail.release;
    const again = await lease(m, 'ac1999', '198.51.100.2');
    expect(again.localAddress).toBe(l.localAddress);
    expect([...addresses.keys()]).toEqual(['eipalloc-2']); // a new allocation, the half-released one given back (AWS may hand its IP back)
    expect([...addresses.values()].map((a) => a.publicIp)).toEqual([again.publicIp]);
    await m.stop();
  });

  it('stop() waits for an attach under way, then gives its address back', async () => {
    const { api, addresses } = fakeEc2();
    let letAllocate!: () => void;
    const gate = new Promise<void>((r) => { letAllocate = r; });
    const slow: Ec2Api = { ...api, allocateAddress: async (i) => { await gate; return api.allocateAddress(i); } };
    const m = await awsManager(tempDir(), 'ac1999:2', slow);
    const acquiring = m.acquire('ac1999', '198.51.100.1');
    await new Promise((r) => setTimeout(r, 20));
    let stopped = false;
    const stopping = m.stop().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false); // waiting on the attach
    letAllocate();
    // stop() began before the attach finished: the session is refused, never handed an address.
    expect(await acquiring).toMatchObject({ ok: false, refusal: 'full', detail: 'egress stopped' });
    await stopping;
    expect(addresses.size).toBe(0);
  });

  it('a failed acquire on a slot that holds an address leaves it its normal grace release', async () => {
    const dir = tempDir();
    const { api, fail } = fakeEc2();
    const config: EgressConfig = { worlds: parseEgressServers('ac1999:2'), provider: 'aws', dir, slots: ['10.0.1.11'], graceMs: 3_600_000 };
    const m = new EgressManager({ config, provider: new AwsEgressProvider({ ec2: api, slots: ['10.0.1.11'], imds: fakeImds(), sleep: async () => {} }), timers: true });
    await m.start();
    const l = await lease(m, 'ac1999', '198.51.100.1');
    l.release();
    // A crash left the record half-released, and AWS refuses the clean-up: the acquire fails.
    const file = path.join(dir, 'slots', '10.0.1.11.addr.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), releasing: true }));
    fail.release = Object.assign(new Error('nope'), { name: 'UnauthorizedOperation' });
    expect(await m.acquire('ac1999', '198.51.100.2')).toMatchObject({ ok: false, refusal: 'full' });
    expect((m as unknown as { releaseTimers: Map<string, unknown> }).releaseTimers.has('10.0.1.11')).toBe(true);
    delete fail.release;
    await m.stop();
  });
});

describe('reconciler robustness', () => {
  it('one failing slot is logged and skipped; the others are still reconciled', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const { api, fail, addresses } = fakeEc2();
    const cap = capture();
    const m = await awsManager(dir, 'ac1999:2', api, clock, cap.log);
    const x = await lease(m, 'ac1999', '198.51.100.1');
    const y = await lease(m, 'ac1999', '198.51.100.2');
    x.release(); y.release();
    clock.advance(121_000);
    const xAlloc = [...addresses.values()].find((a) => a.publicIp === x.publicIp)!.allocationId;
    fail.releaseOf = new Set([xAlloc]);
    expect(await m.reconcile()).toMatchObject({ released: 1, errors: 1 });
    expect([...addresses.keys()]).toEqual([xAlloc]);
    expect(cap.lines.some((l) => l.event === 'egress_reconcile' && l.fields.slot === x.localAddress && l.fields.ok === false)).toBe(true);
    fail.releaseOf.clear();
    expect(await m.reconcile()).toMatchObject({ released: 1, errors: 0 });
    expect(addresses.size).toBe(0);
    await m.stop();
  });

  it('detaches by the listed association, not a stale record\'s', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const { api, calls } = fakeEc2();
    const m = await awsManager(dir, 'ac1999:2', api, clock);
    const l = await lease(m, 'ac1999', '198.51.100.1');
    l.release();
    const file = path.join(dir, 'slots', `${l.localAddress}.addr.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), associationId: 'eipassoc-stale' }));
    clock.advance(121_000);
    calls.length = 0;
    expect(await m.reconcile()).toMatchObject({ released: 1 });
    expect(calls.find((c) => c[0] === 'disassociate')?.[1]).toBe('eipassoc-eipalloc-1');
    await m.stop();
  });

  it('never touches another host\'s addresses; allocations carry this instance\'s id', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const { api, addresses, foreign } = fakeEc2();
    const m = await awsManager(dir, 'ac1999:2', api, clock);
    const l = await lease(m, 'ac1999', '198.51.100.1');
    expect([...addresses.values()][0]).toMatchObject({ instance: 'i-self', networkInterfaceId: 'eni-primary' });
    l.release();
    const otherAssociated = foreign({ associationId: 'eipassoc-x', networkInterfaceId: 'eni-other-host', slot: '10.0.1.12' });
    const otherIdle = foreign({ slot: '10.0.2.21' });
    const untaggedIdle = foreign({ slot: '10.0.2.21', instance: null });
    const ownIdle = foreign({ slot: '10.0.2.21', instance: 'i-self' });
    clock.advance(121_000);
    await m.reconcile();
    expect(addresses.has(otherAssociated.allocationId)).toBe(true);
    expect(addresses.has(otherIdle.allocationId)).toBe(true);
    expect(addresses.has(untaggedIdle.allocationId)).toBe(true);
    expect(addresses.has(ownIdle.allocationId)).toBe(false);
    expect(addresses.size).toBe(3); // ours (the slot's and the orphan) gone, the other host's kept
    await m.stop();
  });
});

describe('shutdown order (blue/green): no address is leaked', () => {
  it('the old bridge stops while the new one plays: the old one\'s idle slots are released at once, shared ones by the new one later', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const { api, addresses } = fakeEc2();
    const oldBridge = await awsManager(dir, 'ac1999:2', api, clock);
    const newBridge = await awsManager(dir, 'ac1999:2', api, clock);
    const a1 = await lease(oldBridge, 'ac1999', '198.51.100.1'); // 10.0.1.11
    const a2 = await lease(oldBridge, 'ac1999', '198.51.100.2'); // 10.0.1.12
    const b1 = await lease(newBridge, 'ac1999', '198.51.100.3'); // 10.0.2.21
    const b2 = await lease(newBridge, 'ac1999', '198.51.100.4'); // shares one of the old bridge's slots
    expect(addresses.size).toBe(3);
    void a1; void a2;
    // The old bridge shuts down: its sessions end (stop drops them) and it gives back what nobody uses.
    await oldBridge.stop();
    const stillUsed = new Set([b1.localAddress, b2.localAddress]);
    expect([...addresses.values()].map((a) => a.slot).sort()).toEqual([...stillUsed].sort());
    expect(fs.existsSync(path.join(dir, 'reconcile.lock'))).toBe(false);
    // The new bridge's players leave; after the grace its reconciler frees the rest.
    b1.release(); b2.release();
    clock.advance(121_000);
    await newBridge.reconcile();
    expect(addresses.size).toBe(0);
    await newBridge.stop();
  });

  it('with no successor, the bridge\'s own stop releases every address', async () => {
    const dir = tempDir();
    const { api, addresses } = fakeEc2();
    const m = await awsManager(dir, 'ac1999:2', api);
    const a = await lease(m, 'ac1999', '198.51.100.1');
    await lease(m, 'ac1999', '198.51.100.2');
    a.release(); // one session ended a moment ago (in grace), one still open
    expect(addresses.size).toBe(2);
    await m.stop();
    expect(addresses.size).toBe(0);
    expect(fs.readdirSync(path.join(dir, 'sessions'))).toEqual([]);
  });

  it('the real bridge\'s shutdown awaits it', async () => {
    const { api, addresses } = fakeEc2();
    const server = await fakeServer();
    const config = bridgeConfig({ BRIDGE_EGRESS_SERVERS: 'pinned:2' }, server.port);
    const m = await awsManager(tempDir(), 'pinned:2', api);
    const bridge = createBridgeServer(config, { log: () => {}, egress: m });
    const url = `ws://127.0.0.1:${await bridge.listen()}/`;
    // The slot is 10.0.1.11 (not on this host), so the session never binds; only its address matters here.
    await openAs(url, '203.0.113.1');
    expect(addresses.size).toBe(1);
    await bridge.shutdown();
    expect(addresses.size).toBe(0);
    server.close();
  });
});

describe('real IPs: IPv6 by /64', () => {
  it('keys IPv4 (and IPv4-mapped) as is and IPv6 by its /64', () => {
    expect(realIpKey('203.0.113.5')).toBe('203.0.113.5');
    expect(realIpKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(realIpKey('2001:db8:1:2:aaaa::1')).toBe(realIpKey('2001:db8:1:2:ffff:ffff:ffff:fffe'));
    expect(realIpKey('2001:db8:1:2::1')).not.toBe(realIpKey('2001:db8:1:3::1'));
    expect(realIpKey('[2001:DB8:1:2::9]')).toBe(realIpKey('2001:db8:1:2::1'));
  });

  it('one /64 can\'t dodge the per-real-IP session cap or the new-account limit by rotating addresses', async () => {
    const m = await staticManager(tempDir(), 'ac1999:2:1', ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    const a = await lease(m, 'ac1999', '2001:db8:1:2::1');
    await lease(m, 'ac1999', '2001:db8:1:2::2');
    expect(await m.acquire('ac1999', '2001:db8:1:2::3')).toMatchObject({ ok: false, refusal: 'ip_cap' });
    expect(await m.checkLogin(a, 'made')).toBe('ok');
    m.accountConfirmed(a, 'made', 0);
    a.release();
    const c = await lease(m, 'ac1999', '2001:db8:1:2::99');
    expect(await m.checkLogin(c, 'another')).toBe('new_account_cap');
    await m.stop();
  });
});

// ─── Round 3: timeouts, account markers, fallbacks, retries ─

/** An EC2 API whose chosen calls never answer. */
function hangingEc2(base: Ec2Api, hang: Array<keyof Ec2Api>): Ec2Api {
  const never = () => new Promise<never>(() => {});
  return Object.fromEntries(Object.entries(base).map(([k, f]) => [k, hang.includes(k as keyof Ec2Api) ? never : f])) as unknown as Ec2Api;
}

describe('AWS calls are bounded', () => {
  it('a stalled EC2 call refuses the session as full instead of hanging admission (and the slot lock)', async () => {
    const dir = tempDir();
    const { api } = fakeEc2();
    const config: EgressConfig = { worlds: parseEgressServers('ac1999:2'), provider: 'aws', dir, slots: null, graceMs: 120_000 };
    const provider = new AwsEgressProvider({ ec2: hangingEc2(api, ['allocateAddress']), slots: null, imds: fakeImds(), sleep: async () => {}, callTimeoutMs: 50 });
    const m = new EgressManager({ config, provider, timers: false });
    await m.start();
    const t0 = Date.now();
    expect(await m.acquire('ac1999', '198.51.100.1')).toMatchObject({ ok: false, refusal: 'full', detail: 'aws:Timeout' });
    expect(Date.now() - t0).toBeLessThan(5_000);
    // The slot lock was let go: no lock files are left behind.
    expect(fs.readdirSync(path.join(dir, 'slots')).filter((f) => f.endsWith('.lock'))).toEqual([]);
    await m.stop();
  });

  it('a stalled first reconcile does not hold up start, and the manager is usable', async () => {
    const { api } = fakeEc2();
    const provider = new AwsEgressProvider({ ec2: hangingEc2(api, ['describeTaggedAddresses']), slots: null, imds: fakeImds(), sleep: async () => {} });
    const config: EgressConfig = { worlds: parseEgressServers('ac1999:2'), provider: 'aws', dir: tempDir(), slots: null, graceMs: 120_000 };
    const t0 = Date.now();
    const m = await startEgress(config, () => {}, provider, { startReconcileMs: 50, timers: false });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(m!.disabled).toBeNull();
    expect((await m!.acquire('ac1999', '198.51.100.1')).ok).toBe(true);
    await m!.stop(50);
  });

  it('stop() gives up at its deadline (shutdown never hangs on AWS)', async () => {
    const { api } = fakeEc2();
    const cap = capture();
    const config: EgressConfig = { worlds: parseEgressServers('ac1999:2'), provider: 'aws', dir: tempDir(), slots: null, graceMs: 120_000 };
    const hung = hangingEc2(api, ['disassociateAddress', 'releaseAddress']);
    const m = new EgressManager({ config, provider: new AwsEgressProvider({ ec2: hung, slots: null, imds: fakeImds(), sleep: async () => {} }), timers: false, log: cap.log });
    await m.start();
    (await lease(m, 'ac1999', '198.51.100.1')).release();
    const t0 = Date.now();
    await m.stop(100);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(cap.lines.some((l) => l.event === 'egress_stop_deadline')).toBe(true);
  });
});

describe('new-account markers', () => {
  it('one session can\'t create more than the limit by trying several names', async () => {
    const m = await staticManager(tempDir(), 'ac1999:2:1', ['10.0.0.1']);
    const l = await lease(m, 'ac1999', '203.0.113.1');
    expect(await m.checkLogin(l, 'one')).toBe('ok');
    expect(await m.checkLogin(l, 'two')).toBe('new_account_cap'); // its own first login counts
    expect(await m.checkLogin(l, 'three')).toBe('new_account_cap');
    await m.stop();
  });

  it('a marker is shared state: a restarted bridge still counts it; an unresolved one expires after 30 days', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const a = await staticManager(dir, 'ac1999:2:1', ['10.0.0.1'], clock);
    const s1 = await lease(a, 'ac1999', '203.0.113.1');
    expect(await a.checkLogin(s1, 'made')).toBe('ok');
    await a.stop(); // closed before any character list
    const b = await staticManager(dir, 'ac1999:2:1', ['10.0.0.1'], clock);
    const s2 = await lease(b, 'ac1999', '203.0.113.1');
    expect(await b.checkLogin(s2, 'other')).toBe('new_account_cap');
    clock.advance(PENDING_MARKER_TTL_MS + 1);
    b.refresh();
    expect(await b.checkLogin(s2, 'other')).toBe('ok');
    await b.stop();
  });

  it('a created account stays counted for good', async () => {
    const clock = fakeClock();
    const m = await staticManager(tempDir(), 'ac1999:2:1', ['10.0.0.1'], clock);
    const s1 = await lease(m, 'ac1999', '203.0.113.1');
    expect(await m.checkLogin(s1, 'made')).toBe('ok');
    m.accountConfirmed(s1, 'made', 0);
    clock.advance(PENDING_MARKER_TTL_MS + 1);
    m.refresh();
    expect(await m.checkLogin(s1, 'another')).toBe('new_account_cap');
    await m.stop();
  });

  it('a check that waited on the lock past its session\'s end writes nothing', async () => {
    const dir = tempDir();
    const m = await staticManager(dir, 'ac1999:2:1', ['10.0.0.1']);
    const l = await lease(m, 'ac1999', '203.0.113.1');
    fs.writeFileSync(path.join(dir, 'alloc.lock'), 'other-process');
    const checking = m.checkLogin(l, 'late');
    l.release();
    fs.unlinkSync(path.join(dir, 'alloc.lock'));
    expect(await checking).toBe('new_account_cap');
    expect(fs.readdirSync(path.join(dir, 'sessions'))).toEqual([]);
    const l2 = await lease(m, 'ac1999', '203.0.113.1');
    expect(await m.checkLogin(l2, 'fresh')).toBe('ok'); // nothing was counted for 'late'
    await m.stop();
  });
});

describe('failed attaches and fallbacks', () => {
  it('an associate that failed on our side but happened at AWS is given back, so the slot is not wedged', async () => {
    const dir = tempDir();
    const { api, addresses } = fakeEc2();
    let once = true;
    const lying: Ec2Api = {
      ...api,
      associateAddress: async (i) => {
        const r = await api.associateAddress(i);
        if (once) { once = false; throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }); }
        return r;
      },
    };
    const m = await awsManager(dir, 'ac1999:2', lying, fakeClock(), capture().log, ['10.0.1.11']);
    expect(await m.acquire('ac1999', '198.51.100.1')).toMatchObject({ ok: false, refusal: 'full' });
    expect(addresses.size).toBe(0); // the associated-but-unrecorded address went back
    expect((await m.acquire('ac1999', '198.51.100.1')).ok).toBe(true); // and the slot works
    await m.stop();
  });

  it('the reconciler releases an unrecorded orphan at once, even on a slot a failed acquire just touched', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const { api, addresses, fail } = fakeEc2();
    const m = await awsManager(dir, 'ac1999:2', api, clock, capture().log, ['10.0.1.11']);
    fail.allocate = Object.assign(new Error('x'), { name: 'AddressLimitExceeded' });
    await m.acquire('ac1999', '198.51.100.1'); // touches the slot's activity
    delete fail.allocate;
    const orphan = await api.allocateAddress({ tag: '10.0.1.11', instanceId: 'i-self' });
    expect(await m.reconcile()).toMatchObject({ released: 1 });
    expect(addresses.has(orphan.allocationId)).toBe(false);
    await m.stop();
  });

  it('an allocation failure falls back to a slot that already holds an address with room', async () => {
    const dir = tempDir();
    const { api, fail } = fakeEc2();
    const cap = capture();
    const m = await awsManager(dir, 'ac1999:2', api, fakeClock(), cap.log, ['10.0.1.11', '10.0.1.12']);
    const first = await lease(m, 'ac1999', '198.51.100.1'); // 10.0.1.11, with an address
    fail.allocate = Object.assign(new Error('quota'), { name: 'AddressLimitExceeded' });
    // The next player would get the empty 10.0.1.12, whose allocation fails: they share 10.0.1.11 instead.
    const second = await lease(m, 'ac1999', '198.51.100.2');
    expect(second.localAddress).toBe(first.localAddress);
    expect(second.publicIp).toBe(first.publicIp);
    expect(cap.lines.some((l) => l.event === 'egress_fallback')).toBe(true);
    expect(m.liveSessions().map((s) => s.slot)).toEqual([first.localAddress, first.localAddress]);
    // Full there too: refused.
    expect(await m.acquire('ac1999', '198.51.100.3')).toMatchObject({ ok: false, refusal: 'full' });
    await m.stop();
  });
});

// ─── Readiness: a fresh Elastic IP passes no traffic for a few seconds ───

/**
 * A fake checkip probe over the fake EC2: it answers with the address
 * associated with the probing private IP once that association has been up
 * for `deadMs` (per allocation, overridable; Infinity: never), else fails as
 * a lost request does. Each probe costs 100 ms of the shared clock.
 */
function fakeProbe(addresses: ReturnType<typeof fakeEc2>['addresses'], clock: { now: () => number; advance(ms: number): void }, deadMs: number) {
  const probes: Array<{ local: string; at: number }> = [];
  const associatedAt = new Map<string, number>();
  const deadFor = new Map<string, number>();
  const probe = async (local: string) => {
    probes.push({ local, at: clock.now() });
    clock.advance(100);
    const a = [...addresses.values()].find((x) => x.privateIp === local && x.associationId);
    if (!a) throw Object.assign(new Error('timed out'), { name: 'Timeout' });
    if (!associatedAt.has(a.allocationId)) associatedAt.set(a.allocationId, clock.now() - 100);
    if (clock.now() - associatedAt.get(a.allocationId)! < (deadFor.get(a.publicIp) ?? deadMs)) throw Object.assign(new Error('timed out'), { name: 'Timeout' });
    return `${a.publicIp}\n`;
  };
  return { probe, probes, deadFor };
}

async function probedManager(dir: string, servers: string, deadMs: number, slots: string[] | null = ['10.0.1.11']) {
  const clock = fakeClock();
  const ec2 = fakeEc2();
  const cap = capture();
  const fp = fakeProbe(ec2.addresses, clock, deadMs);
  const config: EgressConfig = { worlds: parseEgressServers(servers), provider: 'aws', dir, slots, graceMs: 120_000 };
  const provider = new AwsEgressProvider({ ec2: ec2.api, slots, imds: fakeImds(), probe: fp.probe, now: clock.now, sleep: async (ms) => { clock.advance(ms); } });
  const m = new EgressManager({ config, provider, now: clock.now, timers: false, log: cap.log });
  await m.start();
  return { m, clock, cap, ...ec2, ...fp };
}

describe('a fresh address is used only once it passes traffic (readiness check)', () => {
  it('ready on the first probe: acquire returns at once, logging egress_ready', async () => {
    const { m, cap, probes } = await probedManager(tempDir(), 'ac1999:2', 0);
    const l = await lease(m, 'ac1999', '198.51.100.1');
    expect(probes).toHaveLength(1);
    expect(probes[0].local).toBe('10.0.1.11'); // bound to the slot's private IP
    expect(cap.lines.find((x) => x.event === 'egress_ready')?.fields).toEqual({ slot: '10.0.1.11', publicIp: l.publicIp, ms: 100, attempts: 1 });
    await m.stop();
  });

  it('dead for the first 2.5 s (as measured on AWS): acquire waits, polling every 250 ms, until the address answers', async () => {
    const { m, cap, probes, clock } = await probedManager(tempDir(), 'ac1999:2', 2_500);
    const before = clock.now();
    const l = await lease(m, 'ac1999', '198.51.100.1');
    // Not returned before the address passes traffic; one probe per 350 ms (100 probe + 250 wait).
    expect(clock.now() - before).toBeGreaterThanOrEqual(2_500);
    expect(probes.length).toBe(8);
    expect(probes[1].at - probes[0].at).toBe(100 + READY_POLL_MS);
    const ready = cap.lines.find((x) => x.event === 'egress_ready')!;
    expect(ready.fields).toMatchObject({ slot: '10.0.1.11', publicIp: l.publicIp, attempts: 8 });
    expect(ready.fields.ms as number).toBeGreaterThanOrEqual(2_500);
    // Logged after the association, before the acquire.
    const order = cap.lines.map((x) => x.event).filter((e) => ['egress_associate', 'egress_ready', 'egress_acquire'].includes(e));
    expect(order).toEqual(['egress_associate', 'egress_ready', 'egress_acquire']);
    expect(cap.lines.some((x) => x.event === 'egress_not_ready')).toBe(false);
    await m.stop();
  });

  it('never ready: that address is released and a second fresh one attached, checked and used', async () => {
    const { m, cap, calls, addresses, deadFor } = await probedManager(tempDir(), 'ac1999:2', 0);
    deadFor.set('54.0.0.1', Infinity);
    const l = await lease(m, 'ac1999', '198.51.100.1');
    // 54.0.0.2 is the dead 54.0.0.1 handed back (refused), so the replacement is the next new one.
    expect(l.publicIp).toBe('54.0.0.3');
    expect(l.localAddress).toBe('10.0.1.11');
    const notReady = cap.lines.find((x) => x.event === 'egress_not_ready')!;
    expect(notReady.level).toBe('warn');
    expect(notReady.fields).toMatchObject({ slot: '10.0.1.11', publicIp: '54.0.0.1', last: 'Timeout' });
    expect(notReady.fields.ms as number).toBeGreaterThanOrEqual(READY_DEADLINE_MS - READY_POLL_MS);
    expect(notReady.fields.ms as number).toBeLessThanOrEqual(READY_DEADLINE_MS);
    expect(cap.lines.find((x) => x.event === 'egress_release')?.fields).toMatchObject({ publicIp: '54.0.0.1', why: 'not_ready', ok: true });
    // The dead one is gone at AWS; AWS hands it straight back, and it is refused for the replacement.
    expect(calls.map((c) => c[0])).toEqual(['describe', 'allocate', 'associate', 'disassociate', 'release', 'allocate', 'allocate', 'release', 'associate']);
    expect([...addresses.values()].map((a) => a.publicIp)).toEqual(['54.0.0.3']);
    expect(cap.lines.find((x) => x.event === 'egress_ready')?.fields).toMatchObject({ publicIp: '54.0.0.3', attempts: 1 });
    expect(m.liveSessions()).toHaveLength(1);
    await m.stop();
  });

  it('both never ready: acquire is refused as full, as a failed attach is, and no address or session is left', async () => {
    const dir = tempDir();
    const { m, cap, addresses } = await probedManager(dir, 'ac1999:2', Infinity);
    expect(await m.acquire('ac1999', '198.51.100.1')).toEqual({ ok: false, refusal: 'full', detail: 'aws:NotReady' });
    expect(cap.lines.filter((x) => x.event === 'egress_not_ready')).toHaveLength(2);
    expect(cap.lines.filter((x) => x.event === 'egress_release' && x.fields.why === 'not_ready')).toHaveLength(2);
    expect(addresses.size).toBe(0);
    expect(fs.readdirSync(path.join(dir, 'slots')).filter((f) => f.endsWith('.addr.json'))).toHaveLength(0);
    expect(fs.readdirSync(path.join(dir, 'sessions'))).toHaveLength(0);
    expect(await m.reconcile()).toMatchObject({ released: 0, errors: 0 });
    await m.stop();
  });

  it('both never ready on one slot: the player falls back to a slot already holding a working address', async () => {
    const { m, deadFor, cap } = await probedManager(tempDir(), 'ac1999:2', 0, ['10.0.1.11', '10.0.1.12']);
    const first = await lease(m, 'ac1999', '198.51.100.1'); // 10.0.1.11 = 54.0.0.1, ready
    for (let i = 2; i < 10; i++) deadFor.set(`54.0.0.${i}`, Infinity); // every later allocation is dead
    const second = await lease(m, 'ac1999', '198.51.100.2');
    expect(second.localAddress).toBe(first.localAddress);
    expect(cap.lines.find((x) => x.event === 'egress_fallback')?.fields).toMatchObject({ from: '10.0.1.12', reason: 'aws:NotReady' });
    await m.stop();
  });

  it('an address already held (it has carried traffic) is reused without a probe', async () => {
    const { m, probes, calls, cap } = await probedManager(tempDir(), 'ac1999:2', 2_500);
    const a = await lease(m, 'ac1999', '198.51.100.1');
    const probed = probes.length;
    calls.length = 0;
    cap.lines.length = 0;
    const b = await lease(m, 'ac1999', '198.51.100.2'); // same slot, same address
    expect(b.publicIp).toBe(a.publicIp);
    expect(probes.length).toBe(probed);
    expect(calls).toEqual([]);
    expect(cap.lines.find((x) => x.event === 'egress_acquire')?.fields.ms).toBe(0);
    await m.stop();
  });

  it('a new-account login moved to a newly allocated address waits for it too', async () => {
    const dir = tempDir();
    const { m, probes, cap } = await probedManager(dir, 'ac1999:2:5:2', 2_500, ['10.0.1.11', '10.0.1.12']);
    const a = await lease(m, 'ac1999', '203.0.113.1');
    spend(dir, 'ac1999', a.publicIp!, 2);
    // 10.0.1.12 is taken by nobody but has no address: the move allocates there.
    const before = probes.length;
    expect(await m.checkLogin(a, 'brandnew')).toBe('moved');
    expect(a.localAddress).toBe('10.0.1.12');
    expect(probes.slice(before).every((p) => p.local === '10.0.1.12')).toBe(true);
    expect(cap.lines.filter((x) => x.event === 'egress_ready').at(-1)?.fields).toMatchObject({ slot: '10.0.1.12', publicIp: a.publicIp });
    await m.stop();
  });

  it('the static provider never probes', async () => {
    const p: EgressProvider = new StaticEgressProvider(['127.0.0.1']);
    expect(p.awaitReady).toBeUndefined();
  });
});

describe('a failed start retries', () => {
  it('egress worlds come back once a retry succeeds', async () => {
    let calls = 0;
    const flaky = new (class extends StaticEgressProvider {
      override async discoverSlots() { calls++; if (calls === 1) throw new Error('IMDS unreachable'); return super.discoverSlots(); }
    })(['10.0.0.1']);
    const cap = capture();
    const config = egressConfig(tempDir(), 'w:2', ['10.0.0.1']);
    const m = await startEgress(config, cap.log, flaky, { startRetryMs: [20], timers: false });
    expect(m!.disabled).toMatch(/IMDS/);
    expect(await m!.acquire('w', '198.51.100.1')).toMatchObject({ ok: false, refusal: 'full' });
    await until(() => m!.disabled === null, 2_000);
    expect(cap.lines.some((l) => l.event === 'egress_start_recovered')).toBe(true);
    expect((await m!.acquire('w', '198.51.100.1')).ok).toBe(true);
    await m!.stop();
  });

  it('stop() cancels a pending retry', async () => {
    let calls = 0;
    const broken = new (class extends StaticEgressProvider {
      override async discoverSlots(): Promise<never> { calls++; throw new Error('nope'); }
    })([]);
    const m = await startEgress(egressConfig(tempDir(), 'w:2', ['10.0.0.1']), () => {}, broken, { startRetryMs: [30], timers: false });
    await m!.stop();
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(1);
  });
});

// ─── Round 4: the world's account creations per address ─

/** Mark `count` accounts as created on `world` through public address `addr` (as earlier logins would have). */
function spend(dir: string, world: string, addr: string, count: number): void {
  const d = path.join(dir, 'accounts', world, 'by-addr', addr);
  fs.mkdirSync(d, { recursive: true });
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(d, `seeded${i}`), 'created');
}

describe('account creations per egress address (accountsPerAddress)', () => {
  it('the fake EC2 recycles: a released address is the next one allocated', async () => {
    const { api } = fakeEc2();
    const a = await api.allocateAddress({ tag: 's', instanceId: 'i-self' });
    await api.releaseAddress({ allocationId: a.allocationId });
    expect((await api.allocateAddress({ tag: 's', instanceId: 'i-self' })).publicIp).toBe(a.publicIp);
  });

  it('a new-account login on a spent address moves to a fresh one before it is forwarded; a known account stays', async () => {
    const dir = tempDir();
    const { api } = fakeEc2();
    const m = await awsManager(dir, 'ac1999:2:5:2', api, fakeClock(), capture().log, ['10.0.1.11', '10.0.1.12']);
    // Two accounts created through 10.0.1.11's address.
    const a = await lease(m, 'ac1999', '203.0.113.1');
    const spentIp = a.publicIp!;
    for (const name of ['made1', 'made2']) {
      expect(await m.checkLogin(a, name)).toBe('ok');
      m.accountConfirmed(a, name, 0);
    }
    expect(m.addrCount(m.worlds.get('ac1999')!, spentIp)).toBe(2);
    a.release();
    // Another player lands on the held (spent) address: fine for an existing account...
    const known = await lease(m, 'ac1999', '203.0.113.2');
    expect(known.publicIp).toBe(spentIp);
    expect(await m.checkLogin(known, 'MADE1')).toBe('ok');
    expect(known.publicIp).toBe(spentIp);
    known.release();
    // ...but a new one moves to a fresh address first.
    const fresh = await lease(m, 'ac1999', '203.0.113.3');
    expect(fresh.publicIp).toBe(spentIp);
    expect(await m.checkLogin(fresh, 'brandnew')).toBe('moved');
    expect(fresh.localAddress).toBe('10.0.1.12');
    expect(fresh.publicIp).not.toBe(spentIp);
    expect(m.liveSessions().find((s) => s.realIpHash === m.hash('ip', '203.0.113.3'))?.slot).toBe('10.0.1.12');
    m.accountConfirmed(fresh, 'brandnew', 0);
    expect(m.addrCount(m.worlds.get('ac1999')!, fresh.publicIp!)).toBe(1);
    expect(m.addrCount(m.worlds.get('ac1999')!, spentIp)).toBe(2);
    await m.stop();
  });

  it('moves to another held address with room before allocating', async () => {
    const dir = tempDir();
    const { api, calls } = fakeEc2();
    const m = await awsManager(dir, 'ac1999:2:5:2', api, fakeClock(), capture().log, ['10.0.1.11', '10.0.1.12']);
    const x = await lease(m, 'ac1999', '203.0.113.1'); // 10.0.1.11
    const y = await lease(m, 'ac1999', '203.0.113.2'); // 10.0.1.12
    spend(dir, 'ac1999', x.publicIp!, 2);
    calls.length = 0;
    expect(await m.checkLogin(x, 'newname')).toBe('moved');
    expect(x.localAddress).toBe(y.localAddress);
    expect(x.publicIp).toBe(y.publicIp);
    expect(calls.filter((c) => c[0] === 'allocate')).toEqual([]);
    await m.stop();
  });

  it('recycled spent allocations are kept while retrying, then released', async () => {
    const dir = tempDir();
    const { api, addresses, recycled, calls } = fakeEc2();
    const m = await awsManager(dir, 'ac1999:2:5:2', api, fakeClock(), capture().log, ['10.0.1.11', '10.0.1.12']);
    const a = await lease(m, 'ac1999', '203.0.113.1');
    spend(dir, 'ac1999', a.publicIp!, 2);
    // AWS will hand back two spent addresses before a fresh one.
    spend(dir, 'ac1999', '3.209.192.47', 2);
    spend(dir, 'ac1999', '3.209.192.48', 2);
    recycled.push('3.209.192.48', '3.209.192.47');
    calls.length = 0;
    expect(await m.checkLogin(a, 'newname')).toBe('moved');
    expect(a.publicIp).not.toMatch(/^3\.209\.192\./);
    expect(calls.filter((c) => c[0] === 'allocate')).toHaveLength(3);
    expect([...addresses.values()].some((x) => x.publicIp.startsWith('3.209.192.'))).toBe(false); // both released
    await m.stop();
  });

  it('nothing with room: refused new_account_unavailable, and the real IP keeps its allowance', async () => {
    const dir = tempDir();
    const { api, recycled } = fakeEc2();
    const m = await awsManager(dir, 'ac1999:2:1:2', api, fakeClock(), capture().log, ['10.0.1.11', '10.0.1.12']);
    const a = await lease(m, 'ac1999', '203.0.113.1');
    spend(dir, 'ac1999', a.publicIp!, 2);
    for (let i = 0; i < ATTACH_TRIES; i++) { spend(dir, 'ac1999', `3.0.0.${i}`, 2); recycled.push(`3.0.0.${i}`); }
    expect(await m.checkLogin(a, 'newname')).toBe('new_account_unavailable');
    // The login never left, so the IP's one creation was not used up.
    expect(fs.existsSync(path.join(dir, 'accounts', 'ac1999', 'by-ip', m.hash('ip', '203.0.113.1')))
      ? fs.readdirSync(path.join(dir, 'accounts', 'ac1999', 'by-ip', m.hash('ip', '203.0.113.1')))
      : []).toEqual([]);
    await m.stop();
  });

  it('creation counts are shared state: another bridge process sees an address as spent', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const { api } = fakeEc2();
    const one = await awsManager(dir, 'ac1999:2:5:2', api, clock, capture().log, ['10.0.1.11', '10.0.1.12']);
    const two = await awsManager(dir, 'ac1999:2:5:2', api, clock, capture().log, ['10.0.1.11', '10.0.1.12']);
    const a = await lease(one, 'ac1999', '203.0.113.1');
    for (const name of ['p', 'q']) { expect(await one.checkLogin(a, name)).toBe('ok'); }
    // Unresolved (pending) creations count too: the server made them while handling the logins.
    expect(two.addrCount(two.worlds.get('ac1999')!, a.publicIp!)).toBe(2);
    a.release(); // gone before its character lists: both stay counted
    const b = await lease(two, 'ac1999', '203.0.113.2');
    expect(b.publicIp).toBe(a.publicIp); // the held address, though spent (fine for an existing account)
    expect(await two.checkLogin(b, 'r')).toBe('moved');
    expect(b.publicIp).not.toBe(a.publicIp);
    await one.stop(); await two.stop();
  });

  it('idle spent addresses are released before other idle ones', async () => {
    const dir = tempDir();
    const clock = fakeClock();
    const { api, calls } = fakeEc2();
    const m = await awsManager(dir, 'ac1999:2:5:2', api, clock, capture().log, ['10.0.1.11', '10.0.1.12']);
    const x = await lease(m, 'ac1999', '203.0.113.1');
    const y = await lease(m, 'ac1999', '203.0.113.2');
    spend(dir, 'ac1999', y.publicIp!, 2);
    const yAlloc = [...(await api.describeTaggedAddresses())].find((t) => t.publicIp === y.publicIp)!.allocationId;
    x.release(); y.release();
    clock.advance(121_000);
    calls.length = 0;
    await m.reconcile();
    expect(calls.filter((c) => c[0] === 'release').map((c) => c[1])[0]).toBe(yAlloc);
    await m.stop();
  });
});

describe('bridge end to end: new_account_unavailable (static, one slot)', () => {
  it('a new account on the one spent address is closed with 4504 before its login leaves', async () => {
    const server = await fakeServer();
    const config = bridgeConfig({ BRIDGE_EGRESS_SERVERS: 'pinned:2:2:1', BRIDGE_EGRESS_PROVIDER: 'static', BRIDGE_EGRESS_SLOTS: '127.0.0.1', BRIDGE_EGRESS_DIR: tempDir() }, server.port);
    const bridge = createBridgeServer(config, { log: () => {}, egress: await startEgress(config.egress, () => {}) });
    const url = `ws://127.0.0.1:${await bridge.listen()}/`;
    try {
      const a = await openAs(url, '203.0.113.1');
      a.ws.send(clientLogin('eor', 'First', 'pw'));
      await until(() => server.msgs.length === 1);
      server.sock.send(characterListEor('First'), server.msgs[0].rinfo.port, server.msgs[0].rinfo.address);
      await new Promise((res) => a.ws.once('message', res));
      const b = await openAs(url, '203.0.113.2');
      b.ws.send(clientLogin('eor', 'Second', 'pw'));
      expect(await b.closed).toBe(CLOSE_NEW_ACCOUNT_UNAVAILABLE);
      expect(server.msgs).toHaveLength(1);
      // An existing account still logs in through the spent address.
      const c = await openAs(url, '203.0.113.2');
      c.ws.send(clientLogin('eor', 'first', 'pw'));
      await until(() => server.msgs.length === 2);
      a.ws.terminate(); c.ws.terminate();
    } finally {
      await bridge.shutdown();
      server.close();
    }
  });
});

describe.skipIf(!aliasesBindable)('bridge end to end: a new account moves off a spent address (127.0.0.2 / 127.0.0.3)', () => {
  it('rebinds the session\'s socket before the login leaves', async () => {
    const server = await fakeServer();
    const config = bridgeConfig({
      BRIDGE_EGRESS_SERVERS: 'pinned:2:5:1', BRIDGE_EGRESS_PROVIDER: 'static', BRIDGE_EGRESS_SLOTS: '127.0.0.2,127.0.0.3', BRIDGE_EGRESS_DIR: tempDir(),
    }, server.port);
    const bridge = createBridgeServer(config, { log: () => {}, egress: await startEgress(config.egress, () => {}) });
    const url = `ws://127.0.0.1:${await bridge.listen()}/`;
    try {
      const a = await openAs(url, '203.0.113.1');
      a.ws.send(clientLogin('eor', 'one', 'pw'));
      await until(() => server.msgs.length === 1);
      expect(server.msgs[0].rinfo.address).toBe('127.0.0.2');
      server.sock.send(characterListEor('one'), server.msgs[0].rinfo.port, server.msgs[0].rinfo.address);
      await new Promise((res) => a.ws.once('message', res));
      a.ws.close();
      await until(() => bridge.snapshot().sessions === 0);
      // The next player lands on 127.0.0.2 (spent), sends something first (the socket binds there), then a new account.
      const b = await openAs(url, '203.0.113.2');
      const first = Buffer.alloc(24); first.writeUInt32LE(0x4, 4);
      b.ws.send(first);
      await until(() => server.msgs.length === 2);
      expect(server.msgs[1].rinfo.address).toBe('127.0.0.2');
      b.ws.send(clientLogin('eor', 'two', 'pw'));
      await until(() => server.msgs.length === 3);
      expect(readLoginAccountEor(server.msgs[2].msg).account).toBe('two');
      expect(server.msgs[2].rinfo.address).toBe('127.0.0.3');
      // Replies to the new address reach the session.
      server.sock.send(characterListEor('two'), server.msgs[2].rinfo.port, server.msgs[2].rinfo.address);
      await new Promise((res) => b.ws.once('message', res));
      b.ws.terminate();
    } finally {
      await bridge.shutdown();
      server.close();
    }
  });
});

// ─── Round 5: explicit server refusals drop a login's pending markers ─

/** An end-of-retail server datagram carrying one game message (opcode first) in one fragment. */
function messagePacketEor(body: Buffer): Buffer {
  const frag = Buffer.concat([u32(7), u32(0x80000001), Buffer.from([1, 0]), Buffer.alloc(2), Buffer.alloc(4), body]);
  frag.writeUInt16LE(frag.length, 10);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(3, 0);
  head.writeUInt32LE(0x4, 4);
  return Buffer.concat([head, frag]);
}
/** GDLE's refused login: a connectionless seq-0 packet, flags NetError (+ `extraFlags`), payload {u32 id, u32 table 8}. */
function netErrorEor(id: number, extra: Buffer = Buffer.alloc(0), extraFlags = 0): Buffer {
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x100000 | extraFlags, 4);
  return Buffer.concat([head, extra, u32(id), u32(8)]);
}
/** The AC1999 server's SendConnectLoginFailure: 20-byte header (seq 0, flags exactly 0x100000) + {u32 error, u32 8}. */
function netError1999(id: number): Buffer {
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x100000, 4);
  return Buffer.concat([head, u32(id), u32(8)]);
}
const STR_LOGIN_FAILED = 0x04df9c54;
const STR_LOGIN_SERVER_FULL = 0x00f9982c;

describe('explicit login refusals', () => {
  it('reads the refusals that prove no account was made, in both protocols', async () => {
    const { readServerNetError } = await import('../packages/network/src/ClientConnection');
    // 1999
    expect(readLoginRefusal(netError1999(STR_LOGIN_FAILED), 'ac1999')).toBe(true);
    expect(readLoginRefusal(netError1999(0x082e3779), 'ac1999')).toBe(true); // no credential
    expect(readLoginRefusal(netError1999(0x0c559b1e), 'ac1999')).toBe(true); // already online: it exists
    expect(readLoginRefusal(netError1999(STR_LOGIN_SERVER_FULL), 'ac1999')).toBe(false); // sent after the auto-create
    expect(readLoginRefusal(characterList1999('someone'), 'ac1999')).toBe(false);
    // End of retail: GDLE's NetError header (the client reads the same id), also behind an AckSequence.
    const gdle = netErrorEor(STR_LOGIN_FAILED);
    expect(readServerNetError(new Uint8Array(gdle))?.stringId).toBe(STR_LOGIN_FAILED);
    expect(readLoginRefusal(gdle, 'eor')).toBe(true);
    const acked = netErrorEor(STR_LOGIN_FAILED, u32(5), 0x4000);
    expect(readServerNetError(new Uint8Array(acked))?.stringId).toBe(STR_LOGIN_FAILED);
    expect(readLoginRefusal(acked, 'eor')).toBe(true);
    expect(readLoginRefusal(netErrorEor(STR_LOGIN_SERVER_FULL), 'eor')).toBe(false);
    // ACE: CharacterError AccountDoesntExist / Logon; banned; a wrong-password boot.
    expect(readLoginRefusal(messagePacketEor(Buffer.concat([u32(0xf659), u32(0x0a)])), 'eor')).toBe(true);
    expect(readLoginRefusal(messagePacketEor(Buffer.concat([u32(0xf659), u32(0x01)])), 'eor')).toBe(true);
    expect(readLoginRefusal(messagePacketEor(Buffer.concat([u32(0xf659), u32(0x0d)])), 'eor')).toBe(false); // after the auto-create
    expect(readLoginRefusal(messagePacketEor(Buffer.concat([u32(0xf7c1), u32(3600), str16(' - spam')])), 'eor')).toBe(true);
    expect(readLoginRefusal(messagePacketEor(Buffer.concat([u32(0xf7dc), str16(' because the password entered for this account was not correct')])), 'eor')).toBe(true);
    expect(readLoginRefusal(messagePacketEor(Buffer.concat([u32(0xf7dc), str16(' because your client is not the correct version for this server')])), 'eor')).toBe(false);
    expect(readLoginRefusal(characterListEor('someone'), 'eor')).toBe(false);
  });

  it('drops only the pending markers this session\'s latest login wrote', async () => {
    const dir = tempDir();
    const m = await staticManager(dir, 'ac1999:2:2:5', ['10.0.0.1']);
    const world = m.worlds.get('ac1999')!;
    const ipDir = path.join(dir, 'accounts', 'ac1999', 'by-ip', m.hash('ip', '203.0.113.1'));
    const l = await lease(m, 'ac1999', '203.0.113.1');
    expect(await m.checkLogin(l, 'made')).toBe('ok');
    m.accountConfirmed(l, 'made', 0); // created: stays whatever happens later
    expect(await m.checkLogin(l, 'refused')).toBe('ok');
    expect(fs.readdirSync(ipDir)).toHaveLength(2);
    expect(m.addrCount(world, '10.0.0.1')).toBe(2);
    expect(m.loginRefused(l)).toBe(true);
    expect(fs.readdirSync(ipDir)).toHaveLength(1);
    expect(m.addrCount(world, '10.0.0.1')).toBe(1);
    expect(m.loginRefused(l)).toBe(false); // nothing more to drop
    // A re-login of a name an earlier (unresolved) login reserved: a refusal now drops nothing.
    expect(await m.checkLogin(l, 'pending1')).toBe('ok');
    const l2 = await lease(m, 'ac1999', '203.0.113.1');
    expect(await m.checkLogin(l2, 'pending1')).toBe('ok');
    expect(m.loginRefused(l2)).toBe(false);
    expect(fs.readdirSync(ipDir)).toHaveLength(2);
    await m.stop();
  });
});

describe('bridge end to end: an explicit refusal gives the allowance back', () => {
  let server: FakeServer;
  let bridge: BridgeServer | null = null;
  const sockets: WebSocket[] = [];
  beforeEach(async () => { server = await fakeServer(); });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    if (bridge) await bridge.shutdown();
    bridge = null;
    server.close();
  });
  async function start(env: Record<string, string>): Promise<string> {
    const config = bridgeConfig({ BRIDGE_EGRESS_PROVIDER: 'static', BRIDGE_EGRESS_SLOTS: '127.0.0.1', BRIDGE_EGRESS_DIR: tempDir(), ...env }, server.port);
    bridge = createBridgeServer(config, { log: () => {}, egress: await startEgress(config.egress, () => {}) });
    return `ws://127.0.0.1:${await bridge.listen()}/`;
  }
  async function session(url: string, ip: string): Promise<{ ws: WebSocket; closed: Promise<number> }> {
    const s = await openAs(url, ip);
    sockets.push(s.ws);
    return s;
  }

  for (const [proto, env, refusal, login] of [
    ['end of retail (ACE CharacterError AccountDoesntExist)', {}, messagePacketEor(Buffer.concat([u32(0xf659), u32(0x0a)])), (n: string) => clientLogin('eor', n, 'pw')],
    ['1999 (NetError ClientLogOnFailed)', { BRIDGE_ERA: 'ac1999-retail' }, netError1999(STR_LOGIN_FAILED), (n: string) => clientLogin('ac1999', n, 'pw')],
  ] as const) {
    it(proto, async () => {
      const url = await start({ BRIDGE_EGRESS_SERVERS: 'pinned:2:1:99', ...env });
      const a = await session(url, '203.0.113.1');
      a.ws.send(login('refusedname'));
      await until(() => server.msgs.length === 1);
      server.sock.send(refusal, server.msgs[0].rinfo.port, server.msgs[0].rinfo.address);
      await new Promise((res) => a.ws.once('message', res)); // the refusal reaches the page too
      a.ws.close();
      await until(() => bridge!.snapshot().sessions === 0);
      // The IP's one creation is still available.
      const b = await session(url, '203.0.113.1');
      b.ws.send(login('realname'));
      await until(() => server.msgs.length === 2);
      // Contrast: a silent close keeps the login counted.
      b.ws.close();
      await until(() => bridge!.snapshot().sessions === 0);
      const c = await session(url, '203.0.113.1');
      c.ws.send(login('third'));
      expect(await c.closed).toBe(CLOSE_NEW_ACCOUNT_CAP);
    });
  }
});

// ─── No reply from the server: move once to another address ───

describe('a session the server never answers moves once to another address (moveForNoReply)', () => {
  it('to another slot holding a working address with room; the old address is retired, not kept for its grace', async () => {
    const { m, addresses, cap } = await probedManager(tempDir(), 'ac1999:2', 0, ['10.0.1.11', '10.0.1.12']);
    const a = await lease(m, 'ac1999', '198.51.100.1'); // 10.0.1.11 = 54.0.0.1
    const b = await lease(m, 'ac1999', '198.51.100.2'); // 10.0.1.12 = 54.0.0.2
    expect(await m.moveForNoReply(a, () => true)).toEqual({ from: '10.0.1.11', to: '10.0.1.12', publicIp: '54.0.0.2' });
    expect(a.localAddress).toBe('10.0.1.12');
    expect(a.publicIp).toBe(b.publicIp);
    expect(await m.releaseIfIdle('10.0.1.11', 0)).toBe('none'); // the retire already ran
    expect([...addresses.values()].map((x) => x.publicIp)).toEqual(['54.0.0.2']);
    expect(cap.lines.find((x) => x.event === 'egress_release')?.fields).toMatchObject({ slot: '10.0.1.11', publicIp: '54.0.0.1', why: 'no_reply' });
    await m.stop();
  });

  it('else to a free slot with a new address, which passes the readiness check first', async () => {
    const { m, addresses, probes } = await probedManager(tempDir(), 'ac1999:2', 1_000, ['10.0.1.11', '10.0.1.12']);
    const a = await lease(m, 'ac1999', '198.51.100.1');
    const before = probes.length;
    const moved = await m.moveForNoReply(a, () => true);
    expect(moved).toEqual({ from: '10.0.1.11', to: '10.0.1.12', publicIp: '54.0.0.2' });
    expect(probes.slice(before).length).toBeGreaterThan(1); // waited out the dead window
    expect(probes.slice(before).every((p) => p.local === '10.0.1.12')).toBe(true);
    await m.releaseIfIdle('10.0.1.11', 0);
    expect([...addresses.values()].map((x) => x.publicIp)).toEqual(['54.0.0.2']);
    await m.stop();
  });

  it('a reply while the new address was being made undoes the move', async () => {
    const { m, addresses } = await probedManager(tempDir(), 'ac1999:2', 0, ['10.0.1.11', '10.0.1.12']);
    const a = await lease(m, 'ac1999', '198.51.100.1');
    expect(await m.moveForNoReply(a, () => false)).toBeNull();
    expect(a.localAddress).toBe('10.0.1.11');
    expect(a.publicIp).toBe('54.0.0.1');
    expect(m.liveSessions().map((s) => s.slot)).toEqual(['10.0.1.11']);
    expect(addresses.size).toBe(2); // the new one keeps its normal grace; the old one carries the session
    await m.stop();
  });

  it('stays when no other address can take it: a failed allocation, or every slot full on the world', async () => {
    const { m, fail, addresses } = await probedManager(tempDir(), 'ac1999:1', 0, ['10.0.1.11', '10.0.1.12']);
    const a = await lease(m, 'ac1999', '198.51.100.1');
    fail.allocate = Object.assign(new Error('quota'), { name: 'AddressLimitExceeded' });
    expect(await m.moveForNoReply(a, () => true)).toBeNull();
    expect(a.localAddress).toBe('10.0.1.11');
    expect(a.publicIp).toBe('54.0.0.1');
    delete fail.allocate;
    await lease(m, 'ac1999', '198.51.100.2'); // takes 10.0.1.12: the world's 1 per address
    expect(await m.moveForNoReply(a, () => true)).toBeNull();
    expect(a.localAddress).toBe('10.0.1.11');
    expect(addresses.size).toBe(2);
    await m.stop();
  });

  it('the caps hold: the new address needs creation room for an unresolved new account and gets its own marker; the old marker stays', async () => {
    const dir = tempDir();
    const m = await staticManager(dir, 'w:1:5:1', ['10.9.0.1', '10.9.0.2', '10.9.0.3', '10.9.0.4']);
    const world = m.worlds.get('w')!;
    const a = await lease(m, 'w', '203.0.113.1'); // 10.9.0.1
    expect(await m.checkLogin(a, 'brandnew')).toBe('ok');
    expect(m.addrCount(world, '10.9.0.1')).toBe(1);
    const b = await lease(m, 'w', '203.0.113.2'); // 10.9.0.2: full (1 session per address)
    const c = await lease(m, 'w', '203.0.113.3'); // the clean 10.9.0.3, taken
    spend(dir, 'w', '10.9.0.4', 1); // free, but no creation room
    expect(b.localAddress).toBe('10.9.0.2');
    expect(c.localAddress).toBe('10.9.0.3');
    expect(await m.moveForNoReply(a, () => true)).toBeNull();
    expect(a.localAddress).toBe('10.9.0.1');
    c.release();
    expect(await m.moveForNoReply(a, () => true)).toMatchObject({ from: '10.9.0.1', to: '10.9.0.3' });
    expect(m.addrCount(world, '10.9.0.3')).toBe(1); // the resent login may create it here
    expect(m.addrCount(world, '10.9.0.1')).toBe(1); // and may already have, there
    // The real IP's allowance is unchanged: the same login, counted once.
    expect(fs.readdirSync(path.join(dir, 'accounts', 'w', 'by-ip', m.hash('ip', '203.0.113.1')))).toHaveLength(1);
    // The character list resolves the new address's marker.
    m.accountConfirmed(a, 'brandnew', 0);
    expect(m.addrCount(world, '10.9.0.3')).toBe(1);
    await m.stop();
  });
});

describe('bridge: the no-reply move (one slot on 127.0.0.1; the move itself stubbed)', () => {
  async function start(manager: EgressManager, cap = capture()) {
    const server = await fakeServer();
    const config = bridgeConfig({}, server.port);
    const bridge = createBridgeServer(config, { log: cap.log, egress: manager, egressNoReplyMs: 150 });
    return { server, bridge, url: `ws://127.0.0.1:${await bridge.listen()}/` };
  }
  const managerOn = async () => {
    const config = egressConfig(tempDir(), 'pinned:2', ['127.0.0.1']);
    const m = new EgressManager({ config, provider: new StaticEgressProvider(['127.0.0.1']), timers: false });
    await m.start();
    return m;
  };
  const packet = (seq: number) => { const b = Buffer.alloc(24); b.writeUInt32LE(seq, 0); b.writeUInt32LE(0x4, 4); return b; };

  it('silence after the first datagram: the socket is rebound at the new address and the last datagram resent; one move only', async () => {
    const m = await managerOn();
    const move = vi.spyOn(m, 'moveForNoReply').mockResolvedValue({ from: '127.0.0.1', to: '127.0.0.1', publicIp: null });
    const cap = capture();
    const { server, bridge, url } = await start(m, cap);
    try {
      const a = await openAs(url, '203.0.113.1');
      a.ws.send(packet(1));
      a.ws.send(packet(2));
      await until(() => server.msgs.length === 3); // 1, 2, then 2 again from the new socket
      expect(server.msgs[2].msg.equals(packet(2))).toBe(true);
      expect(server.msgs[2].rinfo.port).not.toBe(server.msgs[0].rinfo.port);
      const logged = cap.lines.find((x) => x.event === 'egress_no_reply_move')!;
      expect(logged.fields).toMatchObject({ from: '127.0.0.1', to: '127.0.0.1' });
      expect(logged.fields.ms as number).toBeGreaterThanOrEqual(150);
      // Still silent, and later datagrams go out the new way: never a second move.
      a.ws.send(packet(3));
      await new Promise((r) => setTimeout(r, 400));
      expect(move).toHaveBeenCalledTimes(1);
      expect(server.msgs[3].rinfo.port).toBe(server.msgs[2].rinfo.port);
      a.ws.close();
    } finally {
      await bridge.shutdown();
      server.close();
    }
  });

  it('never once the server has sent a byte', async () => {
    const m = await managerOn();
    const move = vi.spyOn(m, 'moveForNoReply');
    const { server, bridge, url } = await start(m);
    try {
      const a = await openAs(url, '203.0.113.1');
      a.ws.send(packet(1));
      await until(() => server.msgs.length === 1);
      server.sock.send(packet(9), server.msgs[0].rinfo.port, server.msgs[0].rinfo.address);
      await new Promise((res) => a.ws.once('message', res));
      await new Promise((r) => setTimeout(r, 400));
      expect(move).not.toHaveBeenCalled();
      a.ws.close();
    } finally {
      await bridge.shutdown();
      server.close();
    }
  });

  it('a reply that arrives during the move keeps the session where it is', async () => {
    const m = await managerOn();
    let silent: (() => boolean) | null = null;
    let answer!: (v: null) => void;
    vi.spyOn(m, 'moveForNoReply').mockImplementation((_l, s) => { silent = s; return new Promise((r) => { answer = r; }); });
    const { server, bridge, url } = await start(m);
    try {
      const a = await openAs(url, '203.0.113.1');
      a.ws.send(packet(1));
      await until(() => silent !== null);
      expect(silent!()).toBe(true);
      server.sock.send(packet(9), server.msgs[0].rinfo.port, server.msgs[0].rinfo.address);
      await new Promise((res) => a.ws.once('message', res));
      expect(silent!()).toBe(false); // the manager undoes the move on this
      answer(null);
      a.ws.send(packet(2));
      await until(() => server.msgs.length === 2);
      expect(server.msgs[1].rinfo.port).toBe(server.msgs[0].rinfo.port);
      a.ws.close();
    } finally {
      await bridge.shutdown();
      server.close();
    }
  });
});

describe.skipIf(!aliasesBindable)('bridge end to end: the no-reply move (127.0.0.2 / 127.0.0.3)', () => {
  it('a silent session\'s login goes again from the other slot\'s address', async () => {
    const server = await fakeServer();
    const config = bridgeConfig({
      BRIDGE_EGRESS_SERVERS: 'pinned:2:5:2', BRIDGE_EGRESS_PROVIDER: 'static', BRIDGE_EGRESS_SLOTS: '127.0.0.2,127.0.0.3', BRIDGE_EGRESS_DIR: tempDir(),
    }, server.port);
    const manager = (await startEgress(config.egress, () => {}))!;
    const bridge = createBridgeServer(config, { log: () => {}, egress: manager, egressNoReplyMs: 150 });
    const url = `ws://127.0.0.1:${await bridge.listen()}/`;
    try {
      const a = await openAs(url, '203.0.113.1');
      a.ws.send(clientLogin('eor', 'quiet', 'pw'));
      await until(() => server.msgs.length === 2);
      expect(server.msgs.map((x) => x.rinfo.address)).toEqual(['127.0.0.2', '127.0.0.3']);
      expect(readLoginAccountEor(server.msgs[1].msg).account).toBe('quiet');
      expect(manager.liveSessions().map((s) => s.slot)).toEqual(['127.0.0.3']);
      const world = manager.worlds.get('pinned')!;
      expect(manager.addrCount(world, '127.0.0.2')).toBe(1);
      expect(manager.addrCount(world, '127.0.0.3')).toBe(1);
      a.ws.close();
    } finally {
      await bridge.shutdown();
      server.close();
    }
  });
});
