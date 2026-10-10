/**
 * FAITHFUL.345 — PublicUpdateInstanceID(Wielder=Invalid) detaches the
 *  visual wielded-item mesh.
 *
 * ACE emits `GameMessagePublicUpdateInstanceID` with
 * `PropertyInstanceId.Wielder = ObjectGuid.Invalid (=0)` whenever an
 * item leaves a wielder's hand. The call sites:
 *
 *   - `Player_Inventory.cs:303,402` — player unwields a weapon (drop or
 *     swap)
 *   - `Creature_Death.cs:676` — creature dies, dropping a wielded item
 *   - `AdminCommands.cs:2875-2876` — admin force-clears equipment
 *
 * Pre-FAITHFUL.345 the consumer at `main.ts onPublicUpdatePropertyInstanceID`
 * only console.log'd these. Result: the wielded mesh stayed attached to
 * the wielder's hand visually until the wielder left + re-entered
 * visual range (which forces a fresh CreateObject without the wielder
 * relationship). Visible bug: ghost weapons hovering over recently-
 * unwielding NPCs / corpses.
 *
 * Sibling FAITHFUL.344 wired RadarBlipColor / PlayerKillerStatus /
 * UiEffects PublicUpdatePropertyInt updates through the same
 * "diagnostic-only → apply state" pattern.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('PublicUpdateInstanceID(Wielder=0) detaches wielded mesh (FAITHFUL.345)', () => {
  it('handler branches on PropertyInstanceId.Wielder + val === 0', () => {
    const block = MAIN.match(/onPublicUpdatePropertyInstanceID:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toMatch(/data\.key === PropertyInstanceId\.Wielder/);
    expect(block).toMatch(/val === 0/);
  });

  it('handler calls detachWieldedItemFromAnyWielder(data.guid) on Wielder=0', () => {
    const block = MAIN.match(/onPublicUpdatePropertyInstanceID:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toContain('detachWieldedItemFromAnyWielder(data.guid)');
  });

  it('handler also clears ServerObject.wielderId + wieldedLocation', () => {
    const block = MAIN.match(/onPublicUpdatePropertyInstanceID:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toMatch(/obj\.wielderId\s*=\s*0/);
    expect(block).toMatch(/obj\.wieldedLocation\s*=\s*0/);
  });

  it('cites all three ACE source emit sites + the visible bug', () => {
    const block = MAIN.match(/onPublicUpdatePropertyInstanceID:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toContain('Player_Inventory');
    expect(block).toContain('Creature_Death');
    expect(block).toContain('AdminCommands');
    expect(block).toMatch(/ghost|stale|attach|mesh/i);
  });

  it('still logs the diagnostic line (no regression)', () => {
    const block = MAIN.match(/onPublicUpdatePropertyInstanceID:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toMatch(/console\.log\(`\[Property\] PublicIID/);
  });

  it('imports PropertyInstanceId from @ac/shared', () => {
    expect(MAIN).toMatch(/PropertyInstanceId[\s\S]*?from '@ac\/shared'/);
  });
});

describe('local-player unwield detaches the playerModel mesh (paperdoll-rebuild follow-up)', () => {
  // ACE sends NO ObjectDelete for the player's own unwield (the item stays
  // in our inventory) — the Wielder=0 broadcast is the only detach signal.
  // detachWieldedItemFromAnyWielder must therefore also search playerModel,
  // which serverObjectManager never tracks.
  it('the held mesh is stamped with userData.wieldedGuid (guid-match detach signal)', async () => {
    // attachWieldedToPlayer / attachWieldedToCreature hang the mesh through
    // attachHeldChild (models/WieldedItemVisual.ts), which does the stamping.
    const THREE = await import('three');
    const { attachHeldChild } = await import('../packages/renderer/src/models/WieldedItemVisual.js');
    const root = new THREE.Group(); const part = new THREE.Group(); root.add(part);
    const mesh = new THREE.Group();
    attachHeldChild(root, part, mesh, 1, 0x80000199);
    expect(mesh.name).toBe('wielded_1');
    expect(mesh.userData.wieldedGuid).toBe(0x80000199);
    expect(mesh.parent).toBe(part);
  });

  it('detachWieldedItemFromAnyWielder searches playerModel before server objects', () => {
    const block = MAIN.match(/function detachWieldedItemFromAnyWielder[\s\S]+?^  \}/m)?.[0] ?? '';
    expect(block).toMatch(/if \(playerModel\) \{/);
    expect(block).toMatch(/playerModel\.traverse/);
    // player branch comes before the serverObjectManager walk
    expect(block.indexOf('playerModel.traverse')).toBeLessThan(block.indexOf('serverObjectManager.getAllObjects'));
  });

  it('detach reports the wielder; the handler plays no local unwield chime (BUG.duplicate-local-sounds: ACE sends UnwieldObject)', () => {
    const block = MAIN.match(/function detachWieldedItemFromAnyWielder[\s\S]+?^  \}/m)?.[0] ?? '';
    expect(block).toMatch(/\): number \| null \{/);
    expect(block).toMatch(/return aceCharGuid;/);
    expect(block).toMatch(/return so\.guid;/);
    const handler = MAIN.match(/onPublicUpdatePropertyInstanceID:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(handler).toMatch(/detachWieldedItemFromAnyWielder\(data\.guid\)/);
    expect(handler).not.toMatch(/playUnwieldSound/);
  });
});
