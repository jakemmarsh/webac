/**
 * Era / compatibility overlay for the launcher's world list (GET /servers).
 *
 * Servers.xml has no era field (docs/release-plan.md, "Server list"). ACE and
 * ClassicACE servers' eras are detected live from the login version they
 * accept (eraDetect.ts), and a detection result overrides an era named here
 * (serverDirectory.withDetection). An era here is the fallback until
 * detection answers (a known ClassicACE world that was offline), and the
 * only source for servers that can't be detected (GDL-Classic has no
 * version check). The client loads that era's DATs and login for them
 * (docs/dark-majesty-support.md); GDL/GDLE servers speak
 * the same EoL protocol but have not been played end to end yet
 * (RELEASE.gdle-e2e-session), so they carry a beta label.
 *
 * Keyed by Servers.xml id (case-insensitive). Evidence for each entry is the
 * listing's own description, 2026-10-04 snapshot of acresources/serverslist.
 * `registration` is a per-server note for worlds that do not create accounts
 * on first login; add one only with a source (the server's site or Discord).
 */

export type Compat = 'ok' | 'beta' | 'incompatible';

export interface CompatEntry {
  compat: Compat;
  /**
   * The era profile the server needs (packages/renderer/src/era/EraProfiles.ts);
   * absent = end of retail. The client loads that era's DATs and login.
   */
  era?: string;
  /** Short reason shown as a chip and when ENTER is refused. */
  note?: string;
  registration?: string;
}

export interface CompatOverlay {
  /** By server id (lower-cased on lookup). Wins over `byEmu`. */
  byId: Record<string, CompatEntry>;
  /** By Servers.xml `emu` value (upper-cased on lookup). */
  byEmu: Record<string, CompatEntry>;
}

/**
 * Classic (Dark Majesty) servers: the client loads the era's DAT set and
 * login (docs/dark-majesty-support.md). Beta until each has been played end
 * to end against the live server (only local GDL-Classic / ClassicACE so far).
 */
/**
 * The launcher chip for every classic (pre-Throne of Destiny) world, whatever
 * its data set (Classic Dereth, ClassicACE Infiltration or CustomDM): the era
 * players know by name, as the servers' own listings say ("A PVE Dark Majesty
 * server"). Jake, 2026-10-06: "Infiltration" (a Feb 2005 patch) meant nothing.
 */
export const CLASSIC_ERA_NOTE = 'Dark Majesty era';

const CLASSIC_DERETH: CompatEntry = { compat: 'beta', note: CLASSIC_ERA_NOTE, era: 'classic-dereth' };
const CLASSICACE_CUSTOMDM: CompatEntry = { compat: 'beta', note: CLASSIC_ERA_NOTE, era: 'classicace-customdm' };

/** The Nov 1999 launch world (AC1999 servers; docs/ac1999-support-scope.md). */
export const AC1999_ERA = 'ac1999-retail';
/**
 * The launcher chip for every AC1999 world, in player terms like
 * CLASSIC_ERA_NOTE ("Dark Majesty era"): the era as it launched.
 */
export const AC1999_ERA_NOTE = '1999 launch era';
/**
 * AC1999 servers are not in Servers.xml; the bridge lists them itself
 * (serverList.ac1999Overlay) with emu "AC1999". They speak the 1999 protocol
 * (one UDP port), so beta until one has been played end to end through us.
 */
export const AC1999_COMPAT: CompatEntry = { compat: 'beta', note: AC1999_ERA_NOTE, era: AC1999_ERA };

/**
 * Eras the end-of-retail login probe (eraDetect.ts) must never touch: a 1999
 * server speaks another protocol and auto-creates an account for any login.
 */
export const NO_PROBE_ERAS: ReadonlySet<string> = new Set([AC1999_ERA]);

export const SERVER_COMPAT: CompatOverlay = {
  byId: {
    // "A PVE Dark Majesty server must use classic AC .dats"
    '394c58d0-885d-466b-b17f-d7e0b96fe3e2': CLASSIC_DERETH, // Seedsow
    // "A PVP Dark Majesty server must use classic AC .dats"
    'eea962c0-cf9f-481e-9736-0eb058acc1d8': CLASSIC_DERETH, // Snowreap
    // ClassicACE: detected live once they answer; until then, their listings'
    // own words. "ACE-Classic Dark Majesty era custom PVE server"
    '4db379b0-587a-4775-9b7f-879e0f15ba4b': CLASSICACE_CUSTOMDM, // Dekarutide
    // "... CustomDM Client ..." (its public fork expects "c111"; detection corrects it)
    '3f1f41ec-c7fd-4ed9-b47d-25b0d94219c1': CLASSICACE_CUSTOMDM, // Unfamiliar Shores
  },
  byEmu: {
    GDL: { compat: 'beta', note: 'GDLE: beta' },
    GDLE: { compat: 'beta', note: 'GDLE: beta' },
    AC1999: AC1999_COMPAT,
  },
};

export function compatFor(id: string, emu: string, overlay: CompatOverlay = SERVER_COMPAT): CompatEntry {
  return overlay.byId[id.toLowerCase()] ?? overlay.byEmu[emu.toUpperCase()] ?? { compat: 'ok' };
}
