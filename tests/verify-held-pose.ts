/**
 * TOOL.playthrough-regression-steps (shield-relog false failure, 2026-11-07): the step compared the REQUESTED
 * placement id from main.ts's `[Wield] Attached … placement=N` line, and failed on local AC1999 with "placement 6
 * right after equipping (ParentEvent), 0 after the relog (CreateObject)". webac#26's fix (1a38493db) established
 * that the 1999 shield Setups have no Shield (6) frame, so CPartArray::SetPlacementFrame @ 0x005193d0 falls back
 * to frame 0: 6 and 0 draw the identical pose. The step now compares what the held copy DRAWS (HeldPose: the copy
 * on the holder part and every part's applied placement frame), and the attach line names the resolved frame.
 *
 * The DAT cases build the real held copy (SetupModelRenderer.createSetupMeshWithOverrides through
 * buildWieldedItemMesh) of the 1999 buckler and pin both directions: 6 → 0 matches 0, and the pre-1a38493db
 * login pose (Resting 0x65) differs, so the step still fails on webac#26 itself.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  type HeldPose, describeHeldPose, heldPoseDifferences, heldPoseOf, quatAngleDeg,
} from '../packages/renderer/src/models/HeldPose.js';
import { SetupModelRenderer } from '../packages/renderer/src/models/SetupModelRenderer.js';
import type { ModelRenderer } from '../packages/renderer/src/models/ModelRenderer.js';
import { PLACEMENT_RESTING, resolvedPlacementFrameId } from '../packages/renderer/src/models/SetupModelGroup.js';
import {
  WIELDED_FRAME_KEY, WIELDED_PLACEMENT_KEY, buildWieldedItemMesh, itemVisualDescOf,
} from '../packages/renderer/src/models/WieldedItemVisual.js';
import { judgeShieldRelog, parseWieldLine } from '../tools/lib/playthrough-regressions.ts';
import { DAT_SETS_DIR, openDat } from './_harness/dat.js';

const BUCKLER_SETUP = 0x02000162; // wcid 44 Buckler (AC1999 world DB)
const PLACEMENT_SHIELD = 6;

const pose = (parts: Array<[number, number, number, number, number, number, number]>, holding: [number, number, number] = [0.1, 0, 0]): HeldPose => ({
  placement: 0, frame: 0,
  holding: { p: holding, q: [0, 0, 0, 1] },
  parts: parts.map(([x, y, z, qx, qy, qz, qw], i) => ({ name: `part_${i}`, p: [x, y, z], q: [qx, qy, qz, qw] })),
});

describe('heldPoseDifferences: what a held copy draws, within a tolerance', () => {
  const a = pose([[0, 0, 0, 0, 0, 0, 1], [0, 0.2, 0, 0, 0, 0, 1]]);
  it('the same pose (q and -q are one rotation; float noise is not a move)', () => {
    const b = pose([[0, 0, 1e-6, 0, 0, 0, -1], [0, 0.2, 0, 0, 0, 0, 1]]);
    expect(heldPoseDifferences(a, b)).toEqual([]);
    expect(quatAngleDeg([0, 0, 0, 1], [0, 0, 0, -1])).toBeCloseTo(0, 6);
  });
  it('a part turned 90° about X, a moved copy, a part drawn only once: each named', () => {
    const turned = pose([[0, 0, 0, -Math.SQRT1_2, 0, 0, Math.SQRT1_2], [0, 0.2, 0, 0, 0, 0, 1]]);
    expect(heldPoseDifferences(a, turned)).toEqual(['part_0 turned 90.0°']);
    const moved = pose([[0, 0, 0, 0, 0, 0, 1], [0, 0.2, 0, 0, 0, 0, 1]], [0.2, 0, 0]);
    expect(heldPoseDifferences(a, moved)).toEqual(['the copy on the holder part moved 0.100 m']);
    expect(heldPoseDifferences(a, pose([[0, 0, 0, 0, 0, 0, 1]]))).toEqual(['part_1 drawn only before']);
  });
  it('describes the requested placement and the frame drawn', () => {
    expect(describeHeldPose({ ...a, placement: 6, frame: 0 })).toBe('placement 6 → frame 0');
    expect(describeHeldPose({ ...a, placement: 0, frame: 0 })).toBe('placement 0');
  });
});

describe('the attach line names the resolved frame', () => {
  it('parses frame= (a number, or identity), and an older line without it', () => {
    const l = '[Wield] Attached Buckler (setup 0x2000162) to part_14 (location=3, placement=6 from ParentEvent, frame=0)';
    expect(parseWieldLine(l)).toEqual({ name: 'Buckler', placement: 6, source: 'ParentEvent', frame: 0 });
    expect(parseWieldLine(l.replace('frame=0', 'frame=identity'))?.frame).toBeNull();
    expect(parseWieldLine('[Wield] Attached Buckler (setup 0x2000162) to part_14 (location=3, placement=6 from ParentEvent)')).toEqual({ name: 'Buckler', placement: 6, source: 'ParentEvent' });
  });
  it('without poses the verdict reads the resolved frames, never the requested ids', () => {
    const eq = parseWieldLine('[Wield] Attached Buckler (setup 0x1) to part_14 (location=3, placement=6 from ParentEvent, frame=0)')!;
    const login = parseWieldLine('[Wield] Attached Buckler (setup 0x1) to part_14 (location=3, placement=0 from CreateObject, frame=0)')!;
    const resting = parseWieldLine('[Wield] Attached Buckler (setup 0x1) to part_14 (location=3, placement=101 from CreateObject, frame=101)')!;
    expect(judgeShieldRelog({ line: eq, pose: null }, { line: login, pose: null }).ok).toBe(true);
    expect(judgeShieldRelog({ line: eq, pose: null }, { line: resting, pose: null })).toMatchObject({ ok: false, detail: expect.stringMatching(/placement 6 → frame 0 \(ParentEvent\).*placement 101 \(CreateObject\).*webac#26/) });
    const old = parseWieldLine('[Wield] Attached Buckler (setup 0x1) to part_14 (location=3, placement=6 from ParentEvent)')!;
    expect(judgeShieldRelog({ line: old, pose: null }, { line: login, pose: null })).toMatchObject({ ok: false, detail: expect.stringMatching(/can't tell what it draws/) });
  });
});

const AC1999_PORTAL = resolve(DAT_SETS_DIR, 'ac1999-retail', 'portal.dat');

describe.skipIf(!existsSync(AC1999_PORTAL))('the real 1999 buckler held copy', () => {
  let renderer: SetupModelRenderer;
  /** The held copy as attachWieldedToPlayer builds it, at a fixed holding frame. */
  const copyAt = (placement: number | undefined, desc: Parameters<typeof itemVisualDescOf>[0] = { setupId: BUCKLER_SETUP }): THREE.Group => {
    const mesh = buildWieldedItemMesh(renderer, itemVisualDescOf(desc)!, placement, () => null)!;
    mesh.position.set(0.05, -0.02, 0.1);
    return mesh;
  };
  beforeAll(() => {
    const parts = { createMesh: () => new THREE.Group() } as unknown as ModelRenderer;
    renderer = new SetupModelRenderer(openDat(AC1999_PORTAL), parts);
  });

  it('the copy records the frame the Setup used: Shield (6) resolves to 0, Resting stays 0x65', () => {
    const setup = renderer.loadSetupModel(BUCKLER_SETUP)!;
    expect(resolvedPlacementFrameId(setup, PLACEMENT_SHIELD)).toBe(0);
    expect(resolvedPlacementFrameId(setup, PLACEMENT_RESTING)).toBe(PLACEMENT_RESTING);
    const c = copyAt(PLACEMENT_SHIELD);
    expect(c.userData[WIELDED_PLACEMENT_KEY]).toBe(PLACEMENT_SHIELD);
    expect(c.userData[WIELDED_FRAME_KEY]).toBe(0);
    expect(heldPoseOf(c)).toMatchObject({ placement: PLACEMENT_SHIELD, frame: 0 });
  });

  it('re-equip 6 (→ 0) and the fixed login 0 draw the same pose: the step passes', () => {
    const equip = heldPoseOf(copyAt(PLACEMENT_SHIELD));
    const login = heldPoseOf(copyAt(undefined)); // CreateObject without AnimationFrame or Movement → 0 (1a38493db)
    expect(login.placement).toBe(0);
    expect(equip.parts.length).toBeGreaterThan(0);
    expect(heldPoseDifferences(equip, login)).toEqual([]);
    const v = judgeShieldRelog(
      { line: { name: 'Buckler', placement: 6, source: 'ParentEvent', frame: 0 }, pose: equip },
      { line: { name: 'Buckler', placement: 0, source: 'CreateObject', frame: 0 }, pose: login },
    );
    expect(v.ok).toBe(true);
    expect(v.detail).toMatch(/placement 6 → frame 0 \(ParentEvent\) right after equipping, placement 0 \(CreateObject\) after the relog: the same pose/);
  });

  it('the pre-1a38493db login pose (Resting 0x65) differs: the step still fails on webac#26', () => {
    const equip = heldPoseOf(copyAt(PLACEMENT_SHIELD));
    const resting = heldPoseOf(copyAt(PLACEMENT_RESTING));
    const diffs = heldPoseDifferences(equip, resting);
    expect(diffs.some((d) => /turned 90\.0°/.test(d))).toBe(true);
    const v = judgeShieldRelog(
      { line: { name: 'Buckler', placement: 6, source: 'ParentEvent', frame: 0 }, pose: equip },
      { line: { name: 'Buckler', placement: 101, source: 'CreateObject', frame: 101 }, pose: resting },
    );
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/the relog draws it differently \(.*turned 90\.0°.*\) \(webac#26\)/);
  });
});
