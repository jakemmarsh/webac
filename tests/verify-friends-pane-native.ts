/**
 * CORE.5.c.d — the social panel's Friends tab is DAT-NATIVE: hosted in its
 * OWN pane 0x10000513 (base 0x2100005d:0x10000511) with the pane's
 * inherited chrome bound in place instead of hidden + hand-rebuilt.
 *
 * Converted-from-pins coverage (VISUAL.21/.67/.68/.69 + VISUAL3.36/.38
 * source-text pins died with the hand-built branch): this drives the REAL
 * GameUI renderSocialPanel/renderFriendsPaneNative against a mock
 * LayoutRenderer that mirrors the resolved pane chrome (data-element-id
 * nodes + 3-slice button children), asserting the retail behavior from
 * the decompiled client:
 *   - rows go into the DAT list region 0x10000517, sorted online-block-
 *     first then alphabetical (gmFriendsUI::FindSortedInsertPosition @
 *     0048d370)
 *   - button gating per gmFriendsUI::UpdateButtons @ 0048d2a0: Remove
 *     needs a selection, Send Tell needs an ONLINE selection, Add is lit
 *     (state 1) under the 50-friend cap even with an empty field (an edit
 *     that empties the field drops it to state 13)
 *   - Add sends AddFriend with the field text as typed and clears the field; Remove sends /friends
 *     remove for the selection; Send Tell prefills the chat entry with
 *     the /tell prefix (CM_UI::SendNotice_StartTell → gmMainChatUI::
 *     RecvNotice_StartTell @ 004cce40)
 *   - the Appear Offline checkbox (0x1000052c) toggles the appearOffline
 *     option and ships CharacterOption 0x27
 *   - the list scrolls under its own DAT scrollbar 0x10000518, hidden
 *     while the rows fit (its p121 — retail friends-panel.jpg shows no
 *     track on a short list)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

const FRIENDS_PANE = 0x10000513;
// Resolved pane chrome per tools/dump-layout.mjs 2100005d.
const FRIENDS_CHROME = [0x1000051d, 0x1000051e, 0x10000517, 0x10000518, 0x10000254, 0x1000025d, 0x1000052c, 0x10000516, 0x10000515, 0x10000514, 0x1000051c, 0x1000051b];
const BTN_IDS = new Set([0x10000514, 0x10000515, 0x10000516]);
const BTN_SLICES = [0x100002ce, 0x100002cf, 0x100002d0];
const PANE_IDS = [FRIENDS_PANE, 0x10000291, 0x10000292, 0x1000054a];

describe('CORE.5.c.d — friends tab, DAT-native pane (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let chatSent: string[] = [];
  let removed: number[] = [];
  let addFriendSent: string[] = [];
  let optionToggles: Array<{ option: number; value: boolean }> = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const TOP_IDS = [0x1000028b, 0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x10000290, ...PANE_IDS];
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of TOP_IDS) {
          const el = domWindow.document.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          root.appendChild(el);
          elements.set(id, el);
        }
        const pane = elements.get(FRIENDS_PANE)!;
        for (const id of FRIENDS_CHROME) {
          const el = domWindow.document.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          // The resolved list region is 270x375 at the DAT's 575 pane
          // height — give the mock the height so overflow logic is real.
          if (id === 0x10000517) el.style.height = '375px';
          pane.appendChild(el);
          if (BTN_IDS.has(id)) {
            for (const sid of BTN_SLICES) {
              const slice = domWindow.document.createElement('div');
              slice.dataset.elementId = `0x${sid.toString(16)}`;
              el.appendChild(slice);
            }
          }
          if (id === 0x1000052c) {
            const gem = domWindow.document.createElement('div');
            gem.dataset.elementId = '0x10000328';
            el.appendChild(gem);
          }
        }
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {},
          setVisible: (id: number, on: boolean) => {
            const el = elements.get(id);
            if (el) el.style.display = on ? '' : 'none';
          },
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (layoutId: number, parent: HTMLElement) => (ui.layoutRenderer as any).renderPanel(layoutId, parent),
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  beforeEach(() => {
    chatSent = [];
    addFriendSent = [];
    optionToggles = [];
    ui.callbacks.onChatSend = (line: string) => { chatSent.push(line); };
    removed = [];
    ui.callbacks.onRemoveFriend = (guid: number) => { removed.push(guid); };
    ui.callbacks.onAddFriend = (name: string) => { addFriendSent.push(name); };
    ui.callbacks.onCharacterOptionToggle = (option: number, value: boolean) => { optionToggles.push({ option, value }); };
    ui.selectedFriendGuid = null;
    ui.optionsSettings.appearOffline = false;
    ui.socialTab = 'friends';
    ui.setFriendsData([
      { guid: 1, name: 'Zeb', isOnline: true },
      { guid: 2, name: 'Alda', isOnline: false },
      { guid: 3, name: 'Bram', isOnline: true },
    ]);
    if (!ui.socialPanelVisible) ui.toggleSocialPanel();
    else ui.renderSocialPanel();
  });

  function pane(): HTMLElement { return ui.socialPanel.querySelector(`[data-element-id="0x${FRIENDS_PANE.toString(16)}"]`) as HTMLElement; }
  function node(id: number): HTMLElement { return pane().querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement; }
  function rows(): HTMLElement[] { return [...pane().querySelectorAll('.friend-row')] as HTMLElement[]; }
  function click(el: HTMLElement): void { el.dispatchEvent(new domWindow.Event('click', { bubbles: true })); }

  it('hosts the friends tab in its OWN pane 0x10000513 with the other three panes hidden', () => {
    expect(pane().style.display).not.toBe('none');
    for (const other of [0x10000291, 0x10000292, 0x1000054a]) {
      const el = ui.socialPanel.querySelector(`[data-element-id="0x${other.toString(16)}"]`) as HTMLElement;
      expect(el.style.display).toBe('none');
    }
  });

  it('rows render inside the DAT list region 0x10000517, online block first then alphabetical (retail sort @ 0048d370)', () => {
    const r = rows();
    expect(r.length).toBe(3);
    expect(r.map(x => x.dataset.rowName)).toEqual(['Bram', 'Zeb', 'Alda']);
    for (const row of r) expect(row.closest('[data-element-id="0x10000517"]')).toBe(node(0x10000517));
    expect(r[0].textContent).toContain('Online');
    expect(r[2].textContent).toContain('Offline');
  });

  it('the DAT scrollbar 0x10000518 (p121 hideDisabled) hides while the rows fit and shows once they overflow (friends-panel.jpg)', () => {
    const column = node(0x10000518);
    const list = node(0x10000517);
    // The retail widget is bound into the list's own column — no hand-built
    // bar inside the list region.
    expect(column.querySelector('[data-dat-thumb]')).toBeTruthy();
    expect(column.querySelector('[data-dat-scroll-btn="up"]')).toBeTruthy();
    expect(list.querySelector('[data-dat-thumb]')).toBeNull();
    // 3 rows fit: UpdateLayout @ 004710d0 hides the whole bar (disabled + p121).
    expect(column.style.display).toBe('none');
    ui.setFriendsData(Array.from({ length: 20 }, (_, i) => ({ guid: 100 + i, name: `Friend${String(i).padStart(2, '0')}`, isOnline: false })));
    const col2 = node(0x10000518);
    const list2 = node(0x10000517);
    Object.defineProperty(list2, 'scrollHeight', { value: 480, configurable: true });
    Object.defineProperty(list2, 'clientHeight', { value: 375, configurable: true });
    list2.dispatchEvent(new domWindow.Event('scroll'));
    expect(col2.style.display).toBe('');
    // The down arrow steps one 24px row (the 0x10000519 template height).
    click(col2.querySelector('[data-dat-scroll-btn="down"]') as HTMLElement);
    expect(list2.scrollTop).toBe(24);
  });

  it('Remove is disabled without a selection (gmFriendsUI::UpdateButtons state-13); with one it removes that friend by id (no chat command)', () => {
    click(node(0x10000515));
    expect(removed).toEqual([]);
    click(rows()[1]); // Zeb (online)
    click(node(0x10000515));
    expect(removed).toEqual([1]); // Zeb's guid
    expect(chatSent).toEqual([]);
  });

  it('Send Tell needs an ONLINE selection; prefills the chat entry with the /tell prefix (StartTell @ 004cce40)', () => {
    // Chat input in the harness DOM:
    const chatInput = domWindow.document.createElement('input');
    chatInput.id = 'chat-input';
    domWindow.document.body.appendChild(chatInput);
    try {
      click(rows()[2]); // Alda — offline → Send Tell disabled
      click(node(0x10000516));
      expect(chatInput.value).toBe('');
      click(rows()[0]); // Bram — online
      click(node(0x10000516));
      expect(chatInput.value).toBe('/tell Bram, ');
    } finally {
      chatInput.remove();
    }
  });

  it('Add is lit (state 1) on an empty field under the cap — UpdateButtons @ 0048d2a0, retail-friends.png', () => {
    const input = node(0x1000051b).querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.maxLength).toBe(34);
    expect(input.value).toBe('');
    expect(node(0x10000514).dataset.acState).toBe('1');
    // Send Tell / Remove sit in the disabled plate with nothing selected.
    expect(node(0x10000515).dataset.acState).toBe('d');
    expect(node(0x10000516).dataset.acState).toBe('d');
  });

  it('an edit gates Add on text (messages 0x12/0x44): emptied field → state 13, typed → state 1', () => {
    const input = node(0x1000051b).querySelector('input') as HTMLInputElement;
    input.value = 'x';
    input.dispatchEvent(new domWindow.Event('input', { bubbles: true }));
    expect(node(0x10000514).dataset.acState).toBe('1');
    input.value = '';
    input.dispatchEvent(new domWindow.Event('input', { bubbles: true }));
    expect(node(0x10000514).dataset.acState).toBe('d');
    click(node(0x10000514));
    expect(addFriendSent).toEqual([]);
    // A refresh (selection change) runs UpdateButtons again → lit.
    click(rows()[0]);
    expect(node(0x10000514).dataset.acState).toBe('1');
  });

  it('Add sends AddFriend with the text as typed, clears the field and drops to state 13 (0048d520 case 1)', () => {
    const input = node(0x1000051b).querySelector('input') as HTMLInputElement;
    input.value = 'NewFriend';
    input.dispatchEvent(new domWindow.Event('input', { bubbles: true }));
    click(node(0x10000514));
    expect(addFriendSent).toEqual(['NewFriend']);
    expect(chatSent).toEqual([]);
    expect(input.value).toBe('');
    expect(node(0x10000514).dataset.acState).toBe('d');
  });

  it('Add on an untouched empty field still sends (Request_AddFriend has no empty check; the server answers)', () => {
    click(node(0x10000514));
    expect(addFriendSent).toEqual(['']);
  });

  it('Add stays disabled at the retail 50-friend cap (0x32 @ 0048d344)', () => {
    ui.setFriendsData(Array.from({ length: 50 }, (_, i) => ({ guid: 200 + i, name: `F${i}`, isOnline: false })));
    expect(node(0x10000514).dataset.acState).toBe('d');
    const input = node(0x1000051b).querySelector('input') as HTMLInputElement;
    input.value = 'OneTooMany';
    input.dispatchEvent(new domWindow.Event('input', { bubbles: true }));
    click(node(0x10000514));
    expect(addFriendSent).toEqual([]);
  });

  it('Appear Offline checkbox (0x1000052c) toggles the option and ships CharacterOption 0x27', () => {
    const chk = node(0x1000052c);
    expect(chk.dataset.optionKey).toBe('appearOffline');
    expect(chk.dataset.optionOn).toBe('0');
    click(chk);
    expect(ui.optionsSettings.appearOffline).toBe(true);
    expect(chk.dataset.optionOn).toBe('1');
    expect(optionToggles).toEqual([{ option: 0x27, value: true }]);
  });
});
