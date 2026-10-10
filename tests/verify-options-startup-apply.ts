/**
 * FAITHFUL.438 — Apply restored runAsDefault to cameraController at
 *  startup.
 *
 *  FAITHFUL.432 persists optionsSettings to localStorage and restores
 *  them via an IIFE in GameUI's constructor. For SETTING-VALUES that
 *  are read live each frame (e.g. `gameUI.optionsSettings.autoTarget`
 *  in main.ts attack code, `optionsSettings.showTooltips` in the
 *  3D-view hover tooltip) the round-trip is automatic.
 *
 *  But for settings that push their value into a separate live
 *  object (e.g. `cameraController.runIsDefault`), restore is not
 *  enough — the live object needs a one-time `apply` call at
 *  startup, AFTER GameUI is constructed (so optionsSettings is
 *  restored) and AFTER the live object is constructed.
 *
 *  This pins the apply call exists for the runAsDefault → camera
 *  case. Pre-fix the persisted value sat in localStorage but the
 *  camera always started with the default until the user toggled
 *  again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('FAITHFUL.438 — runAsDefault startup-apply', () => {
  it('cameraController.runIsDefault is set from restored optionsSettings.runAsDefault', () => {
    expect(MAIN).toMatch(
      /cameraController\.runIsDefault\s*=\s*gameUI\.optionsSettings\.runAsDefault === true/,
    );
  });

  it('the apply runs AFTER the gameUI = new GameUI(...) constructor', () => {
    const gameUiIdx = MAIN.indexOf('const gameUI = new GameUI(');
    const applyIdx = MAIN.indexOf(
      'cameraController.runIsDefault = gameUI.optionsSettings.runAsDefault',
    );
    expect(gameUiIdx).toBeGreaterThan(0);
    expect(applyIdx).toBeGreaterThan(gameUiIdx);
  });

  it('the apply runs AFTER the cameraController = new CameraController(...) construction', () => {
    const camIdx = MAIN.indexOf('const cameraController = new CameraController(');
    const applyIdx = MAIN.indexOf(
      'cameraController.runIsDefault = gameUI.optionsSettings.runAsDefault',
    );
    expect(camIdx).toBeGreaterThan(0);
    expect(applyIdx).toBeGreaterThan(camIdx);
  });

  it('main.ts cites FAITHFUL.438', () => {
    expect(MAIN).toMatch(/FAITHFUL\.438/);
  });
});
