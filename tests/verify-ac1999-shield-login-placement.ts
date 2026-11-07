/**
 * webac#26 (BUG.shield-rotated-at-login): on the AC1999 server a wielded shield sat low, inside
 * the forearm, on every login until it was re-equipped.
 *
 * Server: the equip sends 0xF749 placement Shield (6) (Monster.cpp GetEquipPlacementAndHoldLocation,
 * Container.cpp Container_EquipItem) and persists it. At login SetupWeenie restores 6 into the part
 * array, every 1999 shield setup lacks frame 6, so CPartArray::SetPlacementFrame falls back to frame 0
 * with id 0, and BuildPhysicsDesc1999 (ObjectMsgs.cpp) omits ANIMFRAME because the id is 0. The
 * ObjectCreate carries PARENT (wielder, Shield 3) and no ANIMFRAME, no MOVEMENT.
 *
 * Client: retail CPhysicsObj::set_description (1999 @ 0x0043b510, EoL @ 0x00514f40) calls
 * SetPlacementFrame(animframe_id) when there is no Movement, and the PhysicsDesc ctor zeroes
 * animframe_id: the shield poses at frame 0, the same frame placement 6 falls back to on re-equip.
 * Ours fell back to Resting (0x65), whose -90 degree turn about X is the "inside the arm" pose.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerObjects1999 } from '../packages/network/src/era1999/codecs/Objects1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import {
  BinaryReader, deserializeMessage, parseCreateObjectFromReader, type CreateObjectData,
} from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildInventoryEntry, type InventoryEntrySource } from '../packages/renderer/src/network/objectSubjectRouting.js';
import {
  buildWieldedItemMesh, createObjectPlacement, heldItemPlacement, itemVisualDescOf, type WieldedMeshBuilder,
} from '../packages/renderer/src/models/WieldedItemVisual.js';
import { placementFrameOf, PLACEMENT_RESTING } from '../packages/renderer/src/models/SetupModelGroup.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { SetupModel } from '../packages/dat-parser/src/file-types/SetupModel.js';
import { DAT_PATHS, DAT_SETS_DIR, openDat } from './_harness/dat.js';
import * as THREE from 'three';

const PLAYER = 0x50000003;
const BUCKLER = 0x80000101;
const DAGGER = 0x80000102;
const BUCKLER_SETUP = 0x02000162; // wcid 44 Buckler (AC1999 world DB)
const PARENT_SHIELD = 3, PARENT_RIGHT_HAND = 1;
const PLACEMENT_SHIELD = 6, PLACEMENT_RIGHT_HAND_COMBAT = 1;

/**
 * A wielded item's 1999 ObjectCreate as BuildPhysicsDesc1999 + OldPublicWeenieDesc::Pack lay it out:
 * PARENT instead of POSITION, ANIMFRAME only when the part array's placement id is non-zero.
 */
function wieldedCreate1999(o: { guid: number; setup: number; parentLoc: number; animFrame?: number; name: string; validLoc: number }): Uint8Array {
  const w = new Writer1999().u32(0xf745).u32(o.guid);
  w.u8(0x11).u8(0).u8(0).u8(0).align4(); // ObjDesc, nothing changed
  const flags = 0x1 /* CSETUP */ | 0x20 /* PARENT */ | 0x800 /* STABLE */ | 0x1000 /* PETABLE */ | (o.animFrame ? 0x20000 : 0);
  w.u32(flags).u32(0x414);
  if (o.animFrame) w.u32(o.animFrame);
  w.u32(0x20000014).u32(0x3400002b).u32(o.setup).u32(PLAYER).u32(o.parentLoc);
  for (let i = 0; i < 9; i++) w.u16(1);
  w.align4();
  // PublicWeenieDesc: combatUse (0x200), wielder (0x8000), validLocations (0x10000), location (0x20000).
  w.u32(0x200 | 0x8000 | 0x10000 | 0x20000).acString(o.name).u16(44).u16(0x1423).u32(2).u32(0x10);
  w.u8(4).u32(PLAYER).u32(o.validLoc).u32(o.validLoc);
  return w.align4().toBytes();
}

function translate(bytes: Uint8Array): Uint8Array {
  const c = emptyCodecs();
  registerObjects1999(c);
  const out = new Adapter1999(c, { account: 'acjs', log: () => {} }).inbound(bytes, 3);
  expect(out).toHaveLength(1);
  return out[0];
}

function parseCreate(eol: Uint8Array): CreateObjectData {
  const m = deserializeMessage(eol);
  if (m.type !== 'direct') throw new Error('not direct');
  const r = new BinaryReader(m.payload);
  const obj = parseCreateObjectFromReader(r);
  expect(r.position).toBe(m.payload.length);
  return obj;
}

function recordingBuilder() {
  const calls: number[] = [];
  const builder: WieldedMeshBuilder = {
    createSetupMeshWithOverrides: (_setup, placement) => { calls.push(placement!); return new THREE.Group(); },
  };
  return { builder, calls };
}

describe('webac#26: a 1999 shield restored at login poses as it does after a re-equip', () => {
  const buckler = parseCreate(translate(wieldedCreate1999({
    guid: BUCKLER, setup: BUCKLER_SETUP, parentLoc: PARENT_SHIELD, name: 'Buckler', validLoc: 0x200000,
  })));

  it('the login ObjectCreate parents it at Shield with no AnimationFrame and no Movement', () => {
    expect(buckler.setupId).toBe(BUCKLER_SETUP);
    expect(buckler.parentLocation).toBe(PARENT_SHIELD);
    expect(buckler.wielderId).toBe(PLAYER);
    expect(buckler.placement).toBeUndefined();
    expect(buckler.initialMotion).toBeUndefined();
  });

  it('its held mesh is built at Default (0), as set_description leaves it, not Resting', () => {
    const entry = buildInventoryEntry(buckler as unknown as InventoryEntrySource);
    expect(entry.visualDesc?.placement).toBe(0);
    const { builder, calls } = recordingBuilder();
    buildWieldedItemMesh(builder, entry.visualDesc!, undefined, () => null); // the login attach (CreateObject)
    expect(calls).toEqual([0]);
  });

  it('the re-equip ParentEvent still wins with its own placement (Shield 6)', () => {
    let parent: { placement: number; parentLocation: number } | undefined;
    const h = new ServerMessageHandler();
    h.setHandlers({ onParentEvent: (d: { placement: number; parentLocation: number }) => { parent = d; } });
    const c = emptyCodecs();
    registerObjects1999(c);
    const a = new Adapter1999(c, { account: 'acjs', log: () => {} });
    for (const m of a.inbound(new Writer1999().u32(0xf749).u32(PLAYER).u32(BUCKLER).u32(PARENT_SHIELD).u32(PLACEMENT_SHIELD).u16(1).u16(2).toBytes(), 3)) {
      const d = deserializeMessage(m);
      if (d.type === 'direct') h.handleMessage(d);
    }
    expect(parent).toMatchObject({ parentLocation: PARENT_SHIELD, placement: PLACEMENT_SHIELD });
    const { builder, calls } = recordingBuilder();
    buildWieldedItemMesh(builder, buildInventoryEntry(buckler as unknown as InventoryEntrySource).visualDesc!, parent!.placement, () => null);
    expect(calls).toEqual([PLACEMENT_SHIELD]);
  });

  it('a 1999 dagger restored at login keeps the ANIMFRAME the server sent (RightHandCombat)', () => {
    const dagger = parseCreate(translate(wieldedCreate1999({
      guid: DAGGER, setup: 0x02000184, parentLoc: PARENT_RIGHT_HAND, animFrame: PLACEMENT_RIGHT_HAND_COMBAT, name: "Gertarh's Dagger", validLoc: 0x100000,
    })));
    expect(dagger.placement).toBe(PLACEMENT_RIGHT_HAND_COMBAT);
    expect(buildInventoryEntry(dagger as unknown as InventoryEntrySource).visualDesc?.placement).toBe(PLACEMENT_RIGHT_HAND_COMBAT);
  });
});

describe('createObjectPlacement: the placement a CreateObject leaves (every era)', () => {
  it('AnimationFrame on the wire wins (ACE writes it for every wielded item: EoL / Dark Majesty unchanged)', () => {
    expect(createObjectPlacement({ placement: PLACEMENT_SHIELD })).toBe(PLACEMENT_SHIELD);
    expect(createObjectPlacement({ placement: PLACEMENT_RIGHT_HAND_COMBAT })).toBe(PLACEMENT_RIGHT_HAND_COMBAT);
    expect(createObjectPlacement({ placement: 0x65, initialMotion: {} })).toBe(0x65);
    expect(itemVisualDescOf({ setupId: BUCKLER_SETUP, placement: PLACEMENT_SHIELD })?.placement).toBe(PLACEMENT_SHIELD);
  });

  it('neither AnimationFrame nor Movement: Default (0)', () => {
    expect(createObjectPlacement({})).toBe(0);
    expect(heldItemPlacement(undefined, itemVisualDescOf({ setupId: BUCKLER_SETUP })!)).toBe(0);
  });

  it('Movement without AnimationFrame: the Resting frame InitObjectEnd set stays', () => {
    expect(createObjectPlacement({ initialMotion: { stance: 0x3d } })).toBeUndefined();
    expect(heldItemPlacement(undefined, itemVisualDescOf({ setupId: BUCKLER_SETUP, initialMotion: {} })!)).toBe(PLACEMENT_RESTING);
  });
});

const AC1999_PORTAL = resolve(DAT_SETS_DIR, 'ac1999-retail', 'portal.dat');

describe.skipIf(!existsSync(AC1999_PORTAL) || !existsSync(DAT_PATHS.portal))('the buckler setup in the DATs', () => {
  let s1999: SetupModel;
  let sEol: SetupModel;
  beforeAll(() => {
    s1999 = new SetupModel(new DatReader(openDat(AC1999_PORTAL).getFileData(BUCKLER_SETUP)!));
    sEol = new SetupModel(new DatReader(openDat(DAT_PATHS.portal).getFileData(BUCKLER_SETUP)!));
  });

  it('has no Shield (6) frame in either era, so the equip falls back to frame 0', () => {
    for (const s of [s1999, sEol]) {
      expect(s.placementFrames.has(PLACEMENT_SHIELD)).toBe(false);
      expect(placementFrameOf(s, PLACEMENT_SHIELD)).toBe(s.placementFrames.get(0));
    }
  });

  it('login (0) and re-equip (6) now pick the same frame; Resting is the turned one the report shows', () => {
    expect(placementFrameOf(s1999, 0)).toBe(placementFrameOf(s1999, PLACEMENT_SHIELD));
    const resting = placementFrameOf(s1999, PLACEMENT_RESTING)!.frames[0].orientation;
    const def = placementFrameOf(s1999, 0)!.frames[0].orientation;
    expect(def).toEqual({ w: 1, x: 0, y: 0, z: 0 });
    expect(resting.w).toBeCloseTo(Math.SQRT1_2, 5);
    expect(resting.x).toBeCloseTo(-Math.SQRT1_2, 5);
  });
});
