/**
 * UX.chargen-preview-no-placeholder — the portal files the chargen / barber
 * preview reads, so a streamed set can fetch them before the player asks.
 *
 * Every id here is what CharacterModelBuilder.buildCharacterModel reads for
 * some choice, as a closure root (DatClosure walks a Setup / GfxObj /
 * SurfaceTexture down to its textures and their palettes). The structural
 * files the walk starts from — the CharGen 0x0E000002, PaletteSets 0x0F,
 * ClothingTables 0x10 — are in the skeleton pack, resident from boot, so
 * listing the roots needs no network. Retail read all of this from a local
 * DAT; nothing here changes what is drawn, only when its bytes arrive.
 *
 * Three scopes:
 *  - appearanceIds: one appearance (what the next build will read) — the
 *    preview hold's critical fetch when a build missed;
 *  - baseIds: a heritage + sex's figure before any choice (its setup's
 *    parts, the chargen view's idle / rest animations, the base ObjDesc, the
 *    base palette, the skin PalSet's palettes) — warmed for every heritage + sex while chargen is open, so a
 *    heritage switch finds its figure resident;
 *  - optionIds: everything the Appearance page can step to for one heritage +
 *    sex (each hair style / eye strip / nose / mouth with its strip icon,
 *    every hair / eye / skin colour and shade, every clothing item with each
 *    colour template's palettes) — warmed for the heritage + sex in force.
 */
import type { ClothingTable } from '@ac/dat-parser/file-types/ClothingTable.js';
import type { GearCG, ObjDesc, SexCG } from '@ac/dat-parser/file-types/CharacterGenerator.js';
import type { AppearanceInfo } from '@ac/shared';

export interface ChargenPrefetchSources {
  loadPaletteSet(id: number): { readonly paletteList: readonly number[]; getPaletteId(hue: number): number } | null;
  loadClothingTable(id: number): ClothingTable | null;
  /**
   * A Setup's part GfxObjs (the Setup itself is skeleton-resident). Rooting
   * the walk on the parts keeps it off the Setup's motion table: DatClosure
   * walks a Setup's whole default-style animation set (~3 MB gzip for a
   * human), which the preview never plays. Absent: the Setup is the root.
   */
  setupParts?(setupId: number): readonly number[] | null;
  /** The chargen view's own animations for a heritage (gmCG3DView's idle / rest / gestures, ChargenViewAnimation). */
  chargenAnimations?(heritage: number): readonly number[];
}

type Add = (id: number | undefined) => void;

function collector(): { ids: Set<number>; add: Add } {
  const ids = new Set<number>();
  return { ids, add: (id) => { if (id) ids.add(id >>> 0); } };
}

/** An ObjDesc's files (mergeObjDesc's reads, plus its palettes). */
function addObjDesc(add: Add, d: ObjDesc | undefined): void {
  if (!d) return;
  add(d.paletteId);
  for (const s of d.subPalettes) add(s.subId);
  for (const t of d.textureChanges) add(t.newTexture);
  for (const p of d.animPartChanges) add(p.partId);
}

/** Every palette of a PalSet (the shade disk can land on any of them). */
function addPalSet(add: Add, src: ChargenPrefetchSources, palSetId: number | undefined): void {
  if (!palSetId) return;
  for (const p of src.loadPaletteSet(palSetId)?.paletteList ?? []) add(p);
}

/** One worn item on `setupId` (applyClothingGear): its replacement parts and textures. */
function addGearShape(add: Add, table: ClothingTable | null, setupId: number): void {
  const base = table?.clothingBaseEffects.get(setupId);
  for (const e of base?.cloObjectEffects ?? []) {
    add(e.modelId);
    for (const t of e.cloTextureEffects) add(t.newTexture);
  }
}

/** A Setup as roots: its parts when the source can list them, else the Setup. */
function addSetup(add: Add, src: ChargenPrefetchSources, setupId: number | undefined): void {
  if (!setupId) return;
  const parts = src.setupParts?.(setupId);
  if (parts) for (const p of parts) add(p);
  else add(setupId);
}

/** The figure before any choice: the setup's parts, the view's animations, base ObjDesc, base palette and every skin shade. */
export function chargenBaseIds(sex: SexCG, src: ChargenPrefetchSources, heritage = 0): number[] {
  const { ids, add } = collector();
  addSetup(add, src, sex.setupId);
  for (const a of src.chargenAnimations?.(heritage) ?? []) add(a);
  add(sex.basePalette);
  addObjDesc(add, sex.baseObjDesc);
  addPalSet(add, src, sex.skinPalSet);
  return [...ids];
}

/** Everything the Appearance page (and the barber) can step to for one heritage + sex. */
export function chargenOptionIds(sex: SexCG, src: ChargenPrefetchSources, heritage = 0): number[] {
  const { ids, add } = collector();
  for (const id of chargenBaseIds(sex, src, heritage)) add(id);
  for (const h of sex.hairStyleList) {
    addObjDesc(add, h.objDesc);
    add(h.iconImage);
    // The barber's preview builds a bald / alternate head on its own setup (BarberModel.previewSetupId).
    if (h.alternateSetup) addSetup(add, src, h.alternateSetup);
  }
  for (const palSet of sex.hairColorList) addPalSet(add, src, palSet);
  for (const pal of sex.eyeColorList) add(pal);
  for (const e of sex.eyeStripList) {
    addObjDesc(add, e.objDesc);
    addObjDesc(add, e.objDescBald);
    add(e.iconImage);
    add(e.iconImageBald);
  }
  for (const s of [...sex.noseStripList, ...sex.mouthStripList]) {
    addObjDesc(add, s.objDesc);
    add(s.iconImage);
  }
  const gear: readonly GearCG[] = [...sex.headgearList, ...sex.shirtList, ...sex.pantsList, ...sex.footwearList];
  for (const g of gear) {
    if (!g.clothingTable) continue;
    const table = src.loadClothingTable(g.clothingTable);
    if (!table) continue;
    // applyClothingGear reads the sex's own setup's base effect.
    addGearShape(add, table, sex.setupId);
    // StoreColorInformation's templates: the colour spots this item offers,
    // and the table's first one (clothingSubPaletteRanges' fallback when the
    // chosen colour's template is not a key, as ACE's CalculateObjDesc does).
    let first = true;
    for (const [template, effect] of table.clothingSubPalEffects) {
      const offered = sex.clothingColorsList.includes(template) || first;
      first = false;
      if (!offered) continue;
      for (const sub of effect.cloSubPalettes) addPalSet(add, src, sub.paletteSet);
    }
  }
  return [...ids];
}

/** What one build of `appearance` reads (buildCharacterModel + buildCompositePalette). */
export function chargenAppearanceIds(sex: SexCG, appearance: AppearanceInfo, src: ChargenPrefetchSources, setupIdOverride = 0): number[] {
  const { ids, add } = collector();
  addSetup(add, src, setupIdOverride || sex.setupId);
  add(sex.basePalette);
  addObjDesc(add, sex.baseObjDesc);
  const hair = appearance.hairStyle >= 0 ? sex.hairStyleList[appearance.hairStyle] : undefined;
  addObjDesc(add, hair?.objDesc);
  const eye = sex.eyeStripList[appearance.eyesStrip];
  addObjDesc(add, hair?.bald ? eye?.objDescBald : eye?.objDesc);
  addObjDesc(add, sex.noseStripList[appearance.noseStyle]?.objDesc);
  addObjDesc(add, sex.mouthStripList[appearance.mouthStyle]?.objDesc);
  if (sex.skinPalSet) add(src.loadPaletteSet(sex.skinPalSet)?.getPaletteId(appearance.skinHue ?? 0));
  const hairPalSet = appearance.hairColor >= 0 ? sex.hairColorList[appearance.hairColor] : undefined;
  if (hairPalSet) add(src.loadPaletteSet(hairPalSet)?.getPaletteId(appearance.hairHue ?? 0));
  if (appearance.eyeColor >= 0) add(sex.eyeColorList[appearance.eyeColor]);
  const slots: Array<[readonly GearCG[], number, number]> = [
    [sex.headgearList, appearance.headgearStyle, appearance.headgearHue ?? 0],
    [sex.shirtList, appearance.shirtStyle, appearance.shirtHue ?? 0],
    [sex.pantsList, appearance.pantsStyle, appearance.pantsHue ?? 0],
    [sex.footwearList, appearance.footwearStyle, appearance.footwearHue ?? 0],
  ];
  for (const [list, style, shade] of slots) {
    const g = style >= 0 ? list[style] : undefined;
    if (!g?.clothingTable) continue;
    const table = src.loadClothingTable(g.clothingTable);
    addGearShape(add, table, sex.setupId);
    // Every template's palette at this shade: the colour index → template mapping is cheap to over-cover.
    for (const effect of table?.clothingSubPalEffects.values() ?? []) {
      for (const sub of effect.cloSubPalettes) add(src.loadPaletteSet(sub.paletteSet)?.getPaletteId(shade));
    }
  }
  return [...ids];
}

/** The heritage + sex pairs a CharGen offers, in DAT order. */
export interface ChargenSexSource {
  sexes(): Array<{ heritage: number; gender: number; sex: SexCG }>;
}

export type PrefetchFn = (ids: readonly number[]) => Promise<void>;

/**
 * The background warm, one set at a time (bounded: a single closure fetch in
 * flight, at the store's Background priority, so it never competes with the
 * boot or a critical miss). `focus(h, g)` puts that heritage + sex's options
 * at the front; `warmBases()` queues every heritage + sex's base figure.
 * Each set is fetched once per session (a failed one may be asked again).
 */
export class ChargenPrefetcher {
  private readonly done = new Set<string>();
  private readonly queued = new Map<string, () => number[]>();
  private order: string[] = [];
  private running = false;
  /** Every id set handed to the fetch, in order (probes / tests). */
  readonly fetched: Array<{ key: string; ids: readonly number[] }> = [];

  constructor(private readonly fetch: PrefetchFn, private readonly sexes: ChargenSexSource, private readonly src: ChargenPrefetchSources) {}

  /** Warm every option of heritage + sex next. */
  focus(heritage: number, gender: number): void {
    const entry = this.sexes.sexes().find((s) => s.heritage === heritage && s.gender === gender);
    if (!entry) return;
    const key = `options:${heritage}:${gender}`;
    // The figure first (a heritage switch draws it at once), then its choices.
    this.enqueue(`base:${heritage}:${gender}`, () => chargenBaseIds(entry.sex, this.src, heritage), true);
    this.enqueue(key, () => chargenOptionIds(entry.sex, this.src, heritage), true, `base:${heritage}:${gender}`);
  }

  /** Warm every heritage + sex's base figure (after anything focused). */
  warmBases(): void {
    for (const { heritage, gender, sex } of this.sexes.sexes()) {
      this.enqueue(`base:${heritage}:${gender}`, () => chargenBaseIds(sex, this.src, heritage), false);
    }
  }

  private enqueue(key: string, ids: () => number[], front: boolean, after?: string): void {
    if (this.done.has(key)) return;
    this.queued.set(key, ids);
    this.order = this.order.filter((k) => k !== key);
    if (front) {
      const at = after !== undefined ? this.order.indexOf(after) + 1 : 0;
      this.order.splice(at, 0, key);
    } else {
      this.order.push(key);
    }
    this.pump();
  }

  private pump(): void {
    if (this.running) return;
    const key = this.order.shift();
    if (key === undefined) return;
    const make = this.queued.get(key)!;
    this.queued.delete(key);
    this.done.add(key);
    let ids: number[] = [];
    try { ids = make(); } catch { ids = []; }
    this.fetched.push({ key, ids });
    this.running = true;
    this.fetch(ids).catch(() => { this.done.delete(key); }).finally(() => {
      this.running = false;
      this.pump();
    });
  }
}
