export { DatReader } from './DatReader.js';
export { DatDatabase } from './DatDatabase.js';
export type { DatFileEntry, DatHeader } from './DatDatabase.js';
export { RangedDat, DatFileSubset, httpRangeFetcher } from './RangedDat.js';
export type { RangeFetcher, DatFileSource } from './RangedDat.js';
export { Iteration, ITERATION_FILE_ID } from './file-types/Iteration.js';
export { PortalFileType, CellFileType, SpecialFileIds } from './DatFileType.js';
export { DxtUtil } from './file-types/DxtUtil.js';
export { Texture, SurfacePixelFormat } from './file-types/Texture.js';
export { Palette } from './file-types/Palette.js';
export { SurfaceTexture } from './file-types/SurfaceTexture.js';
export { RenderTexture } from './file-types/RenderTexture.js';
export { QualityFilter, QUALITY_FILTER_ID_PREFIX } from './file-types/QualityFilter.js';
export { BadData } from './file-types/BadData.js';
export { Surface, SurfaceType } from './file-types/Surface.js';
export { CellLandblock } from './file-types/CellLandblock.js';
export { GfxObj, GfxObjFlags } from './file-types/GfxObj.js';
export { SetupModel, SetupFlags } from './file-types/SetupModel.js';
export { readFrame } from './file-types/Frame.js';
export type { Frame } from './file-types/Frame.js';
export { readSWVertex, readCVertexArray } from './file-types/Vertex.js';
export type { SWVertex, UV, CVertexArray } from './file-types/Vertex.js';
export { readPolygon, StipplingType } from './file-types/Polygon.js';
export type { Polygon } from './file-types/Polygon.js';
export { readBSPTree, readBSPNode, BSPType } from './file-types/BSPTree.js';
export type { BSPTree, BSPNodeBase, BSPInternalNode, BSPLeafNode, BSPPortalNode, Plane, Sphere } from './file-types/BSPTree.js';
export { readAnimationHook, readAnimationFrame, AnimationHookType } from './file-types/AnimationHook.js';
export type { AnimationHook, AnimationFrame } from './file-types/AnimationHook.js';
export { Animation, AnimationFlags } from './file-types/Animation.js';
export { MotionTable, MotionDataFlags } from './file-types/MotionTable.js';
export type { MotionData, AnimData } from './file-types/MotionTable.js';
export { Wave } from './file-types/Wave.js';
export { EnvCell, EnvCellFlags } from './file-types/EnvCell.js';
export type { CellPortal, Stab } from './file-types/EnvCell.js';
export { Environment } from './file-types/Environment.js';
export type { CellStruct } from './file-types/Environment.js';
export { LandblockInfo } from './file-types/LandblockInfo.js';
export type { BuildInfo, CBldPortal } from './file-types/LandblockInfo.js';

// Phase 8: Game data tables
export { SpellTable } from './file-types/SpellTable.js';
export type { SpellBase, SpellSet } from './file-types/SpellTable.js';
export { SpellComponentTable } from './file-types/SpellComponentTable.js';
export type { SpellComponentBase } from './file-types/SpellComponentTable.js';
export { SkillTable, skillTableWithout } from './file-types/SkillTable.js';
export type { SkillBase, SkillFormula } from './file-types/SkillTable.js';
export { XpTable } from './file-types/XpTable.js';
export { SecondaryAttributeTable } from './file-types/SecondaryAttributeTable.js';
// CharGen (0x0E000002) — ACE FileTypes/CharGen.cs. The one parser; the old
// partial duplicate (CharGen.ts, counts-only SexCG) was deleted.
export { CharacterGenerator } from './file-types/CharacterGenerator.js';
export type {
  HeritageGroupCG, SexCG, TemplateCG, SkillCG, StarterArea,
  Position as CharGenPosition, ObjDesc, SubPalette, TextureMapChange,
  AnimationPartChange, HairStyleCG, EyeStripCG, FaceStripCG, GearCG,
} from './file-types/CharacterGenerator.js';
export { ClothingTable } from './file-types/ClothingTable.js';
export type { ClothingBaseEffect, CloObjectEffect, CloTextureEffect, CloSubPalEffect, CloSubPalette } from './file-types/ClothingTable.js';
export { CombatManeuverTable } from './file-types/CombatManeuverTable.js';
export type { CombatManeuver } from './file-types/CombatManeuverTable.js';
export { PaletteSet } from './file-types/PaletteSet.js';
export { ParticleEmitterInfo, EmitterType, ParticleType } from './file-types/ParticleEmitterInfo.js';
export { RegionDesc } from './file-types/RegionDesc.js';
export {
  Scene, ObjectDesc, onRoad,
  SCENERY_CELL_LENGTH, SCENERY_BLOCK_LENGTH, SCENERY_BLOCK_SIDE,
  SCENERY_VERTEX_DIM, SCENERY_ROAD_WIDTH,
} from './file-types/Scene.js';
export { ChatPoseTable } from './file-types/ChatPoseTable.js';
export type { ChatEmoteData } from './file-types/ChatPoseTable.js';
export { ContractTable } from './file-types/ContractTable.js';
export type { Contract, Position as ContractPosition } from './file-types/ContractTable.js';
export { GeneratorTable } from './file-types/GeneratorTable.js';
export type { Generator } from './file-types/GeneratorTable.js';
export { GfxObjDegradeInfo } from './file-types/GfxObjDegradeInfo.js';
export type { GfxObjLOD } from './file-types/GfxObjDegradeInfo.js';
export { LanguageString } from './file-types/LanguageString.js';
export { ActionMap } from './file-types/ActionMap.js';
export type { ActionMapValue, UserBindingValue, InputMapConflictsValue } from './file-types/ActionMap.js';
export { KeyMap, KEYMAP_GAME_DEFAULT_ID, KEYMAP_ENGINE_DEFAULT_ID } from './file-types/KeyMap.js';
export type { ControlSpecification, KeyMapMetaKey, KeyMapBinding, KeyMapDevice } from './file-types/KeyMap.js';
export { DbProperty } from './file-types/DbProperty.js';
export { LanguageInfo } from './file-types/LanguageInfo.js';
export type { LanguageInfoData } from './file-types/LanguageInfo.js';
export { PhysicsScript, PhysicsScriptTable, selectPhysicsScriptByIntensity } from './file-types/PhysicsScript.js';
export type { PhysicsScriptStep, PhysicsScriptModEntry } from './file-types/PhysicsScript.js';
export { NameFilterTable } from './file-types/NameFilterTable.js';
export type { NameFilterLanguageData } from './file-types/NameFilterTable.js';
export { TabooTable } from './file-types/TabooTable.js';
export type { TabooTableEntry } from './file-types/TabooTable.js';
export { SoundTable } from './file-types/SoundTable.js';
export type { SoundTableData, SoundData } from './file-types/SoundTable.js';
export type {
  LandDefs, TerrainDesc, TerrainType, LandSurf, TexMerge,
  TMTerrainDesc, TerrainTex, TerrainAlphaMap, RoadAlphaMap,
  SkyDesc, SoundDesc, SceneDesc, GameTime, RegionMisc,
} from './file-types/RegionDesc.js';

// UI Layout (language DAT)
export {
  parseLayoutDesc, parseStringTable, parseMasterProperty, setMasterPropertyTypes,
  registerStringTable, getString, getStringFromTable, getStringParts, getStringPartsFromTable, acStringHash, unescapeStringTableText,
  resolveElementDesc, resolveElementTree, resolveLayoutDesc, reflowEdgeAnchoredRect, applyAttachTimeAnchors,
  IncorporationFlags, MediaType, BasePropertyType,
} from './file-types/LayoutDesc.js';
export type {
  LayoutDescData, ElementDesc, StateDesc, MediaDesc as UIMediaDesc, LayoutLoader, EdgeAnchoredRect,
  BaseProperty as UIBaseProperty, StringInfo as UIStringInfo,
  StringTableData, StringTableEntry, MasterPropertyDesc,
} from './file-types/LayoutDesc.js';
export { ac1999PortalOverlay, ac1999CellOverlay, AC1999_OVERLAY_KIND, AC1999_UNTRANSLATED_COPIES } from './era1999/Ac1999Overlay.js';
export type { Patches1999, Ac1999OverlayOptions, Ac1999DatOverlay } from './era1999/Ac1999Overlay.js';
export { readCharGen1999Text } from './era1999/Tables1999.js';
export type { CharGen1999Text } from './era1999/Tables1999.js';
export type { DatOverlay, DatContainer } from './DatDatabase.js';
