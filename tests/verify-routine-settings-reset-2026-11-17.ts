/**
 * BUG.routine-settings-reset (2026-11-17) — a player on several devices: "the settings reset constantly".
 * The window paths (a profile pick forgotten at the next login, two tabs clobbering each other, unreadable
 * storage) are driven end to end in verify-vtank-window.ts; here: the three-way merge itself, the starting
 * profile, the document field, RoutineSync's merge against the bridge's store, the Automation panel's
 * switches, and the routines_store telemetry (renderer and bridge sanitizer).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import {
  EXAMPLE_HUNT_PROFILE, emptyRoutineDoc, mergeRoutineDocs, normalizeRoutineDoc, startingProfile, validateRoutineDoc,
  type RoutineDoc, type RoutineProfile,
} from '../packages/shared/src/routines/index.js';
import { RoutineSync } from '../packages/renderer/src/agent/RoutineSync.js';
import { AutomationReporter, MAX_STORE_EVENTS, type AutomationEvent } from '../packages/renderer/src/telemetry/AutomationReporter.js';
import { sanitizeClientAutomation, ROUTINE_STORE_MODES as BRIDGE_MODES, ROUTINE_STORE_WHATS as BRIDGE_WHATS } from '../services/ws-tcp-bridge/src/clientAutomation.js';
import { ROUTINE_STORE_MODES, ROUTINE_STORE_WHATS } from '../packages/renderer/src/telemetry/AutomationReporter.js';
import type { AutomationSource } from '../packages/renderer/src/ui/automation/AutomationPanel.js';

const prof = (name: string, settings: RoutineProfile['settings'] = {}): RoutineProfile => ({ ...structuredClone(EXAMPLE_HUNT_PROFILE), name, settings });
const doc = (...profiles: RoutineProfile[]): RoutineDoc => ({ ...emptyRoutineDoc('coldeve', 'Jake'), updatedAt: '2026-11-17T10:00:00.000Z', profiles });

describe('mergeRoutineDocs: what one side changed is kept, nothing the other removed comes back', () => {
  it('settings changed on different sides both survive; the same setting changed on both takes this page\'s', () => {
    const base = doc(prof('Hunt', { AttackDistance: 20, EnableCombat: true, EnableNav: true }));
    const mine = structuredClone(base);
    mine.profiles[0].settings = { AttackDistance: 20, EnableCombat: false, EnableNav: false };
    const theirs = structuredClone(base);
    theirs.profiles[0].settings = { AttackDistance: 31, EnableCombat: true, EnableNav: true };
    expect(mergeRoutineDocs(base, mine, theirs).profiles[0].settings).toEqual({ AttackDistance: 31, EnableCombat: false, EnableNav: false });
    theirs.profiles[0].settings!.EnableNav = true;
    theirs.profiles[0].settings!.EnableCombat = 'x' as never;
    expect(mergeRoutineDocs(base, mine, theirs).profiles[0].settings?.EnableCombat).toBe(false);
    // None of the three is changed.
    expect(base.profiles[0].settings).toEqual({ AttackDistance: 20, EnableCombat: true, EnableNav: true });
  });

  it('profiles merge by name: added on either side kept, deleted on one side (unchanged on the other) gone', () => {
    const base = doc(prof('A'), prof('B'), prof('C'));
    const mine = structuredClone(base);
    mine.profiles = mine.profiles.filter((p) => p.name !== 'B');
    mine.profiles.push(prof('Mine-new'));
    const theirs = structuredClone(base);
    theirs.profiles = theirs.profiles.filter((p) => p.name !== 'C');
    theirs.profiles.push(prof('Their-new'));
    expect(mergeRoutineDocs(base, mine, theirs).profiles.map((p) => p.name)).toEqual(['A', 'Mine-new', 'Their-new']);
  });

  it('a setting key removed on one side (Clear profile!) stays removed when the other side left it alone', () => {
    const base = doc(prof('A', { AttackDistance: 20, EnableNav: true }));
    const mine = structuredClone(base);
    mine.profiles[0].settings = {};
    const theirs = structuredClone(base);
    theirs.profiles[0].description = 'renamed elsewhere';
    const m = mergeRoutineDocs(base, mine, theirs);
    expect(m.profiles[0].settings).toEqual({});
    expect(m.profiles[0].description).toBe('renamed elsewhere');
  });

  it('a list that isn\'t keyed by name (a route\'s waypoints, a state\'s rules) is one value: no interleaving', () => {
    const base = doc(prof('A'));
    base.profiles[0].routes = [{ name: 'r', mode: 'once', points: ['1.0N, 1.0E', '2.0N, 2.0E'] }];
    const mine = structuredClone(base);
    mine.profiles[0].routes[0].points = ['1.0N, 1.0E'];
    const theirs = structuredClone(base);
    theirs.profiles[0].routes[0].points = ['1.0N, 1.0E', '2.0N, 2.0E', '3.0N, 3.0E'];
    expect(mergeRoutineDocs(base, mine, theirs).profiles[0].routes[0].points).toEqual(['1.0N, 1.0E']);
  });

  it('a character\'s Mine only / last pick naming a profile the merge removed is dropped, so the store accepts it', () => {
    const base = doc(prof('A'), prof('B'));
    const mine = structuredClone(base);
    mine.characters = { Claude: 'B' };
    mine.selected = { Claude: 'B', Alt: 'A' };
    const theirs = structuredClone(base);
    theirs.profiles = [theirs.profiles[0]];
    const m = mergeRoutineDocs(base, mine, theirs);
    // Mine changed B's mapping, theirs deleted B: B stays deleted only if mine left B itself alone (it did).
    expect(m.profiles.map((p) => p.name)).toEqual(['A']);
    expect(m.characters).toEqual({});
    expect(m.selected).toEqual({ Alt: 'A' });
    expect(validateRoutineDoc(m)).toEqual([]);
  });
});

describe('startingProfile and the document\'s `selected`', () => {
  it('last pick, else Mine only, else the first; only profiles that exist', () => {
    const d = doc(prof('A'), prof('B'), prof('C'));
    expect(startingProfile(d, 'Claude')).toBe('A');
    d.characters = { Claude: 'B' };
    expect(startingProfile(d, 'Claude')).toBe('B');
    d.selected = { Claude: 'C' };
    expect(startingProfile(d, 'Claude')).toBe('C');
    d.selected = { Claude: 'gone' };
    expect(startingProfile(d, 'Claude')).toBe('B');
    expect(startingProfile(d, null)).toBe('A');
    expect(startingProfile(doc(), 'Claude')).toBeNull();
  });

  it('validates as a name map, and a broken one is dropped on load (normalizeRoutineDoc), never failing the load', () => {
    const d = doc(prof('A'));
    d.selected = { Claude: 'A', Gone: 'not a profile' };
    expect(validateRoutineDoc(d)).toEqual([]);
    expect(validateRoutineDoc({ ...d, selected: { Claude: 7 } }).map((i) => i.path)).toEqual(['selected']);
    const broken = { ...d, selected: 'A' } as unknown as RoutineDoc;
    expect(normalizeRoutineDoc(broken)).toBe(1);
    expect(broken.selected).toBeUndefined();
  });
});

describe('RoutineSync.save(doc, base) against the bridge\'s store', () => {
  /** A bridge /routines endpoint over one stored document (as routineStore.put / the ?since check do). */
  function bridge(initial: RoutineDoc) {
    let stored = structuredClone(initial);
    let n = 0;
    const puts: RoutineDoc[] = [];
    const grant = { token: 'a'.repeat(48), server: 'coldeve', account: 'Jake' };
    const sync: RoutineSync = new RoutineSync(
      () => ({ bridgeUrl: 'wss://bridge.example/?server=coldeve', requestRoutinesGrant: () => queueMicrotask(() => sync.onGrant(grant)) }),
      (async (url: string, init: RequestInit) => {
        if (init.method === 'PUT') {
          const d = JSON.parse(String(init.body)) as RoutineDoc;
          puts.push(d);
          stored = { ...d, updatedAt: `2026-11-17T11:00:${String(++n).padStart(2, '0')}.000Z` };
          return new Response(JSON.stringify(stored));
        }
        const since = new URL(url).searchParams.get('since');
        return new Response(JSON.stringify(since !== null && since === stored.updatedAt ? { unchanged: true } : stored));
      }) as unknown as typeof fetch,
    );
    const events: string[] = [];
    sync.onStoreEvent = (e) => events.push(`${e.what}/${e.mode}`);
    return { sync, puts, events, stored: () => stored, setStored: (d: RoutineDoc) => { stored = d; } };
  }

  it('another device\'s change since the base is kept under this save; an unchanged store is just written', async () => {
    const base = doc(prof('Hunt', { AttackDistance: 20, EnableCombat: true }));
    const b = bridge(base);
    // Unchanged since the base: this document as sent.
    const first = structuredClone(base);
    first.profiles[0].settings!.EnableCombat = false;
    const r1 = await b.sync.save(first, base) as { ok: true; doc: RoutineDoc };
    expect(r1.ok).toBe(true);
    expect(b.events).toEqual([]);
    // The desktop saves AttackDistance 31; the phone, still on r1's copy, turns combat back on.
    const desktop = structuredClone(r1.doc);
    desktop.profiles[0].settings!.AttackDistance = 31;
    b.setStored({ ...desktop, updatedAt: '2026-11-17T12:00:00.000Z' });
    const phone = structuredClone(r1.doc);
    phone.profiles[0].settings!.EnableCombat = true;
    const r2 = await b.sync.save(phone, r1.doc) as { ok: true; doc: RoutineDoc };
    expect(r2.doc.profiles[0].settings).toEqual({ AttackDistance: 31, EnableCombat: true });
    expect(b.stored().profiles[0].settings).toEqual({ AttackDistance: 31, EnableCombat: true });
    expect(b.events).toEqual(['merged/bridge']);
  });

  it('without a base (ac_routines set) the document replaces what is stored, as before', async () => {
    const b = bridge(doc(prof('Hunt', { AttackDistance: 31 })));
    const r = await b.sync.save(doc(prof('Other'))) as { ok: true; doc: RoutineDoc };
    expect(r.doc.profiles.map((p) => p.name)).toEqual(['Other']);
  });

  it('a bridge answer that isn\'t a document fails the load (never an empty document to save over it)', async () => {
    const grant = { token: 'a'.repeat(48), server: 'coldeve', account: 'Jake' };
    const sync: RoutineSync = new RoutineSync(
      () => ({ bridgeUrl: 'wss://bridge.example/', requestRoutinesGrant: () => queueMicrotask(() => sync.onGrant(grant)) }),
      (async () => new Response('null')) as unknown as typeof fetch,
    );
    const events: string[] = [];
    sync.onStoreEvent = (e) => events.push(`${e.what}/${e.mode}`);
    expect(await sync.load()).toMatchObject({ ok: false });
    expect(events).toEqual(['unreadable/bridge']);
  });
});

describe('the Automation panel\'s module switches save from their base too', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());

  it('a switch flipped on a stale panel keeps the setting another tab stored', async () => {
    const M = await import('../packages/renderer/src/ui/automation/AutomationPanel.js');
    let stored = doc(prof('Hunt', { AttackDistance: 20 }));
    const bases: Array<RoutineDoc | null | undefined> = [];
    const source = {
      load: async () => ({ ok: true as const, doc: structuredClone(stored) }),
      save: async (d: RoutineDoc, base?: RoutineDoc | null) => {
        bases.push(base);
        const next = base && base.updatedAt !== stored.updatedAt ? mergeRoutineDocs(base, d, stored) : d;
        stored = { ...structuredClone(next), updatedAt: '2026-11-17T13:00:00.000Z' };
        return { ok: true as const, doc: structuredClone(stored) };
      },
      status: () => ({ running: false, paused: false, profile: null, state: null, acting: null, last: [] }),
      character: () => 'Claude',
      current: () => null,
    } as unknown as AutomationSource;
    const kit = {
      text: (t: string) => { const s = document.createElement('span'); s.textContent = t; return s; },
      button: (l: string, f: () => void) => { const d = document.createElement('div'); d.dataset.button = l; d.onclick = f; return d; },
      check: (on: boolean, f: (v: boolean) => void) => { const d = document.createElement('div'); d.dataset.check = on ? '1' : '0'; d.onclick = () => f(!on); return d; },
      tab: (l: string) => { const d = document.createElement('div'); d.textContent = l; return d; },
      field: () => document.createElement('div'), menu: () => {}, input: () => document.createElement('input'),
      row: () => document.createElement('div'), box: () => document.createElement('div'),
      header: (t: string) => { const s = document.createElement('span'); s.textContent = t; return s; },
      dot: () => document.createElement('div'), separator: () => document.createElement('hr'), scroll: () => {},
      plate: () => document.createElement('div'),
      colors: { text: 'w', dim: 'g', gold: 'y', good: 'g', warn: 'y', bad: 'r' },
    };
    const panel = new M.AutomationPanel(kit as never, source, () => {});
    await panel.load(() => {});
    // Another tab stores AttackDistance 31; this panel never heard.
    stored = { ...structuredClone(stored), updatedAt: '2026-11-17T12:30:00.000Z' };
    stored.profiles[0].settings = { AttackDistance: 31 };
    const body = document.createElement('div');
    const redraw = () => panel.render(body, 300, 400, redraw);
    redraw();
    const sw = body.querySelector('[data-module-switch="looting"] [data-check], [data-module-switch="looting"]') as HTMLElement;
    sw.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(bases[0]?.updatedAt).toBe('2026-11-17T10:00:00.000Z');
    expect(stored.profiles[0].settings).toEqual({ AttackDistance: 31 });
    expect(stored.profiles[0].modules.looting).toBe(!EXAMPLE_HUNT_PROFILE.modules.looting);
  });
});

describe('routines_store telemetry (closed tokens only)', () => {
  it('the reporter sends what / mode from closed lists, capped per page; the bridge keeps the same lists', () => {
    const events: AutomationEvent[] = [];
    const r = new AutomationReporter({
      endpoint: 'http://x/client-preworld', build: 'abc1234', trace: 'feedc0de12345678', era: () => 'eor', server: () => 'coldeve',
      now: () => 0, send: (_u, b) => { events.push(JSON.parse(b) as AutomationEvent); },
    });
    r.routinesStore('merged', 'local');
    r.routinesStore('Jake', 'local');
    r.routinesStore('unreadable', 'somewhere');
    for (let i = 0; i < 10; i++) r.routinesStore('unreadable', 'bridge');
    expect(events[0]).toMatchObject({ outcome: 'routines_store', what: 'merged', mode: 'local', server: 'coldeve' });
    expect(events).toHaveLength(MAX_STORE_EVENTS);
    expect(Object.keys(events[0]).sort()).toEqual(['build', 'eid', 'era', 'mode', 'outcome', 'server', 'trace', 'what']);
    expect([...BRIDGE_WHATS]).toEqual([...ROUTINE_STORE_WHATS]);
    expect([...BRIDGE_MODES]).toEqual([...ROUTINE_STORE_MODES]);
    expect(sanitizeClientAutomation({ ...events[0], account: 'Jake' })).toMatchObject({ outcome: 'routines_store', era: 'eor', server: 'coldeve', trace: 'feedc0de12345678', build: 'abc1234', what: 'merged', mode: 'local' });
    expect(sanitizeClientAutomation({ ...events[0], account: 'Jake' })).not.toHaveProperty('account');
    expect(sanitizeClientAutomation({ outcome: 'routines_store', what: 'Jake', mode: 'x' })).toMatchObject({ what: null, mode: null });
  });
});
