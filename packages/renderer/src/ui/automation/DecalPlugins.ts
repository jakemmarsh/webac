/**
 * The Decal plugins switch (webac#18): whether this client runs as if Decal and its plugins were
 * installed — Virindi Views' bar (VvsBar.ts), VirindiTank, the Virindi Hotkey System, UtilityBelt,
 * Mag-Tools, GoArrow, Virindi Chat System, Virindi Reporter / HUDs and Splitpea, with their windows,
 * hotkeys and chat commands. Off, they are absent, as for a player without Decal.
 *
 * Its default is the era's (EraClientRules.decalPlugins): on for end of retail and the classic eras,
 * whose players ran Decal; off for AC1999, whose client predates Decal (2001) and whose players
 * asked for a 1999 screen without it.
 *
 * Kept in this browser, per era (one key per EraProfile id), like the Config page's other client
 * preferences (retail's UIPreferences lived in the client's own files, never on the server). It is
 * never one of the server's character options: the options word and GameplayOptions blob the
 * server stores stay exactly what retail sends.
 */

/** The Config page row's optionsSettings key (in memory only: the value is stored per era below). */
export const DECAL_PLUGINS_OPTION_KEY = 'decalPlugins';

/** The row's label on the Config page's UI Options section. Not a DAT string: retail had no such row. */
export const DECAL_PLUGINS_LABEL = 'Enable Decal Plugins';

const STORE_PREFIX = 'acjs.decalPlugins.v1.';

/** The browser-storage key for era `eraId`. */
export function decalPluginsStoreKey(eraId: string): string {
  return `${STORE_PREFIX}${eraId}`;
}

/** The stored choice for era `eraId`, else the era's default. Blocked or broken storage reads as the default. */
export function readDecalPlugins(storage: () => Storage | null, eraId: string, eraDefault: boolean): boolean {
  try {
    const v = storage()?.getItem(decalPluginsStoreKey(eraId));
    if (v === 'on') return true;
    if (v === 'off') return false;
  } catch { /* storage blocked */ }
  return eraDefault;
}

/** Keep the choice for era `eraId` (a failed write leaves it for this page only). */
export function writeDecalPlugins(storage: () => Storage | null, eraId: string, on: boolean): void {
  try { storage()?.setItem(decalPluginsStoreKey(eraId), on ? 'on' : 'off'); } catch { /* storage blocked */ }
}
