/**
 * BUG.keybind-saved-binding-load (webac#13 follow-up) — "Use Closest Unopened Corpse now works,
 * with one oddity. When I first log in it doesn't work until I set the hotkey for select closest
 * unopened corpse and then set the hotkey back to the Use version."
 *
 * The reporter's key is L, retail's default for Select Previous Monster (0x10000036, the same
 * Selection map 0x10000007). Binding L in Keyboard Config takes it from Select Previous Monster
 * (KeybindRegistry.setMapping, CInputMap::AddMapping @ 0068ef90), which left that command with no
 * key, and serialize() wrote only non-empty commands, so the save never said so. At the next login
 * loadSerialized() overlaid the save on the defaults: Select Previous Monster kept its default L,
 * both commands held L, and resolve() picked Select Previous Monster (same map, earlier in the
 * ActionMap). Re-binding L in the session took it away again, until the next login.
 *
 * These tests drive the login load main.ts runs (EraKeymaps.loadEraKeybinds over a stored save),
 * then the real key router and dispatcher, in every era keymap; the sweep binds every command to
 * every key another live command holds by default and requires the reload to match the session.
 */
import { describe, it, expect } from 'vitest';
import { CombatMode } from '@ac/shared';
import { loadEraKeybinds, saveEraKeybinds, keybindDefaultsFor, keybindStorageKey, type EraKeymap, type KeybindStore } from '../packages/renderer/src/input/EraKeymaps.js';
import { ACT, activeInputMaps } from '../packages/renderer/src/input/KeybindDefaults.js';
import type { KeybindRegistry } from '../packages/renderer/src/input/KeybindRegistry.js';
import { routeGameKeyDown } from '../packages/renderer/src/input/GameKeyDown.js';
import { dispatchGameAction, type ActionHost } from '../packages/renderer/src/input/ActionDispatch.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { ERA_PROFILES, eraProfile } from '../packages/renderer/src/era/EraProfiles.js';

function memoryStore(init: Record<string, string> = {}): KeybindStore & { data: Record<string, string> } {
  const data = { ...init };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

/** A world with one unopened corpse 6 m away; records what the dispatcher selected and used. */
function corpseWorld() {
  const CORPSE = 0x80000002;
  const w = { selected: 0, used: [] as number[], dispatched: [] as number[] };
  const host = new Proxy({
    ui: {} as ActionHost['ui'],
    camera: {} as ActionHost['camera'],
    emoteMotion: () => undefined,
    selectCycle: () => { w.selected = CORPSE; return CORPSE; },
    selectedId: () => w.selected,
    isCorpse: (g: number) => g === CORPSE,
    useObject: (g: number) => { w.used.push(g); },
  } as Partial<ActionHost>, {
    get(t, k) {
      if (k in t) return (t as Record<string | symbol, unknown>)[k];
      throw new Error(`the key ran another command (touched host.${String(k)})`);
    },
  }) as ActionHost;
  return { w, CORPSE, host };
}

function press(code: string, registry: KeybindRegistry, dispatch: (id: number) => boolean, mode = CombatMode.NonCombat) {
  return routeGameKeyDown({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false }, {
    textFocused: () => false,
    automationHotkey: () => false,
    syncMaps: () => registry.setActiveInputMaps(activeInputMaps(mode)),
    resolve: (c) => registry.resolveOrBare(c),
    dispatch,
  });
}

/** Every keymap an era profile loads (end of retail + Dark Majesty share 'eor'; AC1999 its own). */
const KEYMAPS: EraKeymap[] = [...new Set([
  eraClientRules(null).keymap,
  ...Object.keys(ERA_PROFILES).map((id) => eraClientRules(eraProfile(id)).keymap),
])];

describe('a saved binding dispatches after login (webac#13 follow-up)', () => {
  it('every era profile loads one of the two keymaps', () => {
    expect(KEYMAPS.sort()).toEqual(['ac1999', 'eor']);
  });

  for (const keymap of KEYMAPS) {
    it(`${keymap}: L bound to Use Closest Unopened Corpse, saved, then the next login: L opens the corpse`, () => {
      const store = memoryStore();
      const session = loadEraKeybinds(keymap, store);
      session.setMapping(ACT.UseClosestUnopenedCorpse, 0, 'KeyL');
      saveEraKeybinds(session, keymap, store);

      const login = loadEraKeybinds(keymap, store);
      const { w, CORPSE, host } = corpseWorld();
      const r = press('KeyL', login, (id) => { w.dispatched.push(id); return dispatchGameAction(id, host); });
      expect(r).toBe('dispatched');
      expect(w.dispatched).toEqual([ACT.UseClosestUnopenedCorpse]);
      expect(w.used).toEqual([CORPSE]);
      // L stays the player's on every later login (the save written after a reload keeps it too).
      saveEraKeybinds(login, keymap, store);
      expect(loadEraKeybinds(keymap, store).resolve('KeyL')).toBe(ACT.UseClosestUnopenedCorpse);
    });
  }

  it('a save written before the fix (the emptied Select Previous Monster omitted) loads with L on the corpse command', () => {
    // The shape the reporter's browser holds: the old serialize() wrote non-empty commands only.
    const legacy = JSON.stringify({ [ACT.UseClosestUnopenedCorpse]: ['KeyL', null, null] });
    const store = memoryStore({ [keybindStorageKey('eor')]: legacy });
    const login = loadEraKeybinds('eor', store);
    expect(keybindDefaultsFor('eor')[ACT.SelectPrevMonster]).toEqual(['KeyL']);
    expect(login.resolve('KeyL')).toBe(ACT.UseClosestUnopenedCorpse);
    expect(login.getMappings(ACT.SelectPrevMonster)).toEqual([null, null, null]);
    // Commands the save does not mention and whose keys it does not claim keep their defaults.
    expect(login.getMappings(ACT.SelectClosestMonster)[0]).toBe(keybindDefaultsFor('eor')[ACT.SelectClosestMonster][0]);
    expect(login.getMappings(ACT.SelectClosestMonster)[0]).toBeTruthy();
  });

  it('a default taken by a command in a map never live with it is kept (melee / magic share keys)', () => {
    const defaults = keybindDefaultsFor('eor');
    // Find a key two never-co-active commands share by default, then save one of them alone.
    const session = loadEraKeybinds('eor', null);
    let pair: [number, number, string] | null = null;
    for (const [a, codes] of Object.entries(defaults)) {
      for (const c of codes) {
        for (const [b, other] of Object.entries(defaults)) {
          if (a !== b && other.includes(c) && !session.coactive(Number(a), Number(b))) { pair = [Number(a), Number(b), c]; break; }
        }
        if (pair) break;
      }
      if (pair) break;
    }
    expect(pair).not.toBeNull();
    const [a, b, code] = pair!;
    const login = loadEraKeybinds('eor', memoryStore({ [keybindStorageKey('eor')]: JSON.stringify({ [a]: [code, null, null] }) }));
    expect(login.getMappings(b)).toContain(code);
  });

  /*
   * The sweep: every command, bound in-session to every key another co-active command holds by
   * default (the case that empties that owner), plus one free key. After save + login the
   * bindings must equal the session's, and the key must resolve to the command whenever its map
   * is registered — in each era keymap.
   */
  for (const keymap of KEYMAPS) {
    it(`${keymap}: every command bound to every contested default key survives the login load`, () => {
      const defaults = keybindDefaultsFor(keymap);
      const probe = loadEraKeybinds(keymap, null);
      const failures: string[] = [];
      let cases = 0;
      for (const action of probe.actions()) {
        const contested = new Set<string>(['F13']);
        for (const [other, codes] of Object.entries(defaults)) {
          if (Number(other) === action.id || !probe.coactive(action.id, Number(other))) continue;
          for (const c of codes) if (!(defaults[action.id] ?? []).includes(c)) contested.add(c);
        }
        for (const code of contested) {
          cases++;
          const store = memoryStore();
          const session = loadEraKeybinds(keymap, store);
          session.setMapping(action.id, 0, code);
          saveEraKeybinds(session, keymap, store);
          const login = loadEraKeybinds(keymap, store);
          const map = login.inputMapOf(action.id);
          if (map !== null) { session.setActiveInputMaps([map]); login.setActiveInputMaps([map]); }
          const got = login.resolve(code);
          if (got !== action.id || JSON.stringify(login.snapshot()) !== JSON.stringify(session.snapshot())) {
            failures.push(`${action.name} (0x${action.id.toString(16)}) on ${code} → 0x${(got ?? 0).toString(16)}`);
          }
        }
      }
      expect(cases).toBeGreaterThan(probe.actions().length);
      expect(failures).toEqual([]);
    });
  }
});
