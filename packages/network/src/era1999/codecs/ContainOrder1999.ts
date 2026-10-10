/**
 * The 1999 server's spawn-into-a-pack order, put into end-of-retail order (docs/ac1999-support.md,
 * "Spawned into a pack").
 *
 * CContainerWeenie::SpawnInContainer (AC1999 Server/Source/Container.cpp:773-830) is how a vendor
 * buy, a quest or emote reward and a corpse's loot reach a container. It sends the 0x22
 * InventoryPutObjInContainer {item, container, slot, type} BEFORE MakeAware (the item's 0xF745
 * CreateObject), and links the item to the container only after both, in OnReceiveInventoryItem.
 * So the create is built for a free object: no container (PublicWeenieDesc 0x4000) and a world
 * POSITION (PhysicsDesc 0x8000) from the item's unset frame (ObjectMsgs.cpp BuildPhysicsDesc1999
 * gives a position to anything not yet contained). The 1999 client queued the event until the
 * object existed; our end-of-retail handlers expect ACE's order (CreateObject with the container,
 * then 0x22) and drop a 0x22 for an object they don't know, so the bought item never reached the
 * pack.
 *
 * This stage runs over each 1999 message's end-of-retail output (Adapter1999's `inboundOrder`):
 *   - an EoL 0x22 event whose item no 0xF745 / 0xF746 has created this session is held;
 *   - that item's 0xF745 then goes out with the held event's container written in (header bit
 *     0x4000, the u32 in the EoL field order) and the stray POSITION removed, as ACE sends a
 *     contained item, followed at once by the held event(s);
 *   - a held event is released unchanged once it is `holdMs` old (checked as messages arrive) or
 *     when more than `maxHeld` are waiting, so a mismatch can't swallow events.
 * A create that already names a container or wielder is passed through unchanged.
 */
import type { AdapterContext, Codecs1999 } from '../Adapter1999.js';

/** The EoL GameEvent InventoryPutObjInContainer. */
const PUT_IN_CONTAINER = 0x22;

/** PhysicsDesc bits (both eras), in the end-of-retail read order after POSITION. */
const PD = {
  Position: 0x8000, Movement: 0x10000, AnimFrame: 0x20000,
  MTable: 0x2, STable: 0x800, PeTable: 0x1000, CSetup: 0x1, Parent: 0x20, Children: 0x40,
  ObjScale: 0x80, Friction: 0x100, Elasticity: 0x200, Translucency: 0x40000, Velocity: 0x4,
  Acceleration: 0x8, Omega: 0x10, DefaultScript: 0x2000, DefaultScriptIntensity: 0x4000,
} as const;
/** Fixed-size PhysicsDesc sections after POSITION, in read order (CHILDREN is variable). */
const PD_AFTER_POSITION: ReadonlyArray<readonly [number, number]> = [
  [PD.MTable, 4], [PD.STable, 4], [PD.PeTable, 4], [PD.CSetup, 4], [PD.Parent, 8], [PD.Children, -1],
  [PD.ObjScale, 4], [PD.Friction, 4], [PD.Elasticity, 4], [PD.Translucency, 4], [PD.Velocity, 12],
  [PD.Acceleration, 12], [PD.Omega, 12], [PD.DefaultScript, 4], [PD.DefaultScriptIntensity, 4],
];
/** WeenieHeaderFlag sizes before CONTAINER, in the end-of-retail read order (plural is a String16). */
const WD_BEFORE_CONTAINER: ReadonlyArray<readonly [number, number]> = [
  [0x1, -1], [0x2, 1], [0x4, 1], [0x100, 2], [0x8, 4], [0x10, 4], [0x20, 4], [0x80000, 4], [0x80, 4],
  [0x200, 1], [0x400, 2], [0x800, 2], [0x1000, 2], [0x2000, 2],
];
const WD_CONTAINER = 0x4000;
const WD_WIELDER = 0x8000;
/** ObjectDescriptionFlag.IncludesSecondHeader: a u32 header2 follows the bitfield. */
const BF_INCLUDES_SECOND_HEADER = 0x04000000;

const u16 = (m: Uint8Array, at: number) => m[at] | (m[at + 1] << 8);
const u32 = (m: Uint8Array, at: number) => (m[at] | (m[at + 1] << 8) | (m[at + 2] << 16) | (m[at + 3] << 24)) >>> 0;
const align4 = (n: number) => (n + 3) & ~3;
const le32 = (v: number) => Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * An end-of-retail 0xF745 CreateObject placed in `container`: the WeenieDesc gains CONTAINER and the
 * PhysicsDesc loses POSITION. Unchanged when it already has a container or wielder. Throws on a
 * message too short for its own flags.
 */
export function placeCreateInContainer(m: Uint8Array, container: number): Uint8Array {
  let p = 8; // opcode, guid
  const packed = () => { p += (u16(m, p) & 0x8000) ? 4 : 2; };
  // ObjDesc: 0x11, three counts, the palette / texture / anim-part changes, align.
  const nSub = m[p + 1], nTex = m[p + 2], nAnim = m[p + 3];
  p += 4;
  if (nSub > 0) { packed(); for (let i = 0; i < nSub; i++) { packed(); p += 2; } }
  for (let i = 0; i < nTex; i++) { p += 1; packed(); packed(); }
  for (let i = 0; i < nAnim; i++) { p += 1; packed(); }
  p = align4(p);
  // PhysicsDesc.
  const physAt = p;
  const flags = u32(m, p);
  p += 8; // flags, state
  if (flags & PD.Movement) { const len = u32(m, p); p += 4 + len + (len > 0 ? 4 : 0); } else if (flags & PD.AnimFrame) p += 4;
  const posAt = p;
  if (flags & PD.Position) p += 32;
  const posEnd = p;
  for (const [bit, size] of PD_AFTER_POSITION) {
    if (!(flags & bit)) continue;
    p += size >= 0 ? size : 4 + 8 * u32(m, p);
  }
  p = align4(p + 18); // nine u16 timestamps
  // WeenieDesc.
  const weenieAt = p;
  const header = u32(m, p);
  if (header & (WD_CONTAINER | WD_WIELDER)) return m;
  p += 4;
  p += align4(2 + u16(m, p)); // name
  packed(); packed(); // wcid, icon
  const bitfield = u32(m, p + 4);
  p = align4(p + 8); // type, bitfield
  if (bitfield & BF_INCLUDES_SECOND_HEADER) p += 4;
  for (const [bit, size] of WD_BEFORE_CONTAINER) {
    if (!(header & bit)) continue;
    p += size >= 0 ? size : align4(2 + u16(m, p));
  }
  if (p > m.length) throw new RangeError(`CreateObject ${m.length} bytes is shorter than its flags (${p})`);
  return concat([
    m.subarray(0, physAt), le32(flags & ~PD.Position), m.subarray(physAt + 4, posAt), m.subarray(posEnd, weenieAt),
    le32(header | WD_CONTAINER), m.subarray(weenieAt + 4, p), le32(container), m.subarray(p),
  ]);
}

export interface ContainOrder1999Options {
  /** Milliseconds (default Date.now). */
  now?: () => number;
  /** How long a 0x22 waits for its item's CreateObject before it goes out as it is (default 3000). */
  holdMs?: number;
  /** The most 0x22s held at once; past it the oldest goes out (default 32). */
  maxHeld?: number;
}

interface Held { item: number; container: number; message: Uint8Array; at: number }

export class ContainOrder1999 {
  private readonly known = new Set<number>();
  private held: Held[] = [];
  private readonly now: () => number;
  private readonly holdMs: number;
  private readonly maxHeld: number;

  constructor(opts: ContainOrder1999Options = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.holdMs = opts.holdMs ?? 3000;
    this.maxHeld = opts.maxHeld ?? 32;
  }

  /** How many 0x22 events are waiting for their item's CreateObject. */
  get pending(): number { return this.held.length; }

  /** One 1999 message's end-of-retail output, reordered (expired holds go first). */
  process(out: Uint8Array[], ctx: AdapterContext): Uint8Array[] {
    const now = this.now();
    const res: Uint8Array[] = [];
    while (this.held.length && now - this.held[0].at >= this.holdMs) {
      const h = this.held.shift()!;
      ctx.log(`[1999] 0x22 for 0x${h.item.toString(16)} got no CreateObject in ${this.holdMs} ms; passed on as it is`);
      res.push(h.message);
    }
    for (const m of out) {
      const op = m.length >= 8 ? u32(m, 0) : 0;
      if (op === 0xf745 || op === 0xf746) {
        const guid = u32(m, 4);
        this.known.add(guid);
        const mine = this.held.filter((h) => h.item === guid);
        if (op === 0xf745 && mine.length) {
          this.held = this.held.filter((h) => h.item !== guid);
          let create = m;
          try {
            create = placeCreateInContainer(m, mine[0].container);
          } catch (err) {
            ctx.log(`[1999] CreateObject 0x${guid.toString(16)} could not take its container: ${(err as Error).message}`);
          }
          res.push(create, ...mine.map((h) => h.message));
          continue;
        }
      } else if (op === 0xf747) {
        this.known.delete(u32(m, 4));
      } else if (op === 0xf7b0 && m.length >= 24 && u32(m, 12) === PUT_IN_CONTAINER) {
        const item = u32(m, 16);
        if (!this.known.has(item)) {
          this.held.push({ item, container: u32(m, 20), message: m, at: now });
          if (this.held.length > this.maxHeld) res.push(this.held.shift()!.message);
          continue;
        }
      }
      res.push(m);
    }
    return res;
  }
}

/** Install the stage as the adapter's inbound reordering (codecs1999 does; tests may). */
export function registerContainOrder1999(c: Codecs1999, opts: ContainOrder1999Options = {}): ContainOrder1999 {
  const stage = new ContainOrder1999(opts);
  c.inboundOrder = (out, ctx) => stage.process(out, ctx);
  return stage;
}
