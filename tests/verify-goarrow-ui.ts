// @vitest-environment happy-dom
/**
 * GoArrow's arrow HUD and main window (docs/plugin-specs/goarrow.md §1, §2): the window's notebooks and
 * controls with GoArrow's labels, search, Find Route, the go icon pointing the arrow, the HUD's frame for a
 * heading, its text lines, repainting only on change, Ctrl gating the move and the close box, and route
 * stepping on the name line. Drives the shipped code through a fake VVS kit and fake hosts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  GOARROW_DEFAULT_SETTINGS,
  GoLocationType,
  GoRegionMap,
  goArrowFrame,
  type GoArrowTarget,
  type GoCoords,
  type GoLocation,
  type GoPortalDevice,
  type GoStartLocation,
} from '@ac/shared';
import { ArrowHud, GOARROW_SHIPPED_SETS, goStepRouteTarget, planArrowHud, type ArrowHudHost, type ArrowHudPlayer, type ArrowHudSettings } from '../packages/renderer/src/ui/goarrow/ArrowHud.ts';
import { GOARROW_SHEETS } from '../packages/renderer/src/ui/goarrow/arrows/sheets.ts';
import { GoArrowModel, GOARROW_WINDOW_DEFAULT_SETTINGS, goWrapDescription, type GoArrowWindowHost, type GoArrowWindowSettings } from '../packages/renderer/src/ui/goarrow/GoArrowModel.ts';
import { renderGoArrowWindow } from '../packages/renderer/src/ui/goarrow/GoArrowWindow.ts';
import { renderVvsText } from '../packages/renderer/src/ui/automation/vvsText.ts';
import type { MenuItem } from '../packages/renderer/src/ui/automation/AutomationPanel.ts';
import type { VTankKit } from '../packages/renderer/src/ui/automation/VTankWindow.ts';

const huds: ArrowHud[] = [];
afterEach(() => { for (const h of huds.splice(0)) h.dispose(); document.body.innerHTML = ''; });

// ── fakes ──

let lastMenu: { items: MenuItem[]; pick: (v: string) => void } | null = null;
function fakeKit(): VTankKit {
  const div = (data: Record<string, string>, onClick?: () => void) => { const d = document.createElement('div'); Object.assign(d.dataset, data); if (onClick) d.addEventListener('click', onClick); return d; };
  return {
    text: (t) => { const s = document.createElement('span'); s.textContent = t; s.dataset.text = t; return s; },
    textTab: (label, on, onClick) => div({ tab: label, selected: on ? '1' : '0' }, onClick),
    flatButton: (label, onClick) => { const d = div({ button: label }, onClick); d.textContent = label; return d; },
    dropdown: (text, onClick) => { const d = div({ field: text }); d.addEventListener('click', () => onClick(d)); return d; },
    menu: (_a, items, onPick) => { lastMenu = { items, pick: onPick }; },
    slider: (value, _min, _max, _w, onChange) => { const i = document.createElement('input'); i.dataset.slider = String(value); i.addEventListener('change', () => onChange(Number(i.value))); return i; },
    check: (on, onChange) => div({ check: on ? '1' : '0' }, () => onChange(!on)),
    input: (value, _w, onChange) => { const i = document.createElement('input'); i.value = value; i.addEventListener('input', () => onChange(i.value)); return i; },
    row: (selected, onClick) => div({ row: selected ? '1' : '0' }, onClick),
    icon: (id) => div({ icon: `0x${id.toString(16)}` }),
    list: () => {},
    colors: { text: 'white', dim: 'grey', gold: 'gold', good: 'green', warn: 'yellow', bad: 'red' },
  } as Partial<VTankKit> as VTankKit;
}

const holtburg: GoLocation = { id: 10, name: 'Holtburg', type: GoLocationType.Town, coords: { ns: 42.1, ew: 33.6 }, notes: 'A town in the north of Aluvia.', useInRouteFinding: true };
const holtPortal: GoLocation = { id: 11, name: 'Holtburg Outpost Portal', type: GoLocationType.Portal, coords: { ns: 40, ew: 30 }, exitCoords: { ns: -20, ew: 10 }, notes: '', useInRouteFinding: true };
const yaraq: GoLocation = { id: 12, name: 'Yaraq', type: GoLocationType.Town, coords: { ns: -21.5, ew: -1.8 }, notes: '', useInRouteFinding: true };

class FakeWindowHost implements GoArrowWindowHost {
  s: GoArrowWindowSettings = structuredClone(GOARROW_WINDOW_DEFAULT_SETTINGS) as GoArrowWindowSettings;
  locs: GoLocation[] = [holtburg, holtPortal, yaraq];
  starts: GoStartLocation[] = [];
  devices: GoPortalDevice[] = [];
  me: GoCoords | null = { ns: 41, ew: 31 };
  target: GoArrowTarget | null = null;
  said: Array<[string, string | undefined]> = [];
  copied: string[] = [];
  sizes: Array<[number, number]> = [];
  kv = new Map<string, unknown>();
  store = { load: (k: string) => this.kv.get(k) ?? null, save: (k: string, v: unknown) => { this.kv.set(k, v); } };
  settings() { return this.s; }
  saveSettings(p: Partial<GoArrowWindowSettings>) { this.s = { ...this.s, ...p }; }
  locations() { return this.locs; }
  routeWorld() { return { locations: this.locs, regions: GoRegionMap.uniform(0) }; }
  startLocations() { return this.starts; }
  saveStartLocations(l: GoStartLocation[]) { this.starts = l; }
  portalDevices() { return this.devices; }
  savePortalDevices(l: GoPortalDevice[]) { this.devices = l; }
  player() { return this.me; }
  arrowTarget() { return this.target; }
  setArrowTarget(t: GoArrowTarget) { this.target = t; this.s = { ...this.s, visible: true }; }
  say(text: string, kind?: string) { this.said.push([text, kind]); }
  copy(text: string) { this.copied.push(text); }
  resize(w: number, h: number) { this.sizes.push([w, h]); }
}

function setupWindow(top: GoArrowModel['top'] = 'Atlas') {
  const host = new FakeWindowHost();
  const model = new GoArrowModel(host);
  model.top = top;
  const body = document.createElement('div');
  document.body.appendChild(body);
  const kit = fakeKit();
  const redraw = () => renderGoArrowWindow(body, kit, model, redraw);
  redraw();
  return { host, model, body, redraw };
}

const press = (el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init }));
const labels = (body: HTMLElement) => [...body.querySelectorAll<HTMLElement>('[data-text], [data-ac-run-text]')].map((e) => e.dataset.text ?? e.dataset.acRunText);
const tabsOf = (body: HTMLElement, group: string) => [...body.querySelectorAll<HTMLElement>(`[data-goarrow-tabs="${group}"] [data-tab]`)].map((e) => e.dataset.tab);
const checks = (body: HTMLElement) => [...body.querySelectorAll<HTMLElement>('[data-goarrow-check]')].map((e) => e.dataset.goarrowCheck);
const buttons = (body: HTMLElement) => [...body.querySelectorAll<HTMLElement>('[data-goarrow-button]')].map((e) => e.dataset.goarrowButton);
const field = (body: HTMLElement, name: string) => body.querySelector<HTMLInputElement>(`[data-goarrow-edit="${name}"]`)!;
const type = (input: HTMLInputElement, v: string) => { input.value = v; input.dispatchEvent(new Event('input')); };
const clickTab = (body: HTMLElement, name: string) => body.querySelector<HTMLElement>(`[data-tab="${name}"]`)!.click();

// ── the window ──

describe('GoArrow window: notebooks and controls (spec §2)', () => {
  it('has the top tabs, no map or Update tabs, and resizes per top tab', () => {
    const { body, host } = setupWindow('Atlas');
    expect(tabsOf(body, 'main')).toEqual(['HUDs', 'Atlas', 'Settings']);
    expect(tabsOf(body, 'atlas')).toEqual(['Search', 'Route', 'Details', 'Favorites', 'Recent']);
    clickTab(body, 'HUDs');
    expect(tabsOf(body, 'huds')).toEqual(['Arrow', 'General']);
    expect(host.sizes.at(-1)).toEqual([216 + 12, 280 + 35]);
    clickTab(body, 'Settings');
    expect(tabsOf(body, 'settings')).toEqual(['Chat', 'Route Finding', 'About']);
    expect(host.sizes.at(-1)).toEqual([272 + 12, 338 + 35]);
    expect(body.querySelector('[data-tab="Dereth"], [data-tab="Dungeon"], [data-tab="Update"]')).toBeNull();
  });

  it('HUDs > Arrow carries GoArrow\'s labels at its places, and its options save', () => {
    const { body, host } = setupWindow('HUDs');
    expect(checks(body)).toEqual(['Show Arrow', 'Show arrow indoors', 'Show destination over arrow', 'Show distance under arrow', 'Require Ctrl key to move arrow', 'Automatically track corpses', 'Bold']);
    expect(buttons(body)).toEqual(['Here', '+', '-', 'Reset Position']);
    expect(labels(body)).toEqual(expect.arrayContaining(['Coords', 'Arrow image', 'Text color', 'Text size']));
    const show = body.querySelector<HTMLElement>('[data-goarrow-check="Show Arrow"]')!;
    expect([show.style.left, show.style.top]).toEqual(['4px', '8px']);
    expect(show.querySelector('[data-vvs-bold="1"]')).not.toBeNull();
    const reset = body.querySelector<HTMLElement>('[data-goarrow-button="Reset Position"]')!;
    expect([reset.style.left, reset.style.top]).toEqual(['56px', '196px']);
    // The defaults (spec §2.2, §7), then toggles.
    expect(body.querySelector<HTMLElement>('[data-goarrow-check="Show destination over arrow"]')!.dataset.on).toBe('1');
    expect(show.dataset.on).toBe('0');
    press(show);
    expect(host.s.visible).toBe(true);
    press(body.querySelector('[data-goarrow-check="Require Ctrl key to move arrow"]')!);
    expect(host.s.positionLocked).toBe(false);
    body.querySelector<HTMLElement>('[data-goarrow-button="+"]')!.click();
    expect(host.s.textSize).toBe(15);
    type(field(body, 'edtTextSize'), '40');
    field(body, 'edtTextSize').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(host.said.at(-1)?.[0]).toBe('Text size must be between 8 and 28');
    body.querySelector<HTMLElement>('[data-goarrow-dropdown="choTextColor"]')!.click();
    expect(lastMenu!.items.map((i) => i.label)).toEqual(['White', 'Black', 'Blue', 'Gold', 'Green', 'Pink', 'Red', 'Yellow']);
    lastMenu!.pick(String(0xffd700));
    expect(host.s.textColor).toBe(0xffd700);
    body.querySelector<HTMLElement>('[data-goarrow-dropdown="choArrowImage"]')!.click();
    expect(lastMenu!.items.map((i) => i.label)).toEqual(['Chrome', 'Simple']);
    body.querySelector<HTMLElement>('[data-goarrow-button="Reset Position"]')!.click();
    expect(host.said.at(-1)?.[0]).toBe('The arrow should now be in a visible location on the screen');
  });

  it('Atlas > Search, Route, Details, Favorites, Recent and Settings carry their labels', () => {
    const { body, model, redraw } = setupWindow('Atlas');
    expect(checks(body)).toEqual(['Text', 'Nearby', 'Relative Coordinates']);
    expect(labels(body)).toEqual(expect.arrayContaining(['km', 'Limit to', '0 - ', 'matches found']));
    expect(field(body, 'edtSearchCoords').value).toBe('Enter Coords');
    expect(field(body, 'edtSearchRadius').value).toBe('5');
    clickTab(body, 'Route');
    expect(labels(body)).toEqual(expect.arrayContaining(['From', 'To', 'Coords', '0 km']));
    expect(buttons(body)).toEqual(['Copy', 'Find Route', 'Next longer']);
    expect(body.querySelectorAll('[data-goarrow-check="Here"]')[0]!.getAttribute('data-on')).toBe('1');
    expect(body.querySelectorAll('[data-goarrow-check="Here"]')[1]!.getAttribute('data-on')).toBe('0');
    clickTab(body, 'Details');
    expect(labels(body)).toEqual(expect.arrayContaining(['No location selected', 'Absolute Coords:', 'Relative Coords:']));
    expect(buttons(body)).toEqual(['Copy', 'Minimize', 'Route Start', 'Arrow Target', 'Route End', 'Add Favorite']);
    clickTab(body, 'Favorites');
    expect(labels(body)).toEqual(expect.arrayContaining(['Favorite Locations', 'Ctrl+Click icon to remove']));
    clickTab(body, 'Recent');
    expect(labels(body)).toEqual(expect.arrayContaining(['Recent Locations', 'Recent Arrow Coordinates', 'Click icon to remove']));
    model.setTop('Settings');
    redraw();
    expect(checks(body)).toEqual(['Make coords in chat area clickable', 'Main Chat', '1', '2', '3', '4', 'Always show errors in Main Chat',
      "Enable '/goarrow loc' command alias", "Enable '/goarrow dest' command alias", "Enable '/goarrow find' command alias"]);
    expect(labels(body)).toEqual(expect.arrayContaining(['Display GoArrow messages in:', 'Chat command: /', "Type '/goarrow help' to see chat commands"]));
    clickTab(body, 'Route Finding');
    expect(labels(body)).toEqual(expect.arrayContaining(['Maximum running distance between portals', 'Treat using a portal equivalent to running', 'Add or modify a start location', 'Run dist']));
    expect(tabsOf(body, 'routeSettings')).toEqual(['Start Locations', 'Portal Devices']);
    expect(field(body, 'edtMaxRunDist').value).toBe('50');
    expect(field(body, 'edtPortalRunDist').value).toBe('0.4');
  });

  it('renaming the chat command renames the alias labels; a duplicate is refused', () => {
    const { body, host, model, redraw } = setupWindow('Settings');
    type(field(body, 'edtChatCommand'), 'ga');
    field(body, 'edtChatCommand').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(host.s.chatCommand).toBe('ga');
    expect(checks(body)).toContain("Enable '/ga loc' command alias");
    expect(model.renameCommand('loc', 'ga')).toBe("The '/ga loc' command alias cannot be the same as another goarrow chat command.");
    redraw();
  });
});

describe('GoArrow window: search, routes and the go icon', () => {
  it('Search lists matches in index order with the footer count', () => {
    const { body } = setupWindow('Atlas');
    type(field(body, 'edtSearchName'), 'holt');
    body.querySelector<HTMLElement>('[data-goarrow-button="Search"]')!.click();
    const rows = [...body.querySelectorAll<HTMLElement>('[data-goarrow-list="lstSearchResults"] [data-goarrow-name]')].map((r) => r.dataset.goarrowName);
    expect(rows).toEqual(['Holtburg', 'Holtburg Outpost Portal']);
    expect(labels(body)).toContain('2 - ');
    expect(body.querySelector('[data-goarrow-location="10"] [data-goarrow-cell="coords"] [data-text]')!.textContent).toBe('42.1N, 33.6E');
  });

  it('Search: Nearby needs a radius and coords; Text and Nearby keep one on; Ctrl makes one exclusive', () => {
    const { body, host, model } = setupWindow('Atlas');
    press(body.querySelector('[data-goarrow-check="Text"]')!);
    expect([model.searchText, model.searchNearby]).toEqual([false, true]);
    press(body.querySelector('[data-goarrow-check="Text"]')!, { ctrlKey: true });
    expect([model.searchText, model.searchNearby]).toEqual([true, false]);
    model.searchNearby = true;
    model.searchRadius = '0';
    model.search();
    expect(host.said.at(-1)?.[0]).toBe('Invalid search radius; must be a number greater than 0');
    model.searchRadius = '5';
    model.search();
    expect(host.said.at(-1)?.[0]).toBe('Invalid coordinates for nearby search');
    model.searchText = false;
    model.searchHere();
    model.search();
    expect(model.results.map((l) => l.name)).toEqual(['Holtburg', 'Holtburg Outpost Portal']);
  });

  it('the go icon points the arrow at the location, shows it, and records it as recent', () => {
    const { body, host } = setupWindow('Atlas');
    type(field(body, 'edtSearchName'), 'yaraq');
    body.querySelector<HTMLElement>('[data-goarrow-button="Search"]')!.click();
    press(body.querySelector('[data-goarrow-location="12"] [data-goarrow-cell="go"]')!);
    expect(host.target).toEqual({ kind: 'location', name: 'Yaraq', coords: { ns: -21.5, ew: -1.8 } });
    expect(host.s.visible).toBe(true);
    expect(host.kv.get('recentLocations')).toEqual([12]);
    expect((host.kv.get('recentCoords') as Array<{ name: string }>)[0]!.name).toBe('Yaraq');
    // Name click opens Details; Ctrl sets the route end; the icon removes the row.
    press(body.querySelector('[data-goarrow-location="12"] [data-goarrow-cell="name"]')!);
    expect(body.querySelector<HTMLElement>('[data-goarrow-details="name"]')!.dataset.goarrowLabel).toBe('Yaraq');
  });

  it('Find Route lists the steps and the total, the go icon targets a step, and Copy copies it', () => {
    const { body, host, model } = setupWindow('Atlas');
    clickTab(body, 'Route');
    // From: Here (41N, 31E). To: Yaraq's coords.
    type(field(body, 'edtRouteToCoords'), '21.5S, 1.8W');
    body.querySelector<HTMLElement>('[data-goarrow-button="Find Route"]')!.click();
    const steps = [...body.querySelectorAll<HTMLElement>('[data-goarrow-list="lstRoute"] [data-goarrow-step]')].map((r) => r.dataset.goarrowName);
    // Typed coords: a temporary End Point (spec §4.2).
    expect(steps).toEqual(['Start Point', 'Holtburg Outpost Portal', 'End Point']);
    const total = Math.hypot(1, 1) + 0.4 + Math.hypot(1.5, 11.8);
    expect(body.querySelector<HTMLElement>('[data-goarrow-route-distance]')!.dataset.goarrowLabel).toBe(`${total.toFixed(2)} km`);
    // Picking the location in the To dropdowns makes it the end itself.
    body.querySelector<HTMLElement>('[data-goarrow-dropdown="choRouteToLtr"]')!.click();
    lastMenu!.pick('Y');
    body.querySelector<HTMLElement>('[data-goarrow-dropdown="choRouteTo"]')!.click();
    expect(lastMenu!.items.map((i) => i.label)).toEqual(['<Custom>', 'Yaraq']);
    lastMenu!.pick('12');
    expect(field(body, 'edtRouteToCoords').value).toBe('21.5S, 1.8W');
    body.querySelector<HTMLElement>('[data-goarrow-button="Find Route"]')!.click();
    expect([...body.querySelectorAll<HTMLElement>('[data-goarrow-step]')].map((r) => r.dataset.goarrowName)).toEqual(['Start Point', 'Holtburg Outpost Portal', 'Yaraq']);
    press(body.querySelector('[data-goarrow-step="1"] [data-goarrow-cell="go"]')!);
    expect(host.target).toMatchObject({ kind: 'route', index: 1, names: ['Start Point', 'Holtburg Outpost Portal', 'Yaraq'] });
    body.querySelector<HTMLElement>('[data-goarrow-button="Copy"]')!.click();
    expect(host.copied.at(-1)).toBe('Start Point [41.0N, 31.0E] >> Holtburg Outpost Portal [40.0N, 30.0E] >> Yaraq [21.5S, 1.8W]');
    body.querySelector<HTMLElement>('[data-goarrow-button="Next longer"]')!.click();
    expect(host.said.at(-1)?.[0]).toBe("Can't find any more routes.");
    expect(model.routeLabel).toBe('No route found');
    // No To coords: GoArrow's message.
    model.to.coordsText = '';
    model.findRoute();
    expect(host.said.at(-1)?.[0]).toBe('Invalid end point coordinates');
  });

  it('Details: Add Favorite, then Favorites removes only with Ctrl; Minimize shrinks the window', () => {
    const { body, host, model, redraw } = setupWindow('Atlas');
    model.showDetails(holtburg);
    redraw();
    expect(body.querySelector<HTMLElement>('[data-goarrow-details="type"]')!.dataset.goarrowLabel).toBe('Town');
    expect([...body.querySelectorAll<HTMLElement>('[data-goarrow-description]')].map((e) => e.dataset.goarrowDescription)).toEqual(goWrapDescription(holtburg.notes));
    body.querySelector<HTMLElement>('[data-goarrow-button="Add Favorite"]')!.click();
    body.querySelector<HTMLElement>('[data-goarrow-button="Add Favorite"]')!.click();
    expect(host.said.at(-1)?.[0]).toBe('Holtburg is already in your favorites list');
    body.querySelector<HTMLElement>('[data-goarrow-button="Minimize"]')!.click();
    expect(host.sizes.at(-1)).toEqual([272 + 12, 136 + 35]);
    expect(buttons(body)).toContain('Restore');
    clickTab(body, 'Favorites');
    const icon = body.querySelector('[data-goarrow-list="lstFavorites"] [data-goarrow-cell="icon"]')!;
    press(icon);
    expect(host.kv.get('favorites')).toEqual([10]);
    press(icon, { ctrlKey: true });
    expect(host.kv.get('favorites')).toEqual([]);
  });

  it('wraps descriptions at 42 characters', () => {
    expect(goWrapDescription('one two three four five six seven eight nine ten eleven')).toEqual(['one two three four five six seven eight', 'nine ten eleven']);
  });
});

// ── the HUD ──

const CHROME = GOARROW_SHEETS.find((s) => s.name === 'Chrome')!;
const settings = (p: Partial<ArrowHudSettings> = {}): ArrowHudSettings => ({ ...structuredClone(GOARROW_DEFAULT_SETTINGS), visible: true, ...p });
const me = (heading = 0, coords: GoCoords = { ns: 0, ew: 0 }): ArrowHudPlayer => ({ coords, heading, inDungeon: false });

type Call = [string, unknown[]];
function recordingCanvas(): HTMLCanvasElement & { calls: Call[] } {
  const c = document.createElement('canvas') as HTMLCanvasElement & { calls: Call[] };
  c.calls = [];
  const props: Record<string, unknown> = {};
  const ctx = new Proxy({}, {
    get: (_t, k) => (typeof k === 'string' && k in props ? props[k] : k === 'measureText' ? (t: string) => ({ width: t.length * 8 }) : (...a: unknown[]) => { c.calls.push([String(k), a]); }),
    set: (_t, k, v) => { props[String(k)] = v; c.calls.push([`=${String(k)}`, [v]]); return true; },
  });
  (c as unknown as { getContext: () => unknown }).getContext = () => ctx;
  return c;
}

class FakeHudHost implements ArrowHudHost {
  s = settings();
  me: ArrowHudPlayer | null = me();
  t: GoArrowTarget | null = { kind: 'location', name: 'Holtburg', coords: { ns: 42.1, ew: 33.6 } };
  saved: Array<{ x: number; y: number }> = [];
  hidden = 0;
  canvas = recordingCanvas();
  player() { return this.me; }
  target() { return this.t; }
  settings() { return this.s; }
  savePosition(p: { x: number; y: number }) { this.saved.push(p); this.s = { ...this.s, location: p }; }
  hide() { this.hidden++; this.s = { ...this.s, visible: false }; }
  setTarget(t: GoArrowTarget) { this.t = t; }
  loadImage() { return Promise.resolve({} as CanvasImageSource); }
  createCanvas() { return this.canvas; }
}

async function setupHud() {
  const host = new FakeHudHost();
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const hud = new ArrowHud(host, parent);
  huds.push(hud);
  hud.update();
  await new Promise((r) => setTimeout(r, 0));
  hud.update();
  return { host, hud, parent };
}

const mouse = (type: string, x: number, y: number, init: MouseEventInit = {}) =>
  document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...init }));

describe('GoArrow arrow HUD (spec §1)', () => {
  it('ships the Chrome and Simple sets as sprite sheets', () => {
    expect(GOARROW_SHIPPED_SETS).toEqual(['Chrome', 'Simple']);
    expect(CHROME).toMatchObject({ frames: 180, width: 69, height: 71 });
    expect(CHROME.url()).toMatch(/chrome\.png$/);
  });

  it('picks the frame from the bearing minus the character\'s heading', () => {
    const plan = (heading: number, dest: GoCoords) => planArrowHud({ player: me(heading), target: { kind: 'coords', coords: dest }, settings: settings(), sheet: CHROME, hover: false }).frame;
    expect(plan(0, { ns: 10, ew: 0 })).toBe(0); // north, facing north: dead ahead
    expect(plan(0, { ns: 0, ew: 10 })).toBe(45); // east: 90° clockwise of 180 frames
    expect(plan(0, { ns: -10, ew: 0 })).toBe(90);
    expect(plan(Math.PI / 2, { ns: 0, ew: 10 })).toBe(0); // facing east, target east
    expect(plan(Math.PI / 2, { ns: 10, ew: 0 })).toBe(135); // facing east, target north: to the left
    expect(plan(0, { ns: 10, ew: 10 })).toBe(goArrowFrame(Math.PI / 4, 180));
  });

  it('draws that frame out of the sheet, centred, below the text', async () => {
    const host = new FakeHudHost();
    host.t = { kind: 'coords', coords: { ns: 0, ew: 10 } };
    const hud = new ArrowHud(host, document.body);
    huds.push(hud);
    hud.update();
    await new Promise((r) => setTimeout(r, 0));
    const draw = host.canvas.calls.find(([k, a]) => k === 'drawImage' && a.length === 9);
    // Frame 45: column 45 % 14 = 3, row 3; x = floor((400 − 69) / 2) = 165, y = 1 + 2 × 14 = 29.
    expect(draw?.[1].slice(1)).toEqual([3 * 69, 3 * 71, 69, 71, 165, 29, 69, 71]);
  });

  it('draws the name, coords and distance lines with the 8-copy outline', async () => {
    const { host, hud } = await setupHud();
    expect(hud.plan!.lines).toEqual([
      { kind: 'name', text: 'Holtburg', y: 0 },
      { kind: 'coords', text: '42.1N, 33.6E', y: 14 },
      { kind: 'distance', text: Math.hypot(42.1, 33.6).toFixed(2), y: 29 + 71 },
    ]);
    const texts = host.canvas.calls.filter(([k]) => k === 'fillText').map(([, a]) => a[0]);
    expect(texts.filter((t) => t === 'Holtburg')).toHaveLength(9);
    expect(host.canvas.calls.find(([k]) => k === '=font')?.[1][0]).toBe('bold 14px Arial');
    // Route mode: ◄ / ► hints; an out-of-range object; bare coords have no name line.
    const route: GoArrowTarget = { kind: 'route', names: ['A', 'B', 'C'], coords: [{ ns: 1, ew: 1 }, { ns: 2, ew: 2 }, { ns: 3, ew: 3 }], index: 1 };
    expect(planArrowHud({ player: me(), target: route, settings: settings(), sheet: CHROME, hover: false }).lines[0]!.text).toBe('◄  B  ►');
    expect(planArrowHud({ player: me(), target: { kind: 'object', name: 'Drudge', coords: null, inRange: false }, settings: settings(), sheet: CHROME, hover: false }).lines.map((l) => l.text)).toEqual(['Drudge (out of range)', '<None>', 'Infinity']);
    expect(planArrowHud({ player: me(), target: { kind: 'coords', coords: { ns: 1, ew: 2 } }, settings: settings({ showDistanceUnder: false }), sheet: CHROME, hover: false }).lines.map((l) => l.kind)).toEqual(['coords']);
    // Without the destination line the image sits at y = 1.
    expect(planArrowHud({ player: me(), target: null, settings: settings({ showDestinationOver: false }), sheet: CHROME, hover: false }).image.y).toBe(1);
  });

  it('repaints only when what it draws changes', async () => {
    const { host, hud } = await setupHud();
    const n = hud.paints;
    hud.update();
    hud.update();
    expect(hud.paints).toBe(n);
    host.me = me(0.001); // the same frame, the same distance text
    hud.update();
    expect(hud.paints).toBe(n);
    host.me = me(Math.PI / 2);
    hud.update();
    expect(hud.paints).toBe(n + 1);
  });

  it('is hidden in a dungeon unless "Show arrow indoors", and says why', async () => {
    const { host, hud } = await setupHud();
    host.me = { ...me(), inDungeon: true };
    hud.update();
    expect(hud.root.style.display).toBe('none');
    expect(hud.hiddenReason()).toBe('The arrow is enabled, but not visible because you are indoors');
    host.s = { ...host.s, displayIndoors: true };
    hud.update();
    expect(hud.root.style.display).toBe('block');
  });

  it('moves only with Ctrl held while "Require Ctrl key to move arrow" is on (read on mousedown)', async () => {
    const { host, hud } = await setupHud();
    // Location (100, 100); image at (165, 29) 69 × 71.
    const ix = 100 + 165 + 30, iy = 100 + 29 + 40;
    expect(mouse('mousedown', ix, iy)).toBe(true); // not handled: reaches the game
    mouse('mousemove', ix + 50, iy + 20);
    mouse('mouseup', ix + 50, iy + 20);
    expect(host.saved).toEqual([]);
    mouse('mousemove', ix, iy, { ctrlKey: true });
    expect(hud.plan!.hover).toBe(true);
    expect(mouse('mousedown', ix, iy, { ctrlKey: true })).toBe(false); // eaten
    mouse('mousemove', ix + 50, iy + 20, { ctrlKey: true });
    mouse('mouseup', ix + 50, iy + 20, { ctrlKey: true });
    expect(host.saved).toEqual([{ x: 150, y: 120 }]);
    // Its contextmenu (a Mac's Ctrl+click) is swallowed once.
    const cm = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(cm);
    expect(cm.defaultPrevented).toBe(true);
    // Unlocked: no Ctrl needed.
    host.s = { ...host.s, positionLocked: false };
    hud.update();
    const jx = 150 + 165 + 30, jy = 120 + 29 + 40;
    mouse('mousemove', jx, jy);
    expect(hud.plan!.hover).toBe(true);
    mouse('mousedown', jx, jy);
    mouse('mousemove', jx - 10, jy);
    mouse('mouseup', jx - 10, jy);
    expect(host.saved.at(-1)).toEqual({ x: 140, y: 120 });
  });

  it('the close box (Ctrl held) hides the arrow', async () => {
    const { host, hud } = await setupHud();
    // Close box: 2 px in from the image's top-right, 14 px.
    const cx = 100 + 165 + 69 - 2 - 7, cy = 100 + 29 + 2 + 7;
    mouse('mousemove', cx, cy, { ctrlKey: true });
    expect(hud.plan!.closeBox).toEqual({ x: 165 + 69 - 16, y: 31, w: 14, h: 14 });
    mouse('mousedown', cx, cy, { ctrlKey: true });
    expect(host.hidden).toBe(1);
    expect(hud.root.style.display).toBe('none');
  });

  it('a click on either end of the route name line steps the route', async () => {
    const { host, hud } = await setupHud();
    host.t = { kind: 'route', names: ['Start', 'Middle', 'End'], coords: [{ ns: 1, ew: 1 }, { ns: 2, ew: 2 }, { ns: 3, ew: 3 }], index: 1 };
    hud.update();
    const text = '◄  Middle  ►';
    const w = text.length * 8; // the fake measureText
    const left = 100 + (400 - w) / 2;
    mouse('mousedown', left + 2, 105);
    expect(host.t).toMatchObject({ index: 0 });
    hud.update();
    const text0 = 'Start  ►';
    const left0 = 100 + (400 - text0.length * 8) / 2;
    mouse('mousedown', left0 + text0.length * 8 - 2, 105);
    expect(host.t).toMatchObject({ index: 1 });
    expect(goStepRouteTarget(host.t, 1)).toMatchObject({ index: 2 });
    expect(goStepRouteTarget({ kind: 'coords', coords: { ns: 0, ew: 0 } }, 1)).toBeNull();
  });
});

describe('VVS text styles', () => {
  it('draws bold and italic labels in the Decal font style', () => {
    const b = renderVvsText('Show Arrow', undefined, { bold: true });
    expect(b.dataset.vvsBold).toBe('1');
    expect(renderVvsText('x', undefined, { italic: true }).dataset.vvsItalic).toBe('1');
  });
});
