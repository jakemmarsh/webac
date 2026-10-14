// @vitest-environment happy-dom
/**
 * Mag-Tools' main window (packages/renderer/src/ui/magtools/MagToolsWindow.ts, docs/plugin-specs/magtools.md §2)
 * drawn over the real core models (MtManaTracker, MtCombatParser / MtCombatTracker, MtOptions) through a fake
 * VVS kit: the tabs and their exact labels, a mana row and footer from a fed item, combat totals from fed
 * chat lines, and an option toggled from the window and saved to the store.
 */
import { describe, expect, it } from 'vitest';
import {
  AttackConditions, DamageType, formatAttackerChat, MT_TRADE_WHITELIST_KEY, MtCombatParser, MtCombatTracker, MtManaTracker, MtOptions,
  mtTradeWhitelistMatches, readMtTradeWhitelist, writeMtTradeWhitelist, type MtOptionStorage, type MtWornItem,
} from '@ac/shared';
import {
  MagToolsWindow, MT_ABOUT_THANKS, MT_FRAME, MT_TRADE_WHITELIST_LABEL, MT_WINDOW, type MagToolsHost,
} from '../packages/renderer/src/ui/magtools/MagToolsWindow.ts';
import type { VTankKit } from '../packages/renderer/src/ui/automation/VTankWindow.ts';

function fakeKit(icons: number[]): VTankKit {
  const div = (data: Record<string, string>, onClick?: () => void) => { const d = document.createElement('div'); Object.assign(d.dataset, data); if (onClick) d.addEventListener('click', onClick); return d; };
  const kit = {
    text: (t: string) => { const s = document.createElement('span'); s.textContent = t; s.dataset.text = t; return s; },
    textTab: (label: string, on: boolean, onClick: () => void) => div({ tab: label, selected: on ? '1' : '0' }, onClick),
    flatButton: (label: string, onClick: () => void) => div({ button: label }, onClick),
    check: (on: boolean, onChange: (v: boolean) => void) => div({ check: on ? '1' : '0' }, () => onChange(!on)),
    input: (value: string, _w: number, onChange: (v: string) => void) => { const i = document.createElement('input'); i.value = value; i.addEventListener('input', () => onChange(i.value)); return i; },
    row: (_sel: boolean, onClick?: () => void) => div({ row: '1' }, onClick),
    icon: (id: number, _size: number, onClick?: () => void) => { icons.push(id); return div({ icon: String(id) }, onClick); },
    list: () => {},
    colors: { text: 'white', dim: 'grey', gold: 'gold', good: 'green', warn: 'yellow', bad: 'red' },
  };
  return kit as unknown as VTankKit;
}

const ME = 'Hero';
const T0 = 1_000_000;

function setup(worn: MtWornItem[] = []) {
  const stored = new Map<string, string>();
  const store: MtOptionStorage = { get: (k) => stored.get(k), set: (k, v) => { stored.set(k, v); } };
  const options = new MtOptions(store);
  const mana = new MtManaTracker({ worn: () => worn, playerEnchantments: () => [], now: () => T0 });
  const current = new MtCombatTracker(() => ME, () => T0);
  const persistent = new MtCombatTracker(() => ME, () => T0);
  let persistentCleared = 0;
  const icons: number[] = [];
  const body = document.createElement('div');
  let win!: MagToolsWindow;
  const host: MagToolsHost = {
    mana, options,
    combat: { current, persistent, clearPersistent: () => { persistent.clear(); persistentCleared++; } },
    redraw: () => win.render(body),
    version: 'test',
  };
  win = new MagToolsWindow(fakeKit(icons), host);
  win.render(body);
  const tabs = (level: string) => [...body.querySelectorAll<HTMLElement>(`[data-mt-level="${level}"]`)].map((e) => e.dataset.mtTab);
  const click = (sel: string) => { const e = body.querySelector<HTMLElement>(sel); if (!e) throw new Error(`no ${sel}`); e.click(); };
  const texts = (root: ParentNode = body) => [...root.querySelectorAll<HTMLElement>('[data-text]')].map((e) => e.dataset.text);
  return { body, win, host, stored, options, current, persistent, icons, tabs, click, texts, cleared: () => persistentCleared };
}

describe('Mag-Tools main window (spec §2)', () => {
  it('is 320 × 460 in a VVS frame, with only the built tabs, labels exact', () => {
    expect(MT_WINDOW).toEqual({ title: 'Mag-Tools', w: 320, h: 460, icon: 0x06002208 });
    expect(MT_FRAME).toEqual({ w: 332, h: 495 });
    const t = setup();
    expect(t.tabs('top')).toEqual([' Trackers ', '   Misc   ']);
    expect(t.tabs('trackers')).toEqual(['  Mana  ', ' Combat ']);
    t.click('[data-mt-tab=" Combat "]');
    expect(t.tabs('combat')).toEqual([' Current Session Stats ', '  Persistent Stats  ', '    Options    ']);
    t.click('[data-mt-tab="   Misc   "]');
    expect(t.tabs('misc')).toEqual(['  Options  ', '  Filters  ', ' About ']);
    // The open tab is drawn selected; the sub-tab choice survives a top-tab switch.
    expect(t.body.querySelector<HTMLElement>('[data-mt-tab="   Misc   "]')!.dataset.selected).toBe('1');
    t.click('[data-mt-tab=" Trackers "]');
    expect(t.body.querySelector<HTMLElement>('[data-mt-tab=" Combat "]')!.dataset.selected).toBe('1');
    // A host with no corpse / player / inventory / logger / tools sources gets none of those tabs (verify-magtools-trackers.ts draws them); Client is never drawn.
    for (const gone of [' Loggers ', ' Tools ', ' Corpse ', ' Player ', ' Inv. Items ', '  Client  ']) expect(t.body.querySelector(`[data-mt-tab="${gone}"]`)).toBeNull();
    t.click('[data-mt-tab="   Misc   "]');
    t.click('[data-mt-tab=" About "]');
    expect(t.texts()).toContain(MT_ABOUT_THANKS);
    expect(t.texts()).toContain('Version: test');
    expect(t.texts().some((x) => x?.includes('codeplex'))).toBe(false);
  });

  it('draws a mana row and the footer from a fed worn item; hidden kinds stay out of the list but in the totals', () => {
    const ring: MtWornItem = {
      id: 0x80001234, name: 'Ring of Testing', icon: 0x06001111, validLocations: 0x000c0000, wieldedLocation: 0x00040000,
      appraised: true, spells: [{ id: 1, name: 'Strength Self I', family: 1, difficulty: 50 }], curMana: 100, maxMana: 200,
      manaRate: -0.02, retained: false, enchantments: [{ family: 1, difficulty: 50 }], manaUpdatedAt: T0,
    };
    const cloak: MtWornItem = { ...ring, id: 0x80005678, name: 'Cloak', icon: 0x06002222, validLocations: 0x08000000, wieldedLocation: 0x08000000, curMana: 50, retained: true };
    const t = setup([ring, cloak]);
    const rows = [...t.body.querySelectorAll<HTMLElement>('[data-mt-mana-row]')];
    expect(rows.map((r) => Number(r.dataset.mtManaRow))).toEqual([ring.id]);
    const row = rows[0]!;
    expect(row.dataset.state).toBe('Active');
    // ceil(-0.2 / -0.02) × 5 = 50 s per point; 100 points = 5000 s = 1h23m.
    expect(t.texts(row)).toEqual(['Ring of Testing', '100 / 200', '1h23m']);
    expect(row.querySelector('[data-mt-col="ManaItemIcon"] [data-icon]')!.getAttribute('data-icon')).toBe(String(0x06001111));
    expect(row.querySelector<HTMLElement>('[data-mt-state-icon]')!.dataset.mtStateIcon).toBe(String(0x060011f9));
    // Column widths 16 / 125 / 16 / 72 / 44.
    expect([...row.querySelectorAll<HTMLElement>('[data-mt-col]')].map((c) => c.style.width)).toEqual(['16px', '125px', '16px', '72px', '44px']);
    // The cloak's 150 missing mana counts; only the ring is unretained.
    const total = t.body.querySelector<HTMLElement>('[data-mt="ManaTotal"]')!;
    expect(total.textContent).toBe('Mana needed: 250');
    expect([total.style.left, total.style.top]).toEqual(['5px', '385px']);
    expect(t.body.querySelector('[data-mt="UnretainedTotal"]')!.textContent).toBe('Unretained Items: 1');
  });

  it('renders combat totals from fed chat lines; a row click selects that opponent; Clear clears', () => {
    const t = setup();
    const parser = new MtCombatParser({ me: () => ME });
    const lines = [
      formatAttackerChat('Drudge Skulker', DamageType.Slash, 0.3, 20, false),
      formatAttackerChat('Drudge Skulker', DamageType.Pierce, 0.6, 50, true, AttackConditions.SneakAttack),
      'You split Drudge Skulker apart!',
      'Drudge Skulker withers you for 12 points with Nether Bolt I.',
      'You chill Mosswart for 30 points with Frost Bolt II.',
    ];
    for (const l of lines) { const e = parser.parse(l); if (e) { t.current.record(e); t.persistent.record(e); } }
    t.click('[data-mt-tab=" Combat "]');
    const monsterRow = (i: number) => t.body.querySelector<HTMLElement>(`[data-mt-list="monsters-current"] [data-mt-row="${i}"]`)!;
    const cells = (r: HTMLElement) => [...r.querySelectorAll<HTMLElement>('[data-mt-cell]')].map((c) => c.dataset.text);
    expect(cells(monsterRow(0))).toEqual(['', '', "KB's", 'Dmg Rcvd', 'Dmg Givn']);
    expect(cells(monsterRow(1))).toEqual(['*', 'All', '1', '12', '100']);
    expect(cells(monsterRow(2))).toEqual(['', 'Drudge Skulker', '1', '12', '70']);
    expect(cells(monsterRow(3))).toEqual(['', 'Mosswart', '', '', '30']);
    expect([...monsterRow(0).querySelectorAll<HTMLElement>('[data-mt-cell]')].map((c) => c.style.width)).toEqual(['5px', '111px', '37px', '55px', '77px']);
    const detailTotal = () => cells(t.body.querySelector<HTMLElement>('[data-mt-list="detail-current"] [data-mt-row="10"]')!);
    expect(detailTotal()).toEqual(['Total', '', '12', 'Total', '100']);
    // Select Mosswart: its row gets the star and the grid narrows to it.
    monsterRow(3).click();
    expect(cells(monsterRow(3))[0]).toBe('*');
    expect(detailTotal()).toEqual(['Total', '', '', 'Total', '30']);
    // The header selects All again.
    monsterRow(0).click();
    expect(cells(monsterRow(1))[0]).toBe('*');
    // Options: Clear Current Stats empties Current, Persistent keeps its record until its own button.
    t.click('[data-mt-tab="    Options    "]');
    const btn = (l: string) => t.body.querySelector<HTMLElement>(`[data-mt-button="${l}"]`);
    expect(btn('Export Current Stats')).toBeNull(); // no exporter given: no dead button
    btn('Clear Current Stats')!.click();
    expect(t.current.monsterRows()).toHaveLength(2);
    expect(t.persistent.monsterRows()).toHaveLength(4);
    btn('Clear Persistent Stats')!.click();
    expect(t.cleared()).toBe(1);
    expect(t.persistent.monsterRows()).toHaveLength(2);
    t.click('[data-mt-tab="  Persistent Stats  "]');
    expect(cells(t.body.querySelector<HTMLElement>('[data-mt-list="monsters-persistent"] [data-mt-row="1"]')!)).toEqual(['*', 'All', '', '', '']);
  });

  it('toggles an option from the list and saves it (a child turns its parent on); Sort Alphabetically reorders', () => {
    const t = setup();
    t.click('[data-mt-tab="   Misc   "]');
    const optRow = (p: string) => t.body.querySelector<HTMLElement>(`[data-mt-option="${p}"]`)!;
    const labels = [...t.body.querySelectorAll<HTMLElement>('[data-mt-list="Misc/Options"] [data-mt-option]')].map((r) => t.texts(r)[0]);
    expect(labels.slice(0, 3)).toEqual(['Show Item Info On Ident', '- Show Item Info Buffed* Values', '- Show Value and Burden']);
    expect(labels).not.toContain('Maximize Chat On Login'); // Windows-only
    expect(optRow('Misc.LogOutOnDeath').dataset.on).toBe('0');
    optRow('Misc.LogOutOnDeath').querySelector<HTMLElement>('[data-check]')!.click();
    expect(t.stored.get('Misc.LogOutOnDeath')).toBe('True');
    expect(optRow('Misc.LogOutOnDeath').dataset.on).toBe('1');
    // Turn the parent off, then a child on: the parent comes back on.
    optRow('ItemInfoOnIdent.Enabled').querySelector<HTMLElement>('[data-check]')!.click();
    expect(t.stored.get('ItemInfoOnIdent.Enabled')).toBe('False');
    optRow('ItemInfoOnIdent.ShowValueAndBurden').querySelector<HTMLElement>('[data-check]')!.click();
    expect(t.stored.get('ItemInfoOnIdent.Enabled')).toBe('True');
    // Target Output Window: a number saves; non-numbers fall back to the default.
    const field = t.body.querySelector<HTMLInputElement>('[data-mt="OutputWindow"]')!;
    expect([field.value, field.style.left, field.style.top]).toEqual(['1', '272px', '17px']);
    field.value = '3'; field.dispatchEvent(new Event('input'));
    expect(t.options.int('Misc.OutputTargetWindow')).toBe(3);
    field.value = 'x'; field.dispatchEvent(new Event('input'));
    expect(t.options.int('Misc.OutputTargetWindow')).toBe(1);
    // Filters: 29 rows, all off; one toggles on.
    t.click('[data-mt-tab="  Filters  "]');
    const filters = [...t.body.querySelectorAll<HTMLElement>('[data-mt-list="Misc/Filters"] [data-mt-option]')];
    expect(filters).toHaveLength(29);
    expect(filters.every((r) => r.dataset.on === '0')).toBe(true);
    optRow('Filters.NpcChatter').querySelector<HTMLElement>('[data-check]')!.click();
    expect(t.stored.get('Filters.NpcChatter')).toBe('True');
    // Combat → Options: Sort Alphabetically reorders the monster list.
    for (const l of ['You chill Zombie for 5 points with Frost Bolt I.', 'You chill Banderling for 5 points with Frost Bolt I.']) {
      const e = new MtCombatParser({ me: () => ME }).parse(l); if (e) t.current.record(e);
    }
    t.click('[data-mt-tab=" Trackers "]');
    t.click('[data-mt-tab=" Combat "]');
    t.click('[data-mt-tab="    Options    "]');
    const sort = optRow('CombatTracker.SortAlphabetically');
    expect([sort.style.left, sort.style.top]).toEqual(['10px', '140px']);
    sort.querySelector<HTMLElement>('[data-check]')!.click();
    expect(t.stored.get('CombatTracker.SortAlphabetically')).toBe('True');
    t.click('[data-mt-tab=" Current Session Stats "]');
    const names = [...t.body.querySelectorAll<HTMLElement>('[data-mt-list="monsters-current"] [data-mt-cell="1"]')].map((c) => c.dataset.text);
    expect(names).toEqual(['', 'All', 'Banderling', 'Zombie']);
  });

  it('draws only the options the host says run (optionShown)', () => {
    const t = setup();
    t.host.optionShown = (d) => d.status === 'build' && d.path !== 'ManaManagement.AutoRecharge';
    t.win.render(t.body);
    expect(t.body.querySelector('[data-mt-option="ManaManagement.AutoRecharge"]')).toBeNull();
    t.click('[data-mt-tab="   Misc   "]');
    expect(t.body.querySelector('[data-mt-option="AutoBuySell.Enabled"]')).toBeNull();
    expect(t.body.querySelector('[data-mt-option="Misc.LogOutOnDeath"]')).not.toBeNull();
    // Without a filter, Recharge sits at its mainView.xml place.
    const u = setup();
    const r = u.body.querySelector<HTMLElement>('[data-mt-option="ManaManagement.AutoRecharge"]')!;
    expect([r.style.left, r.style.top, r.dataset.on]).toEqual(['125px', '386px', '1']);
  });

  describe('Auto Trade Accept whitelist editor (Misc → Options; ours, spec §3.4)', () => {
    const withWhitelist = () => {
      const t = setup();
      const printed: string[] = [];
      const store: MtOptionStorage = { get: (k) => t.stored.get(k), set: (k, v) => { t.stored.set(k, v); } };
      t.host.tradeWhitelist = { read: () => readMtTradeWhitelist(store), write: (p) => writeMtTradeWhitelist(store, p), print: (l) => printed.push(l) };
      t.win.render(t.body);
      t.click('[data-mt-tab="   Misc   "]');
      const field = () => t.body.querySelector<HTMLInputElement>('input[name="AutoTradeAcceptWhitelistText"]')!;
      const type = (v: string) => { const f = field(); f.value = v; f.dispatchEvent(new Event('input')); };
      const add = () => t.click('[data-mt-page="misc/options"] [data-mt-button="Add"]');
      const rows = () => [...t.body.querySelectorAll<HTMLElement>('[data-mt-list="AutoTradeAcceptWhitelist"] [data-mt-row]')]
        .map((r) => r.querySelector<HTMLElement>('[data-mt-cell="0"]')!.dataset.text);
      const stored = () => JSON.parse(t.stored.get(MT_TRADE_WHITELIST_KEY) ?? '[]') as string[];
      return { t, printed, field, type, add, rows, stored };
    };

    it('sits right of the option list with its label, a named text box, Add and a list', () => {
      const w = withWhitelist();
      const label = w.t.body.querySelector<HTMLElement>('[data-mt="AutoTradeAcceptWhitelistLabel"]')!;
      expect(label.textContent).toBe(MT_TRADE_WHITELIST_LABEL);
      expect([label.style.left, label.style.top]).toEqual(['225px', '45px']);
      expect(w.field()).not.toBeNull();
      const list = w.t.body.querySelector<HTMLElement>('[data-mt-list="AutoTradeAcceptWhitelist"]')!;
      // The label wraps to three VVS lines (45..~81): the box sits below it (live, 2026-10-13: "(regex):" ran into it at 80).
      const box = w.t.body.querySelector<HTMLElement>('[data-mt="AutoTradeAcceptWhitelistText"]');
      expect(box?.style.top).toBe('90px');
      expect([list.style.left, list.style.top, list.style.width]).toEqual(['222px', '135px', '98px']);
      // Gone with its option (optionShown) or without a source.
      w.t.host.optionShown = (d) => d.path !== 'AutoTradeAccept.Enabled';
      w.t.win.render(w.t.body);
      expect(w.t.body.querySelector('[data-mt-list="AutoTradeAcceptWhitelist"]')).toBeNull();
    });

    it('Add stores the typed regex and lists it; blanks and duplicates are ignored', () => {
      const w = withWhitelist();
      w.type('  Hero.*  ');
      w.add();
      expect(w.stored()).toEqual(['Hero.*']);
      expect(w.rows()).toEqual(['Hero.*']);
      expect(w.field().value).toBe('');
      w.type('Mule|Bank');
      w.add();
      w.type('Hero.*');
      w.add();
      w.type('   ');
      w.add();
      expect(w.stored()).toEqual(['Hero.*', 'Mule|Bank']);
      expect(w.rows()).toEqual(['Hero.*', 'Mule|Bank']);
      expect(w.printed).toEqual([]);
      // The stored entries keep the full-name regex semantics.
      expect(mtTradeWhitelistMatches('Heroic Mule', w.stored())).toBe(true);
      expect(mtTradeWhitelistMatches('Mulex', w.stored())).toBe(false);
    });

    it('the delete icon removes its entry', () => {
      const w = withWhitelist();
      for (const v of ['Alpha', 'Beta', 'Gamma']) { w.type(v); w.add(); }
      const beta = w.t.body.querySelectorAll<HTMLElement>('[data-mt-list="AutoTradeAcceptWhitelist"] [data-mt-row]')[1]!;
      (beta.querySelector('[data-mt-cell="1"] [data-icon]') as HTMLElement).click();
      expect(w.stored()).toEqual(['Alpha', 'Gamma']);
      expect(w.rows()).toEqual(['Alpha', 'Gamma']);
    });

    it('refuses an invalid regex with a Mag-Tools chat line and keeps the text to fix', () => {
      const w = withWhitelist();
      w.type('Hero[');
      w.add();
      w.type('a)(b');
      w.add();
      expect(w.t.stored.has(MT_TRADE_WHITELIST_KEY)).toBe(false);
      expect(w.rows()).toEqual([]);
      expect(w.printed).toEqual([
        '<{Mag-Tools}>: Auto Trade Accept - "Hero[" is not a valid regular expression.',
        '<{Mag-Tools}>: Auto Trade Accept - "a)(b" is not a valid regular expression.',
      ]);
      expect(w.field().value).toBe('a)(b');
    });
  });
});
