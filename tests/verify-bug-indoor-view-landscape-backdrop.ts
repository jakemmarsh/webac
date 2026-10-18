/**
 * BUG.bunker-terrain-over-stairs — with the camera in a surface building
 * cell, retail draws the landscape as a backdrop, clears depth, then draws
 * the viewer's cells and what stands in them (PView::DrawCells @ 005a4840;
 * scene/IndoorView.ts). Drives the shipped renderIndoorView with a recording
 * renderer and real three.js objects.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { indoorPassOf, isViewerCell, renderIndoorView, type IndoorViewContext } from '../packages/renderer/src/scene/IndoorView.js';
import { SpellEffects } from '../packages/renderer/src/effects/SpellEffects.js';
import type { ParticleEmitterInfo } from '@ac/dat-parser';

const ROOM = 0xa9b40185;
const STAIRS = 0xa9b40187;
const NEIGHBOUR = 0xa9b40110;

function ctx(over: Partial<IndoorViewContext> = {}): IndoorViewContext {
  return {
    blockKey: 0xa9b4,
    cells: new Set([0x185, 0x186, 0x187, 0x188, 0x189]),
    playerCellId: STAIRS,
    cellAt: () => 0,
    ...over,
  };
}
const named = (name: string, obj: THREE.Object3D = new THREE.Group()) => { obj.name = name; return obj; };

describe('indoorPassOf — the pass each top-level scene child draws in', () => {
  it('the viewer\'s cells and the cells it sees draw inside; another building\'s cells are landscape', () => {
    expect(indoorPassOf(named('envcell_a9b40185'), ctx())).toBe('inside');
    expect(indoorPassOf(named('envcell_a9b40189'), ctx())).toBe('inside');
    expect(indoorPassOf(named('envcell_a9b40110'), ctx())).toBe('outside');
    expect(indoorPassOf(named('envcell_a9b30185'), ctx())).toBe('outside'); // same index, another block
  });

  it('terrain, roads, sky, buildings and scenery are the backdrop; lights light both passes', () => {
    for (const n of ['', 'blendmerge', 'roadmerge', 'sky_objects', 'bldginst_010011c0', 'sceneryinst_02000123', 'portal_punch', 'setup_02000456']) {
      expect(indoorPassOf(named(n, new THREE.Mesh()), ctx()), n).toBe('outside');
    }
    expect(indoorPassOf(new THREE.AmbientLight(), ctx())).toBe('both');
    expect(indoorPassOf(named('dat-light-filler', new THREE.PointLight()), ctx())).toBe('both');
    expect(indoorPassOf(named('object-light-carrier'), ctx())).toBe('both');
  });

  it('the player draws inside while standing in one of the viewer\'s cells', () => {
    expect(indoorPassOf(named('player_Claude'), ctx())).toBe('inside');
    expect(indoorPassOf(named('player_Claude'), ctx({ playerCellId: 0xa9b40024 }))).toBe('outside');
    expect(indoorPassOf(named('player_Claude'), ctx({ playerCellId: NEIGHBOUR }))).toBe('outside');
  });

  it('a server object goes by its cell (the portal in the room inside, a mosswart on the grass outside)', () => {
    const portal = named('server_7a9b4068_Portal to Rithwic');
    portal.userData.objCellId = ROOM;
    const mosswart = named('server_80001234_Young Mosswart');
    mosswart.userData.objCellId = 0xa9b40024;
    expect(indoorPassOf(portal, ctx())).toBe('inside');
    expect(indoorPassOf(mosswart, ctx())).toBe('outside');
  });

  it('a world-space particle system (its node at the origin) goes by its parent\'s position', () => {
    // The bunker's Portal to Rithwic vortex (particles_320002cd): node at (0,0,0), parent on the room floor.
    const vortex = named('particles_320002cd');
    vortex.userData.indoorAnchor = (out: THREE.Vector3) => out.set(32556, 73.6, 34624.4);
    const asked: number[][] = [];
    const room = (x: number, y: number, z: number) => { asked.push([x, y, z]); return z > 73.7 ? ROOM : 0; };
    expect(indoorPassOf(vortex, ctx({ cellAt: room }))).toBe('inside');
    expect(asked[0][0]).toBe(32556);
    expect(asked[0][1]).toBeCloseTo(34624.4, 6);
    expect(asked[0][2]).toBeCloseTo(74.1, 6); // lifted off the floor it rests on
    const unborn = named('particles_320002cd');
    unborn.userData.indoorAnchor = () => null;
    expect(indoorPassOf(unborn, ctx({ cellAt: () => ROOM }))).toBe('outside');
  });

  it('effects go by the cell their position lies in (three (x, y, z) = AC (x, z, y))', () => {
    const asked: number[][] = [];
    const fx = named('particles_32000001');
    fx.position.set(32556, 75, 34630);
    const c = ctx({ cellAt: (x, y, z) => { asked.push([x, y, z]); return ROOM; } });
    expect(indoorPassOf(fx, c)).toBe('inside');
    expect(asked).toEqual([[32556, 34630, 75.5]]);
    expect(indoorPassOf(fx, ctx({ cellAt: () => 0 }))).toBe('outside');
  });

  it('isViewerCell: an outdoor cell or 0 is never one', () => {
    expect(isViewerCell(0, ctx())).toBe(false);
    expect(isViewerCell(0xa9b40024, ctx())).toBe(false);
    expect(isViewerCell(STAIRS, ctx())).toBe(true);
  });
});

describe('renderIndoorView — backdrop, depth clear, then the viewer\'s cells', () => {
  it('draws the landscape first, clears depth only, then the cells; every visibility is restored', () => {
    const scene = new THREE.Scene();
    const terrain = named('', new THREE.Mesh());
    const room = named('envcell_a9b40185');
    const player = named('player_Claude');
    const light = new THREE.AmbientLight();
    const hidden = named('envcell_a9b40187');
    hidden.visible = false;
    scene.add(terrain, room, player, light, hidden);
    const log: string[] = [];
    const renderer = {
      autoClear: true,
      render: () => log.push(`render autoClear=${renderer.autoClear} [${scene.children.filter((c) => c.visible).map((c) => c.name || c.type).join(',')}]`),
      clearDepth: () => log.push('clearDepth'),
    };
    renderIndoorView(renderer, scene, new THREE.PerspectiveCamera(), ctx());
    expect(log).toEqual([
      'render autoClear=true [Mesh,AmbientLight]',
      'clearDepth',
      'render autoClear=false [envcell_a9b40185,player_Claude,AmbientLight]',
    ]);
    expect(renderer.autoClear).toBe(true);
    expect([terrain.visible, room.visible, player.visible, light.visible, hidden.visible]).toEqual([true, true, true, true, false]);
  });

  it('restores visibility and autoClear even when a pass throws', () => {
    const scene = new THREE.Scene();
    const terrain = named('', new THREE.Mesh());
    scene.add(terrain, named('envcell_a9b40185'));
    const renderer = { autoClear: true, render: () => { throw new Error('lost context'); }, clearDepth: () => {} };
    expect(() => renderIndoorView(renderer, scene, new THREE.PerspectiveCamera(), ctx())).toThrow('lost context');
    expect(scene.children.every((c) => c.visible)).toBe(true);
    expect(renderer.autoClear).toBe(true);
  });
});

describe('a world-space particle system spawned by SpellEffects carries its parent\'s position', () => {
  const vortexInfo = (): ParticleEmitterInfo => ({
    id: 0x320002cd, emitterType: 1, particleType: 9, gfxObjId: 0, hwGfxObjId: 0x01002061,
    birthrate: 0.5, maxParticles: 20, initialParticles: 0, totalParticles: 0, totalSeconds: 0,
    lifespan: 10, lifespanRand: 0, offsetDir: { x: 0, y: 0, z: 1 }, minOffset: 0, maxOffset: 0,
    a: { x: 0, y: 0, z: 0 }, minA: 0, maxA: 0, b: { x: 0, y: 0, z: 0 }, minB: 0, maxB: 0,
    c: { x: 0, y: 0, z: 0 }, minC: 0, maxC: 0, startScale: 1, finalScale: 1, scaleRand: 0,
    startTrans: 0, finalTrans: 0, transRand: 0, isParentLocal: 0, sortingSphereRadius: 1,
  } as never);

  it('the node stays at the origin; its indoor anchor is the parent frame, and it draws with the parent\'s room', () => {
    const scene = new THREE.Scene();
    const effects = new SpellEffects(scene);
    // The portal's frame in three axes (x, up, AC y): on the bunker room's floor.
    const frameSource = {
      getFrame: (pos: THREE.Vector3, quat: THREE.Quaternion) => { pos.set(32556, 73.6, 34624.4); quat.identity(); return true; },
      offset: { x: 0, y: 0, z: 0 },
    };
    const system = effects.spawnParticleEffect(vortexInfo(), { x: 0, y: 0, z: 0 }, undefined, undefined, undefined, { frameSource });
    const node = system.object3D;
    expect(node.parent).toBe(scene);
    expect(node.position.toArray()).toEqual([0, 0, 0]);
    const at = (node.userData.indoorAnchor as (o: THREE.Vector3) => THREE.Vector3 | null)(new THREE.Vector3());
    expect(at!.x).toBeCloseTo(32556, 3);
    expect(at!.y).toBeCloseTo(73.6, 3);
    expect(at!.z).toBeCloseTo(34624.4, 3);
    expect(indoorPassOf(node, ctx({ cellAt: (_x, y, z) => (y < 34639 && z > 73.7 ? ROOM : 0) }))).toBe('inside');
  });
});
