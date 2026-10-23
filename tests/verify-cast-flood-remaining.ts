/**
 * BUG.cast-flood-remaining — one cast request per press, whatever pressed it.
 *
 * Prod (2026-10-23, AC1999): two players on builds that already swallow OS key repeats
 * (1e71a1abb705, c6ac07c8ef35) still logged "You're too busy!" (we:0x001d, action 0x4a) ~100 times a
 * minute, "not enough Mana" and pairs of "select a suitable target" 158-250 ms apart. Both
 * players' bursts run at 4-8 casts a second on a Mac and on a Windows PC alike, the same as the
 * Mac player's session before repeats were stopped; an OS key repeat would run at the platform's
 * own rate (Windows' default ~30/s), so these are presses. Neither client gates a press on its
 * busy state: the 1999 UI_CastSpell @ 0x004d1bd0 → PanelUI_FreeHandsAndCastSpell @ 0x004fecc0 and
 * end of retail's ClientMagicSystem::CastSpell @ 00568040 send every one, and the 1999
 * UI_HandleFailureEvent @ 0x004ccd10 prints "You're too busy!" for 0x1d.
 *
 * Pinned here, driving the shipped handlers:
 *  - input/GameKeyDown.ts (main.ts's keydown router): a held digit in 1999 magic mode, a held 1999
 *    attack key in magic mode (it casts, PanelUI_HandleCommand @ 0x4f5700), end of retail's digits
 *    and End: one dispatch for the press, none for its repeats; a second press casts again.
 *  - GameUI's spell bar: a held mouse on a shortcut or on the Cast button is one click; a
 *    shortcut casts on the double-click only (ListenToElementMessage @ 004c7ab0 dwParam1 10), the
 *    Cast button on its click (message 1 → Cast @ 004c6050).
 *  - telemetry: each press says what pressed it and how long after the last one (CastPressTracker),
 *    and a server refusal of the cast carries it (RefusalReporter), so the next roll-up proves it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CombatMode } from '@ac/shared';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { KeybindRegistry } from '../packages/renderer/src/input/KeybindRegistry.js';
import { ACT, activeInputMaps } from '../packages/renderer/src/input/KeybindDefaults.js';
import { keybindDefaultsFor, type EraKeymap } from '../packages/renderer/src/input/EraKeymaps.js';
import { routeGameKeyDown, keyDownConsumed, type GameKeyDownEvent, type GameKeyDownResult } from '../packages/renderer/src/input/GameKeyDown.js';
import { KEY_REPEAT_ACTIONS } from '../packages/renderer/src/input/KeybindActions.generated.js';
import { CastPressTracker, cleanRefusalDetail } from '../packages/renderer/src/telemetry/RefusalTemplates.js';
import { RefusalReporter } from '../packages/renderer/src/telemetry/RefusalReporter.js';
import { SPELLBAR_CAST_BUTTON } from '../packages/renderer/src/ui/HudTooltips.js';
import { sanitizeClientRefusal } from '../services/ws-tcp-bridge/src/clientRefusal.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

const SPELL_SLOT_1 = 0x10000065;
const key = (code: string, repeat = false, mods: Partial<Pick<GameKeyDownEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>> = {}): GameKeyDownEvent =>
  ({ code, repeat, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

/** The router over the era's real registry in `mode`, recording what it dispatched. */
function router(keymap: EraKeymap, mode: CombatMode, opts: { textFocused?: boolean } = {}) {
  const reg = new KeybindRegistry(keybindDefaultsFor(keymap));
  const dispatched: number[] = [];
  const press = (e: GameKeyDownEvent): GameKeyDownResult => routeGameKeyDown(e, {
    textFocused: () => !!opts.textFocused,
    automationHotkey: () => false,
    syncMaps: () => reg.setActiveInputMaps(activeInputMaps(mode)),
    resolve: (code) => reg.resolveOrBare(code),
    dispatch: (id) => { dispatched.push(id); return true; },
  });
  /** A key held down: the press, then `repeats` OS auto-repeats. */
  const hold = (code: string, repeats: number): GameKeyDownResult[] => [press(key(code)), ...Array.from({ length: repeats }, () => press(key(code, true)))];
  return { reg, dispatched, press, hold };
}

describe('the keydown router: a held cast key casts once (1999 and end of retail)', () => {
  it('1999, magic mode: Digit1 held through 30 repeats dispatches Spell Slot 1 once; the repeats are swallowed', () => {
    const r = router('ac1999', CombatMode.Magic);
    const results = r.hold('Digit1', 30);
    expect(r.dispatched).toEqual([SPELL_SLOT_1]);
    expect(results[0]).toBe('dispatched');
    expect(results.slice(1).every((x) => x === 'held')).toBe(true);
    // The browser default is prevented for the repeats too (no Firefox quick-find, no page scroll).
    expect(results.every(keyDownConsumed)).toBe(true);
  });

  it('1999, magic mode: every digit 1-9 casts its slot once per press', () => {
    const r = router('ac1999', CombatMode.Magic);
    for (let i = 1; i <= 9; i++) r.hold(`Digit${i}`, 5);
    expect(r.dispatched).toEqual(Array.from({ length: 9 }, (_, i) => SPELL_SLOT_1 + i));
  });

  it('1999, magic mode: the attack keys (PageDown / End / Delete) cast, once per press however long held', () => {
    const r = router('ac1999', CombatMode.Magic);
    for (const code of ['PageDown', 'End', 'Delete']) r.hold(code, 20);
    expect(r.dispatched).toEqual([ACT.CastSpell, ACT.CastSpell, ACT.CastSpell]);
  });

  it('a tapped key casts every tap: three presses with repeats between them are three casts', () => {
    const r = router('ac1999', CombatMode.Magic);
    r.hold('Digit2', 4); r.hold('Digit2', 0); r.hold('Digit2', 9);
    expect(r.dispatched).toEqual([SPELL_SLOT_1 + 1, SPELL_SLOT_1 + 1, SPELL_SLOT_1 + 1]);
  });

  it('end of retail, magic mode: Digit1 and End (Cast Spell) held cast once each', () => {
    const r = router('eor', CombatMode.Magic);
    r.hold('Digit1', 25);
    r.hold('End', 25);
    expect(r.dispatched).toEqual([SPELL_SLOT_1, ACT.CastSpell]);
  });

  it('Shift+digit (running) answers as the bare digit, and its repeats are swallowed too', () => {
    const r = router('ac1999', CombatMode.Magic);
    r.press(key('Digit3', false, { shiftKey: true }));
    for (let i = 0; i < 10; i++) r.press(key('Digit3', true, { shiftKey: true }));
    expect(r.dispatched).toEqual([SPELL_SLOT_1 + 2]);
  });

  it('out of magic mode the 1999 digits use the shortcut tray, once per press', () => {
    const r = router('ac1999', CombatMode.NonCombat);
    r.hold('Digit1', 10);
    expect(r.dispatched).toEqual([0x10000042]);
  });

  it('a text field keeps every key: nothing is dispatched or prevented', () => {
    const r = router('ac1999', CombatMode.Magic, { textFocused: true });
    const results = r.hold('Digit1', 3);
    expect(r.dispatched).toEqual([]);
    expect(results.every((x) => x === 'text' && !keyDownConsumed(x))).toBe(true);
  });

  it('an action retail repeats (ActionMap toggle type 4) still runs on each repeat', () => {
    const repeating = [...KEY_REPEAT_ACTIONS][0];
    const dispatched: number[] = [];
    const deps = {
      textFocused: () => false, automationHotkey: () => false, syncMaps: () => {},
      resolve: () => repeating, dispatch: (id: number) => { dispatched.push(id); return true; },
    };
    routeGameKeyDown(key('KeyX'), deps);
    routeGameKeyDown(key('KeyX', true), deps);
    routeGameKeyDown(key('KeyX', true), deps);
    expect(dispatched).toEqual([repeating, repeating, repeating]);
  });

  it('a movement key is CameraController\'s; an unbound key falls to the system keys', () => {
    const r = router('ac1999', CombatMode.Magic);
    expect(r.press(key('KeyW'))).toBe('movement');
    expect(r.press(key('Pause'))).toBe('unbound');
    expect(r.dispatched).toEqual([]);
  });
});

/* ── GameUI's spell bar under a held mouse ─────────────────────────── */

describe('GameUI spell bar: a held mouse is one cast at most', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let casts: number[] = [];
  const spell = (id: number, name: string) => ({ id, name, school: 1, level: 1, power: 10, manaCost: 10, difficulty: 10, duration: 1800, components: [1], targetType: 0, iconId: 0x06001000 + id, desc: '' });
  const A = spell(1, 'Flame Bolt I');
  const mouse = (el: HTMLElement, type: string, detail = 1): void => { el.dispatchEvent(new domWindow.MouseEvent(type, { bubbles: true, button: 0, detail })); };
  /** Press and hold: mousedown, then the browser's held-button events (none repeat), then the release and its click. */
  const holdClick = (el: HTMLElement, detail = 1): void => {
    mouse(el, 'mousedown', detail);
    for (let i = 0; i < 20; i++) mouse(el, 'mousemove', 0);
    mouse(el, 'mouseup', detail);
    mouse(el, 'click', detail);
  };

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (typeof g.requestAnimationFrame !== 'function') { g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {}; }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.setSpellCallbacks({ onCastSpell: (i: number) => { casts.push(i); } });
    ui.displayErrorText = () => {};
    ui.playUISound = () => {};
  });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS, saved); });

  const reset = (): void => {
    casts = [];
    ui.knownSpells = [A];
    ui.spellBarSlots = Array.from({ length: 8 }, () => new Array(9).fill(null));
    ui.spellBarSelected = new Array(8).fill(0);
    ui.activeSpellBarTab = 0;
    ui.spellBarSlots[0][0] = A;
  };

  it('a shortcut held down and released selects it and casts nothing; the double-click casts once', () => {
    reset();
    const slot = domWindow.document.createElement('div') as HTMLElement;
    domWindow.document.body.appendChild(slot);
    ui.wireSpellBarSlotEvents(slot, 0, 0);
    holdClick(slot);
    expect(casts).toEqual([]);
    expect(ui.spellBarSelected[0]).toBe(A.id);
    holdClick(slot, 2);
    mouse(slot, 'dblclick', 2);
    expect(casts).toEqual([0]);
  });

  it('the Cast button held down casts once, on its click; each click is one cast', () => {
    reset();
    ui.spellBarSelected[0] = A.id;
    // The spell bar's layout through a stand-in renderer: only the Cast button exists, the rest of
    // renderSpellBarPanel's wiring finds nothing to do.
    const doc = domWindow.document;
    const castBtn = doc.createElement('div') as HTMLElement;
    const handle = new Proxy({ elements: new Map([[SPELLBAR_CAST_BUTTON, castBtn]]), descs: new Map() } as Record<string, unknown>, {
      get: (t, p) => (p in t ? t[p as string] : () => undefined),
    });
    ui.layoutRenderer = { render: (layout: number) => (layout === 0x21000010 ? handle : null) };
    ui.renderSpellBarPanel();
    doc.body.appendChild(castBtn);
    holdClick(castBtn);
    expect(casts).toEqual([0]);
    holdClick(castBtn); holdClick(castBtn);
    expect(casts).toEqual([0, 0, 0]);
  });
});

/* ── telemetry: what pressed Cast, and how soon after the last press ─ */

describe('cast press telemetry (CastPressTracker → RefusalReporter → bridge)', () => {
  it('a press records its source (key / mouse / agent; the mouse when nothing says) and the gap since the last', () => {
    let t = 1000;
    const presses = new CastPressTracker(() => t);
    expect(presses.during('key', () => presses.notePress())).toEqual({ castInput: 'key' });
    t += 170;
    expect(presses.notePress()).toEqual({ castInput: 'mouse', castGapMs: 170 });
    t += 2500;
    expect(presses.during('agent', () => presses.notePress())).toEqual({ castInput: 'agent', castGapMs: 2500 });
    // during() restores the outer source, a throw included.
    expect(() => presses.during('key', () => { throw new Error('x'); })).toThrow('x');
    t += 1;
    expect(presses.notePress().castInput).toBe('mouse');
  });

  it('the server\'s "You\'re too busy!" for a cast carries the press it answered; the bridge keeps the fields', () => {
    let t = 0;
    const posted: string[] = [];
    const rr = new RefusalReporter({
      endpoint: '/client-preworld', build: 'test', trace: '0123456789abcdef',
      era: () => 'ac1999-retail', server: () => 'ac1999', now: () => t,
      send: (_url: string, body: string) => { posted.push(body); },
    });
    const presses = new CastPressTracker(() => t);
    const castOnce = (): void => { rr.withDetail(presses.during('key', () => presses.notePress()), () => rr.noteActionSent(0x4a)); };
    castOnce();
    t += 40;
    rr.serverCode('weenie_error', 0x1d, "You're too busy!", 'spew');
    expect(posted).toHaveLength(1);
    const ev = JSON.parse(posted[0]);
    expect(ev).toMatchObject({ code: 'we:0x001d', action: 0x4a, castInput: 'key' });
    expect(ev.castGapMs).toBeUndefined();
    // The next press 170 ms later: its refusal rolls up with the gap.
    t += 130; castOnce(); t += 40;
    rr.serverCode('weenie_error', 0x1d, "You're too busy!", 'spew');
    rr.flush();
    const roll = JSON.parse(posted[1]);
    expect(roll).toMatchObject({ code: 'we:0x001d', count: 1, castInput: 'key', castGapMs: 170 });
    const kept = sanitizeClientRefusal(roll);
    expect(kept).toMatchObject({ castInput: 'key', castGapMs: 170, action: 0x4a });
    // Only the closed tokens and bounded numbers survive, on the page and at the bridge.
    expect(cleanRefusalDetail({ castInput: 'turbo', castGapMs: -5 })).toEqual({});
    expect(sanitizeClientRefusal({ ...roll, castInput: 'turbo', castGapMs: 1.5 })).not.toHaveProperty('castInput');
  });

  it('a refusal well after the request carries neither its action nor its press', () => {
    let t = 0;
    const posted: string[] = [];
    const rr = new RefusalReporter({
      endpoint: '/client-preworld', build: 'test', trace: '0123456789abcdef',
      era: () => 'eor', server: () => null, now: () => t,
      send: (_url: string, body: string) => { posted.push(body); },
    });
    rr.withDetail({ castInput: 'mouse' }, () => rr.noteActionSent(0x4a));
    t += 10_000;
    rr.serverCode('weenie_error', 0x1d, "You're too busy!", 'spew');
    const ev = JSON.parse(posted[0]);
    expect(ev.action).toBeNull();
    expect(ev.castInput).toBeUndefined();
  });
});
