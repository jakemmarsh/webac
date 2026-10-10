/**
 * FAITHFUL.481 — drop orphan `languageDb` field on GameUI.
 *
 *  The field was assigned from the constructor param but never read
 *  elsewhere. `getString` calls throughout GameUI resolve via the
 *  module-level `stringIndex` in LayoutDesc.ts (populated by the
 *  global `registerStringTable` on DAT load), not via any per-
 *  instance field. The constructor still accepts the parameter
 *  (renamed `_languageDb` per TS unused-arg convention) so callers
 *  don't need to shift positional args, but it's discarded.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('FAITHFUL.481 — orphan languageDb removal (behavioural, real GameUI)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());

  it('a constructed GameUI carries no languageDb field', () => {
    expect('languageDb' in H.ui).toBe(false);
    expect(H.ui.languageDb).toBeUndefined();
  });

  it('the constructor still accepts the positional 7th arg and discards it (callers keep their arg order)', () => {
    const container = H.win.document.createElement('div');
    H.win.document.body.appendChild(container);
    const fakeLangDb = { tag: 'language-db' };
    const fakeLayout = { setFontResolver: () => {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = new (H.mod.GameUI as any)(container, {}, undefined, undefined, undefined, undefined, fakeLangDb, fakeLayout);
    // The 8th positional arg still lands in its slot — the discarded 7th didn't shift it.
    expect(ui.layoutRenderer).toBe(fakeLayout);
    expect(Object.values(ui)).not.toContain(fakeLangDb);
    container.remove();
  });
});
