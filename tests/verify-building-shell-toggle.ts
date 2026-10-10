/**
 * Unit tests for the updateBuildingShells logic from UI.33 — XZ-footprint
 * containment with enter/exit hysteresis. Complements the UI.32 ServerObject
 * culling by hiding STATIC interior geometry (walls/furniture/floors) when
 * viewed from outside.
 *
 * Keeps the same test style as UI.32: inline the rule against a minimal
 * shape rather than instantiating the full main.ts render loop.
 */
import { describe, it, expect } from 'vitest';

interface MinimalBox {
  min: { x: number; z: number };
  max: { x: number; z: number };
}

interface MinimalShell {
  interiors: Array<{ visible: boolean }>;
  bbox: MinimalBox;
  enterBbox: MinimalBox;
  wasInside: boolean;
}

function updateBuildingShells(
  shells: MinimalShell[],
  playerX: number,
  playerZ: number,
): void {
  for (const shell of shells) {
    // Strict bbox on entry, loose enterBbox on exit — hysteresis.
    const box = shell.wasInside ? shell.enterBbox : shell.bbox;
    const inside =
      playerX >= box.min.x && playerX <= box.max.x &&
      playerZ >= box.min.z && playerZ <= box.max.z;
    if (inside !== shell.wasInside) {
      for (const interior of shell.interiors) interior.visible = inside;
      shell.wasInside = inside;
    }
  }
}

function makeShell(bbox: MinimalBox, enterBbox: MinimalBox = bbox): MinimalShell {
  return {
    interiors: [{ visible: false }, { visible: false }],
    bbox,
    enterBbox,
    wasInside: false,
  };
}

describe('updateBuildingShells — XZ-footprint containment with hysteresis', () => {
  it('shows interiors when player walks inside enterBbox', () => {
    const shell = makeShell(
      { min: { x: 0, z: 0 }, max: { x: 10, z: 10 } },
      { min: { x: -1.5, z: -1.5 }, max: { x: 11.5, z: 11.5 } },
    );
    updateBuildingShells([shell], 5, 5);
    expect(shell.wasInside).toBe(true);
    expect(shell.interiors.every(i => i.visible)).toBe(true);
  });

  it('keeps interiors hidden when player is far outside', () => {
    const shell = makeShell({ min: { x: 0, z: 0 }, max: { x: 10, z: 10 } });
    updateBuildingShells([shell], 50, 50);
    expect(shell.wasInside).toBe(false);
    expect(shell.interiors.every(i => !i.visible)).toBe(true);
  });

  it('hides interiors on exit through the tight bbox', () => {
    const shell = makeShell(
      { min: { x: 0, z: 0 }, max: { x: 10, z: 10 } },
      { min: { x: -1.5, z: -1.5 }, max: { x: 11.5, z: 11.5 } },
    );
    shell.wasInside = true;
    for (const i of shell.interiors) i.visible = true;
    // Move outside both boxes
    updateBuildingShells([shell], 20, 20);
    expect(shell.wasInside).toBe(false);
    expect(shell.interiors.every(i => !i.visible)).toBe(true);
  });

  it('provides hysteresis: player in the band between bbox and enterBbox stays "inside" if they were inside', () => {
    const shell = makeShell(
      { min: { x: 0, z: 0 }, max: { x: 10, z: 10 } },
      { min: { x: -1.5, z: -1.5 }, max: { x: 11.5, z: 11.5 } },
    );
    // Enter the building.
    updateBuildingShells([shell], 5, 5);
    expect(shell.wasInside).toBe(true);
    // Step into the hysteresis band (outside tight bbox but inside enterBbox)
    updateBuildingShells([shell], 10.8, 5);
    expect(shell.wasInside).toBe(true);
    expect(shell.interiors.every(i => i.visible)).toBe(true);
  });

  it('does NOT enter from the hysteresis band — requires crossing the tight bbox', () => {
    const shell = makeShell(
      { min: { x: 0, z: 0 }, max: { x: 10, z: 10 } },
      { min: { x: -1.5, z: -1.5 }, max: { x: 11.5, z: 11.5 } },
    );
    // Standing just outside the tight bbox but inside enterBbox while wasInside=false
    // should NOT count as inside — you have to cross the strict bbox to enter.
    // Prevents false positives at the edge of the building.
    updateBuildingShells([shell], 10.8, 5);
    expect(shell.wasInside).toBe(false);
  });

  it('handles multiple buildings independently', () => {
    const house = makeShell({ min: { x: 0, z: 0 }, max: { x: 10, z: 10 } });
    const shop = makeShell({ min: { x: 20, z: 20 }, max: { x: 30, z: 30 } });
    updateBuildingShells([house, shop], 5, 5);
    expect(house.wasInside).toBe(true);
    expect(shop.wasInside).toBe(false);
  });

  it('ignores Y — building is considered "entered" regardless of player altitude', () => {
    const shell = makeShell({ min: { x: 0, z: 0 }, max: { x: 10, z: 10 } });
    // updateBuildingShells takes (x, z) only — Y is intentionally not a parameter.
    // Player on a balcony or underground but XZ-inside still triggers "inside".
    updateBuildingShells([shell], 5, 5);
    expect(shell.wasInside).toBe(true);
  });

  it('is idempotent — no state change on subsequent calls with same position', () => {
    const shell = makeShell({ min: { x: 0, z: 0 }, max: { x: 10, z: 10 } });
    updateBuildingShells([shell], 5, 5);
    const snapshot = shell.interiors.map(i => i.visible);
    updateBuildingShells([shell], 5, 5);
    expect(shell.interiors.map(i => i.visible)).toEqual(snapshot);
  });

  it('handles empty shells array without crashing', () => {
    expect(() => updateBuildingShells([], 0, 0)).not.toThrow();
  });

  it('handles a shell with no interiors (empty building) gracefully', () => {
    const shell: MinimalShell = {
      interiors: [],
      bbox: { min: { x: 0, z: 0 }, max: { x: 10, z: 10 } },
      enterBbox: { min: { x: 0, z: 0 }, max: { x: 10, z: 10 } },
      wasInside: false,
    };
    updateBuildingShells([shell], 5, 5);
    expect(shell.wasInside).toBe(true);
  });
});
