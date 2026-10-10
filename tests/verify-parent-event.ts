/**
 * ParentEvent wire-format regression test (UI.54).
 *
 * Anchored to ACE's `GameMessageParentEvent.cs:9-18`:
 *   creatureGuid (uint32) — wearer
 *   wieldedGuid  (uint32) — item being parented
 *   parentLocation (uint32)
 *   placement      (uint32)
 *   instanceSequence (uint32)
 *   positionSequence (uint32)
 *
 * UI.54 fixed an off-by-one-field misnaming where our parser was treating
 * the WEARER's GUID as the "child" and the ITEM's GUID as the "parent",
 * and was reading only 3 of the 6 uint32s — silently missing placement +
 * sequence numbers. Pinning the format to prevent regression.
 */
import { describe, it, expect } from 'vitest';
import type { ParentEventData } from '@ac/renderer/network/ServerMessageHandler.js';

describe('wieldLocationFromMask + bow/crossbow routing (UI.65)', () => {
  it('routes Bow/Crossbow MissileWeapons to LeftHand via weenieCombatStyles', () => {
    const fs = require('fs');
    const main = fs.readFileSync('packages/renderer/src/main.ts', 'utf8');

    // Helper takes optional wcid for combat-style lookup. Return type is
    // `ParentLocation` (FAITHFUL.101 enum extraction); was `number` pre-fix.
    expect(main).toContain('function wieldLocationFromMask(slot: number, wcid?: number): ParentLocation');
    // CombatStyle.Bow | CombatStyle.Crossbow — both bits trigger LeftHand=2.
    // FAITHFUL.72 moved this from bare hex (0x10|0x20) to symbolic enum.
    expect(main).toMatch(/cs\s*&\s*\(CombatStyle\.Bow\s*\|\s*CombatStyle\.Crossbow\)/);
    // weenieCombatStyles map exists and is fed from /weenie-combat-styles.json
    expect(main).toContain('const weenieCombatStyles = new Map<number, number>()');
    expect(main).toContain('/weenie-combat-styles.json');
  });

  it('passes weenieClassId at every wieldLocationFromMask call site', () => {
    const fs = require('fs');
    const main = fs.readFileSync('packages/renderer/src/main.ts', 'utf8');
    // Every call should include the wcid arg (no zero-arg or single-arg uses left).
    // Match wieldLocationFromMask(<expr>, <wcid expr>) form.
    const matches = main.match(/wieldLocationFromMask\(([^)]+)\)/g) || [];
    // Filter out the function definition itself
    const calls = matches.filter((m: string) => !m.includes('slot: number'));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // Each call should have a comma — i.e. be a 2-arg call passing wcid
      expect(call).toMatch(/,/);
    }
  });
});

describe('attachWieldedToCreature (UI.64 NPC extension)', () => {
  it('main.ts wires onParentEvent to dispatch creature-vs-player paths', () => {
    const fs = require('fs');
    const main = fs.readFileSync('packages/renderer/src/main.ts', 'utf8');

    // A call without a ParentEvent placement resolves the item's own
    // CreateObject Placement, else Resting — behavioral in
    // verify-wielded-item-objdesc.ts (heldItemPlacement / buildWieldedItemMesh).
    // Source for the creature-held mesh = the wielded item's own ServerObject
    // (setup + ObjDesc; RECON.wielded-item-objdesc)
    expect(main).toContain('const item = serverObjectManager?.getObject(wieldedGuid)');
    // Dispatch in onParentEvent: player → attachWieldedToPlayer, else → creature
    expect(main).toMatch(/if \(isMe\)\s*\{[\s\S]*?attachWieldedToPlayer[\s\S]*?\}\s*else\s*\{[\s\S]*?attachWieldedToCreature/);
    // BUG.parent-event-placement-dropped — the creature branch also threads data.placement.
    expect(main).toContain('attachWieldedToCreature(data.creatureGuid, data.wieldedGuid, data.parentLocation, data.placement)');
  });

  it('ServerObject carries wielderId + wieldedLocation for child-of-creature tracking', () => {
    const fs = require('fs');
    const som = fs.readFileSync('packages/renderer/src/world/ServerObjectManager.ts', 'utf8');
    // The fields exist on the interface
    expect(som).toMatch(/^\s*wielderId:\s*number;/m);
    expect(som).toMatch(/^\s*wieldedLocation:\s*number;/m);
    // Populated from CreateObjectData
    expect(som).toContain('wielderId: data.wielderId || 0');
    expect(som).toContain('wieldedLocation: data.currentWieldedLocation || 0');
  });
});

describe('attachWieldedToPlayer (UI.60 production-switch)', () => {
  it('main.ts wires onParentEvent to call attachWieldedToPlayer for the local player', async () => {
    const fs = require('fs');
    const main = fs.readFileSync('packages/renderer/src/main.ts', 'utf8');

    // The no-placement default is behavioral in verify-wielded-item-objdesc.ts.
    // onParentEvent invokes it with isMe gate, threading the wire-parsed placement through.
    expect(main).toMatch(/if \(isMe\) \{\s*attachWieldedToPlayer\(data\.wieldedGuid, data\.parentLocation, data\.placement\)/);
    // The held mesh is hung by attachHeldChild (behavioral: named
    // wielded_<location>, stamped with the item guid; replaces only an
    // earlier copy of the same item — BUG.held-items-same-location-evict).
    const THREE = await import('three');
    const { attachHeldChild } = await import('../packages/renderer/src/models/WieldedItemVisual.js');
    const root = new THREE.Group(); const part = new THREE.Group(); root.add(part);
    const mesh = new THREE.Group();
    attachHeldChild(root, part, mesh, 1, 0x80000199);
    expect(mesh.name).toBe('wielded_1');
    expect(mesh.userData.wieldedGuid).toBe(0x80000199);
    expect(mesh.parent).toBe(part);
    // (The held mesh's setup + ObjDesc source is covered behaviorally in
    // verify-wielded-item-objdesc.ts — RECON.wielded-item-objdesc.)
    // Mirrors SetupModelRenderer's AC-Z-up → Three-Y-up axis swap
    expect(main).toMatch(/itemMesh\.position\.set\(loc\.frame\.origin\.x, loc\.frame\.origin\.z, loc\.frame\.origin\.y\)/);
  });
});

describe('ParentEventData', () => {
  it('exposes the field names anchored to ACE GameMessageParentEvent.cs', () => {
    // Compile-time check: these field names exist on the type.
    const sample: ParentEventData = {
      creatureGuid: 0x50000002,
      wieldedGuid: 0x80000199,
      parentLocation: 1,         // ParentLocation.RightHand
      placement: 0,
      instanceSequence: 0,
      positionSequence: 0,
    };
    expect(sample.creatureGuid).toBe(0x50000002);
    expect(sample.wieldedGuid).toBe(0x80000199);
    expect(sample.parentLocation).toBe(1);
    expect(sample.placement).toBe(0);
    expect(sample.instanceSequence).toBe(0);
    expect(sample.positionSequence).toBe(0);
  });

  it('has no field named "guid" or "parentGuid" — those were the misnamed pre-UI.54 fields', () => {
    // Source-grep regression: the pre-fix names should not appear in the
    // public ParentEventData interface, otherwise downstream code reverts
    // to the wearer/item swap.
    const fs = require('fs');
    const handlerSrc = fs.readFileSync(
      'packages/renderer/src/network/ServerMessageHandler.ts', 'utf8'
    );
    // Find the ParentEventData interface block
    const m = handlerSrc.match(/interface ParentEventData \{[\s\S]*?\}/);
    expect(m).toBeTruthy();
    const interfaceBlock = m![0];
    // Old names must be gone
    expect(interfaceBlock).not.toMatch(/^\s*guid\s*:/m);
    expect(interfaceBlock).not.toMatch(/^\s*parentGuid\s*:/m);
    // New names must be present
    expect(interfaceBlock).toMatch(/creatureGuid\s*:/);
    expect(interfaceBlock).toMatch(/wieldedGuid\s*:/);
  });
});
