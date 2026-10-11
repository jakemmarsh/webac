/**
 * VirindiTank's generated profile (docs/vtank-parity-gaps.md §9.3): choosing
 * [Default] (or a new [By char]) on the Profiles tab fills the Items and
 * Consumables tabs from what the character carries.
 *
 * What VTank documents (its changelog, docs/vtank-macro-behavior.md §1):
 * - "When generating an automatic profile, weapons for which you do not have
 *   the skill trained will no longer be added" (0.3.0.19);
 * - "Burning coals will no longer be automatically added to the foods list"
 *   (0.3.0.19), so foods are added;
 * - "Pets which match your mastery are now auto-added to items when setting
 *   the profile to default" (0.3.1.157).
 * What a consumable is follows MOSS's facts for the Consumables tab
 * (ProfileItemAdmission): healing kits, foods that restore a vital
 * (BoosterEnum 2 / 4 / 6), mana stones and charges. The rest of VTank's
 * rules are not public: casters are added (VTank's macro needs a wand on the
 * Items tab to cast, its "add at least one wand" error) when you have a
 * magic school trained; shields, gems and lockpicks are left to the player.
 *
 * Data, never names: the weapon's skill is its examined WeaponSkill
 * (PropertyInt 48) checked against your skill list, a pet device is one with
 * PetClass (266), and mastery is SummoningMastery (362) on the essence and on
 * you. Each era's own items and skills decide, so 1999's sword skills and end
 * of retail's Heavy Weapons both work; an era without Summoning has no pets.
 */
import type { PlanSkill, VtItemEntry } from '@ac/shared';

/** What the generator reads of one carried (or wielded) object. */
export interface LoadoutItem {
  guid: number;
  name: string;
  /** ACE ItemType bits. */
  itemType?: number;
  /** ObjectDescriptionFlags (Healer 0x10000). */
  flags?: number;
  /** Examined PropertyInts (WeaponSkill 48, BoosterEnum 89, PetClass 266, SummoningMastery 362). */
  ints?: Record<number, number>;
}

export interface LoadoutInput {
  items: LoadoutItem[];
  skills: PlanSkill[];
  /** Your SummoningMastery (PropertyInt 362); 0 / undefined: none chosen. */
  mastery?: number;
}

export interface Loadout {
  items: VtItemEntry[];
  consumables: string[];
  /** Weapons and foods whose examination hadn't come back: left out (their skill / vital unknown). */
  unexamined: string[];
}

const IT_MELEE = 0x1, IT_FOOD = 0x20, IT_MISSILE = 0x100, IT_CASTER = 0x8000, IT_MANASTONE = 0x80000;
const FLAG_HEALER = 0x10000;
const P_WEAPON_SKILL = 48, P_BOOSTER = 89, P_PET_CLASS = 266, P_MASTERY = 362;
/** The magic schools (ACE Skill: Creature 31, Item 32, Life 33, War 34, Void 43). */
const MAGIC_SKILLS = new Set([31, 32, 33, 34, 43]);
/** BoosterEnum: Health 2, Stamina 4, Mana 6 (ACE PropertyAttribute2nd). */
const VITAL_BOOSTERS = new Set([2, 4, 6]);
const SUMMONING = 54;

const trained = (s: PlanSkill | undefined): boolean => !!s && s.training !== 'untrained';

/** The Items and Consumables a generated profile starts with. */
export function generateLoadout(input: LoadoutInput): Loadout {
  const byId = new Map(input.skills.map((s) => [s.id, s]));
  const anyMagic = input.skills.some((s) => MAGIC_SKILLS.has(s.id) && trained(s));
  const summoning = trained(byId.get(SUMMONING)) || trained(input.skills.find((s) => /^summoning$/i.test(s.name)));
  const items: VtItemEntry[] = [];
  const consumables: string[] = [];
  const unexamined: string[] = [];
  const seen = new Set<number>();
  for (const it of input.items) {
    if (seen.has(it.guid >>> 0)) continue;
    seen.add(it.guid >>> 0);
    const t = it.itemType ?? 0;
    const ints = it.ints;
    if (t & IT_CASTER) {
      if (anyMagic) items.push({ name: it.name, id: it.guid >>> 0 });
    } else if (t & (IT_MELEE | IT_MISSILE)) {
      const skill = ints?.[P_WEAPON_SKILL];
      if (skill === undefined) { unexamined.push(it.name); continue; }
      if (trained(byId.get(skill))) items.push({ name: it.name, id: it.guid >>> 0 });
    } else if (ints?.[P_PET_CLASS] !== undefined) {
      // An essence whose mastery is none or yours, with Summoning trained (CHG .157; MOSS: a different mastery can't be used).
      const m = ints[P_MASTERY] ?? 0;
      if (summoning && (m === 0 || m === (input.mastery ?? 0))) items.push({ name: it.name, id: it.guid >>> 0, noBuffs: true });
    } else if ((it.flags ?? 0) & FLAG_HEALER) {
      if (!consumables.includes(it.name)) consumables.push(it.name);
    } else if (t & IT_MANASTONE) {
      if (!consumables.includes(it.name)) consumables.push(it.name);
    } else if (t & IT_FOOD) {
      if (/^burning coals?$/i.test(it.name.trim())) continue;
      const b = ints?.[P_BOOSTER];
      if (b === undefined) { unexamined.push(it.name); continue; }
      if (VITAL_BOOSTERS.has(b) && !consumables.includes(it.name)) consumables.push(it.name);
    }
  }
  return { items, consumables, unexamined };
}

/** Which carried objects the generator needs examined first: weapons, foods, and what may be a pet device (not yet examined). */
export function loadoutNeedsExamining(it: LoadoutItem): boolean {
  if (it.ints) return false;
  const t = it.itemType ?? 0;
  if (t & IT_CASTER) return false;
  if (t & (IT_MELEE | IT_MISSILE | IT_FOOD)) return true;
  // Summoning essences: a Misc-type object named as one ("… Essence"); its PetClass decides.
  return /essence/i.test(it.name);
}

/** What gathering the loadout reads from the game (main.ts: the agent API and the player's properties). */
export interface LoadoutGame {
  /** Carried and wielded objects (AgentItem fields). */
  inventory(): Array<{ guid: number; name: string; itemType?: number; objectDescFlags?: number }>;
  /** An object's examined int properties, or null when it hasn't been examined. */
  examined(guid: number): Record<number, number> | null;
  /** Ask the server to examine an object, quietly (no chat). */
  examine(guid: number): void;
  skills(): PlanSkill[];
  /** Your SummoningMastery (PropertyInt 362). */
  mastery(): number | undefined;
  /** Wait this many milliseconds. */
  sleep(ms: number): Promise<void>;
}

/**
 * Examine what the generator needs (weapons, foods, essences not yet
 * examined), wait for the answers (at most `timeoutMs`), then hand the
 * generator what you carry. At most 60 objects are asked about, a few at a time
 * as the server answers, so a full pack doesn't flood it.
 */
export async function gatherLoadout(game: LoadoutGame, timeoutMs = 6000): Promise<LoadoutInput> {
  const read = (): LoadoutItem[] => game.inventory().map((i) => {
    const ints = game.examined(i.guid);
    return { guid: i.guid, name: i.name, ...(i.itemType !== undefined ? { itemType: i.itemType } : {}), ...(i.objectDescFlags !== undefined ? { flags: i.objectDescFlags } : {}), ...(ints ? { ints } : {}) };
  });
  const want = read().filter(loadoutNeedsExamining).slice(0, 60).map((i) => i.guid);
  const asked = new Set<number>();
  const step = 200;
  for (let t = 0; t <= timeoutMs; t += step) {
    const waiting = want.filter((g) => !game.examined(g));
    if (!waiting.length) break;
    // Up to six questions out at once; the next go out as answers come back.
    const out = waiting.filter((g) => asked.has(g)).length;
    for (const g of waiting.filter((x) => !asked.has(x)).slice(0, Math.max(0, 6 - out))) { asked.add(g); game.examine(g); }
    await game.sleep(step);
  }
  return { items: read(), skills: game.skills(), mastery: game.mastery() };
}
