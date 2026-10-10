/**
 * Retail A/B scene list (tools/retail-ab-scenes.ts): one input script drives
 * both the retail client and ours, so every key a scene presses must be the
 * retail DAT default for the action the scene means (KeyMap 0x14000000/02,
 * which ours binds identically), every key must be drivable on both retail
 * hosts, and ours is pinned to the retail frame's in-game moment.
 */
import { describe, it, expect } from 'vitest';
import { RETAIL_DEFAULT_KEYBINDS } from '../packages/renderer/src/input/KeybindDefaults.generated.ts';
import {
  AB_SCENES, MAC_DRIVER_KEYS, PREWORLD, TOUR, VIEWPORT, XDOTOOL_KEYS, letterbox, mayReplaceRetailFrame, needsPoint, retailFrameClock, selectScenes, ticksAt, toDesign, validateScenes,
  type AbScene,
} from '../tools/retail-ab-scenes.ts';

/** The action each key a scene uses stands for (ActionMap 0x26000000 ids). */
const KEY_ACTION: Record<string, number> = {
  F3: 0x1000000e,        // Show/Hide Allegiance Page
  F4: 0x1000000f,        // Show/Hide Fellowship Page
  F5: 0x10000011,        // Show/Hide Spellbook Page
  F6: 0x10000012,        // Show/Hide Spell Components Page
  F8: 0x10000014,        // Show/Hide Attributes Page
  F9: 0x10000015,        // Show/Hide Skills Page
  F10: 0x10000016,       // Show/Hide World Panel
  F11: 0x1000001a,       // Show/Hide Options Panel
  F12: 0x10000019,       // Show/Hide Inventory Panel
  Backslash: 0x10000032, // Select Closest Item
  KeyR: 0x10000025,      // Use Selected Object
  KeyE: 0x1000002b,      // Examine Selected Object
  Backquote: 0x1000005a, // Toggle Combat Mode
  Quote: 0x10000035,     // Select Closest Monster
  KeyY: 0x10000094,      // Ready
  KeyH: 0x10000095,      // Crouch
  KeyG: 0x10000096,      // Sit
  KeyB: 0x10000097,      // Lay Down
};
/** Keys that are UI conventions rather than KeyMap actions. */
const NON_ACTION_KEYS = new Set(['Escape']);

const keysOf = (s: AbScene): string[] => [...s.steps, ...(s.cleanup ?? [])].flatMap((st) => ('key' in st ? [st.key] : []));

describe('AB_SCENES', () => {
  it('is a valid scene list', () => {
    expect(validateScenes(AB_SCENES)).toEqual([]);
    expect(AB_SCENES.length).toBeGreaterThanOrEqual(30);
  });

  it('pre-world scenes come first and form one session from character select', () => {
    const stages = AB_SCENES.map((s) => s.stage ?? 'world');
    const lastPre = stages.lastIndexOf('preworld');
    expect(lastPre).toBeGreaterThan(0);
    expect(stages.slice(0, lastPre + 1).every((st) => st === 'preworld')).toBe(true);
    expect(AB_SCENES[0].name).toBe('char-select');
  });

  it('never clicks a raw pixel: targets are DAT elements or named objects', () => {
    for (const s of AB_SCENES) {
      for (const st of [...s.steps, ...(s.cleanup ?? [])]) expect('click' in st, `${s.name} uses a raw click`).toBe(false);
    }
  });

  it('presses only retail DAT default keys for the action each scene means', () => {
    for (const s of AB_SCENES) {
      for (const key of keysOf(s)) {
        if (NON_ACTION_KEYS.has(key)) continue;
        const action = KEY_ACTION[key];
        expect(action, `${s.name}: ${key} has no known action`).toBeDefined();
        expect(RETAIL_DEFAULT_KEYBINDS[action], `${s.name}: ${key} is not the retail default for 0x${action.toString(16)}`).toContain(key);
      }
    }
  });

  it('closes what it opens: every panel key in steps is pressed again in cleanup, or the panel\'s close button is clicked', () => {
    for (const s of AB_SCENES) {
      const opened = s.steps.flatMap((st) => ('key' in st && /^F\d+$/.test(st.key) ? [st.key] : []));
      const clicksClose = (s.cleanup ?? []).some((st) => 'element' in st);
      for (const k of opened) expect(clicksClose || (s.cleanup ?? []).some((st) => 'key' in st && st.key === k), `${s.name} leaves ${k} open`).toBe(true);
    }
  });

  it('the social tab scenes close with the panel\'s close button 0x10000290: F3 on the Friends / Squelch page switches to Allegiance instead of closing', () => {
    for (const name of ['social-friends', 'social-squelch']) {
      const s = AB_SCENES.find((x) => x.name === name)!;
      expect(s.cleanup).toEqual([{ element: '0x10000290', layout: '0x21000031' }]);
    }
  });

  it('removes every object it spawns, by name, never with a bare @delete', () => {
    for (const s of AB_SCENES) {
      const spawns = s.steps.filter((st) => 'cmd' in st && st.cmd.startsWith('@create')).length;
      const removes = (s.cleanup ?? []).filter((st) => 'remove' in st).length;
      expect(removes, `${s.name}: ${spawns} spawn(s), ${removes} remove(s)`).toBe(spawns);
      for (const st of [...s.steps, ...(s.cleanup ?? [])]) expect('cmd' in st && /^@delete/.test(st.cmd), `${s.name}: bare @delete`).toBe(false);
    }
  });

  it('tours every town POI and each exported dungeon drop point', () => {
    expect(TOUR.towns.length).toBeGreaterThanOrEqual(40);
    expect(TOUR.dungeons.length).toBeGreaterThanOrEqual(10);
    const names = new Set(AB_SCENES.map((s) => s.name));
    expect(AB_SCENES.filter((s) => s.name.startsWith('town-')).length).toBe(TOUR.towns.length);
    expect(AB_SCENES.filter((s) => s.name.startsWith('dungeon-') && s.name !== 'dungeon-stone').length).toBe(TOUR.dungeons.length);
    expect(names.size).toBe(AB_SCENES.length);
    for (const d of TOUR.dungeons) expect(d.teleloc).toMatch(/^@teleloc 0x[0-9A-F]{8} \[[-\d. ]+\] [-\d. ]+$/);
  });
});

describe('validateScenes', () => {
  const ok: AbScene = { name: 'x', world: false, settleMs: 0, steps: [{ cmd: '@teleloc 0xA9B40019 [84 5 94] 1 0 0 0' }], notes: '' };
  it('accepts a minimal scene', () => expect(validateScenes([ok])).toEqual([]));
  it('rejects keys a retail driver cannot press', () => {
    expect(validateScenes([{ ...ok, steps: [...ok.steps, { key: 'MediaPlay' }] }]).join()).toMatch(/unknown to the Mac driver.*no xdotool keysym/s);
  });
  it('rejects empty chat, a missing start spot, duplicates, bad targets and out-of-frame regions', () => {
    expect(validateScenes([{ ...ok, steps: [...ok.steps, { cmd: '  ' }] }]).join()).toMatch(/empty chat/);
    expect(validateScenes([{ ...ok, steps: [{ key: 'F12' }] }]).join()).toMatch(/fixed @teleloc/);
    expect(validateScenes([{ ...ok, stage: 'preworld', steps: [{ key: 'F12' }] }])).toEqual([]);
    expect(validateScenes([{ ...ok, steps: [...ok.steps, { element: 'Create' }] }]).join()).toMatch(/0x DAT id/);
    expect(validateScenes([{ ...ok, steps: [...ok.steps, { element: '0x100003a0', layout: '0x10000001' }] }]).join()).toMatch(/LayoutDesc/);
    expect(validateScenes([{ ...ok, steps: [...ok.steps, { object: 'Lich' }] }]).join()).toMatch(/SPAWN_NAMES/);
    expect(validateScenes([{ ...ok, cleanup: [{ cmd: '@delete' }] }]).join()).toMatch(/bare @delete/);
    expect(validateScenes([{ ...ok, cleanup: [{ remove: 'Chest' }] }])).toEqual([]);
    expect(validateScenes([ok, ok]).join()).toMatch(/duplicate/);
    expect(validateScenes([{ ...ok, region: { x: 1500, y: 0, w: 200, h: 10 } }]).join()).toMatch(/region outside 1600x900/);
    expect(validateScenes([{ ...ok, steps: [...ok.steps, { wait: 120_000 }] }]).join()).toMatch(/wait/);
  });
});

describe('driver key tables', () => {
  it('the Mac and Linux drivers know the same scene keys', () => {
    for (const k of Object.keys(XDOTOOL_KEYS)) expect(MAC_DRIVER_KEYS.has(k), k).toBe(true);
  });
  it('frames are 1600x900, the retail fullscreen size the harness requests', () => {
    expect(VIEWPORT).toEqual({ width: 1600, height: 900 });
  });
});

describe('selectScenes', () => {
  it('picks by exact name and trailing-* prefix; all when empty', () => {
    expect(selectScenes(AB_SCENES, []).length).toBe(AB_SCENES.length);
    expect(selectScenes(AB_SCENES, ['inventory']).map((s) => s.name)).toEqual(['inventory']);
    expect(selectScenes(AB_SCENES, ['holt*']).map((s) => s.name)).toEqual(['holtburg']);
  });
  it('throws on an unknown scene instead of silently capturing nothing', () => {
    expect(() => selectScenes(AB_SCENES, ['nope'])).toThrow(/unknown retail A\/B scene/);
  });
});

describe('pre-world letterbox mapping (ours resizes; retail is fixed 800x600)', () => {
  it('scales 800x600 into any window the way our layout does, centered', () => {
    expect(letterbox({ width: 1600, height: 900 })).toEqual({ x: 200, y: 0, scale: 1.5, w: 1200, h: 900 });
    expect(letterbox({ width: 800, height: 600 })).toEqual({ x: 0, y: 0, scale: 1, w: 800, h: 600 });
    expect(letterbox({ width: 1000, height: 1200 })).toMatchObject({ x: 0, scale: 1.25, w: 1000, h: 750 });
  });
  it('maps a point in our window back to retail design space', () => {
    // ENTER measured on ours at 1600x900 (0x100003a2 center) → retail's (343, 393) disc.
    expect(toDesign([716, 591], { width: 1600, height: 900 })).toEqual([344, 394]);
    expect(toDesign([400, 300], PREWORLD)).toEqual([400, 300]);
  });
  it('only element and object steps need a resolved point', () => {
    expect(needsPoint({ element: '0x100003a2' })).toBe(true);
    expect(needsPoint({ object: 'Chest' })).toBe(true);
    expect(needsPoint({ remove: 'Chest' })).toBe(true);
    expect(needsPoint({ key: 'F12' })).toBe(false);
  });
});

describe('ticksAt', () => {
  it('steps the server clock back by the wall time since the retail frame', () => {
    expect(ticksAt(10_000, 1_000_000, 1_000_000)).toBe(10_000);
    expect(ticksAt(10_000, 1_090_000, 1_000_000)).toBe(9_910);
  });

  it('a Linux retail run keeps a stored Mac real-GPU frame unless --overwrite', () => {
    const mac = 'mac-gpu (Wine wined3d → OpenGL → Metal)';
    const linux = 'linux-llvmpipe (Wine wined3d → Mesa software GL)';
    expect(mayReplaceRetailFrame(mac, false, false)).toBe(false);
    expect(mayReplaceRetailFrame(mac, false, true)).toBe(true);
    expect(mayReplaceRetailFrame(mac, true, false)).toBe(true);
    expect(mayReplaceRetailFrame(linux, false, false)).toBe(true);
    expect(mayReplaceRetailFrame(undefined, false, false)).toBe(true);
  });
});

describe('retailFrameClock (VISUAL.town-scenery-gaps.a — ACE clocks drift per server)', () => {
  const mac = 'mac-gpu (Wine wined3d → OpenGL → Metal)';
  const at = '2026-10-04T15:50:46.780Z';
  const now = Date.parse(at) + 90_000;
  it('a recorded retail tick wins over any clock estimate', () => {
    expect(retailFrameClock({ retailAt: at, retailRenderer: mac, retailClock: 1234.5 }, 99_999, now, { shotThisRun: false, isMac: false }))
      .toEqual({ ticks: 1234.5, source: 'recorded' });
  });
  it('a frame this run shot steps this server clock back (exact: same server)', () => {
    expect(retailFrameClock({ retailAt: at }, 10_000, now, { shotThisRun: true, isMac: false })).toEqual({ ticks: 9_910, source: 'same-server' });
  });
  it('a Mac frame pinned on the Mac counts as the same server', () => {
    expect(retailFrameClock({ retailAt: at, retailRenderer: mac }, 10_000, now, { shotThisRun: false, isMac: true })?.source).toBe('same-server');
  });
  it('a stored Mac frame pinned in the cloud is only an estimate', () => {
    expect(retailFrameClock({ retailAt: at, retailRenderer: mac }, 10_000, now, { shotThisRun: false, isMac: false })).toEqual({ ticks: 9_910, source: 'other-server' });
    expect(retailFrameClock({ retailAt: at, retailRenderer: 'linux-llvmpipe' }, 10_000, now, { shotThisRun: false, isMac: true })?.source).toBe('other-server');
  });
  it('no retail frame time and no recorded tick: nothing to pin', () => {
    expect(retailFrameClock({}, 10_000, now, { shotThisRun: true, isMac: true })).toBeNull();
    expect(retailFrameClock({ retailAt: at, retailClock: Number.NaN }, 10_000, now, { shotThisRun: true, isMac: false })?.source).toBe('same-server');
  });
});
