/**
 * RELEASE.launcher-screen + RELEASE.remove-test-defaults — the client side:
 * world directory loading (pinned vs multi bridge), connect URLs, the ENTER
 * gate, Custom… bridge parsing, remember-last-world storage (never the
 * password), URL-credential gating, the debug-globals gate, and the
 * LauncherScreen itself driven in happy-dom through a fake LauncherKit.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  bridgeHttpOrigin, loadWorldDirectory, connectUrlFor, worldCredentialsBlock, worldEnterBlock, parseCustomBridge, worldFromEntry,
  localWorld, bridgeUrlWithServer, worldBoxName, LOCAL_WORLD_NAME, type World,
  eraIdFrom, probeBridgeEra, loginTimeoutText, worldRegistrationText,
} from '../packages/renderer/src/launcher/worldDirectory';
import {
  loadRememberedLogin, saveRememberedLogin, worldKeyOf, LAUNCHER_STORAGE_KEY,
} from '../packages/renderer/src/launcher/launcherStorage';
import { resolveUrlLogin } from '../packages/renderer/src/launcher/urlLogin';
import {
  exposeDebugGlobal, readDebugGlobal, debugBag, setDebugGlobalsEnabledForTest,
} from '../packages/renderer/src/utils/debugGlobals';
import { wrapLines, LAUNCHER_GEOMETRY } from '../packages/renderer/src/launcher/LauncherScreen';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { ERA_PROFILES } from '../packages/renderer/src/era/EraProfiles';

const BRIDGE = 'wss://bridge.example.org/connect';

function listed(over: Partial<World> = {}): World {
  return {
    id: 'c0ldeve', name: 'Coldeve', emu: 'ACE', type: 'PvE', description: 'A PvE server.', website: null,
    discord: 'https://discord.gg/x', online: true, population: 691, compat: 'ok', compatNote: null,
    registration: null, registrationUrl: null, kind: 'listed', era: null, ...over,
  };
}

type Call = { url: string };
function fakeFetch(routes: Record<string, unknown | Error | number>, calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (typeof r === 'number') return new Response('x', { status: r });
    if (r === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('world directory', () => {
  it('maps the bridge URL to its HTTP origin', () => {
    expect(bridgeHttpOrigin('wss://bridge.example.org/connect?x=1')).toBe('https://bridge.example.org');
    expect(bridgeHttpOrigin('ws://localhost:9094')).toBe('http://localhost:9094');
    expect(bridgeHttpOrigin('https://nope.org')).toBeNull();
    expect(bridgeHttpOrigin('garbage')).toBeNull();
  });

  it('pinned bridge (or one without a mode) → the single Local server world, no /servers call', async () => {
    const calls: Call[] = [];
    const dir = await loadWorldDirectory('ws://localhost:9094', fakeFetch({ 'http://localhost:9094/healthz': { up: true, mode: 'pinned' } }, calls));
    expect(dir.mode).toBe('pinned');
    expect(dir.worlds).toEqual([localWorld()]);
    expect(dir.worlds[0].name).toBe(LOCAL_WORLD_NAME);
    expect(calls.map(c => c.url)).toEqual(['http://localhost:9094/healthz']);
    const old = await loadWorldDirectory('ws://localhost:9094', fakeFetch({ 'http://localhost:9094/healthz': 404 }));
    expect(old.mode).toBe('pinned');
  });

  it('multi bridge → /servers rows as worlds; malformed rows and non-http links dropped', async () => {
    const dir = await loadWorldDirectory(BRIDGE, fakeFetch({
      'https://bridge.example.org/healthz': { mode: 'multi' },
      'https://bridge.example.org/servers': {
        mode: 'multi',
        servers: [
          { id: 'c0ldeve', name: 'Coldeve', emu: 'ACE', online: true, population: 691, compat: 'ok', website: 'javascript:alert(1)', discord: 'https://discord.gg/x' },
          { name: 'no id' },
          { id: 'seed', name: 'Seedsow', online: true, population: null, compat: 'incompatible', compatNote: 'Classic data: coming later' },
        ],
      },
    }));
    expect(dir.mode).toBe('multi');
    expect(dir.worlds.map(w => w.name)).toEqual(['Coldeve', 'Seedsow']);
    expect(dir.worlds[0]).toMatchObject({ website: null, discord: 'https://discord.gg/x', kind: 'listed', population: 691 });
    expect(dir.worlds[1]).toMatchObject({ compat: 'incompatible', population: null });
    expect(worldFromEntry({ id: 'x', compat: 'weird' })?.compat).toBe('ok');
  });

  it('register-first worlds: the row keeps its registration note and an http(s) registration link only', () => {
    const reef = worldFromEntry({
      id: 'a7502ac9-0cec-4caf-b81c-b3eb40a4689a', name: 'Reefcull', emu: 'GDL', compat: 'beta',
      registration: 'Register on the Reefcull website first (lower-case names only).',
      registrationUrl: 'http://reefcull.gdleac.com/',
    })!;
    expect(reef.registration).toBe('Register on the Reefcull website first (lower-case names only).');
    expect(reef.registrationUrl).toBe('http://reefcull.gdleac.com/');
    expect(worldFromEntry({ id: 'x', registrationUrl: 'javascript:alert(1)' })?.registrationUrl).toBeNull();
    // An older bridge sends no registrationUrl at all.
    expect(worldFromEntry({ id: 'x', registration: 'Ask in Discord' })).toMatchObject({ registration: 'Ask in Discord', registrationUrl: null });
    expect(localWorld().registrationUrl).toBeNull();
    // A link without text gets the launcher's own line.
    expect(worldRegistrationText({ name: 'Harvestbud', registration: null, registrationUrl: 'http://harvestbud.gdleac.com/' }))
      .toBe('Register on the Harvestbud website first.');
    expect(worldRegistrationText(listed())).toBeNull();
  });

  it('a login timeout on a register-first world says to register, with the link; other worlds keep the plain text', () => {
    const base = 'Client timed out the connection';
    const reef = listed({ name: 'Reefcull', registration: 'Register on the Reefcull website first.', registrationUrl: 'http://reefcull.gdleac.com/' });
    expect(loginTimeoutText(base, reef)).toBe(
      'Client timed out the connection\n\nNew account? Register on the Reefcull website first. http://reefcull.gdleac.com/');
    expect(loginTimeoutText(base, listed())).toBe(base);
    expect(loginTimeoutText(base, null)).toBe(base);
    expect(loginTimeoutText(base, listed({ registration: 'Register in our Discord first.' }))).toBe(`${base}\n\nNew account? Register in our Discord first.`);
  });

  it('an unreachable bridge throws (the launcher shows the error)', async () => {
    await expect(loadWorldDirectory(BRIDGE, fakeFetch({ 'https://bridge.example.org/healthz': new Error('offline') }))).rejects.toThrow();
    await expect(loadWorldDirectory('nonsense', fakeFetch({}))).rejects.toThrow(/not a bridge URL/);
  });

  it('connect URLs: listed → ?server=<id>; local → the bridge as is; custom → its own bridge', () => {
    expect(connectUrlFor(BRIDGE, listed())).toBe('wss://bridge.example.org/connect?server=c0ldeve');
    expect(connectUrlFor('ws://localhost:9094', localWorld())).toBe('ws://localhost:9094');
    const c = parseCustomBridge('wss://play.example.net/bridge');
    expect('world' in c && connectUrlFor(BRIDGE, c.world)).toBe('wss://play.example.net/bridge');
    expect(bridgeUrlWithServer('ws://localhost:9095/connect?server=old', 'new id')).toBe('ws://localhost:9095/connect?server=new+id');
    expect(worldBoxName(listed())).toBe('Coldeve');
    expect(worldBoxName(localWorld())).toBeNull();
  });

  it('ENTER gate: AC1999 credentials must fit the 1999 login field (18 characters together)', () => {
    const a99 = listed({ name: 'AC1999', era: 'ac1999-retail' });
    expect(worldCredentialsBlock(a99, 'player1', 'hunter12345')).toBeNull(); // 7 + 11 = 18
    expect(worldCredentialsBlock(a99, 'player1', 'hunter123456')).toBe(
      "AC1999 uses the 1999 login, which fits an account name and password of 18 characters together. Yours are 19. Use a shorter account name or password.");
    // Other eras have no such limit: end of retail and a classic (Dark Majesty) world.
    expect(worldCredentialsBlock(listed(), 'a'.repeat(30), 'b'.repeat(30))).toBeNull();
    expect(worldCredentialsBlock(listed({ name: 'Seedsow', era: 'classic-dereth' }), 'a'.repeat(30), 'b'.repeat(30))).toBeNull();
    expect(worldCredentialsBlock(null, 'a'.repeat(30), 'b')).toBeNull();
  });

  it('ENTER gate: incompatible and offline worlds explain instead of connecting', () => {
    expect(worldEnterBlock(listed())).toBeNull();
    expect(worldEnterBlock(listed({ compat: 'beta' }))).toBeNull();
    expect(worldEnterBlock(listed({ online: null }))).toBeNull();
    expect(worldEnterBlock(listed({ name: 'Seedsow', compat: 'incompatible' }))).toMatch(/Seedsow needs the classic/);
    expect(worldEnterBlock(listed({ name: 'Funky', online: false }))).toMatch(/Funky is offline/);
    expect(worldEnterBlock(null)).toMatch(/Pick a world/);
    // An era this build lacks (usually a page loaded before the deploy that added it): reload, never another era's data.
    expect(worldEnterBlock(listed({ name: 'FutureWorld', era: 'classic-dereth-9-9' }))).toBe('FutureWorld needs a kind of game data (classic-dereth-9-9) this version of the client does not know. Reload the page to update, or pick another world.');
    expect(worldEnterBlock(listed({ name: 'Snowreap', era: 'classic-dereth-1-0' }))).toBeNull();
  });

  it('Custom…: wss:// (scheme optional), ws:// only for localhost', () => {
    expect(parseCustomBridge('play.example.net:8443')).toMatchObject({ world: { kind: 'custom', bridgeUrl: 'wss://play.example.net:8443/', name: 'play.example.net:8443' } });
    expect(parseCustomBridge('ws://localhost:9094')).toMatchObject({ world: { bridgeUrl: 'ws://localhost:9094/' } });
    expect(parseCustomBridge('ws://evil.example.org')).toHaveProperty('error');
    expect(parseCustomBridge('https://x.org')).toHaveProperty('error');
    expect(parseCustomBridge('::::')).toHaveProperty('error');
  });
});

describe('remember last world + account (never the password)', () => {
  class MemStorage {
    data = new Map<string, string>();
    getItem(k: string) { return this.data.get(k) ?? null; }
    setItem(k: string, v: string) { this.data.set(k, v); }
  }

  it('round-trips world key + account and drops anything else', () => {
    const s = new MemStorage();
    expect(loadRememberedLogin(s)).toEqual({ worldKey: null, account: null, era: null });
    saveRememberedLogin({ worldKey: 'c0ldeve', account: 'Aerfalle', password: 'hunter2' } as never, s);
    expect(loadRememberedLogin(s)).toEqual({ worldKey: 'c0ldeve', account: 'Aerfalle', era: null });
    expect(s.data.get(LAUNCHER_STORAGE_KEY)).not.toContain('hunter2');
  });

  it('survives missing, corrupt and throwing storage', () => {
    expect(loadRememberedLogin(null)).toEqual({ worldKey: null, account: null, era: null });
    const corrupt = new MemStorage();
    corrupt.setItem(LAUNCHER_STORAGE_KEY, '{nope');
    expect(loadRememberedLogin(corrupt)).toEqual({ worldKey: null, account: null, era: null });
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadRememberedLogin(throwing)).toEqual({ worldKey: null, account: null, era: null });
    expect(() => saveRememberedLogin({ worldKey: 'x', account: 'y' }, throwing)).not.toThrow();
  });

  it('world keys: id / local / custom:<url>', () => {
    expect(worldKeyOf(listed())).toBe('c0ldeve');
    expect(worldKeyOf(localWorld())).toBe('local');
    const c = parseCustomBridge('wss://a.example/b');
    expect('world' in c && worldKeyOf(c.world)).toBe('custom:wss://a.example/b');
  });
});

describe('URL credential gating', () => {
  const Q = '?ace&bridge=ws://localhost:9094&account=probe1&password=pw1&autoenter=false&server=abc';

  it('dev builds keep the tooling auto-login (?account=&password=, ?server=)', () => {
    expect(resolveUrlLogin(Q, true)).toEqual({ autoLogin: { account: 'probe1', password: 'pw1' }, prefillAccount: 'probe1', server: 'abc' });
    // Dev without ?password= keeps the old tooling default; dev without ?account= shows the launcher.
    expect(resolveUrlLogin('?account=probe1', true).autoLogin).toEqual({ account: 'probe1', password: 'testacjs' });
    expect(resolveUrlLogin('?ace', true)).toEqual({ autoLogin: null, prefillAccount: null, server: null });
  });

  it('production ignores ?password= (account only pre-fills) and never defaults to testacjs', () => {
    expect(resolveUrlLogin(Q, false)).toEqual({ autoLogin: null, prefillAccount: 'probe1', server: null });
    expect(resolveUrlLogin('?ace', false)).toEqual({ autoLogin: null, prefillAccount: null, server: null });
  });

  it('production with ?debug still ignores ?password= (any link can carry ?debug)', () => {
    expect(resolveUrlLogin(`${Q}&debug`, false)).toEqual({ autoLogin: null, prefillAccount: 'probe1', server: null });
    expect(resolveUrlLogin('?debug&account=probe1', false).autoLogin).toBeNull();
  });
});

describe('debug globals gate', () => {
  afterEach(() => setDebugGlobalsEnabledForTest(null));

  it('exposes window.__* hooks only when enabled', () => {
    const target: Record<string, unknown> = {};
    setDebugGlobalsEnabledForTest(false);
    expect(exposeDebugGlobal('__playerState', { hp: 5 }, target)).toBe(false);
    expect(target).toEqual({});
    expect(readDebugGlobal('__playerState', target)).toBeUndefined();
    const bag = debugBag(target);
    bag.lastPressSounds = [1];
    expect(target.__ac).toBeUndefined(); // detached when off

    setDebugGlobalsEnabledForTest(true);
    expect(exposeDebugGlobal('__playerState', { hp: 5 }, target)).toBe(true);
    expect(readDebugGlobal('__playerState', target)).toEqual({ hp: 5 });
    debugBag(target).layoutRenderer = 'lr';
    debugBag(target).lastSoulEmoteSent = 'wave';
    expect(target.__ac).toEqual({ layoutRenderer: 'lr', lastSoulEmoteSent: 'wave' });
  });
});

describe('wrapLines', () => {
  const measure = (t: string) => t.length * 5;
  it('wraps greedily and ellipsizes the last kept line', () => {
    expect(wrapLines('one two three', 100, 2, measure)).toEqual(['one two three']);
    expect(wrapLines('aaaa bbbb cccc dddd eeee', 45, 2, measure)).toEqual(['aaaa bbbb', 'cccc…']);
    expect(wrapLines('', 50, 2, measure)).toEqual([]);
  });
});

// ─── LauncherScreen in happy-dom with a fake kit ───────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'] as const;

describe('LauncherScreen (behavioral, fake kit)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    mod = await import('../packages/renderer/src/launcher/LauncherScreen');
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  function makeKit() {
    const messages: string[] = [];
    const entries: Array<(t: string) => void> = [];
    const mount = domWindow.document.createElement('div');
    domWindow.document.body.replaceChildren(mount);
    const kit = {
      prepareScreen: () => { mount.replaceChildren(); return mount; },
      renderLayout: () => null,
      desc: () => null,
      texUrl: () => null,
      text: (text: string) => { const s = domWindow.document.createElement('span'); s.textContent = text; return s; },
      measure: (_r: string, t: string) => t.length * 5,
      textColor: () => null,
      lineHeight: () => 12,
      bindEditField: () => null,
      onlineColor: 'green',
      attachScale: () => {},
      plate: () => domWindow.document.createElement('div'),
      message: (t: string) => { messages.push(t); },
      textEntry: (_p: string, done: (t: string) => void) => { entries.push(done); },
      confirmExit: () => {},
      openCredits: () => {},
      justifyLabel: () => {},
      tagElement: () => {},
    };
    return { kit, mount, messages, entries };
  }

  class MemStorage {
    data = new Map<string, string>();
    getItem(k: string) { return this.data.get(k) ?? null; }
    setItem(k: string, v: string) { this.data.set(k, v); }
  }

  const worlds = (): World[] => [
    listed(),
    listed({ id: 'seed', name: 'Seedsow', compat: 'incompatible', compatNote: 'Classic data: coming later', population: 35 }),
    listed({ id: 'funky', name: 'Funky', online: false, population: null }),
  ];

  async function open(storage = new MemStorage(), prefill: string | null = null) {
    const k = makeKit();
    const screen = new mod.LauncherScreen(k.kit, {
      bridgeUrl: BRIDGE, prefillAccount: prefill, storage,
      loadDirectory: async () => ({ mode: 'multi', worlds: worlds() }),
    });
    const done: Promise<unknown> = screen.run();
    await screen.loaded;
    const rows = () => [...k.mount.querySelectorAll('.launcher-world-row')] as HTMLElement[];
    const row = (name: string) => rows().find(r => r.textContent?.includes(name))!;
    const dbl = (el: HTMLElement) => el.dispatchEvent(new domWindow.MouseEvent('dblclick', { bubbles: true }));
    const account = k.mount.querySelector('.launcher-account') as HTMLInputElement;
    const password = k.mount.querySelector('.launcher-password') as HTMLInputElement;
    return { ...k, screen, done, rows, row, dbl, account, password, storage };
  }

  it('lists the worlds with the header count, selects the first enterable one, and fits above ENTER', async () => {
    const s = await open();
    expect(s.rows().map(r => r.dataset.world)).toEqual(['c0ldeve', 'seed', 'funky']);
    expect(s.mount.querySelector('.launcher-list-header')?.textContent).toBe('Public worlds · 3');
    expect(s.screen.selectedWorld.name).toBe('Coldeve');
    expect(s.row('Seedsow').dataset.blocked).toBe('true');
    expect(s.mount.querySelector('.launcher-world-name')?.textContent).toBe('Coldeve');
    expect(s.mount.querySelector('.launcher-hint')?.textContent).toMatch(/^New here\?/);
    const g = LAUNCHER_GEOMETRY;
    expect(g.details.y + g.details.h).toBeLessThan(g.enterRimTop - 4); // a visible gap above the ENTER rim
    expect(g.details.y).toBeGreaterThan(140); // below the logo
    // Password managers: autocomplete attributes on the real inputs.
    expect(s.account.getAttribute('autocomplete')).toBe('username');
    expect(s.password.getAttribute('autocomplete')).toBe('current-password');
    expect(s.password.type).toBe('password');
  });

  it('the world list stacks above the buttons whose boxes it overlaps (the last row selects, it never opens Custom…)', async () => {
    const s = await open();
    const list = s.mount.querySelector('.launcher-world-list') as HTMLElement;
    const host = list.parentElement as HTMLElement;
    const px = (v: string) => parseFloat(v) || 0;
    // The list's box in launcher space: its host's offset + the listbox's own.
    const top = px(host.style.top) + px(list.style.top);
    const bottom = top + px(list.style.height);
    const left = px(host.style.left) + px(list.style.left);
    const right = left + px(list.style.width);
    const buttons = [...s.mount.querySelectorAll('button')].filter((b) => b.style.position === 'absolute');
    const overlapping = buttons.filter((b) => {
      const bt = px(b.style.top), bl = px(b.style.left);
      return bt < bottom && bt + px(b.style.height) > top && bl < right && bl + px(b.style.width) > left;
    });
    expect(overlapping.map((b) => b.classList.contains('launcher-custom'))).toContain(true);
    for (const b of overlapping) expect(px(host.style.zIndex)).toBeGreaterThan(px(b.style.zIndex));
  });

  it('arrow keys step the selection through the worlds (not scroll the list), and focus follows the row', async () => {
    const s = await open();
    const list = s.mount.querySelector('.launcher-world-list') as HTMLElement;
    const key = (k: string) => {
      const target = (domWindow.document.activeElement && list.contains(domWindow.document.activeElement))
        ? domWindow.document.activeElement as HTMLElement : list;
      const ev = new domWindow.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      return ev.defaultPrevented as boolean;
    };
    s.row('Coldeve').focus();
    expect(key('ArrowDown')).toBe(true);
    expect(s.screen.selectedWorld.name).toBe('Seedsow');
    // The rebuilt row for the new selection holds focus, so the next key lands too.
    expect(domWindow.document.activeElement).toBe(s.row('Seedsow'));
    key('ArrowDown');
    expect(s.screen.selectedWorld.name).toBe('Funky');
    key('ArrowDown'); // clamps at the end
    expect(s.screen.selectedWorld.name).toBe('Funky');
    key('Home');
    expect(s.screen.selectedWorld.name).toBe('Coldeve');
    key('ArrowUp'); // clamps at the start
    expect(s.screen.selectedWorld.name).toBe('Coldeve');
    key('End');
    expect(s.screen.selectedWorld.name).toBe('Funky');
    expect(s.mount.querySelector('.launcher-world-name')?.textContent).toBe('Funky');
    // Other keys are left alone (Tab still moves focus).
    expect(key('Tab')).toBe(false);
    // A click on a row keeps focus in the list, so arrows work right after.
    s.row('Coldeve').focus();
    s.row('Coldeve').dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(s.screen.selectedWorld.name).toBe('Coldeve');
    key('ArrowDown');
    expect(s.screen.selectedWorld.name).toBe('Seedsow');
    // Arrows in the account field still move its caret.
    s.account.focus();
    const ev = new domWindow.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    s.account.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(s.screen.selectedWorld.name).toBe('Seedsow');
  });

  it('AGPL §13: the launcher shows a Source code link only when sourceUrl is configured', async () => {
    const k = makeKit();
    const screen = new mod.LauncherScreen(k.kit, {
      bridgeUrl: BRIDGE, storage: new MemStorage(), sourceUrl: 'https://github.com/example/acjs',
      loadDirectory: async () => ({ mode: 'multi', worlds: worlds() }),
    });
    void screen.run();
    const a = k.mount.querySelector('a.launcher-source') as HTMLAnchorElement;
    expect(a.href).toBe('https://github.com/example/acjs');
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
    const none = await open();
    expect(none.mount.querySelector('a.launcher-source')).toBeNull();
  });

  it('first visit (streamed DATs): the online bullets paint once their texture streams in', async () => {
    const k = makeKit();
    let resident = false;
    const listeners = new Set<() => void>();
    const kit = {
      ...k.kit,
      texUrl: (id: number) => (resident ? `data:tex/${id.toString(16)}` : null),
      onFilesArrived: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    };
    const screen = new mod.LauncherScreen(kit, {
      bridgeUrl: BRIDGE, storage: new MemStorage(),
      loadDirectory: async () => ({ mode: 'multi', worlds: worlds() }),
    });
    void screen.run();
    await screen.loaded;
    const dots = () => [...k.mount.querySelectorAll('.launcher-dot')] as HTMLElement[];
    expect(dots().filter((d) => d.dataset.online === 'true').every((d) => d.style.backgroundImage === '')).toBe(true);
    // The files land: the list redraws with the bullets (0x06004d17 online, 0x06004d19 offline).
    resident = true;
    for (const cb of listeners) cb();
    const painted = dots().filter((d) => d.dataset.online !== undefined);
    expect(painted.length).toBeGreaterThan(0);
    for (const d of painted) {
      expect(d.style.backgroundImage).toContain(d.dataset.online === 'true' ? '6004d17' : '6004d19');
    }
    // Nothing missed since: a later arrival leaves the list alone.
    const before = k.mount.querySelector('.launcher-world-row');
    for (const cb of listeners) cb();
    expect(k.mount.querySelector('.launcher-world-row')).toBe(before);
  });

  it('the launcher stops listening for file arrivals once a world is entered', async () => {
    const k = makeKit();
    const listeners = new Set<() => void>();
    const kit = { ...k.kit, onFilesArrived: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; } };
    const screen = new mod.LauncherScreen(kit, {
      bridgeUrl: BRIDGE, storage: new MemStorage(), prefillAccount: 'someone',
      loadDirectory: async () => ({ mode: 'multi', worlds: worlds() }),
    });
    const done = screen.run();
    await screen.loaded;
    expect(listeners.size).toBe(1);
    (k.mount.querySelector('.launcher-password') as HTMLInputElement).value = 'pw';
    const row = ([...k.mount.querySelectorAll('.launcher-world-row')] as HTMLElement[]).find((r) => r.textContent?.includes('Coldeve'))!;
    row.dispatchEvent(new domWindow.MouseEvent('dblclick', { bubbles: true }));
    await done;
    expect(listeners.size).toBe(0);
  });

  it('RELEASE.launcher-enter-before-ready — ENTER while the list loads waits, says so, then enters', async () => {
    const k = makeKit();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const screen = new mod.LauncherScreen(k.kit, {
      bridgeUrl: BRIDGE, prefillAccount: 'probe', storage: new MemStorage(),
      loadDirectory: async () => { await gate; return { mode: 'multi', worlds: worlds() }; },
    });
    let choice: any = null;
    void screen.run().then((c: unknown) => { choice = c; });
    (k.mount.querySelector('.launcher-password') as HTMLInputElement).value = 'pw';
    (k.mount.querySelector('.launcher-enter') as HTMLElement).click();
    expect(k.messages).toEqual([]); // not 'Pick a world first.'
    expect(k.mount.querySelector('.launcher-desc')?.textContent).toMatch(/^Loading worlds… You will enter/);
    release();
    await screen.loaded;
    await Promise.resolve();
    expect(choice?.world.name).toBe('Coldeve');
    expect(choice?.account).toBe('probe');
  });

  it('a register-first world shows its registration line and a Register link to the page, in a new tab', async () => {
    const k = makeKit();
    const reef = listed({
      id: 'reef', name: 'Reefcull', emu: 'GDL', discord: 'https://discord.gg/3ngsm6e',
      registration: 'Register on the Reefcull website first (lower-case names only).',
      registrationUrl: 'http://reefcull.gdleac.com/',
    });
    const cold = listed();
    const screen = new mod.LauncherScreen(k.kit, {
      bridgeUrl: BRIDGE, storage: new MemStorage(), loadDirectory: async () => ({ mode: 'multi', worlds: [reef, cold] }),
    });
    void screen.run();
    await screen.loaded;
    expect(screen.selectedWorld.name).toBe('Reefcull');
    const reg = k.mount.querySelector('a.launcher-register') as HTMLAnchorElement;
    expect(reg).not.toBeNull();
    expect(reg.getAttribute('href')).toBe('http://reefcull.gdleac.com/');
    expect(reg.target).toBe('_blank');
    expect(reg.rel).toBe('noopener noreferrer');
    const lines = [...reg.children].map((el) => el.textContent);
    expect(lines.length).toBeLessThanOrEqual(2); // fits the details box; joined below, so never cut short
    expect(lines.join(' ')).toBe('Register on the Reefcull website first (lower-case names only).');
    const links = [...k.mount.querySelectorAll('.launcher-links a')] as HTMLAnchorElement[];
    expect(links.map((a) => [a.textContent, a.getAttribute('href'), a.target, a.rel])).toEqual([
      ['Register', 'http://reefcull.gdleac.com/', '_blank', 'noopener noreferrer'],
      ['Discord', 'https://discord.gg/3ngsm6e', '_blank', 'noopener noreferrer'],
    ]);
    // The first-login line does not show for it; a world without registration keeps it.
    expect(k.mount.querySelector('.launcher-details-body')?.textContent).not.toMatch(/Most worlds create your account/);
    screen.select(cold);
    expect(k.mount.querySelector('a.launcher-register')).toBeNull();
    expect(k.mount.querySelector('.launcher-hint')?.textContent).toMatch(/^New here\? Most worlds/);
  });

  it('ENTER on AC1999 with credentials over the 1999 field explains instead of connecting, then enters once shortened', async () => {
    const k = makeKit();
    const screen = new mod.LauncherScreen(k.kit, {
      bridgeUrl: BRIDGE, prefillAccount: 'longaccountname', storage: new MemStorage(),
      loadDirectory: async () => ({ mode: 'multi', worlds: [listed({ id: 'ac1999', name: 'AC1999', era: 'ac1999-retail' })] }),
    });
    let choice: any = null;
    void screen.run().then((c: unknown) => { choice = c; });
    await screen.loaded;
    const password = k.mount.querySelector('.launcher-password') as HTMLInputElement;
    password.value = 'longpassword';
    (k.mount.querySelector('.launcher-enter') as HTMLElement).click();
    await Promise.resolve();
    expect(k.messages).toEqual([
      'AC1999 uses the 1999 login, which fits an account name and password of 18 characters together. Yours are 27. Use a shorter account name or password.',
    ]);
    expect(choice).toBeNull();
    (k.mount.querySelector('.launcher-account') as HTMLInputElement).value = 'short';
    password.value = 'pw1234';
    (k.mount.querySelector('.launcher-enter') as HTMLElement).click();
    await Promise.resolve();
    expect(choice?.world.name).toBe('AC1999');
    expect(choice?.account).toBe('short');
  });

  it('ENTER before the list loads still asks for a missing password first', async () => {
    const k = makeKit();
    const screen = new mod.LauncherScreen(k.kit, {
      bridgeUrl: BRIDGE, prefillAccount: 'probe', storage: new MemStorage(),
      loadDirectory: () => new Promise(() => {}),
    });
    void screen.run();
    (k.mount.querySelector('.launcher-enter') as HTMLElement).click();
    expect(k.messages).toEqual(['Enter a password.']);
  });

  it('double-clicking an incompatible or offline world explains instead of connecting', async () => {
    const s = await open();
    s.account.value = 'probe';
    s.dbl(s.row('Seedsow'));
    expect(s.screen.selectedWorld.name).toBe('Seedsow');
    expect(s.messages[0]).toMatch(/classic Asheron's Call data/);
    s.dbl(s.row('Funky'));
    expect(s.messages[1]).toMatch(/offline/);
    (s.mount.querySelector('.launcher-enter') as HTMLElement).click();
    expect(s.messages).toHaveLength(3);
    let settled = false;
    void s.done.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('double-clicking a good world connects with ?server=<id> and remembers world + account only', async () => {
    const s = await open();
    s.account.value = ' Aerfalle ';
    s.password.value = 'hunter2';
    s.dbl(s.row('Coldeve'));
    await expect(s.done).resolves.toMatchObject({
      account: 'Aerfalle', password: 'hunter2', connectUrl: 'wss://bridge.example.org/connect?server=c0ldeve',
      world: { name: 'Coldeve' },
    });
    expect(loadRememberedLogin(s.storage)).toEqual({ worldKey: 'c0ldeve', account: 'Aerfalle', era: null });
    expect([...s.storage.data.values()].join()).not.toContain('hunter2');
  });

  it('Enter in a field submits the login form (RECON.login-credential-form: the only credential entry)', async () => {
    const s = await open(new MemStorage(), 'Prefilled');
    expect(s.account.value).toBe('Prefilled');
    // The credential fields sit in the DAT edit-field frame, not a bare web form.
    expect(s.account.closest('form')?.className).toBe('launcher-login');
    s.password.value = 'pw';
    const form = s.mount.querySelector('form.launcher-login') as HTMLFormElement;
    form.dispatchEvent(new domWindow.Event('submit', { bubbles: true, cancelable: true }));
    await expect(s.done).resolves.toMatchObject({ account: 'Prefilled', password: 'pw', world: { name: 'Coldeve' } });
  });

  it('ENTER needs an account name; a remembered world and account are restored', async () => {
    const storage = new MemStorage();
    saveRememberedLogin({ worldKey: 'funky', account: 'Bael' }, storage);
    const s = await open(storage);
    expect(s.screen.selectedWorld.name).toBe('Funky');
    expect(s.account.value).toBe('Bael');
    s.account.value = '';
    s.screen.select(s.screen.listedWorlds[0]);
    (s.mount.querySelector('.launcher-enter') as HTMLElement).click();
    expect(s.messages).toEqual(['Enter an account name.']);
  });

  it('ENTER needs a password (an empty one hung on the connect dialog: ACE refuses it)', async () => {
    const s = await open();
    s.account.value = 'Aerfalle';
    s.password.value = '';
    s.screen.select(s.screen.listedWorlds[0]);
    (s.mount.querySelector('.launcher-enter') as HTMLElement).click();
    s.dbl(s.row('Coldeve'));
    expect(s.messages).toEqual(['Enter a password.', 'Enter a password.']);
    let settled = false;
    void s.done.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('Custom… adds and selects a custom bridge world; ENTER connects to that bridge', async () => {
    const s = await open();
    (s.mount.querySelector('.launcher-custom') as HTMLElement).click();
    s.entries[0]('ws://evil.example.org');
    expect(s.messages[0]).toMatch(/wss:\/\//);
    (s.mount.querySelector('.launcher-custom') as HTMLElement).click();
    s.entries[1]('wss://play.example.net/bridge');
    expect(s.rows()[0].dataset.world).toBe('custom:wss://play.example.net/bridge');
    s.account.value = 'me';
    s.password.value = 'pw';
    (s.mount.querySelector('.launcher-enter') as HTMLElement).click();
    await expect(s.done).resolves.toMatchObject({ connectUrl: 'wss://play.example.net/bridge' });
  });

  it('a failed directory load shows the error and leaves Custom… usable', async () => {
    const k = makeKit();
    const screen = new mod.LauncherScreen(k.kit, {
      bridgeUrl: BRIDGE, storage: new MemStorage(), loadDirectory: async () => { throw new Error('HTTP 502'); },
    });
    void screen.run();
    await screen.loaded;
    expect(k.mount.querySelector('.launcher-details-body')?.textContent).toMatch(/world list is unavailable \(HTTP 502\).*use CUSTOM\.$/);
    expect(k.mount.querySelector('.launcher-custom')).toBeTruthy();
  });

  it('the Custom… plate is upper-cased like the DAT\'s DELETE / CREDITS / EXIT labels', async () => {
    const k = makeKit();
    const screen = new mod.LauncherScreen(k.kit, { bridgeUrl: BRIDGE, storage: new MemStorage(), loadDirectory: async () => [] });
    void screen.run();
    await screen.loaded;
    expect(k.mount.querySelector('.launcher-custom')?.textContent).toBe('CUSTOM…');
  });

  it('RECON.dom-chrome-sweep.d: the account field draws in the DialogFactory edit font (DatEditField); the password keeps its masked input', async () => {
    const { attachDatEditField } = await import('../packages/renderer/src/ui/DatEditField');
    const { LAUNCHER_TEXT } = mod;
    const doc = domWindow.document;
    const painted: string[] = [];
    // A 6-px-advance stand-in for the DAT font: what it is asked to rasterise is what shows.
    const font = {
      lineHeight: 12, outlinePadding: { x: 0, y: 0 },
      measureText: (t: string) => t.length * 6,
      renderTextToCanvas: (t: string) => { painted.push(t); return doc.createElement('canvas'); },
    };
    const k = makeKit();
    const bound: Array<{ input: HTMLInputElement; host: HTMLElement; ref: string; hJustify?: number; masked?: boolean }> = [];
    (k.kit as Record<string, unknown>).bindEditField = (input: HTMLInputElement, host: HTMLElement, ref: string, hJustify?: number, masked?: boolean) => {
      bound.push({ input, host, ref, hJustify, masked });
      return attachDatEditField(input, host, { font, color: 'rgb(255, 242, 204)', hJustify, masked });
    };
    const screen = new mod.LauncherScreen(k.kit, {
      bridgeUrl: BRIDGE, prefillAccount: 'olthoi', storage: new MemStorage(),
      loadDirectory: async () => ({ mode: 'multi', worlds: worlds() }),
    });
    const done: Promise<unknown> = screen.run();
    await screen.loaded;
    const account = k.mount.querySelector('.launcher-account') as HTMLInputElement;
    const password = k.mount.querySelector('.launcher-password') as HTMLInputElement;
    expect(bound).toHaveLength(2);
    expect(bound[0].input).toBe(account);
    expect(bound[0].masked).toBeFalsy();
    expect(bound[0].ref).toBe(LAUNCHER_TEXT.edit);
    // Left-justified over the text-entry desc's centring: the text starts at the field's left edge.
    expect(bound[0].hJustify).toBe(0);
    // The host is the edit box inside the 24-px frame art, the input filling it.
    expect(bound[0].host.className).toBe('launcher-edit');
    expect(bound[0].host.style.height).toBe('16px');
    // The DAT layer paints the prefilled account; the browser's glyphs and caret go.
    expect(account.style.color).toBe('transparent');
    expect(account.style.caretColor).toBe('transparent');
    expect(painted).toContain('olthoi');
    expect(bound[0].host.querySelector('.ac-dat-edit-layer canvas')).not.toBeNull();
    account.value = 'olthoi2';
    expect(painted.at(-1)).toBe('olthoi2');
    // RECON.dom-chrome-sweep.d.a — the password binds the same edit desc,
    // left-justified and masked: the DAT layer paints one dot per character
    // and never the value. The <input> stays type=password (password
    // managers), its own bullets transparent.
    expect(bound[1]).toMatchObject({ input: password, ref: LAUNCHER_TEXT.edit, hJustify: 0, masked: true });
    expect(password.type).toBe('password');
    expect(password.style.color).toBe('transparent');
    expect(password.style.textAlign).toBe('left');
    expect(painted.some(t => t.includes('hunter2'))).toBe(false);
    password.value = 'hunter2';
    expect(painted.at(-1)).toBe('\u25CF'.repeat(7));
    expect(painted.some(t => t.includes('hunter2'))).toBe(false);
    // ENTER tears the painted layer down with the screen.
    screen.attemptEnter();
    await expect(done).resolves.toMatchObject({ account: 'olthoi2', password: 'hunter2' });
    expect(bound[0].host.querySelector('.ac-dat-edit-layer')).toBeNull();
    expect(bound[1].host.querySelector('.ac-dat-edit-layer')).toBeNull();
    expect(account.dataset.acDatEdit).toBe('1');
  });
});

describe('ERA.dm-support: worlds carry their era (docs/dark-majesty-support.md)', () => {
  it('a /servers row and a pinned bridge /healthz name the era; end of retail is null', async () => {
    expect(worldFromEntry({ id: 'seed', name: 'Seedsow', era: 'classic-dereth' })?.era).toBe('classic-dereth');
    expect(worldFromEntry({ id: 'c0ldeve', name: 'Coldeve' })?.era).toBeNull();
    expect(eraIdFrom('eor')).toBeNull();
    expect(eraIdFrom('Bad Era!')).toBeNull();
    expect(eraIdFrom(7)).toBeNull();
    const pinned = await loadWorldDirectory('ws://localhost:9190', fakeFetch({
      'http://localhost:9190/healthz': { up: true, mode: 'pinned', era: 'classicace-customdm' },
    }));
    expect(pinned.worlds[0]).toMatchObject({ kind: 'local', era: 'classicace-customdm' });
    const plain = await loadWorldDirectory('ws://localhost:9090', fakeFetch({ 'http://localhost:9090/healthz': { mode: 'pinned' } }));
    expect(plain.worlds[0].era).toBeNull();
  });

  it('a custom bridge reports its era over its WebSocket health answer (CSP allows wss:), else /healthz', async () => {
    const noWs = async () => { throw new Error('no socket'); };
    const urls: string[] = [];
    expect(await probeBridgeEra('wss://play.example.net/bridge', fakeFetch({}), async (u) => { urls.push(u); return { bridge: 'ok', era: 'classicace-customdm' }; })).toBe('classicace-customdm');
    expect(urls).toEqual(['wss://play.example.net/bridge']);
    expect(await probeBridgeEra('wss://play.example.net/bridge', fakeFetch({}), async () => ({ bridge: 'ok' }))).toBeNull();
    expect(await probeBridgeEra('wss://play.example.net/bridge', fakeFetch({ 'https://play.example.net/healthz': { era: 'classic-dereth' } }), noWs)).toBe('classic-dereth');
    expect(await probeBridgeEra('wss://play.example.net/bridge', fakeFetch({ 'https://play.example.net/healthz': 500 }), noWs)).toBeNull();
    expect(await probeBridgeEra('wss://play.example.net/bridge', fakeFetch({ 'https://play.example.net/healthz': new Error('x') }), noWs)).toBeNull();
  });

  it('ENTER refuses a world whose era this client does not know; known classic eras pass', () => {
    expect(worldEnterBlock(listed({ name: 'Old', era: 'some-future-era' }))).toMatch(/Old needs a kind of game data \(some-future-era\)/);
    expect(worldEnterBlock(listed({ name: 'Seedsow', compat: 'beta', era: 'classic-dereth' }))).toBeNull();
    expect(worldEnterBlock(listed({ name: 'Dekarutide', compat: 'beta', era: 'classicace-customdm' }))).toBeNull();
  });

  it('remembering a classic world remembers its era (the next visit boots straight into it)', () => {
    const data = new Map<string, string>();
    const st = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
    saveRememberedLogin({ worldKey: 'seed', account: 'Bael', era: 'classic-dereth' }, st);
    expect(loadRememberedLogin(st)).toEqual({ worldKey: 'seed', account: 'Bael', era: 'classic-dereth' });
  });
});

describe('ERA.dm-support: LauncherScreen era handling (fake kit)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    mod = await import('../packages/renderer/src/launcher/LauncherScreen');
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  function kit(entries: Array<(t: string) => void>) {
    const mount = domWindow.document.createElement('div');
    domWindow.document.body.replaceChildren(mount);
    return {
      mount,
      kit: {
        prepareScreen: () => { mount.replaceChildren(); return mount; }, renderLayout: () => null, desc: () => null, texUrl: () => null,
        text: (t: string) => { const e = domWindow.document.createElement('span'); e.textContent = t; return e; },
        measure: (_r: string, t: string) => t.length * 5, textColor: () => null, lineHeight: () => 12, bindEditField: () => null, onlineColor: 'green',
        attachScale: () => {}, plate: () => domWindow.document.createElement('div'), message: () => {},
        textEntry: (_p: string, done: (t: string) => void) => { entries.push(done); },
        confirmExit: () => {}, openCredits: () => {}, justifyLabel: () => {}, tagElement: () => {},
      },
    };
  }

  it('ENTER on a classic world resolves with its era and stores it', async () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
    const k = kit([]);
    const screen = new mod.LauncherScreen(k.kit, {
      bridgeUrl: BRIDGE, storage,
      loadDirectory: async () => ({ mode: 'multi', worlds: [listed({ id: 'seed', name: 'Seedsow', compat: 'beta', era: 'classic-dereth' })] }),
    });
    const done = screen.run();
    await screen.loaded;
    (k.mount.querySelector('.launcher-account') as HTMLInputElement).value = 'bael';
    (k.mount.querySelector('.launcher-password') as HTMLInputElement).value = 'pw';
    screen.attemptEnter();
    await expect(done).resolves.toMatchObject({ world: { name: 'Seedsow', era: 'classic-dereth' }, connectUrl: `${BRIDGE}?server=seed` });
    expect(loadRememberedLogin(storage)).toEqual({ worldKey: 'seed', account: 'bael', era: 'classic-dereth' });
  });

  it('a custom bridge\'s era is probed, and ENTER waits for the answer', async () => {
    const entries: Array<(t: string) => void> = [];
    const k = kit(entries);
    let answer!: (era: string | null) => void;
    const screen = new mod.LauncherScreen(k.kit, {
      bridgeUrl: BRIDGE, storage: null,
      loadDirectory: async () => ({ mode: 'multi', worlds: [] }),
      probeEra: () => new Promise<string | null>((r) => { answer = r; }),
    });
    const done = screen.run();
    await screen.loaded;
    (k.mount.querySelector('.launcher-custom') as HTMLElement).click();
    entries[0]('wss://classic.example.net/bridge');
    (k.mount.querySelector('.launcher-account') as HTMLInputElement).value = 'bael';
    (k.mount.querySelector('.launcher-password') as HTMLInputElement).value = 'pw';
    screen.attemptEnter();
    let settled = false;
    void done.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    answer('classicace-customdm');
    await expect(done).resolves.toMatchObject({ world: { kind: 'custom', era: 'classicace-customdm' }, connectUrl: 'wss://classic.example.net/bridge' });
  });
});

describe('ERA.ac1999: a world\'s era is its compat chip, the same mechanism for every era', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    mod = await import('../packages/renderer/src/launcher/LauncherScreen');
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('an AC1999 /servers row becomes a 1999 world; ENTER takes it once its era profile exists', () => {
    const w = worldFromEntry({ id: 'ac1999', name: 'AC1999', emu: 'AC1999', compat: 'beta', compatNote: '1999 launch era', era: 'ac1999-retail' })!;
    expect(w).toMatchObject({ kind: 'listed', era: 'ac1999-retail', compat: 'beta', compatNote: '1999 launch era' });
    expect(worldEnterBlock(w) === null).toBe(ERA_PROFILES['ac1999-retail'] !== undefined);
  });

  it('rows carry no era tag; the details chip reads "Dark Majesty era" / "1999 launch era", and nothing for end of retail', async () => {
    const mount = domWindow.document.createElement('div');
    domWindow.document.body.replaceChildren(mount);
    const kit = {
      prepareScreen: () => { mount.replaceChildren(); return mount; }, renderLayout: () => null, desc: () => null, texUrl: () => null,
      text: (t: string) => { const e = domWindow.document.createElement('span'); e.textContent = t; return e; },
      measure: (_r: string, t: string) => t.length * 5, textColor: () => null, lineHeight: () => 12, bindEditField: () => null, onlineColor: 'green',
      attachScale: () => {}, plate: () => domWindow.document.createElement('div'), message: () => {},
      textEntry: () => {}, confirmExit: () => {}, openCredits: () => {}, justifyLabel: () => {}, tagElement: () => {},
    };
    const worlds: World[] = [
      listed(),
      listed({ id: 'doc', name: 'Doctide', compat: 'beta', compatNote: 'Dark Majesty era', era: 'classicace-infiltration', population: 12 }),
      listed({ id: 'seed', name: 'Seedsow', compat: 'beta', compatNote: 'Dark Majesty era', era: 'classic-dereth', population: 35 }),
      listed({ id: 'dek', name: 'Dekarutide', compat: 'beta', compatNote: 'Dark Majesty era', era: 'classicace-customdm', population: 9 }),
      listed({ id: 'ac1999', name: 'AC1999', emu: 'AC1999', type: null, compat: 'beta', compatNote: '1999 launch era', era: 'ac1999-retail', online: null, population: null }),
    ];
    const screen = new mod.LauncherScreen(kit, { bridgeUrl: BRIDGE, storage: null, loadDirectory: async () => ({ mode: 'multi', worlds }) });
    void screen.run();
    await screen.loaded;
    const rows = () => [...mount.querySelectorAll('.launcher-world-row')] as HTMLElement[];
    // Rows are name + population, exactly as on main: no per-era tag.
    expect(rows().map((r) => [r.dataset.world, r.textContent])).toEqual([
      ['c0ldeve', 'Coldeve691'], ['doc', 'Doctide12'], ['seed', 'Seedsow35'], ['dek', 'Dekarutide9'], ['ac1999', 'AC1999'],
    ]);
    expect(mount.querySelector('.launcher-era-tag, .launcher-era')).toBeNull();
    const chips: Record<string, string[]> = {};
    for (const id of ['c0ldeve', 'doc', 'seed', 'dek', 'ac1999']) {
      rows().find((r) => r.dataset.world === id)!.click();
      chips[id] = [...mount.querySelector('.launcher-meta')!.children].map((c) => c.textContent ?? '');
      expect(mount.querySelector('.launcher-era-tag, .launcher-era')).toBeNull();
    }
    expect(chips).toEqual({
      c0ldeve: ['ACE', 'PvE', '691 online'],
      doc: ['ACE', 'PvE', '12 online', 'Dark Majesty era'],
      seed: ['ACE', 'PvE', '35 online', 'Dark Majesty era'],
      dek: ['ACE', 'PvE', '9 online', 'Dark Majesty era'],
      ac1999: ['AC1999', '1999 launch era'],
    });
  });
});
