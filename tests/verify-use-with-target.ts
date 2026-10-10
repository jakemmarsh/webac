/**
 * GAP.21 — use-with-target routing (key/lockpick/healing-kit vs food/scroll).
 *
 * ACE Usable.cs packs ItemUseable as source flags (low 16) + target flags
 * (high 16). A non-zero TARGET mask marks a use-WITH-target item; the
 * retail gesture (in-game "Guide to Healing", asheron.fandom.com/wiki/
 * Guide_to_Healing) is: "Double-click on the healing kit, then select the
 * injured person." Generic-use items (Usable.Contained = 0x8) ship plain
 * GameActionType.Use on double-click instead.
 *
 * Discriminator values proven against the live ACE world DB
 * (weenie_properties_int type 16 = PropertyInt.ItemUseable):
 *   key (291)                0x200008 SourceContainedTargetRemote
 *   healingkit (628/13233)   0x220008 SourceContainedTargetRemoteOrSelf
 *   scroll (366), apple (258)     0x8 Contained            → generic Use
 *   arrow (300), wand (12759)     0x1 No                   → generic Use
 *
 * The wire capture side is pinned byte-exact in verify-createobject-house.ts
 * (WeenieHeaderFlag.Usable read into CreateObjectData.usable).
 */
import { describe, it, expect } from 'vitest';
import { isUseWithTargetItem, USABLE_TARGET_MASK, USABLE_SOURCE_MASK } from '../packages/shared/src/weenie-types.js';

describe('GAP.21 — isUseWithTargetItem (ACE Usable.cs target mask)', () => {
  it('key 0x200008 (SourceContainedTargetRemote) requires a target', () => {
    expect(isUseWithTargetItem(0x200008)).toBe(true);
  });

  it('healing kit 0x220008 (SourceContainedTargetRemoteOrSelf) requires a target', () => {
    expect(isUseWithTargetItem(0x220008)).toBe(true);
  });

  it('food/scroll 0x8 (Contained) is generic use', () => {
    expect(isUseWithTargetItem(0x8)).toBe(false);
  });

  it('non-usable 0x1 (No) is generic use', () => {
    expect(isUseWithTargetItem(0x1)).toBe(false);
  });

  it('undefined/absent usable (older wire paths) is generic use', () => {
    expect(isUseWithTargetItem(undefined)).toBe(false);
    expect(isUseWithTargetItem(0)).toBe(false);
  });

  it('gem-set SourceContainedTargetObjselfOrContained 0x880008 requires a target', () => {
    expect(isUseWithTargetItem(0x880008)).toBe(true);
  });

  it('masks partition the 32-bit value exactly (ACE SourceMask/TargetMask)', () => {
    expect(USABLE_SOURCE_MASK).toBe(0x0000ffff);
    expect(USABLE_TARGET_MASK >>> 0).toBe(0xffff0000);
    expect(((USABLE_SOURCE_MASK | USABLE_TARGET_MASK) >>> 0)).toBe(0xffffffff);
  });
});
