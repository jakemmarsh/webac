/**
 * AGENT.vtank-window — VirindiTank's Enable Autostack and Enable Autocram
 * (docs/vtank-macro-behavior.md §1), and UtilityBelt's `/ub autostack` /
 * `/ub autocram` passes: the next pack tidy-up, one at a time, each waiting
 * for the server's answer before the next (docs/vtank-parity-gaps.md §6.1).
 *
 * - Autostack: stacks of one kind (the same weenie class) merge toward the
 *   heaviest place. Items rank by where they are (the main pack first, then
 *   side packs from the lightest), then by their own weight: the first is
 *   moved onto the last that still has room, as much as fits (a partial
 *   merge). So stacks gather in the side packs, onto the bigger stack, and
 *   one partial stack is left (VTank stacks toward one item, "also into side
 *   packs", CHG .157). What you wear or wield never moves: arrows stay in the
 *   ammo slot (CHG .159).
 * - `keepIn` (Mag-Tools Autopack's placement, @ac/shared mtAutopackPlacement):
 *   an item a Keep # rule placed only ever moves to a pack in its list, so the
 *   tidy never undoes Autopack (neither a cram nor a merge onto a stack in
 *   another pack). Placement wins; the tidy works around it.
 * - Autocram: the first item in the main pack moves to the first side pack
 *   with room. Packs, foci (they take a pack slot) and worn things stay.
 */

export interface InvItem {
  guid: number; name: string; packSlot: number; stack: number; maxStack: number; wcid: number; isPack: boolean; equipped: boolean;
  /** Its burden (a pack's includes what it holds); the stack size stands in when unknown. */
  burden?: number;
}
export interface InvPack { slot: number; guid: number; capacity: number; count: number }
export type InvAction = { kind: 'merge'; from: number; onto: number; why: string } | { kind: 'move'; guid: number; packSlot: number; why: string };

export function planInventory(input: { items: InvItem[]; packs: InvPack[]; autostack: boolean; autocram: boolean; ignored?: ReadonlySet<number>; keepIn?: ReadonlyMap<number, readonly number[]> }): InvAction | null {
  const ignored = input.ignored ?? new Set<number>();
  const allowed = (i: InvItem, packSlot: number) => { const k = input.keepIn?.get(i.guid); return !k || k.includes(packSlot); };
  const loose = input.items.filter((i) => !i.equipped && !i.isPack && !ignored.has(i.guid) && i.packSlot >= 0);
  if (input.autostack) {
    const packWeight = new Map(input.packs.map((p) => [p.slot, input.items.find((i) => i.guid === p.guid)?.burden ?? 0]));
    // The main pack ranks first, then side packs lightest first; within one, the lighter item first.
    const rank = (i: InvItem) => (i.packSlot === 0 ? 0 : 1e9 + (packWeight.get(i.packSlot) ?? 0) * 1e3 + i.packSlot) + (i.burden ?? i.stack) / 1e6;
    const groups = new Map<number, InvItem[]>();
    for (const i of loose) {
      if (i.maxStack <= 1 || i.stack <= 0 || !i.wcid) continue;
      const g = groups.get(i.wcid) ?? [];
      g.push(i);
      groups.set(i.wcid, g);
    }
    for (const g of [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) {
      if (g.length < 2) continue;
      g.sort((a, b) => rank(a) - rank(b) || a.guid - b.guid);
      // The first item that may go onto a later one with room (without keepIn, always the first: the rest
      // can only reach a subset of its candidates).
      for (let f = 0; f < g.length - 1; f++) {
        const from = g[f]!;
        for (let k = g.length - 1; k > f; k--) {
          const onto = g[k]!;
          if (onto.stack >= onto.maxStack) continue;
          if (onto.packSlot !== from.packSlot && !allowed(from, onto.packSlot)) continue;
          return { kind: 'merge', from: from.guid, onto: onto.guid, why: `stack ${from.name} (${from.stack}) onto ${onto.stack}` };
        }
        if (!input.keepIn?.size) break;
      }
    }
  }
  if (input.autocram) {
    const side = input.packs.filter((p) => p.slot > 0 && p.count < p.capacity && !ignored.has(p.guid)).sort((a, b) => a.slot - b.slot)[0];
    const item = side ? loose.find((i) => i.packSlot === 0 && allowed(i, side.slot)) : undefined;
    if (side && item) return { kind: 'move', guid: item.guid, packSlot: side.slot, why: `cram ${item.name} into side pack ${side.slot}` };
  }
  return null;
}

/** What the tidy-up reads and does (AgentApi's itemSlots / packs / placeItem). */
export interface TidyApi {
  itemSlots(): InvItem[];
  packs(): InvPack[];
  placeItem(guid: number, to: { packSlot: number } | { onto: number }): { ok: boolean; message: string };
}

/**
 * One tidy-up move at a time, waiting for the server's answer (the moved
 * item's place or stack changes, or it is gone) before planning the next. A
 * move the server doesn't answer within `waitMs` counts as a failure; after
 * `abandonAfter` failures the two items are left alone as bugged (UB:
 * "Abandoned trying to stack/cram two bugged items") until `clearIgnored`.
 */
export class InventoryTidy {
  private pending: { guids: number[]; sig: string; at: number; key: string } | null = null;
  private readonly failures = new Map<string, number>();
  readonly ignored = new Set<number>();
  /** Mag-Tools Autopack's placement (`planInventory` keepIn), read each step; the lead sets it when Mag-Tools runs. */
  keepIn: (() => ReadonlyMap<number, readonly number[]>) | null = null;
  constructor(private readonly api: TidyApi, private readonly now: () => number, private readonly opts: { waitMs?: number; abandonAfter?: number } = {}) {}

  private sig(guids: number[], items: InvItem[]): string {
    return guids.map((g) => { const i = items.find((x) => x.guid === g); return i ? `${i.packSlot}:${i.stack}` : 'gone'; }).join('|');
  }

  /** Still waiting for the last move's answer. */
  get waiting(): boolean { return this.pending !== null; }

  /**
   * The next step: 'moved' (a move went out; `text` says what), 'waiting'
   * (for the last move's answer), 'abandoned' (two items given up on), or
   * 'idle' (nothing to do).
   */
  step(mode: { autostack: boolean; autocram: boolean }): { kind: 'moved' | 'waiting' | 'abandoned' | 'idle'; text?: string } {
    const items = this.api.itemSlots();
    if (this.pending) {
      if (this.sig(this.pending.guids, items) !== this.pending.sig) {
        this.failures.delete(this.pending.key);
        this.pending = null;
      } else if (this.now() - this.pending.at < (this.opts.waitMs ?? 5000)) {
        return { kind: 'waiting' };
      } else {
        const p = this.pending;
        this.pending = null;
        const n = (this.failures.get(p.key) ?? 0) + 1;
        this.failures.set(p.key, n);
        if (n >= (this.opts.abandonAfter ?? 3)) {
          for (const g of p.guids) this.ignored.add(g);
          this.failures.delete(p.key);
          return { kind: 'abandoned', text: 'Abandoned trying to stack/cram two bugged items.' };
        }
      }
    }
    for (const g of [...this.ignored]) if (!items.some((i) => i.guid === g) && !this.api.packs().some((p) => p.guid === g)) this.ignored.delete(g);
    const plan = planInventory({ items, packs: this.api.packs(), ...mode, ignored: this.ignored, ...(this.keepIn ? { keepIn: this.keepIn() } : {}) });
    if (!plan) return { kind: 'idle' };
    const guids = plan.kind === 'merge' ? [plan.from, plan.onto] : [plan.guid];
    const r = plan.kind === 'merge' ? this.api.placeItem(plan.from, { onto: plan.onto }) : this.api.placeItem(plan.guid, { packSlot: plan.packSlot });
    const key = plan.kind === 'merge' ? `${plan.from}>${plan.onto}` : `${plan.guid}>${plan.packSlot}`;
    if (!r.ok) {
      // Refused before anything went out: counts toward giving up, no wait.
      const n = (this.failures.get(key) ?? 0) + 1;
      this.failures.set(key, n);
      if (n >= (this.opts.abandonAfter ?? 3)) { for (const g of guids) this.ignored.add(g); this.failures.delete(key); return { kind: 'abandoned', text: 'Abandoned trying to stack/cram two bugged items.' }; }
      return { kind: 'waiting', text: `${plan.why}: ${r.message}` };
    }
    this.pending = { guids, sig: this.sig(guids, items), at: this.now(), key };
    return { kind: 'moved', text: `${plan.why}: ${r.message}` };
  }

  /** Forget the items given up on (UB's /ub clearbugged starts afresh). */
  clearIgnored(): number { const n = this.ignored.size; this.ignored.clear(); this.failures.clear(); return n; }
}
