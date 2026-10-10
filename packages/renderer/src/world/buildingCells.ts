/**
 * CORE.14.b — the landblock's outdoor-visible interior-cell set.
 *
 * Retail never draws a landblock's EnvCells just because the viewer is in
 * the landblock. While the viewer is outdoors, the only interior cells a
 * landblock draws are the ones its building portals reference:
 * CLandBlock::init_buildings builds the block's stablist exclusively from
 * CBuildingObj::add_to_stablist → per-portal CBldPortal::add_to_stablist
 * (dedup'd union of each portal's stab_list — the DAT-precomputed set of
 * cells visible through that doorway/window), and
 * CLandBlock::grab_visible_cells loads exactly that list
 * (CEnvCell::grab_visible). All decompiled-EoL-client citations; ACE
 * mirrors the data in ACE.DatLoader/Entity/CBldPortal.cs.
 *
 * Cells no building references — deeper rooms and under-terrain dungeon
 * complexes sharing the landblock — are drawn only when the viewer is
 * inside: current cell + its VisibleCells PVS (CObjCell::draw_visible),
 * which the renderer applies per-frame elsewhere.
 */

/** Minimal shape of a building as parsed from LandblockInfo (BuildInfo). */
export interface BuildingPortalRef {
  portals: {
    otherCellId: number;
    stabList: number[];
  }[];
}

/** Interior cell indices are 0x0100..0xFFFD within a landblock (0xFFFE =
 *  LandblockInfo, 0xFFFF = terrain; 0x0000-0x00FF = outdoor land cells). */
function isInteriorIndex(idx: number, numCells: number): boolean {
  return idx >= 0x0100 && idx < 0x0100 + numCells;
}

/**
 * Union of every building portal's stab list (plus the portal's own
 * otherCellId — the doorway room itself), filtered to valid interior
 * indices. This is the retail CLandBlock stablist: the set of interior
 * cells this landblock renders while the viewer is outdoors.
 */
export function collectBuildingStabCells(
  buildings: BuildingPortalRef[],
  numCells: number,
): Set<number> {
  const stabSet = new Set<number>();
  for (const building of buildings) {
    for (const portal of building.portals) {
      if (isInteriorIndex(portal.otherCellId, numCells)) stabSet.add(portal.otherCellId);
      for (const stab of portal.stabList) {
        if (isInteriorIndex(stab, numCells)) stabSet.add(stab);
      }
    }
  }
  return stabSet;
}

/**
 * PERF.3 — the interior cells a player walking in from outdoors can reach:
 * the portal-graph closure (EnvCell CellPortals' otherCellId, same block) of
 * the building-portal cells. Retail enters an interior from a land cell only
 * through a building (CSortCell::find_transit_cells → CBuildingObj::
 * find_building_transit_cells, each CBldPortal's other cell; ACE Physics/
 * Common/SortCell.cs:33-42, BuildingObj.cs:54-71), then moves cell to cell
 * through CellPortals (CEnvCell::find_transit_cells; ACE EnvCell.cs:311-)
 * — a portal whose otherCellId is 0xFFFF leads back outside. A cell outside this closure (an
 * under-terrain dungeon reached only by a portal/teleport) can never hold an
 * outdoor-walking player, so its collision is not needed on the surface;
 * teleporting into it runs the dungeon path's own collision instead.
 *
 * @param seeds      interior cell indices entered from outdoors (the stab set)
 * @param portalsOf  a cell's CellPortals (null when the cell is unreadable)
 */
export function collectWalkableCells(
  seeds: Iterable<number>,
  numCells: number,
  portalsOf: (cellIndex: number) => readonly { otherCellId: number }[] | null | undefined,
): Set<number> {
  const out = new Set<number>();
  const queue: number[] = [];
  for (const s of seeds) {
    if (isInteriorIndex(s, numCells) && !out.has(s)) { out.add(s); queue.push(s); }
  }
  while (queue.length > 0) {
    const idx = queue.pop()!;
    for (const portal of portalsOf(idx) ?? []) {
      const next = portal.otherCellId;
      if (isInteriorIndex(next, numCells) && !out.has(next)) { out.add(next); queue.push(next); }
    }
  }
  return out;
}

// ── CORE.14.b.1 — per-portal frustum/plane gating ─────────────────────────
//
// Retail refines the stab-list rule per frame: a building portal's stab
// cells draw only while its doorway POLYGON is on screen. PView::DrawPortal
// (decompiled EoL client @ 005a5ab0) maps each CPortalPoly in the building
// model's drawing BSP to outdoor_portal_list[portal_index] (the building's
// CBldPortal), and PView::ConstructView(CBldPortal*, CPolygon*) @ 005a59a0
// (1) sidedness-tests the viewer against the polygon plane — portal_side==0
// requires POSITIVE, else NEGATIVE (portal_side = (~flags>>1)&1 per
// CBldPortal::UnPack @ 0053bc40, i.e. flags bit 0x2 set → POSITIVE side) —
// and (2) clips the polygon against the view frustum; a fully clipped or
// wrong-side portal draws zero interior cells. We reproduce that as a
// conservative superset: bounding-sphere-vs-frustum instead of exact
// polygon clipping, in-plane viewers pass, and a portal with no resolved
// polygon stays always open — never hiding a cell retail would draw.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Plane n·p + d, AC world coordinates (x east, y north, z up). */
export interface GatePlane {
  nx: number;
  ny: number;
  nz: number;
  d: number;
}

/** One doorway polygon, world-transformed at load time. */
export interface GatePortalPoly {
  /** polygon plane from the vertex winding (retail CPolygon::make_plane) */
  plane: GatePlane;
  /** true → viewer must be on the positive side (CBldPortal flags & 0x2) */
  requirePositive: boolean;
  /** bounding sphere of the polygon, for the frustum test */
  center: Vec3;
  radius: number;
}

/** One CBldPortal's gate: the cells it opens + its doorway polygon(s). */
export interface BuildingGate {
  /** interior cell indices (otherCellId + stabList, range-filtered) */
  cells: number[];
  /** doorway polys; empty → gate always open (no geometry resolved) */
  polys: GatePortalPoly[];
  /**
   * VISUAL.landblock-statics-missing-vs-retail — the portal-poly punch
   * (world/PortalPunch.ts) retail draws whenever ConstructView draws this
   * portal: shown exactly while the gate is open.
   */
  punch?: { visible: boolean } | null;
}

/** Camera view for gating, in AC world coordinates. */
export interface SurfaceView {
  /**
   * Positions tested against the portal plane — pass if ANY is on the
   * enterable side. Retail tests only the render viewpoint (the camera);
   * we add the player so a third-person camera trailing through the
   * doorway during entry/exit never hides a room the player still sees.
   */
  viewpoints: Vec3[];
  /** frustum planes, inward normals: n·p + d >= 0 inside */
  frustum: GatePlane[];
}

/** Client F_EPSILON — in-plane viewers PASS (conservative superset). */
const PLANE_EPSILON = 0.0002;

interface PortalPolyRef {
  portalIndex: number;
  polygonId: number;
}

/**
 * Collect every portal-poly reference from a drawing BSP ("PORT" nodes'
 * inPortals) — the retail CPortalPoly list for a building model part.
 */
export function collectDrawingPortalPolys(
  node: {
    type?: string;
    posNode?: unknown;
    negNode?: unknown;
    inPortals?: PortalPolyRef[];
  } | null | undefined,
): PortalPolyRef[] {
  const out: PortalPolyRef[] = [];
  const walk = (n: typeof node): void => {
    if (!n) return;
    if (n.inPortals) out.push(...n.inPortals);
    walk(n.posNode as typeof node);
    walk(n.negNode as typeof node);
  };
  walk(node);
  return out;
}

/**
 * Build a gate poly from world-space (AC coords) vertices in polygon
 * winding order. Newell normal reproduces the winding-derived plane the
 * client computes in CPolygon::make_plane. Returns null for degenerate
 * polygons (caller then leaves the gate always open).
 */
export function makeGatePortalPoly(verts: Vec3[], portalFlags: number): GatePortalPoly | null {
  if (verts.length < 3) return null;
  let nx = 0, ny = 0, nz = 0;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
    cx += a.x; cy += a.y; cz += a.z;
  }
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-9) return null;
  nx /= len; ny /= len; nz /= len;
  const inv = 1 / verts.length;
  const center = { x: cx * inv, y: cy * inv, z: cz * inv };
  let r2 = 0;
  for (const v of verts) {
    const dx = v.x - center.x, dy = v.y - center.y, dz = v.z - center.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) r2 = d2;
  }
  return {
    plane: { nx, ny, nz, d: -(nx * center.x + ny * center.y + nz * center.z) },
    requirePositive: (portalFlags & 0x2) !== 0,
    center,
    radius: Math.sqrt(r2),
  };
}

/**
 * Per-CBldPortal gates for one building. polysByPortal maps a portal's
 * index in `portals` to its world-space doorway polygon vertex lists
 * (usually one; the caller resolved them from the model's drawing BSP).
 * A portal with no resolvable polygon gets an always-open gate.
 */
export function buildBuildingGates(
  portals: { flags: number; otherCellId: number; stabList: number[] }[],
  polysByPortal: Map<number, Vec3[][]>,
  numCells: number,
  makePunch?: (portalIndex: number) => { visible: boolean } | null,
): BuildingGate[] {
  const gates: BuildingGate[] = [];
  for (let i = 0; i < portals.length; i++) {
    const portal = portals[i];
    const cellSet = new Set<number>();
    if (isInteriorIndex(portal.otherCellId, numCells)) cellSet.add(portal.otherCellId);
    for (const stab of portal.stabList) {
      if (isInteriorIndex(stab, numCells)) cellSet.add(stab);
    }
    if (cellSet.size === 0) continue;
    const polys: GatePortalPoly[] = [];
    for (const verts of polysByPortal.get(i) ?? []) {
      const poly = makeGatePortalPoly(verts, portal.flags);
      if (poly) polys.push(poly);
    }
    gates.push({ cells: [...cellSet], polys, punch: makePunch?.(i) ?? null });
  }
  return gates;
}

/**
 * Retail ConstructView(CBldPortal*, CPolygon*) as a conservative predicate:
 * open iff some doorway poly has a viewpoint on its enterable side AND its
 * bounding sphere touches the frustum. No polys → always open.
 */
export function gateOpen(gate: BuildingGate, view: SurfaceView): boolean {
  if (gate.polys.length === 0) return true;
  outer: for (const poly of gate.polys) {
    const { nx, ny, nz, d } = poly.plane;
    let enterable = false;
    for (const vp of view.viewpoints) {
      const dist = nx * vp.x + ny * vp.y + nz * vp.z + d;
      if (poly.requirePositive ? dist >= -PLANE_EPSILON : dist <= PLANE_EPSILON) {
        enterable = true;
        break;
      }
    }
    if (!enterable) continue;
    const c = poly.center;
    for (const fp of view.frustum) {
      if (fp.nx * c.x + fp.ny * c.y + fp.nz * c.z + fp.d < -poly.radius) continue outer;
    }
    return true;
  }
  return false;
}

/** One loaded landblock's interior meshes + its outdoor-visible stab set. */
export interface SurfaceCellBlock<M extends { visible: boolean } = { visible: boolean }> {
  /** interior cell index (0x0100+) → cell render mesh */
  meshes: Map<number, M>;
  /** building-portal stab list — the outdoor-visible cell set */
  stabSet: Set<number>;
  /**
   * CORE.14.b.1 — per-portal gates (union of cells === stabSet). When
   * present and a view is supplied, the outdoor rule narrows to the gates
   * whose doorway polygon is on screen; otherwise the full stab set draws.
   */
  gates?: BuildingGate[];
}

/**
 * Apply the retail surface interior draw rule to every registered block:
 * a cell renders iff it is in its block's building-portal stab set
 * (outdoor rule), or the viewer stands in that block and the cell is the
 * viewer's cell / in its VisibleCells PVS (indoor rule,
 * CObjCell::draw_visible).
 *
 * @param registry        blockKey ((blockX<<8)|blockY) → block cells
 * @param playerBlockKey  blockKey of the viewer's current cell, or -1 outdoors
 * @param pvs             viewer's current cell index + its VisibleCells
 *                        (interior indices); ignored when playerBlockKey is -1
 * @param view            camera viewpoint + frustum (AC world coords) for
 *                        per-portal gating (CORE.14.b.1); omitted → the
 *                        whole stab set draws (pre-gating behavior)
 */
export function applySurfaceCellVisibility<M extends { visible: boolean }>(
  registry: Map<number, SurfaceCellBlock<M>>,
  playerBlockKey: number,
  pvs: Set<number>,
  view?: SurfaceView,
): void {
  const openCells = new Set<number>();
  for (const [blockKey, block] of registry) {
    const inPlayerBlock = blockKey === playerBlockKey;
    if (view && block.gates) {
      openCells.clear();
      for (const gate of block.gates) {
        const open = gateOpen(gate, view);
        if (open) for (const c of gate.cells) openCells.add(c);
        if (gate.punch) gate.punch.visible = open;
      }
      for (const [idx, mesh] of block.meshes) {
        mesh.visible = openCells.has(idx) || (inPlayerBlock && pvs.has(idx));
      }
    } else {
      for (const [idx, mesh] of block.meshes) {
        mesh.visible = block.stabSet.has(idx) || (inPlayerBlock && pvs.has(idx));
      }
      // Ungated: every stab cell draws, so every portal punches.
      if (block.gates) for (const gate of block.gates) if (gate.punch) gate.punch.visible = true;
    }
  }
}

/**
 * DECOMP.interior-objects-culled — whether a surface interior cell draws
 * this frame under the rule above (`cellId` is the full 0xXXYYcccc id).
 * A registered block's cell with no built mesh is not drawn (PERF.3 builds
 * every cell the rule can show); undefined when the block is not
 * registered. Objects in the cell draw with it (`PView::DrawCells` @
 * 005a4840 → `DrawObjCell` @ 005a1a40).
 */
export function surfaceCellDrawn<M extends { visible: boolean }>(
  registry: Map<number, SurfaceCellBlock<M>>,
  cellId: number,
): boolean | undefined {
  const block = registry.get(cellId >>> 16);
  if (!block) return undefined;
  return block.meshes.get(cellId & 0xffff)?.visible ?? false;
}

/**
 * DECOMP.interior-objects-culled — whether ANY cell renderer draws the cell
 * an object stands in: the dungeon stream (while the viewer is in it) or
 * the surface building-cell rule. undefined when neither holds the cell.
 */
export function objectCellDrawn<M extends { visible: boolean }>(
  cellId: number,
  dungeonDrawn: ((cellId: number) => boolean | undefined) | null,
  registry: Map<number, SurfaceCellBlock<M>>,
): boolean | undefined {
  const inDungeon = dungeonDrawn?.(cellId);
  if (inDungeon) return true;
  const onSurface = surfaceCellDrawn(registry, cellId);
  return onSurface !== undefined ? onSurface : inDungeon;
}
