/**
 * RECON.social-rows-dat-templates — the social panel's list rows draw from
 * their DAT row templates, driven through the REAL GameUI + LayoutRenderer
 * on the EoL client_local_English.dat:
 *  - friends rows = template 0x2100005d:0x10000519: name 0x1000051a and
 *    status 0x1000051f in their desc's font 0x40000001, coloured by the
 *    friend's state's p27 (0x10000054 online: white name, green status;
 *    0x10000055 offline: 0xFF999999 both); the list scrolls under its own
 *    scrollbar 0x10000518, whose p121 = true hides it while the rows fit;
 *  - squelch rows = template 0x21000060:0x10000541: name 0x10000542 white,
 *    Type 0x1000054d pale yellow (0x10000056 character) / red (0x10000057
 *    account); scrollbar 0x10000543 (p121 = true);
 *  - fellowship rows = template 0x21000030:0x10000281: name 0x10000283,
 *    LVL/XP 0x10000284 and the bar readouts 0x10000286/88/8a in their descs'
 *    white font 0x40000000 with no halo (retail UpdateFellowStats @ 0048eb20
 *    / UpdateFellowVitals @ 0048ed60 only SetText them); the list's own
 *    scrollbar 0x1000027a overrides p121 = false, so it stays drawn with a
 *    single fellow (fellowship-panel-2.jpg).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

const norm = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
/** A rendered AC-font run's colour (happy-dom keeps the CSS as written or normalised). */
const colorOf = (el: HTMLElement): string => {
  const c = el.style.color;
  return c.startsWith('#') ? norm(c) : c;
};

describe.skipIf(!hasDats)('RECON.social-rows-dat-templates — social rows from their DAT row templates (real LayoutRenderer)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: () => null, getTextureDataURLWithAlpha: () => null };
    ui = fx.ui;
    ui.layoutRenderer = new LayoutRenderer(local, tex as never, null);
  });
  afterAll(() => fx?.teardown());

  const show = (tab: 'friends' | 'squelch' | 'fellowship'): void => {
    ui.socialTab = tab;
    if (!ui.socialPanelVisible) ui.toggleSocialPanel();
    else ui.renderSocialPanel();
  };
  /** An element of a social pane (friends 0x10000513 / squelch 0x1000054a / fellowship 0x10000292). */
  const node = (pane: number, id: number): HTMLElement =>
    ui.socialPanel.querySelector(`[data-element-id="0x${pane.toString(16)}"] [data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
  const runs = (row: Element): HTMLElement[] => [...row.querySelectorAll('[data-ac-desc]')] as HTMLElement[];

  it('friends rows: name / status in the 0x10000519 template\'s font and per-state colours', () => {
    ui.setFriendsData([
      { guid: 1, name: 'Zeb', isOnline: true },
      { guid: 2, name: 'Alda', isOnline: false },
    ]);
    show('friends');
    const rows = [...ui.socialPanel.querySelectorAll('.friend-row')] as HTMLElement[];
    expect(rows.map((r) => r.dataset.rowName)).toEqual(['Zeb', 'Alda']);
    const [onName, onStatus] = runs(rows[0]);
    const [offName, offStatus] = runs(rows[1]);
    expect(onName.dataset.acDesc).toBe('2100005d:10000519/1000051a');
    expect(onStatus.dataset.acDesc).toBe('2100005d:10000519/1000051a/1000051f');
    expect(onName.dataset.acState).toBe('10000054');
    expect(offName.dataset.acState).toBe('10000055');
    for (const r of [onName, onStatus, offName, offStatus]) expect(r.dataset.acFont).toBe('40000001');
    expect(colorOf(onName)).toBe(norm('#ffffff'));
    expect(colorOf(onStatus)).toBe(norm('#00ff00'));
    expect(colorOf(offName)).toBe(norm('#999999'));
    expect(colorOf(offStatus)).toBe(norm('#999999'));
  });

  it('friends list: its own scrollbar 0x10000518 is bound live and hidden while the rows fit (p121 = true)', () => {
    const column = node(0x10000513, 0x10000518);
    expect(column.querySelector('[data-dat-thumb]')).toBeTruthy();
    expect(column.style.display).toBe('none');
  });

  it('squelch rows: name white, Type pale yellow (character) / red (account) from the 0x10000541 template', () => {
    ui.setSquelchList([{ name: 'Zeb', account: false }, { name: 'Alda', account: true }]);
    show('squelch');
    const rows = [...ui.socialPanel.querySelectorAll('.squelch-row')] as HTMLElement[];
    const byName = new Map(rows.map((r) => [r.dataset.rowName, runs(r)]));
    const [acctName, acctType] = byName.get('Alda')!;
    const [charName, charType] = byName.get('Zeb')!;
    expect(acctType.dataset.acDesc).toBe('21000060:10000541/10000542/1000054d');
    expect(acctType.dataset.acState).toBe('10000057');
    expect(charType.dataset.acState).toBe('10000056');
    for (const r of [acctName, acctType, charName, charType]) expect(r.dataset.acFont).toBe('40000001');
    expect(colorOf(acctName)).toBe(norm('#ffffff'));
    expect(colorOf(charName)).toBe(norm('#ffffff'));
    expect(colorOf(acctType)).toBe(norm('#ff0000'));
    expect(colorOf(charType)).toBe(norm('#ffff19'));
    const column = node(0x1000054a, 0x10000543);
    expect(column.querySelector('[data-dat-thumb]')).toBeTruthy();
    expect(column.style.display).toBe('none');
  });

  it('fellowship rows: name, LVL/XP and bar readouts in the 0x10000281 template\'s white font, no halo; scrollbar drawn with one fellow', () => {
    ui.setFellowshipData({
      fellowshipName: 'Olthoi Hunters', leaderGuid: 7, shareXP: false, evenShare: false,
      open: false, isLocked: false, selfGuid: 7,
      fellows: [{ guid: 7, name: 'Jade', level: 1, healthCurrent: 25, healthMax: 25, staminaCurrent: 30, staminaMax: 50, manaCurrent: 100, manaMax: 100, shareLoot: true }],
    });
    show('fellowship');
    const row = ui.socialPanel.querySelector('.fellow-row') as HTMLElement;
    const r = runs(row);
    expect(r.map((x) => x.dataset.acDesc)).toEqual([
      '21000030:10000281/10000282/10000283',
      '21000030:10000281/10000282/10000284',
      '21000030:10000281/10000285/10000286',
      '21000030:10000281/10000287/10000288',
      '21000030:10000281/10000289/1000028a',
    ]);
    for (const x of r) {
      expect(x.dataset.acFont).toBe('40000000');
      expect(colorOf(x)).toBe(norm('#ffffff'));
      expect(x.style.textShadow).toBe('');
    }
    // ID_Fellowship_FellowStats = LEVEL "/" EXPERIENCE "%", the share 0
    // with XP sharing off (UpdateFellowStats @ 0048eb20, never "Lv N").
    expect(r[1].textContent).toBe('1/0%');
    // ID_Fellowship_Fellow*Status = CUR "/" MAX.
    expect(r.slice(2).map((x) => x.textContent)).toEqual(['25/25', '30/50', '100/100']);
    const column = node(0x10000292, 0x1000027a);
    expect(column.querySelector('[data-dat-thumb]')).toBeTruthy();
    expect(column.style.display).toBe('');
  });
});
