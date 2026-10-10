import { DatReader } from '../DatReader.js';

// ─── Sub-entities ─────────────────────────────────────────────────

export interface TimeOfDay {
  start: number;
  isNight: boolean;
  name: string;
}

export interface Season {
  startDate: number;
  name: string;
}

export interface GameTime {
  zeroTimeOfYear: number;
  zeroYear: number;
  dayLength: number;
  daysPerYear: number;
  yearSpec: string;
  timesOfDay: TimeOfDay[];
  daysOfTheWeek: string[];
  seasons: Season[];
}

export interface SkyObjectReplace {
  objectIndex: number;
  gfxObjId: number;
  rotate: number;
  transparent: number;
  luminosity: number;
  maxBright: number;
}

export interface SkyTimeOfDay {
  begin: number;
  dirBright: number;
  dirHeading: number;
  dirPitch: number;
  dirColor: number;
  ambBright: number;
  ambColor: number;
  minWorldFog: number;
  maxWorldFog: number;
  worldFogColor: number;
  worldFog: number;
  skyObjReplace: SkyObjectReplace[];
}

export interface SkyObject {
  beginTime: number;
  endTime: number;
  beginAngle: number;
  endAngle: number;
  texVelocityX: number;
  texVelocityY: number;
  defaultGFXObjectId: number;
  defaultPESObjectId: number;
  properties: number;
}

export interface DayGroup {
  chanceOfOccur: number;
  dayName: string;
  skyObjects: SkyObject[];
  skyTime: SkyTimeOfDay[];
}

export interface SkyDesc {
  tickSize: number;
  lightTickSize: number;
  dayGroups: DayGroup[];
}

export interface AmbientSoundDesc {
  sType: number;
  volume: number;
  baseChance: number;
  minRate: number;
  maxRate: number;
}

export interface AmbientSTBDesc {
  stbId: number;
  ambientSounds: AmbientSoundDesc[];
}

export interface SoundDesc {
  stbDesc: AmbientSTBDesc[];
}

export interface SceneType {
  stbIndex: number;
  scenes: number[];
}

export interface SceneDesc {
  sceneTypes: SceneType[];
}

export interface TerrainAlphaMap {
  tCode: number;
  texGID: number;
}

export interface RoadAlphaMap {
  rCode: number;
  roadTexGID: number;
}

export interface TerrainTex {
  texGID: number;
  texTiling: number;
  maxVertBright: number;
  minVertBright: number;
  maxVertSaturate: number;
  minVertSaturate: number;
  maxVertHue: number;
  minVertHue: number;
  detailTexTiling: number;
  detailTexGID: number;
}

export interface TMTerrainDesc {
  terrainType: number;
  terrainTex: TerrainTex;
}

export interface TexMerge {
  baseTexSize: number;
  cornerTerrainMaps: TerrainAlphaMap[];
  sideTerrainMaps: TerrainAlphaMap[];
  roadMaps: RoadAlphaMap[];
  terrainDesc: TMTerrainDesc[];
}

export interface LandSurf {
  type: number;
  texMerge: TexMerge | null;
}

export interface TerrainType {
  terrainName: string;
  terrainColor: number;
  sceneTypes: number[];
}

export interface TerrainDesc {
  terrainTypes: TerrainType[];
  landSurfaces: LandSurf;
}

export interface LandDefs {
  numBlockLength: number;
  numBlockWidth: number;
  squareLength: number;
  lBlockLength: number;
  vertexPerCell: number;
  maxObjHeight: number;
  skyHeight: number;
  roadWidth: number;
  landHeightTable: Float32Array;
}

export interface RegionMisc {
  version: number;
  gameMapID: number;
  autotestMapId: number;
  autotestMapSize: number;
  clearCellId: number;
  clearMonsterId: number;
}

// ─── Reader Functions ─────────────────────────────────────────────

function readTimeOfDay(reader: DatReader): TimeOfDay {
  const start = reader.readFloat32();
  const isNight = reader.readUInt32() !== 0;
  const name = reader.readPString(); reader.align(4);
  return { start, isNight, name };
}

function readSeason(reader: DatReader): Season {
  const startDate = reader.readUInt32();
  const name = reader.readPString(); reader.align(4);
  return { startDate, name };
}

function readGameTime(reader: DatReader): GameTime {
  const zeroTimeOfYear = reader.readFloat64();
  const zeroYear = reader.readUInt32();
  const dayLength = reader.readFloat32();
  const daysPerYear = reader.readUInt32();
  const yearSpec = reader.readPString(); reader.align(4);

  const numTimesOfDay = reader.readUInt32();
  const timesOfDay: TimeOfDay[] = [];
  for (let i = 0; i < numTimesOfDay; i++) {
    timesOfDay.push(readTimeOfDay(reader));
  }

  const numDaysOfTheWeek = reader.readUInt32();
  const daysOfTheWeek: string[] = [];
  for (let i = 0; i < numDaysOfTheWeek; i++) {
    daysOfTheWeek.push(reader.readPString()); reader.align(4);
  }

  const numSeasons = reader.readUInt32();
  const seasons: Season[] = [];
  for (let i = 0; i < numSeasons; i++) {
    seasons.push(readSeason(reader));
  }

  return { zeroTimeOfYear, zeroYear, dayLength, daysPerYear, yearSpec, timesOfDay, daysOfTheWeek, seasons };
}

function readSkyObjectReplace(reader: DatReader): SkyObjectReplace {
  return {
    objectIndex: reader.readUInt32(),
    gfxObjId: reader.readUInt32(),
    rotate: reader.readFloat32(),
    transparent: reader.readFloat32(),
    luminosity: reader.readFloat32(),
    maxBright: reader.readFloat32(),
  };
}

function readSkyTimeOfDay(reader: DatReader): SkyTimeOfDay {
  const begin = reader.readFloat32();
  const dirBright = reader.readFloat32();
  const dirHeading = reader.readFloat32();
  const dirPitch = reader.readFloat32();
  const dirColor = reader.readUInt32();
  const ambBright = reader.readFloat32();
  const ambColor = reader.readUInt32();
  const minWorldFog = reader.readFloat32();
  const maxWorldFog = reader.readFloat32();
  const worldFogColor = reader.readUInt32();
  const worldFog = reader.readUInt32();

  const numReplace = reader.readUInt32();
  const skyObjReplace: SkyObjectReplace[] = [];
  for (let i = 0; i < numReplace; i++) {
    skyObjReplace.push(readSkyObjectReplace(reader));
  }

  return {
    begin, dirBright, dirHeading, dirPitch, dirColor,
    ambBright, ambColor, minWorldFog, maxWorldFog,
    worldFogColor, worldFog, skyObjReplace,
  };
}

function readSkyObject(reader: DatReader): SkyObject {
  return {
    beginTime: reader.readFloat32(),
    endTime: reader.readFloat32(),
    beginAngle: reader.readFloat32(),
    endAngle: reader.readFloat32(),
    texVelocityX: reader.readFloat32(),
    texVelocityY: reader.readFloat32(),
    defaultGFXObjectId: reader.readUInt32(),
    defaultPESObjectId: reader.readUInt32(),
    properties: reader.readUInt32(),
  };
}

function readDayGroup(reader: DatReader): DayGroup {
  const chanceOfOccur = reader.readFloat32();
  const dayName = reader.readPString(); reader.align(4);

  const numSkyObjects = reader.readUInt32();
  const skyObjects: SkyObject[] = [];
  for (let i = 0; i < numSkyObjects; i++) {
    skyObjects.push(readSkyObject(reader));
  }

  const numSkyTime = reader.readUInt32();
  const skyTime: SkyTimeOfDay[] = [];
  for (let i = 0; i < numSkyTime; i++) {
    skyTime.push(readSkyTimeOfDay(reader));
  }

  return { chanceOfOccur, dayName, skyObjects, skyTime };
}

function readSkyDesc(reader: DatReader): SkyDesc {
  const tickSize = reader.readFloat64();
  const lightTickSize = reader.readFloat64();

  const numDayGroups = reader.readUInt32();
  const dayGroups: DayGroup[] = [];
  for (let i = 0; i < numDayGroups; i++) {
    dayGroups.push(readDayGroup(reader));
  }

  return { tickSize, lightTickSize, dayGroups };
}

function readAmbientSoundDesc(reader: DatReader): AmbientSoundDesc {
  return {
    sType: reader.readUInt32(),
    volume: reader.readFloat32(),
    baseChance: reader.readFloat32(),
    minRate: reader.readFloat32(),
    maxRate: reader.readFloat32(),
  };
}

function readAmbientSTBDesc(reader: DatReader): AmbientSTBDesc {
  const stbId = reader.readUInt32();
  const numSounds = reader.readUInt32();
  const ambientSounds: AmbientSoundDesc[] = [];
  for (let i = 0; i < numSounds; i++) {
    ambientSounds.push(readAmbientSoundDesc(reader));
  }
  return { stbId, ambientSounds };
}

function readSoundDesc(reader: DatReader): SoundDesc {
  const numStb = reader.readUInt32();
  const stbDesc: AmbientSTBDesc[] = [];
  for (let i = 0; i < numStb; i++) {
    stbDesc.push(readAmbientSTBDesc(reader));
  }
  return { stbDesc };
}

function readSceneType(reader: DatReader): SceneType {
  const stbIndex = reader.readUInt32();
  const numScenes = reader.readInt32();
  const scenes: number[] = [];
  for (let i = 0; i < numScenes; i++) {
    scenes.push(reader.readUInt32());
  }
  return { stbIndex, scenes };
}

function readSceneDesc(reader: DatReader): SceneDesc {
  const numSceneTypes = reader.readUInt32();
  const sceneTypes: SceneType[] = [];
  for (let i = 0; i < numSceneTypes; i++) {
    sceneTypes.push(readSceneType(reader));
  }
  return { sceneTypes };
}

function readTerrainAlphaMap(reader: DatReader): TerrainAlphaMap {
  return {
    tCode: reader.readUInt32(),
    texGID: reader.readUInt32(),
  };
}

function readRoadAlphaMap(reader: DatReader): RoadAlphaMap {
  return {
    rCode: reader.readUInt32(),
    roadTexGID: reader.readUInt32(),
  };
}

function readTerrainTex(reader: DatReader): TerrainTex {
  return {
    texGID: reader.readUInt32(),
    texTiling: reader.readUInt32(),
    maxVertBright: reader.readUInt32(),
    minVertBright: reader.readUInt32(),
    maxVertSaturate: reader.readUInt32(),
    minVertSaturate: reader.readUInt32(),
    maxVertHue: reader.readUInt32(),
    minVertHue: reader.readUInt32(),
    detailTexTiling: reader.readUInt32(),
    detailTexGID: reader.readUInt32(),
  };
}

function readTMTerrainDesc(reader: DatReader): TMTerrainDesc {
  return {
    terrainType: reader.readUInt32(),
    terrainTex: readTerrainTex(reader),
  };
}

function readTexMerge(reader: DatReader): TexMerge {
  const baseTexSize = reader.readUInt32();

  const numCorner = reader.readUInt32();
  const cornerTerrainMaps: TerrainAlphaMap[] = [];
  for (let i = 0; i < numCorner; i++) {
    cornerTerrainMaps.push(readTerrainAlphaMap(reader));
  }

  const numSide = reader.readUInt32();
  const sideTerrainMaps: TerrainAlphaMap[] = [];
  for (let i = 0; i < numSide; i++) {
    sideTerrainMaps.push(readTerrainAlphaMap(reader));
  }

  const numRoad = reader.readUInt32();
  const roadMaps: RoadAlphaMap[] = [];
  for (let i = 0; i < numRoad; i++) {
    roadMaps.push(readRoadAlphaMap(reader));
  }

  const numTerrain = reader.readUInt32();
  const terrainDesc: TMTerrainDesc[] = [];
  for (let i = 0; i < numTerrain; i++) {
    terrainDesc.push(readTMTerrainDesc(reader));
  }

  return { baseTexSize, cornerTerrainMaps, sideTerrainMaps, roadMaps, terrainDesc };
}

function readLandSurf(reader: DatReader): LandSurf {
  const type = reader.readUInt32();
  if (type === 1) {
    // PalShift — never observed in real data, skip
    return { type, texMerge: null };
  }
  return { type, texMerge: readTexMerge(reader) };
}

function readTerrainType(reader: DatReader): TerrainType {
  const terrainName = reader.readPString(); reader.align(4);
  const terrainColor = reader.readUInt32();
  const numSceneTypes = reader.readInt32();
  const sceneTypes: number[] = [];
  for (let i = 0; i < numSceneTypes; i++) {
    sceneTypes.push(reader.readUInt32());
  }
  return { terrainName, terrainColor, sceneTypes };
}

function readTerrainDesc(reader: DatReader): TerrainDesc {
  const numTerrainTypes = reader.readUInt32();
  const terrainTypes: TerrainType[] = [];
  for (let i = 0; i < numTerrainTypes; i++) {
    terrainTypes.push(readTerrainType(reader));
  }
  const landSurfaces = readLandSurf(reader);
  return { terrainTypes, landSurfaces };
}

function readLandDefs(reader: DatReader): LandDefs {
  const numBlockLength = reader.readInt32();
  const numBlockWidth = reader.readInt32();
  const squareLength = reader.readFloat32();
  const lBlockLength = reader.readInt32();
  const vertexPerCell = reader.readInt32();
  const maxObjHeight = reader.readFloat32();
  const skyHeight = reader.readFloat32();
  const roadWidth = reader.readFloat32();

  const landHeightTable = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    landHeightTable[i] = reader.readFloat32();
  }

  return {
    numBlockLength, numBlockWidth, squareLength, lBlockLength,
    vertexPerCell, maxObjHeight, skyHeight, roadWidth, landHeightTable,
  };
}

function readRegionMisc(reader: DatReader): RegionMisc {
  return {
    version: reader.readUInt32(),
    gameMapID: reader.readUInt32(),
    autotestMapId: reader.readUInt32(),
    autotestMapSize: reader.readUInt32(),
    clearCellId: reader.readUInt32(),
    clearMonsterId: reader.readUInt32(),
  };
}

// ─── Main RegionDesc ──────────────────────────────────────────────

export class RegionDesc {
  id: number;
  regionNumber: number;
  version: number;
  regionName: string;
  landDefs: LandDefs;
  gameTime: GameTime;
  partsMask: number;
  skyInfo: SkyDesc | null;
  soundInfo: SoundDesc | null;
  sceneInfo: SceneDesc | null;
  terrainInfo: TerrainDesc;
  regionMisc: RegionMisc | null;

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();
    this.regionNumber = reader.readUInt32();
    this.version = reader.readUInt32();
    this.regionName = reader.readPString(); reader.align(4);

    this.landDefs = readLandDefs(reader);
    this.gameTime = readGameTime(reader);

    this.partsMask = reader.readUInt32();

    this.skyInfo = (this.partsMask & 0x10) !== 0 ? readSkyDesc(reader) : null;
    this.soundInfo = (this.partsMask & 0x01) !== 0 ? readSoundDesc(reader) : null;
    this.sceneInfo = (this.partsMask & 0x02) !== 0 ? readSceneDesc(reader) : null;

    this.terrainInfo = readTerrainDesc(reader);

    this.regionMisc = (this.partsMask & 0x0200) !== 0 ? readRegionMisc(reader) : null;
  }
}
