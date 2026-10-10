/**
 * FAITHFUL.470 — vendor sell tab refreshes on every inventory change.
 *
 *  Pre-fix the vendor's sell tab showed the inventory snapshot from
 *  the moment of ApproachVendor and stayed stale through subsequent
 *  Buy/Sell transactions. ACE doesn't push a fresh ApproachVendor on
 *  every delta — the client has to recompute the sell list from its
 *  current inventory.
 *
 *  The GameUI helper `updateVendorSellItems` already existed but had
 *  zero callers (per the FAITHFUL.469 orphan audit). Wired it from
 *  syncInventoryUI, gated on the new `gameUI.isVendorVisible`
 *  accessor + a cached `activeVendorBuyPrice` +
 *  `activeVendorMerchandiseItemTypes` (captured in onApproachVendor).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
const UI = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf8');

describe('FAITHFUL.470 — vendor cache state', () => {
  it('declares activeVendorBuyPrice', () => {
    expect(MAIN).toMatch(/let activeVendorBuyPrice = 0/);
  });

  it('declares activeVendorMerchandiseItemTypes', () => {
    expect(MAIN).toMatch(/let activeVendorMerchandiseItemTypes = 0/);
  });
});

describe('FAITHFUL.470 — onApproachVendor captures cache', () => {
  it('writes activeVendorBuyPrice from parsed.buyPrice', () => {
    expect(MAIN).toMatch(/activeVendorBuyPrice = parsed\.buyPrice/);
  });

  it('writes activeVendorMerchandiseItemTypes from parsed.merchandiseItemTypes', () => {
    expect(MAIN).toMatch(/activeVendorMerchandiseItemTypes = parsed\.merchandiseItemTypes/);
  });
});

describe('FAITHFUL.470 — syncInventoryUI refreshes sell tab', () => {
  const fn = MAIN.match(/function syncInventoryUI\(\): void \{[\s\S]+?\n  \}/)?.[0] ?? '';

  it('extracted', () => {
    expect(fn).not.toBe('');
  });

  it('gates on gameUI.isVendorVisible + activeVendorGuid', () => {
    expect(fn).toMatch(/gameUI\.isVendorVisible && activeVendorGuid !== 0/);
  });

  it('iterates playerState.inventory.getAll()', () => {
    expect(fn).toMatch(/playerState\.inventory\.getAll\(\)/);
  });

  it('filters by merchandiseItemTypes', () => {
    expect(fn).toMatch(/activeVendorMerchandiseItemTypes/);
  });

  it('calls gameUI.updateVendorSellItems', () => {
    expect(fn).toMatch(/gameUI\.updateVendorSellItems\(sellItems\)/);
  });
});

describe('FAITHFUL.470 — isVendorVisible accessor', () => {
  it('GameUI exposes get isVendorVisible(): boolean', () => {
    expect(UI).toMatch(/get isVendorVisible\(\): boolean \{ return this\.vendorVisible; \}/);
  });
});

describe('FAITHFUL.470 citations', () => {
  it('main.ts cites FAITHFUL.470', () => {
    expect(MAIN).toMatch(/FAITHFUL\.470/);
  });

  it('GameUI cites FAITHFUL.470', () => {
    expect(UI).toMatch(/FAITHFUL\.470/);
  });
});
