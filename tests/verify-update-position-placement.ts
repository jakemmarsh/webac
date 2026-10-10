/**
 * SmartBox::HandleReceivedPosition @ 00453fd0 poses an object without
 * animations at the UpdatePosition's placement (CPhysicsObj::SetPlacementFrame);
 * PositionPack::UnPack @ 268792 reads an absent placement id as 0. Ours read
 * the id and threw it away.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { deserializeMessage } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler, type UpdatePositionData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

/** A 0xF748 UpdatePosition: identity orientation (W only), optional placement. */
function updatePosition(guid: number, placement?: number): Uint8Array {
  const flags = 0x10 | 0x20 | 0x40 | (placement !== undefined ? 0x02 : 0);
  const buf = new Uint8Array(4 + 4 + 4 + 4 + 12 + 4 + (placement !== undefined ? 4 : 0) + 8);
  const v = new DataView(buf.buffer);
  let o = 0;
  v.setUint32(o, 0xf748, true); o += 4;
  v.setUint32(o, guid, true); o += 4;
  v.setUint32(o, flags, true); o += 4;
  v.setUint32(o, 0xa9b40019, true); o += 4;
  for (const f of [84, 7.1, 94]) { v.setFloat32(o, f, true); o += 4; }
  v.setFloat32(o, 1, true); o += 4;
  if (placement !== undefined) { v.setUint32(o, placement, true); o += 4; }
  for (const ts of [1, 2, 0, 0]) { v.setUint16(o, ts, true); o += 2; }
  return buf;
}

describe('UpdatePosition placement id', () => {
  it('is read when HasPlacementID is set and is 0 when it is absent; the timestamps after it still line up', () => {
    const got: UpdatePositionData[] = [];
    const h = new ServerMessageHandler();
    h.setHandlers({ onUpdatePosition: (d) => { got.push(d); } });
    h.handleMessage(deserializeMessage(updatePosition(0x80000001, 0x65)));
    h.handleMessage(deserializeMessage(updatePosition(0x80000002)));
    expect(got.map((d) => [d.placementId, d.instanceSequence, d.positionSequence])).toEqual([[0x65, 1, 2], [0, 1, 2]]);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('SetPlacementFrame on a built object', () => {
  // Setup 0x02000100: one part; Default (0) at the origin, Resting (0x65) 0.035 m down.
  const SETUP = 0x02000100;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let renderer: any;
  beforeAll(async () => {
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    renderer = new SetupModelRenderer(openDat(DAT_PATHS.portal), {} as never);
  });

  it('posePlacement moves each part to the placement frame (AC z → three y)', () => {
    const group = new THREE.Group();
    const part = new THREE.Object3D(); part.name = 'part_0'; group.add(part);
    expect(renderer.posePlacement(group, SETUP, 0x65)).toBe(true);
    expect(part.position.y).toBeCloseTo(-0.035, 3);
    renderer.posePlacement(group, SETUP, 0);
    expect(part.position.y).toBeCloseTo(0, 6);
  });

  it('ServerObjectManager.setPlacementFrame re-poses only on a change, and the placement survives for rebuilds', async () => {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
    const posed: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).setupModelRenderer = { posePlacement: (_g: unknown, _s: number, p: number) => { posed.push(p); return true; } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = { guid: 1, setupId: SETUP, mesh: new THREE.Group(), placement: undefined } as any;
    som.setPlacementFrame(obj, 0x65); // CreateObject without a placement is already Resting
    som.setPlacementFrame(obj, 0);
    som.setPlacementFrame(obj, 0);
    expect(posed).toEqual([0]);
    expect(obj.placement).toBe(0);
  });
});
