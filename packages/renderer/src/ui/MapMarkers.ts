/**
 * CORE.17.k.b.b.a.g.d — the map panel's markers and coordinate line, as
 * gmMapUI draws them (the decompiled EoL client, docs/retail-client-symbols.md
 * CORE.17.k.b.b.a.g.d).
 *
 * Ground truth:
 *  - gmMapUI::PostInit @ 004a1c70: m_pDateTimeText = 0x100001eb's text,
 *    m_pCoordinateText = 0x100001ef's text, m_pPlayerLocationIcon = 0x100001ed
 *    (17x16, media 0x06004d10), m_pHouseLocationIcon = 0x100001ee (8x8, media
 *    0x06004d11, p73 "Your House", root 0x10000398, p80 0), m_pMap =
 *    0x100001ec, whose custom int properties p0x1000004e / 4f / 50 / 51 are
 *    m_boxMapMarkerArea (x0 / x1 / y0 / y1 — 6 / 247 / 8 / 258 in the EoL DAT).
 *  - gmMapUI::Update @ 004a1eb0 (on open and every 5 s while open —
 *    m_nextUpdate = cur_time + 5.0, ListenToGlobalMessage 3): while
 *    CPlayerSystem::IsOutside (the player's cell id & 0xffff < 0x100), the
 *    coordinate text is sprintf("%.1f%s, %.1f%s", |NS|, "N" / "S" / "",
 *    |EW|, "E" / "W" / "") (.rdata 0x7a657c–0x7a65a8; an exact 0 gets the
 *    empty suffix) and the player icon is placed at the SIGNED coordinates;
 *    inside, the text is "" and the icon hidden. The house icon shows while
 *    m_HousePosition is valid (Position::IsValid = inbound_valid_cellid +
 *    Frame::IsValid), placed at the outside cell's landscape coordinate.
 *  - CPlayerSystem::InqPlayerCoords @ 00560090 and the house branch of Update:
 *    the coordinate of a landscape cell c is (c − 1024) × 0.1 + 0.5 (.rdata
 *    0x7a6db0 / 0x798088), for EW from the x cell and NS from the y cell —
 *    cell-quantized (ACE Position.GetMapCoords: global / 240 − 101.95).
 *  - gmMapUI::PlaceMarkerOnMap @ 004a18b0 (acclient.exe 4a18b0–4a1997, the
 *    fmul / fadd operands .rdata 0x79bac8 = 10.0, 0x7aac78 = 1024.0,
 *    0x7aac70 = −1/2048, 0x7aac68 = 2047.0):
 *      x = x0 − ⌊w/2⌋ − ftol((EW·10 + 1024) · (x1 − x0 + 1) · (−1/2048))
 *      y = y0 − ⌊h/2⌋ − ftol((2047 − (NS·10 + 1024)) · (y1 − y0 + 1) · (−1/2048))
 *    then MoveTo(x, y) (relative to the map element) + SetVisible(1). The
 *    world is 2048 cells across with coordinate 0 at cell 1024, so a marker
 *    sits at its cell's fraction of the marker box, north up.
 *  - gmMapUI::RecvNotice_UpdateHouseData @ 004a1870: a HouseData of type 4
 *    (Apartment) clears m_HousePosition (objcell_id 0), any other stores
 *    its position; RecvNotice_FailedHouseTransaction @ 004a18a0 (the 0x226
 *    HouseStatus) clears it. CPlayerSystem::InitializePlayer @ 00563570
 *    sends CM_House::Event_QueryHouse, so the data is in hand from login.
 *  - LandDefs::gid_to_lcoord @ 00497a90 / inbound_valid_cellid @ 004979a0 /
 *    get_outside_lcoord @ 005a9b00 / adjust_to_outside @ 005a9bc0
 *    (Position::get_outside_cell_id @ 004527b0): an outdoor cell id
 *    (index 1..0x40) maps to (lbx·8 + (index − 1) >> 3, lby·8 + (index − 1) & 7);
 *    an indoor one (0x100..0xfffd) or the landblock itself (0xffff) is
 *    adjusted to the outdoor cell under the origin (lb·8 + ⌊origin / 24⌋).
 */

/** 0x21000026's map picture; its children are the two icons. */
export const MAP_ELEMENT = 0x100001ec;
export const MAP_PLAYER_ICON_ELEMENT = 0x100001ed;
export const MAP_HOUSE_ICON_ELEMENT = 0x100001ee;
export const MAP_COORDINATE_TEXT_ELEMENT = 0x100001ef;
export const MAP_PLAYER_ICON_MEDIA = 0x06004d10;
export const MAP_HOUSE_ICON_MEDIA = 0x06004d11;

export interface MarkerSize { width: number; height: number }
/** 0x100001ed: 17x16. */
export const MAP_PLAYER_ICON_SIZE: Readonly<MarkerSize> = { width: 17, height: 16 };
/** 0x100001ee: 8x8. */
export const MAP_HOUSE_ICON_SIZE: Readonly<MarkerSize> = { width: 8, height: 8 };

/** The map's custom int properties gmMapUI::PostInit reads into m_boxMapMarkerArea. */
export const MAP_MARKER_AREA_PROPERTIES = { x0: 0x1000004e, x1: 0x1000004f, y0: 0x10000050, y1: 0x10000051 } as const;

export interface MapMarkerArea { x0: number; x1: number; y0: number; y1: number }
/** The EoL DAT's values (client_local_English.dat 0x21000026:0x100001ec). */
export const MAP_MARKER_AREA: Readonly<MapMarkerArea> = { x0: 6, x1: 247, y0: 8, y1: 258 };

/** gmMapUI::Update's re-run cadence while the panel is open (m_nextUpdate = cur_time + 5.0). */
export const MAP_UPDATE_INTERVAL_SECONDS = 5;

/** ACE HouseType.Apartment — the one house type gmMapUI never marks. */
export const HOUSE_TYPE_APARTMENT = 4;

/** The exe's constants. */
export const LANDSCAPE_ORIGIN_CELL = 1024;
export const COORD_PER_CELL = 0.1;
export const COORD_CELL_OFFSET = 0.5;
export const PLACE_MARKER_SCALE = 10.0;
export const PLACE_MARKER_BIAS = 1024.0;
export const PLACE_MARKER_STEP = -1 / 2048;
export const PLACE_MARKER_FLIP = 2047.0;
export const MAP_COORDINATE_FORMAT = '%.1f%s, %.1f%s';
export const MAP_COORDINATE_SUFFIXES = { north: 'N', south: 'S', east: 'E', west: 'W', zero: '' } as const;

/** The world's cell grid: 256 landblocks × 8 cells; a cell is 24 m (LandDefs::square_length). */
export const CELLS_PER_LANDBLOCK = 8;
export const CELL_LENGTH = 24;
export const MAX_LANDSCAPE_COORD = 0x7f8;

/** MSVC's _ftol2: truncation toward zero. */
export function ftol(v: number): number { return Math.trunc(v); }

/** CPlayerSystem::InqPlayerCoords / gmMapUI::Update: a landscape cell's coordinate, (c − 1024) × 0.1 + 0.5. */
export function landscapeCoordToMapCoord(cell: number): number {
  return (cell - LANDSCAPE_ORIGIN_CELL) * COORD_PER_CELL + COORD_CELL_OFFSET;
}

export interface MapCoords { ew: number; ns: number }

/** Both markers' coordinates from a landscape (cell) coordinate pair. */
export function mapCoordsOfCell(cellX: number, cellY: number): MapCoords {
  return { ew: landscapeCoordToMapCoord(cellX), ns: landscapeCoordToMapCoord(cellY) };
}

/**
 * gmMapUI::PlaceMarkerOnMap @ 004a18b0: the icon's top-left inside the map
 * element for a coordinate pair, over the marker box.
 */
export function placeMarkerOnMap(area: MapMarkerArea, icon: MarkerSize, ew: number, ns: number): { x: number; y: number } {
  const width = area.x1 - area.x0 + 1;
  const height = area.y1 - area.y0 + 1;
  const halfW = ftol(icon.width / 2);
  const halfH = ftol(icon.height / 2);
  const x = area.x0 - halfW - ftol((ew * PLACE_MARKER_SCALE + PLACE_MARKER_BIAS) * width * PLACE_MARKER_STEP);
  const y = area.y0 - halfH - ftol((PLACE_MARKER_FLIP - (ns * PLACE_MARKER_SCALE + PLACE_MARKER_BIAS)) * height * PLACE_MARKER_STEP);
  return { x, y };
}

/**
 * gmMapUI::Update's coordinate line: sprintf("%.1f%s, %.1f%s", |NS|, N/S,
 * |EW|, E/W) — a coordinate below 0 reads S / W, above 0 N / E, and an
 * exact 0 carries no letter.
 */
export function mapCoordinateText(coords: MapCoords): string {
  const { ns, ew } = coordinateHalves(coords);
  return `${ns}, ${ew}`;
}

/**
 * One "%.1f%s" half: |v| to one decimal (printf rounding of the double) and
 * the letter — the `fcomp [0x794610]` (0.0) pair every coordinate reader
 * runs: below 0 the negative letter, above 0 the positive one, an exact 0
 * the empty string (.rdata 0x794320).
 */
function coordinateHalf(v: number, pos: string, neg: string): string {
  const letter = v < 0 ? neg : v > 0 ? pos : MAP_COORDINATE_SUFFIXES.zero;
  return `${Math.abs(v).toFixed(1)}${letter}`;
}

/** Both "%.1f%s" halves of a coordinate pair, NS first as every retail reader prints them. */
export function coordinateHalves(coords: MapCoords): { ns: string; ew: string } {
  return {
    ns: coordinateHalf(coords.ns, MAP_COORDINATE_SUFFIXES.north, MAP_COORDINATE_SUFFIXES.south),
    ew: coordinateHalf(coords.ew, MAP_COORDINATE_SUFFIXES.east, MAP_COORDINATE_SUFFIXES.west),
  };
}

/**
 * BUG.radar-coordinate-formula-unverified — gmRadarUI::UpdateCoordinates
 * @ 004d8c80 (acclient.exe 4d8c80–4d8ff0): while PlayerModule::
 * CoordinatesOnRadar, CPlayerSystem::InqPlayerCoords(&ew, &nsCoord) — the
 * same cell-quantized (c − 1024) × 0.1 + 0.5 the map uses, NOT ACE's
 * server-side GetMapCoordStr — and, when the pair changed, three texts:
 *   m_pCombinedCoordsText (+0x648): sprintf(L"%.1f%s,%.1f%s" @ .rdata
 *     0x7bdd0c, |NS|, N/S/"", |EW|, E/W/"") — no space after the comma;
 *   m_pYCoordText (+0x650): L"%.1f%s" @ 0x7bdcfc with |NS| + N/S/"";
 *   m_pXCoordText (+0x64c): L"%.1f%s" @ 0x7bdcfc with |EW| + E/W/"".
 * Then the container (+0x644) and the three texts are SetVisible(ok), ok =
 * CoordinatesOnRadar && InqPlayerCoords succeeded — and InqPlayerCoords
 * fails indoors (CPhysicsObj::get_landscape_coord → LandDefs::gid_to_lcoord
 * @ 00497a90 rejects a cell index ≥ 0x100), so retail hides the readout in
 * dungeons and building interiors.
 */
export const RADAR_COMBINED_COORDINATE_FORMAT = '%.1f%s,%.1f%s';
export const RADAR_SINGLE_COORDINATE_FORMAT = '%.1f%s';

/** CPlayerSystem::InqPlayerCoords @ 00560090: the pair for a landscape cell, or null when the player isn't in an outdoor cell. */
export function inqPlayerCoords(cellX: number, cellY: number, outside: boolean): MapCoords | null {
  return outside ? mapCoordsOfCell(cellX, cellY) : null;
}

/** gmRadarUI::UpdateCoordinates' three texts for a coordinate pair. */
export function radarCoordinateTexts(coords: MapCoords): { combined: string; ns: string; ew: string } {
  const { ns, ew } = coordinateHalves(coords);
  return { combined: `${ns},${ew}`, ns, ew };
}

/**
 * gmRadarUI::UpdateCoordinates as a whole: the combined text and whether
 * the readout shows (CoordinatesOnRadar && InqPlayerCoords). Hidden, the
 * text is null — retail leaves the last one in place, invisible.
 */
export function radarCoordinateReadout(cellX: number, cellY: number, outside: boolean, coordinatesOnRadar: boolean): { visible: boolean; text: string | null } {
  if (!coordinatesOnRadar) return { visible: false, text: null };
  const coords = inqPlayerCoords(cellX, cellY, outside);
  if (!coords) return { visible: false, text: null };
  return { visible: true, text: radarCoordinateTexts(coords).combined };
}

/**
 * gmJournalUI::ResetLocation @ 00496260 (the Record button 0x10000574) +
 * UpdateLocation @ 004958f0: m_LocationSet = InqPlayerCoords(...); set, the
 * location text is sprintf(L"%.1f%s, %.1f%s" @ 0x7a657c, |NS|, N/S/"",
 * |EW|, E/W/"") — the map's format — and unset (indoors) it is L"None"
 * @ .rdata 0x7a6558.
 */
export const JOURNAL_NO_LOCATION_TEXT = 'None';
export function journalLocationText(cellX: number, cellY: number, outside: boolean): string {
  const coords = inqPlayerCoords(cellX, cellY, outside);
  return coords ? mapCoordinateText(coords) : JOURNAL_NO_LOCATION_TEXT;
}

/** SmartBox::is_player_outside @ 00451e80: the player's cell id's low word below 0x100. */
export function isOutsideCell(cellId: number): boolean {
  return (cellId & 0xffff) < 0x100;
}

/** LandDefs::inbound_valid_cellid @ 004979a0. */
export function inboundValidCellId(cellId: number): boolean {
  const idx = cellId & 0xffff;
  const kind = (idx !== 0 && idx < 0x41) || (idx > 0xff && idx < 0xfffe) || idx === 0xffff;
  return kind && ((cellId >>> 21) & MAX_LANDSCAPE_COORD) < MAX_LANDSCAPE_COORD && ((cellId >>> 13) & MAX_LANDSCAPE_COORD) < MAX_LANDSCAPE_COORD;
}

export interface LandscapeCoord { x: number; y: number }

/** LandDefs::gid_to_lcoord @ 00497a90: an OUTDOOR cell id's landscape coordinate (null: not one). */
export function gidToLcoord(cellId: number): LandscapeCoord | null {
  if (!inboundValidCellId(cellId) || (cellId & 0xffff) >= 0x100) return null;
  const idx = (cellId & 0xffff) - 1;
  const x = ((cellId >>> 21) & MAX_LANDSCAPE_COORD) + (idx >> 3);
  const y = (((cellId >>> 16) & 0xff) << 3) + (idx & 7);
  if (x < 0 || y < 0 || x >= MAX_LANDSCAPE_COORD || y >= MAX_LANDSCAPE_COORD) return null;
  return { x, y };
}

export interface CellPosition { cell: number; x: number; y: number }

/**
 * LandDefs::get_outside_lcoord @ 005a9b00: the landscape coordinate of the
 * outdoor cell under a position (its landblock's cell origin plus the
 * origin's ⌊x / 24⌋, ⌊y / 24⌋); null for a cell id no landblock owns.
 */
export function getOutsideLcoord(position: CellPosition): LandscapeCoord | null {
  if (!inboundValidCellId(position.cell)) return null;
  const x = (((position.cell >>> 24) & 0xff) << 3) + ftol(Math.floor(position.x / CELL_LENGTH));
  const y = (((position.cell >>> 16) & 0xff) << 3) + ftol(Math.floor(position.y / CELL_LENGTH));
  if (x < 0 || y < 0 || x >= MAX_LANDSCAPE_COORD || y >= MAX_LANDSCAPE_COORD) return null;
  return { x, y };
}

/** LandDefs::lcoord_to_gid @ 004a19a0. */
export function lcoordToGid(x: number, y: number): number {
  if (x < 0 || y < 0 || x >= MAX_LANDSCAPE_COORD || y >= MAX_LANDSCAPE_COORD) return 0;
  return ((((x & ~7) << 5) | (y >> 3)) << 16 | ((x & 7) * 8 + (y & 7) + 1)) >>> 0;
}

/** Position::get_outside_cell_id @ 004527b0 (adjust_to_outside): the outdoor cell id under a position, 0 when none. */
export function getOutsideCellId(position: CellPosition): number {
  const l = getOutsideLcoord(position);
  return l ? lcoordToGid(l.x, l.y) : 0;
}

/** Position::IsValid @ 005a9480 (the frame's validity taken as given): a cell id some landblock owns. */
export function positionIsValid(position: CellPosition | null | undefined): boolean {
  return !!position && inboundValidCellId(position.cell);
}

/**
 * gmMapUI::RecvNotice_UpdateHouseData @ 004a1870: what m_HousePosition
 * becomes for a HouseData — cleared for an Apartment (type 4), the data's
 * position otherwise.
 */
export function houseMarkerPosition<T extends CellPosition>(houseType: number, position: T | null | undefined): T | null {
  if (houseType === HOUSE_TYPE_APARTMENT) return null;
  return position ?? null;
}

/**
 * The house branch of gmMapUI::Update: the icon's place for a valid house
 * position (the outside cell's landscape coordinate → map coordinates →
 * PlaceMarkerOnMap), or null when the icon is hidden.
 */
export function houseIconPlacement(area: MapMarkerArea, position: CellPosition | null | undefined): { x: number; y: number; coords: MapCoords } | null {
  if (!positionIsValid(position)) return null;
  const outside = gidToLcoord(getOutsideCellId(position!));
  if (!outside) return null;
  const coords = mapCoordsOfCell(outside.x, outside.y);
  return { ...placeMarkerOnMap(area, MAP_HOUSE_ICON_SIZE, coords.ew, coords.ns), coords };
}

/**
 * The player branch of gmMapUI::Update: while outside, the coordinate text
 * and the icon's place for the player's landscape cell; inside, "" and no
 * icon (SetVisible(0)).
 */
export function playerMarkerUpdate(area: MapMarkerArea, cellX: number, cellY: number, outside: boolean): { text: string; icon: { x: number; y: number } | null; coords: MapCoords | null } {
  if (!outside) return { text: '', icon: null, coords: null };
  const coords = mapCoordsOfCell(cellX, cellY);
  return { text: mapCoordinateText(coords), icon: placeMarkerOnMap(area, MAP_PLAYER_ICON_SIZE, coords.ew, coords.ns), coords };
}

/**
 * gmMapUI::ListenToElementMessage @ 004a2350 — a PSR's click on the map art
 * 0x100001ec at (px, py) inside m_boxMapMarkerArea teleports to the outdoor
 * cell under it: LandDefs::lcoord_to_gid(⌊(px − x0)·0x7ff / (x1 − x0)⌋,
 * ⌊(y0 − py)·0x7ff / (y1 − y0)⌋ + 0x7ff) (C integer division truncates),
 * then CM_Advocate::Event_Teleport("", that cell at (10, 10, 0), heading 0).
 * 0 = the click missed the marker area.
 */
export function mapClickTeleportCell(area: MapMarkerArea, px: number, py: number): number {
  const x = Math.floor(px);
  const y = Math.floor(py);
  if (x < area.x0 || x >= area.x1 || y < area.y0 || y >= area.y1) return 0;
  const lx = Math.trunc(((x - area.x0) * 0x7ff) / (area.x1 - area.x0));
  const ly = Math.trunc(((area.y0 - y) * 0x7ff) / (area.y1 - area.y0)) + 0x7ff;
  return lcoordToGid(lx, ly);
}

/** The position Event_Teleport carries for a map click: (10, 10, 0) in the cell, heading 0. */
export const MAP_TELEPORT_ORIGIN = { x: 10, y: 10, z: 0 } as const;
