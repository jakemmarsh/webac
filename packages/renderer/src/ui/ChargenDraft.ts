/**
 * UX.chargen-resume — the chargen wizard's choices as plain data, and back.
 *
 * A dropped connection in character creation (a socket close, a hidden tab,
 * a network blip) used to end on the Disconnected screen with every choice
 * lost. The page now reconnects on its own and reopens chargen where the
 * player was (session/ChargenResume.ts); this module is the wizard half:
 * snapshotWizard takes the choices (step, heritage, gender, face and
 * clothes with their colours and shades, attributes and their locks,
 * profession template, skills, town, the typed name), restoreWizard puts
 * them back into a NEW wizard, but only after checking every index against
 * the CharGen data now loaded: the heritage must be one this world lists
 * (HeritageRows / chargenHeritageDefined, so a heritage the server refused,
 * e.g. Olthoi on a server that forbids it, fails), the credits must be that
 * heritage's, and CharGenState's own constraints (ConstrainAllByHeritage
 * @ 005c6590: ConstrainAllByGender's appearance clamp, the template range,
 * the skill-credit recount) must leave the restored state unchanged. Any
 * difference means the draft was made against other data (another era's
 * DATs, another world): the caller drops it and starts clean, so a stale
 * draft never leaks a half-valid selection into chargen.
 *
 * Retail had no reconnect and no draft: a named browser-UX exception
 * (CLAUDE.md, beside the in-world reconnect).
 */
import { Gender, Heritage, SkillAdvancementClass, ATTRIBUTE_MIN, ATTRIBUTE_MAX } from '@ac/shared';
import { CharacterCreateWizard, CreateStep, resolveProgressState, type AppearanceState, type AttributeSet, type ChargenRollDeps } from './CharacterCreate.js';
import type { AttributeKey } from './ChargenAttributeSliders.js';

/** The appearance indices (−1 = none, e.g. no headgear) and the shades (the gradient disks' 0..1, −1 after Reset). */
export const APPEARANCE_INDEX_KEYS = [
  'hairStyle', 'hairColor', 'eyesStrip', 'eyeColor', 'skinColor', 'noseStyle', 'mouthStyle',
  'headgearStyle', 'headgearColor', 'shirtStyle', 'shirtColor', 'pantsStyle', 'pantsColor', 'footwearStyle', 'footwearColor',
] as const satisfies readonly (keyof AppearanceState)[];
export const APPEARANCE_SHADE_KEYS = [
  'skinHue', 'hairHue', 'headgearHue', 'shirtHue', 'pantsHue', 'footwearHue',
] as const satisfies readonly (keyof AppearanceState)[];
/** The four clothing colours ConstrainAllByGender holds to the chosen item's palette count. */
const CLOTHING_COLOR_KEYS = ['headgearColor', 'shirtColor', 'pantsColor', 'footwearColor'] as const;
const ATTRIBUTE_KEYS: readonly AttributeKey[] = ['strength', 'endurance', 'coordination', 'quickness', 'focus', 'self'];

/** Everything the player chose in chargen, as JSON-safe data. */
export interface ChargenWizardSnapshot {
  step: number;
  heritage: number;
  gender: number;
  name: string;
  /** gmCGSummaryPage::m_bNameEntered: the name field holds typed text, not the prompt. */
  nameEntered: boolean;
  attributes: AttributeSet;
  attributeLocks: Record<AttributeKey, boolean>;
  attributeCredits: number;
  skillCredits: number;
  skillCreditsUsed: number;
  /** [skillId, SkillAdvancementClass] for every Trained / Specialized skill. */
  skills: [number, number][];
  appearance: AppearanceState;
  startArea: number;
  templateIndex: number;
  /**
   * gmCGAppearancePage::m_LastHeritageGroup (GameUI's chargenLastAppearanceHeritage): the Face page
   * re-rolls the face and clothes when it opens on a Gearknight after another heritage, or the other
   * way round (appearanceUpdateRandomize). Absent in a bare wizard snapshot; GameUI's capture fills it.
   */
  appearanceLastHeritage?: number;
}

/** The wizard's choices as plain data. */
export function snapshotWizard(w: CharacterCreateWizard, nameEntered: boolean): ChargenWizardSnapshot {
  return {
    step: w.currentStep,
    heritage: w.heritage,
    gender: w.gender,
    name: w.name,
    nameEntered,
    attributes: { ...w.attributes },
    attributeLocks: { ...w.attributeLocks },
    attributeCredits: w.attributeCredits,
    skillCredits: w.skillCredits,
    skillCreditsUsed: w.skillCreditsUsed,
    skills: [...w.skills.entries()].map(([id, level]) => [id, level]),
    appearance: { ...w.appearance },
    startArea: w.startArea,
    templateIndex: w.templateIndex,
  };
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** The snapshot has every field with the right type (storage may hand back anything). */
export function isWizardSnapshotShaped(s: unknown): s is ChargenWizardSnapshot {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  if (!isInt(o.step) || !isInt(o.heritage) || !isInt(o.gender) || typeof o.name !== 'string' || o.name.length > 64) return false;
  if (typeof o.nameEntered !== 'boolean') return false;
  if (o.appearanceLastHeritage !== undefined && !isInt(o.appearanceLastHeritage)) return false;
  if (!isInt(o.attributeCredits) || !isInt(o.skillCredits) || !isInt(o.skillCreditsUsed) || !isInt(o.startArea) || !isInt(o.templateIndex)) return false;
  const attrs = o.attributes as Record<string, unknown> | null;
  const locks = o.attributeLocks as Record<string, unknown> | null;
  if (!attrs || typeof attrs !== 'object' || !locks || typeof locks !== 'object') return false;
  for (const k of ATTRIBUTE_KEYS) if (!isInt(attrs[k]) || typeof locks[k] !== 'boolean') return false;
  if (!Array.isArray(o.skills) || !o.skills.every((e) => Array.isArray(e) && e.length === 2 && isInt(e[0]) && isInt(e[1]))) return false;
  const a = o.appearance as Record<string, unknown> | null;
  if (!a || typeof a !== 'object') return false;
  for (const k of APPEARANCE_INDEX_KEYS) if (!isInt(a[k])) return false;
  for (const k of APPEARANCE_SHADE_KEYS) if (typeof a[k] !== 'number' || !Number.isFinite(a[k] as number)) return false;
  return true;
}

/**
 * Put a snapshot's choices into `w` (a NEW wizard) and check them against
 * the CharGen data in `deps`. True when every choice is valid there and the
 * wizard now holds exactly the snapshot; false otherwise, and then the
 * wizard is half-written: the caller discards it and starts clean.
 */
export function restoreWizard(w: CharacterCreateWizard, s: ChargenWizardSnapshot, deps: ChargenRollDeps): boolean {
  return restoreWizardVerdict(w, s, deps) === null;
}

/**
 * restoreWizard, saying why a draft was refused: null when it was restored,
 * else the check that failed with its field and value (the page logs it, so a
 * live refusal says which, UX.chargen-resume 2026-10-29).
 */
export function restoreWizardVerdict(w: CharacterCreateWizard, s: ChargenWizardSnapshot, deps: ChargenRollDeps): string | null {
  if (!isWizardSnapshotShaped(s)) return 'shape: a field is missing or of the wrong type';
  // The heritage: one this world's CharGen has and the heritage page lists
  // (the era's set, minus Olthoi on a world that refused them).
  if (s.heritage === Heritage.Invalid) return 'heritage: none';
  const group = deps.heritageGroup(s.heritage);
  if (!group) return `heritage ${s.heritage}: not in this CharGen`;
  if (deps.heritageListed && !deps.heritageListed(s.heritage)) return `heritage ${s.heritage}: not listed on this world`;
  if (s.gender !== Gender.Male && s.gender !== Gender.Female) return `gender ${s.gender}: invalid`;
  // The page: one of the six, and not one SetProgressState hides for the heritage (Olthoi) or the era (1999's Town).
  if (s.step < CreateStep.Heritage || s.step > CreateStep.Summary) return `step ${s.step}: not a chargen page`;
  if (resolveProgressState(s.step as CreateStep, s.step as CreateStep, s.heritage, w.townOnSummary) !== s.step) return `step ${s.step}: hidden for heritage ${s.heritage}${w.townOnSummary ? ' (no Town page in this era)' : ''}`;
  // SetHeritageGroup's credits.
  if (s.attributeCredits !== group.attributeCredits) return `attributeCredits ${s.attributeCredits}: the heritage has ${group.attributeCredits}`;
  if (s.skillCredits !== group.skillCredits) return `skillCredits ${s.skillCredits}: the heritage has ${group.skillCredits}`;
  let total = 0;
  for (const k of ATTRIBUTE_KEYS) {
    const v = s.attributes[k];
    if (v < ATTRIBUTE_MIN || v > ATTRIBUTE_MAX) return `attribute ${k} ${v}: out of range`;
    total += v;
  }
  if (total > s.attributeCredits) return `attributes total ${total}: over ${s.attributeCredits} credits`;
  // The town: an index into the CharGen's starter areas (−1 = unset, sent as 0).
  if (s.startArea < -1 || s.startArea >= deps.starterAreaCount) return `startArea ${s.startArea}: of ${deps.starterAreaCount}`;
  const templates = deps.templatesFor(s.heritage);
  if (s.templateIndex < -1 || s.templateIndex >= templates.length) return `templateIndex ${s.templateIndex}: of ${templates.length}`;
  // The skills: each one the heritage's table prices, at a level it can be bought at, adding up to what was spent.
  const costs = deps.costsFor(s.heritage);
  const seen = new Set<number>();
  let used = 0;
  for (const [id, level] of s.skills) {
    if (seen.has(id)) return `skill ${id}: twice`;
    if (!costs.skillIds.includes(id)) return `skill ${id}: not in this SkillTable`;
    seen.add(id);
    const cost = level === SkillAdvancementClass.Trained ? costs.trainedCost(id)
      : level === SkillAdvancementClass.Specialized ? costs.specializedCost(id) : -1;
    if (cost < 0) return `skill ${id} level ${level}: no price`;
    used += cost;
  }
  if (used !== s.skillCreditsUsed) return `skillCreditsUsed ${s.skillCreditsUsed}: the skills cost ${used}`;
  if (used > s.skillCredits) return `skills cost ${used}: over ${s.skillCredits} credits`;
  for (const k of APPEARANCE_INDEX_KEYS) if (s.appearance[k] < -1) return `appearance ${k} ${s.appearance[k]}: below -1`;
  for (const k of APPEARANCE_SHADE_KEYS) if (s.appearance[k] < -1 || s.appearance[k] > 1) return `appearance ${k} ${s.appearance[k]}: out of range`;

  w.heritage = s.heritage;
  w.gender = s.gender;
  w.attributeCredits = s.attributeCredits;
  w.skillCredits = s.skillCredits;
  w.skillCreditsUsed = s.skillCreditsUsed;
  w.attributes = { ...s.attributes };
  for (const k of ATTRIBUTE_KEYS) w.attributeLocks[k] = s.attributeLocks[k];
  w.skills = new Map(s.skills.map(([id, level]) => [id, level as SkillAdvancementClass]));
  w.appearance = { ...s.appearance };
  w.templateIndex = s.templateIndex;
  w.startArea = s.startArea;
  w.name = s.name;
  w.currentStep = s.step as CreateStep;

  // ConstrainAllByHeritage must find nothing to change: an appearance index
  // past this heritage / gender's Sex_CG lists (or a colour past the chosen
  // item's), a template past the list, or skills that no longer fit mean the
  // draft belongs to other data.
  w.constrainAllByHeritage(deps);
  if (w.templateIndex !== s.templateIndex) return `templateIndex ${s.templateIndex}: constrained to ${w.templateIndex}`;
  if (w.skillCreditsUsed !== s.skillCreditsUsed || w.skills.size !== s.skills.length) return `skills: constrained (used ${s.skillCreditsUsed} -> ${w.skillCreditsUsed})`;
  for (const [id, level] of s.skills) if (w.skills.get(id) !== level) return `skill ${id}: constrained ${level} -> ${w.skills.get(id)}`;
  for (const k of [...APPEARANCE_INDEX_KEYS, ...APPEARANCE_SHADE_KEYS]) {
    // A clothing colour is held to the chosen item's palette count, which the page knows only once
    // that item's clothing file is resident (streamed sets): a roll made before it was can hold a
    // colour past it, and the page clamps it the moment it can (Set<Slot>Style). The clamp is kept,
    // not held against the draft (an AC1999 resume lost its draft to it 1 time in 3, 2026-10-29).
    if ((CLOTHING_COLOR_KEYS as readonly string[]).includes(k)) continue;
    if (w.appearance[k] !== s.appearance[k]) return `appearance ${k} ${s.appearance[k]}: constrained to ${w.appearance[k]}`;
  }
  return null;
}
