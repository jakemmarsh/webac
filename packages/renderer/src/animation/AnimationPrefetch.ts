import type { MotionTable } from '@ac/dat-parser/file-types/MotionTable.js';
import { FetchPriority, type DatStore } from '../dat/streaming/DatStore.js';

/**
 * STREAM.style-animations-on-first-use (webac#16) — a motion table's
 * animations for one style, asked for as an object takes that style.
 *
 * Retail reads every Animation from the local portal.dat when CSequence
 * first needs it (CMotionTable::GetObjectSequence → add_motion →
 * AnimSequenceNode::set_animation_id), so a swing plays the moment its
 * MovementEvent lands. A streamed set's closure prefetches only the table's
 * default style (DatClosure 0x09: the peace idles a spawned creature
 * shows), and nothing fetched a combat style's animations before their first
 * use (docs/dat-streaming.md §2.3 planned it at the stance change):
 *  - an AC1999 Banderling Captain's first swing of each kind in SwordCombat
 *    missed, MotionManager dropped the action, and the captain stood in its
 *    idle while its hit landed (webac#16 0:16);
 *  - our first Stamina to Mana Self after drawing the wand missed the Magic
 *    gesture link, and the retry put the hands-out hold on with no gesture,
 *    a snap (0:45).
 *
 * This asks for every animation of the style the object enters (its
 * cycles, the links out of its substates, its modifiers: the keys whose
 * high word is the style) at prefetch priority: the ones not resident,
 * each time a style is entered (the store dedupes a file already in
 * flight). The style change's own link (~0.5-0.75 s) covers the fetch; an
 * action that still finds its file missing waits for it
 * (MotionManager, STREAM.action-held-for-animation).
 * A Banderling's SwordCombat is 24 files; the 1999 human table's largest
 * combat style 40. The default style is already in the closure.
 */
export class AnimationPrefetch {
  /** Each (table, style)'s animation ids, read once per session. */
  private readonly ids = new Map<string, number[]>();

  /**
   * `fetch` requests one Animation (the streamed store); null = whole DATs, nothing to do.
   * `isResident` (the store's): with it, a style entered again asks for the
   * files no longer resident (the store's LRU evicts leaves unused for
   * minutes, STREAM.style-prefetch-after-eviction); without it, once per
   * table and style per session.
   */
  constructor(
    private readonly fetch: ((animId: number) => void) | null = null,
    private readonly isResident: ((animId: number) => boolean) | null = null,
  ) {}

  /** Request `style`'s animations of `table` that are not resident. Returns how many files were asked for. */
  style(table: MotionTable, style: number): number {
    if (!this.fetch) return 0;
    const s = style & 0xffff;
    const key = `${table.id >>> 0}:${s}`;
    let ids = this.ids.get(key);
    if (ids) {
      if (!this.isResident) return 0;
    } else {
      ids = styleAnimationIds(table, s);
      this.ids.set(key, ids);
    }
    let asked = 0;
    for (const id of ids) {
      if (this.isResident?.(id)) continue;
      this.fetch(id);
      asked++;
    }
    return asked;
  }

  /** (table, style) pairs asked for so far (tests / diagnostics). */
  get requested(): number { return this.ids.size; }
}

/** Every Animation id `table` plays in `style` (low word): its cycles, links and modifiers keyed by that style. */
export function styleAnimationIds(table: MotionTable, style: number): number[] {
  const s = style & 0xffff;
  const out = new Set<number>();
  const inStyle = (key: number) => ((key >>> 16) & 0xffff) === s;
  for (const [k, md] of table.cycles) if (inStyle(k)) for (const a of md.anims) out.add(a.animId >>> 0);
  for (const [k, inner] of table.links) if (inStyle(k)) for (const md of inner.values()) for (const a of md.anims) out.add(a.animId >>> 0);
  for (const [k, md] of table.modifiers) if (inStyle(k)) for (const a of md.anims) out.add(a.animId >>> 0);
  out.delete(0);
  return [...out];
}

/**
 * The streamed world store's prefetcher. The style's animations go out at
 * Critical priority (STREAM.held-action-starved, 2026-11-03): they are needed
 * within the style change's own link (~0.5-0.75 s), and at Prefetch the
 * limiter holds them while any critical load runs or waits (the
 * critical-first rule), which in a fight on a slow or high-latency link is
 * nearly always: with 1 s on every object fetch, an AC1999 Banderling
 * Captain's SwordCombat swing 0x03000570, asked for on entering the style at
 * 4.9 s, was still missing at 9.9 s, so the swing was held, then dropped
 * after ACTION_ANIMATION_HOLD_MAX_S. Small files (24-40 per style), each
 * fetched once (the store dedupes in-flight and resident ones).
 */
export function storeAnimationPrefetch(store: Pick<DatStore, 'request' | 'isResident'>): AnimationPrefetch {
  return new AnimationPrefetch(
    (id) => { void store.request('portal', id, FetchPriority.Critical).catch(() => false); },
    (id) => store.isResident('portal', id),
  );
}

/** The session's prefetcher (set once at boot when the world DATs stream). */
let current = new AnimationPrefetch();
export function setAnimationPrefetch(p: AnimationPrefetch): void { current = p; }
export function animationPrefetch(): AnimationPrefetch { return current; }
