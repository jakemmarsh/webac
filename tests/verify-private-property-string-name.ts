/**
 * FAITHFUL.379 — PrivateUpdatePropertyString (Name=1) updates the
 *  local player's name in playerState.
 *
 * Pre-fix this handler was diagnostic-only. ACE
 * Player_AdminCommands.cs emits PrivateUpdatePropertyString to a
 * renamed character on the self-side path (alongside the broadcast
 * PublicUpdate to observers, handled by FAITHFUL.378). The local
 * player's name stayed frozen at login-time until they logged out +
 * back in. Affected: chat sender label, fellowship roster, any UI
 * that reads `playerState.name`.
 *
 * ACE refs:
 *   reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyString.cs:5
 *     → Name = 1
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('onPrivateUpdatePropertyString handles Name=1 (FAITHFUL.379)', () => {
  const block = MAIN.match(/onPrivateUpdatePropertyString:[\s\S]+?\n      \},/)?.[0] ?? '';
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('branches on data.key === 1', () => {
    expect(code).toMatch(/data\.key === 1/);
  });

  it('mutates playerState.name', () => {
    expect(code).toMatch(/playerState\.name = val/);
  });

  it('guards against empty + non-string values', () => {
    expect(code).toMatch(/typeof val === 'string'/);
    expect(code).toMatch(/val\.length\s*>\s*0/);
  });

  it('cites FAITHFUL.379 in the docblock', () => {
    expect(MAIN).toMatch(/FAITHFUL\.379/);
  });
});
