/**
 * FAITHFUL.539 — acDebug helpers for trade-flow two-character verification.
 *
 *  GOAL.md mandates multi-tab Chrome verification with two characters for
 *  pair-only flows like trade. The .533-.538 trade audit only had unit
 *  tests; live verification required helpers to drive the trade
 *  GameActions from the JS console rather than navigating the right-click
 *  context-menu path (the right-click path requires a real target raycast
 *  hit on the partner's mesh, which is flaky across teleports).
 *
 *  The helpers (tradeOpen, tradeAdd, tradeAccept, tradeDecline, tradeReset,
 *  tradeClose, tradeState) call directly into the real `sendGameAction`
 *  pipeline — the wire-format payloads match the same paths the normal
 *  UI uses, so verification through these helpers is functionally
 *  equivalent to using the trade panel + inventory right-click menu.
 *
 *  This commit also captures the live trade-flow verification results in
 *  progress.md — see the FAITHFUL.539 entry there for the full
 *  step-by-step + the two new bugs found (FAITHFUL.540, .541).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('FAITHFUL.539 — acDebug trade helpers', () => {
  it('declares tradeOpen helper with ACE-source-cited wire format', () => {
    const block = MAIN.match(/tradeOpen: \(partnerGuid: number\) => \{[\s\S]+?sendGameAction\(GameActionType\.OpenTradeNegotiations[\s\S]+?\},/)?.[0] ?? '';
    expect(block.length).toBeGreaterThan(100);
    expect(block).toMatch(/writeUInt32\(partnerGuid\)/);
    expect(block).toMatch(/GameActionType\.OpenTradeNegotiations/);
  });

  it('declares tradeAdd helper matching GameActionAddToTrade wire format (itemGuid + slot)', () => {
    const block = MAIN.match(/tradeAdd: \(itemGuid: number[\s\S]+?GameActionType\.AddToTrade[\s\S]+?\},/)?.[0] ?? '';
    expect(block.length).toBeGreaterThan(50);
    // GAP.87: the inline writeUInt32(itemGuid)/writeUInt32(slot) BinaryWriter
    // block was extracted into buildAddToTradePayload (byte order
    // behaviorally tested in verify-inventory-transfer-gameaction-send.ts).
    expect(block).toMatch(/buildAddToTradePayload\(itemGuid, slot\)/);
  });

  it('declares tradeAccept helper with 28-byte payload (server discards)', () => {
    const block = MAIN.match(/tradeAccept: \(\) => \{[\s\S]+?GameActionType\.AcceptTrade[\s\S]+?\},/)?.[0] ?? '';
    expect(block.length).toBeGreaterThan(50);
    expect(block).toMatch(/new BinaryWriter\(28\)/);
  });

  it('declares empty-payload helpers for decline/reset/close', () => {
    expect(MAIN).toMatch(/tradeDecline: \(\) => \{[\s\S]+?GameActionType\.DeclineTrade,[\s\S]+?new Uint8Array\(0\)/);
    expect(MAIN).toMatch(/tradeReset: \(\) => \{[\s\S]+?GameActionType\.ResetTrade,[\s\S]+?new Uint8Array\(0\)/);
    expect(MAIN).toMatch(/tradeClose: \(\) => \{[\s\S]+?GameActionType\.CloseTradeNegotiations,[\s\S]+?new Uint8Array\(0\)/);
  });

  it('declares tradeState snapshot helper that exposes guid field per FAITHFUL.535', () => {
    const block = MAIN.match(/tradeState: \(\) => \{[\s\S]+?return \{[\s\S]+?\};/)?.[0] ?? '';
    expect(block.length).toBeGreaterThan(100);
    expect(block).toMatch(/partnerGuid/);
    expect(block).toMatch(/initiatorGuid/);
    expect(block).toMatch(/theirName/);
    expect(block).toMatch(/yourReady/);
    expect(block).toMatch(/theirReady/);
    // Guid field on items is the FAITHFUL.535 invariant — verify it surfaces
    // through the state snapshot so two-tab verification can confirm dedupe.
    expect(block).toMatch(/guid: '0x' \+ i\.guid\.toString\(16\)/);
  });

  it('helper block is gated behind sendGameAction null-check (no crash if pipeline not wired)', () => {
    const block = MAIN.match(/tradeOpen: \(partnerGuid: number\) => \{[\s\S]+?\},/)?.[0] ?? '';
    expect(block).toMatch(/if \(!sendGameAction\)/);
  });
});
