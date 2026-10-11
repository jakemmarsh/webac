/**
 * Era profiles: what a server of a given era needs from the client
 * (docs/dark-majesty-support.md).
 *
 * Every live classic (Dark Majesty) server runs the end-of-retail client and
 * protocol with its own DAT set, so a profile is data, not code: the
 * LoginRequest version literal and credential encoding, and which DAT files
 * replace the end-of-retail ones. The client loads one profile's DATs per page
 * load; picking a world of another era reloads into that era (EraBoot.ts).
 *
 * Identification never trusts the iteration number alone: the Classic Dereth
 * portal reports the end-of-retail iteration (2072) with different contents,
 * so each own DAT also names a directory entry whose size differs.
 */
import { EOR_LOGIN_PROFILE, type LoginProfile, type String16Wire } from '@ac/network';

/** The end-of-retail DAT roles: every era loads each one (its own file or end of retail's). */
export type EorDatRole = 'portal' | 'cell' | 'local' | 'highres';
/**
 * Every DAT role. `worldPortal` is a second portal that serves the WORLD
 * (terrain, models, game tables) while `portal` keeps serving the interface
 * (docs/ac1999-support-scope.md Phase 1.3): only an era whose world portal is
 * a different file from its interface portal (AC1999) owns it. Absent, the
 * one portal serves both.
 */
export type DatRole = EorDatRole | 'worldPortal';

/** The default file name of each role (an era's `files` overrides it). */
export const DAT_FILE_NAMES: Readonly<Record<DatRole, string>> = Object.freeze({
  portal: 'client_portal.dat',
  cell: 'client_cell_1.dat',
  local: 'client_local_English.dat',
  highres: 'client_highres.dat',
  worldPortal: 'portal.dat',
});

/** The roles every era loads (its own file or end of retail's), in load order. */
export const EOR_DAT_ROLES: readonly EorDatRole[] = Object.freeze(['portal', 'cell', 'local', 'highres'] as EorDatRole[]);

/** Every role in load order. */
export const DAT_ROLES: readonly DatRole[] = Object.freeze(['portal', 'worldPortal', 'cell', 'local', 'highres'] as DatRole[]);

/** The file name of `role` for era `p`: its own name when it has one, else the end-of-retail name. */
export function datFileName(p: EraProfile | null | undefined, role: DatRole): string {
  return p?.files?.[role] ?? DAT_FILE_NAMES[role];
}

/** How to recognise one of a profile's own DAT files. */
export interface DatIdentity {
  /** The 0xFFFF0001 Iteration record's total (what DDD reports). */
  iterations: number;
  /**
   * A directory entry whose size is specific to this set, one size per known
   * release of it (null: the iteration is distinctive enough).
   */
  entry: { id: number; sizes: number[] } | null;
}

export interface EraProfile {
  id: string;
  /** Short name for the launcher and dialogs. */
  name: string;
  login: LoginProfile;
  /** The DATs this era replaces; every other role loads the end-of-retail file. */
  own: Partial<Record<DatRole, DatIdentity>>;
  /** The era's own file names where they differ from end of retail's (DAT_FILE_NAMES). */
  files?: Partial<Record<DatRole, string>>;
  /** Where players get the files, shown when the client asks for them. */
  source: string;
  /**
   * The heritages this era's servers let a character be, when that's fewer
   * than the DAT's CharGen lists. Every Dark Majesty-era server allows only
   * Aluvian, Gharu'ndim and Sho: GDL-Classic refuses the rest ("Only Aluvian,
   * Gharu'ndim and Sho heritages are allowed on this server",
   * reference/classic/ClassicDereth/Source/Client.cpp:426) although its DATs
   * name all thirteen. Absent = every heritage the world CharGen has.
   */
  heritages?: readonly number[];
  /**
   * How this era's server reads the client's strings (String16L): 'ace' for
   * ACE and ClassicACE, which decode them as UTF-8 characters (see
   * @ac/network setString16Wire; BUG.chat-nonascii-question-mark), else
   * Windows-1252 (GDLE-family servers keep the bytes as retail sent them).
   */
  stringWire?: 'ace';
  /**
   * The era whose hosted DATs (and DAT cache entries) this era loads, when
   * its files are another era's plus `dropSkills`. Absent = its own id.
   */
  datsOf?: string;
  /**
   * SkillTable (0x0E000004) entries the era's DATs lack although `datsOf`'s
   * files have them; served without them (EraBoot.eraPortalOverlay), so
   * chargen never trains a skill the server's table doesn't know.
   */
  dropSkills?: readonly number[];
}

export const EOR_ERA_ID = 'eor';

/** Aluvian, Gharu'ndim, Sho: the heritages of the Dark Majesty era (before Throne of Destiny). */
const DARK_MAJESTY_HERITAGES: readonly number[] = Object.freeze([1, 2, 3]);

export const ERA_PROFILES: Readonly<Record<string, EraProfile>> = Object.freeze({
  [EOR_ERA_ID]: {
    id: EOR_ERA_ID,
    name: 'End of Retail',
    login: EOR_LOGIN_PROFILE,
    own: {},
    stringWire: 'ace',
    source: '',
  },
  /**
   * ClassicACE CustomDM 1.60 (Dekarutide): ClassicACE
   * DatManager.cs CUSTOMDM_* — version "c118", portal 20044, cell 20011,
   * language 20011; highres is the end-of-retail file byte for byte.
   */
  'classicace-customdm': {
    id: 'classicace-customdm',
    name: 'ClassicACE CustomDM',
    login: { clientVersion: 'c118', authStyle: 'account-password' },
    stringWire: 'ace',
    own: {
      portal: { iterations: 20044, entry: null },
      cell: { iterations: 20011, entry: null },
      local: { iterations: 20011, entry: null },
    },
    source: 'the ClassicACE "Data Files - CustomDM 1.60" download (github.com/bDekaru/ClassicACE)',
    heritages: DARK_MAJESTY_HERITAGES,
  },
  /**
   * ClassicACE Infiltration 1.9 (Doctide): ClassicACE DatManager.cs
   * INFILTRATION_* — version "i104", portal 10006, cell 10001, language
   * 10002; highres is the end-of-retail file byte for byte. Its XpTable lists
   * 126 levels but keeps end of retail's 276 skill-credit entries; every
   * reader (retail, ACE, ours) reads by the header counts.
   */
  'classicace-infiltration': {
    id: 'classicace-infiltration',
    name: 'ClassicACE Infiltration',
    login: { clientVersion: 'i104', authStyle: 'account-password' },
    stringWire: 'ace',
    own: {
      portal: { iterations: 10006, entry: null },
      cell: { iterations: 10001, entry: null },
      local: { iterations: 10002, entry: null },
    },
    source: 'the ClassicACE "Data Files - Infiltration 1.9" download (github.com/bDekaru/ClassicACE)',
    heritages: DARK_MAJESTY_HERITAGES,
  },
  /**
   * Classic Dereth 1.1 (Seedsow, GDL-Classic; 1.0 servers use the profile below): replaces only the
   * portal and cell. The portal keeps the end-of-retail iteration 2072 —
   * identified by its SkillTable (0x0E000004; end of retail 5876).
   * Seedsow takes only auth type 1 ("account:password") and ignores the
   * version; GDL-Classic requires "1802" and accepts type 1 too.
   */
  'classic-dereth': {
    id: 'classic-dereth',
    name: 'Classic Dereth',
    login: { clientVersion: '1802', authStyle: 'account-colon-password' },
    own: {
      // SkillTable 0x0E000004: 4928 bytes in Classic Dereth 1.0 (Seedsow's
      // README set), 5064 in 1.1 (GDL-Classic's README set: "different than
      // the ones necessary for Classic Dereth 1.17 and below"); the cells of
      // 1.0 and 1.1 are byte-identical.
      portal: { iterations: 2072, entry: { id: 0x0e000004, sizes: [4928, 5064] } },
      cell: { iterations: 4, entry: null },
    },
    source: 'the "Classic Dereth - Portal and Cell" (1.0 or 1.1) download the server links to (github.com/bDekaru/ClassicDereth)',
    heritages: DARK_MAJESTY_HERITAGES,
  },
  /**
   * Classic Dereth 1.0 (Snowreap): the 1.1 files minus one thing. The two
   * sets differ only in the SkillTable, and 1.0's is 1.1's without its last
   * entry, Salvaging (40; trained, cost 0, so chargen trains it for every
   * character). A GDL server on 1.0 has no skill 40 and refuses a create
   * that trains it as Corrupt (CClient::CreateCharacter, "trained or
   * specialized skill the table lacks": reference/classic/ClassicDereth/
   * Source/Client.cpp ~500), shown as "The server cannot create your new
   * character at this time" (Jake on Snowreap, 2026-10-11). Both report
   * portal 2072 / cell 4, so DDD can't tell them apart: the bridge's compat
   * overlay names this era per server.
   */
  'classic-dereth-1-0': {
    id: 'classic-dereth-1-0',
    name: 'Classic Dereth 1.0',
    login: { clientVersion: '1802', authStyle: 'account-colon-password' },
    own: {
      portal: { iterations: 2072, entry: { id: 0x0e000004, sizes: [4928, 5064] } },
      cell: { iterations: 4, entry: null },
    },
    source: 'the "Classic Dereth - Portal and Cell" 1.0 download (github.com/bDekaru/ClassicDereth)',
    heritages: DARK_MAJESTY_HERITAGES,
    datsOf: 'classic-dereth',
    dropSkills: Object.freeze([40]),
  },
  /**
   * AC1999 (November 1999 retail; docs/ac1999-support-scope.md): the 1999
   * protocol (network era1999/), and the 1999 portal and cell for the world —
   * pre-ToD containers whose header iterations are 102 (portal) and 67 (cell)
   * on the retail CD, read through dat-parser era1999's overlay. The interface
   * (layouts, fonts, UI art, mappers) stays the end-of-retail portal, local
   * and highres DATs: `worldPortal` is a second portal, not a replacement.
   */
  'ac1999-retail': {
    id: 'ac1999-retail',
    name: '1999 launch era',
    login: { clientVersion: '4.35752', authStyle: 'account-colon-password', protocol: 'ac1999' },
    own: {
      worldPortal: { iterations: 102, entry: null },
      cell: { iterations: 67, entry: null },
    },
    files: { worldPortal: 'portal.dat', cell: 'cell.dat' },
    source: 'the November 1999 retail CD (portal.dat and cell.dat)',
  },
});

/**
 * How strings go to the server of a world the launcher picked (@ac/network
 * setString16Wire). A classic or 1999 era names its server family, so its
 * profile decides. End of retail is played on ACE (UTF-8, 'ace') and on GDL /
 * GDLE (Reefcull, Harvestbud, FunkyTown), which keep the bytes as retail sent
 * them in Windows-1252; the directory's emulator tells them apart. A world
 * with no emulator (a custom URL, local) keeps end of retail's ACE default.
 */
export function string16WireFor(era: EraProfile, emu: string | null | undefined): String16Wire {
  if (era.id !== EOR_ERA_ID) return era.stringWire ?? 'windows-1252';
  return emu === 'GDL' || emu === 'GDLE' ? 'windows-1252' : era.stringWire ?? 'windows-1252';
}

export function eraProfile(id: string | null | undefined): EraProfile | null {
  if (!id) return ERA_PROFILES[EOR_ERA_ID];
  return Object.prototype.hasOwnProperty.call(ERA_PROFILES, id) ? ERA_PROFILES[id] : null;
}

/** The roles a profile replaces, in load order. */
export function ownRoles(p: EraProfile): DatRole[] {
  return DAT_ROLES.filter((r) => p.own[r]);
}

/** The minimal view of a parsed DAT that identification needs (DatDatabase satisfies it). */
export interface DatIdentityView {
  dataSet: number;
  dataSubset: number;
  totalIterations: number;
  getFileEntry(id: number): { fileSize: number } | undefined;
}

/** Why `db` is not this profile's `role` file, or null when it is. */
export function datMismatch(p: EraProfile, role: DatRole, db: DatIdentityView): string | null {
  const want = p.own[role];
  if (!want) return null;
  const file = datFileName(p, role);
  // A world portal's header is a portal's (DataSet 1; pre-ToD: BlockSize 0x400).
  const headerRole: DatRole = role === 'worldPortal' ? 'portal' : role;
  if (roleForHeader(db.dataSet, db.dataSubset) !== headerRole) {
    const actual = roleForHeader(db.dataSet, db.dataSubset);
    return actual ? `That file is a ${DAT_FILE_NAMES[actual]}, not ${file}.` : `That file is not ${file}.`;
  }
  if (db.totalIterations !== want.iterations) {
    return `That ${file} is version ${db.totalIterations}; ${p.name} needs version ${want.iterations}.`;
  }
  if (want.entry && !want.entry.sizes.includes(db.getFileEntry(want.entry.id)?.fileSize ?? -1)) {
    return `That ${file} is not the ${p.name} one (it looks like the end-of-retail file).`;
  }
  return null;
}

/**
 * The role a DAT header names: DataSet 1 is portal (subset 0) or highres
 * (subset 0x69466948, "HiFi"), 2 is cell, 3 is the language DAT.
 */
export function roleForHeader(dataSet: number, dataSubset: number): EorDatRole | null {
  if (dataSet === 1) return dataSubset === HIGHRES_SUBSET ? 'highres' : 'portal';
  if (dataSet === 2) return 'cell';
  if (dataSet === 3) return 'local';
  return null;
}

const HIGHRES_SUBSET = 0x69466948;
