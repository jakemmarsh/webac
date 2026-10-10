/**
 * FAITHFUL.260 — Live `connection` HUD indicator (texActive 0x06001103 /
 * texInactive 0x0600110f) reflects WS-to-bridge connection state.
 *
 * Pre-fix the indicator was created with texInactive and never updated.
 * Fix: hook the existing aceConnection 'connected' / 'disconnected' events
 * to setIndicatorActive('connection', ...).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN_TS = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');
const GAMEUI_TS = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf-8');

describe('FAITHFUL.260 — live connection indicator', () => {
  it("'connected' event lights the connection indicator", () => {
    expect(MAIN_TS).toMatch(
      /case 'connected':[\s\S]+?gameUI\.setIndicatorActive\('connection', true\);/,
    );
  });

  it('post-HUD-show resync sets the indicator from aceConnection.isConnected', () => {
    // The 'connected' event fires BEFORE the HUD is built, so the first
    // setIndicatorActive call hits a missing DOM node. We resync after
    // showGame() to capture the live state.
    expect(MAIN_TS).toMatch(
      /gameUI\.showGame\(\);[\s\S]+?gameUI\.setIndicatorActive\('connection', aceConnection\.isConnected\);/,
    );
  });

  it("'disconnected' event drops the connection indicator", () => {
    expect(MAIN_TS).toMatch(
      /case 'disconnected':[\s\S]+?gameUI\.setIndicatorActive\('connection', false\);/,
    );
  });

  it('connection indicator def is the CORE.5.b LinkStatus element (0x100000f8, green 0x06007498 / red 0x0600749a)', () => {
    const block = GAMEUI_TS.match(/id: 'connection'[\s\S]{0,200}/)?.[0] ?? '';
    expect(block).toContain('elementId: 0x100000f8');
    expect(block).toContain('texActive: 0x06007498');
    expect(block).toContain('texInactive: 0x0600749a');
  });

  it('setIndicatorActive exists in GameUI public surface', () => {
    expect(GAMEUI_TS).toMatch(/setIndicatorActive\(id: string, active: boolean\): void \{/);
  });
});
