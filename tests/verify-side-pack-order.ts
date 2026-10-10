/**
 * BUG.side-pack-order-follows-arrival — side packs follow PlayerDescription's
 * placement list (GameEventPlayerDescription.cs:401-416), not ObjectCreate
 * arrival order. Found 2026-10-01 by the GPU screen-regression calibration:
 * the backpack and a sack swapped places between two logins of identical code.
 */
import { describe, it, expect } from 'vitest';
import { orderSidePacks } from '../packages/renderer/src/player/sidePackOrder.js';

const ME = 0x50000003, BACKPACK = 0x80000136, SACK1 = 0x800014be, SACK2 = 0x80001502, NEW = 0x80009999;

describe('orderSidePacks', () => {
  it('orders packs by placement whatever order they arrived in; the main pack stays first', () => {
    const placement = [0x80000001, BACKPACK, 0x80000002, SACK1, SACK2];
    expect(orderSidePacks([ME, SACK2, BACKPACK, SACK1], placement)).toEqual([ME, BACKPACK, SACK1, SACK2]);
    expect(orderSidePacks([ME, SACK1, SACK2, BACKPACK], placement)).toEqual([ME, BACKPACK, SACK1, SACK2]);
  });
  it('a pack the placement list does not know (picked up after login) keeps arrival order at the end', () => {
    expect(orderSidePacks([ME, NEW, SACK1, BACKPACK], [BACKPACK, SACK1])).toEqual([ME, BACKPACK, SACK1, NEW]);
  });
  it('no placement yet, or a single pack: unchanged', () => {
    expect(orderSidePacks([ME, SACK1, BACKPACK], [])).toEqual([ME, SACK1, BACKPACK]);
    expect(orderSidePacks([ME, SACK1], [BACKPACK])).toEqual([ME, SACK1]);
  });
});
