/**
 * BUG.uihidden-never-read — obj.uiHidden was stored (PropertyBool.UiHidden
 * mirror, FAITHFUL.364) but never read: UI-hidden objects (empty/hidden
 * house hooks, etc.) stayed hoverable/selectable and kept their radar dot.
 *
 * Ground truth (decompiled EoL retail client, build ac1_sep13):
 *  - UIElement_SmartBoxWrapper::RecvNotice_SmartBoxObjectFound @ 004e5ad0
 *    opens with: found object's PublicWeenieDesc._bitfield sign-bit test
 *    `(char)bitfield < 0` (bit 0x80 = BF_UI_HIDDEN, matches ACE
 *    ObjectDescriptionFlag.UiHidden = 0x80) → SmartBox::set_found_object(0,
 *    -1) and return. The mouse-over pipeline treats a UI-hidden object as
 *    NOTHING found — no hover label, no cursor change, no select/use — and
 *    does NOT fall through to the object behind it.
 *  - gmRadarUI::AddObject @ 004d9a00 refuses objects with the same bit
 *    (`-1 < (char)bitfield` gate); GetBlipColor @ 004d76f0 and
 *    GetBlipShape @ 004d7b60 bail likewise → no radar blip.
 *  - ACCWeenieObject::OnStatUpdated @ 0058c680 case 0x18 (= PropertyBool
 *    24 UiHidden) routes live bool updates into SetUIHidden @ 0058bd60,
 *    which sets/clears bitfield 0x80 — so the flag is live, not
 *    create-only.
 *  - ACE server side: WorldObject_Networking.cs:867 merges the UiHidden
 *    bool into the wire ObjectDescriptionFlag; Hook.cs:121-130/245-255
 *    sets UiHidden=true on empty hooks and hidden house hooks.
 *
 * Fix:
 *  - ServerObject.uiHidden is seeded from CreateObject's
 *    ObjectDescriptionFlag 0x80 (previously only the live PropertyBool
 *    broadcast wrote it, so objects that ARRIVED hidden were never marked).
 *  - getObjectAtScreenPos returns null when the closest hit is uiHidden
 *    (retail semantics: nothing found, no fall-through).
 *  - ServerObjectManager.radarDotEligible culls uiHidden objects; the
 *    main-loop radar populate routes through it.
 */
import { describe, it, expect } from 'vitest';
import { ObjectDescriptionFlag, RadarBehavior } from '@ac/shared';
import type { CreateObjectData } from '@ac/network';
import {
  ServerObjectManager,
  type ServerObject,
} from '../packages/renderer/src/world/ServerObjectManager.js';

function makeSOM(): ServerObjectManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
}

function makeCreateData(guid: number, objectDescFlags: number): CreateObjectData {
  return {
    guid, name: 'Hook', weenieClassId: 2472, itemType: 0x8000 /* Misc */,
    position: { landblock: 0x00000001, x: 0, y: 0, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 } /* a world object has a cell (HandleCreateObject enter_world) */, setupId: 0x02000001, motionTableId: 0, iconId: 0,
    physicsState: 0, objectDescFlags, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [],
    containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0,
    validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0,
    uiEffects: 0, usable: 0, useRadius: 0.6,
    velocityX: 0, velocityY: 0, velocityZ: 0, soundTableId: 0,
    objScale: 1.0, translucency: 0, defaultScript: 0, defaultScriptIntensity: 1.0,
    iconOverlayId: 0, iconUnderlayId: 0, cooldownId: 0, cooldownDuration: 0,
  };
}

function fakeMesh(): object {
  return {
    visible: true,
    name: '',
    position: { set: () => {}, copy: () => {}, clone: () => ({}) },
    quaternion: { set: () => {}, copy: () => {} },
    scale: { setScalar: () => {}, x: 1 },
    traverse: () => {},
  };
}

/** A raycaster stub whose intersectObject reports a fixed hit distance per
 *  mesh (executes the real getObjectAtScreenPos closest-hit logic). */
function fakeRaycaster(distances: Map<object, number>): { intersectObject: (m: object, r: boolean) => { distance: number }[] } {
  return {
    intersectObject: (mesh: object) => {
      const d = distances.get(mesh);
      return d === undefined ? [] : [{ distance: d }];
    },
  };
}

describe('BUG.uihidden-never-read — create-time seeding', () => {
  it('an object arriving with ObjectDescriptionFlag.UiHidden (0x80) is marked uiHidden', () => {
    const som = makeSOM();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).buildMesh = () => fakeMesh();
    const obj = som.createObject(makeCreateData(0x80000001, ObjectDescriptionFlag.UiHidden));
    expect(obj?.uiHidden).toBe(true);
  });

  it('an object arriving without the flag is not uiHidden', () => {
    const som = makeSOM();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).buildMesh = () => fakeMesh();
    const obj = som.createObject(makeCreateData(0x80000002, ObjectDescriptionFlag.Attackable));
    expect(obj?.uiHidden).toBe(false);
  });
});

describe('BUG.uihidden-never-read — getObjectAtScreenPos (retail 004e5ad0 guard)', () => {
  function addObj(som: ServerObjectManager, guid: number, uiHidden: boolean): ServerObject {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).buildMesh = () => fakeMesh();
    const obj = som.createObject(makeCreateData(guid, uiHidden ? ObjectDescriptionFlag.UiHidden : 0))!;
    return obj;
  }

  it('a uiHidden closest hit yields NOTHING found (null), not the object behind it', () => {
    const som = makeSOM();
    const hidden = addObj(som, 1, true);
    const behind = addObj(som, 2, false);
    const ray = fakeRaycaster(new Map([[hidden.mesh as object, 1.0], [behind.mesh as object, 5.0]]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(som.getObjectAtScreenPos(ray as any)).toBeNull();
  });

  it('a normal closest hit is still returned', () => {
    const som = makeSOM();
    const front = addObj(som, 1, false);
    const behind = addObj(som, 2, false);
    const ray = fakeRaycaster(new Map([[front.mesh as object, 1.0], [behind.mesh as object, 5.0]]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(som.getObjectAtScreenPos(ray as any)?.guid).toBe(1);
  });

  it('a live PropertyBool.UiHidden=false update makes the object pickable again (OnStatUpdated case 0x18)', () => {
    const som = makeSOM();
    const obj = addObj(som, 1, true);
    obj.uiHidden = false; // what the onPublicUpdatePropertyBool handler writes
    const ray = fakeRaycaster(new Map([[obj.mesh as object, 1.0]]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(som.getObjectAtScreenPos(ray as any)?.guid).toBe(1);
  });
});

describe('BUG.uihidden-never-read — radarDotEligible (retail gmRadarUI::AddObject guard)', () => {
  const base = { radarBehavior: RadarBehavior.ShowAlways, uiHidden: false };

  it('culls uiHidden objects', () => {
    expect(ServerObjectManager.radarDotEligible({ ...base, uiHidden: true })).toBe(false);
  });

  it('keeps a visible ShowAlways dot', () => {
    expect(ServerObjectManager.radarDotEligible(base)).toBe(true);
  });

  it('culls ShowNever and Undefined (InqShowableOnRadar @ 0058c250 accepts only 2/3/4)', () => {
    expect(ServerObjectManager.radarDotEligible({ ...base, radarBehavior: RadarBehavior.ShowNever })).toBe(false);
    expect(ServerObjectManager.radarDotEligible({ ...base, radarBehavior: RadarBehavior.Undefined })).toBe(false);
  });
});
