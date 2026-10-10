/**
 * File type prefixes — the high byte of ObjectId in portal.dat.
 * From DatFile.cs GetFileType().
 */
export enum PortalFileType {
  GraphicsObject = 0x01,
  Setup = 0x02,
  Animation = 0x03,
  Palette = 0x04,
  SurfaceTexture = 0x05,
  Texture = 0x06,
  Surface = 0x08,
  MotionTable = 0x09,
  Wave = 0x0a,
  Environment = 0x0d,
  PaletteSet = 0x0f,
  Clothing = 0x10,
  DegradeInfo = 0x11,
  Scene = 0x12,
  Region = 0x13,
  KeyMap = 0x14,
  RenderTexture = 0x15,
  RenderMaterial = 0x16,
  MaterialModifier = 0x17,
  MaterialInstance = 0x18,
  SoundTable = 0x20,
  EnumMapper = 0x22,
  DidMapper = 0x25,
  ActionMap = 0x26,
  DualDidMapper = 0x27,
  CombatTable = 0x30,
  String = 0x31,
  ParticleEmitter = 0x32,
  PhysicsScript = 0x33,
  PhysicsScriptTable = 0x34,
  MasterProperty = 0x39,
  Font = 0x40,
  DbProperties = 0x78,
}

/**
 * Cell DAT file types — determined by the low 16 bits of ObjectId.
 */
export enum CellFileType {
  LandBlock = 0xffff,
  LandBlockInfo = 0xfffe,
  // EnvCell = 0x0001 to 0xFFFD
}

/**
 * Special portal.dat file IDs for singleton tables.
 */
export const SpecialFileIds = {
  CharacterGenerator: 0x0e000002,
  SecondaryAttributeTable: 0x0e000003,
  SkillTable: 0x0e000004,
  ChatPoseTable: 0x0e000007,
  ObjectHierarchy: 0x0e00000d,
  SpellTable: 0x0e00000e,
  SpellComponentTable: 0x0e00000f,
  XpTable: 0x0e000018,
  BadData: 0x0e00001a,
  ContractTable: 0x0e00001d,
  TabooTable: 0x0e00001e,
  FileToId: 0x0e00001f,
  NameFilterTable: 0x0e000020,
} as const;
