/**
 * Mag-Tools' Autopack, the inventory packer (docs/plugin-specs/magtools.md §9.1), rebuilt from
 * the spec (clean room). UI-free: a planner (the next move or null) and a runner that makes one
 * move at a time over an injected host.
 *
 * - Only Keep # rules (our `keep-up-to`) place items. The number is a list of pack indices, one
 *   per digit: 0 = the main pack, 1 = the first side pack … "12" = side pack 1, else 2. Pack
 *   indices are our pack slots (AgentApi packs(): 0 main, 1+ side packs).
 * - Digits are tried in pack index order 0..9 (spec: "the first listed pack that has a free slot
 *   (pack index order 0..9)"), so the first-choice pack is the lowest listed index.
 * - Each pass: first auto-stack (merge a non-full stack into another non-full stack of the same
 *   name in the same pack), then auto-pack (move one item to the first listed pack with room).
 *   Done when nothing moved and no appraisal is pending.
 * - Equipped and wielded items, packs and foci never move.
 *
 * Living beside VirindiTank's Autostack / Autocram (renderer agent/macro/inventoryPlan.ts): the
 * rule is placement wins. `mtAutopackPlacement` gives every item a Keep # rule places, with the
 * packs it may sit in; the tidy (planInventory's `keepIn`) never moves such an item to a pack
 * outside its list, neither by a cram nor by merging it onto a stack elsewhere. Autopack in turn
 * only stacks within one pack, which the tidy's cross-pack stacking can't undo for a placed item.
 * And the runner waits while the tidy has a move out (`host.busy`), so their moves never cross.
 */
import type { LootRule } from '../routines/RoutineDoc.js';

export interface MtPackItem {
  id: number;
  name: string;
  /** Its pack slot (0 = main pack, 1+ = side packs); negative when not in a pack. */
  pack: number;
  stack: number;
  maxStack: number;
  equipped: boolean;
  /** A pack (container) itself. */
  isContainer: boolean;
  /** A focus (Foci take a pack slot and never move). */
  isFocus?: boolean;
}

export interface MtPackInfo {
  /** The pack slot (0 = main, 1+ side packs). */
  index: number;
  id: number;
  capacity: number;
  /** Items it holds now. */
  count: number;
}

/** A rule's answer for one item: the packs it may sit in (index order), null for none, or 'appraise' when the profile needs an appraisal first. */
export type MtKeepPacks = readonly number[] | null | 'appraise';

/** A Keep # number as pack indices: one per digit, unique, in index order ("21" → [1, 2]). */
export function mtKeepPackDigits(count: number | undefined): number[] | null {
  if (count === undefined || !Number.isFinite(count) || count < 0) return null;
  const digits = [...String(Math.trunc(count))].map(Number);
  return [...new Set(digits)].sort((a, b) => a - b);
}

/** The packs a loot rule places an item in: only Keep # (keep-up-to) rules place. */
export function mtAutopackRulePacks(rule: LootRule | null): number[] | null {
  if (!rule || rule.disabled || rule.action !== 'keep-up-to') return null;
  return mtKeepPackDigits(rule.count);
}

export type MtAutopackMove =
  | { kind: 'merge'; from: number; onto: number; why: string }
  | { kind: 'move'; id: number; pack: number; why: string };

const movable = (i: MtPackItem) => !i.equipped && !i.isContainer && !i.isFocus && i.pack >= 0;

/** The next Autopack move, and the items whose rule needs an appraisal first. */
export function mtPlanAutopack(input: {
  items: readonly MtPackItem[];
  packs: readonly MtPackInfo[];
  keepPacks: (item: MtPackItem) => MtKeepPacks;
  /** Items to leave alone (blacklisted). */
  skip?: ReadonlySet<number>;
}): { move: MtAutopackMove | null; appraise: number[] } {
  const skip = input.skip ?? new Set<number>();
  const loose = input.items.filter((i) => movable(i) && !skip.has(i.id));
  // 1. Auto-stack: within one pack, a non-full stack onto another non-full stack of the same name.
  const seen = new Map<string, MtPackItem>();
  for (const i of loose) {
    if (i.maxStack <= 1 || i.stack >= i.maxStack) continue;
    const key = `${i.pack}\u0000${i.name}`;
    const first = seen.get(key);
    if (first) return { move: { kind: 'merge', from: i.id, onto: first.id, why: `stack ${i.name} in pack ${i.pack}` }, appraise: [] };
    seen.set(key, i);
  }
  // 2. Auto-pack.
  const appraise: number[] = [];
  const packs = new Map(input.packs.map((p) => [p.index, p]));
  for (const i of loose) {
    const k = input.keepPacks(i);
    if (k === 'appraise') { appraise.push(i.id); continue; }
    if (!k || k.length === 0) continue;
    const listed = [...k].sort((a, b) => a - b);
    if (i.pack === listed[0]) continue;
    for (const p of listed) {
      if (p === i.pack) break; // already in a listed pack, and no earlier one has room
      const pk = packs.get(p);
      if (pk && pk.count < pk.capacity) return { move: { kind: 'move', id: i.id, pack: p, why: `pack ${i.name} into pack ${p}` }, appraise };
    }
  }
  return { move: null, appraise };
}

/**
 * The items a Keep # rule places, with the packs each may sit in: what VirindiTank's tidy must
 * respect (inventoryPlan `keepIn`). Items still waiting for an appraisal are not pinned.
 */
export function mtAutopackPlacement(items: readonly MtPackItem[], keepPacks: (item: MtPackItem) => MtKeepPacks): Map<number, readonly number[]> {
  const out = new Map<number, readonly number[]>();
  for (const i of items) {
    if (!movable(i)) continue;
    const k = keepPacks(i);
    if (Array.isArray(k) && k.length) out.set(i.id, [...k].sort((a, b) => a - b));
  }
  return out;
}

/** A chat line that starts Autopack: any non-say line containing `<me> autopack`, case-insensitive (typically a tell from your other character). The line is then hidden. */
export function mtIsAutopackTrigger(text: string, me: string, isSay: boolean): boolean {
  if (isSay || !me) return false;
  return text.toLowerCase().includes(`${me.toLowerCase()} autopack`);
}

export const MT_AUTOPACK_STARTED = 'Auto Pack - Started.';
export const MT_AUTOPACK_COMPLETED = 'Auto Pack - Completed.';

/** What Autopack reads and does in the game. */
export interface MtAutopackHost {
  /** What you carry (AgentApi itemSlots, with foci flagged). */
  items(): MtPackItem[];
  /** The main pack and side packs (AgentApi packs). */
  packs(): MtPackInfo[];
  /** Whether a profile is loaded (`<Character>.AutoPack.utl`, else `Default.AutoPack.utl`). No profile: Autopack does nothing, silently. */
  hasProfile(): boolean;
  /** The profile's answer for an item (mtAutopackRulePacks over the rule that matches it). */
  keepPacks(item: MtPackItem): MtKeepPacks;
  /** Move into a pack, or merge onto a stack (AgentApi placeItem); false when refused at once. */
  place(id: number, to: { pack: number } | { onto: number }): boolean;
  /** Ask the server to appraise an item quietly. */
  appraise(id: number): void;
  /** A `<{Mag-Tools}>: ` line (the host adds the prefix). */
  print(text: string): void;
  /** Something else is moving items (VirindiTank's tidy has a move out, a vendor is open …): wait. */
  busy?(): boolean;
}

export type MtAutopackStep = 'idle' | 'busy' | 'waiting' | 'moved' | 'appraising' | 'done';

/**
 * The packer's loop, one `step()` per 100 ms tick. A move waits for its answer (the item's pack
 * or stack changes, or it's gone); one unanswered for `retryMs` is tried again, and an item that
 * still hasn't moved `blacklistMs` (10 s) after its first try is blacklisted.
 */
export class MtAutopacker {
  private active = false;
  private pending: { ids: number[]; sig: string; at: number } | null = null;
  private readonly firstTry = new Map<number, number>();
  private readonly asked = new Map<number, number>();
  readonly blacklist = new Set<number>();

  constructor(private readonly host: MtAutopackHost, private readonly now: () => number, private readonly opts: { retryMs?: number; blacklistMs?: number; appraiseMs?: number } = {}) {}

  get running(): boolean { return this.active; }

  /** `/mt autopack`, the Pack Inventory hotkey or a trigger line. False (and silent) without a profile. */
  start(): boolean {
    if (!this.host.hasProfile()) return false;
    this.active = true;
    this.pending = null;
    this.firstTry.clear();
    this.asked.clear();
    this.blacklist.clear();
    this.host.print(MT_AUTOPACK_STARTED);
    return true;
  }

  stop(): void { this.active = false; this.pending = null; }

  private sig(ids: number[], items: MtPackItem[]): string {
    return ids.map((id) => { const i = items.find((x) => x.id === id); return i ? `${i.pack}:${i.stack}` : 'gone'; }).join('|');
  }

  step(): MtAutopackStep {
    if (!this.active) return 'idle';
    if (this.host.busy?.()) return 'busy';
    const items = this.host.items();
    const t = this.now();
    if (this.pending) {
      if (this.sig(this.pending.ids, items) !== this.pending.sig) {
        for (const id of this.pending.ids) this.firstTry.delete(id);
        this.pending = null;
      } else if (t - this.pending.at < (this.opts.retryMs ?? 2000)) {
        return 'waiting';
      } else {
        this.pending = null;
      }
    }
    // Blacklist what has failed for 10 s.
    for (const [id, at] of this.firstTry) {
      if (t - at >= (this.opts.blacklistMs ?? 10000)) {
        this.firstTry.delete(id);
        if (!this.blacklist.has(id)) {
          this.blacklist.add(id);
          const name = items.find((i) => i.id === id)?.name ?? '';
          this.host.print(`Blacklisting item: ${id}, ${name}`);
        }
      }
    }
    // An appraisal not back within appraiseMs counts as no rule (the item is skipped).
    const keepPacks = (i: MtPackItem): MtKeepPacks => {
      const k = this.host.keepPacks(i);
      if (k === 'appraise' && this.asked.has(i.id) && t - this.asked.get(i.id)! >= (this.opts.appraiseMs ?? 10000)) return null;
      return k;
    };
    const plan = mtPlanAutopack({ items, packs: this.host.packs(), keepPacks, skip: this.blacklist });
    if (plan.move) {
      const m = plan.move;
      const ids = m.kind === 'merge' ? [m.from, m.onto] : [m.id];
      const mover = m.kind === 'merge' ? m.from : m.id;
      if (!this.firstTry.has(mover)) this.firstTry.set(mover, t);
      const ok = m.kind === 'merge' ? this.host.place(m.from, { onto: m.onto }) : this.host.place(m.id, { pack: m.pack });
      if (ok) this.pending = { ids, sig: this.sig(ids, items), at: t };
      return 'moved';
    }
    const waitingOn = plan.appraise.filter((id) => !this.asked.has(id) || t - this.asked.get(id)! < (this.opts.appraiseMs ?? 10000));
    if (waitingOn.length) {
      for (const id of waitingOn) if (!this.asked.has(id)) { this.asked.set(id, t); this.host.appraise(id); }
      return 'appraising';
    }
    this.active = false;
    this.host.print(MT_AUTOPACK_COMPLETED);
    return 'done';
  }
}
