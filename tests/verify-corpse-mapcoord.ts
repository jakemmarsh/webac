/**
 * FAITHFUL.244 — /corpse + /cor commands and faithful AC map-coord format.
 *
 * Closes three issues at once:
 *  1. New `formatMapCoord(worldX, worldZ)` helper in @ac/shared matches
 *     ACE PositionExtensions.GetMapCoordStr exactly: 1 map unit = 240m,
 *     center at (0,0) after the -102 shift, 0.05 rounding bias.
 *  2. HUD.updatePosition + /loc both used the wrong formula (1u = 192m
 *     landblock-based with center at ±128) — the numbers they showed
 *     didn't match what ACE/retail emitted.
 *  3. PositionType.LastOutsideDeath (=14) from
 *     GameMessagePrivateUpdatePosition was logged but not cached, so /corpse
 *     + /cor (per Microsoft KB Q243622) had no source of truth to read from.
 *     Now cached on receipt; new /corpse + /cor cases display
 *     'Your corpse is located at (<coords>).' (matching the on-death message
 *     from Creature_Death.cs:562 verbatim) or an empty-state Help message.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatMapCoord } from '@ac/shared';
import { HUD } from '../packages/renderer/src/ui/HUD.js';

const REPO = resolve(__dirname, '..');
const MAIN_TS = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('FAITHFUL.244 — /corpse + faithful AC map coords', () => {
  describe('formatMapCoord — matches ACE GetMapCoordStr', () => {
    it('center of Dereth → (0, 0) → small N + small E (after rounding bias)', () => {
      // 102 map units × 240 = 24480 m. At that origin, mapZ=0, mapX=0.
      // After |val|-0.05 the result is "0.0N, 0.0E" via Math.max clamp.
      expect(formatMapCoord(24480, 24480)).toBe('0.0N, 0.0E');
    });

    it('north of center: positive Z → N suffix', () => {
      // 10 map units north of center → Y = (102 + 10) * 240 = 26880
      const out = formatMapCoord(24480, 26880);
      expect(out).toMatch(/9\.\d?N/); // 10 - 0.05 = 9.95 → '10.0' (well, '9.9' after toFixed(1))
      expect(out).toMatch(/, 0\.0E$/);
    });

    it('south of center: negative Z → S suffix', () => {
      // 10 map units south of center → Y = (102 - 10) * 240 = 22080
      expect(formatMapCoord(24480, 22080)).toMatch(/^9\.9S/);
    });

    it('east + west signs', () => {
      const east = formatMapCoord(26880, 24480);
      expect(east).toMatch(/0\.0[NS], 9\.9E/);
      const west = formatMapCoord(22080, 24480);
      expect(west).toMatch(/0\.0[NS], 9\.9W/);
    });

    it('matches ACE 0.05 rounding-bias for typical retail values', () => {
      // Server-side GetMapCoordStr: format("{0:0.0}", abs - 0.05) — the bias
      // converts default round-half-to-even into round-down-to-tenths so
      // borderline values lean toward the smaller number. We mirror exactly.
      // 42.15N: worldZ = (42.15 + 102) × 240 = 34596. abs - 0.05 = 42.10 →
      // toFixed(1) = '42.1' (no rounding ambiguity).
      expect(formatMapCoord(24480, 34596)).toBe('42.1N, 0.0E');
      // 42.05N is the round-half boundary — Math.abs - 0.05 = 42.0 → '42.0'
      // (so the helper produces the LOWER of the two tenths, matching how
      // ACE's bias makes 42.05 print as 42.0 too).
      expect(formatMapCoord(24480, 34572)).toBe('42.0N, 0.0E');
    });
  });

  describe('HUD.updatePosition prints the radar\'s cell-quantized coordinates', () => {
    it('reads the 24 m cell\'s (c − 1024) × 0.1 + 0.5, not ACE\'s server text', () => {
      const hud = new HUD();
      // Holtburg: cell 1355 × 1440. ACE's GetMapCoordStr reads 42.0N, 33.5E here.
      hud.updatePosition(0xa9 * 192 + 80, 0, 0xb4 * 192 + 20); // (x, height, north) as the game loop passes it
      expect(hud.acCoordinates).toBe('42.1N, 33.6E');
      expect(formatMapCoord(0xa9 * 192 + 80, 0xb4 * 192 + 20)).toBe('42.0N, 33.5E');
      // The origin cell (1024, 1024) reads 0.5N, 0.5E; the one below-left of it 0.5S, 0.5W.
      hud.updatePosition(1024 * 24 + 1, 0, 1024 * 24 + 1);
      expect(hud.acCoordinates).toBe('0.5N, 0.5E');
      hud.updatePosition(1018 * 24 + 1, 0, 1018 * 24 + 1);
      expect(hud.acCoordinates).toBe('0.1S, 0.1W');
    });
  });

  describe('LastOutsideDeath caching (read by retail @corpse, verify-retail-commands-death-travel-house.ts)', () => {
    // BUG.corpse-cache-stale-char-switch — the cache is now a
    // LastOutsideDeathState instance (packages/renderer/src/session/
    // LastOutsideDeathState.ts), cleared by teardownWorldState() on every
    // logoff/character-logoff/disconnect boundary. The clear() behavior
    // itself is exercised behaviorally in
    // verify-last-outside-death-state-clear.ts against the real class;
    // this file only pins main.ts's wiring to it.
    it('declares LastOutsideDeathState (not a bare nullable variable)', () => {
      expect(MAIN_TS).toMatch(/import \{ LastOutsideDeathState \} from '\.\/session\/LastOutsideDeathState\.js';/);
      expect(MAIN_TS).toMatch(/const lastOutsideDeathState = new LastOutsideDeathState\(\);/);
      expect(MAIN_TS).not.toMatch(/let lastOutsideDeathPos/);
    });

    it('onPrivateUpdatePosition handles PositionType.LastOutsideDeath (=14) via the shared resolveLoginPositionRestore()', () => {
      // BUG.login-position-restore-unreachable-positiontypes — the
      // per-branch positionType switch was consolidated: LastOutsideDeath
      // (the only PositionType ACE ever sends here) now resolves through
      // the same tested resolveLoginPositionRestore() the login snapshot
      // path uses (see tests/verify-login-position-restore.ts and
      // packages/shared/src/systems/LoginPositionRestore.ts).
      expect(MAIN_TS).toMatch(/onPrivateUpdatePosition: \(data\) => \{[\s\S]{0,3000}resolveLoginPositionRestore\(data\.positionType, data, wx, wy, wz\)/);
      expect(MAIN_TS).toMatch(/action\?\.kind === 'lastOutsideDeath'[\s\S]{0,500}lastOutsideDeathState\.set\(\{ worldX: action\.worldX, worldZ: action\.worldZ, cellId: data\.landblockId \}\)/);
    });

    it('teardownWorldState clears the cache on logoff/character-switch/disconnect', () => {
      // Lazy match to the function's closing brace (first `\n  }` at
      // function-level indent) — an explicit char cap here broke once the
      // body legitimately grew past it (BUG.item-shortcut-restore-runs-
      // before-inventory added a teardown clear).
      const block = MAIN_TS.match(/function teardownWorldState\(\): void \{[\s\S]*?\n  \}/)?.[0] ?? '';
      expect(block).toContain('lastOutsideDeathState.clear();');
    });
  });
});
