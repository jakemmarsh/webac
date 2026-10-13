/**
 * Mag-Tools' mana tracker (docs/plugin-specs/magtools.md §5.1, §2.3 Trackers → Mana): every
 * worn item's mana, burn rate, active state and time left, plus the footer. Pure: the game
 * reads (worn items, the player's enchantments) and the clock are injected. Clean room from
 * the spec's facts; column texts are verbatim.
 */
import { mtHoursMinutes } from './format.js';
import type { MtSpellInfo } from './itemInfo.js';

/** The list's columns (Icon, Name, Active icon, Mana, Time; id and sort key hidden), widths from mainView.xml. */
export const MT_MANA_COLUMNS = [
  { kind: 'icon', name: 'ManaItemIcon', width: 16 },
  { kind: 'text', name: 'ManaItemName', width: 125 },
  { kind: 'icon', name: 'ManaItemActive', width: 16 },
  { kind: 'text', name: 'ManaItemMana', width: 72 },
  { kind: 'text', name: 'ManaItemTime', width: 44 },
] as const;

/** The footer controls' texts. */
export const MT_MANA_RECHARGE_LABEL = 'Recharge';

export type MtManaState = 'Unknown' | 'NotActivatable' | 'NotActive' | 'Active';

/** The state column's portal.dat icons (spec §2.7). */
export const MT_MANA_STATE_ICONS: Readonly<Record<MtManaState, number>> = {
  Active: 0x060011f9, NotActive: 0x060011f8, Unknown: 0x060020b5, NotActivatable: 0x0600287a,
};

/** An enchantment's spell Family (Category) and Difficulty (Power). */
export interface MtEnchantment { family: number; difficulty: number }
/** An enchantment on the player; `timeRemaining` ≤ 0 is an item-cast one (no duration). */
export interface MtPlayerEnchantment extends MtEnchantment { timeRemaining: number }

/** One worn item as the game knows it. */
export interface MtWornItem {
  id: number;
  name: string;
  /** Its icon (a portal.dat 0x06 id). */
  icon?: number;
  /** ValidLocations (Decal EquipableSlots). */
  validLocations: number;
  /** CurrentWieldedLocation (Decal EquippedSlots); > 0 when worn. */
  wieldedLocation: number;
  /** Appraisal data has arrived. */
  appraised: boolean;
  spells: readonly MtSpellInfo[];
  /** The item's own use spell (PropertyDataId Spell, Decal AssociatedSpell): never checked. */
  associatedSpellId?: number;
  curMana: number;
  maxMana: number;
  /** PropertyFloat ManaRate: negative mana per second. */
  manaRate: number;
  /** PropertyBool Retained. */
  retained: boolean;
  /** Enchantments on the item itself. */
  enchantments: readonly MtEnchantment[];
  /** When the mana figure last changed: the last appraisal or mana-change event (ms), not the server's id time. */
  manaUpdatedAt: number;
}

export interface MtManaReads {
  worn(): readonly MtWornItem[];
  playerEnchantments(): readonly MtPlayerEnchantment[];
  /** ms. */
  now(): number;
}

export interface MtManaRow {
  id: number;
  name: string;
  icon: number | undefined;
  state: MtManaState;
  stateIcon: number;
  /** `<cur> / <max>`, or `-`. */
  mana: string;
  /** `<h>h<mm>m`, `-`, or empty for an active item that never burns (spec §12 #7). */
  time: string;
  /** Seconds left (the hidden sort column). */
  sortKey: number;
  /** Aetheria, cloaks and ammunition: counted in the totals but not listed. */
  hidden: boolean;
  manaNeeded: number;
}

const CLOAK_SLOT = 0x08000000;
const AMMO_SLOT = 0x00800000;
/** TimeSpan(99, 99, 0): what upstream returns for an active item that never burns. */
const NO_BURN_SECONDS = 99 * 3600 + 99 * 60;
const SORT_LAST = 2147483647;

/** Seconds per point of mana: ceil(−0.2 / ManaRate) × 5 (items burn in 5 s steps); 0 when it doesn't burn. */
export function mtSecondsPerBurn(item: Pick<MtWornItem, 'appraised' | 'manaRate'>): number {
  if (!item.appraised || item.manaRate === 0) return 0;
  return Math.ceil(-0.2 / item.manaRate) * 5;
}

/** The item's state (spec §5.1 "Item state"). */
export function mtManaState(item: MtWornItem, player: readonly MtPlayerEnchantment[]): MtManaState {
  if (!item.appraised) return 'Unknown';
  if (item.spells.length === 0 || item.maxMana === 0) return 'NotActivatable';
  if (item.curMana === 0) return 'NotActive';
  for (const spell of item.spells) {
    if (spell.id === item.associatedSpellId || spell.offensive) continue;
    const covers = (e: MtEnchantment) => e.family === spell.family && e.difficulty >= spell.difficulty;
    const active = item.enchantments.some(covers) || player.some((e) => e.timeRemaining <= 0 && covers(e));
    if (!active) return 'NotActive';
  }
  return 'Active';
}

export class MtManaTracker {
  constructor(private readonly reads: MtManaReads) {}

  private tracked(): MtWornItem[] {
    return this.reads.worn().filter((i) => i.wieldedLocation > 0);
  }

  /** One item's row. */
  row(item: MtWornItem, player = this.reads.playerEnchantments(), now = this.reads.now()): MtManaRow {
    const state = mtManaState(item, player);
    const spb = mtSecondsPerBurn(item);
    let current = 0;
    if (state === 'Active' && spb > 0) {
      const elapsed = Math.max(0, (now - item.manaUpdatedAt) / 1000);
      current = Math.max(item.curMana - Math.floor(elapsed / spb), 0);
    } else if (state !== 'Unknown' && state !== 'NotActivatable') {
      current = item.curMana;
    }
    const manaNeeded = state === 'Unknown' ? 0 : Math.max(item.maxMana - current, 0);
    const hidden = item.name.includes('Aetheria') || item.validLocations === CLOAK_SLOT || item.wieldedLocation === AMMO_SLOT;
    const base = { id: item.id, name: item.name, icon: item.icon, state, stateIcon: MT_MANA_STATE_ICONS[state], hidden, manaNeeded };
    if (state === 'Unknown' || state === 'NotActivatable') return { ...base, mana: '-', time: '-', sortKey: SORT_LAST };
    const seconds = state !== 'Active' ? 0 : spb === 0 ? NO_BURN_SECONDS : current * spb;
    // Spec §12 #7 (fix): upstream renders a never-burning item as "100h39m" (TimeSpan 99h99m); we leave
    // the cell blank (the DAT fonts have no ∞) and keep its sort place.
    const time = state === 'Active' && spb === 0 ? '' : mtHoursMinutes(seconds);
    return { ...base, mana: `${current} / ${item.maxMana}`, time, sortKey: seconds };
  }

  /** Every tracked item, ascending by time left (unknown / not activatable last); hidden rows included, flagged. */
  rows(): MtManaRow[] {
    const player = this.reads.playerEnchantments();
    const now = this.reads.now();
    return this.tracked().map((i) => this.row(i, player, now)).sort((a, b) => a.sortKey - b.sortKey);
  }

  /** `Mana needed: <n>` — mana to refill every tracked item. */
  manaNeededText(): string {
    return `Mana needed: ${this.rows().reduce((t, r) => t + r.manaNeeded, 0)}`;
  }

  /** `Unretained Items: <n>` — appraised, not Retained, ammunition excluded. */
  unretainedText(): string {
    const n = this.tracked().filter((i) => i.appraised && !i.retained && i.wieldedLocation !== AMMO_SLOT).length;
    return `Unretained Items: ${n}`;
  }

  /** The HUD's `Mana` entry: time until the next item runs dry, `*` first when any is Not Active; blank when none. */
  hudText(): string {
    const rows = this.rows();
    const timed = rows.filter((r) => r.state === 'Active' && r.time !== '');
    const star = rows.some((r) => r.state === 'NotActive') ? '*' : '';
    if (!timed.length) return star;
    return star + mtHoursMinutes(Math.min(...timed.map((r) => r.sortKey)));
  }

  /** Which tracked items a chat line says to re-appraise (spec §5.1 "Re-appraisal triggers"). */
  reappraiseFor(line: string): number[] {
    if (line.startsWith('You say, ') || line.includes('says, "')) return [];
    const stone = line.includes('The Mana Stone gives ');
    const low = line.includes('Your ') && (line.includes(' is low on Mana.') || line.includes(' is out of Mana.'));
    if (!stone && !low) return [];
    return this.tracked().filter((i) => line.includes(i.name)).map((i) => i.id);
  }
}
