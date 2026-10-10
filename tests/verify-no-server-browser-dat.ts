/**
 * GAP.49 — "Lobby / server browser" is a WRONG PREMISE. End-of-retail
 * Asheron's Call had no in-client lobby or world/server-selection UI.
 *
 * Retail architecture: the EXTERNAL Turbine launcher (GameLauncher / the
 * Zone client, later community launchers like ThwargLauncher) handled
 * account login AND world selection, then launched acclient.exe against
 * the ONE chosen world. The client itself went straight to the connecting
 * screen → character select for that single world. There was never an
 * in-client "pick a server/world" browser.
 *
 * Ground truth:
 *   • DAT strings: 0 "lobby"; the 37 "server" hits are all connection
 *     status / error / credits text ("The server has disconnected",
 *     "server is full", "Lead Server Engineer"), and the "world" hits are
 *     "Entering World" / "World Panel" / "exit the game world" — never a
 *     "Server List" / "Select World" / "Choose a World" selection label.
 *   • ACE C#: the only "serverlist" is `@serverlist`, an ADMIN
 *     (AccessLevel.Envoy) diagnostic listing logical servers within one
 *     world's farm — not a player-facing world browser. ACE is a
 *     single-world server; the client connects to one endpoint.
 *
 * Our browser client is the launcher-equivalent: the pre-world launcher
 * screen (RELEASE.launcher-screen, src/launcher/LauncherScreen.ts) takes the
 * world and credentials the external launcher used to own, drawn with the
 * charselect layout's own DAT art. No in-client server browser built from
 * invented DAT strings is fabricated (CLAUDE.md: a wrong implementation is
 * worse than none).
 *
 * This drives the REAL DAT parser over every String table and asserts a
 * positive control (connection-status "server" text + "Entering World"
 * ARE present — the search works) plus the absence of any lobby /
 * world-selection UI label. skipIf DAT absent (CI).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { DatDatabase, parseStringTable } from '@ac/dat-parser';
import { openDat } from './_harness/dat.js';

const LANG_PATH = 'dat/client_local_English.dat';
const hasLang = fs.existsSync(LANG_PATH);

function allStrings(path: string): string[] {
  const dat = openDat(path);
  const out: string[] = [];
  for (const id of dat.listFileIds(0x23)) {
    try {
      const st = parseStringTable(dat.getReader(id));
      for (const e of st.entries) for (const s of e.strings) out.push(s);
    } catch { /* skip */ }
  }
  return out;
}

describe.skipIf(!hasLang)('GAP.49 — no in-client lobby / server browser (DAT ground truth)', () => {
  let strings: string[];

  it('parses the language DAT string tables', () => {
    strings = allStrings(LANG_PATH);
    expect(strings.length).toBeGreaterThan(1000);
  });

  it('positive control: connection-status "server" text and "Entering World" ARE present', () => {
    // Proves the corpus/search would surface a server/world UI label if one
    // existed — so the selection-label absence below is meaningful.
    expect(strings.some((s) => /server/i.test(s))).toBe(true);
    expect(strings.some((s) => /Entering World/i.test(s))).toBe(true);
  });

  it('has NO lobby / world-or-server-selection UI label', () => {
    expect(strings.filter((s) => /\blobby\b/i.test(s))).toEqual([]);
    // A real server browser would carry one of these selection labels.
    const selectionLabel =
      /(select|choose)\s+(a\s+|your\s+)?(server|world|realm)\b|(server|world|realm)\s+(list|browser|selection)/i;
    expect(strings.filter((s) => selectionLabel.test(s))).toEqual([]);
  });
});
