/**
 * What VirindiTank's looting does beyond the loot rules
 * (docs/vtank-parity-gaps.md §3.3–§3.6): which corpses it may open (the
 * corpse book), reading unknown scrolls, and mana donors. The routine engine
 * asks it per corpse item (`itemAction`) and between corpses (`step`).
 */
import type { AgentApi } from '../AgentApi.ts';
import type { AgentResult } from '../types.ts';
import { CorpseBook, corpseBookSettings, type CorpseBookSettings } from './corpseBook.ts';
import { DRAIN_CONFIRM, donorNeedsLook, isDonor, manaLootAction, planDrain, type DonorProps, type StoneItem } from './manaDonorPlan.ts';
import { canReadScroll, isScrollRefusal, ITEM_TYPE_WRITABLE, scrollSpell, type ScrollContext } from './scrollPlan.ts';

type Settings = Record<string, string | number | boolean | undefined>;
const on = (v: unknown): boolean => v === true || v === 1 || (typeof v === 'string' && /^(true|1|yes|on)$/i.test(v));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** How long a corpse's description is waited for: VTank's max(1, CorpseOpenTimeoutSeconds × 2) (MOSS). */
const describeWaitMs = (st: Settings): number => Math.max(1000, (Number(st.CorpseOpenTimeoutSeconds) || 1.5) * 2000);
/** A scroll the server neither read nor refused is tried this many times. */
const READ_TRIES = 3;

export interface LootItemView { guid: number; name: string; itemType: number; uiEffects?: number; descFlags?: number }

export class LootExtras {
  readonly book = new CorpseBook();
  /** Scrolls taken to read: guid → its spell, and tries. */
  private reads = new Map<number, { name: string; spell: string; tries: number }>();
  /** Items taken for their mana, waiting for a stone. */
  private donors = new Set<number>();
  /** The corpse pass now running: stones and donors it took. */
  private passStones = 0;
  private passDonors = 0;
  /** Donors whose look in hand was asked for. */
  private asked = new Set<number>();

  constructor(private readonly api: AgentApi, private readonly now: () => number, private readonly report: (text: string) => void) {}

  settings(st: Settings): CorpseBookSettings { return corpseBookSettings(st); }

  /** Your fellows (not you) and whether each shares loot. */
  fellows(): Array<{ name: string; shareLoot: boolean }> {
    const f = this.api.fellowshipInfo();
    if (!f) return [];
    const me = this.api.self()?.name ?? '';
    const sharing = new Set((f.sharing ?? []).map((n) => n.toLowerCase()));
    return (f.members ?? []).filter((n) => n !== me).map((n) => ({ name: n, shareLoot: sharing.has(n.toLowerCase()) }));
  }

  /** Examine a corpse for its "Killed by …" (one look, waited for as VTank does), and note it in the book. */
  async describe(guid: number, st: Settings): Promise<void> {
    const reply = await Promise.race([this.api.appraise(guid, { quiet: true }), sleep(describeWaitMs(st)).then(() => null)]);
    const data = (reply?.data ?? this.api.itemData(guid)) as { string?: Record<number, string> } | null | undefined;
    const text = data?.string?.[16] ?? (reply?.ok ? /^Killed by [^\n]*?\./m.exec(reply.message)?.[0] : undefined);
    this.book.describe(guid, text ?? null, this.now());
  }

  // ── the items on a corpse ──

  /** A corpse pass starts (what it takes for mana is counted per pass). */
  beginPass(): void { this.passStones = 0; this.passDonors = 0; }

  private carried(): Array<StoneItem & { descFlags?: number }> {
    return this.api.inventory().map((i) => ({ guid: i.guid, name: i.name, itemType: i.itemType, uiEffects: i.uiEffects, equipped: i.where === 'equipped', descFlags: i.objectDescFlags }));
  }
  private donorsWaiting(): number {
    const have = new Set(this.api.inventory().map((i) => i.guid));
    for (const g of [...this.donors]) if (!have.has(g)) this.donors.delete(g);
    return this.donors.size + this.passDonors;
  }
  private manaCtx(consumables: readonly string[], st: Settings) {
    return {
      carried: this.carried(), consumables, donorsWaiting: this.donorsWaiting(), takenStones: this.passStones,
      stoneCount: Number(st.ManaStoneLootCount ?? 4), minimum: Number(st.ManaTankMinimumMana ?? 1000),
    };
  }

  /** Whether an item no rule settles needs examining for these checks: a scroll (ReadUnknownScrolls), or a magic item while a spare stone waits. */
  needsLook(item: LootItemView, consumables: readonly string[], st: Settings): boolean {
    if (on(st.ReadUnknownScrolls) && item.itemType & ITEM_TYPE_WRITABLE) return true;
    return donorNeedsLook(item, this.manaCtx(consumables, st));
  }

  private scrollCtx(): ScrollContext {
    const table = this.api.spellTableData();
    const byName = new Map<string, { school: number; power: number }>();
    if (table) for (const s of table.spells.values()) byName.set(s.name.toLowerCase(), { school: s.school, power: s.power });
    return {
      known: new Set(this.api.spells('', 5000).map((s) => s.name)),
      spell: (n) => byName.get(n.toLowerCase()) ?? null,
      skill: (id) => this.api.skillList().find((x) => x.id === id)?.buffed ?? null,
    };
  }

  /**
   * What looting does with an item no rule took (or a rule left): 'read' (ReadUnknownScrolls: a scroll you can
   * learn), 'stone' / 'donor' (mana donors), or null to leave it. Each one taken is remembered for {@link step}.
   */
  itemAction(item: LootItemView, props: (DonorProps & { spells?: string[] }) | null | undefined, consumables: readonly string[], st: Settings): 'read' | 'stone' | 'donor' | null {
    if (on(st.ReadUnknownScrolls)) {
      const spell = scrollSpell(item, props);
      if (spell && ![...this.reads.values()].some((r) => r.spell.toLowerCase() === spell.toLowerCase()) && canReadScroll(spell, this.scrollCtx())) {
        this.reads.set(item.guid, { name: item.name, spell, tries: 0 });
        return 'read';
      }
    }
    const mana = manaLootAction(item, props, this.manaCtx(consumables, st));
    if (mana === 'stone') this.passStones++;
    if (mana === 'donor') { this.passDonors++; this.donors.add(item.guid); }
    return mana;
  }

  /** A Read rule took this item: a scroll is read later (as VTank: when ReadUnknownScrolls is on and you can learn it). */
  readTaken(item: LootItemView, props: { spells?: string[] } | null | undefined): void {
    const spell = scrollSpell(item, props);
    if (spell) this.reads.set(item.guid, { name: item.name, spell, tries: 0 });
  }

  /** The donor a pass took is now in your pack (its look goes on with it). */
  get waitingDonors(): ReadonlySet<number> { return this.donors; }
  get waitingReads(): ReadonlyMap<number, { name: string; spell: string }> { return this.reads; }

  // ── between corpses ──

  /** The next scroll to read or donor to drain, or null. */
  step(consumables: readonly string[], st: Settings): { label: string; run: () => Promise<AgentResult> } | null {
    return this.readStep(st) ?? this.drainStep(consumables, st);
  }

  private readStep(st: Settings): { label: string; run: () => Promise<AgentResult> } | null {
    if (!this.reads.size) return null;
    const have = new Set(this.api.inventory().map((i) => i.guid));
    const ctx = this.scrollCtx();
    for (const [g, r] of [...this.reads]) {
      if (!have.has(g)) { this.reads.delete(g); continue; }
      // Known since (another copy read), or no longer learnable: kept, not read.
      if (!on(st.ReadUnknownScrolls) || !canReadScroll(r.spell, ctx)) { this.reads.delete(g); continue; }
      return { label: `read ${r.name}`, run: async () => {
        const since = this.api.currentSeq();
        r.tries++;
        const res = await this.api.use(g);
        const gone = !this.api.inventory().some((i) => i.guid === g);
        const refusal = this.api.eventsSince(since).find((e) => e.type === 'chat' && isScrollRefusal(e.text.replace(/^\([a-z]+\) /, '')));
        if (gone) { this.reads.delete(g); this.report(`Read ${r.name}`); return { ok: true, message: `read ${r.name}` }; }
        if (refusal || r.tries >= READ_TRIES) {
          this.reads.delete(g);
          const why = refusal ? refusal.text.replace(/^\([a-z]+\) /, '') : 'the server did not answer';
          this.report(`Kept ${r.name} unread: ${why}`);
          return { ok: false, message: `kept ${r.name} unread: ${why}` };
        }
        return { ok: false, message: res.message.split('\n')[0] };
      } };
    }
    return null;
  }

  private drainStep(consumables: readonly string[], st: Settings): { label: string; run: () => Promise<AgentResult> } | null {
    if (!this.donorsWaiting()) return null;
    const min = Number(st.ManaTankMinimumMana ?? 1000);
    const carried = this.carried();
    // A donor whose look in hand says it isn't one after all (written on, tinkered, worn) is kept, not drained.
    for (const g of [...this.donors]) {
      const it = carried.find((i) => i.guid === g);
      if (!it) continue;
      const d = this.api.itemData(g);
      if (!d) { if (!this.asked.has(g)) { this.asked.add(g); void this.api.appraise(g, { quiet: true }); } continue; }
      if (it.equipped || !isDonor(d, min, it.descFlags)) { this.donors.delete(g); this.report(`Kept ${it.name}: not drained (worn, written on, tinkered or too little mana)`); }
    }
    const plan = planDrain(carried, this.donors, consumables, min, (x) => this.api.itemData(x));
    if (!plan) return null;
    return { label: `drain ${plan.donor.name} into ${plan.stone.name}`, run: async () => {
      const since = this.api.currentSeq();
      const r = this.api.useOn(plan.stone.guid, plan.donor.guid);
      if (!r.ok) { this.donors.delete(plan.donor.guid); return r; }
      // The client's own "destroy … and drain its mana into this stone?" is answered Yes, should it come up.
      for (let i = 0; i < 30; i++) {
        const ask = this.api.openDialogs().find((x) => DRAIN_CONFIRM.test(x.text));
        if (ask) this.api.dialog('Yes');
        if (!this.api.inventory().some((x) => x.guid === plan.donor.guid)) break;
        await sleep(200);
      }
      this.donors.delete(plan.donor.guid);
      const gone = !this.api.inventory().some((x) => x.guid === plan.donor.guid);
      const said = this.api.eventsSince(since).filter((e) => e.type === 'chat').map((e) => e.text.replace(/^\([a-z]+\) /, '')).find((l) => /drains .* points of mana/.test(l));
      if (gone) { this.report(`Drained ${plan.donor.name} into ${plan.stone.name}`); void this.api.appraise(plan.stone.guid, { quiet: true }); return { ok: true, message: said ?? `drained ${plan.donor.name}` }; }
      this.report(`Kept ${plan.donor.name}: the stone did not take its mana`);
      return { ok: false, message: `${plan.donor.name} was not drained` };
    } };
  }
}
