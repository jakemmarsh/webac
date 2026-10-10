/**
 * FAITHFUL.385 — IdentifyResponse mirrors PropertyInt.Level (25) onto
 *  the ServerObject + HUD target frame.
 *
 * Pre-fix the HUD target panel showed `level: 0` for nearby players +
 * creatures forever, because ACE doesn't broadcast PropertyInt.Level
 * to observers via PublicUpdatePropertyInt (FAITHFUL.384 wired the
 * rare admin-broadcast case, but observers normally see Level only
 * through the Identify response). When the user examines a target,
 * ACE returns IdentifyResponse with `propertiesInt` populated — we
 * now use that moment to refresh the HUD-visible level.
 *
 * ACE refs:
 *   reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs:38 → Level=25
 *   IdentifyResponse populates propertiesInt for creatures + players
 *   (Creature_Networking.cs SendIdentifyObjectResponse).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('onIdentifyResponse mirrors Level to ServerObject + HUD (FAITHFUL.385)', () => {
  const block = MAIN.match(/onIdentifyResponse:[\s\S]+?\n      \},/)?.[0] ?? '';
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('reads PropertyInt.Level from propertiesInt', () => {
    expect(code).toMatch(/data\.propertiesInt\?\.get\(PropertyInt\.Level\)/);
  });

  it('writes to obj.level when value present + positive', () => {
    expect(code).toMatch(/obj\.level\s*=\s*idLevel/);
    expect(code).toMatch(/idLevel\s*>\s*0/);
  });

  it('live-updates HUD target.level when the identified object is current target', () => {
    expect(code).toMatch(/currentTargetGuid === data\.guid/);
    expect(code).toMatch(/gameUI\.hudState\.target\.level\s*=\s*idLevel/);
  });

  it('cites FAITHFUL.385 in the docblock', () => {
    expect(MAIN).toMatch(/FAITHFUL\.385/);
  });
});
