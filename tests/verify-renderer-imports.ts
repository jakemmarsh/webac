/**
 * FAITHFUL.190 — Renderer entry-point import surface sanity.
 *
 * Mid-session pass: catches regressions where a DAT loader, hook player,
 * or new parser is removed/renamed but main.ts still imports it. Without
 * this guard, missed import updates surface only at `npm run dev` time
 * via the Vite module-graph error overlay.
 *
 * This test reads main.ts's import list and asserts every symbol we
 * documented in progress.md FAITHFUL.173-189 still resolves to an
 * exported symbol from its source module. Build-time TypeScript would
 * catch type-level missing exports, but not symbol-level removals that
 * happen to retain the type name elsewhere.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN_SRC = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('renderer main.ts — DAT/runtime symbol imports', () => {
  // FAITHFUL.173's Scene-parser / SceneryGenerator import pins were retired
  // when PERF.5 moved scenery out of main.ts into world/LandblockScenery.ts:
  // verify-perf3-perf5-landblock-content.ts asserts (real DATs) that it builds
  // exactly SceneryGenerator's placements, and verify-landblock-object-
  // streamer.ts that the streamer pools + retires them per block.
  it('imports the FAITHFUL.174 ChatPoseTable', () => {
    expect(MAIN_SRC).toMatch(/ChatPoseTable.*from .@ac\/dat-parser\/file-types\/ChatPoseTable\.js./);
  });
  it('imports the FAITHFUL.175 PhysicsScript[Table] parsers', () => {
    expect(MAIN_SRC).toMatch(/PhysicsScript, PhysicsScriptTable.*from .@ac\/dat-parser\/file-types\/PhysicsScript\.js./);
  });
  it('imports the FAITHFUL.176 char-name tables', () => {
    expect(MAIN_SRC).toMatch(/NameFilterTable.*from .@ac\/dat-parser\/file-types\/NameFilterTable\.js./);
    expect(MAIN_SRC).toMatch(/TabooTable.*from .@ac\/dat-parser\/file-types\/TabooTable\.js./);
  });
  it('imports the FAITHFUL.177 PhysicsScriptPlayer runtime', () => {
    expect(MAIN_SRC).toMatch(/PhysicsScriptPlayer.*from .\.\/effects\/PhysicsScriptPlayer\.js./);
  });
  it('imports the FAITHFUL.177 ParticleEmitterInfo for emitter cache', () => {
    expect(MAIN_SRC).toMatch(/ParticleEmitterInfo.*from .@ac\/dat-parser\/file-types\/ParticleEmitterInfo\.js./);
  });
});

describe('renderer main.ts — runtime wiring sanity', () => {
  it('PhysicsScriptPlayer is constructed with all 6 deps', () => {
    // Extract the constructor argument block (multi-line) and assert each dep
    // name appears inside it. Use a non-trivial regex that handles nested
    // braces inside arrow-function dep values.
    const ctorIdx = MAIN_SRC.indexOf('new PhysicsScriptPlayer({');
    expect(ctorIdx).toBeGreaterThan(0);
    // The whole argument object, brace-matched (a fixed character window broke
    // when the streamed-DAT emitterPending dep was added, 2026-10-06).
    const open = ctorIdx + 'new PhysicsScriptPlayer('.length;
    let depth = 0, end = open;
    for (; end < MAIN_SRC.length; end++) {
      if (MAIN_SRC[end] === '{') depth++;
      else if (MAIN_SRC[end] === '}' && --depth === 0) break;
    }
    const ctorBlock = MAIN_SRC.slice(ctorIdx, end + 1);
    expect(ctorBlock).toContain('emitterPending');
    for (const dep of ['spellEffects', 'soundPlayer', 'loadEmitterInfo', 'getListenerPos', 'loadScript', 'resolveDefaultScript']) {
      expect(ctorBlock).toContain(dep);
    }
  });
  it('PhysicsScriptPlayer.update is called from the render loop', () => {
    expect(MAIN_SRC).toContain('physicsScriptPlayer.update(dt);');
  });
  it('GameUI name-validation tables wired from main.ts', () => {
    expect(MAIN_SRC).toContain('gameUI.setNameValidationTables(');
  });
  it('FAITHFUL.180 — obj.motionTableId is consulted first for player anim', () => {
    expect(MAIN_SRC).toMatch(/let motionTableId = obj\.motionTableId \|\| setup\?\.defaultMotionTable/);
  });
  // FAITHFUL.181's "auto-attack uses PowerLevel × refillMod" source-pin was
  // retired with the client refill re-send (BUG.combat-attack-charge-build.b):
  // the server times and swings the repeat itself (ACE Player_Melee.cs:365-
  // 382 NextRefillTime); verify-attack-charge-build.ts covers the client half.
  // FAITHFUL.199's "scenery placed at exact terrain Y (no baseLift hack)"
  // source-pin was converted to a behavioral test when CORE.14 moved scenery
  // rendering into SceneryInstancer: verify-scenery-instancer.ts asserts the
  // instance world matrix translation Y equals p.z exactly (see
  // 'FAITHFUL.199 — placement Y is exact ground z, no baseLift').
  // FAITHFUL.199's "scenery registers cylinder collision" source-pin was
  // converted to behavioural tests when BUG.movement-pinned-south-holtburg-
  // slope moved scenery/static collision into world/ObjectCollision.ts (ACE
  // FindObjCollisions: part BSPs, else CylSpheres, else Spheres, else none):
  // verify-bug-scenery-collision-ace-rules.ts drives addObjectCollision into
  // a real DungeonCollision and asserts what blocks and what doesn't.
});
