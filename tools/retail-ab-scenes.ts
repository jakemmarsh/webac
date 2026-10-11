/**
 * Retail A/B scenes: ONE input script per scene that drives both the real
 * retail client (tools/launch-retail-client-mac.sh / launch-retail-client.sh)
 * and ours, so the two frames come from the same server state reached the
 * same way (docs/verification-workflows.md "Retail A/B").
 *
 * Steps are what a player does: type a chat line, press a key named by
 * KeyboardEvent.code, click a DAT UI element by id, click a world object by
 * name, or wait. Keys are retail's DAT defaults (KeyMap 0x14000000/0x14000002
 * → src/input/KeybindDefaults.generated.ts), which ours binds identically.
 * Click targets are never pixel constants: ours resolves an element from its
 * DOM and an object by projecting it, and retail clicks the point ours found
 * (in 800x600 design space for pre-world, frame space in the world). If ours
 * puts the element somewhere retail does not, the click misses and the sheet
 * shows it. Our UI keeps resizing with the window (browser UX is the one
 * exception to retail faithfulness, CLAUDE.md); only the A/B frame is 1600x900.
 *
 * Both sides log in as the same character (testacjs3 / +Obsprobe), one after
 * the other (ACE allows one session per account). Ours is pinned to the
 * in-game moment and day group of each retail world frame.
 */

import { readFileSync } from 'node:fs';

export type Step =
  | { cmd: string }                                   // a chat line (typed: Return, text, Return)
  | { key: string }                                   // KeyboardEvent.code, optionally "Shift+"
  | { element: string; layout?: string }              // click a DAT UI element (data-element-id), inside a layout root
  | { object: string }                                // click the newest dynamic world object with this name
  | { remove: string }                                // delete the newest dynamic object with this name (a spawn this scene made)
  | { click: [number, number] }                       // a raw frame point (only for points no element names)
  | { drag: string; layout?: string; to: [number, number] } // press on the first draggable item inside a DAT element, move to a frame point, and HOLD the button
  | { release: true }                                 // move back to the held drag's origin and let go (the drop lands where it started)
  | { wait: number };

export interface AbScene {
  name: string;
  /**
   * 'preworld' scenes run in list order in one session that starts at
   * character select (each continues from the previous one's state); retail's
   * pre-world is 800x600 and ours' letterbox is scaled to match. 'world'
   * scenes (default) each start from a fixed @teleloc.
   */
  stage?: 'preworld' | 'world';
  steps: Step[];
  /** Undo what the steps opened or spawned, run after the shot. */
  cleanup?: Step[];
  /** ms between the last step and the shot (landblock streaming, panel open). */
  settleMs: number;
  /**
   * The 3D world is part of what the scene checks. Cloud retail frames are
   * software-rendered (llvmpipe) and only count for HUD/panel layout, so a
   * world scene needs the Mac (GPU) retail side to be authoritative.
   */
  world: boolean;
  /** Region of the frame the scene is about (panel diff); whole frame when absent. */
  region?: { x: number; y: number; w: number; h: number };
  notes: string;
}

export const VIEWPORT = { width: 1600, height: 900 } as const;
/** Retail's fixed pre-world design size; ours letterboxes it into any window. */
export const PREWORLD = { width: 800, height: 600 } as const;
export const ACCOUNT = 'testacjs3';

/**
 * Holtburg, south of the lifestone, facing north-ish: the 2026-09-26 A/B spot
 * (verification/retail-client/ab). ACE @teleloc wants cell [x y z] qw qx qy qz.
 */
export const HOLTBURG_SPOT = '@teleloc 0xA9B40019 [84.3 5.0 94] 0.9969 0 0 -0.0785';
/**
 * A quiet hillside south-west of Holtburg for panel scenes: no corpses or NPCs
 * nearby and an empty backdrop, so the diff is about the panel (feet at z 89).
 */
export const QUIET_SPOT = '@teleloc 0xA9B40011 [60 12 90] 0.9969 0 0 -0.0785';
/**
 * Level open ground on Holtburg's north side for spawned objects: retail seats
 * an object on a slope lower than ours (VISUAL.spawned-object-slope-height), so
 * interaction scenes stay on flat ground (z 66 at y 150-158, nothing behind the
 * camera; probed 2026-10-02).
 */
export const FLAT_SPOT = '@teleloc 0xA9B4000F [40 154 66] 0.9969 0 0 -0.0785';
/** 4 m south of FLAT_SPOT: an object spawned at FLAT_SPOT stands in front. */
export const FLAT_SPOT_BACK = '@teleloc 0xA9B4000F [40 150 66] 0.9969 0 0 -0.0785';
/** The Holtburg Dungeon drop point (capture-scenes.ts DUNGEON_STONE). */
export const DUNGEON_STONE_SPOT = '@teleloc 0x01F60289 [96.7 -10 0] -0.719 0 0 -0.695';

/** Names of the objects scenes @create; tools/capture-retail-ab.ts sweeps dynamic ones left by an interrupted run. */
export const SPAWN_NAMES = ['Chest', 'Drudge Skulker'];

// DAT layout + element ids (LayoutDesc, as our renderer tags them).
const CHAR_PANEL = '0x2100002e';
const OPTIONS_PANEL = '0x2100002b';
const SOCIAL_PANEL = '0x21000031';
const WORLD_PANEL = '0x21000027';
const CHARGEN = '0x21000038';

const at = (spot: string, settle = 12_000): Step[] => [{ cmd: spot }, { wait: settle }];
/** Spawn `wcid` at FLAT_SPOT and step back so it stands in front. */
const spawnInFront = (wcid: number): Step[] => [...at(FLAT_SPOT, 8000), { cmd: `@create ${wcid}` }, { wait: 2500 }, { cmd: FLAT_SPOT_BACK }, { wait: 8000 }];
/**
 * Delete the spawn. Ours deletes exactly that object (select + identify its
 * guid, @delete); retail clicks its point, examines (ACE's @delete acts on the
 * last examined object) and deletes. Never a bare @delete: after a missed
 * click it would delete whatever was selected (2026-10-02: a Cooking Forge).
 */
const deleteSpawn = (name: string): Step[] => [{ remove: name }, { wait: 1500 }];

/**
 * A panel scene: open with `key`, optionally click a tab, and close again.
 * `close` names the panel's close button for panels whose key is a tab
 * switch: F3 on the social panel's Friends page goes to the Allegiance page
 * instead of closing (the panel stays up, and the next scene's F3 closed it;
 * HARNESS / VISUAL.social-squelch-tab-missing, 2026-10-05).
 */
function panel(
  name: string, key: string, notes: string,
  tab?: { element: string; layout: string }, close?: { element: string; layout: string },
): AbScene {
  return {
    name, world: false, settleMs: 2500,
    steps: [...at(QUIET_SPOT), { key }, ...(tab ? [{ wait: 1200 }, tab] : [])],
    cleanup: close ? [close] : [{ key }],
    notes,
  };
}
/** World scenes at a POI: teleport, let it stream, shoot the idle HUD over it. */
const poi = (name: string, poiName: string, notes: string): AbScene => ({
  name, world: true, settleMs: 4000, steps: [{ cmd: `@telepoi ${poiName}` }, { wait: 20_000 }], notes,
});
/** The world tour (tools/gen-retail-ab-tour.ts from the ACE world DB): every town POI and one drop point per dungeon landblock. */
export const TOUR = JSON.parse(readFileSync(new URL('./retail-ab-tour.json', import.meta.url), 'utf8')) as {
  towns: string[]; dungeons: { name: string; teleloc: string }[];
};
const slug = (n: string): string => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const tourScenes: AbScene[] = [
  ...TOUR.towns.map((t): AbScene => ({
    name: `town-${slug(t)}`, world: true, settleMs: 4000, steps: [{ cmd: `@telepoi ${t}` }, { wait: 20_000 }],
    notes: `World tour: ${t} (ACE point of interest): building placement, terrain, scenery, sky.`,
  })),
  ...TOUR.dungeons.map((d): AbScene => ({
    // Hop to the quiet spot first: monsters from the previous tour stop (Fort
    // Tethana's Lugians, Banished Tuskers) otherwise keep the character in a
    // fight, and in the 2026-10-02 run every dungeon frame showed one spot.
    name: `dungeon-${slug(d.name)}`, world: true, settleMs: 6000, steps: [...at(QUIET_SPOT, 8000), { cmd: d.teleloc }, { wait: 18_000 }],
    notes: `World tour: ${d.name} drop point (its portal's Destination): cell geometry, statics, dungeon lighting.`,
  })),
];

const emote = (name: string, key: string, what: string): AbScene => ({
  name, world: true, settleMs: 3500,
  steps: [...at(QUIET_SPOT), { key }],
  cleanup: [{ key: 'KeyY' }, { wait: 1500 }],   // Ready (stand back up)
  notes: `${what} (${key}, retail default): the held pose.`,
});

export const AB_SCENES: AbScene[] = [
  // ── Pre-world (one session from character select, in order) ──────────
  { name: 'char-select', stage: 'preworld', world: false, settleMs: 1500, steps: [],
    notes: 'Character select (0x21000004).' },
  { name: 'chargen-heritage', stage: 'preworld', world: false, settleMs: 3000,
    steps: [{ element: '0x100003a0' }, { wait: 4000 }, { element: '0x100003bf', layout: CHARGEN }],
    notes: 'Create Character → the Heritage page with the first heritage (Aluvian) chosen.' },
  { name: 'chargen-profession', stage: 'preworld', world: false, settleMs: 2500, steps: [{ element: '0x100003f0', layout: CHARGEN }],
    notes: 'Chargen Profession page (second tab).' },
  { name: 'chargen-skills', stage: 'preworld', world: false, settleMs: 2500, steps: [{ element: '0x100003f1', layout: CHARGEN }],
    notes: 'Chargen Skills page (third tab).' },
  { name: 'chargen-appearance', stage: 'preworld', world: false, settleMs: 3000, steps: [{ element: '0x100003f2', layout: CHARGEN }],
    notes: 'Chargen Appearance page (fourth tab).' },
  { name: 'chargen-town', stage: 'preworld', world: false, settleMs: 2500, steps: [{ element: '0x100003f3', layout: CHARGEN }],
    notes: 'Chargen Town page (fifth tab).' },
  { name: 'chargen-summary', stage: 'preworld', world: false, settleMs: 2500, steps: [{ element: '0x100003f4', layout: CHARGEN }],
    notes: 'Chargen Summary page (sixth tab).' },

  // ── World ─────────────────────────────────────────────────────────────
  {
    name: 'holtburg', world: true, settleMs: 3000,
    steps: at(HOLTBURG_SPOT, 15_000),
    notes: 'Idle full HUD over Holtburg: terrain, buildings, sky, fog, the lifestone, HUD chrome.',
  },
  poi('yaraq', 'yaraq', 'Yaraq (desert town): terrain palette, buildings, sky over sand.'),
  poi('shoushi', 'shoushi', 'Shoushi (Sho town): architecture, terrain, sky.'),
  panel('inventory', 'F12', 'Inventory panel (F12).'),
  panel('attributes', 'F8', 'Character attributes page (F8).'),
  panel('skills', 'F9', 'Character skills page (F9).'),
  panel('titles', 'F8', 'Character panel → Titles tab.', { element: '0x10000538', layout: CHAR_PANEL }),
  panel('spellbook', 'F5', 'Spellbook page (F5).'),
  panel('components', 'F6', 'Spell components page (F6).'),
  panel('allegiance', 'F3', 'Allegiance page (F3).'),
  panel('fellowship', 'F4', 'Fellowship page (F4).'),
  panel('social-friends', 'F3', 'Social panel → Friends tab.', { element: '0x10000512', layout: SOCIAL_PANEL }, { element: '0x10000290', layout: SOCIAL_PANEL }),
  panel('social-squelch', 'F3', 'Social panel → Squelch tab.', { element: '0x1000053b', layout: SOCIAL_PANEL }, { element: '0x10000290', layout: SOCIAL_PANEL }),
  panel('world-panel', 'F10', 'World panel / map (F10).'),
  panel('world-house', 'F10', 'World panel → House tab.', { element: '0x100001f4', layout: WORLD_PANEL }),
  panel('options', 'F11', 'Options panel, Gameplay tab (F11).'),
  panel('options-character', 'F11', 'Options → Character tab.', { element: '0x1000020e', layout: OPTIONS_PANEL }),
  panel('options-chat', 'F11', 'Options → Chat tab.', { element: '0x1000050b', layout: OPTIONS_PANEL }),
  panel('options-config', 'F11', 'Options → Config tab.', { element: '0x1000020f', layout: OPTIONS_PANEL }),
  {
    name: 'combat-mode', world: false, settleMs: 3000,
    steps: [...at(QUIET_SPOT), { key: 'Backquote' }],
    cleanup: [{ key: 'Backquote' }, { wait: 1500 }],
    notes: 'Toggle Combat Mode (`): stance change and the combat bar.',
  },
  {
    name: 'chat-say', world: false, settleMs: 2500,
    steps: [...at(QUIET_SPOT), { cmd: 'Hello Dereth' }],
    notes: 'A spoken chat line: the chat window text, colors and wrapping.',
  },
  {
    name: 'notice-spew', world: false, settleMs: 800,
    steps: [...at(QUIET_SPOT), { cmd: '/tell Bogus hi' }],
    region: { x: 400, y: 0, w: 800, h: 120 },
    notes: 'A 0x1a notice (gmSpewBoxUI, layout 0x21000011): /tell without a comma → "Use comma after the name for targeted chat." (DoTell :363427), centred 20 px down behind the vitals bar, plus its red main-chat copy. Shot inside the row\'s 5 s life. (AutoRun ON/OFF is no use here: its ~95 px text hides entirely behind the 154 px vitals bar.)',
  },
  {
    name: 'drag-pack-item', world: false, settleMs: 1000,
    steps: [...at(QUIET_SPOT), { key: 'F12' }, { wait: 1500 }, { drag: '0x100001cf', to: [560, 600] }],
    cleanup: [{ release: true }, { wait: 1200 }, { key: 'F12' }],
    notes: 'The first backpack item dragged out over open ground, button held: the ghosted source cell, the drag icon, the toolbar naming the item. Released back on its cell. Ours\' drag icon is the browser\'s native drag image, which a page screenshot does not include.',
  },
  emote('emote-sit', 'KeyG', 'Sit'),
  emote('emote-crouch', 'KeyH', 'Crouch'),
  emote('emote-lay-down', 'KeyB', 'Lay Down'),
  {
    name: 'chest-open', world: true, settleMs: 4000,
    steps: [...spawnInFront(143), { object: 'Chest' }, { wait: 800 }, { key: 'KeyR' }],
    cleanup: [{ object: 'Chest' }, { wait: 800 }, { key: 'KeyR' }, { wait: 1500 }, ...deleteSpawn('Chest')],
    notes: 'Spawned chest (@create 143) on level ground, clicked then Use (R): the container strip.',
  },
  {
    name: 'examine-chest', world: false, settleMs: 4000,
    steps: [...spawnInFront(143), { object: 'Chest' }, { wait: 800 }, { key: 'KeyE' }],
    cleanup: [{ key: 'Escape' }, { wait: 800 }, ...deleteSpawn('Chest')],
    notes: 'Examine (E) on a clicked chest: the examine panel.',
  },
  {
    name: 'monster-selected', world: true, settleMs: 3000,
    steps: [...spawnInFront(7), { key: 'Quote' }],
    cleanup: deleteSpawn('Drudge Skulker'),
    notes: 'A Drudge Skulker (@create 7), Select Closest Monster (\'): the target health bar and selection.',
  },
  {
    name: 'monster-combat', world: true, settleMs: 3500,
    steps: [...spawnInFront(7), { key: 'Quote' }, { wait: 800 }, { key: 'Backquote' }, { wait: 2500 }],
    cleanup: [{ key: 'Backquote' }, { wait: 1500 }, ...deleteSpawn('Drudge Skulker')],
    notes: 'The Skulker selected and combat mode on: stance, combat bar, the monster reacting.',
  },
  {
    name: 'dungeon-stone', world: true, settleMs: 9000,
    steps: at(DUNGEON_STONE_SPOT, 15_000),
    notes: 'Holtburg Dungeon interior: cell geometry, dungeon lighting, no sky.',
  },
  ...tourScenes,
];

/** The click a pre-world step needs to leave character select for the world (ENTER, 0x21000004). */
export const ENTER_WORLD: Step = { element: '0x100003a2' };

/** Ours' letterbox for retail's 800x600 pre-world in a `view`-sized window (same rule as our layout scaling). */
export function letterbox(view: { width: number; height: number }): { x: number; y: number; scale: number; w: number; h: number } {
  const scale = Math.min(view.width / PREWORLD.width, view.height / PREWORLD.height);
  const w = Math.round(PREWORLD.width * scale);
  const h = Math.round(PREWORLD.height * scale);
  return { x: Math.round((view.width - w) / 2), y: Math.round((view.height - h) / 2), scale, w, h };
}

/** A point in ours' window → retail's 800x600 pre-world design space. */
export function toDesign(pt: [number, number], view: { width: number; height: number }): [number, number] {
  const lb = letterbox(view);
  return [Math.round((pt[0] - lb.x) / lb.scale), Math.round((pt[1] - lb.y) / lb.scale)];
}

/**
 * The points a drag moves through after the press, `from` excluded and `to`
 * included: about one per 16 px, at least 8. Every driver moves along this
 * path, because a single jump to the target never starts a retail drag.
 */
export function dragPath(from: [number, number], to: [number, number]): [number, number][] {
  const n = Math.max(8, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 16));
  return Array.from({ length: n }, (_, i) => [
    Math.round(from[0] + ((to[0] - from[0]) * (i + 1)) / n),
    Math.round(from[1] + ((to[1] - from[1]) * (i + 1)) / n),
  ] as [number, number]);
}

/** Steps whose click point ours resolves and retail replays. */
export const needsPoint = (st: Step): boolean => 'element' in st || 'object' in st || 'remove' in st || 'drag' in st;

// ── Key names per driver ─────────────────────────────────────────────────

/** Every key a scene may use, with its xdotool keysym (Linux retail driver). */
export const XDOTOOL_KEYS: Record<string, string> = {
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
  Backslash: 'backslash', Backquote: 'grave', Backspace: 'BackSpace', Quote: 'apostrophe', Semicolon: 'semicolon',
  Slash: 'slash', Comma: 'comma', Period: 'period', Minus: 'minus', Equal: 'equal', BracketLeft: 'bracketleft',
  BracketRight: 'bracketright', Escape: 'Escape', Enter: 'Return', Tab: 'Tab', Space: 'space', Home: 'Home',
  Delete: 'Delete', PageDown: 'Next', PageUp: 'Prior',
  KeyE: 'e', KeyF: 'f', KeyR: 'r', KeyT: 't', KeyP: 'p', KeyL: 'l', KeyN: 'n', KeyM: 'm', KeyQ: 'q',
  KeyB: 'b', KeyG: 'g', KeyH: 'h', KeyY: 'y',
};

/** The keys tools/retail-drive-mac.swift knows (kept in step with its `codes` table). */
export const MAC_DRIVER_KEYS = new Set([
  'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyH', 'KeyG', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyQ', 'KeyW', 'KeyE', 'KeyR',
  'KeyY', 'KeyT', 'KeyO', 'KeyU', 'KeyI', 'KeyP', 'KeyL', 'KeyJ', 'KeyK', 'KeyN', 'KeyM',
  'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
  'Equal', 'Minus', 'BracketRight', 'BracketLeft', 'Enter', 'Quote', 'Semicolon', 'Backslash', 'Comma', 'Slash',
  'Period', 'Tab', 'Space', 'Backquote', 'Backspace', 'Escape',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Home', 'PageUp', 'Delete', 'End', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp',
]);

/** Every reason the scene list is unusable (empty = valid). */
export function validateScenes(scenes: AbScene[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const s of scenes) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s.name)) errors.push(`${s.name}: name must be kebab-case`);
    if (seen.has(s.name)) errors.push(`${s.name}: duplicate name`);
    seen.add(s.name);
    for (const step of [...s.steps, ...(s.cleanup ?? [])]) {
      if ('click' in step) {
        const [x, y] = step.click;
        if (!(x >= 0 && y >= 0 && x < VIEWPORT.width && y < VIEWPORT.height)) errors.push(`${s.name}: click ${x},${y} outside the frame`);
      } else if ('key' in step) {
        const base = step.key.replace(/^Shift\+/, '');
        if (!MAC_DRIVER_KEYS.has(base)) errors.push(`${s.name}: key ${step.key} unknown to the Mac driver`);
        if (!(base in XDOTOOL_KEYS)) errors.push(`${s.name}: key ${step.key} has no xdotool keysym`);
      } else if ('element' in step) {
        if (!/^0x[0-9a-f]{8}$/.test(step.element)) errors.push(`${s.name}: element must be a 0x DAT id, got ${step.element}`);
        if (step.layout !== undefined && !/^0x21[0-9a-f]{6}$/.test(step.layout)) errors.push(`${s.name}: layout must be a 0x21 LayoutDesc id`);
      } else if ('drag' in step) {
        if (!/^0x[0-9a-f]{8}$/.test(step.drag)) errors.push(`${s.name}: drag source must be a 0x DAT id, got ${step.drag}`);
        if (step.layout !== undefined && !/^0x21[0-9a-f]{6}$/.test(step.layout)) errors.push(`${s.name}: layout must be a 0x21 LayoutDesc id`);
        const [x, y] = step.to;
        if (!(x >= 0 && y >= 0 && x < VIEWPORT.width && y < VIEWPORT.height)) errors.push(`${s.name}: drag to ${x},${y} outside the frame`);
      } else if ('release' in step) {
        if (!s.steps.some((st) => 'drag' in st)) errors.push(`${s.name}: release without a drag`);
      } else if ('object' in step || 'remove' in step) {
        const name = 'object' in step ? step.object : step.remove;
        if (!SPAWN_NAMES.includes(name)) errors.push(`${s.name}: object ${name} is not in SPAWN_NAMES (it would never be swept)`);
      } else if ('cmd' in step) {
        if (!step.cmd.trim()) errors.push(`${s.name}: empty chat line`);
        if (/^@delete\b/.test(step.cmd.trim())) errors.push(`${s.name}: bare @delete deletes whatever is selected; use a { remove } step`);
      } else if (!(Number.isFinite(step.wait) && step.wait >= 0 && step.wait <= 60_000)) {
        errors.push(`${s.name}: wait must be 0..60000 ms`);
      }
    }
    if ((s.stage ?? 'world') === 'world' && !s.steps.some((st) => 'cmd' in st && /^@tele(loc|poi) /.test(st.cmd))) {
      errors.push(`${s.name}: a world scene must start from a fixed @teleloc/@telepoi`);
    }
    const r = s.region;
    if (r && (r.x < 0 || r.y < 0 || r.w <= 0 || r.h <= 0 || r.x + r.w > VIEWPORT.width || r.y + r.h > VIEWPORT.height)) {
      errors.push(`${s.name}: region outside ${VIEWPORT.width}x${VIEWPORT.height}`);
    }
  }
  return errors;
}

/** Scenes by name (exact, or a trailing * prefix); all when `names` is empty. */
export function selectScenes(scenes: AbScene[], names: string[]): AbScene[] {
  if (!names.length) return scenes;
  const pick = scenes.filter((s) => names.some((n) => (n.endsWith('*') ? s.name.startsWith(n.slice(0, -1)) : s.name === n)));
  const unknown = names.filter((n) => !scenes.some((s) => (n.endsWith('*') ? s.name.startsWith(n.slice(0, -1)) : s.name === n)));
  if (unknown.length) throw new Error(`unknown retail A/B scene(s): ${unknown.join(', ')}`);
  return pick;
}

/**
 * Whether a retail run on this host may replace a scene's stored retail frame.
 * The Mac frame is real GPU and authoritative for everything; a Linux frame
 * (llvmpipe) only for HUD/panel layout. So a non-Mac run keeps a stored Mac
 * frame unless `overwrite` (--overwrite) asks for it.
 */
export function mayReplaceRetailFrame(storedRenderer: string | undefined, hostIsMac: boolean, overwrite: boolean): boolean {
  return hostIsMac || overwrite || !storedRenderer?.startsWith('mac-gpu');
}

/**
 * The server-clock tick value at a past wall-clock instant: both clients run
 * the same ACE clock, so ours reproduces the retail frame's moment by stepping
 * its own current tick estimate back by the wall time since that frame.
 */
export function ticksAt(nowTicks: number, nowMs: number, thenMs: number): number {
  return nowTicks - (nowMs - thenMs) / 1000;
}

/**
 * Where the sky pin for a retail frame comes from. ACE's clock is NOT shared
 * between servers: Timers.PortalYearTicks starts at the boot's wall-clock lore
 * time and then only advances by world-tick time (WorldManager.cs, `+=
 * worldTickTimer.Elapsed`), so each server drifts on its own (a sleeping Mac,
 * a slow tick). `ticksAt` is only right on the server the retail frame was
 * shot against (VISUAL.town-scenery-gaps.a: a cloud run pinned the Mac's
 * 2026-10-04 Holtburg frame to phase 0.140 where the same-server run had
 * 0.979, and the sky difference read as a missing roof).
 *  - 'recorded': the frame's own server tick, stored by a same-server run.
 *  - 'same-server': this run shot the retail frame, or both are the Mac's.
 *  - 'other-server': an estimate from this server's clock; sky and lighting
 *    differences in that sheet are not findings.
 */
export type RetailClockSource = 'recorded' | 'same-server' | 'other-server';

export interface RetailClockMeta { retailAt?: string; retailRenderer?: string; retailClock?: number }

export function retailFrameClock(
  meta: RetailClockMeta, nowTicks: number, nowMs: number,
  host: { shotThisRun: boolean; isMac: boolean },
): { ticks: number; source: RetailClockSource } | null {
  if (typeof meta.retailClock === 'number' && Number.isFinite(meta.retailClock)) return { ticks: meta.retailClock, source: 'recorded' };
  if (!meta.retailAt) return null;
  const ticks = ticksAt(nowTicks, nowMs, Date.parse(meta.retailAt));
  const same = host.shotThisRun || (host.isMac && !!meta.retailRenderer?.startsWith('mac-gpu'));
  return { ticks, source: same ? 'same-server' : 'other-server' };
}
