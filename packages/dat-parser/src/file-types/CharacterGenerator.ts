import { DatReader } from '../DatReader.js';

// ─── Sub-structure interfaces ────────────────────────────────────────────────

export interface Position {
  readonly objCellId: number;
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly orientation: { readonly w: number; readonly x: number; readonly y: number; readonly z: number };
}

export interface StarterArea {
  readonly name: string;
  readonly locations: readonly Position[];
}

export interface SkillCG {
  readonly skillNum: number;
  readonly normalCost: number;
  readonly primaryCost: number;
}

export interface TemplateCG {
  readonly name: string;
  readonly iconImage: number;
  readonly title: number;
  readonly strength: number;
  readonly endurance: number;
  readonly coordination: number;
  readonly quickness: number;
  readonly focus: number;
  readonly self: number;
  readonly normalSkillsList: readonly number[];
  readonly primarySkillsList: readonly number[];
}

export interface SubPalette {
  readonly subId: number;
  readonly offset: number;
  readonly numColors: number;
}

export interface TextureMapChange {
  readonly partIndex: number;
  readonly oldTexture: number;
  readonly newTexture: number;
}

export interface AnimationPartChange {
  readonly partIndex: number;
  readonly partId: number;
}

export interface ObjDesc {
  readonly paletteId: number;
  readonly subPalettes: readonly SubPalette[];
  readonly textureChanges: readonly TextureMapChange[];
  readonly animPartChanges: readonly AnimationPartChange[];
}

export interface HairStyleCG {
  readonly iconImage: number;
  readonly bald: boolean;
  readonly alternateSetup: number;
  readonly objDesc: ObjDesc;
}

export interface EyeStripCG {
  readonly iconImage: number;
  readonly iconImageBald: number;
  readonly objDesc: ObjDesc;
  readonly objDescBald: ObjDesc;
}

export interface FaceStripCG {
  readonly iconImage: number;
  readonly objDesc: ObjDesc;
}

export interface GearCG {
  readonly name: string;
  readonly clothingTable: number;
  readonly weenieDefault: number;
}

export interface SexCG {
  readonly name: string;
  readonly scale: number;
  readonly setupId: number;
  readonly soundTable: number;
  readonly iconImage: number;
  readonly basePalette: number;
  readonly skinPalSet: number;
  readonly physicsTable: number;
  readonly motionTable: number;
  readonly combatTable: number;
  readonly baseObjDesc: ObjDesc;
  readonly hairColorList: readonly number[];
  readonly hairStyleList: readonly HairStyleCG[];
  readonly eyeColorList: readonly number[];
  readonly eyeStripList: readonly EyeStripCG[];
  readonly noseStripList: readonly FaceStripCG[];
  readonly mouthStripList: readonly FaceStripCG[];
  readonly headgearList: readonly GearCG[];
  readonly shirtList: readonly GearCG[];
  readonly pantsList: readonly GearCG[];
  readonly footwearList: readonly GearCG[];
  readonly clothingColorsList: readonly number[];
}

export interface HeritageGroupCG {
  readonly name: string;
  readonly iconImage: number;
  readonly setupId: number;
  readonly environmentSetupId: number;
  readonly attributeCredits: number;
  readonly skillCredits: number;
  readonly primaryStartAreas: readonly number[];
  readonly secondaryStartAreas: readonly number[];
  readonly skills: readonly SkillCG[];
  readonly templates: readonly TemplateCG[];
  readonly genders: ReadonlyMap<number, SexCG>;
}

// ─── Reader helpers ──────────────────────────────────────────────────────────

function readPosition(reader: DatReader): Position {
  return {
    objCellId: reader.readUInt32(),
    origin: {
      x: reader.readFloat32(),
      y: reader.readFloat32(),
      z: reader.readFloat32(),
    },
    orientation: {
      w: reader.readFloat32(),
      x: reader.readFloat32(),
      y: reader.readFloat32(),
      z: reader.readFloat32(),
    },
  };
}

function readStarterArea(reader: DatReader): StarterArea {
  const name = reader.readString();
  const count = reader.readCompressedUInt32();
  const locations: Position[] = [];
  for (let i = 0; i < count; i++) {
    locations.push(readPosition(reader));
  }
  return { name, locations };
}

function readObjDesc(reader: DatReader): ObjDesc {
  reader.align(4);
  reader.readUInt8(); // magic marker 0x11

  const numPalettes = reader.readUInt8();
  const numTextures = reader.readUInt8();
  const numAnimParts = reader.readUInt8();

  let paletteId = 0;
  if (numPalettes > 0) {
    paletteId = reader.readDataIdOfKnownType(0x04000000);
  }

  const subPalettes: SubPalette[] = [];
  for (let i = 0; i < numPalettes; i++) {
    const subId = reader.readDataIdOfKnownType(0x04000000);
    const rawOffset = reader.readUInt8();
    const rawNumColors = reader.readUInt8();
    subPalettes.push({
      subId,
      offset: rawOffset * 8,
      numColors: (rawNumColors === 0 ? 256 : rawNumColors) * 8,
    });
  }

  const textureChanges: TextureMapChange[] = [];
  for (let i = 0; i < numTextures; i++) {
    textureChanges.push({
      partIndex: reader.readUInt8(),
      oldTexture: reader.readDataIdOfKnownType(0x05000000),
      newTexture: reader.readDataIdOfKnownType(0x05000000),
    });
  }

  const animPartChanges: AnimationPartChange[] = [];
  for (let i = 0; i < numAnimParts; i++) {
    animPartChanges.push({
      partIndex: reader.readUInt8(),
      partId: reader.readDataIdOfKnownType(0x01000000),
    });
  }

  reader.align(4);

  return { paletteId, subPalettes, textureChanges, animPartChanges };
}

function readHairStyleCG(reader: DatReader): HairStyleCG {
  const iconImage = reader.readUInt32();
  const bald = reader.readUInt8() !== 0;
  const alternateSetup = reader.readUInt32();
  const objDesc = readObjDesc(reader);
  return { iconImage, bald, alternateSetup, objDesc };
}

function readEyeStripCG(reader: DatReader): EyeStripCG {
  const iconImage = reader.readUInt32();
  const iconImageBald = reader.readUInt32();
  const objDesc = readObjDesc(reader);
  const objDescBald = readObjDesc(reader);
  return { iconImage, iconImageBald, objDesc, objDescBald };
}

function readFaceStripCG(reader: DatReader): FaceStripCG {
  const iconImage = reader.readUInt32();
  const objDesc = readObjDesc(reader);
  return { iconImage, objDesc };
}

function readGearCG(reader: DatReader): GearCG {
  const name = reader.readString();
  const clothingTable = reader.readUInt32();
  const weenieDefault = reader.readUInt32();
  return { name, clothingTable, weenieDefault };
}

function readSmartArrayUInt32(reader: DatReader): number[] {
  const count = reader.readCompressedUInt32();
  const items: number[] = [];
  for (let i = 0; i < count; i++) {
    items.push(reader.readUInt32());
  }
  return items;
}

function readSmartArrayInt32(reader: DatReader): number[] {
  const count = reader.readCompressedUInt32();
  const items: number[] = [];
  for (let i = 0; i < count; i++) {
    items.push(reader.readInt32());
  }
  return items;
}

function readSexCG(reader: DatReader): SexCG {
  const name = reader.readString();
  const scale = reader.readUInt32();
  const setupId = reader.readUInt32();
  const soundTable = reader.readUInt32();
  const iconImage = reader.readUInt32();
  const basePalette = reader.readUInt32();
  const skinPalSet = reader.readUInt32();
  const physicsTable = reader.readUInt32();
  const motionTable = reader.readUInt32();
  const combatTable = reader.readUInt32();

  const baseObjDesc = readObjDesc(reader);

  const hairColorList = readSmartArrayUInt32(reader);

  const hairStyleCount = reader.readCompressedUInt32();
  const hairStyleList: HairStyleCG[] = [];
  for (let i = 0; i < hairStyleCount; i++) {
    hairStyleList.push(readHairStyleCG(reader));
  }

  const eyeColorList = readSmartArrayUInt32(reader);

  const eyeStripCount = reader.readCompressedUInt32();
  const eyeStripList: EyeStripCG[] = [];
  for (let i = 0; i < eyeStripCount; i++) {
    eyeStripList.push(readEyeStripCG(reader));
  }

  const noseStripCount = reader.readCompressedUInt32();
  const noseStripList: FaceStripCG[] = [];
  for (let i = 0; i < noseStripCount; i++) {
    noseStripList.push(readFaceStripCG(reader));
  }

  const mouthStripCount = reader.readCompressedUInt32();
  const mouthStripList: FaceStripCG[] = [];
  for (let i = 0; i < mouthStripCount; i++) {
    mouthStripList.push(readFaceStripCG(reader));
  }

  const headgearCount = reader.readCompressedUInt32();
  const headgearList: GearCG[] = [];
  for (let i = 0; i < headgearCount; i++) {
    headgearList.push(readGearCG(reader));
  }

  const shirtCount = reader.readCompressedUInt32();
  const shirtList: GearCG[] = [];
  for (let i = 0; i < shirtCount; i++) {
    shirtList.push(readGearCG(reader));
  }

  const pantsCount = reader.readCompressedUInt32();
  const pantsList: GearCG[] = [];
  for (let i = 0; i < pantsCount; i++) {
    pantsList.push(readGearCG(reader));
  }

  const footwearCount = reader.readCompressedUInt32();
  const footwearList: GearCG[] = [];
  for (let i = 0; i < footwearCount; i++) {
    footwearList.push(readGearCG(reader));
  }

  const clothingColorsList = readSmartArrayUInt32(reader);

  return {
    name, scale, setupId, soundTable, iconImage, basePalette, skinPalSet,
    physicsTable, motionTable, combatTable, baseObjDesc, hairColorList,
    hairStyleList, eyeColorList, eyeStripList, noseStripList, mouthStripList,
    headgearList, shirtList, pantsList, footwearList, clothingColorsList,
  };
}

function readSkillCG(reader: DatReader): SkillCG {
  return {
    skillNum: reader.readUInt32(),
    normalCost: reader.readInt32(),
    primaryCost: reader.readInt32(),
  };
}

function readTemplateCG(reader: DatReader): TemplateCG {
  const name = reader.readString();
  const iconImage = reader.readUInt32();
  const title = reader.readUInt32();
  const strength = reader.readUInt32();
  const endurance = reader.readUInt32();
  const coordination = reader.readUInt32();
  const quickness = reader.readUInt32();
  const focus = reader.readUInt32();
  const self = reader.readUInt32();
  const normalSkillsList = readSmartArrayUInt32(reader);
  const primarySkillsList = readSmartArrayUInt32(reader);
  return {
    name, iconImage, title, strength, endurance, coordination,
    quickness, focus, self, normalSkillsList, primarySkillsList,
  };
}

function readHeritageGroupCG(reader: DatReader): HeritageGroupCG {
  const name = reader.readString();
  const iconImage = reader.readUInt32();
  const setupId = reader.readUInt32();
  const environmentSetupId = reader.readUInt32();
  const attributeCredits = reader.readUInt32();
  const skillCredits = reader.readUInt32();

  const primaryStartAreas = readSmartArrayInt32(reader);
  const secondaryStartAreas = readSmartArrayInt32(reader);

  const skillCount = reader.readCompressedUInt32();
  const skills: SkillCG[] = [];
  for (let i = 0; i < skillCount; i++) {
    skills.push(readSkillCG(reader));
  }

  const templateCount = reader.readCompressedUInt32();
  const templates: TemplateCG[] = [];
  for (let i = 0; i < templateCount; i++) {
    templates.push(readTemplateCG(reader));
  }

  // Skip 1 byte flag before genders dictionary
  reader.readUInt8();

  const genderCount = reader.readCompressedUInt32();
  const genders = new Map<number, SexCG>();
  for (let i = 0; i < genderCount; i++) {
    const key = reader.readInt32();
    genders.set(key, readSexCG(reader));
  }

  return {
    name, iconImage, setupId, environmentSetupId, attributeCredits, skillCredits,
    primaryStartAreas, secondaryStartAreas, skills, templates, genders,
  };
}

// ─── Main class ──────────────────────────────────────────────────────────────

/**
 * CharacterGenerator -- character generation data from portal.dat (0x0E000002).
 * Fully parses all sub-structures including ObjDesc, HairStyleCG, EyeStripCG,
 * FaceStripCG, and GearCG with their complete data.
 *
 * Reference: ACE.DatLoader/FileTypes/CharGen.cs
 */
export class CharacterGenerator {
  readonly id: number;
  readonly starterAreas: readonly StarterArea[];
  readonly heritageGroups: ReadonlyMap<number, HeritageGroupCG>;

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();

    // Skip 4 bytes (unknown / padding)
    reader.readUInt32();

    // StarterAreas: SmartArray<StarterArea>
    const starterAreaCount = reader.readCompressedUInt32();
    const starterAreas: StarterArea[] = [];
    for (let i = 0; i < starterAreaCount; i++) {
      starterAreas.push(readStarterArea(reader));
    }
    this.starterAreas = starterAreas;

    // Skip 1 byte
    reader.readUInt8();

    // HeritageGroups: Dictionary<uint, HeritageGroupCG>
    const heritageCount = reader.readCompressedUInt32();
    const heritageGroups = new Map<number, HeritageGroupCG>();
    for (let i = 0; i < heritageCount; i++) {
      const key = reader.readUInt32();
      heritageGroups.set(key, readHeritageGroupCG(reader));
    }
    this.heritageGroups = heritageGroups;
  }
}
