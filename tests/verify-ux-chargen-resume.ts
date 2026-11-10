/**
 * UX.chargen-resume (Jake, 2026-10-29: "store character creation progress.
 * make sure we clear it when necessary so users don't see weird sticky
 * selections").
 *
 * A dropped connection in chargen reconnects quietly (the in-world resume's
 * 2 / 5 / 10 s behind the connecting screen) and reopens chargen on the same
 * step with every choice; a FINISH that already made the character is never
 * sent again; a resume that gives up keeps the draft 15 minutes for a manual
 * login to the same world + account; and every clearing rule drops it.
 *
 * Drives the real modules: SessionLifecycle, ChargenDraftStore /
 * decideChargenDraft / pendingCreateSlot, snapshotWizard / restoreWizard,
 * GameUI's chargen in happy-dom (a 1999-shaped CharGen on CI; the real end of
 * retail and Dark Majesty CharGens when the DATs are here), and the
 * PreworldReporter tokens through the bridge's sanitizer.
 */
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Connection1999 } from '../packages/network/src/era1999/Connection1999.js';
import { parseCharacterList, type ConnectionEvent } from '../packages/network/src/index.js';
import { SessionLiveness, characterListRole } from '../packages/renderer/src/session/SessionLiveness.js';
import { resolve } from 'node:path';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionLifecycle } from '../packages/renderer/src/session/SessionLifecycle.js';
import {
  ChargenDraftStore, CHARGEN_DRAFT_STORAGE_KEY, CHARGEN_DRAFT_TTL_MS, CHARGEN_RESUME_TOKENS,
  decideChargenDraft, pendingCreateSlot, type ChargenDraft, type ChargenDraftOwner,
} from '../packages/renderer/src/session/ChargenResume.js';
import { restoreWizard, restoreWizardVerdict, snapshotWizard, type ChargenWizardSnapshot } from '../packages/renderer/src/ui/ChargenDraft.js';
import { CharacterCreateWizard, CreateStep } from '../packages/renderer/src/ui/CharacterCreate.js';
import { scriptedRandomSource, seededRandomSource } from '../packages/renderer/src/ui/ChargenRandomize.js';
import { ADVENTURER_TEMPLATE } from '../packages/renderer/src/ui/ChargenTemplates.js';
import { MemoryStorage } from '../packages/renderer/src/utils/pageStorage.js';
import { PreworldReporter, type PreworldEvent } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { sanitizeClientPreworld } from '../services/ws-tcp-bridge/src/clientPreworld.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { RESUME_DELAYS_MS } from '../packages/renderer/src/session/RetryPolicy.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const OWNER: ChargenDraftOwner = { world: 'bridge.playwebac.com/?server=coldeve', account: 'Jake', era: 'eor' };

function snap(over: Partial<ChargenWizardSnapshot> = {}): ChargenWizardSnapshot {
  const w = new CharacterCreateWizard(330, 50);
  w.heritage = 1; w.gender = 1; w.name = 'Brenna'; w.currentStep = CreateStep.Appearance;
  return { ...snapshotWizard(w, true), ...over };
}

function draft(over: Partial<ChargenDraft> = {}, now = 1_000_000): ChargenDraft {
  return { owner: OWNER, savedAt: now, wizard: snap(), pending: false, createdGuid: null, knownGuids: [0x50000001], ...over };
}

// ── the store: what is kept, for whom, for how long ───────────────────

describe('ChargenDraftStore', () => {
  it('keeps the draft in memory and in sessionStorage (a reload inside the window still has it); never a password', () => {
    const storage = new MemoryStorage();
    const clock = { t: 1_000_000 };
    const a = new ChargenDraftStore(storage, () => clock.t);
    a.save(draft());
    const raw = storage.getItem(CHARGEN_DRAFT_STORAGE_KEY)!;
    expect(raw).toContain('Brenna');
    expect(raw.toLowerCase()).not.toContain('password');
    const b = new ChargenDraftStore(storage, () => clock.t); // the page after a reload
    expect(b.peek(OWNER)?.wizard.name).toBe('Brenna');
  });

  it('a draft older than 15 minutes is gone', () => {
    const clock = { t: 1_000_000 };
    const s = new ChargenDraftStore(new MemoryStorage(), () => clock.t);
    s.save(draft());
    clock.t += CHARGEN_DRAFT_TTL_MS;
    expect(s.peek(OWNER)).not.toBeNull();
    clock.t += 1;
    expect(s.peek(OWNER)).toBeNull();
    expect(s.held).toBe(false);
  });

  it('a login to another world, account or era drops it (the account matches case-insensitively)', () => {
    for (const other of [{ ...OWNER, world: 'other' }, { ...OWNER, account: 'someone' }, { ...OWNER, era: 'ac1999-retail' }]) {
      const s = new ChargenDraftStore(new MemoryStorage(), () => 1_000_000);
      s.save(draft());
      expect(s.peek(other)).toBeNull();
      expect(s.held).toBe(false);
      expect(s.peek(OWNER)).toBeNull(); // gone for good, not just hidden
    }
    const s = new ChargenDraftStore(new MemoryStorage(), () => 1_000_000);
    s.save(draft());
    expect(s.peek({ ...OWNER, account: ' jake ' })).not.toBeNull();
  });

  it('take consumes it: a draft is handed out once', () => {
    const s = new ChargenDraftStore(new MemoryStorage(), () => 1_000_000);
    s.save(draft());
    expect(s.take(OWNER)).not.toBeNull();
    expect(s.take(OWNER)).toBeNull();
  });

  it('blocked or corrupt storage never throws; garbage is dropped', () => {
    const throwing = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('x'); } };
    const s = new ChargenDraftStore(throwing, () => 1_000_000);
    s.save(draft());
    expect(s.peek(OWNER)?.wizard.name).toBe('Brenna'); // the memory copy stands
    s.clear();
    const bad = new MemoryStorage();
    bad.setItem(CHARGEN_DRAFT_STORAGE_KEY, '{"owner":1}');
    expect(new ChargenDraftStore(bad).held).toBe(false);
    expect(bad.getItem(CHARGEN_DRAFT_STORAGE_KEY)).toBeNull();
    bad.setItem(CHARGEN_DRAFT_STORAGE_KEY, 'not json');
    expect(new ChargenDraftStore(bad).held).toBe(false);
  });
});

// ── what the reconnect's character list does with it ──────────────────

describe('decideChargenDraft / pendingCreateSlot', () => {
  const slots = [{ id: String(0x50000001), name: 'Old Hand' }];

  it('the automatic resume restores the draft on its own step and consumes it', () => {
    const s = new ChargenDraftStore(new MemoryStorage(), () => 1_000_000);
    s.save(draft());
    const act = decideChargenDraft(s, OWNER, slots, true);
    expect(act).toEqual({ kind: 'restore', wizard: draft().wizard });
    expect(s.held).toBe(false);
  });

  it('a pending FINISH whose character now exists: "created", no second create, the draft gone', () => {
    const s = new ChargenDraftStore(new MemoryStorage(), () => 1_000_000);
    s.save(draft({ pending: true, wizard: snap({ name: '[ Brenna ]' }) }));
    const after = [...slots, { id: String(0x50000002), name: 'brenna' }];
    expect(decideChargenDraft(s, OWNER, after, true)).toEqual({ kind: 'created', slotId: String(0x50000002) });
    expect(s.held).toBe(false);
  });

  it('the server\'s OK named the guid (its enter was under way): found by guid', () => {
    const d = draft({ pending: true, createdGuid: 0x50000009, wizard: snap({ name: 'Brenna' }) });
    expect(pendingCreateSlot(d, [...slots, { id: String(0x50000009), name: 'Brenna' }])?.id).toBe(String(0x50000009));
  });

  it('a pending FINISH not in the list: back on the summary to press it again', () => {
    const s = new ChargenDraftStore(new MemoryStorage(), () => 1_000_000);
    s.save(draft({ pending: true }));
    const act = decideChargenDraft(s, OWNER, slots, true);
    expect(act.kind).toBe('restore');
    expect((act as { wizard: ChargenWizardSnapshot }).wizard.step).toBe(CreateStep.Summary);
  });

  it('a name the account already had before the drop is not the new character', () => {
    const d = draft({ pending: true, wizard: snap({ name: 'Old Hand' }) });
    expect(pendingCreateSlot(d, slots)).toBeNull();
    expect(pendingCreateSlot(draft({ pending: false, wizard: snap({ name: 'Brenna' }) }), [{ id: '7', name: 'Brenna' }])).toBeNull();
  });

  it('a manual login (no resume) is offered the draft; it stays until answered, a pending one on the summary', () => {
    const s = new ChargenDraftStore(new MemoryStorage(), () => 1_000_000);
    s.save(draft({ pending: true }));
    const act = decideChargenDraft(s, OWNER, slots, false);
    expect(act.kind).toBe('offer');
    expect((act as { wizard: ChargenWizardSnapshot }).wizard.step).toBe(CreateStep.Summary);
    expect(s.take(OWNER)?.pending).toBe(false);
  });

  it('nothing for another owner', () => {
    const s = new ChargenDraftStore(new MemoryStorage(), () => 1_000_000);
    s.save(draft());
    expect(decideChargenDraft(s, { ...OWNER, world: 'w2' }, slots, false)).toEqual({ kind: 'none' });
  });
});

// ── SessionLifecycle: the same attempts as the in-world resume ────────

describe('SessionLifecycle chargen resume', () => {
  it('a drop in chargen gets the in-world resume\'s delays, then the Disconnected screen', () => {
    const l = new SessionLifecycle();
    expect(l.nextResumeDelay()).toBeNull(); // no character, no chargen: nothing to resume (unchanged)
    l.beginChargenResume();
    const delays: number[] = [];
    for (let d = l.nextResumeDelay(); d !== null; d = l.nextResumeDelay()) {
      expect(l.resumingChargen).toBe(true);
      delays.push(d);
    }
    expect(delays).toEqual([...RESUME_DELAYS_MS]);
    expect(l.resumingAfterDrop).toBe(false);
    expect(l.resumingChargen).toBe(false);
  });

  it('an earlier deliberate logout does not stop it, and it never auto-enters a character', () => {
    const l = new SessionLifecycle();
    l.noteEnterWorldRequested(0x50000001);
    l.noteWorldEntered();
    l.noteLoggedOut();
    l.beginChargenResume();
    expect(l.nextResumeDelay()).toBe(RESUME_DELAYS_MS[0]);
    expect(l.pickAutoEnterSlot([{ id: String(0x50000001) }], true)).toBeNull();
    l.endResume();
    expect(l.resumingChargen).toBe(false);
    // The next drop in the world is a world resume again, not a chargen one.
    l.noteEnterWorldRequested(0x50000001);
    l.noteWorldEntered();
    l.noteDisconnected();
    expect(l.nextResumeDelay()).toBe(RESUME_DELAYS_MS[0]);
    expect(l.resumingChargen).toBe(false);
  });
});

// ── restoreWizard: every index re-validated ──────────────────────────

/** A small CharGen double (the fields chargen reads): heritages 1..3, 330 / 50 credits, 2 hair styles. */
function depsFor(over: { heritages?: number[]; listed?: (h: number) => boolean; areas?: number } = {}) {
  const heritages = over.heritages ?? [1, 2, 3];
  const lists = { hairStyleCount: 2, hairColorCount: 3, eyeStripCount: 2, eyeColorCount: 2, noseStripCount: 2, mouthStripCount: 2, headgearCount: 2, shirtCount: 2, pantsCount: 2, footwearCount: 2, clothingColorCount: 4 };
  return {
    hasThroneOfDestiny: false,
    heritageGroup: (h: number) => (heritages.includes(h) ? { attributeCredits: 330, skillCredits: 50, primaryStartAreas: [0] } : undefined),
    templatesFor: () => [ADVENTURER_TEMPLATE, ADVENTURER_TEMPLATE],
    costsFor: () => ({ skillIds: [6, 7], trainedCost: (id: number) => (id === 6 ? 4 : 0), specializedCost: (id: number) => (id === 6 ? 8 : 0) }),
    listsFor: () => lists,
    starterAreaCount: over.areas ?? 5,
    heritageListed: over.listed ?? (() => true),
    clothingColorCounts: () => ({ headgear: 3, shirt: 3, pants: 3, footwear: 3 }),
  };
}

describe('restoreWizard', () => {
  const good = (): ChargenWizardSnapshot => snap({ skills: [[6, 2], [7, 2]], skillCreditsUsed: 4, startArea: 2, appearance: { ...snap().appearance, hairStyle: 1, shirtColor: 2, skinHue: 0.4 } });

  it('a valid draft comes back exactly', () => {
    const w = new CharacterCreateWizard();
    expect(restoreWizard(w, good(), depsFor())).toBe(true);
    expect(snapshotWizard(w, true)).toEqual(good());
  });

  it.each([
    ['a heritage this world does not have (another era\'s DATs)', { heritage: 4 }],
    ['an appearance index past the Sex_CG list', { appearance: { ...snap().appearance, hairStyle: 2 } }],
    ['a negative index below "none"', { appearance: { ...snap().appearance, noseStyle: -2 } }],
    ['a start area past the CharGen\'s', { startArea: 5 }],
    ['credits of another heritage table', { attributeCredits: 300 }],
    ['attributes over the credits', { attributes: { strength: 100, endurance: 100, coordination: 100, quickness: 100, focus: 10, self: 10 } }],
    ['a skill the table does not price', { skills: [[99, 2]] as [number, number][] }],
    ['skill credits that do not add up', { skills: [[6, 2]] as [number, number][], skillCreditsUsed: 0 }],
    ['a page off the wizard', { step: 9 }],
    ['an invalid gender', { gender: 0 }],
    ['a template past the list', { templateIndex: 3 }],
  ])('drops %s', (_why, over) => {
    expect(restoreWizard(new CharacterCreateWizard(), { ...good(), ...over } as ChargenWizardSnapshot, depsFor())).toBe(false);
  });

  it('a clothing colour past the item\'s palette count (counts unknown when it was rolled) is clamped, not a refusal', () => {
    const w = new CharacterCreateWizard();
    const s = { ...good(), appearance: { ...good().appearance, shirtColor: 3 } };
    expect(restoreWizardVerdict(w, s, depsFor())).toBeNull();
    expect(w.appearance.shirtColor).toBe(2); // Set<Slot>Style's clamp to the item's 3 colours
    // Everything else stays exactly the draft's.
    expect({ ...snapshotWizard(w, true), appearance: { ...w.appearance, shirtColor: 3 } }).toEqual(s);
  });

  it('a refusal says which check failed, with the field and value', () => {
    expect(restoreWizardVerdict(new CharacterCreateWizard(), { ...good(), startArea: 5 }, depsFor())).toBe('startArea 5: of 5');
    expect(restoreWizardVerdict(new CharacterCreateWizard(), { ...good(), appearance: { ...good().appearance, hairStyle: 2 } }, depsFor()))
      .toBe('appearance hairStyle 2: constrained to 1');
    expect(restoreWizardVerdict(new CharacterCreateWizard(), { ...good(), heritage: 4 }, depsFor())).toBe('heritage 4: not in this CharGen');
  });

  it('drops a heritage the server refused (Olthoi on a world that forbids it: not listed)', () => {
    const olthoi = { ...good(), heritage: 12, step: CreateStep.Appearance };
    expect(restoreWizard(new CharacterCreateWizard(), olthoi, depsFor({ heritages: [1, 12] }))).toBe(true);
    expect(restoreWizard(new CharacterCreateWizard(), olthoi, depsFor({ heritages: [1, 12], listed: (h) => h !== 12 }))).toBe(false);
  });

  it('drops a draft on a page SetProgressState hides for its heritage (Olthoi on Skills)', () => {
    expect(restoreWizard(new CharacterCreateWizard(), { ...good(), heritage: 12, step: CreateStep.Skills }, depsFor({ heritages: [12] }))).toBe(false);
  });

  it('drops a malformed draft', () => {
    expect(restoreWizard(new CharacterCreateWizard(), { ...good(), appearance: undefined } as any, depsFor())).toBe(false);
    expect(restoreWizard(new CharacterCreateWizard(), { ...good(), name: 'x'.repeat(65) }, depsFor())).toBe(false);
  });
});

// ── the real GameUI chargen ───────────────────────────────────────────

const AREAS = ['Holtburg South', 'Holtburg West', 'Rithwic East', 'Shoushi West', 'Yaraq North'];
const TEMPLATE_NAMES = ['Adventurer', 'Archer', 'Warrior'];
const charGen1999Shape = {
  starterAreas: AREAS.map((name) => ({ name, locations: [] })),
  heritageGroups: new Map([1, 2, 3].map((h) => [h, {
    name: `h${h}`, iconImage: 0, setupId: 0, environmentSetupId: 0, attributeCredits: 330, skillCredits: 50,
    primaryStartAreas: [h - 1], secondaryStartAreas: [], skills: [],
    templates: TEMPLATE_NAMES.map((name) => ({ name, iconImage: 0, title: 0, strength: 10, endurance: 10, coordination: 10, quickness: 10, focus: 10, self: 10, normalSkillsList: [], primarySkillsList: [] })),
    genders: new Map(),
  }])),
};

function prep(ui: any, charGen: any, skillTable: any = null): void {
  ui.getTexURL = () => null;
  ui.charGen = charGen;
  ui.skillTable = skillTable;
  ui.paintChargenShadeDisk = () => {};
  ui.renderChargenPreview = () => {};
  ui.renderChargenSummaryView = () => {};
  ui.hideMessageDialog();
  ui.hideConfirmationDialog();
}

/** The player's own choices: another heritage and gender, a face, clothes, a town, a typed name, the Appearance page. */
function play(ui: any, heritage: number, gender = 2): void {
  const deps = ui.chargenRollDeps();
  ui.wizard.setHeritageGroup(heritage, deps, scriptedRandomSource([0], [0]));
  ui.wizard.setGender(gender, deps);
  const lists = deps.listsFor(heritage, gender);
  if (lists.hairStyleCount > 1) ui.wizard.appearance.hairStyle = lists.hairStyleCount - 1;
  if (lists.eyeColorCount > 1) ui.wizard.appearance.eyeColor = 1;
  ui.wizard.appearance.skinHue = 0.25;
  ui.wizard.startArea = Math.min(1, deps.starterAreaCount - 1);
  ui.wizard.setName('Brenna Qaeol');
  ui.chargenNameEntered = true;
  ui.wizard.setProgressState(CreateStep.Appearance);
  ui.renderCharacterCreate();
}

/** Drop → resume → char list → chargen, as main.ts runs it. */
function dropAndResume(ui: any, store: ChargenDraftStore, owner: ChargenDraftOwner): { before: ChargenWizardSnapshot; after: ChargenWizardSnapshot } {
  const cap = ui.captureChargenDraft();
  expect(cap).not.toBeNull();
  store.save({ owner, savedAt: Date.now(), wizard: cap.wizard, pending: cap.pending, createdGuid: null, knownGuids: [] });
  const life = new SessionLifecycle();
  life.beginChargenResume();
  expect(life.nextResumeDelay()).toBe(2000);
  ui.showConnectingScreen(); // the resume's connecting screen replaces chargen
  expect(ui.captureChargenDraft()).toBeNull();
  const resuming = life.resumingChargen;
  life.endResume();
  ui.showCharacterSelect([], 5);
  const act = decideChargenDraft(store, owner, [], resuming);
  expect(act.kind).toBe('restore');
  const wizard = (act as { wizard: ChargenWizardSnapshot }).wizard;
  expect(ui.chargenDraftApplies(wizard)).toBe(true);
  ui.showCharacterCreate(wizard);
  return { before: cap.wizard, after: ui.captureChargenDraft().wizard };
}

describe('GameUI: drop mid-chargen, resume, same step and choices (1999-shaped CharGen, CI)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H?.teardown());

  it('restores every choice on the same page; then a fresh Create Character starts clean', () => {
    const ui = H.ui;
    prep(ui, charGen1999Shape);
    ui.chargenRandomSource = seededRandomSource(7);
    ui.showCharacterCreate();
    play(ui, 3);
    const store = new ChargenDraftStore(new MemoryStorage());
    const { before, after } = dropAndResume(ui, store, { ...OWNER, era: 'ac1999-retail' });
    expect(ui.lastChargenRestore).toBe('restored');
    expect(after).toEqual(before);
    expect(ui.chargenStep).toBe(CreateStep.Appearance);
    expect(store.held).toBe(false); // consumed

    // A new start (character select's Create Character): never the draft.
    ui.showCharacterSelect([], 5);
    ui.chargenRandomSource = seededRandomSource(7);
    ui.showCharacterCreate();
    expect(ui.lastChargenRestore).toBe('fresh');
    const fresh = snapshotWizard(ui.wizard, ui.chargenNameEntered);
    expect(fresh.name).toBe('');
    expect(fresh.nameEntered).toBe(false);
    expect(fresh.step).toBe(CreateStep.Heritage);
  });

  it('a draft that no longer validates opens a clean chargen (and the check says so beforehand)', () => {
    const ui = H.ui;
    prep(ui, charGen1999Shape);
    const bad = { ...snapshotWizard(ui.wizard, true), heritage: 5 };
    expect(ui.chargenDraftApplies(bad)).toBe(false);
    ui.showCharacterCreate(bad);
    expect(ui.lastChargenRestore).toBe('invalid');
    expect(ui.wizard.heritage).not.toBe(5);
    expect(ui.chargenStep).toBe(CreateStep.Heritage);
    expect(ui.wizard.name).toBe('');
  });

  it('an era whose heritages exclude the draft\'s (eraHeritages) drops it', () => {
    const ui = H.ui;
    prep(ui, charGen1999Shape);
    ui.showCharacterCreate();
    play(ui, 2);
    const cap = ui.captureChargenDraft().wizard;
    ui.eraHeritages = new Set([1, 3]);
    try {
      expect(ui.chargenDraftApplies(cap)).toBe(false);
    } finally {
      ui.eraHeritages = null;
    }
  });

  it('FINISH pending at the drop is captured as pending, and the draft comes back on the summary', () => {
    const ui = H.ui;
    prep(ui, charGen1999Shape);
    ui.showCharacterCreate();
    play(ui, 1);
    ui.chargenVerificationPending = true; // DoFinish sent the CharacterCreate
    const cap = ui.captureChargenDraft();
    expect(cap.pending).toBe(true);
    expect(cap.created).toBe(false);
    const store = new ChargenDraftStore(new MemoryStorage());
    store.save({ owner: OWNER, savedAt: Date.now(), wizard: cap.wizard, pending: true, createdGuid: null, knownGuids: [] });
    ui.showConnectingScreen();
    const act = decideChargenDraft(store, OWNER, [], true) as { kind: string; wizard: ChargenWizardSnapshot };
    ui.showCharacterCreate(act.wizard);
    expect(ui.chargenStep).toBe(CreateStep.Summary);
    expect(ui.wizard.name).toBe('Brenna Qaeol');
    expect(ui.chargenVerificationPending).toBe(false); // a new gmCharGenMainUI: FINISH usable
  });

  it('a draft waiting on the world art opens restored; a fresh click meanwhile wins', async () => {
    const ui = H.ui;
    prep(ui, charGen1999Shape);
    ui.showCharacterCreate();
    play(ui, 2);
    const cap = ui.captureChargenDraft().wizard;
    ui.showCharacterSelect([], 5);
    let release!: () => void;
    ui.worldArtPending = new Promise<void>((r) => { release = r; });
    ui.showCharacterCreate(cap);
    ui.showCharacterCreate(); // Create Character pressed while waiting: clean start
    ui.worldArtPending = null;
    release();
    await Promise.resolve(); await Promise.resolve();
    expect(ui.lastChargenRestore).toBe('fresh');
    expect(ui.wizard.name).toBe('');
  });
});

const hasEoL = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);
const DM_PORTAL = 'dat/sets/classic-dereth/client_portal.dat';
const hasDM = hasEoL && existsSync(DM_PORTAL);

describe.skipIf(!hasEoL)('GameUI with the real CharGens: end of retail and Dark Majesty', () => {
  let H: GameUIFixture;
  let eol: { charGen: any; skills: any };
  let dm: { charGen: any; skills: any } | null = null;
  beforeAll(async () => {
    H = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const { CharacterGenerator } = await import('../packages/dat-parser/src/file-types/CharacterGenerator.js');
    const local = openDat(DAT_PATHS.local);
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000002)));
    const load = (path: string) => {
      const portal = openDat(path);
      return { charGen: new CharacterGenerator(portal.getReader(0x0e000002)), skills: new dat.SkillTable(portal.getReader(0x0e000004)) };
    };
    eol = load(DAT_PATHS.portal);
    if (hasDM) dm = load(DM_PORTAL);
  });
  afterAll(() => H?.teardown());

  it('end of retail: every choice back on the same page, skills included', () => {
    const ui = H.ui;
    prep(ui, eol.charGen, eol.skills);
    ui.showCharacterCreate();
    play(ui, 4); // Viamontian
    ui.wizard.setProgressState(CreateStep.Town);
    const { before, after } = dropAndResume(ui, new ChargenDraftStore(new MemoryStorage()), OWNER);
    expect(after).toEqual(before);
    expect(after.skills.length).toBeGreaterThan(0);
    expect(ui.chargenStep).toBe(CreateStep.Town);
  });

  it('end of retail Olthoi; then a world that refused Olthoi drops the draft', () => {
    const ui = H.ui;
    prep(ui, eol.charGen, eol.skills);
    ui.showCharacterCreate();
    play(ui, 12);
    const { before, after } = dropAndResume(ui, new ChargenDraftStore(new MemoryStorage()), OWNER);
    expect(after).toEqual(before);
    ui.chargenOlthoiDisallowed = true;
    try {
      expect(ui.chargenDraftApplies(before)).toBe(false);
      ui.showCharacterCreate(before);
      expect(ui.lastChargenRestore).toBe('invalid');
    } finally {
      ui.chargenOlthoiDisallowed = false;
    }
  });

  it.skipIf(!hasDM)('Dark Majesty (Classic Dereth CharGen, three heritages): restored; an end-of-retail draft does not fit it', () => {
    const ui = H.ui;
    prep(ui, dm!.charGen, dm!.skills);
    ui.eraHeritages = new Set([1, 2, 3]);
    try {
      ui.showCharacterCreate();
      play(ui, 2);
      const { before, after } = dropAndResume(ui, new ChargenDraftStore(new MemoryStorage()), { ...OWNER, era: 'classic-dereth' });
      expect(after).toEqual(before);
      // An end-of-retail Viamontian draft against this era: dropped.
      prep(ui, eol.charGen, eol.skills);
      ui.eraHeritages = null;
      ui.showCharacterCreate();
      play(ui, 4);
      const eolDraft = ui.captureChargenDraft().wizard;
      prep(ui, dm!.charGen, dm!.skills);
      ui.eraHeritages = new Set([1, 2, 3]);
      expect(ui.chargenDraftApplies(eolDraft)).toBe(false);
    } finally {
      ui.eraHeritages = null;
    }
  });
});

// ── the real 1999 world portal (AC1999) ───────────────────────────────

const PORTAL_1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail', 'portal.dat');

describe.skipIf(!existsSync(PORTAL_1999))('GameUI on the real 1999 world portal (AC1999)', () => {
  let world: DatDatabase;
  beforeAll(() => {
    // Its own instance: the overlay would change what other files read from openDat's shared one.
    world = new DatDatabase(new FileDatBytes(PORTAL_1999));
    world.setOverlay(ac1999PortalOverlay());
  });

  it('a Sho with a 1999 town and template comes back; an end-of-retail Viamontian draft does not fit', async () => {
    const H = await mountGameUI();
    try {
      const ui = new H.mod.GameUI(H.container, {}, world) as any;
      ui.getTexURL = () => null;
      ui.paintChargenShadeDisk = () => {};
      ui.renderChargenPreview = () => {};
      ui.renderChargenSummaryView = () => {};
      ui.accountHasThroneOfDestiny = false;
      ui.showCharacterCreate();
      play(ui, 3);
      ui.wizard.startArea = 17;
      const templates = ui.chargenRollDeps().templatesFor(3);
      expect(templates.length).toBe(8);
      ui.wizard.setTemplate(7);
      ui.wizard.applyTemplate(templates, ui.chargenRollDeps().costsFor(3));
      const { before, after } = dropAndResume(ui, new ChargenDraftStore(new MemoryStorage()), { ...OWNER, era: 'ac1999-retail' });
      expect(after).toEqual(before);
      expect(after.startArea).toBe(17);
      expect(after.templateIndex).toBe(7);
      expect(ui.chargenDraftApplies({ ...before, heritage: 4 })).toBe(false);
      expect(ui.chargenDraftApplies({ ...before, startArea: 18 })).toBe(false);
    } finally {
      H.teardown();
    }
  });
});

// ── the AC1999 server's double character list (live check, 2026-10-29) ──

/** The recorded AC1999 server traffic (tests/fixtures): its login sends the list, the news, then the list again. */
const S2C_1999: Uint8Array[] = gunzipSync(readFileSync(resolve(__dirname, 'fixtures', 'ac1999-session-001.jsonl.gz')))
  .toString().trim().split('\n').map((l) => JSON.parse(l))
  .filter((j) => j.d === 's2c').map((j) => new Uint8Array(Buffer.from(j.b, 'base64')));

class Socket1999 {
  static OPEN = 1;
  static sockets: Socket1999[] = [];
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { Socket1999.sockets.push(this); }
  send(): void {}
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.(); }
  deliver(b: Uint8Array): void { this.onmessage?.({ data: b.slice().buffer }); }
}

describe('AC1999: the server\'s second character list never tears a restored chargen down', () => {
  let H: GameUIFixture;
  const g = globalThis as { WebSocket?: unknown };
  let savedWs: unknown;
  beforeAll(async () => { H = await mountGameUI(); savedWs = g.WebSocket; g.WebSocket = Socket1999; });
  afterAll(() => { g.WebSocket = savedWs; H?.teardown(); });

  /**
   * Log in over the recorded bytes through the real Connection1999, feeding each character list
   * to main.ts's handling (characterListRole → char select / the draft decision, once per session).
   */
  function login(ui: any, live: SessionLiveness, store: ChargenDraftStore, life: SessionLifecycle, owner: ChargenDraftOwner) {
    const out = { lists: 0, roles: [] as string[], decisions: [] as string[] };
    live.noteConnectAttempt(); // the page's connect
    const conn = new Connection1999('ws://bridge');
    conn.datIterations = { portal: 102, cell: 67, language: 0 };
    conn.on((e: ConnectionEvent) => {
      if (e.type !== 'characterList') return;
      out.lists++;
      const list = parseCharacterList(e.data as Uint8Array);
      const role = characterListRole(live.isLive, ui.uiManager.currentScreen);
      live.noteCharacterList();
      out.roles.push(role);
      if (role === 'keep_chargen') return;
      const slots = list.characters.map((c) => ({ id: String(c.id), name: c.name, deleteTime: c.deleteTime }));
      const resuming = life.resumingChargen;
      if (resuming) life.endResume();
      const act = role === 'first' ? decideChargenDraft(store, owner, slots, resuming) : { kind: 'none' as const };
      out.decisions.push(act.kind);
      ui.showCharacterSelect(slots, list.slotCount);
      if (act.kind === 'restore' && ui.chargenDraftApplies(act.wizard)) ui.showCharacterCreate(act.wizard);
    });
    conn.connect('acjsdbja', 'acjsdbja');
    const sock = Socket1999.sockets[Socket1999.sockets.length - 1];
    sock.open();
    // Up to the second list (the news between them), as the server sends them.
    for (const b of S2C_1999) { sock.deliver(b); if (out.lists >= 2) break; }
    return { conn, out };
  }

  it('drop in chargen, resume: both lists arrive; chargen stays restored, the draft decided and consumed once', () => {
    const ui = H.ui;
    prep(ui, charGen1999Shape);
    const owner = { ...OWNER, era: 'ac1999-retail' };
    const live = new SessionLiveness();
    const store = new ChargenDraftStore(new MemoryStorage());
    const life = new SessionLifecycle();
    // The first session: both lists, then the player opens chargen and makes choices.
    const first = login(ui, live, store, life, owner);
    expect(first.out.lists).toBe(2);
    expect(first.out.roles).toEqual(['first', 'repeat']); // on char select both times: the list redraws, no draft
    ui.showCharacterCreate();
    play(ui, 3);
    // The drop: main.ts keeps the draft and arms the chargen resume.
    const cap = ui.captureChargenDraft();
    store.save({ owner, savedAt: Date.now(), wizard: cap.wizard, pending: cap.pending, createdGuid: null, knownGuids: [] });
    life.beginChargenResume();
    expect(life.nextResumeDelay()).toBe(2000);
    live.noteEnded();
    first.conn.disconnect();
    ui.showConnectingScreen();
    // The resume's login: the first list restores chargen, the second (11 ms later live) keeps it.
    const second = login(ui, live, store, life, owner);
    expect(second.out.lists).toBe(2);
    expect(second.out.roles).toEqual(['first', 'keep_chargen']);
    expect(second.out.decisions).toEqual(['restore']);
    expect(ui.uiManager.currentScreen).toBe('character-create');
    expect(ui.captureChargenDraft().wizard).toEqual(cap.wizard);
    expect(store.held).toBe(false);
    second.conn.disconnect();
  });

  it('end of retail / Dark Majesty (one list per login) and a later list elsewhere are unchanged', () => {
    expect(characterListRole(false, 'character-select')).toBe('first');
    expect(characterListRole(false, 'character-create')).toBe('first'); // a new session's first list always redraws
    expect(characterListRole(true, 'game')).toBe('repeat'); // ACE's list after a logoff: character select as before
    expect(characterListRole(true, 'character-select')).toBe('repeat'); // after a delete / a 1999 create
    expect(characterListRole(true, 'character-create')).toBe('keep_chargen');
  });
});

// ── telemetry ─────────────────────────────────────────────────────────

describe('telemetry: resume_ended with the chargen tokens passes the bridge as it is', () => {
  it('every token survives sanitizeClientPreworld (no bridge deploy needed)', () => {
    const sent: PreworldEvent[] = [];
    const r = new PreworldReporter({
      endpoint: 'http://x/client-preworld', build: 'eb3bcb5e', era: () => 'eor', server: () => 'coldeve',
      screen: () => 'chargen', chargenStep: () => null, now: () => 1, trace: 'feedc0de12345678',
      send: (_u, raw) => { sent.push(JSON.parse(raw) as PreworldEvent); },
    });
    for (const t of CHARGEN_RESUME_TOKENS) r.resumeEnded(t);
    expect(sent.map((e) => e.token)).toEqual([...CHARGEN_RESUME_TOKENS]);
    for (const ev of sent) expect(sanitizeClientPreworld(ev)).toMatchObject({ outcome: 'resume_ended', token: ev.token, screen: 'chargen' });
  });
});
