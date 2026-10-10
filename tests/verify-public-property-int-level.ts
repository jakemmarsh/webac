/**
 * FAITHFUL.384 — PublicUpdatePropertyInt for Level (25) mirrors to
 *  ServerObject.level + live-updates the HUD target panel.
 *
 * Pre-fix the HUD target panel captured `level: 0` at selectTarget
 * time and never refreshed. ACE Player_Xp.cs broadcasts
 * PropertyInt.Level on every level-up, fellowship-join, and
 * observer-visible recalc — those broadcasts were console-only.
 *
 * Now:
 *  - ServerObject.level? mirror tracks the latest broadcast value.
 *  - onPublicUpdatePropertyInt key=25 mutates obj.level AND, when
 *    the object is the current target, also updates
 *    gameUI.hudState.target.level.
 *  - selectTarget reads obj.level ?? 0 instead of hard-coding 0, so
 *    a target with a known level shows it on first click.
 *
 * ACE refs:
 *   reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs → Level=25
 *   reference/ACE/Source/ACE.Server/WorldObjects/Player_Xp.cs — broadcast emit
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyPublicUpdatePropertyInt, applyPublicUpdatePropertyIntToHudTarget, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { PropertyInt } from '@ac/shared';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

function makeServerObject(overrides: Partial<ServerObject> = {}): ServerObject {
  return { guid: 1, name: 'Test Object', radarColor: 0, ...overrides } as unknown as ServerObject;
}

describe('ServerObject carries the level mirror (FAITHFUL.384)', () => {
  it('applyPublicUpdatePropertyInt(Level) mutates obj.level', () => {
    const obj = makeServerObject();
    applyPublicUpdatePropertyInt(obj, PropertyInt.Level, 30);
    expect(obj.level).toBe(30);
  });
});

describe('PublicUpdatePropertyInt Level also live-updates the HUD target panel (FAITHFUL.384)', () => {
  it('mirrors to the HUD target when the update is for the currently-selected target', () => {
    const hudTarget = { level: 0 };
    applyPublicUpdatePropertyIntToHudTarget(hudTarget, /* currentTargetGuid */ 0x50001234, /* guid */ 0x50001234, PropertyInt.Level, 30);
    expect(hudTarget.level).toBe(30);
  });

  it('does NOT mirror when the update is for a different object than the current target', () => {
    const hudTarget = { level: 0 };
    applyPublicUpdatePropertyIntToHudTarget(hudTarget, /* currentTargetGuid */ 0x50001234, /* guid */ 0x50009999, PropertyInt.Level, 30);
    expect(hudTarget.level).toBe(0);
  });

  it('does NOT mirror non-Level keys even for the currently-selected target', () => {
    const hudTarget = { level: 0 };
    applyPublicUpdatePropertyIntToHudTarget(hudTarget, 0x50001234, 0x50001234, PropertyInt.UiEffects, 30);
    expect(hudTarget.level).toBe(0);
  });

  it('is a no-op when there is no active HUD target (null)', () => {
    expect(() => applyPublicUpdatePropertyIntToHudTarget(null, 0x50001234, 0x50001234, PropertyInt.Level, 30)).not.toThrow();
  });
});

describe('selectTarget reads obj.level mirror (FAITHFUL.384)', () => {
  it('prefers obj.level ?? 0', () => {
    const fn = MAIN.match(/function selectTarget\([\s\S]+?\n  \}/)?.[0] ?? '';
    expect(fn).toMatch(/level:\s*obj\.level\s*\?\?\s*0/);
  });
});
