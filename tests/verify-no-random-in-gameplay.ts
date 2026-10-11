/**
 * FAITHFUL.216 — Server-authoritative gameplay drift guard.
 *
 * AC's gameplay rolls (combat hit/miss, damage variation, spell resist,
 * fizzle, critical hit, loot generation, …) ALL happen server-side. The
 * client just renders the outcome. Any client-side `Math.random()` in a
 * gameplay-decision path would silently desync from what the server
 * actually decided — which is the worst class of bug (looks fine until
 * a player notices their damage numbers don't match the server log).
 *
 * This test asserts:
 *   1. No `Math.random()` calls in `controllers/` (combat, magic,
 *      inventory) or `player/` (state, attributes, vitals, skills) —
 *      ALL gameplay decisions live there and must come from the server.
 *   2. Existing `Math.random()` usage is confined to the documented
 *      cosmetic categories (particle/weather/effect placement, ambient
 *      sound chance, animation-hook probability gates, crypto fallback).
 *
 * If a future commit adds `Math.random()` in a gameplay path, this test
 * fails with a precise filename + line callout. The error message
 * documents the rule so it's actionable without reading this file.
 *
 * Reference: ACE server is the authoritative source of truth for
 * combat/spell rolls — see reference/ACE/Source/ACE.Server/WorldObjects/
 * Player_Combat.cs, Player_Magic.cs, Creature_Magic.cs, etc.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO = resolve(__dirname, '..');

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      yield* walkTs(full);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      yield full;
    }
  }
}

function findRandomUses(dir: string): Array<{ file: string; line: number; text: string }> {
  const out: Array<{ file: string; line: number; text: string }> = [];
  for (const file of walkTs(dir)) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('Math.random')) {
        out.push({ file: file.replace(REPO + '/', ''), line: i + 1, text: lines[i].trim() });
      }
    }
  }
  return out;
}

describe('FAITHFUL.216 — server-authoritative gameplay (no client Math.random in decision paths)', () => {
  it('controllers/ contains no Math.random (combat, magic, inventory are server-driven)', () => {
    const uses = findRandomUses(resolve(REPO, 'packages/renderer/src/controllers'));
    expect(uses, `Math.random() in controllers — gameplay decisions must come from the server: ${JSON.stringify(uses, null, 2)}`).toEqual([]);
  });

  it('player/ contains no Math.random (player state mutations are server-driven)', () => {
    const uses = findRandomUses(resolve(REPO, 'packages/renderer/src/player'));
    expect(uses, `Math.random() in player/ — player-state changes must come from the server: ${JSON.stringify(uses, null, 2)}`).toEqual([]);
  });

  it('all package Math.random usage is in approved cosmetic / non-gameplay categories', () => {
    // Each approved bucket is annotated with the reason it's allowed.
    // Adding to this list requires a justification — adding to "gameplay
    // decision path" requires a redesign instead (server-authoritative).
    const APPROVED_DIRS: Array<{ dir: string; reason: string; textPattern?: RegExp }> = [
      { dir: 'packages/renderer/src/effects/',           reason: 'particle/weather/spell visual placement — cosmetic' },
      // GameUI itself is NOT approved — the chargen Random rolls live in ChargenRandomize.ts (CORE.17.k.b.b.a.f.d).
      { dir: 'packages/renderer/src/ui/ChargenRandomize.ts',
        reason: 'chargen Random button (DAT 0x2100003a element 0x100003cb, str 172831981) — the retail per-page rolls (CharGenState::Randomize* over the CRT rand() / Random::RollDice) run locally on pre-world state; the server validates the submitted CharacterCreateInfo, so this carries no gameplay authority' },
      { dir: 'packages/renderer/src/audio/',             reason: 'ambient sound chance — cosmetic' },
      { dir: 'packages/renderer/src/main.ts',            reason: 'thunder timing + animation hook probability — cosmetic' },
      { dir: 'packages/network/src/ConnectionData.ts',   reason: 'crypto.getRandomValues fallback (modern browsers never hit this)' },
      // No packages/shared/ bucket: the local server simulations (AI, combat,
      // magic, loot, crafting, death, NPC emotes) that rolled Math.random were
      // deleted (DEBT.shared-dead-server-logic) — shared/ has no RNG left.
      { dir: 'packages/dat-parser/src/file-types/SoundTable.ts', reason: 'picking weighted sound variant — cosmetic' },
      { dir: 'packages/dat-parser/src/file-types/PhysicsScript.ts', reason: 'animation hook probability (chickens cluck random) — cosmetic' },
      { dir: 'packages/shared/src/routines/vtankExpr.ts', reason: "VirindiTank meta randint[] — a player's own automation choice (e.g. which emote), not a game rule" },
      { dir: 'packages/renderer/src/agent/macro/combatPlan.ts', reason: "VirindiTank's Random damage type — the player's macro picking which element to cast, a player choice the server then resolves; not a game rule",
        textPattern: /Random damage type|input\.random \?\? Math\.random/ },
    ];
    const uses = findRandomUses(resolve(REPO, 'packages'));
    const violations = uses.filter(u => !APPROVED_DIRS.some(d =>
      u.file.includes(d.dir) && (!d.textPattern || d.textPattern.test(u.text))));
    expect(
      violations,
      `Math.random() outside the approved categories — this is a server-authoritativeness violation if the path drives gameplay:\n${JSON.stringify(violations, null, 2)}\n\nApproved categories:\n${APPROVED_DIRS.map(d => `  ${d.dir} — ${d.reason}`).join('\n')}`,
    ).toEqual([]);
  });

  it('the approved-categories list is non-trivial (not silently empty)', () => {
    // Sanity: if someone clears Math.random everywhere by accident, this test
    // would falsely pass. Pin at least one usage exists in each category so
    // we know the test is actually looking at the code.
    const allUses = findRandomUses(resolve(REPO, 'packages'));
    expect(allUses.length).toBeGreaterThanOrEqual(20);
    expect(allUses.some(u => u.file.includes('effects/'))).toBe(true);
    expect(allUses.some(u => u.file.includes('audio/'))).toBe(true);
    expect(allUses.some(u => u.file.includes('ConnectionData.ts'))).toBe(true);
  });
});
