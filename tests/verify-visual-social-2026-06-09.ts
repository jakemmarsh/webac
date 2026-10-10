/**
 * Social-panel visual-fidelity pins (burndown 2026-06-09).
 *
 * VISUAL.16 — the social panel body rendered fully transparent (the 3D world
 * showed through the whole content area). The DAT social content roots carry
 * media 0x06004cc2 (a 48x48 dark warm-gray DXT3 tile). The body now tiles it
 * opaquely (background-repeat:repeat + opaque fallback), same treatment as the
 * chat window — closing the see-through defect. (The full container migration
 * to 0x21000031 + the 4-tab Allegiance/Fellowship/Friends/Squelch row are
 * separate follow-up tasks; see verification/panel-specs/social-fellowship.md.)
 *
 * DEBT.test-harness-hygiene: converted from GameUI.ts source-text pins to
 * behaviour — the real renderSocialPanel / renderFriendsPaneNative /
 * addPanelScrollbar / seedSocialTestData run in happy-dom against a mocked
 * 0x21000031 LayoutRenderer handle (same mock shape as
 * verify-friends-pane-native.ts), with a synthetic StringTable registered so
 * each DAT string id is proven, not just its fallback. The acDebug seed
 * wiring in main.ts has no importable seam, so it stays a source citation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerStringTable } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const REPO = resolve(__dirname, '..');
const HARNESS = readFileSync(resolve(REPO, 'tools/capture-ui-screens.ts'), 'utf8');

const TAB_IDS = { allegiance: 0x1000028c, fellowship: 0x1000028e, friends: 0x10000512, squelch: 0x1000053b } as const;
const PANE_BY_TAB = { friends: 0x10000513, allegiance: 0x10000291, fellowship: 0x10000292, squelch: 0x1000054a } as const;
const TOP_IDS = [0x1000028b, ...Object.values(TAB_IDS), 0x10000290, ...Object.values(PANE_BY_TAB)];
const FRIENDS_PANE = PANE_BY_TAB.friends;
const FRIENDS_CHROME = [0x1000051d, 0x1000051e, 0x10000517, 0x10000518, 0x10000254, 0x1000025d, 0x1000052c, 0x10000516, 0x10000515, 0x10000514, 0x1000051c, 0x1000051b];
const BTN_IDS = new Set([0x10000514, 0x10000515, 0x10000516]);
const BTN_SLICES = [0x100002ce, 0x100002cf, 0x100002d0];

/** StringTable ids the social panel resolves (value = a sentinel proving the id). */
const STR_IDS = [71954706, 10586626, 102895522, 105328610, 48249388, 156489932, 2976924, 40711228,
  241687660, 149146076, 235366940, 163410492, 8941020];
const sentinel = (id: number): string => `S${id}`;

describe('social panel visual fidelity 2026-06-09 (behavioural, real GameUI)', () => {
  let H: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const texts = new Map<number, string>();
  const clicks = new Map<number, () => void>();
  const chatSent: string[] = [];
  const addFriendSent: string[] = [];

  beforeAll(async () => {
    H = await mountGameUI({ callbacks: { onChatSend: (l: string) => { chatSent.push(l); }, onAddFriend: (n: string) => { addFriendSent.push(n); } } });
    ui = H.ui;
    const doc = H.win.document;
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = doc.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        const mk = (par: HTMLElement, id: number): HTMLElement => {
          const el = doc.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          par.appendChild(el);
          return el;
        };
        for (const id of TOP_IDS) elements.set(id, mk(root, id));
        for (const id of FRIENDS_CHROME) {
          const el = mk(elements.get(FRIENDS_PANE)!, id);
          if (id === 0x10000517) el.style.height = '375px';
          if (BTN_IDS.has(id)) for (const sid of BTN_SLICES) mk(el, sid);
          if (id === 0x1000052c) mk(el, 0x10000328);
        }
        return {
          root, elements,
          setState: () => {},
          setText: (id: number, t: string) => { texts.set(id, t); },
          setInteractive: () => {},
          setVisible: (id: number, on: boolean) => { const el = elements.get(id); if (el) el.style.display = on ? '' : 'none'; },
          setTexture: () => {},
          onClick: (id: number, fn: () => void) => { clicks.set(id, fn); },
          close: () => { root.remove(); },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (layoutId: number, parent: HTMLElement) => (ui.layoutRenderer as any).renderPanel(layoutId, parent),
    };
  });
  afterAll(() => H.teardown());

  beforeEach(() => {
    texts.clear(); clicks.clear(); chatSent.length = 0; addFriendSent.length = 0;
    ui.uiTextures.delete(0x0600114d);
    ui.socialTab = 'friends';
    ui.setFriendsData([
      { guid: 1, name: 'Zeb', isOnline: true },
      { guid: 2, name: 'Alda', isOnline: false },
    ]);
    if (!ui.socialPanelVisible) ui.toggleSocialPanel();
    else ui.renderSocialPanel();
  });

  const paneEl = (id: number): HTMLElement =>
    ui.socialPanel.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
  const friendsNode = (id: number): HTMLElement =>
    paneEl(FRIENDS_PANE).querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
  /** happy-dom's normalised form of a CSS colour. */
  const norm = (c: string): string => { const d = H.win.document.createElement('div'); d.style.color = c; return d.style.color; };

  it('VISUAL.char-panel-body-too-bright.c — the active pane body is its own DAT scrim, never the invented leather 0x0600114d or an opaque backing', () => {
    // No leather painted, texture loaded or not; nothing opaque under the pane (it composites over the world).
    const body = paneEl(FRIENDS_PANE);
    expect(body.style.backgroundImage).not.toContain('leather');
    expect(['', 'transparent']).toContain(body.style.backgroundColor);
    ui.uiTextures.set(0x0600114d, 'data:leather');
    ui.renderSocialPanel();
    const lit = paneEl(FRIENDS_PANE).style;
    expect(lit.backgroundImage).not.toContain('data:leather');
    expect(['', 'transparent']).toContain(lit.backgroundColor);
  });

  it('VISUAL.18 — every tab shares the same (scrim) body treatment; a tab click switches + re-renders; stable data-social-tab hooks', () => {
    for (const [key, id] of Object.entries(TAB_IDS)) expect(paneEl(id).dataset.socialTab).toBe(key);
    clicks.get(TAB_IDS.squelch)!();
    expect(ui.socialTab).toBe('squelch');
    expect(paneEl(PANE_BY_TAB.squelch).style.display).toBe('');
    expect(paneEl(FRIENDS_PANE).style.display).toBe('none');
    expect(['', 'transparent']).toContain(paneEl(PANE_BY_TAB.squelch).style.backgroundColor);
    // The capture harness clicks social sub-tabs by that hook, not raw coordinates.
    expect(HARNESS).toMatch(/clickSel: '\[data-social-tab="allegiance"\]'/);
    expect(HARNESS).toMatch(/clickSel: '\[data-social-tab="friends"\]'/);
  });

  it('VISUAL.167 — seedSocialTestData populates the social views and clears them', () => {
    ui.seedSocialTestData('friends');
    expect(ui.friendsList.length).toBeGreaterThan(0);
    expect(paneEl(FRIENDS_PANE).querySelectorAll('.friend-row').length).toBe(ui.friendsList.length);
    ui.seedSocialTestData('allegiance');
    expect(ui.allegianceInfo?.allegianceName).toBe('Test Allegiance');
    ui.seedSocialTestData('fellowship');
    expect(ui.fellowshipData?.fellowshipName).toBe('Test Fellowship');
    ui.seedSocialTestData('squelch');
    expect(ui.squelchList.some((e: { account: boolean }) => e.account)).toBe(true);
    ui.seedSocialTestData('clear');
    expect([ui.allegianceInfo, ui.fellowshipData, ui.friendsList.length, ui.squelchList.length]).toEqual([null, null, 0, 0]);
    // capture harness has seeded entries + an evalJs action to drive them
    expect(HARNESS).toMatch(/evalJs: 'window\.acDebug\.seedAllegiance\(\)'/);
    expect(HARNESS).toMatch(/name: 'social-allegiance-seeded'/);
    expect(HARNESS).toMatch(/name: 'social-fellowship-seeded'/);
    expect(HARNESS).toMatch(/name: 'social-friends-seeded'/);
  });

  it('VISUAL.20 — the DAT 4 tabs in order with fallback labels; each tab key selects its pane (incl. squelch)', () => {
    expect(texts.get(TAB_IDS.allegiance)).toBe('Allegiance');
    expect(texts.get(TAB_IDS.fellowship)).toBe('Fellowship');
    expect(texts.get(TAB_IDS.friends)).toBe('Friends');
    expect(texts.get(TAB_IDS.squelch)).toBe('Squelch');
    const order = [...ui.socialPanel.querySelectorAll('[data-social-tab]')].map((e: HTMLElement) => e.dataset.socialTab);
    expect(order).toEqual(['allegiance', 'fellowship', 'friends', 'squelch']);
  });

  it('VISUAL.21/CORE.5.c.d — friends field label + Add use the DAT strings (fallbacks without DATs); Add sends AddFriend', () => {
    expect(friendsNode(0x1000051c).textContent).toContain('Friend Name:');
    expect(friendsNode(0x10000514).textContent).toContain('Add');
    const input = paneEl(FRIENDS_PANE).querySelector('input') as HTMLInputElement;
    input.value = 'Newbie';
    input.dispatchEvent(new H.win.Event('input'));
    friendsNode(0x10000514).dispatchEvent(new H.win.Event('click', { bubbles: true }));
    expect(addFriendSent).toContain('Newbie');
  });

  it('VISUAL.67/CORE.5.c.d — headers + Online/Offline status text + row colours', () => {
    expect(friendsNode(0x1000051d).textContent).toContain('Friend');
    expect(friendsNode(0x1000051e).textContent).toContain('Status');
    const C = H.mod.AC_COLORS;
    const rows = [...paneEl(FRIENDS_PANE).querySelectorAll('.friend-row')] as HTMLElement[];
    const spans = (r: HTMLElement) => [...r.querySelectorAll('span')] as HTMLElement[];
    const [onName, onStatus] = spans(rows[0]);
    const [offName, offStatus] = spans(rows[1]);
    expect([onName.textContent, onStatus.textContent]).toEqual(['Zeb', 'Online']);
    expect([offName.textContent, offStatus.textContent]).toEqual(['Alda', 'Offline']);
    expect(onName.style.color).toBe(norm(C.white));
    expect(onStatus.style.color).toBe(norm(C.socialOnlineGreen));
    expect(offName.style.color).toBe(norm(C.socialOfflineGray));
    expect(offStatus.style.color).toBe(norm(C.socialOfflineGray));
  });

  it('VISUAL.68/CORE.5.c.d — Appear Offline + Send Tell/Remove bind the DAT elements', () => {
    expect(friendsNode(0x1000052c).textContent).toContain('Appear Offline');
    expect(friendsNode(0x10000516).textContent).toContain('Send Tell');
    expect(friendsNode(0x10000515).textContent).toContain('Remove');
  });

  it('every social label resolves its DAT StringTable id when the table is loaded', () => {
    registerStringTable({
      id: 0x23fffffe, language: 0, unknown: 0,
      entries: STR_IDS.map((id) => ({ id, varNames: [], vars: [], strings: [sentinel(id)], comments: [], unknown: 0 })),
    });
    ui.renderSocialPanel();
    expect(texts.get(TAB_IDS.allegiance)).toBe(sentinel(71954706));
    expect(texts.get(TAB_IDS.fellowship)).toBe(sentinel(10586626));
    expect(texts.get(TAB_IDS.friends)).toBe(sentinel(102895522));
    expect(texts.get(TAB_IDS.squelch)).toBe(sentinel(105328610));
    expect(friendsNode(0x1000051c).textContent).toContain(sentinel(48249388));   // Friend Name:
    expect(friendsNode(0x10000514).textContent).toContain(sentinel(156489932));  // Add
    expect(friendsNode(0x1000051d).textContent).toContain(sentinel(2976924));    // Friend
    expect(friendsNode(0x1000051e).textContent).toContain(sentinel(40711228));   // Status
    expect(friendsNode(0x1000052c).textContent).toContain(sentinel(235366940));  // Appear Offline
    expect(friendsNode(0x10000516).textContent).toContain(sentinel(163410492));  // Send Tell
    expect(friendsNode(0x10000515).textContent).toContain(sentinel(8941020));    // Remove
    const rowText = [...paneEl(FRIENDS_PANE).querySelectorAll('.friend-row')].map((r) => r.textContent);
    expect(rowText[0]).toContain(sentinel(241687660)); // Online
    expect(rowText[1]).toContain(sentinel(149146076)); // Offline
  });

  // RECON.social-rows-dat-templates — the list scrolls under its OWN DAT
  // scrollbar 0x10000518 (the list's p114), bound live as the retail
  // UIElement_Scrollbar; the hide-while-fitting rule (p121) is covered by
  // verify-friends-pane-native.ts.
  it('VISUAL.69 — the DAT scrollbar 0x10000518: dragging the thumb scrolls the list', () => {
    ui.setFriendsData(Array.from({ length: 20 }, (_, i) => ({ guid: 100 + i, name: `F${String(i).padStart(2, '0')}`, isOnline: false })));
    const list = friendsNode(0x10000517);
    const column = friendsNode(0x10000518);
    const thumb = column.querySelector('[data-dat-thumb]') as HTMLElement;
    expect(thumb).toBeTruthy();
    expect(list.querySelectorAll('.friend-row').length).toBe(20);
    // happy-dom has no layout: give the scroller/column real extents.
    Object.defineProperty(list, 'scrollHeight', { value: 480, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 375, configurable: true });
    Object.defineProperty(column, 'clientHeight', { value: 400, configurable: true });
    column.getBoundingClientRect = () => ({ top: 0, left: 0, right: 16, bottom: 400, width: 16, height: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    list.scrollTop = 0;
    list.dispatchEvent(new H.win.Event('scroll'));
    expect(column.style.display).toBe('');
    thumb.dispatchEvent(new H.win.MouseEvent('mousedown', { clientY: 100, bubbles: true, cancelable: true }));
    H.win.document.dispatchEvent(new H.win.MouseEvent('mousemove', { clientY: 250 }));
    expect(list.scrollTop).toBeGreaterThan(0);
    H.win.document.dispatchEvent(new H.win.MouseEvent('mouseup', {}));
    const after = list.scrollTop;
    H.win.document.dispatchEvent(new H.win.MouseEvent('mousemove', { clientY: 350 }));
    expect(list.scrollTop).toBe(after); // released — no further drag
  });
});

// main.ts has no importable seam for the acDebug seed hooks yet — these stay
// source citations until the debug surface is extracted.
describe('VISUAL.167 — main.ts acDebug seed hooks (source citation)', () => {
  it('acDebug exposes the social seeds', () => {
    const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
    expect(MAIN).toMatch(/seedAllegiance: \(\) => \{ gameUI\.seedSocialTestData\('allegiance'\)/);
    expect(MAIN).toMatch(/seedFellowship: \(\) => \{ gameUI\.seedSocialTestData\('fellowship'\)/);
    expect(MAIN).toMatch(/seedFriends: \(\) => \{ gameUI\.seedSocialTestData\('friends'\)/);
  });
});

/*
 * BUG.allegiance-total-vassals-dropped — the Followers-header behavioral
 * coverage moved to verify-allegiance-pane-native.ts (header block test:
 * "Followers: <totalVassals>" never totalMembers), which drives the
 * DAT-native pane that replaced the hand-built branch these tests rendered.
 */
