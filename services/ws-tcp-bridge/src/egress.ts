/**
 * Per-session egress addresses (BRIDGE_EGRESS_*; services/ws-tcp-bridge/README.md,
 * "Per-session egress addresses").
 *
 * Every browser player reaches a game server from the bridge's one address,
 * so a world that caps sessions and account creation per source IPv4 (the
 * AC1999 server: 2 live sessions, 2 accounts created per address, ever)
 * shares those caps across every webAC player. An "egress world" instead
 * gets each session's UDP socket bound to one of the host's own addresses (a
 * "slot"): on AWS a secondary private IPv4 of an attached ENI, given a freshly
 * allocated Elastic IP for as long as it carries sessions (and a grace period
 * after), then released, so the cost follows play time. A fresh address also
 * resets the world's lifetime account cap, so the bridge applies the world's
 * own rules per REAL player address itself (an IPv6 player by their /64): at
 * most `sessionsPerAddress` live sessions per real IP, and at most
 * `newAccountsPerRealIp` accounts each real IP creates on the world through
 * this bridge.
 *
 * Coordination is cross-process through files in BRIDGE_EGRESS_DIR, because
 * two bridges share the slots during a deploy (the old one drains for hours
 * while the new one serves):
 *
 *   salt                          random, created once; every real IP and
 *                                 account name is stored only as a salted hash
 *   alloc.lock                    mutex around slot choice and the account
 *                                 rule's check-and-reserve (held for ms)
 *   reconcile.lock                one reconciler at a time
 *   sessions/<id>.json            one per live session: {sessionId, pid,
 *                                 startedAt, world, realIpHash, slot};
 *                                 its owner touches it every
 *                                 30 s, and one older than 120 s is a dead
 *                                 process's, removed by whoever sees it
 *   slots/<ip>.lock               mutex around one slot's address changes
 *   slots/<ip>.addr.json          the slot's public address (AWS allocation)
 *   slots/<ip>.active             mtime = the slot's last acquire or release
 *   accounts/<world>/known/<h>    accounts that reached a character list
 *   accounts/<world>/by-ip/<ip>/<h>  per real IP: 'pending' (a login for an
 *                                 unknown account went through; counts until
 *                                 its character list resolves it, 30 days at
 *                                 most) or 'created' (it made the account)
 *
 * Mutexes are files made with exclusive create holding a random token; the
 * holder touches its file while it works, a crashed holder's file goes stale
 * and is taken over, and only the token's owner deletes it. Every timestamp
 * the manager compares is one it wrote itself (mtimes are set from its
 * clock), so tests drive staleness and grace with a fake clock.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import type { EgressConfig, EgressWorld } from './bridgeUtil.js';
import type { Logger } from './log.js';
import { sppAddressBytes } from './spp.js';
import { readSingleFragmentMessages } from './routines.js';

/** An unresolved new-account marker (a login whose character list never came) stops counting after 30 days. */
export const PENDING_MARKER_TTL_MS = 30 * 24 * 3600_000;
/** A session lock file untouched for this long belongs to a dead process. */
export const SESSION_STALE_MS = 120_000;
/** How often an owner touches its session lock files. */
export const SESSION_REFRESH_MS = 30_000;
/** How often the reconciler looks for leaked addresses. */
export const RECONCILE_INTERVAL_MS = 5 * 60_000;
/** The tag every bridge-allocated Elastic IP carries; its value is the slot's private IP. */
export const EGRESS_TAG = 'webac:egress';
/** The second tag: the allocating instance's id (the reconciler touches only this instance's addresses). */
export const EGRESS_INSTANCE_TAG = 'webac:egress-instance';

/** A mutex's timings: taken over once untouched for `staleMs`; its holder touches it every `keepaliveMs`; a waiter gives up after `waitMs`. */
interface LockTiming { staleMs: number; keepaliveMs: number; waitMs: number }
/** alloc.lock is held for milliseconds: a crashed holder's is taken over after a few seconds. */
export const ALLOC_LOCK: LockTiming = { staleMs: 5_000, keepaliveMs: 1_000, waitMs: 10_000 };
/** A slot's lock spans AWS calls (seconds). */
export const SLOT_LOCK: LockTiming = { staleMs: 60_000, keepaliveMs: 10_000, waitMs: 30_000 };
/** The reconciler's lock (never waited for: another process reconciling is enough). */
export const RECONCILE_LOCK: LockTiming = { staleMs: 60_000, keepaliveMs: 10_000, waitMs: 0 };

// ─── Real IPs ──────────────────────────────────────────

/**
 * The key a real client address is limited by: an IPv4 address as it is
 * (IPv4-mapped IPv6 included), an IPv6 address by its /64 (one subscriber's
 * prefix; anyone can pick any of its 2^64 addresses).
 */
export function realIpKey(ip: string): string {
  let a = ip.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) return a;
  if (net.isIPv6(a)) return `${sppAddressBytes(a).subarray(0, 8).toString('hex')}::/64`;
  return a;
}

// ─── Providers ─────────────────────────────────────────

/** A local address sessions can be bound to; `eni` is its AWS network interface (null for static). */
export interface EgressSlot { address: string; eni: string | null }

/** A slot's public address, as kept in slots/<ip>.addr.json. */
export interface HeldAddress {
  allocationId: string;
  /** null: not associated (being made, or being given back). */
  associationId: string | null;
  publicIp: string;
  /** When this record was written (manager clock). */
  at: number;
  /** A detach started: the address is on its way out and claims no association. */
  releasing?: boolean;
}

/** A bridge-tagged address as the provider lists it. */
export interface TaggedAddress {
  allocationId: string;
  associationId: string | null;
  publicIp: string;
  /** The EGRESS_TAG value: the slot it was allocated for. */
  slot: string;
  /** The ENI it is associated with (null when unassociated). */
  networkInterfaceId?: string | null;
  /** The EGRESS_INSTANCE_TAG value. */
  instance?: string | null;
}

export interface EgressProvider {
  readonly name: 'aws' | 'static';
  discoverSlots(): Promise<EgressSlot[]>;
  /**
   * Give `slot` a public address. `persist` is called as soon as the address
   * exists (before association), so a crash mid-attach leaves it findable.
   * `accept`: whether a newly allocated public address will do (AWS hands
   * recently released addresses back; one the world has already counted
   * its account creations against won't). null: the slot egresses as it is (static).
   */
  attach(slot: EgressSlot, persist: (h: HeldAddress) => void, accept?: (publicIp: string) => boolean): Promise<HeldAddress | null>;
  /** Undo attach: disassociate (when `associationId` is set) and release. */
  detach(h: HeldAddress): Promise<void>;
  /** This instance's tagged addresses ([] for static). */
  listTagged(): Promise<TaggedAddress[]>;
}

/** Slots are the configured local addresses; nothing to allocate (tests, dev with loopback aliases, a host with real public IPs). */
export class StaticEgressProvider implements EgressProvider {
  readonly name = 'static' as const;
  constructor(private readonly slots: string[]) {}
  async discoverSlots(): Promise<EgressSlot[]> { return this.slots.map((address) => ({ address, eni: null })); }
  async attach(): Promise<HeldAddress | null> { return null; }
  async detach(): Promise<void> { /* nothing held */ }
  async listTagged(): Promise<TaggedAddress[]> { return []; }
}

/** Allocations tried for an address the world will still let create accounts. */
export const ATTACH_TRIES = 5;

/** Every EC2 call gives up after this long (a stalled endpoint must not hold a slot lock, an admission or a shutdown). */
export const AWS_CALL_TIMEOUT_MS = 10_000;

/** `p`, or a rejection named 'Timeout' after `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what} timed out after ${ms} ms`), { name: 'Timeout' })), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** The EC2 calls the AWS provider makes, narrow so tests inject a fake. */
export interface Ec2Api {
  allocateAddress(input: { tag: string; instanceId: string }): Promise<{ allocationId: string; publicIp: string }>;
  associateAddress(input: { allocationId: string; networkInterfaceId: string; privateIpAddress: string }): Promise<{ associationId: string }>;
  disassociateAddress(input: { associationId: string }): Promise<void>;
  releaseAddress(input: { allocationId: string }): Promise<void>;
  /** Every address carrying EGRESS_TAG, any instance's. */
  describeTaggedAddresses(): Promise<TaggedAddress[]>;
}

/** An AWS error's code (the SDK's `name`), for logs and the not-found checks. */
export function awsErrorCode(err: unknown): string {
  const e = err as { name?: unknown; Code?: unknown; code?: unknown; message?: unknown } | null;
  const c = e?.name ?? e?.Code ?? e?.code;
  return typeof c === 'string' && c && c !== 'Error' ? c : String(e?.message ?? err);
}

/**
 * The real EC2 client (credentials from the SDK default chain: the instance
 * role). The SDK is imported on first use only, so a bridge with egress off
 * (or on the static provider) never loads it.
 */
export function sdkEc2Api(region: () => Promise<string>, timeoutMs = AWS_CALL_TIMEOUT_MS): Ec2Api {
  // The SDK's HTTP handler has no default timeouts: a stalled endpoint would hang the call forever.
  const opts = () => ({ abortSignal: AbortSignal.timeout(timeoutMs) });
  type Sdk = typeof import('@aws-sdk/client-ec2');
  let ready: Promise<{ sdk: Sdk; client: InstanceType<Sdk['EC2Client']> }> | null = null;
  const get = () => (ready ??= (async () => {
    const sdk = await import('@aws-sdk/client-ec2');
    return { sdk, client: new sdk.EC2Client({ region: await region() }) };
  })().catch((e) => { ready = null; throw e; }));
  return {
    async allocateAddress({ tag, instanceId }) {
      const { sdk, client } = await get();
      const r = await client.send(new sdk.AllocateAddressCommand({
        Domain: 'vpc',
        TagSpecifications: [{ ResourceType: 'elastic-ip', Tags: [{ Key: EGRESS_TAG, Value: tag }, { Key: EGRESS_INSTANCE_TAG, Value: instanceId }] }],
      }), opts());
      if (!r.AllocationId || !r.PublicIp) throw new Error('AllocateAddress returned no address');
      return { allocationId: r.AllocationId, publicIp: r.PublicIp };
    },
    async associateAddress({ allocationId, networkInterfaceId, privateIpAddress }) {
      const { sdk, client } = await get();
      const r = await client.send(new sdk.AssociateAddressCommand({
        AllocationId: allocationId, NetworkInterfaceId: networkInterfaceId, PrivateIpAddress: privateIpAddress, AllowReassociation: false,
      }), opts());
      if (!r.AssociationId) throw new Error('AssociateAddress returned no association');
      return { associationId: r.AssociationId };
    },
    async disassociateAddress({ associationId }) {
      const { sdk, client } = await get();
      await client.send(new sdk.DisassociateAddressCommand({ AssociationId: associationId }), opts());
    },
    async releaseAddress({ allocationId }) {
      const { sdk, client } = await get();
      await client.send(new sdk.ReleaseAddressCommand({ AllocationId: allocationId }), opts());
    },
    async describeTaggedAddresses() {
      const { sdk, client } = await get();
      const r = await client.send(new sdk.DescribeAddressesCommand({ Filters: [{ Name: 'tag-key', Values: [EGRESS_TAG] }] }), opts());
      return (r.Addresses ?? []).filter((a) => a.AllocationId && a.PublicIp).map((a) => ({
        allocationId: a.AllocationId!,
        associationId: a.AssociationId ?? null,
        publicIp: a.PublicIp!,
        slot: a.Tags?.find((t) => t.Key === EGRESS_TAG)?.Value ?? '',
        networkInterfaceId: a.NetworkInterfaceId ?? null,
        instance: a.Tags?.find((t) => t.Key === EGRESS_INSTANCE_TAG)?.Value ?? null,
      }));
    },
  };
}

type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** IMDSv2: a session token, then GETs with it. */
export function imdsClient(fetchFn: FetchFn = fetch as unknown as FetchFn, base = 'http://169.254.169.254'): (p: string) => Promise<string> {
  let token: string | null = null;
  return async (p: string) => {
    if (!token) {
      const r = await fetchFn(`${base}/latest/api/token`, { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' }, signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(`IMDS token: HTTP ${r.status}`);
      token = (await r.text()).trim();
    }
    const r = await fetchFn(`${base}/latest/meta-data/${p}`, { headers: { 'X-aws-ec2-metadata-token': token }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`IMDS ${p}: HTTP ${r.status}`);
    return (await r.text()).trim();
  };
}

/** What IMDS says about this instance: its id, every attached ENI, and the slots. */
export interface ImdsInstance { instanceId: string; enis: string[]; slots: EgressSlot[] }

/**
 * Every secondary private IPv4 on every ENI attached to this instance, with
 * its ENI. Each ENI's first local-ipv4s entry is its primary address, never a
 * slot: the primary ENI's primary address carries the instance's own public
 * address, which everything else (the WebSocket listener, other worlds) uses.
 */
export async function discoverImdsInstance(imds: (p: string) => Promise<string>): Promise<ImdsInstance> {
  const instanceId = await imds('instance-id');
  const macs = (await imds('network/interfaces/macs/')).split('\n').map((m) => m.trim().replace(/\/$/, '')).filter(Boolean);
  const enis: string[] = [];
  const slots: EgressSlot[] = [];
  for (const mac of macs) {
    const eni = await imds(`network/interfaces/macs/${mac}/interface-id`);
    enis.push(eni);
    const ips = (await imds(`network/interfaces/macs/${mac}/local-ipv4s`)).split('\n').map((s) => s.trim()).filter(Boolean);
    for (const address of ips.slice(1)) slots.push({ address, eni });
  }
  return { instanceId, enis, slots };
}

/** The slots alone (discoverImdsInstance). */
export async function discoverImdsSlots(imds: (p: string) => Promise<string>): Promise<EgressSlot[]> {
  return (await discoverImdsInstance(imds)).slots;
}

/** Elastic IPs on secondary private IPs (EC2 API through `ec2`, slot discovery through IMDS). */
export class AwsEgressProvider implements EgressProvider {
  readonly name = 'aws' as const;
  private instance: ImdsInstance | null = null;
  constructor(private readonly opts: {
    ec2: Ec2Api;
    /** Configured slot addresses (BRIDGE_EGRESS_SLOTS); each still needs its ENI, from IMDS. */
    slots: string[] | null;
    imds: (p: string) => Promise<string>;
    /** Waits between release retries (tests pass a no-op). */
    sleep?: (ms: number) => Promise<void>;
    /** Each EC2 call's deadline (default AWS_CALL_TIMEOUT_MS), on top of the SDK's own abort signal. */
    callTimeoutMs?: number;
  }) {
    const ms = opts.callTimeoutMs ?? AWS_CALL_TIMEOUT_MS;
    const e = opts.ec2;
    this.ec2 = {
      allocateAddress: (i) => withTimeout(e.allocateAddress(i), ms, 'AllocateAddress'),
      associateAddress: (i) => withTimeout(e.associateAddress(i), ms, 'AssociateAddress'),
      disassociateAddress: (i) => withTimeout(e.disassociateAddress(i), ms, 'DisassociateAddress'),
      releaseAddress: (i) => withTimeout(e.releaseAddress(i), ms, 'ReleaseAddress'),
      describeTaggedAddresses: () => withTimeout(e.describeTaggedAddresses(), ms, 'DescribeAddresses'),
    };
  }

  /** The EC2 API with every call bounded. */
  private readonly ec2: Ec2Api;

  private async self(): Promise<ImdsInstance> {
    return (this.instance ??= await discoverImdsInstance(this.opts.imds));
  }

  async discoverSlots(): Promise<EgressSlot[]> {
    const all = (await this.self()).slots;
    if (!this.opts.slots) return all;
    return this.opts.slots.map((address) => {
      const found = all.find((s) => s.address === address);
      if (!found) throw new Error(`BRIDGE_EGRESS_SLOTS: ${address} is not a secondary private IPv4 of this instance`);
      return found;
    });
  }

  async attach(slot: EgressSlot, persist: (h: HeldAddress) => void, accept?: (publicIp: string) => boolean): Promise<HeldAddress> {
    if (!slot.eni) throw new Error(`slot ${slot.address} has no network interface`);
    const { instanceId } = await this.self();
    // An unacceptable (recycled, spent) address is kept until the end, so the next allocation can't return it again.
    const spent: string[] = [];
    let got: { allocationId: string; publicIp: string } | null = null;
    try {
      for (let i = 0; i < ATTACH_TRIES && !got; i++) {
        const a = await this.ec2.allocateAddress({ tag: slot.address, instanceId });
        if (accept && !accept(a.publicIp)) spent.push(a.allocationId);
        else got = a;
      }
    } finally {
      for (const allocationId of spent) await this.ec2.releaseAddress({ allocationId }).catch(() => {}); // else the reconciler's
    }
    if (!got) throw Object.assign(new Error(`${ATTACH_TRIES} allocations were all spent addresses`), { name: 'NoFreshAddress' });
    const { allocationId, publicIp } = got;
    const held: HeldAddress = { allocationId, associationId: null, publicIp, at: 0 };
    persist(held);
    try {
      const { associationId } = await this.ec2.associateAddress({ allocationId, networkInterfaceId: slot.eni, privateIpAddress: slot.address });
      return { ...held, associationId };
    } catch (err) {
      // Never keep an address no session can use: give it back (the reconciler retries if this fails too).
      await this.ec2.releaseAddress({ allocationId }).catch(() => {});
      throw err;
    }
  }

  async detach(h: HeldAddress): Promise<void> {
    if (h.associationId) {
      try { await this.ec2.disassociateAddress({ associationId: h.associationId }); } catch (err) {
        if (!/NotFound/.test(awsErrorCode(err))) throw err;
      }
    }
    // A release right after a disassociate can still see the address in use; retry briefly.
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      try { await this.ec2.releaseAddress({ allocationId: h.allocationId }); return; } catch (err) {
        const code = awsErrorCode(err);
        if (/NotFound/.test(code)) return;
        if (attempt >= 3 || !/InUse|Throttl|RequestLimitExceeded/.test(code)) throw err;
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  /**
   * This instance's tagged addresses only (two bridge hosts in one account
   * must never release each other's): associated with one of this
   * instance's ENIs, or unassociated and tagged with this instance's id.
   */
  async listTagged(): Promise<TaggedAddress[]> {
    const { instanceId, enis } = await this.self();
    return (await this.ec2.describeTaggedAddresses()).filter((a) =>
      a.networkInterfaceId ? enis.includes(a.networkInterfaceId) : !a.associationId && a.instance === instanceId);
  }
}

/** The provider BRIDGE_EGRESS_PROVIDER names. */
export function makeEgressProvider(config: EgressConfig): EgressProvider {
  if (config.provider === 'static') return new StaticEgressProvider(config.slots ?? []);
  const imds = imdsClient();
  const region = async () => process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || imds('placement/region');
  return new AwsEgressProvider({ ec2: sdkEc2Api(region), slots: config.slots, imds });
}

// ─── Login requests (the account a login names) ────────

const LOGIN_MAGIC_BEEF = 0xbeefbeef;
const CREDENTIAL_BYTES_1999 = 20;
/** End of retail header flag LoginRequest (also the AC1999 server's 2017-style BT_LOGIN). */
const FLAG_LOGIN_REQUEST = 0x00010000;

/** What a client datagram says about logging in: whether the server takes it as a login, and the account it names (null: none it could log in). */
export interface LoginRead { login: boolean; account: string | null }

const NOT_LOGIN: LoginRead = { login: false, account: null };

/**
 * A 1999 client datagram as the AC1999 server reads it (Network.cpp
 * ProcessConnectionless + AuthenticateUserQuery): connectionless (header
 * recipient 0) with flags 0x10000, or flags exactly 0x2 with a body. The body
 * is u32 tick, u16 version length, the version (read only when 1..32 bytes),
 * then the first 0xBEEFBEEF marker whose 20-byte field (up to its first NUL)
 * holds a ':'; the account is what precedes it. A login with no such field
 * logs nobody in (the server answers "invalid auth").
 */
export function readLoginAccount1999(buf: Buffer): LoginRead {
  if (buf.length < 20) return NOT_LOGIN;
  const flags = buf.readUInt32LE(4);
  const size = buf.readUInt16LE(16);
  if (buf.readUInt16LE(8) !== 0) return NOT_LOGIN;
  if (!(flags === FLAG_LOGIN_REQUEST || (flags === 0x2 && size > 0))) return NOT_LOGIN;
  // The server drops a runt (fewer body bytes than the header's size) before reading it.
  if (buf.length - 20 < size) return NOT_LOGIN;
  const body = buf.subarray(20, 20 + size);
  let pos = 4;
  if (pos + 2 > body.length) return { login: true, account: null };
  const versionLen = body.readUInt16LE(pos);
  pos += 2;
  if (versionLen > 0 && versionLen <= 32) pos += versionLen;
  for (let i = pos; i + 4 + CREDENTIAL_BYTES_1999 <= body.length; i++) {
    if (body.readUInt32LE(i) !== LOGIN_MAGIC_BEEF) continue;
    const field = body.subarray(i + 4, i + 4 + CREDENTIAL_BYTES_1999);
    const nul = field.indexOf(0);
    const cred = field.toString('latin1', 0, nul >= 0 ? nul : CREDENTIAL_BYTES_1999);
    const colon = cred.indexOf(':');
    if (colon < 0) continue;
    return { login: true, account: cred.slice(0, colon) };
  }
  return { login: true, account: null };
}

/**
 * An end-of-retail LoginRequest (flag 0x10000) as ACE reads it
 * (PacketHeaderOptional, PacketInboundLoginRequest): the optional headers
 * that precede it, then String16L ClientVersion, u32 length, u32
 * NetAuthType, u32 AuthFlags, u32 Timestamp, String16L Account. Auth type 1
 * (GDL's "-a account:password") carries the password in the account string,
 * so the account is what precedes its ':'.
 */
export function readLoginAccountEor(buf: Buffer): LoginRead {
  if (buf.length < 20) return NOT_LOGIN;
  const flags = buf.readUInt32LE(4);
  if (!(flags & FLAG_LOGIN_REQUEST)) return NOT_LOGIN;
  let pos = 20;
  const need = (n: number) => pos + n <= buf.length;
  if (flags & 0x100) pos += 8; // ServerSwitch
  for (const list of [0x1000, 0x2000]) { // RequestRetransmit, RejectRetransmit
    if (!(flags & list)) continue;
    if (!need(4)) return { login: true, account: null };
    pos += 4 + 4 * buf.readUInt32LE(pos);
  }
  if (flags & 0x4000) pos += 4; // AckSequence
  const str16 = (): string | null => {
    if (!need(2)) return null;
    const n = buf.readUInt16LE(pos);
    if (!need(2 + n)) return null;
    const s = buf.toString('latin1', pos + 2, pos + 2 + n);
    pos += 2 + n + ((4 - ((2 + n) % 4)) % 4);
    return s;
  };
  if (str16() === null || !need(16)) return { login: true, account: null };
  const authType = buf.readUInt32LE(pos + 4);
  pos += 16;
  const account = str16();
  if (account === null || account === '') return { login: true, account: null };
  if (authType === 1) {
    const colon = account.indexOf(':');
    return { login: true, account: colon >= 0 ? account.slice(0, colon) : account };
  }
  return { login: true, account };
}

/** The login a client datagram carries, for its session's wire protocol. */
export function readLoginAccount(buf: Buffer, protocol: 'eor' | 'ac1999'): LoginRead {
  return protocol === 'ac1999' ? readLoginAccount1999(buf) : readLoginAccountEor(buf);
}

// ─── Login refusals (the server made no account) ───────

/**
 * NetError string ids (table enum 8, ID_ConnectionError_*) that mean the
 * login created no account. The AC1999 server (Network.cpp) and GDLE:
 *   STR_LOGIN_FAILED 0x04DF9C54 (ClientLogOnFailed): a wrong password for an
 *     existing account, or an auto-create that failed (e.g. its own per-IP cap);
 *   STR_LOGIN_INVALID_AUTH 0x082E3779 (BadCryptoKey): no credential at all;
 *   STR_LOGIN_ACCOUNT_ONLINE 0x0C559B1E (PlayerAlreadyLoggedOn): it exists.
 * Not STR_LOGIN_SERVER_FULL: the AC1999 server answers it after
 * auto-creating the account (AcceptClientLogin runs after CreateAccount).
 */
export const NO_CREATION_NET_ERRORS: ReadonlySet<number> = new Set([0x04df9c54, 0x082e3779, 0x0c559b1e]);
const FLAG_NET_ERROR = 0x00100000;
const OPCODE_CHARACTER_ERROR = 0xf659;
const OPCODE_ACCOUNT_BANNED = 0xf7c1;
const OPCODE_ACCOUNT_BOOT = 0xf7dc;
/**
 * ACE CharacterError codes at login that mean no account was made
 * (AuthenticationHandler): AccountDoesntExist (not found, no auto-create)
 * and Logon (in use: it exists). Not LogonServerFull or ServerCrash1: ACE
 * sends those after its auto-create.
 */
const NO_CREATION_CHARACTER_ERRORS: ReadonlySet<number> = new Set([0x0a, 0x01]);

/** The NetError string id of an end-of-retail server packet's optional header (ClientConnection netErrorPayloadOffset), or null. */
function netErrorIdEor(buf: Buffer): number | null {
  if (buf.length < 20) return null;
  const flags = buf.readUInt32LE(4);
  if (!(flags & FLAG_NET_ERROR)) return null;
  if (flags & (0x800 | 0x10000 | 0x20000 | 0x40000 | 0x80000)) return null; // a header we can't step over
  let o = 20;
  if (flags & 0x100) o += 8; // ServerSwitch
  if (flags & 0x200) o += 16; // LogonServerAddr
  for (const list of [0x1000, 0x2000]) {
    if (!(flags & list)) continue;
    if (o + 4 > buf.length) return null;
    o += 4 + 4 * buf.readUInt32LE(o);
  }
  if (flags & 0x4000) o += 4; // AckSequence
  return o + 4 <= buf.length ? buf.readUInt32LE(o) : null;
}

/**
 * Whether a server datagram explicitly refuses the login in a way that
 * proves no account was created by it (the session's pending new-account
 * markers are then dropped). A silent drop or a client close says nothing.
 *   1999: the connectionless NetError blob (flags 0x100000, {u32 id, u32 table}).
 *   End of retail: a NetError optional header (GDLE); ACE's CharacterError
 *   AccountDoesntExist / Logon; AccountBanned (the account exists); an
 *   AccountBoot for a wrong password (the account exists). Not a boot for
 *   any other reason: ACE's client-version boot comes after its auto-create.
 */
export function readLoginRefusal(buf: Buffer, protocol: 'eor' | 'ac1999'): boolean {
  if (protocol === 'ac1999') {
    return buf.length >= 28 && (buf.readUInt32LE(4) & FLAG_NET_ERROR) !== 0 && NO_CREATION_NET_ERRORS.has(buf.readUInt32LE(20));
  }
  const id = netErrorIdEor(buf);
  if (id !== null) return NO_CREATION_NET_ERRORS.has(id);
  for (const m of readSingleFragmentMessages(buf)) {
    if (m.length < 4) continue;
    const op = m.readUInt32LE(0);
    if (op === OPCODE_CHARACTER_ERROR && m.length >= 8 && NO_CREATION_CHARACTER_ERRORS.has(m.readUInt32LE(4))) return true;
    if (op === OPCODE_ACCOUNT_BANNED) return true;
    if (op === OPCODE_ACCOUNT_BOOT && m.length >= 6) {
      const n = m.readUInt16LE(4);
      if (6 + n <= m.length && /password/i.test(m.toString('latin1', 6, 6 + n))) return true;
    }
  }
  return false;
}


// ─── File helpers ──────────────────────────────────────

function errno(err: unknown): string | undefined { return (err as NodeJS.ErrnoException)?.code; }

function setMtime(file: string, at: number): void {
  const s = at / 1000;
  try { fs.utimesSync(file, s, s); } catch { /* removed meanwhile */ }
}

function mtimeOf(file: string): number | null {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function unlinkQuiet(file: string): void {
  try { fs.unlinkSync(file); } catch { /* gone */ }
}

/** Write a file atomically (temp + rename), its mtime set to `at`. */
function writeAtomic(file: string, content: string, at: number): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content);
  setMtime(tmp, at);
  fs.renameSync(tmp, file);
}

/** A filesystem-safe name for an address or world key. */
function safeName(s: string): string { return s.toLowerCase().replace(/[^a-z0-9._-]/g, '_'); }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The JSON in a session lock file. */
interface SessionRecord {
  sessionId: string;
  pid: number;
  startedAt: number;
  world: string;
  realIpHash: string;
  slot: string;
}

// ─── The manager ───────────────────────────────────────

/** A session's hold on a slot. */
export interface EgressLease {
  readonly sessionId: string;
  readonly world: string;
  /** The local address the session's UDP socket binds to (a login for a new account may move it: checkLogin 'moved'). */
  readonly localAddress: string;
  /** The address the game server sees (null for static: the local address is it). */
  readonly publicIp: string | null;
  /** The world limits new accounts per real IP (check every login). */
  readonly accountRule: boolean;
  /** Free the slot (idempotent). */
  release(): void;
}

export type EgressRefusal = 'ip_cap' | 'full';

/**
 * checkLogin's answer. 'moved': allowed, on another slot (the session's
 * address had made the world's accountsPerAddress creations): rebind before
 * forwarding. 'new_account_cap': the real IP's limit. 'new_account_unavailable':
 * no address that may still create an account could be had.
 */
export type LoginVerdict = 'ok' | 'moved' | 'new_account_cap' | 'new_account_unavailable';

export type AcquireResult =
  | { ok: true; lease: EgressLease }
  | { ok: false; refusal: EgressRefusal; detail: string };

interface LeaseState {
  record: SessionRecord;
  file: string;
  released: boolean;
  /** The slot's public address (null for static). */
  publicIp: string | null;
  /** For each unknown account let through: the address (addrKey) its creation counts against. */
  loginAddr: Map<string, string>;
  /** The account whose pending markers this session's latest login wrote (an explicit refusal drops them). */
  lastNewLogin: string | null;
  /** Account hashes this session's logins were let through for. */
  allowed: Set<string>;
}

export interface EgressManagerOptions {
  config: EgressConfig;
  provider: EgressProvider;
  log?: Logger;
  now?: () => number;
  /** Run timers (refresh, reconcile, grace releases); tests turn them off and call the steps. */
  timers?: boolean;
  /** start()'s first reconcile is waited for at most this long (default 15 s); it goes on in the background. */
  startReconcileMs?: number;
  /** Retry delays after a failed start (startWithRetry), the last repeating. Default 30 s, 2 min, 10 min. */
  startRetryMs?: number[];
}

/** shutdown waits this long for stop() at most (AWS calls are bounded too, but a release per slot adds up). */
export const STOP_DEADLINE_MS = 20_000;

export class EgressManager {
  readonly worlds: ReadonlyMap<string, EgressWorld>;
  private slots: EgressSlot[] = [];
  private readonly dir: string;
  private readonly graceMs: number;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly timers: boolean;
  private salt = '';
  private readonly leases = new Map<string, LeaseState>();
  private readonly releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  /** AWS work under way (attach, detach, reconcile); stop() waits for it. */
  private readonly inflight = new Set<Promise<unknown>>();
  /** Consecutive listings that missed a recorded allocation (it is forgotten after two). */
  private readonly misses = new Map<string, number>();
  private stopped = false;
  /** Why start() failed: every egress world is then refused as full. */
  private failed: string | null = null;

  constructor(private readonly opts: EgressManagerOptions) {
    this.worlds = opts.config.worlds;
    this.dir = opts.config.dir;
    this.graceMs = opts.config.graceMs;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? true;
  }

  /** Discover the slots, prepare the state dir, reconcile once and start the timers. Throws when there is no usable slot. */
  async start(): Promise<void> {
    for (const d of ['sessions', 'slots', 'accounts']) fs.mkdirSync(path.join(this.dir, d), { recursive: true });
    this.salt = await this.loadSalt();
    this.slots = await this.opts.provider.discoverSlots();
    if (this.slots.length === 0) throw new Error('egress: no slots (no secondary private IPv4s found and BRIDGE_EGRESS_SLOTS unset)');
    this.log('info', 'egress_start', { provider: this.opts.provider.name, slots: this.slots.map((s) => s.address), worlds: [...this.worlds.values()], graceSeconds: this.graceMs / 1000 });
    // Bounded: the bridge starts listening even when AWS is slow (the pass goes on, and never throws).
    const first = this.reconcile();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([first, new Promise<void>((r) => { timer = setTimeout(r, this.opts.startReconcileMs ?? 15_000); timer.unref?.(); })]);
    clearTimeout(timer);
    if (this.timers) {
      this.refreshTimer = setInterval(() => this.refresh(), SESSION_REFRESH_MS);
      this.refreshTimer.unref?.();
      this.reconcileTimer = setInterval(() => { void this.reconcile(); }, RECONCILE_INTERVAL_MS);
      this.reconcileTimer.unref?.();
    }
  }

  /** start() failed: refuse every egress world as full (the bridge keeps serving every other world). */
  disable(reason: string): void {
    this.failed = reason;
  }

  get disabled(): string | null { return this.failed; }

  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * start(), and on failure (logged loudly) keep the egress worlds refused
   * as full and try again after 30 s, 2 min, then every 10 min, until it
   * works or stop() is called. Never throws.
   */
  async startWithRetry(attempt = 0): Promise<void> {
    try {
      await this.start();
      if (this.failed) this.log('info', 'egress_start_recovered', { attempt });
      this.failed = null;
    } catch (err) {
      const reason = (err as Error)?.message ?? String(err);
      const delays = this.opts.startRetryMs ?? [30_000, 120_000, 600_000];
      const next = delays[Math.min(attempt, delays.length - 1)];
      this.failed = reason;
      this.log('error', 'egress_start_failed', { reason, worlds: [...this.worlds.keys()], attempt, retryInSeconds: next / 1000, note: 'egress worlds are refused as full until a retry succeeds' });
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.startWithRetry(attempt + 1); }, next);
      this.retryTimer.unref?.();
    }
  }

  /**
   * The bridge is exiting (its sessions already closed): wait for AWS work
   * under way, drop this process's session files, and give back at once (no
   * grace) the address of every slot no process has a session on, so nothing
   * is left billing for a successor that may never come.
   */
  async stop(deadlineMs = STOP_DEADLINE_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'deadline'>((r) => { timer = setTimeout(() => r('deadline'), deadlineMs); timer.unref?.(); });
    const how = await Promise.race([this.stopInner(), deadline]);
    clearTimeout(timer);
    if (how === 'deadline') this.log('warn', 'egress_stop_deadline', { seconds: deadlineMs / 1000, note: 'exiting with AWS work unfinished; the next reconciler frees what is left' });
  }

  private async stopInner(): Promise<'done'> {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.stopped) { await Promise.allSettled([...this.inflight]); return 'done'; }
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const t of this.releaseTimers.values()) clearTimeout(t);
    this.releaseTimers.clear();
    await Promise.allSettled([...this.inflight]);
    for (const l of this.leases.values()) { l.released = true; unlinkQuiet(l.file); }
    this.leases.clear();
    if (this.opts.provider.name === 'static' || this.failed) return 'done';
    const slots = new Set([...this.slots.map((s) => s.address), ...this.recordedSlots()]);
    for (const slot of this.spentFirst(slots)) await this.releaseIfIdle(slot, 0);
    return 'done';
  }

  isEgressWorld(key: string): boolean { return this.worlds.has(key.toLowerCase()); }

  slotAddresses(): string[] { return this.slots.map((s) => s.address); }

  /** A salted hash: real IPs and account names never reach the disk in clear. */
  hash(kind: string, value: string): string {
    return createHash('sha256').update(`${this.salt}\0${kind}\0${value}`).digest('hex').slice(0, 32);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = () => { this.inflight.delete(p); };
    p.then(done, done);
    return p;
  }

  // ── Acquire / release ──

  /**
   * A slot for a session to `worldKey` from `realIp`, with its public address
   * attached before this resolves (so the session's first datagram already
   * leaves from it). Refuses 'ip_cap' when the real IP already holds the
   * world's per-address session limit, 'full' when every slot does (or AWS
   * could not give one an address, or egress failed to start). Never throws.
   */
  async acquire(worldKey: string, realIp: string): Promise<AcquireResult> {
    const world = this.worlds.get(worldKey.toLowerCase());
    if (!world) return { ok: false, refusal: 'full', detail: 'not an egress world' };
    const realIpHash = this.hash('ip', realIpKey(realIp));
    if (this.failed) return this.refuse(world.key, realIpHash, 'full', `egress unavailable: ${this.failed}`);
    if (this.stopped) return this.refuse(world.key, realIpHash, 'full', 'egress stopped');
    let picked: { slot: EgressSlot; state: LeaseState } | { refusal: EgressRefusal; detail: string };
    try {
      picked = await this.withLock('alloc.lock', ALLOC_LOCK, async () => this.pick(world, realIpHash));
    } catch (err) {
      return this.refuse(world.key, realIpHash, 'full', `state: ${(err as Error).message}`);
    }
    if ('refusal' in picked) return this.refuse(world.key, realIpHash, picked.refusal, picked.detail);
    let { slot } = picked;
    const { state } = picked;
    this.leases.set(state.record.sessionId, state);
    const started = this.now();
    let held: HeldAddress | null = null;
    const tried = new Set<string>();
    for (;;) {
      // stop() began meanwhile: no new address for a bridge on its way out.
      if (this.stopped) {
        if (!state.released) this.dropLease(state);
        return this.refuse(world.key, realIpHash, 'full', 'egress stopped');
      }
      tried.add(slot.address);
      try {
        held = await this.track(this.ensureAddress(slot));
        break;
      } catch (err) {
        const failedSlot = slot.address;
        // Another slot that already holds an address with room takes the player instead.
        let alt: EgressSlot | null = null;
        try { alt = await this.withLock('alloc.lock', ALLOC_LOCK, async () => this.repick(world, state, tried)); } catch { alt = null; }
        if (!alt && !state.released) this.dropLease(state);
        // An address the failed slot already held keeps its normal grace (this session is off it now).
        if (this.readAddr(failedSlot) && !this.liveSessions().some((s) => s.slot === failedSlot)) this.scheduleRelease(failedSlot, this.graceMs);
        if (!alt) return this.refuse(world.key, realIpHash, 'full', `aws:${awsErrorCode(err)}`);
        this.log('info', 'egress_fallback', { world: world.key, from: failedSlot, to: alt.address, reason: `aws:${awsErrorCode(err)}` });
        slot = alt;
      }
    }
    if (this.stopped) {
      if (!state.released) this.dropLease(state);
      return this.refuse(world.key, realIpHash, 'full', 'egress stopped');
    }
    state.publicIp = held?.publicIp ?? null;
    const lease: EgressLease = {
      sessionId: state.record.sessionId,
      world: world.key,
      get localAddress() { return state.record.slot; },
      get publicIp() { return state.publicIp; },
      accountRule: world.newAccountsPerRealIp !== null || world.accountsPerAddress !== null,
      release: () => this.release(state),
    };
    this.log('info', 'egress_acquire', {
      egressSession: state.record.sessionId, world: world.key, slot: slot.address, publicIp: lease.publicIp,
      realIpHash, ms: this.now() - started,
    });
    return { ok: true, lease };
  }

  private refuse(world: string, realIpHash: string, refusal: EgressRefusal, detail: string): AcquireResult {
    this.log('info', 'egress_refused', { world, realIpHash, refusal, reason: detail });
    return { ok: false, refusal, detail };
  }

  /**
   * Under alloc.lock, after an attach failed: move the session to an untried
   * slot that already holds a working address and has room on its world
   * (no AWS call needed there), or null.
   */
  private repick(world: EgressWorld, state: LeaseState, tried: Set<string>): EgressSlot | null {
    if (state.released) return null;
    const onWorld = this.liveSessions().filter((s) => s.world === world.key && s.sessionId !== state.record.sessionId);
    const alt = this.slots
      .filter((sl) => !tried.has(sl.address))
      .filter((sl) => { const h = this.readAddr(sl.address); return !!h?.associationId && !h.releasing; })
      .map((sl) => ({ sl, count: onWorld.filter((s) => s.slot === sl.address).length }))
      .filter((c) => c.count < world.sessionsPerAddress)
      .sort((a, b) => a.count - b.count)[0]?.sl ?? null;
    if (!alt) return null;
    const from = state.record.slot;
    state.record.slot = alt.address;
    writeAtomic(state.file, JSON.stringify(state.record), this.now());
    this.touchActive(from);
    this.touchActive(alt.address);
    this.cancelReleaseTimer(alt.address);
    return alt;
  }

  /** Under alloc.lock: apply the per-real-IP cap, choose a slot and write the session's lock file. */
  private pick(world: EgressWorld, realIpHash: string): { slot: EgressSlot; state: LeaseState } | { refusal: EgressRefusal; detail: string } {
    const live = this.liveSessions();
    const onWorld = live.filter((s) => s.world === world.key);
    const mine = onWorld.filter((s) => s.realIpHash === realIpHash).length;
    if (mine >= world.sessionsPerAddress) return { refusal: 'ip_cap', detail: `real IP holds ${mine} of ${world.sessionsPerAddress} sessions on ${world.key}` };
    // Fewest sessions on this world first (one player per address while any is free), then a
    // slot that already holds an address (no new allocation), then the configured order.
    const ranked = this.slots
      // held: 0 an address that may still create accounts, 1 a spent one (fine for existing accounts), 2 none yet.
      .map((slot, i) => ({ slot, i, count: onWorld.filter((s) => s.slot === slot.address).length, held: this.readAddr(slot.address) ? (this.slotSpent(slot.address, world) ? 1 : 0) : 2 }))
      .filter((c) => c.count < world.sessionsPerAddress)
      .sort((a, b) => a.count - b.count || a.held - b.held || a.i - b.i);
    if (ranked.length === 0) return { refusal: 'full', detail: `all ${this.slots.length} slots carry ${world.sessionsPerAddress} sessions on ${world.key}` };
    const slot = ranked[0].slot;
    const at = this.now();
    const record: SessionRecord = {
      sessionId: `${process.pid}-${randomBytes(6).toString('hex')}`, pid: process.pid, startedAt: at,
      world: world.key, realIpHash, slot: slot.address,
    };
    const file = path.join(this.dir, 'sessions', `${record.sessionId}.json`);
    writeAtomic(file, JSON.stringify(record), at);
    this.touchActive(slot.address);
    this.cancelReleaseTimer(slot.address);
    return { slot, state: { record, file, released: false, allowed: new Set(), publicIp: null, loginAddr: new Map(), lastNewLogin: null } };
  }

  private release(state: LeaseState): void {
    if (state.released) return;
    this.dropLease(state);
    const slot = state.record.slot;
    this.log('info', 'egress_session_end', { egressSession: state.record.sessionId, world: state.record.world, slot, durationMs: this.now() - state.record.startedAt });
    try {
      if (this.liveSessions().some((s) => s.slot === slot)) return;
    } catch { /* the reconciler covers it */ }
    this.scheduleRelease(slot, this.graceMs);
  }

  private dropLease(state: LeaseState): void {
    state.released = true;
    this.leases.delete(state.record.sessionId);
    unlinkQuiet(state.file);
    this.touchActive(state.record.slot);
  }

  private scheduleRelease(slot: string, ms: number): void {
    if (!this.timers || this.stopped) return;
    this.cancelReleaseTimer(slot);
    const t = setTimeout(() => { this.releaseTimers.delete(slot); void this.releaseIfIdle(slot); }, ms + 250);
    t.unref?.();
    this.releaseTimers.set(slot, t);
  }

  private cancelReleaseTimer(slot: string): void {
    const t = this.releaseTimers.get(slot);
    if (t) { clearTimeout(t); this.releaseTimers.delete(slot); }
  }

  /**
   * Give back the slot's address if no process has a session on it and it
   * has been idle for `graceMs` (stop() passes 0). Under the slot's lock, so
   * it never races an attach (in this or the other process), and re-checked
   * there: a session that arrived meanwhile keeps it. Never throws.
   */
  releaseIfIdle(slot: string, graceMs = this.graceMs): Promise<'released' | 'busy' | 'none' | 'error'> {
    return this.track((async () => {
      try {
        return await this.withLock(this.slotLockName(slot), SLOT_LOCK, async () => {
          if (this.liveSessions().some((s) => s.slot === slot)) return 'busy' as const;
          const idle = this.now() - (mtimeOf(this.activeFile(slot)) ?? 0);
          if (idle < graceMs) { this.scheduleRelease(slot, graceMs - idle); return 'busy' as const; }
          const held = this.readAddr(slot);
          if (!held) return 'none' as const;
          await this.detachHeld(slot, held, graceMs === 0 ? 'shutdown' : 'idle', null);
          return 'released' as const;
        });
      } catch (err) {
        this.log('warn', 'egress_release', { slot, ok: false, reason: `aws:${awsErrorCode(err)}` });
        return 'error' as const;
      }
    })());
  }

  /**
   * Give back a recorded address. The record first stops claiming an
   * association, so an exit between disassociate and release leaves an
   * unassociated allocation, which the next attach or the reconciler gives
   * back. `listed`: the address as the provider listed it (its association
   * is current; the record's may not be).
   */
  private async detachHeld(slot: string, held: HeldAddress, why: string, listed: TaggedAddress | null): Promise<void> {
    const started = this.now();
    const associationId = listed ? listed.associationId : held.associationId;
    this.writeAddr(slot, { ...held, associationId: null, releasing: true });
    await this.opts.provider.detach({ ...held, associationId });
    unlinkQuiet(this.addrFile(slot));
    this.misses.delete(held.allocationId);
    this.log('info', 'egress_release', { slot, publicIp: held.publicIp, allocationId: held.allocationId, why, ok: true, ms: this.now() - started });
  }

  /** Give back a tagged address no record names. */
  private async detachListed(slot: string, t: TaggedAddress, why: string): Promise<void> {
    const started = this.now();
    await this.opts.provider.detach({ allocationId: t.allocationId, associationId: t.associationId, publicIp: t.publicIp, at: 0 });
    this.log('info', 'egress_release', { slot, publicIp: t.publicIp, allocationId: t.allocationId, why, ok: true, ms: this.now() - started });
  }

  /** The slot's public address: the one already held (by either process), else a new one. */
  private async ensureAddress(slot: EgressSlot, accept?: (publicIp: string) => boolean): Promise<HeldAddress | null> {
    if (this.opts.provider.name === 'static') return null;
    return this.withLock(this.slotLockName(slot.address), SLOT_LOCK, async () => {
      const have = this.readAddr(slot.address);
      if (have?.associationId && !have.releasing) return have;
      if (have) {
        // An exit mid-attach or mid-release left this one: give it back, by its listed association.
        const listed = (await this.opts.provider.listTagged()).find((t) => t.allocationId === have.allocationId) ?? null;
        if (listed) await this.detachHeld(slot.address, have, 'unfinished', listed);
        else unlinkQuiet(this.addrFile(slot.address));
      }
      const started = this.now();
      let held: HeldAddress | null;
      try {
        held = await this.opts.provider.attach(slot, (h) => this.writeAddr(slot.address, h), accept);
      } catch (err) {
        // Nothing half-made stays recorded (the provider already gave back what it allocated).
        unlinkQuiet(this.addrFile(slot.address));
        // A call that failed on our side may have succeeded at AWS (an associate whose answer
        // timed out): with AllowReassociation false that address would wedge the slot. Give back,
        // under the slot lock we hold, every address tagged for this slot that no record names.
        try {
          for (const t of (await this.opts.provider.listTagged()).filter((x) => x.slot === slot.address)) {
            await this.detachListed(slot.address, t, 'failed_attach');
          }
        } catch (cleanupErr) {
          this.log('warn', 'egress_release', { slot: slot.address, ok: false, why: 'failed_attach', reason: `aws:${awsErrorCode(cleanupErr)}` });
        }
        throw err;
      }
      if (!held) return null;
      this.writeAddr(slot.address, held);
      this.log('info', 'egress_associate', { slot: slot.address, eni: slot.eni, publicIp: held.publicIp, allocationId: held.allocationId, ms: this.now() - started });
      return held;
    });
  }

  // ── Reconcile ──

  /**
   * Free leaked addresses (each costs money): every tagged address of this
   * instance whose slot has no live session and has been idle past the
   * grace, and any the slot's record doesn't name. Under reconcile.lock (one
   * reconciler across processes) and each slot's lock (never against an
   * attach); a failing slot is logged and skipped. Never throws.
   */
  reconcile(): Promise<{ released: number; adopted: number; forgotten: number; errors: number } | null> {
    if (this.opts.provider.name === 'static' || this.stopped) return Promise.resolve(null);
    return this.track(this.reconcileOnce());
  }

  private async reconcileOnce(): Promise<{ released: number; adopted: number; forgotten: number; errors: number } | null> {
    let unlock: (() => void) | null;
    try { unlock = await this.lock('reconcile.lock', RECONCILE_LOCK); } catch { unlock = null; }
    if (!unlock) return null;
    const out = { released: 0, adopted: 0, forgotten: 0, errors: 0 };
    try {
      const listedAt = this.now();
      let tagged: TaggedAddress[];
      try {
        tagged = await this.opts.provider.listTagged();
      } catch (err) {
        this.log('warn', 'egress_reconcile', { ok: false, reason: `aws:${awsErrorCode(err)}` });
        return null;
      }
      const slotsSeen = this.spentFirst(new Set<string>([...tagged.map((t) => t.slot).filter(Boolean), ...this.recordedSlots()]));
      for (const slot of slotsSeen) {
        try {
          await this.withLock(this.slotLockName(slot), SLOT_LOCK, () => this.reconcileSlot(slot, tagged, listedAt, out));
        } catch (err) {
          out.errors++;
          this.log('warn', 'egress_reconcile', { slot, ok: false, reason: `aws:${awsErrorCode(err)}` });
        }
      }
      this.log('info', 'egress_reconcile', { tagged: tagged.length, ...out });
      return out;
    } finally {
      unlock();
    }
  }

  private async reconcileSlot(slot: string, tagged: TaggedAddress[], listedAt: number, out: { released: number; adopted: number; forgotten: number }): Promise<void> {
    const live = this.liveSessions().some((s) => s.slot === slot);
    const idle = this.now() - (mtimeOf(this.activeFile(slot)) ?? 0) >= this.graceMs;
    let held = this.readAddr(slot);
    const listedHeld = held ? tagged.find((t) => t.allocationId === held!.allocationId) ?? null : null;
    if (held && listedHeld) this.misses.delete(held.allocationId);
    if (held && !listedHeld && !live && held.at <= listedAt) {
      // A record whose address is gone (released by hand). Listings are eventually consistent,
      // so only after two consecutive misses, and never under live sessions.
      const n = (this.misses.get(held.allocationId) ?? 0) + 1;
      this.misses.set(held.allocationId, n);
      if (n >= 2) {
        unlinkQuiet(this.addrFile(slot));
        this.misses.delete(held.allocationId);
        held = null;
        out.forgotten++;
      }
    }
    for (const t of tagged.filter((x) => x.slot === slot)) {
      if (held && t.allocationId === held.allocationId) continue;
      if (!held && live && t.associationId) {
        // Live sessions use an address the record lost: keep it.
        held = { allocationId: t.allocationId, associationId: t.associationId, publicIp: t.publicIp, at: this.now() };
        this.writeAddr(slot, held);
        out.adopted++;
        continue;
      }
      // No record names it, so no session can be given it: release it now, grace or not
      // (a failed acquire touches the slot's activity, which would otherwise hold it forever).
      await this.detachListed(slot, t, 'orphan');
      out.released++;
    }
    if (held && listedHeld && !live && idle) {
      await this.detachHeld(slot, held, 'idle', listedHeld);
      out.released++;
    }
  }

  private recordedSlots(): string[] {
    try {
      return fs.readdirSync(path.join(this.dir, 'slots')).filter((f) => f.endsWith('.addr.json')).map((f) => f.slice(0, -'.addr.json'.length));
    } catch { return []; }
  }

  // ── New accounts per real IP ──

  /** Whether this session's login for `account` was already let through (no state-dir work). */
  loginAllowed(lease: EgressLease, account: string): boolean {
    const state = this.leases.get(lease.sessionId);
    const world = this.worlds.get(lease.world);
    if (!state || !world || !lease.accountRule) return true;
    return state.allowed.has(this.hash(`account:${world.key}`, account.toLowerCase()));
  }

  /**
   * Whether `account` may log in on this session (before the login reaches
   * the server, which creates an unknown account). An account that has
   * reached a character list through this bridge always may, from any
   * address. An unknown one (a possible creation) needs both:
   *   - the real IP under newAccountsPerRealIp (its created accounts plus
   *     its logins not yet resolved, by-ip markers);
   *   - an address the world will still let create one (accountsPerAddress,
   *     by-addr markers: the world counts creations per source address for
   *     life, and AWS hands released addresses back). When the session's
   *     address is spent, the session moves first to a slot holding an
   *     address with room (session and creation), else to a free slot with
   *     a newly allocated address ('moved'), else 'new_account_unavailable'.
   * The login leaves a pending marker for the IP and the address at once.
   * Throws only on a state-dir failure (the caller closes the session).
   */
  async checkLogin(lease: EgressLease, account: string): Promise<LoginVerdict> {
    const state = this.leases.get(lease.sessionId);
    const world = this.worlds.get(lease.world);
    if (!state || !world || !lease.accountRule) return 'ok';
    const ah = this.hash(`account:${world.key}`, account.toLowerCase());
    if (state.allowed.has(ah)) return 'ok';
    if (fs.existsSync(this.knownFile(world.key, ah))) { state.allowed.add(ah); return 'ok'; }
    const ipHash = state.record.realIpHash;
    type Plan = LoginVerdict | { allocate: EgressSlot };
    const plan = await this.withLock('alloc.lock', ALLOC_LOCK, async (): Promise<Plan> => {
      // The session ended while this waited: never write for it.
      if (state.released) return 'new_account_cap';
      const ipMarker = this.markerFile(world.key, ipHash, ah);
      if (fs.existsSync(ipMarker)) { state.lastNewLogin = null; return 'ok'; } // this IP's login for it already counts (an earlier login's marker: never dropped here)
      if (world.newAccountsPerRealIp !== null && this.countMarkers(this.ipDir(world.key, ipHash)) >= world.newAccountsPerRealIp) return 'new_account_cap';
      let verdict: LoginVerdict = 'ok';
      if (world.accountsPerAddress !== null && this.addrCount(world, this.addrKey(state)) >= world.accountsPerAddress) {
        const alt = this.slotWithCreationRoom(world, state);
        if (alt) {
          this.moveSession(state, alt.address, this.readAddr(alt.address)?.publicIp ?? null);
          verdict = 'moved';
        } else {
          const free = this.opts.provider.name === 'static' ? null : this.freeSlot(state);
          if (!free) return 'new_account_unavailable';
          // Reserve the free slot (others see the session there) and this IP's allowance, then allocate outside the lock.
          this.moveSession(state, free.address, null);
          this.writeMarker(ipMarker);
          return { allocate: free };
        }
      }
      this.writeMarker(ipMarker);
      this.addLoginAddr(state, world, ah);
      state.lastNewLogin = ah;
      return verdict;
    });
    let verdict: LoginVerdict;
    if (typeof plan === 'object') {
      try {
        const held = await this.track(this.ensureAddress(plan.allocate, (ip) => this.addrCount(world, ip) < world.accountsPerAddress!));
        if (state.released) return 'new_account_cap';
        state.publicIp = held?.publicIp ?? null;
        await this.withLock('alloc.lock', ALLOC_LOCK, async () => { this.addLoginAddr(state, world, ah); state.lastNewLogin = ah; });
        verdict = 'moved';
      } catch (err) {
        // The login is never forwarded, so nothing was created: give back the IP's reservation.
        unlinkQuiet(this.markerFile(world.key, ipHash, ah));
        this.log('info', 'egress_refused', { world: world.key, realIpHash: ipHash, refusal: 'new_account_unavailable', reason: `aws:${awsErrorCode(err)}` });
        return 'new_account_unavailable';
      }
    } else {
      verdict = plan;
    }
    if (verdict === 'ok' || verdict === 'moved') state.allowed.add(ah);
    if (verdict === 'moved') {
      this.log('info', 'egress_moved', { egressSession: state.record.sessionId, world: world.key, slot: state.record.slot, publicIp: state.publicIp, reason: 'address_spent' });
    } else if (verdict !== 'ok' && !state.released) {
      this.log('info', 'egress_refused', { world: world.key, realIpHash: ipHash, refusal: verdict });
    }
    return verdict;
  }

  /**
   * The server explicitly refused this session's latest login in a way that
   * proves it created no account (readLoginRefusal): drop the pending
   * markers that login wrote, for the real IP and the address. Markers an
   * earlier login wrote, or already resolved as created, stay. Throws only
   * on a state-dir failure (the caller closes the session).
   */
  loginRefused(lease: EgressLease): boolean {
    const state = this.leases.get(lease.sessionId);
    const world = this.worlds.get(lease.world);
    if (!state || !world || !state.lastNewLogin) return false;
    const ah = state.lastNewLogin;
    state.lastNewLogin = null;
    state.allowed.delete(ah);
    const addr = state.loginAddr.get(ah);
    state.loginAddr.delete(ah);
    let dropped = false;
    for (const marker of [this.markerFile(world.key, state.record.realIpHash, ah), ...(addr ? [path.join(this.addrDir(world.key, addr), ah)] : [])]) {
      if (readText(marker) === 'pending') { unlinkQuiet(marker); dropped = true; }
    }
    if (dropped) this.log('info', 'egress_login_refused', { world: world.key, realIpHash: state.record.realIpHash, address: addr ?? null });
    return dropped;
  }

  /**
   * The server's character list named `account`, listing `characters`. It is
   * known from now on. The pending markers this login left (for the real IP
   * and for the address) stay, as created, only when the evidence says the
   * login made it: the account was still unknown (no other session recorded
   * it first) and lists no characters (a just-created account has none);
   * otherwise they are dropped. Throws only on a state-dir failure (the
   * caller closes the session).
   */
  accountConfirmed(lease: EgressLease, account: string, characters: number): void {
    const state = this.leases.get(lease.sessionId);
    const world = this.worlds.get(lease.world);
    if (!state || !world || !lease.accountRule) return;
    const ah = this.hash(`account:${world.key}`, account.toLowerCase());
    const known = this.knownFile(world.key, ah);
    fs.mkdirSync(path.dirname(known), { recursive: true });
    let firstSeen = false;
    try { fs.writeFileSync(known, '', { flag: 'wx' }); firstSeen = true; } catch (err) { if (errno(err) !== 'EEXIST') throw err; }
    const created = firstSeen && characters === 0;
    const addr = state.loginAddr.get(ah);
    const markers = [this.markerFile(world.key, state.record.realIpHash, ah), ...(addr ? [path.join(this.addrDir(world.key, addr), ah)] : [])];
    let counted = false;
    for (const marker of markers) {
      if (!fs.existsSync(marker)) continue;
      if (created) { writeAtomic(marker, 'created', this.now()); counted = true; } else unlinkQuiet(marker);
    }
    if (firstSeen) {
      this.log('info', 'egress_account_known', {
        world: world.key, realIpHash: state.record.realIpHash, created: counted,
        ...(counted ? { createdByIp: this.countMarkers(this.ipDir(world.key, state.record.realIpHash)), address: addr ?? null, createdByAddress: addr ? this.addrCount(world, addr) : null } : {}),
      });
    }
    state.allowed.add(ah);
    if (state.lastNewLogin === ah) state.lastNewLogin = null;
  }

  private ipDir(world: string, ipHash: string): string { return path.join(this.dir, 'accounts', safeName(world), 'by-ip', ipHash); }
  /** Public addresses are this bridge's own, not players': kept in clear. */
  private addrDir(world: string, addr: string): string { return path.join(this.dir, 'accounts', safeName(world), 'by-addr', safeName(addr)); }

  private markerFile(world: string, ipHash: string, ah: string): string { return path.join(this.ipDir(world, ipHash), ah); }

  private writeMarker(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, 'pending', this.now());
  }

  /** The address the world sees for this session: the public IP, or (static) the slot itself. */
  private addrKey(state: LeaseState): string { return state.publicIp ?? state.record.slot; }

  /** Count the login's possible creation against the session's address (when the world limits it). */
  private addLoginAddr(state: LeaseState, world: EgressWorld, ah: string): void {
    if (world.accountsPerAddress === null) return;
    const addr = this.addrKey(state);
    this.writeMarker(path.join(this.addrDir(world.key, addr), ah));
    state.loginAddr.set(ah, addr);
  }

  /** Accounts created (or possibly created, pending) on `world` through public address `addr`. */
  addrCount(world: EgressWorld, addr: string): number { return this.countMarkers(this.addrDir(world.key, addr)); }

  /** The slot's address has made the world's accountsPerAddress creations (for `world`, or any world when omitted). */
  private slotSpent(slot: string, world?: EgressWorld): boolean {
    const addr = this.readAddr(slot)?.publicIp ?? (this.opts.provider.name === 'static' ? slot : null);
    if (!addr) return false;
    const worlds = world ? [world] : [...this.worlds.values()];
    return worlds.some((w) => w.accountsPerAddress !== null && this.addrCount(w, addr) >= w.accountsPerAddress);
  }

  /** Slots in the order idle addresses should go back: spent ones first (the least useful). */
  private spentFirst(slots: Iterable<string>): string[] {
    const all = [...slots];
    return [...all.filter((s) => this.slotSpent(s)), ...all.filter((s) => !this.slotSpent(s))];
  }

  /** Under alloc.lock: another slot holding a working address with session room and creation room on the world. */
  private slotWithCreationRoom(world: EgressWorld, state: LeaseState): EgressSlot | null {
    const onWorld = this.liveSessions().filter((s) => s.world === world.key && s.sessionId !== state.record.sessionId);
    return this.slots
      .filter((sl) => sl.address !== state.record.slot)
      .map((sl) => {
        const h = this.readAddr(sl.address);
        const addr = h ? (h.associationId && !h.releasing ? h.publicIp : null) : (this.opts.provider.name === 'static' ? sl.address : null);
        return { sl, addr, count: onWorld.filter((s) => s.slot === sl.address).length };
      })
      .filter((c) => c.addr !== null && c.count < world.sessionsPerAddress && this.addrCount(world, c.addr) < world.accountsPerAddress!)
      .sort((a, b) => a.count - b.count)[0]?.sl ?? null;
  }

  /** Under alloc.lock: a slot with no address and no session (a new address can be allocated there). */
  private freeSlot(state: LeaseState): EgressSlot | null {
    const live = this.liveSessions().filter((s) => s.sessionId !== state.record.sessionId);
    return this.slots.find((sl) => sl.address !== state.record.slot && !this.readAddr(sl.address) && !live.some((s) => s.slot === sl.address)) ?? null;
  }

  /** Under alloc.lock: put the session on `slot` (its lock file says so for every process); the old slot gets its normal grace. */
  private moveSession(state: LeaseState, slot: string, publicIp: string | null): void {
    const from = state.record.slot;
    state.record.slot = slot;
    state.publicIp = publicIp;
    writeAtomic(state.file, JSON.stringify(state.record), this.now());
    this.touchActive(from);
    this.touchActive(slot);
    this.cancelReleaseTimer(slot);
    if (!this.liveSessions().some((s) => s.slot === from)) this.scheduleRelease(from, this.graceMs);
  }

  /**
   * Markers in `dir` (a real IP's or an address's): created accounts, and
   * logins for unknown accounts not yet resolved by a character list (the
   * server may have created them; a session that closed first leaves its
   * marker counted). An unresolved marker expires after PENDING_MARKER_TTL_MS.
   */
  private countMarkers(dir: string): number {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return 0; }
    let n = 0;
    for (const name of names) {
      if (name.endsWith('.tmp')) continue;
      const file = path.join(dir, name);
      if (readText(file) === 'pending' && this.now() - (mtimeOf(file) ?? 0) > PENDING_MARKER_TTL_MS) { unlinkQuiet(file); continue; }
      n++;
    }
    return n;
  }


  private knownFile(world: string, ah: string): string { return path.join(this.dir, 'accounts', safeName(world), 'known', ah); }



  // ── Session files ──

  /** Touch this process's session files (they are live). */
  refresh(): void {
    const at = this.now();
    for (const l of this.leases.values()) setMtime(l.file, at);
  }

  /** Every live session record across processes; stale ones (a dead process's) are removed. */
  liveSessions(): SessionRecord[] {
    const dir = path.join(this.dir, 'sessions');
    const out: SessionRecord[] = [];
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return out; }
    const now = this.now();
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      const m = mtimeOf(file);
      if (m === null) continue;
      if (now - m > SESSION_STALE_MS) {
        this.takeOverIfStale(file, SESSION_STALE_MS);
        continue;
      }
      try { out.push(JSON.parse(fs.readFileSync(file, 'utf8')) as SessionRecord); } catch { /* being written */ }
    }
    return out;
  }

  // ── Slot files ──

  private slotLockName(slot: string): string { return path.join('slots', `${safeName(slot)}.lock`); }
  private addrFile(slot: string): string { return path.join(this.dir, 'slots', `${safeName(slot)}.addr.json`); }
  private activeFile(slot: string): string { return path.join(this.dir, 'slots', `${safeName(slot)}.active`); }

  private touchActive(slot: string): void {
    const f = this.activeFile(slot);
    try { fs.writeFileSync(f, ''); } catch { return; }
    setMtime(f, this.now());
  }

  private readAddr(slot: string): HeldAddress | null {
    try { return JSON.parse(fs.readFileSync(this.addrFile(slot), 'utf8')) as HeldAddress; } catch { return null; }
  }

  private writeAddr(slot: string, h: HeldAddress): void {
    const at = this.now();
    writeAtomic(this.addrFile(slot), JSON.stringify({ ...h, at }), at);
  }

  // ── Locks ──

  private async loadSalt(): Promise<string> {
    const file = path.join(this.dir, 'salt');
    // Written aside and linked into place, so a reader never sees it half-written.
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, randomBytes(32).toString('hex'), { mode: 0o600 });
    try { fs.linkSync(tmp, file); } catch (err) { if (errno(err) !== 'EEXIST') throw err; } finally { unlinkQuiet(tmp); }
    const s = fs.readFileSync(file, 'utf8').trim();
    if (!s) throw new Error('egress: empty salt file');
    return s;
  }

  /**
   * Take a mutex: exclusive-create `name` holding a fresh token, taking over
   * a stale one; touched every keepaliveMs while held. Resolves with the
   * unlock, or null when `waitMs` is 0 and it is held; throws when a wait
   * runs out.
   */
  private async lock(name: string, timing: LockTiming): Promise<(() => void) | null> {
    const file = path.join(this.dir, name);
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
    const deadline = Date.now() + timing.waitMs;
    for (;;) {
      try {
        fs.writeFileSync(file, token, { flag: 'wx' });
        setMtime(file, this.now());
        break;
      } catch (err) {
        if (errno(err) !== 'EEXIST') throw err;
      }
      if (this.takeOverIfStale(file, timing.staleMs)) continue;
      if (timing.waitMs === 0) return null;
      if (Date.now() > deadline) throw new Error(`egress: ${name} is held`);
      await sleep(5 + Math.floor(Math.random() * 15));
    }
    const keep = setInterval(() => { if (readText(file) === token) setMtime(file, this.now()); }, timing.keepaliveMs);
    keep.unref?.();
    return () => {
      clearInterval(keep);
      // Only our own: a holder that lost its lock to a takeover must not delete the new owner's.
      if (readText(file) === token) unlinkQuiet(file);
    };
  }

  private async withLock<T>(name: string, timing: LockTiming, fn: () => Promise<T>): Promise<T> {
    const unlock = await this.lock(name, timing);
    if (!unlock) throw new Error(`egress: ${name} is held`);
    try { return await fn(); } finally { unlock(); }
  }

  /**
   * Remove `file` if it is older than `staleMs` (its holder died). It is
   * renamed aside first (one process wins the rename) and deleted only if
   * what was renamed is the same stale file that was looked at (same
   * contents, still stale); a fresh lock grabbed in between is put back.
   * True when the caller may try again.
   */
  private takeOverIfStale(file: string, staleMs: number): boolean {
    const m = mtimeOf(file);
    if (m === null) return true;
    if (this.now() - m <= staleMs) return false;
    const seen = readText(file);
    if (seen === null) return true;
    const aside = `${file}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
    try { fs.renameSync(file, aside); } catch { return false; }
    const got = readText(aside);
    const m2 = mtimeOf(aside);
    if (got === seen && m2 !== null && this.now() - m2 > staleMs) { unlinkQuiet(aside); return true; }
    try { fs.linkSync(aside, file); } catch { /* a newer one is in place */ }
    unlinkQuiet(aside);
    return false;
  }
}

/**
 * The bridge's egress manager for its config, started (slots discovered,
 * first reconcile done), or null when BRIDGE_EGRESS_SERVERS is unset: then
 * nothing here runs and the AWS SDK is never loaded. A start failure (no
 * IMDS, no slots, a configured slot missing) never takes the bridge down:
 * it is logged at error level and the manager refuses its worlds as full,
 * while every other world keeps working, and retries in the background
 * (startWithRetry).
 */
export async function startEgress(
  config: EgressConfig | null, log: Logger, provider?: EgressProvider,
  opts: Pick<EgressManagerOptions, 'startRetryMs' | 'startReconcileMs' | 'timers'> = {},
): Promise<EgressManager | null> {
  if (!config) return null;
  const manager = new EgressManager({ config, provider: provider ?? makeEgressProvider(config), log, ...opts });
  await manager.startWithRetry();
  return manager;
}
