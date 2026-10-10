/**
 * FAITHFUL.535 — onAddToTrade de-dupes by item guid.
 *
 *  ACE Player_Trade.cs:161 (HandleActionAddToTrade) calls
 *    `ItemsInTradeWindow.Add(new ObjectGuid(itemGuid))`
 *  which is a HashSet — duplicate inserts return false but DON'T abort
 *  the broader flow. Lines 163 + 172 unconditionally ship
 *  GameEventAddToTrade events to both Self and Partner sessions.
 *
 *  Player clicks "Add to Trade" twice on the same inventory item (the
 *  right-click menu doesn't track per-item already-in-trade state, so
 *  this is a real user-reachable scenario):
 *    - 1st click: server validates + ItemsInTradeWindow.Add returns true
 *    - 2nd click: server validates again + HashSet.Add returns false, but
 *      AddToTrade event still ships (the code doesn't check the bool).
 *
 *  Pre-fix our client `[...td.yourItems, { name, value }]` appended on
 *  every event → UI showed the item twice (or three+ times) while
 *  server's ItemsInTradeWindow had one entry. FinalizeTrade would
 *  iterate the unique HashSet and transfer one copy — but the user
 *  thought they were trading multiple. Visible desync.
 *
 *  Fix: extend tradeData items with `guid` field; in the handler,
 *  short-circuit when a row with the same guid already exists on the
 *  target side. Still clear ready flags (server does too).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tradeItemEntryFor } from '../packages/renderer/src/ui/tradeItemEntry.js';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
const GAMEUI = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf8');

describe('FAITHFUL.535 — onAddToTrade dedupes by guid', () => {
  it('tradeData type declares guid on yourItems and theirItems entries', () => {
    const block = GAMEUI.match(/private tradeData: \{[\s\S]+?theirReady: boolean;\s*\}/)?.[0] ?? '';
    expect(block.length).toBeGreaterThan(50);
    // Assert .535's guid + .541's burden are present on yourItems/theirItems.
    // Don't pin the full field list — other faithful commits may extend it
    // (e.g. FAITHFUL.542 added iconDid).
    expect(block).toMatch(/yourItems: Array<\{[^}]*name: string[^}]*\}>/);
    expect(block).toMatch(/yourItems: Array<\{[^}]*guid: number[^}]*\}>/);
    expect(block).toMatch(/yourItems: Array<\{[^}]*burden: number[^}]*\}>/);
    expect(block).toMatch(/theirItems: Array<\{[^}]*guid: number[^}]*\}>/);
    expect(block).toMatch(/theirItems: Array<\{[^}]*burden: number[^}]*\}>/);
  });

  it('tradeData type cites FAITHFUL.535 + ACE source anchor', () => {
    const block = GAMEUI.match(/private tradeData: \{[\s\S]+?theirReady: boolean;\s*\}/)?.[0] ?? '';
    expect(block).toMatch(/FAITHFUL\.535/);
    expect(block).toMatch(/Player_Trade\.cs:161/);
    expect(block).toMatch(/HashSet/);
  });

  it('onAddToTrade handler checks the target side array for an existing guid', () => {
    const handler = MAIN.match(/onAddToTrade: \(data\) => \{[\s\S]+?^\s{6}\},/m)?.[0] ?? '';
    expect(handler.length).toBeGreaterThan(200);
    // Computes sideArr = isSelf ? yourItems : theirItems
    expect(handler).toMatch(/sideArr = isSelf \? next\.yourItems : next\.theirItems/);
    // Short-circuits if a row with the same guid already exists
    expect(handler).toMatch(/sideArr\.some\(e => e\.guid === data\.objectGuid\)/);
  });

  it('duplicate add still clears acceptance (matches server-side TradeAccepted=false)', () => {
    const handler = MAIN.match(/onAddToTrade: \(data\) => \{[\s\S]+?^\s{6}\},/m)?.[0] ?? '';
    // The duplicate-skip branch sets yourReady + theirReady to false before
    // returning — ACE Player_Trade.cs:121 + 128 clears TradeAccepted on
    // both sides on every AddToTrade call (whether duplicate or fresh).
    const dupeBranch = handler.match(/sideArr\.some[\s\S]+?return;\s*\}/)?.[0] ?? '';
    expect(dupeBranch).toMatch(/yourReady = false/);
    expect(dupeBranch).toMatch(/theirReady = false/);
  });

  it('fresh add path appends entry with all three fields (name, value, guid)', () => {
    // CORE.18.c.a — the row is tradeItemEntryFor's (converted from a text pin).
    const handler = MAIN.match(/onAddToTrade: \(data\) => \{[\s\S]+?^\s{6}\},/m)?.[0] ?? '';
    expect(handler).toMatch(/const entry = tradeItemEntryFor\(data\.objectGuid, obj, isSelf\)/);
    const entry = tradeItemEntryFor(0x80001234, { name: 'Scarab', value: 10000, burden: 20, iconDid: 0x06001234 }, true);
    expect(entry).toMatchObject({ name: 'Scarab', value: 10000, guid: 0x80001234, burden: 20 });
  });

  it('cites FAITHFUL.535 + ACE source in the handler comment', () => {
    const handler = MAIN.match(/onAddToTrade: \(data\) => \{[\s\S]+?^\s{6}\},/m)?.[0] ?? '';
    expect(handler).toMatch(/FAITHFUL\.535/);
    expect(handler).toMatch(/Player_Trade\.cs:161/);
    expect(handler).toMatch(/ItemsInTradeWindow\.Add/);
  });
});
