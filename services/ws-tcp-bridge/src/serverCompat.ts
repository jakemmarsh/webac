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
 * on first login, and `registrationUrl` the page where players register (the
 * launcher links it); add one only with a source (the server's site or Discord).
 */

export type Compat = 'ok' | 'beta' | 'incompatible';

export interface CompatEntry {
  compat: Compat;
  /**
   * The era profile the server needs (packages/renderer/src/era/EraProfiles.ts);
   * absent = end of retail. The client loads that era's DATs and login.
   */
  era?: string;
  /** Short reason shown as a chip in the launcher's world details. */
  note?: string;
  /**
   * compat 'incompatible' only: one sentence saying why nobody can play
   * there from webAC, shown in the world details and when ENTER is refused
   * (DirectoryEntry.compatReason). A page that predates it refuses ENTER
   * on `compat` alone.
   */
  reason?: string;
  /** One line telling a new player to register before the first login. */
  registration?: string;
  /** Where to register (http/https); the launcher links it. */
  registrationUrl?: string;
  /**
   * A short warning (at most the 2 lines the launcher's details box has, the
   * length of the Reefcull registration note) for a world players CAN enter
   * but where something they'd expect doesn't work from webAC. Shown in warn
   * colour where the new-player hint goes. Unlike `reason` it never refuses
   * ENTER.
   */
  warning?: string;
  /**
   * The server caps accounts created from, and sessions online at once from,
   * one IP address. Every webAC player reaches it from the bridge's single
   * egress address, so the caps apply to all webAC players together. The
   * launcher reads its login refusals in that light (a ClientLogOnFailed is a
   * refused new account, a ServerFull is the session cap): renderer
   * launcher/worldDirectory.ts loginFailureText.
   */
  perIpLimits?: PerIpLimits;
}

/** Per-IP caps (0 = unlimited), as the server's own config names them. */
export interface PerIpLimits {
  /** max_accounts_per_ip: accounts ever created from one address. */
  accounts: number;
  /** max_sessions_per_ip: clients online at once from one address. */
  sessions: number;
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

/**
 * Classic Dereth 1.0 data (no Salvaging skill): the client serves the 1.1
 * set's SkillTable without it (renderer era/EraProfiles.ts
 * 'classic-dereth-1-0'). Both sets report the same DDD iterations, so only
 * the server's refusal tells them apart: Snowreap answered every 1.1 create
 * (Salvaging trained) with Corrupt (Jake, 2026-10-11), and so does Seedsow
 * (same host): on 2026-10-12 a create with Salvaging trained got Corrupt (5)
 * and the same create without it got Ok, one account, minutes apart
 * (tools/probe-gdl-chargen.ts). Classic Dereth 1.1 ('classic-dereth') stays
 * the era of a GDL-Classic server on its README's 1.1 set (our local one).
 */
const CLASSIC_DERETH_1_0: CompatEntry = { compat: 'beta', note: CLASSIC_ERA_NOTE, era: 'classic-dereth-1-0' };
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
 * The public AC1999 server (ac1999.cobradragon.com) since upstream commit
 * 11e7463f "Enforce a two account limit" (2026-10-12): max_accounts_per_ip=2
 * and max_sessions_per_ip=2 (Server/Bin/server.cfg.example; DatabaseIO.cpp
 * CreateAccount counts accounts.created_ip_address, Network.cpp
 * AcceptClientLogin counts live clients). The bridge's one egress address
 * used its two accounts long ago, so a new account through webAC is refused
 * with STR_LOGIN_FAILED (ClientLogOnFailed; a fresh account through the
 * production bridge, 2026-10-13), and a third webAC player online at once
 * gets STR_LOGIN_SERVER_FULL. Existing accounts still log in, so the world
 * stays enterable. An `ip_limit_overrides` row for the bridge's address lifts
 * both (docs/operators.md); drop `perIpLimits` and `warning` once it exists.
 * Only the public id: our local server (ac1999-local) keeps AC1999_COMPAT.
 */
export const AC1999_PUBLIC_COMPAT: CompatEntry = {
  ...AC1999_COMPAT,
  warning: "Existing accounts only: webAC can't create new ones here yet.",
  perIpLimits: { accounts: 2, sessions: 2 },
};

/**
 * Eras the end-of-retail login probe (eraDetect.ts) must never touch: a 1999
 * server speaks another protocol and auto-creates an account for any login.
 */
export const NO_PROBE_ERAS: ReadonlySet<string> = new Set([AC1999_ERA]);

const GDLE_BETA: CompatEntry = { compat: 'beta', note: 'GDLE: beta' };

/**
 * GDLE worlds whose accounts exist only after a web-form registration (email
 * plus reCAPTCHA; first-login auto-create is off): a fresh account's login
 * just times out. Source: gdleac.com "Step 4: Account Creation" links each
 * world's form, and the forms say not to use capital letters
 * (docs/gdle-compat.md, "Public servers").
 */
function gdleWebRegistration(name: string, url: string): CompatEntry {
  return {
    ...GDLE_BETA,
    registration: `Register on the ${name} website first (lower-case names only).`,
    registrationUrl: url,
  };
}

/**
 * A world whose anti-VPN / IP-reputation check refuses the hosted bridge's
 * egress (a cloud data-centre address), so it refuses every webAC player.
 * Listed, but ENTER is refused with this reason instead of leaving players
 * held in portal space or booted at login. Remove the entry once the
 * operator exempts the bridge (docs/operators.md, "If your world blocks VPNs
 * or proxies"); tools/probe-world-access.ts re-checks a world.
 */
export const VPN_BLOCK: CompatEntry = {
  compat: 'incompatible',
  note: 'Blocks webAC',
  // Fits the launcher's 2-line details note. The long-term fix: an ACE change so a
  // trusted relay (the bridge) can pass the player's real address to the VPN check.
  reason: "Its VPN check refuses webAC players. We're working on a fix.",
};

export const SERVER_COMPAT: CompatOverlay = {
  byId: {
    // "A PVE Dark Majesty server must use classic AC .dats"
    '394c58d0-885d-466b-b17f-d7e0b96fe3e2': CLASSIC_DERETH_1_0, // Seedsow (1.0 data, 2026-10-12)
    // "A PVP Dark Majesty server must use classic AC .dats"
    'eea962c0-cf9f-481e-9736-0eb058acc1d8': CLASSIC_DERETH_1_0, // Snowreap
    // ClassicACE: detected live once they answer; until then, their listings'
    // own words. "ACE-Classic Dark Majesty era custom PVE server"
    '4db379b0-587a-4775-9b7f-879e0f15ba4b': CLASSICACE_CUSTOMDM, // Dekarutide
    // "... CustomDM Client ..." (its public fork expects "c111"; detection corrects it)
    '3f1f41ec-c7fd-4ed9-b47d-25b0d94219c1': CLASSICACE_CUSTOMDM, // Unfamiliar Shores
    // Web-form registration only (byId wins over byEmu, so these repeat GDLE_BETA).
    'a7502ac9-0cec-4caf-b81c-b3eb40a4689a': gdleWebRegistration('Reefcull', 'http://reefcull.gdleac.com/'),
    'f023fbf9-caab-4745-8205-81c4d7c061ad': gdleWebRegistration('Harvestbud', 'http://harvestbud.gdleac.com/'),
    // VPN/proxy checks that refuse the bridge (tools/probe-world-access.ts, 2026-10-12).
    // In the world, chat: "VPN/Proxy connections are not permitted on this
    // server. Please disconnect from your VPN and try again."; held in portal space.
    '2d7bfb40-7726-4951-b65f-b4948807e602': VPN_BLOCK, // Conquest
    // At login: "You have been booted from Asheron's Call Connections from
    // VPN / proxy disallowed by server policy."
    '9d17ce44-7db5-40c1-b7bb-a01c9de21d00': VPN_BLOCK, // AChard
    // ACE (a DocTide fork), play.jawntide.com:9000. Prod logs 2026-10-22..29: 9
    // login_refused with token boot_other across 6 players, 0 char_list, 0
    // enter_ok; its version check passes (a login probe gets AccountDoesntExist).
    // Its website: "Connections: No VPNs or proxies" and "Up to 2 accounts
    // logged in at a time per person". The boot text itself wasn't captured
    // (the client logs only the token); bootReasonToken now codes a VPN / proxy
    // reason boot_vpn_blocked and a per-IP limit boot_address_limit, so the
    // next refusal says which (COMPAT.jawntide-vpn-block).
    '19c05a84-551c-428e-859e-9ea2fd06592e': VPN_BLOCK, // JawnTide
    // Two accounts / two sessions per IP (AC1999_PUBLIC_COMPAT). serverList.AC1999_PUBLIC_SERVER.id.
    ac1999: AC1999_PUBLIC_COMPAT,
  },
  byEmu: {
    GDL: GDLE_BETA,
    GDLE: GDLE_BETA,
    AC1999: AC1999_COMPAT,
  },
};

export function compatFor(id: string, emu: string, overlay: CompatOverlay = SERVER_COMPAT): CompatEntry {
  return overlay.byId[id.toLowerCase()] ?? overlay.byEmu[emu.toUpperCase()] ?? { compat: 'ok' };
}
