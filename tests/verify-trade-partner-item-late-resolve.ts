/**
 * FAITHFUL.547 — Re-resolve partner trade item name/value/burden/iconDid
 * when the initial lookup missed due to AddToTrade arriving before
 * CreateObject for that item.
 *
 *  Race condition: ACE Player_Trade.cs:163-174 sends two packets when
 *  the partner adds an item:
 *    1. immediate: GameEventAddToTrade to SELF
 *    2. (no delay): target.TrackObject(wo) → ships CreateObject to PARTNER
 *    3. ActionChain delay 1ms → GameEventAddToTrade to PARTNER (TradeSide.Partner)
 *
 *  CreateObject travels on the InOrder queue, GameEvent on UIQueue —
 *  separate queues mean network reorder is possible. If our partner-side
 *  AddToTrade arrives BEFORE the CreateObject for that item,
 *  serverObjectManager?.getObject(data.objectGuid) returns undefined and
 *  the entry's name/value/burden/iconDid all default to placeholders
 *  ("Item 0x...", 0, 0, 0). Pre-fix the broken entry stayed broken even
 *  after CreateObject arrived — the trade slot showed "Item 0xabcd1234"
 *  forever.
 *
 *  Fix: in onAddToTrade for partner items where the initial SOM lookup
 *  missed, schedule a single 250ms retry. SOM should have the object by
 *  then (250ms >> ACE's 1ms server delay + typical network jitter).
 *  Re-resolve and call setTradeData with the corrected entry.
 *
 *  Guards: skip if the entry was removed (trade closed/reset between
 *  initial fire and retry), and skip if the name was already resolved
 *  (idempotent — no double-resolution if some other path beat us to it).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tradeItemEntryFor } from '../packages/renderer/src/ui/tradeItemEntry.js';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('FAITHFUL.547 — late re-resolve for partner trade items', () => {
  it('handler schedules setTimeout retry when isSelf=false and obj lookup missed', () => {
    const block = MAIN.match(/FAITHFUL\.547[\s\S]+?gameUI\.setTradeData\(\{[\s\S]+?\}\);\s*\}, 250\);\s*\}/)?.[0] ?? '';
    expect(block.length).toBeGreaterThan(300);
    expect(block).toMatch(/if \(!isSelf && !obj\)/);
    expect(block).toMatch(/setTimeout\(/);
    expect(block).toMatch(/, 250\)/);
  });

  it('retry path uses guid to find the entry in current theirItems (not stale index)', () => {
    const block = MAIN.match(/FAITHFUL\.547[\s\S]+?\}, 250\);/)?.[0] ?? '';
    expect(block).toMatch(/tdNow\.theirItems\.findIndex\(e => e\.guid === data\.objectGuid\)/);
    // Guard against the entry having been removed (trade closed/reset).
    expect(block).toMatch(/if \(idx < 0\) return;/);
  });

  it('retry is idempotent: skip if name already resolved (does not start with "Item 0x")', () => {
    const block = MAIN.match(/FAITHFUL\.547[\s\S]+?\}, 250\);/)?.[0] ?? '';
    expect(block).toMatch(/cached\.name && !cached\.name\.startsWith\('Item 0x'\)/);
  });

  it('retry skips silently if SOM still does not have the object (extremely rare)', () => {
    const block = MAIN.match(/FAITHFUL\.547[\s\S]+?\}, 250\);/)?.[0] ?? '';
    expect(block).toMatch(/if \(!resolved\) return;/);
  });

  it('on successful resolution, fixes name + value + burden + iconDid + preserves guid', () => {
    // CORE.18.c.a — the retry rebuilds the row with tradeItemEntryFor(guid,
    // resolved ServerObject, partner side); converted from a text pin.
    const block = MAIN.match(/FAITHFUL\.547[\s\S]+?\}, 250\);/)?.[0] ?? '';
    expect(block).toMatch(/tradeItemEntryFor\(data\.objectGuid, resolved, false\)/);
    const fixed = tradeItemEntryFor(0x5000abcd, { name: 'Pearl', value: 300, burden: 5, iconId: 0x06002a2a, iconDid: 0x06009999, itemType: 0x800 }, false);
    expect(fixed).toMatchObject({ name: 'Pearl', value: 300, burden: 5, iconDid: 0x06002a2a, guid: 0x5000abcd, itemType: 0x800 });
    // A ServerObject with no value / burden mirrors → 0, not undefined.
    expect(tradeItemEntryFor(0x5000abce, { name: 'Rock', iconId: 0x06000001 }, false)).toMatchObject({ value: 0, burden: 0 });
  });

  it('cites the ACE packet-ordering rationale (InOrder + UIQueue race)', () => {
    const block = MAIN.match(/FAITHFUL\.547[\s\S]+?if \(!isSelf && !obj\)/)?.[0] ?? '';
    expect(block).toMatch(/Player_Trade\.cs/);
    expect(block).toMatch(/CreateObject/);
    expect(block).toMatch(/AddToTrade/);
    expect(block).toMatch(/InOrder/);
    expect(block).toMatch(/UIQueue/);
  });
});
