/**
 * UtilityBelt's inventory passes (docs/vtank-parity-gaps.md §6.2-6.3):
 * `/ub autostack` and `/ub autocram` (one pass of the macro's own
 * Autostack / Autocram, whether or not those options are on) and
 * `/ub clearbugged` (`/ub count` is in ui/automation/metaCommands.ts). Behaviour from UtilityBelt's help (MIT; its
 * command list and chat wording): "Auto Stack your inventory", "Auto Cram
 * into side packs", "Counts matching items, or the players around you", "ID
 * everything in your inventory, and remove bugged items".
 */
import { planInventory, type InventoryTidy, type TidyApi } from './inventoryPlan.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One `/ub autostack` or `/ub autocram` pass on the macro's tidy runner (the
 * same owner, so the two never move items at once): it says it is running,
 * moves one item at a time, each after the server answered the last, and
 * says it is complete once nothing is left; with nothing to do it says so.
 */
export class TidyPass {
  private run: { mode: 'stack' | 'cram'; gen: number } | null = null;
  private gen = 0;
  constructor(private readonly tidy: InventoryTidy, private readonly api: TidyApi, private readonly report: (text: string) => void, private readonly tickMs = 250) {}

  get running(): boolean { return this.run !== null; }

  start(mode: 'stack' | 'cram'): string {
    const name = mode === 'stack' ? 'AutoStack' : 'AutoCram';
    const opts = { autostack: mode === 'stack', autocram: mode === 'cram' };
    this.run = null;
    if (!planInventory({ items: this.api.itemSlots(), packs: this.api.packs(), ...opts, ignored: this.tidy.ignored, ...(this.tidy.keepIn ? { keepIn: this.tidy.keepIn() } : {}) })) return `${name} - nothing to do`;
    const gen = ++this.gen;
    this.run = { mode, gen };
    void (async () => {
      while (this.run?.gen === gen) {
        const r = this.tidy.step(opts);
        if (r.kind === 'abandoned' && r.text) this.report(r.text);
        if (r.kind === 'idle') { this.run = null; this.report(`${name} complete.`); return; }
        await sleep(this.tickMs);
      }
    })();
    return `${name} running`;
  }

  stop(): void { this.run = null; }
}

export interface ClearBuggedApi {
  /** What you carry that could be a ghost: not worn, and not a pack that still lists contents. */
  candidates(): Array<{ guid: number; name: string }>;
  /** Ask the server to identify an item (quietly, no examine window). */
  identify(guid: number): void;
  /** The server's last answer about an item: whether it described it, and when. */
  answer(guid: number): { success: boolean; at: number } | undefined;
  /** Let go of an item the server no longer has. */
  forget(guid: number): void;
  now(): number;
}

/**
 * `/ub clearbugged`: asks the server to describe every item you carry, one
 * request every half second, and lets go of the ones it no longer has (the
 * "ghost" items a client keeps listing after the server lost them). A
 * refusal alone proves little (the server also refuses a repeat request
 * within five seconds of a failed one), so an item counts as a ghost only
 * when it is refused twice, the second request at least five seconds after
 * the first refusal. An item that never answers is left alone.
 */
export async function clearBugged(api: ClearBuggedApi, opts: { intervalMs?: number; recheckMs?: number; waitMs?: number } = {}): Promise<string[]> {
  const interval = opts.intervalMs ?? 500, recheck = opts.recheckMs ?? 5000, wait = opts.waitMs ?? 6000;
  const ask = async (guid: number): Promise<boolean | null> => {
    const sent = api.now();
    api.identify(guid);
    for (let t = 0; t < wait; t += 100) {
      await sleep(100);
      const a = api.answer(guid);
      if (a && a.at >= sent) return a.success;
    }
    return null;
  };
  const items = api.candidates();
  const removed: string[] = [];
  for (const it of items) {
    const first = await ask(it.guid);
    await sleep(interval);
    if (first !== false) continue;
    await sleep(recheck);
    if ((await ask(it.guid)) === false) { api.forget(it.guid); removed.push(it.name); }
    await sleep(interval);
  }
  return [`Clear Bugged: checked ${items.length} item${items.length === 1 ? '' : 's'}; ${removed.length ? `removed ${removed.length}: ${removed.join(', ')}` : 'none were bugged'}.`];
}
