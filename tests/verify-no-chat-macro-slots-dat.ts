/**
 * GAP.47 — "Chat input + macro slots". Two halves:
 *   • Chat input — REAL end-to-end (GameUI's chat entries feed the retail
 *     command system in chat/commands; covered behaviorally by verify-chat-input-*,
 *     verify-canvas-click-blurs-chat, verify-send-button-*, the /-command
 *     dispatch tests, etc.). Not re-litigated here.
 *   • "Macro slots (saved chat macros bound to slots)" — WRONG PREMISE.
 *     End-of-retail AC's client shipped NO chat-macro feature. In-game
 *     command macros were a THIRD-PARTY thing (Decal / Virindi Hotkey),
 *     never part of the base client. The only slot-based quickbar retail
 *     shipped is the item/spell **Shortcut Bar** ("Create Shortcut",
 *     "Creates a shortcut to the currently selected item in the first open
 *     shortcut slot", "Next/Previous Shortcut Bar") — items and spells, not
 *     saved chat text.
 *
 * Per CLAUDE.md the DAT is ground truth, and a wrong implementation is worse
 * than none. This drives the REAL DAT parser over every String table in
 * client_local_English.dat and asserts:
 *   1. (positive control A) the real chat UI labels ARE present;
 *   2. (positive control B) the real item/spell Shortcut-Bar labels ARE
 *      present — documenting the actual slotted quickbar so the absence
 *      below is "no CHAT macros", not "no slotted UI at all";
 *   3. NO string anywhere contains "macro" — retail shipped no chat-macro UI.
 *
 * Guards against a future fabricated chat-macro-slot panel; if a real macro
 * String ever appears in the DAT chain the premise re-triages.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { DatDatabase, parseStringTable } from '@ac/dat-parser';
import { openDat } from './_harness/dat.js';

const LANG_PATH = 'dat/client_local_English.dat';
const hasLang = fs.existsSync(LANG_PATH);

function loadDat(path: string): DatDatabase {
  return openDat(path);
}

function allStrings(dat: DatDatabase): string[] {
  const out: string[] = [];
  for (const id of dat.listFileIds(0x23)) {
    let st;
    try { st = parseStringTable(dat.getReader(id)); } catch { continue; }
    for (const e of st.entries) for (const s of e.strings) out.push(s);
  }
  return out;
}

describe.skipIf(!hasLang)('GAP.47 — no chat-macro slots in retail (DAT ground truth)', () => {
  let strings: string[];

  it('parses the language DAT string tables', () => {
    strings = allStrings(loadDat(LANG_PATH));
    expect(strings.length).toBeGreaterThan(1000);
  });

  it('positive control A: real chat UI labels ARE present', () => {
    expect(strings.some((s) => /Chat Options/i.test(s))).toBe(true);
    expect(strings.some((s) => /Chat Window \d/i.test(s))).toBe(true);
  });

  it('positive control B: the real item/spell Shortcut Bar labels ARE present', () => {
    // The ONLY slotted quickbar retail shipped. Its presence proves this
    // search surfaces slot-UI labels, so the "macro" absence is meaningful.
    expect(strings.some((s) => /Create Shortcut/i.test(s))).toBe(true);
    expect(strings.some((s) => /shortcut slot/i.test(s))).toBe(true);
  });

  it('NO DAT string references a chat "macro" — retail never shipped one', () => {
    const hits = strings.filter((s) => /macro/i.test(s));
    expect(hits).toEqual([]);
  });
});
