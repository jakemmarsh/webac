/**
 * UX.chargen-resume — the property sweep behind verify-ux-chargen-resume-roundtrip*.ts: seeded
 * RandomizeCharacter rolls plus a player's edits on the real GameUI chargen, each captured as main.ts
 * captures a draft and restored (scratch wizard and the page itself); returns every failure with why.
 * One era per test file: each era's DATs and GameUI cost a worker's heap.
 */
import { restoreWizardVerdict, snapshotWizard } from '../../packages/renderer/src/ui/ChargenDraft.js';
import { CharacterCreateWizard } from '../../packages/renderer/src/ui/CharacterCreate.js';
import { seededRandomSource } from '../../packages/renderer/src/ui/ChargenRandomize.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const ROLLS = 60;
/** The page-level restore (GameUI render) every this many seeds: it is the heavy part. */
const PAGE_EVERY = 4;

export function stub(ui: any): void {
  ui.getTexURL = () => null;
  ui.paintChargenShadeDisk = () => {};
  ui.renderChargenPreview = () => {};
  ui.renderChargenSummaryView = () => {};
}

/** Seeded player edits on top of the opening roll, through the wizard's own paths. */
function edit(ui: any, seed: number): void {
  const src = seededRandomSource(seed * 7919 + 13);
  const r = (n: number): number => Math.floor(src.roll() * n) % Math.max(1, n);
  const deps = ui.chargenRollDeps();
  const heritages = [...(ui.charGen?.heritageGroups.keys() ?? [])].filter((h: number) => deps.heritageListed?.(h) ?? true);
  ui.chargenRandomSource = src;
  for (let i = 0, n = r(6); i < n; i++) {
    switch (r(6)) {
      case 0: ui.wizard.setHeritageGroup(heritages[r(heritages.length)], deps, src); break;
      case 1: ui.wizard.setGender(1 + r(2), deps); break;
      case 2: ui.wizard.setProgressState(r(6)); ui.renderCharacterCreate(); ui.doChargenRandom(); break; // the Random button on that page
      case 3: { const t = deps.templatesFor(ui.wizard.heritage); if (t.length) { ui.wizard.setTemplate(r(t.length)); ui.wizard.applyTemplate(t, deps.costsFor(ui.wizard.heritage)); } break; }
      case 4: ui.wizard.startArea = r(deps.starterAreaCount); break;
      case 5: ui.wizard.setName(`Name${seed}`); ui.chargenNameEntered = true; break;
    }
  }
  // Visit pages as a player does (the Face page's m_LastHeritageGroup moves with them), ending on one.
  for (let i = 0, n = 1 + r(3); i < n; i++) { ui.wizard.setProgressState(r(6)); ui.renderCharacterCreate(); }
}

export function sweep(ui: any): string[] {
  const failures: string[] = [];
  for (let seed = 1; seed <= ROLLS; seed++) {
    ui.hideConfirmationDialog?.();
    ui.chargenRandomSource = seededRandomSource(seed);
    ui.showCharacterCreate(); // RandomizeCharacter, as every fresh chargen opens
    if (seed % 2 === 0) edit(ui, seed);
    const snap = ui.captureChargenDraft().wizard; // what main.ts keeps at a drop
    const w = new CharacterCreateWizard();
    const verdict = restoreWizardVerdict(w, snap, ui.chargenRollDeps());
    if (verdict !== null) { failures.push(`seed ${seed}: ${verdict}`); continue; }
    const back = snapshotWizard(w, snap.nameEntered);
    const bare = { ...snap }; delete bare.appearanceLastHeritage;
    if (JSON.stringify(back) !== JSON.stringify(bare)) failures.push(`seed ${seed}: round trip differs`);
    if (seed % PAGE_EVERY !== 0) continue;
    // And through the page itself, opened on the step the drop left (it renders that page).
    ui.showCharacterSelect([], 5);
    ui.showCharacterCreate(snap);
    if (ui.lastChargenRestore !== 'restored') failures.push(`seed ${seed}: GameUI did not restore`);
    else {
      const got = ui.captureChargenDraft().wizard as Record<string, unknown>;
      const want = snap as unknown as Record<string, unknown>;
      const diff = Object.keys(want).filter((k) => JSON.stringify(got[k]) !== JSON.stringify(want[k]));
      if (diff.length) failures.push(`seed ${seed}: GameUI round trip differs in ${diff.map((k) => `${k} ${JSON.stringify(want[k])} -> ${JSON.stringify(got[k])}`).join('; ')}`);
    }
  }
  return failures;
}

