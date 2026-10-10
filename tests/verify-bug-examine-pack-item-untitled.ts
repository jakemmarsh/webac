/**
 * BUG.examine-pack-item-untitled — examining an apple in our pack opened a
 * panel titled "Object 0x800009e4" with no icon: only world objects live in
 * the ServerObjectManager. The header now comes from the object's weenie
 * wherever the client holds it (world object → pack/worn item → the
 * identify response's PropertyString.Name).
 */
import { describe, it, expect } from 'vitest';
import { examineHeldItem, resolveExamineHeader } from '../packages/renderer/src/ui/examineHeader.js';

describe('resolveExamineHeader', () => {
  it('a pack item: its name and icon (not the hex id)', () => {
    const h = resolveExamineHeader(0x800009e4, undefined, { name: 'Apple', iconDid: 0x06001234, itemType: 0x20, uiEffects: 0 }, undefined);
    expect(h).toMatchObject({ name: 'Apple', iconId: 0x06001234, itemType: 0x20 });
  });
  it('a world object wins over everything', () => {
    const h = resolveExamineHeader(1, { name: 'Drudge Skulker', iconId: 0x0600aaaa, itemType: 0x10, iconOverlayId: 0 }, { name: 'x' }, new Map([[1, 'y']]));
    expect(h.name).toBe('Drudge Skulker');
    expect(h.overlayDid).toBeUndefined();
  });
  it('neither held nor in the world: the identify response\'s Name, then the hex id', () => {
    expect(resolveExamineHeader(0x80000001, null, null, new Map([[1, 'Pyreal']])).name).toBe('Pyreal');
    expect(resolveExamineHeader(0x80000001, null, null, undefined).name).toBe('Object 0x80000001');
  });
  it('our own character (no ServerObject, no wire Name) is titled with the player name', () => {
    expect(resolveExamineHeader(0x5000005c, undefined, undefined, new Map(), 'Testchar').name).toBe('Testchar');
    expect(resolveExamineHeader(0x5000005c, undefined, undefined, undefined, undefined).name).toBe('Object 0x5000005c');
  });
});

describe('examineHeldItem — an item inside an open corpse or chest', () => {
  // Appraising a corpse item before looting it opened "Object 0x8000b13c" (Jake, 2026-10-07):
  // it is neither a world object nor ours, but the open container's view holds it.
  const corpse = [
    { guid: 0x8000b13c, name: 'Chainmail Bracers', iconDid: 0x06001234, itemType: 2 },
    { guid: 0x8000b13d, name: '???', iconDid: 0 },
  ];
  it('titles it from the container view', () => {
    const h = resolveExamineHeader(0x8000b13c, null, examineHeldItem(0x8000b13c, null, corpse), undefined);
    expect(h).toMatchObject({ name: 'Chainmail Bracers', iconId: 0x06001234, itemType: 2 });
  });
  it('our own item wins; a view with no name yet is not used', () => {
    expect(examineHeldItem(0x8000b13c, { name: 'Mine' }, corpse)).toEqual({ name: 'Mine' });
    expect(examineHeldItem(0x8000b13d, null, corpse)).toBeNull();
    expect(resolveExamineHeader(0x8000b13d, null, examineHeldItem(0x8000b13d, null, corpse), undefined).name).toBe('Object 0x8000b13d');
  });
});
