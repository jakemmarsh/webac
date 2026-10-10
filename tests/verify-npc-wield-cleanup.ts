/**
 * FAITHFUL.276 — NPC wielded-item mesh detaches when the item is destroyed.
 *
 * Pre-fix when an NPC's wielded item was DestroyObject'd by the server
 * (creature death + corpse-transfer cleanup, dynamic weapon swap), the
 * wielded mesh stayed orphaned on the NPC at its holding location. UI.64
 * + UI.65 wired the ATTACH path; this entry wires the DETACH path.
 *
 * Implementation:
 *  - attachWieldedToCreature now stamps `wieldedGuid` + `wielderGuid` into
 *    the child mesh's `userData` so we can find it later.
 *  - detachWieldedItemFromAnyWielder(wieldedGuid) walks all server objects,
 *    finds the wielder via the userData stamp, removes the matching child
 *    mesh from its parent. Idempotent + silent no-op if not found.
 *  - onObjectDelete calls it BEFORE serverObjectManager.deleteObject so
 *    the ordering of the cleanup logs is coherent.
 *
 * This closes part of the Stop hook's "NPC equipped-item visuals" gap —
 * the inverse of the ParentEvent attach path was missing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN_TS = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('FAITHFUL.276 — NPC wielded-item detach on destroy', () => {
  it("attachWieldedToCreature stamps wieldedGuid (via attachHeldChild) + wielderGuid into userData", async () => {
    const block = MAIN_TS.match(/function attachWieldedToCreature[\s\S]+?\n  \}/)?.[0] ?? '';
    expect(block).toContain('itemMesh.userData.wielderGuid = creatureGuid');
    const THREE = await import('three');
    const { attachHeldChild } = await import('../packages/renderer/src/models/WieldedItemVisual.js');
    const root = new THREE.Group(); const part = new THREE.Group(); root.add(part);
    const mesh = new THREE.Group();
    attachHeldChild(root, part, mesh, 1, 0x80000199);
    expect(mesh.name).toBe('wielded_1');
    expect(mesh.userData.wieldedGuid).toBe(0x80000199);
    expect(mesh.parent).toBe(part);
  });

  it("detachWieldedItemFromAnyWielder function exists with correct signature", () => {
    // Returns the wielder's guid (aceCharGuid for the local player, null if
    // nothing found) so the FAITHFUL.419 chime can fire for our own unwield.
    expect(MAIN_TS).toMatch(/function detachWieldedItemFromAnyWielder\(wieldedGuid: number\): number \| null/);
  });

  it("detach helper walks all server objects + matches by wieldedGuid in userData", () => {
    const block = MAIN_TS.match(/function detachWieldedItemFromAnyWielder[\s\S]+?\n  \}/)?.[0] ?? '';
    expect(block).toContain('serverObjectManager.getAllObjects().values()');
    expect(block).toContain("obj.name?.startsWith('wielded_')");
    expect(block).toContain('obj.userData?.wieldedGuid === wieldedGuid');
  });

  it("detach helper removes matched meshes from their parents", () => {
    const block = MAIN_TS.match(/function detachWieldedItemFromAnyWielder[\s\S]+?\n  \}/)?.[0] ?? '';
    expect(block).toMatch(/m\.parent\?\.remove\(m\)/);
  });

  it("detach helper exits early after finding the first wielder (item can only be held by one)", () => {
    const block = MAIN_TS.match(/function detachWieldedItemFromAnyWielder[\s\S]+?\n  \}/)?.[0] ?? '';
    expect(block).toContain('return so.guid; // an item can only be held by one creature at a time');
  });

  it("onObjectDelete calls detachWieldedItemFromAnyWielder before deleteObject", () => {
    const block = MAIN_TS.match(/onObjectDelete: \(data\) => \{[\s\S]+?serverObjectManager!\.deleteObject\(data\.guid\);/)?.[0] ?? '';
    expect(block).toContain('detachWieldedItemFromAnyWielder(data.guid)');
    // Confirm the ordering: detach FIRST, deleteObject SECOND
    const detachIdx = block.indexOf('detachWieldedItemFromAnyWielder(data.guid)');
    const deleteIdx = block.indexOf('serverObjectManager!.deleteObject(data.guid)');
    expect(detachIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(detachIdx);
  });

  it("FAITHFUL.276 comments cite the gap being closed (orphaned mesh on creature death)", () => {
    expect(MAIN_TS).toMatch(/FAITHFUL\.276[\s\S]+?orphaned/);
    expect(MAIN_TS).toMatch(/FAITHFUL\.276[\s\S]+?(creature death|DestroyObject|despawn)/);
  });
});
