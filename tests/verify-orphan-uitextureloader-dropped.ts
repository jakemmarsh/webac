/**
 * FAITHFUL.480 — drop orphan UITextureLoader scaffolding from GameUI.
 *
 *  GameUI had a `private uiTextureLoader: UITextureLoader | null`
 *  field, assigned in `loadDATAssets` from `new UITextureLoader(
 *  this.textureManager)`, but never read elsewhere. The real
 *  UITextureLoader lives at main.ts:776 and is passed to
 *  LayoutRenderer's constructor — that's the only consumer. The
 *  GameUI-internal duplicate was orphaned scaffolding.
 *
 *  Removed: field declaration, assignment, and the now-unused
 *  `import { UITextureLoader }` line.
 *
 *  DEBT.test-harness-hygiene: behavioural — a real GameUI instance carries
 *  no uiTextureLoader field, before or after loadDATAssets runs. (The dead
 *  import line had no runtime effect to observe; tsc/lint own that.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('FAITHFUL.480 — orphan UITextureLoader scaffolding removed (behavioural)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); }, 60_000);
  afterAll(() => H.teardown());

  it('a constructed GameUI has no uiTextureLoader field (class fields are defined at construction)', () => {
    expect('uiTextureLoader' in H.ui).toBe(false);
    expect((H.mod.GameUI.prototype as unknown as Record<string, unknown>).uiTextureLoader).toBeUndefined();
  });

  it('loadDATAssets (with a portal DB + TextureManager present) does not assign one', () => {
    // Empty DAT stand-ins: every lookup misses, so each loader no-ops, but the
    // method runs past its `!portalDb` guard — the path that used to do
    // `this.uiTextureLoader = new UITextureLoader(this.textureManager)`.
    H.ui.portalDb = { getFileData: () => null, hasFile: () => false, listFileIds: () => [] };
    H.ui.textureManager = { getTextureDataURL: () => null, getIconDataURL: () => null };
    H.ui.loadDATAssets();
    expect('uiTextureLoader' in H.ui).toBe(false);
  });
});
