/**
 * The whole-screen SCENE table of tools/capture-ui-screens.ts (world + HUD
 * composite captures), split out so tests can import it — the harness runs
 * on import. Scenes are judged as WHOLE FRAMES against the full-screen retail
 * references in reference/images/hud/.
 */
import { HOLTBURG_SPOT } from './retail-ab-scenes.js';
import { ZOOM_FARTHEST } from './lib/camera-pins.js';

// CORE.17.r — the day group every scene pins unless it names its own. The
// group is the retail hash of the server clock's absolute day
// (SkyDesc::CalcPresentDayGroup — before CORE.17.r ours was a Math.random()
// roll per session and per day boundary), ACE's clock is wall time, and
// freezeTimeOfDay() never held it: of the EoL region's 20 groups, the 6
// Sunny / 3 Clear draw a blue sky with cirrus and the 3 Cloudy / 8 Rainy an
// overcast-white one, which is why two world-town-day runs in different
// sessions disagreed. Pinned by NAME → the first match in DAT order
// (acDebug.dayGroup() lists them with indices; "Sunny" is #0).
export const DEFAULT_DAY_GROUP: string | number = 'Sunny';

export interface Scene {
  name: string;
  /** ~fraction of day: 0.5 = noon, 0.0/1.0 = midnight, 0.25 dawn, 0.75 dusk. */
  timeOfDay?: number;
  weather?: boolean;
  /** CORE.17.r — sky day group to pin (DAT index or name, first match); default DEFAULT_DAY_GROUP. */
  dayGroup?: string | number;
  /** admin command to reposition before the shot (@telepoi / @teleloc). */
  teleport?: string;
  yaw?: number;
  /**
   * camera boom to zoom out to (default third-person); larger = more world in
   * frame. Applied as wheel notches (tools/lib/camera-pins.ts), so retail's
   * CAMERA_FAR_LIMIT caps it; ZOOM_FARTHEST = full zoom-out.
   */
  cameraDistance?: number;
  /** toolbar toggles to open over the live world. */
  toggles?: string[];
  /** arbitrary page JS run just before the shot. */
  evalJs?: string;
  /** page JS run after the shot to undo evalJs (CORE.17.g.a: un-maximize / drag back). */
  cleanupJs?: string;
  /**
   * HARNESS.scene-spawn-leak — weenie class ids this scene @creates in the
   * world. After the shot the capture tool deletes the objects of these
   * classes the scene added, plus every inventory item it added (@ci), and
   * after each teleport it sweeps leftovers of every declared class (dynamic
   * guids only). Without it a bookshelf or chest from one scene sat in later
   * scenes and differed between screen-regression sides.
   */
  spawns?: number[];
  /**
   * BUG.dungeon-light-pools-nondeterministic (2026-10-01) — screen-regression
   * captures (`--no-world` runs) of this scene hide the particle systems for
   * the instant of the world shot. Its DAT emitters are big animated mists
   * (0x32000406: a puff every 0.2 s growing 0.1 → 6 m while fading), so two
   * captures of identical code differed by ~27% and the scene came out
   * BROKEN every run. The scene checks dungeon geometry and lighting;
   * particles are covered by the side-by-side and portal-space captures.
   * Gameplay never sees this.
   */
  regressionHideParticles?: boolean;
  /** hold these keys down across the screenshot (motion frames). */
  holdKeys?: string[];
  settleMs?: number;
  /** full-screen retail references (reference/images/hud/). */
  refs: string[];
  notes: string;
}

export const HOLTBURG = '@telepoi holtburg';
// VISUAL.scorecard-world-town-framing — the spot AND heading the retail
// Holtburg frames were shot from (verification/retail-client/ab/retail-holtburg.png,
// verification/retail-ab/holtburg/retail.png): south of the lifestone facing
// north-ish, the lifestone left, the cottages and the oven ahead. `@telepoi
// holtburg` lands elsewhere, and its yaw 0 faced a hillside and yaw 1.2 the
// road, so the scorecard's world-at-spawn screen could not be judged
// like-for-like. The heading comes from the teleport quaternion: no `yaw`.
export const HOLTBURG_TOWN_SPOT = HOLTBURG_SPOT;
// CORE.17.o.d — a house interior with storage chests (world DB landblock_instance 1881145392: 0x02000146 at (53.66, -33.66, -5.67)).
export const STORAGE_HOUSE = '@teleloc 0x02000146 53.6645 -33.6611 -5.674';
// Interior cell proven reachable by tools/probe-interior-furniture.ts. ACE's
// @teleloc needs the full 'cell [x y z] qw qx qy qz' form — the bare cell id
// returned a usage line and every prior 'world-dungeon' capture was Holtburg
// (found by CORE.17.e).
export const DUNGEON = '@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0';
// CORE.17.q.c — the Holtburg Dungeon (0x01F6): the tan cobble set of the
// retail references rawg_04 / rawg_09 (wall 0x0800016f in 369 of its 429
// cells, beams 0x08000176, dark brick floor 0x0800016e; 157 lit stabs, none
// SeenOutside). The Academy cave above has no retail reference at all. The
// drop point is the portal's own Destination in the world DB
// (portalholtburgdungeon → 0x01F60289 (96.7, -10, 0) facing -0.719 0 0 -0.695).
export const DUNGEON_STONE = '@teleloc 0x01F60289 [96.7 -10 0] -0.719 0 0 -0.695';

/** CORE.17.h.b — make option 0x10000080 (Inactive Opacity) present at `value`, the way a server blob or a slider drag would. */
function chatInactiveOpacityPresentJs(value: number): string {
  return '(function(){var ui=window.__ac&&window.__ac.gameUI;if(!ui)return;'
    + `ui.optionsSettings.chatInactiveOpacity=${Math.round(value * 100)};ui.optionsSettings.chatInactiveOpacitySet=true;`
    + 'ui.applyChatOpacityFromOptions();})();';
}

/** CORE.17.h.b — activate the main chat entry (retail ActivateChatEntry @ 004f2f90 = Activate + TakeFocus). */
function chatEntryFocusJs(): string {
  return 'document.getElementById("chat-input")?.focus();';
}

/** CORE.17.h.b — deactivate the main chat entry (DeactivateChatEntry @ 004f2fc0 = RelinquishFocus + Deactivate). */
function chatEntryBlurJs(): string {
  return 'document.getElementById("chat-input")?.blur();';
}

/** CORE.17.h.b — type `text` into the focused entry and press Enter through the real keydown handler. */
function chatEntrySendJs(text: string): string {
  return `(function(){var i=document.getElementById("chat-input");if(!i)return;i.value=${JSON.stringify(text)};`
    + 'i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));})();';
}

/** CORE.17.h.a — switch the open Options panel to its Chat tab. */
function optionsChatTabJs(): string {
  return optionsTabJs('chat');
}

/** CORE.17.h.d — switch the open Options panel to the named tab (the DAT tab elements carry data-options-tab). */
function optionsTabJs(tab: 'gameplay' | 'character' | 'chat' | 'config'): string {
  return `document.querySelector('[data-options-tab="${tab}"]')?.dispatchEvent(new MouseEvent("click",{bubbles:true}));`;
}

/** VISUAL.options-rows-help-tooltips — after the tab settles, StartTooltipAtMouse (the instant path) on the options widget `sel`. */
function optionsHoverTooltipJs(sel: string): string {
  return `setTimeout(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return; el.scrollIntoView({ block: 'center' });`
    + ' const b = el.getBoundingClientRect(); window.__ac.gameUI.startHudTooltipAtMouse(el, b.left + Math.min(60, b.width / 2), b.top + b.height / 2); }, 2500);';
}

/** CORE.17.h.g — scroll the open options list to its end (the rows live in addPanelScrollbar's inner wrapper). */
function optionsListScrollToEndJs(): string {
  return '(function(){var s=document.querySelector(".options-separator");var inner=s&&s.parentElement;'
    + 'if(inner){inner.scrollTop=inner.scrollHeight;inner.dispatchEvent(new Event("scroll"));}})();';
}

/** CORE.17.h.a — mousedown on one Chat-tab opacity slider track at `fraction` of its width (the real drag handler). */
function chatOpacitySliderDragJs(label: string, fraction: number): string {
  return `(function(){var t=document.querySelector('[data-slider-label="${label}"]');if(!t)return;`
    + 'var r=t.getBoundingClientRect();'
    + `t.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true,clientX:r.left+r.width*${fraction},clientY:r.top+r.height/2}));`
    + 'document.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));})();';
}

/**
 * CORE.17.h.a — forget options 0x10000080/81 again (a fresh character carries
 * neither) and push that to the server, so later captures keep the main
 * window on gmMainChatUI's constructor 1.0/1.0 instead of a dragged value.
 */
function chatOpacityOptionsForgetJs(): string {
  return '(function(){var ui=window.__ac&&window.__ac.gameUI;if(!ui)return;'
    + 'ui.optionsSettings.chatInactiveOpacity=50;ui.optionsSettings.chatActiveOpacity=100;'
    + 'ui.optionsSettings.chatInactiveOpacitySet=false;ui.optionsSettings.chatActiveOpacitySet=false;'
    + 'ui.saveOptionsSettings();ui.markChatOptionsDirty();ui.flushChatOptionsSave();'
    + 'if(ui.optionsPanelVisible)ui.renderOptionsPanel();ui.applyChatOpacityFromOptions();})();';
}

/** Click the main chat maximize box (toggles; the same JS restores). Hoisted — SCENES above uses it. */
function chatMaximizeJs(): string {
  return 'document.querySelector(\'#hud-chat [data-element-id="0x1000046f"]\')?.dispatchEvent(new MouseEvent("click",{bubbles:true}));';
}

/** Synthetic mouse drag on one main-chat border element by (dx,dy) screen px. */
function chatDragJs(elementId: number, dx: number, dy: number): string {
  return `(function(){var el=document.querySelector('#hud-chat [data-element-id="0x${elementId.toString(16)}"]');if(!el)return;`
    + 'var r=el.getBoundingClientRect();var x=r.left+r.width/2,y=r.top+r.height/2;'
    + 'el.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true,clientX:x,clientY:y}));'
    + `document.dispatchEvent(new MouseEvent("mousemove",{bubbles:true,clientX:x+(${dx}),clientY:y+(${dy})}));`
    + `document.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,clientX:x+(${dx}),clientY:y+(${dy})}));})();`;
}

export const SCENES: Scene[] = [
  // The retail-holtburg.png frame has no recorded clock (llvmpipe, 2026-09-26),
  // so this stays at noon; the sky-timed comparison is the retail A/B scene
  // `holtburg` (same spot, mac-gpu retail frame, its sky pinned to the retail
  // frame's own server tick by tools/capture-retail-ab.ts: phase 0.805).
  { name: 'world-town-day', teleport: HOLTBURG_TOWN_SPOT, timeOfDay: 0.5, refs: ['rawg_07.jpg', 'rawg_08.jpg', 'gw_01.jpg'],
    notes: 'Holtburg town at noon from the retail A/B spot and heading (retail-client/ab/retail-holtburg.png frames the same lifestone, cottages and oven), no panels — the baseline "does this read as AC": terrain textures, building shapes/scale, sky, fog depth, character model + stance' },
  { name: 'world-town-day-alt', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 2.4, refs: ['rawg_08.jpg', 'shoushi-live.jpg', 'shoushi-live-2.jpg'],
    notes: 'same town, different heading — checks terrain/scenery variety and draw distance rather than one lucky angle' },
  { name: 'world-town-far', teleport: HOLTBURG_TOWN_SPOT, timeOfDay: 0.5, cameraDistance: ZOOM_FARTHEST, refs: ['shoushi-live.jpg', 'shoushi-live-2.jpg'],
    notes: 'the world-town-day view with the camera pulled back — the same town in frame, plus landscape silhouette, terrain LOD, draw distance, horizon/fog falloff' },
  { name: 'world-xarabydun-pit', teleport: '@telepoi xarabydun', timeOfDay: 0.5, refs: [],
    notes: 'VISUAL.landblock-statics-missing-vs-retail: the arrival stands on the pit rim (building 0x01002bef) above the dungeon entrance and its two torches (0x02000719); the building portal punch keeps the flat terrain off the pit (retail ref: verification/retail-ab/town-xarabydun/retail.png)' },
  { name: 'world-night', teleport: HOLTBURG, timeOfDay: 0.0, yaw: 0, refs: [],
    notes: 'night lighting — ambient level, sky, whether the world goes flat-black vs retail moonlit; light sources on buildings' },
  { name: 'world-dawn', teleport: HOLTBURG, timeOfDay: 0.25, yaw: 0, refs: ['gw_01.jpg'],
    notes: 'dawn transition — sky gradient + directional light colour through the day/night cycle (RegionDesc)' },
  // CORE.17.r — the rain domes are the Rainy groups' OWN sky objects: unless a
  // Rainy group is pinned this scene has no rain at all (the harness only
  // re-enabled the weather gate, and the rolled group was Rainy ~35% of runs).
  { name: 'world-weather', teleport: HOLTBURG, timeOfDay: 0.5, weather: true, dayGroup: 'Rainy', yaw: 0, settleMs: 6000, refs: ['rawg_11.jpg', 'gw_05.jpg'],
    notes: 'weather ON, a Rainy day group pinned — precipitation density/streak look, cloud layer, fog interaction (VISUAL.rain-streak-legibility is open against this)' },
  { name: 'world-dungeon', teleport: DUNGEON, timeOfDay: 0.5, settleMs: 9000, regressionHideParticles: true, refs: ['rawg_02.jpg', 'rawg_04.jpg', 'rawg_09.jpg'],
    notes: 'dungeon interior — EnvCell geometry, wall/floor textures, interior lighting falloff, portal-gated visibility' },
  { name: 'world-dungeon-stone', teleport: DUNGEON_STONE, timeOfDay: 0.5, yaw: 1.6, settleMs: 9000, refs: ['rawg_04.jpg', 'rawg_09.jpg'],
    notes: 'CORE.17.q.c — torch-lit tan cobble dungeon (Holtburg Dungeon), the set the retail refs show: interior light pools vs texel brightness, wood beams, wall torches; the scene for the CORE.17.q.a Gouraud A/B' },
  { name: 'world-dungeon-stone-night', teleport: DUNGEON_STONE, timeOfDay: 0.0, yaw: 1.6, settleMs: 9000, refs: ['rawg_04.jpg', 'rawg_09.jpg'],
    notes: 'CORE.17.q.c — the same drop point at midnight: what the sky ambient / sun contribute underground (a sealed dungeon should read the same as at noon unless the region lighting reaches in)' },
  { name: 'world-running', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, holdKeys: ['w'], settleMs: 1400, refs: ['rawg_07.jpg', 'rawg_08.jpg'],
    notes: 'MID-MOVEMENT frame — run animation, camera follow, terrain streaming seams; nothing else captures the player in motion' },
  { name: 'hud-idle-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, refs: ['rawg_07.jpg', 'rawg_08.jpg', 'reddit-shutdown.jpg'],
    notes: 'HUD composite over live world — vitals orbs, radar, compass, chat, toolbar: sizes, spacing, opacity and whether anything overlaps or crowds the world' },
  { name: 'hud-inventory-over-world', teleport: HOLTBURG, timeOfDay: 0.5, toggles: ['tb-inv'], refs: ['reddit-shutdown.jpg', 'inventory-panel.jpg'],
    notes: 'inventory open OVER gameplay — panel scale vs screen, does it overlap the bars below, is the world still legible beside it (CORE.1.b was exactly this class of defect)' },
  // CORE.17.o.a — an OPENABLE side pack's grid is a FIXED list of the pack's
  // own ItemsCapacity cells (ACE backpack 136: 24 = four rows of six), not
  // padding to the reflowed viewport. The scene gives the character a
  // backpack (@ci 136) when it has none and opens its tab.
  { name: 'hud-inventory-sidepack-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-inv'], settleMs: 12000,
    evalJs: `(() => {
      const ui = window.__ac.gameUI;
      const clickTab = () => {
        const strip = ui.inventoryPanelHandle && ui.inventoryPanelHandle.elements.get(0x100001ce);
        if (!strip) return;
        // the first side-pack slot: 36x36 at top 73 (makePackSlot(1, 73));
        // take the last match — the strip can carry a stale earlier render.
        const slots = [...strip.children].filter((d) => d.style.width === '36px' && d.style.height === '36px' && d.style.top === '73px');
        const slot = slots[slots.length - 1];
        if (slot) slot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      };
      if ((ui.sidePackGuids || []).length > 1) { clickTab(); return; }
      window.acDebug.sendChat('@ci 136');
      // SwiftShader round-trips run seconds long — poll for the pack's
      // CreateObject before opening its tab.
      let tries = 0;
      const poll = setInterval(() => {
        if ((ui.sidePackGuids || []).length > 1 || ++tries > 40) { clearInterval(poll); clickTab(); }
      }, 500);
    })()`,
    cleanupJs: "(function(){ var ui = window.__ac && window.__ac.gameUI; if (!ui) return; ui.selectedPackSlot = 0; if (ui.inventoryVisible) ui.renderInventoryPanel(); })()",
    refs: ['reddit-shutdown.jpg', 'inventory-panel.jpg'],
    notes: 'inventory open on a SIDE PACK tab OVER gameplay (CORE.17.o.a) — the pack grid is exactly the pack\'s ItemsCapacity (24 cells, four rows) with blank list region below, the open-pack arrow on the second strip slot; the rest of the HUD unchanged' },
  // RECON.inventory-grid-dat-cells — pack UIItems carry their toolbar
  // shortcut tag (UIElement_UIItem::SetShortcutNum: 0x0600109e+n, blank
  // 0x060074d3 for slots 10-18) and no stack count (only a vendor list sets a
  // UIItem's quantity). The scene makes a 500-pyreal stack, puts the first
  // (up to two) loose pack items on toolbar slots 1 and 11, and drags them
  // back off in cleanup (beginShortcutDrag → Event_RemoveShortCut).
  { name: 'hud-inventory-shortcut-tags-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-inv'], settleMs: 12000,
    evalJs: `(() => {
      const ui = window.__ac.gameUI;
      const cb = ui.itemShortcutCallbacks;
      const skip = () => new Set([...(ui.sidePackGuids || []), ...ui.equippedItems.map((e) => e.id)]);
      const loose = () => ui.inventoryItems.map((it, i) => ({ it, i })).filter(({ it }) => !skip().has(it.id) && !/^pyreal/i.test(it.name || ''));
      if (!ui.inventoryItems.some((it) => /^pyreal/i.test(it.name || '') && it.stackSize > 1)) window.acDebug.admin('@ci 273 500');
      let tries = 0;
      const poll = setInterval(() => {
        const l = loose();
        if (l.length >= 1 || ++tries > 16) {
          clearInterval(poll);
          if (l[0]) cb.onDropItem(0, { kind: 'inventory', itemIndex: l[0].i });
          if (l[1]) cb.onDropItem(10, { kind: 'inventory', itemIndex: l[1].i });
          if (ui.inventoryVisible) ui.renderInventoryPanel();
        }
      }, 500);
    })()`,
    cleanupJs: "(function(){ var ui = window.__ac && window.__ac.gameUI; if (!ui) return; var cb = ui.itemShortcutCallbacks; [0, 10].forEach(function(s){ cb.onBeginDrag(s); cb.onEndDrag(); }); })()",
    refs: ['retail-inventory-vendor.png', 'inventory-panel.jpg'],
    notes: 'inventory open OVER gameplay with loose pack items on toolbar slots 1 (and 11 when there is a second) — the cell carries the cream shortcut tag (a "1"; the blank tag for slot 11) in its top-left corner; the pyreal stack shows no count on its icon (retail-inventory-vendor.png: the 5,000-pyreal stack is bare); toolbar slots 1 and 11 show the items' },
  // RECON.dom-chrome-sweep.c — a selected 5000-pyreal stack: the toolbar's
  // split widgets (entry 0x100001a3 in its DAT font, right-justified; the
  // slider 0x100001a4) as retail-stack-selected.png shows them.
  { name: 'hud-toolbar-stack-selected-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 9000,
    evalJs: `(() => {
      const ui = window.__ac.gameUI;
      const stack = () => ui.inventoryItems.find((it) => /^pyreal/i.test(it.name || '') && it.stackSize > 1);
      if (!stack()) window.acDebug.admin('@ci 273 5000');
      let tries = 0;
      const poll = setInterval(() => {
        const s = stack();
        if (s || ++tries > 16) { clearInterval(poll); if (s) ui.selectInventoryItem(s); }
      }, 500);
    })()`,
    refs: ['retail-stack-selected.png'],
    notes: 'a pyreal stack selected (RECON.dom-chrome-sweep.c) — the toolbar names "N Pyreals (of N)", the entry box draws the count right-justified in the DAT UI font, the slider thumb at the right end; the rest of the HUD unchanged' },
  // CORE.17.o.b — the EXTERNAL container panel's list is sized like any
  // retail ItemList (ItemList_SetParentContainer -> ItemList_UpdateContainerListSize):
  // a container with ItemsCapacity >= 0 (ACE bookshelf 1115: 10) is a FIXED
  // list of exactly that many cells; -1 (chests / corpses) pads the visible
  // area. The scene spawns a bookshelf beside the character (@create 1115),
  // Uses it and waits for the ViewContents to open the panel.
  { name: 'hud-salvage-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-inv'], settleMs: 12000,
    evalJs: `(() => {
      const ui = window.__ac.gameUI;
      const idx = (pred) => { const it = ui.inventoryItems; for (let i = it.length - 1; i >= 0; i--) if (pred(it[i])) return i; return -1; };
      const isUst = (it) => ((it.itemType || 0) & 0x20000000) !== 0;
      const isLoot = (it) => /rusted dirk/i.test(it.name || '');
      if (idx(isUst) < 0) window.acDebug.admin('@ci 20646');
      if (idx(isLoot) < 0) window.acDebug.admin('@ci 23320');
      let tries = 0;
      const poll = setInterval(() => {
        const u = idx(isUst), l = idx(isLoot);
        if ((u >= 0 && l >= 0) || ++tries > 40) {
          clearInterval(poll);
          if (u < 0) return;
          ui.dragCallbacks.onDoubleClickItem(u);
          if (l < 0) return;
          ui.dragItemIndex = l; ui.dragSourceSlot = null;
          const list = ui.salvagePanel && ui.salvagePanel.querySelector('[data-element-id="0x10000074"]');
          if (list) list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
        }
      }, 500);
    })()`,
    cleanupJs: "(function(){ var ui = window.__ac && window.__ac.gameUI; if (ui && ui.isSalvageOpen) ui.hideSalvagePanel(); })()",
    refs: ['reddit-shutdown.jpg'],
    notes: 'the salvage panel (an Ust double-clicked, a rusted dirk queued) OVER gameplay — CORE.17.k.b.b.c.c.a.a.c.a.a: gmSalvageUI in the bottom transaction dock (0x2100006d:0x100005fb slot 0x1000005e, 610x120 centred 80 px above the bottom) drawn from layout 0x2100000c: the title "WARNING: Items in this panel will be destroyed!", ONE row of 32-px UIItem cells (the dirk + 14 empty tiles), the bar hidden, the Salvage button on its normal art, the close box; the dirk in the inventory grid carries the trade-state overlay; vitals / chat / toolbar uncovered' },
  // VISUAL.examine-panel-layout-2100001c — the EoL examine window
  // (gmFloatyExaminationUI 0x2100006b:0x100005f2, root HUD slot 0x100005f7)
  // left of the panels window: a pack item right-clicked (select + examine,
  // UIElement_ItemList action 8) shows the item page's one flowing appraisal
  // text + the inscription block.
  { name: 'hud-examine-item-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-inv'], settleMs: 9000,
    evalJs: `(() => {
      const cell = document.querySelector('[data-inv-slot="0"]');
      if (cell) cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    })()`,
    cleanupJs: "(function(){ var ui = window.__ac && window.__ac.gameUI; if (ui) ui.hideExaminePanel(); })()",
    refs: ['examine-bow.jpg', 'examine-helm.jpg'],
    notes: 'the examine window OVER gameplay beside the inventory — VISUAL.examine-panel-layout-2100001c: floaty 310x400 frame, title = the item name, the item page on the alpha-175 scrim: ONE text element (Value / Burden first, then the retail Appraisal_Show* lines), DAT scrollbar, the parchment inscription block (0x0600126f) with "<Inscribe here>" when inscribable. The refs are the older docked-era panel: judge wording/flow, not the leather art' },
  // The same window's character page: the nearest NPC selected, then E
  // (ExamineSelected) — header lines, "Character Level", stat rows over the
  // 3D model, armour lines.
  { name: 'hud-examine-npc-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 9000,
    evalJs: `(() => {
      const ac = window.__ac; const cs = window.acDebug.collisionState(); let best = null;
      for (const o of ac.serverObjectManager.objects.values()) {
        if (!(o.itemType & 0x10) || !o.mesh || !o.mesh.visible || (o.objectDescFlags & 0x8) || o.guid === ac.charGuid) continue;
        const d = Math.hypot(o.worldX - cs.x, o.worldZ - cs.z); if (!best || d < best.d) best = { guid: o.guid, d };
      }
      if (!best) return;
      window.acDebug.select(best.guid);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', code: 'KeyE', bubbles: true }));
    })()`,
    cleanupJs: "(function(){ var ui = window.__ac && window.__ac.gameUI; if (ui) ui.hideExaminePanel(); })()",
    refs: ['examine-npc.jpg'],
    notes: 'the examine window character page OVER gameplay — CharExamineUI (page 0x10000140, header panel 0x1000014f): "<Gender> <Heritage>" / title / "Non-Player Killer", the "Character Level" box, nine stat rows (template 0x10000166) over the 3D model (viewport 0x10000148), armour lines (template 0x10000337) + "* = Unenchantable"' },
  // CORE.17.k.b.b.c.c.a.a.c.a.b — the trade panel needs a second character
  // for a real negotiation (tools/capture-core17kbbccaaacab-trade-slot.ts
  // drives one with two clients); this single-client scene opens the panel
  // through acDebug.testTrade and stages two of the player's own pack items
  // on the player's list with the partner marked accepted, so the whole-screen
  // audit sees the slot's populated state over gameplay.
  { name: 'hud-trade-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 8000,
    evalJs: `(() => {
      const ui = window.__ac.gameUI;
      window.acDebug.testTrade();
      const mine = (ui.inventoryItems || []).slice(0, 2).map((it) => ({ name: it.name, value: it.value || 0, guid: it.id, burden: it.burden || 0, iconDid: it.iconDid || 0 }));
      ui.setTradeData({ yourItems: mine, theirItems: [], theirName: 'Og the Barbarian', yourName: '',
        partnerGuid: 0x50000002, initiatorGuid: 0x50000001, tradeStamp: 0, tradeStatus: 0, yourReady: false, theirReady: true });
    })()`,
    cleanupJs: "(function(){ var ui = window.__ac && window.__ac.gameUI; if (ui) ui.hideTradeWindow(); })()",
    refs: ['reddit-shutdown.jpg'],
    notes: 'the trade panel OVER gameplay — CORE.17.k.b.b.c.c.a.a.c.a.b: gmSecureTradeUI in the bottom transaction dock (0x2100006d:0x100005fb slot 0x1000005f, 610x120 centred 80 px above the bottom) drawn from layout 0x2100000d: the partner half LEFT (name, the accepted lamp lit 0x06004cba, "Total Items: 0", nine empty 32-px cells), the player half RIGHT ("You", the Trade toggle on 0x06004cbc, "Total Items: 2", two icons + seven empty cells), Clear All centred, the close box; vitals / chat / toolbar uncovered' },
  { name: 'hud-container-bookshelf-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 14000,
    evalJs: `(() => {
      const ac = window.__ac;
      const findShelf = () => {
        const all = ac.serverObjectManager && ac.serverObjectManager.getAllObjects();
        if (!all) return 0;
        for (const [guid, obj] of all) if (obj.weenieClassId === 1115) return guid;
        return 0;
      };
      const open = (guid) => { if (guid) window.acDebug.useObject(guid); };
      const existing = findShelf();
      if (existing) { open(existing); return; }
      window.acDebug.sendChat('@create 1115');
      let tries = 0;
      const poll = setInterval(() => {
        const guid = findShelf();
        if (guid || ++tries > 40) { clearInterval(poll); open(guid); }
      }, 500);
    })()`,
    cleanupJs: "(function(){ var ui = window.__ac && window.__ac.gameUI; if (ui && ui.isContainerOpen) ui.hideContainerPanel(); })()",
    spawns: [1115],
    refs: ['reddit-shutdown.jpg'],
    notes: 'an external container (ACE bookshelf 1115, ItemsCapacity 10) open OVER gameplay — CORE.17.o.c: retail\'s layout 0x21000008 (gmExternalContainerUI), the 110-px strip at y 400 spanning the display: the shelf\'s own icon cell top-left, the (empty) nested-container list beside it, the close box at the right edge, ONE 32-px item row of exactly the shelf\'s ten cells (CORE.17.o.b) as empty recessed tiles, its bar hidden while the row fits; no "Loot" title, no Take All; the chat / toolbar below untouched' },
  { name: 'hud-container-chest-stocked-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 26000,
    // CORE.17.o.c — a real chest (ACE 143: ItemsCapacity -1, ContainersCapacity
    // -1, no lock, no generator) STOCKED over the wire: apples, bread, arrows
    // and a sack are created in the inventory (@ci), the chest is created and
    // opened, then each is stored with one PutItemInContainer at a time
    // (retail's IsPlayerReadyToMakeInventoryRequest gate: the next request
    // goes out after the previous is answered), so the row fills from ACE's
    // CreateObject traffic and the sack lands in the nested-container list.
    // (The bookshelf 1115 refuses packs — ContainersCapacity 0 — and the
    // character's own starting items are attuned.)
    evalJs: `(() => {
      const ac = window.__ac;
      const findChest = () => {
        const all = ac.serverObjectManager && ac.serverObjectManager.getAllObjects();
        if (!all) return 0;
        // A chest @create'd at the player (dynamic guid), never one of the
        // landblock's own pre-placed chests off in the distance.
        for (const [guid, obj] of all) if (obj.weenieClassId === 143 && (guid >>> 0) >= 0x80000000) return guid;
        return 0;
      };
      const stock = () => {
        const ui = ac.gameUI;
        const all = ac.playerState.inventory.getAll();
        const wanted = [258, 259, 300, 166];
        const queue = wanted.map((w) => all.find((it) => it.weenieClassId === w)).filter(Boolean).map((it) => it.id);
        let i = 0;
        const step = () => {
          if (i >= queue.length) return;
          const guid = queue[i++];
          try { ui.containerCallbacks.onStoreItem(guid); } catch (e) { console.error('[scene] store failed', e); }
          setTimeout(step, 1500);
        };
        step();
      };
      const open = (guid) => {
        if (!guid) return;
        // A world double-click selects on its first click, then Uses
        // (retail's reference frame shows the chest selected: the toolbar
        // name + the VividTargetIndicator corners).
        window.acDebug.selectServerObject(guid);
        window.acDebug.useObject(guid);
        let tries = 0;
        const wait = setInterval(() => {
          if ((ac.gameUI && ac.gameUI.isContainerOpen) || ++tries > 30) { clearInterval(wait); setTimeout(stock, 1200); }
        }, 500);
      };
      for (const cmd of ['@ci 258 3', '@ci 259', '@ci 300 20', '@ci 166']) window.acDebug.sendChat(cmd);
      setTimeout(() => window.acDebug.sendChat('@create 143'), 1500);
      let tries = 0;
      const poll = setInterval(() => {
        const guid = findChest();
        if (guid || ++tries > 40) { clearInterval(poll); setTimeout(() => open(guid), 1000); }
      }, 500);
    })()`,
    cleanupJs: "(function(){ var ui = window.__ac && window.__ac.gameUI; if (ui && ui.isContainerOpen) ui.hideContainerPanel(); })()",
    spawns: [143],
    refs: ['reddit-shutdown.jpg'],
    notes: 'a live chest (ACE 143) STOCKED over the wire (CORE.17.o.c) — apples, bread, arrows in the row (stack counts) beside the chest\'s own cell; -1 capacity → the row padded to the display\'s cells; ACE refuses the sack ("The Sack can\'t be put in the container", error 0), so the nested-container list stays empty here — the seeded chest scene covers it; the strip otherwise as the shelf scene' },
  { name: 'hud-container-chest-contents-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0,
    evalJs: 'window.acDebug && window.acDebug.testContainer && window.acDebug.testContainer()',
    cleanupJs: "(function(){ var ui = window.__ac && window.__ac.gameUI; if (ui && ui.isContainerOpen) ui.hideContainerPanel(); })()",
    refs: ['reddit-shutdown.jpg'],
    notes: 'a seeded chest (-1 = visible-area padding, acDebug.testContainer) on the strip (CORE.17.o.c): eight occupied cells (stack counts on the pyreals / kits / apples) + empty tiles to the row\'s width, a nested Sack and a nested Pouch in the container list (CORE.17.o.d), the chest\'s own cell marked open; no Take All' },
  // CORE.17.o.d — the strip's open state on the live stack: ACE's Storage
  // 9687 (ItemsCapacity 26, ContainersCapacity 1) is the ONE ground
  // container ACE lets a pack into (Player_Inventory.cs:922). ACE refuses
  // to @create one ("You cannot spawn storage because it is a Storage"), so
  // the scenes teleport into a house that owns storage chests (world DB
  // landblock_instance 1881145392, cell 0x02000146) and open the nearest,
  // through the character's IgnoreHouseBarriers (PropertyBool 25, set in the
  // shard DB for Perf Tester — Storage.CheckUseRequirements). Four scenes on
  // one page: a sack stored while the storage's row is open (the ground marker
  // survives the nested list's refresh), the sack's cell clicked (the row
  // re-parents to it: its 24 cells, the marker moves), the OPEN sack taken
  // back (nothing re-parents the row — it keeps the sack's cells, no marker
  // anywhere: ItemList_Flush on the nested list), the ground cell clicked
  // (the storage's 26 cells and marker again).
  { name: 'hud-container-storage-pack-stored-over-world', teleport: STORAGE_HOUSE, timeOfDay: 0.5, yaw: 0, settleMs: 24000,
    evalJs: `(() => {
      const ac = window.__ac;
      const find = (wcid) => {
        const all = ac.serverObjectManager && ac.serverObjectManager.getAllObjects();
        if (!all) return 0;
        for (const [guid, obj] of all) if (obj.weenieClassId === wcid) return guid;
        return 0;
      };
      const store = () => {
        const sack = ac.playerState.inventory.getAll().find((it) => it.weenieClassId === 166);
        if (!sack) { console.error('[scene] no sack'); return; }
        try { ac.gameUI.containerCallbacks.onStoreItem(sack.id); } catch (e) { console.error('[scene] store failed', e); }
      };
      const open = (guid) => {
        if (!guid) { console.error('[scene] no storage'); return; }
        window.acDebug.useObject(guid);
        let tries = 0;
        const wait = setInterval(() => {
          if ((ac.gameUI && ac.gameUI.isContainerOpen) || ++tries > 30) { clearInterval(wait); setTimeout(store, 1500); }
        }, 500);
      };
      window.acDebug.sendChat('@ci 166');
      let tries = 0;
      const poll = setInterval(() => {
        const guid = find(9687);
        if (guid || ++tries > 40) { clearInterval(poll); setTimeout(() => open(guid), 1000); }
      }, 500);
    })()`,
    refs: ['reddit-shutdown.jpg'],
    notes: 'a live Storage (ACE 9687, 26 fixed cells) open on the strip with a Sack just stored into it (CORE.17.o.d): the sack in the nested-container list AND as an item in the storage\'s row; the storage\'s own cell keeps its open marker (the top list never refreshes — only the nested list flushes); the rest of the HUD as the other container scenes' },
  { name: 'hud-container-storage-pack-open-over-world', teleport: STORAGE_HOUSE, timeOfDay: 0.5, yaw: 0, settleMs: 2500,
    evalJs: `(() => { const c = document.querySelector('[data-element-id="0x10000067"] [data-ac-container-tab]'); if (c) c.dispatchEvent(new MouseEvent('click', { bubbles: true })); else console.error('[scene] no nested cell'); })()`,
    refs: ['reddit-shutdown.jpg'],
    notes: 'the stored Sack\'s cell clicked in the nested list (CORE.17.o.d, ListenToElementMessage message 7 on a container-list UIItem): the row re-parented to the sack — its 24 fixed cells (empty tiles) — and the ONE open marker moved from the storage\'s cell to the sack\'s (ItemList_SetParentList clears the other list)' },
  { name: 'hud-container-storage-open-pack-taken-over-world', teleport: STORAGE_HOUSE, timeOfDay: 0.5, yaw: 0, settleMs: 4000,
    evalJs: `(() => { const ui = window.__ac.gameUI; const sack = (ui.containerItems || []).find((it) => it.isContainer); if (!sack) { console.error('[scene] no stored sack'); return; } ui.containerCallbacks.onTakeItem(sack.guid); })()`,
    refs: ['reddit-shutdown.jpg'],
    notes: 'the OPEN sack taken back from the storage over the wire (CORE.17.o.d): nothing re-parents the row — it still shows the sack\'s 24 cells; the nested list is empty and NO cell carries the open marker (the nested list\'s refresh flushed its openItemID; the storage cell\'s was cleared when the sack opened). Pre-fix the row fell back to the storage\'s 26 cells with its marker' },
  { name: 'hud-container-storage-ground-cell-over-world', teleport: STORAGE_HOUSE, timeOfDay: 0.5, yaw: 0, settleMs: 2500,
    evalJs: `(() => { const c = document.querySelector('[data-element-id="0x10000064"] [data-ac-container-tab]'); if (c) c.dispatchEvent(new MouseEvent('click', { bubbles: true })); else console.error('[scene] no ground cell'); })()`,
    cleanupJs: "(function(){ var ui = window.__ac && window.__ac.gameUI; if (ui && ui.isContainerOpen) ui.hideContainerPanel(); })()",
    refs: ['reddit-shutdown.jpg'],
    notes: 'the storage\'s own cell clicked after the sack left (CORE.17.o.d): the row back on the storage — its 26 fixed cells — and the open marker on its cell again' },
  // CORE.17.o.d — two nested packs (the seeded chest: ACE's Storage takes
  // only one, ContainersCapacity 1): the Pouch open, then the Sack — the
  // FIRST nested pack — leaves: the row must stay the Pouch's (10 cells,
  // the Ruby) by GUID; pre-fix the index-tracked slot ran off the end and
  // fell back to the chest's row.
  { name: 'hud-container-seeded-other-pack-taken-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 2500,
    evalJs: `(() => {
      window.acDebug.testContainer();
      const cells = document.querySelectorAll('[data-element-id="0x10000067"] [data-ac-container-tab]');
      if (cells.length < 2) { console.error('[scene] expected two nested packs'); return; }
      cells[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const ui = window.__ac.gameUI;
      const items = ui.containerItems.filter((it) => it.guid !== 107 && it.containerId !== 107);
      ui.setContainerPackGuids([99999, 109]);
      ui.updateContainerItems(items);
    })()`,
    cleanupJs: "(function(){ var ui = window.__ac && window.__ac.gameUI; if (ui && ui.isContainerOpen) ui.hideContainerPanel(); })()",
    refs: ['reddit-shutdown.jpg'],
    notes: 'the seeded chest with the Pouch (second nested pack) open, after the Sack (first) left (CORE.17.o.d): the row stays the Pouch\'s — ten fixed cells, the Ruby — with no open marker (the nested list\'s refresh flushed it); pre-fix the index-tracked slot ran off the shortened list and the row fell back to the chest\'s contents with the chest marked' },
  { name: 'hud-character-over-world', teleport: HOLTBURG, timeOfDay: 0.5, toggles: ['tb-char'], refs: ['reddit-shutdown.jpg', 'character-panel-attributes.jpg'],
    notes: 'character panel (Attributes) open OVER gameplay — CORE.17.k.b.b.c: the level value 0x1000023b in its own 0x40000010 numeral font (cream, black halo) like reddit-shutdown.jpg\'s "240"; the pane\'s other labels, the tabs and the rest of the HUD unchanged' },
  { name: 'hud-map-over-world', teleport: HOLTBURG, timeOfDay: 0.5, toggles: ['tb-map'], evalJs: "window.__ac && window.__ac.gameUI && window.__ac.gameUI.setMapHousePosition && window.__ac.gameUI.setMapHousePosition(1, { cell: 0xA9B40001, x: 12, y: 12, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 })", refs: ['map-panel.jpg'],
    notes: 'map open OVER gameplay (CORE.17.k.b.b.a.g.d) — the player ring + the house icon on Holtburg, the coordinate line under the map (retail: outside only), the parchment vs the world beside it' },
  { name: 'hud-world-house-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-map'],
    evalJs: "window.__ac && window.__ac.gameUI && window.__ac.gameUI.openWorldPanelTab('house')",
    cleanupJs: "window.__ac && window.__ac.gameUI && window.__ac.gameUI.openWorldPanelTab('map')", refs: ['map-panel.jpg', 'reddit-shutdown.jpg'],
    notes: 'the World panel on its House page OVER gameplay (CORE.17.k.b.b.c.c.a) — the test character owns no house: gmHouseUI\'s listbox 0x21000025 on the dark leather with "You do not currently own a house." + the purchase-wait row, the House tab in 0xc / Map in 0xb; the rest of the HUD unchanged' },
  { name: 'hud-world-house-owned-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0,
    evalJs: 'window.acDebug && window.acDebug.testHousePage && window.acDebug.testHousePage()',
    cleanupJs: "(function(){ var ui = window.__ac && window.__ac.gameUI; if (!ui) return; ui.clearHouseData(); ui.openWorldPanelTab('map'); if (ui.mapPanelVisible) ui.toggleMapPanel(); })()", refs: ['map-panel.jpg', 'reddit-shutdown.jpg'],
    notes: 'the House page with a seeded owned cottage 5 days into an UNPAID period (acDebug.testHousePage) — the seven gmHouseUI rows: purchase price, Rent: paid/due, Bought:, the two maintenance dates, Location:, the yellow (RentNotPaid) warning, the purchase-wait row' },
  { name: 'hud-slumlord-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0,
    evalJs: 'window.acDebug && window.acDebug.testSlumlordPanel && window.acDebug.testSlumlordPanel(false, true)',
    cleanupJs: "window.__ac && window.__ac.gameUI && window.__ac.gameUI.hideSlumlordPanel()", refs: ['reddit-shutdown.jpg'],
    notes: 'the slumlord dialog OVER gameplay (CORE.17.k.b.b.c.c.a.a) — gmSlumlordUI\'s 800x110 bar 0x2100000e across the top of the 800x600 design space (its root is authored at (0,0)): the Buy tab open (0xc) / Maintenance (0xb), "38000 Pyreals, 5 Writs of Refuge" + "Owner: None", the six staged UIElement_UIItem cells in the 555x32 list, the Buy button lit; the vitals strip under it is what retail covers too; the rest of the HUD unchanged' },
  { name: 'hud-vendor-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-inv'], settleMs: 4000,
    evalJs: "(function(){ var d = window.acDebug; var ui = window.__ac && window.__ac.gameUI; if (!d || !ui) return; d.testVendor(); ui.vendorData.tab = 2; ui.renderVendorPanel(); })()",
    cleanupJs: "window.__ac && window.__ac.gameUI && window.__ac.gameUI.hideVendorWindow()", refs: ['reddit-shutdown.jpg'],
    notes: 'the vendor bar (0x21000012 in the transaction dock) on its Selling tab OVER gameplay with the inventory open (CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.a) — the sell list 0x100000ce the pack drags onto, the Selling value / purse lines, the Sell Item / Sell All buttons; the refusal / split notices land in the spew box above the chat; the rest of the HUD unchanged' },
  { name: 'hud-vendor-sell-state-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-inv'], settleMs: 4000,
    // RECON.inventory-grid-dat-cells.c — two loose pack items and one worn item on the sell list.
    evalJs: "(function(){ var d = window.acDebug; var ui = window.__ac && window.__ac.gameUI; if (!d || !ui) return; d.testVendor();"
      + " var pick = ui.inventoryItems.filter(function(it){ return !(it.itemsCapacity > 0); }).slice(0, 2).concat(ui.equippedItems.slice(0, 1));"
      + " ui.vendorData.sellItems = pick.map(function(it){ return { guid: it.id, weenieClassId: it.weenieClassId || 0, name: it.name, price: 10, burden: it.burden || 0, stackSize: it.stackSize || 1, itemType: it.itemType, iconDid: it.iconDid, iconOverlayDid: it.iconOverlayDid, iconUnderlayDid: it.iconUnderlayDid, uiEffects: it.uiEffects }; });"
      + " ui.vendorData.sellList = pick.map(function(it){ return { guid: it.id, qty: it.stackSize || 1 }; });"
      + " ui.vendorData.tab = 2; ui.renderVendorPanel(); ui.renderInventoryPanel(); })()",
    cleanupJs: "window.__ac && window.__ac.gameUI && window.__ac.gameUI.hideVendorWindow()", refs: ['retail-inventory-vendor.png'],
    notes: 'RECON.inventory-grid-dat-cells.c — the vendor bar on its Selling tab with the inventory open and two pack items plus one worn item listed: each of their UIItems (pack grid cell, paperdoll slot, sell-list cell) carries the sell-state badge 0x10000437 (0x060012d9, the small check tag in the top-left corner; UIItem_Update @ 004e21d0); the unlisted items stay bare' },
  { name: 'hud-spellbar-endowment-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 11000, refs: ['rawg_10.jpg', 'reddit-shutdown.jpg'],
    // CORE.17.k.b.b.a.g.e — a caster with a built-in spell wielded (the
    // Practice Wand 4799: spell 27) and magic mode: the endowment icon at the
    // bar's left, selected, "Practice Wand (Flame Bolt I)" in 0x1000048b.
    evalJs: `(() => {
      const ui = window.__ac.gameUI;
      const magic = () => { ui.hud.combatMode = 8; ui.updateSpellBarVisibility(); ui.refreshSpellBarPanel(); };
      const equip = () => { window.acDebug.equip('Practice Wand', 'Held'); setTimeout(magic, 3500); };
      if ((ui.inventoryItems || []).some((i) => i.name === 'Practice Wand') || window.acDebug.equipped().some((e) => e.name === 'Practice Wand')) equip();
      else { window.acDebug.sendChat('@ci 4799'); setTimeout(equip, 3500); }
    })()`,
    notes: 'magic mode with a caster wielded (CORE.17.k.b.b.a.g.e) — the endowment icon 0x100000b1 at the bar\'s left (the wand icon over the spell icon, the selected overlay), the "%s (%hs)" name field, the Cast button; nothing else on the HUD moves' },
  { name: 'hud-keyboard-config-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 2500, refs: ['options-config.jpg'],
    // CORE.17.k.b.b.a.g.f — Options → Configure Keyboard (layout 0x21000009)
    // on its Combat tab: the rows read the retail KeyMap DAT (End = Cast
    // Spell, Insert/Page Up = power, Delete/End/Page Down = attack height,
    // 1-9 = Spell Slot, 10-12 unbound, ` = Toggle Combat Mode).
    // CORE.17.k.b.b.a.g.f.a — the list is the retail UIElement_ListBox: the
    // Combat / Melee Combat / Missile Combat / Magic Combat header rows, 40 px
    // rows with the 100x32 Mapping buttons, the 16 px DAT scrollbar at x 570.
    evalJs: `(() => { const ui = window.__ac.gameUI; ui.toggleKeyboardConfigPanel(); ui.keyboardConfigTab = 4; ui.refreshKeyboardTabs(); })()`,
    notes: 'the 800x600 Keyboard Config modal over the world (CORE.17.k.b.b.a.g.f / .f.a) — centred, the six plain-label tabs, the Combat tab list: input-map header rows, 40 px command rows with the retail key names on the 100x32 Mapping buttons, the proportional DAT scrollbar, the bottom buttons; no retail screenshot of this dialog is in the corpus (options-config.jpg shows the Options panel that opens it)' },
  { name: 'hud-keyboard-config-ok-pressed-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 2500, refs: ['options-config.jpg'],
    // CORE.17.k.b.b.b — the same dialog with the OK button held down (a DOM
    // mousedown on 0x1000002c: UIElement_Button::UpdateState_ @ 00471cf0 →
    // normal_pressed 0x3, whose p33 outlines the label black while held) and
    // the first Mapping button of the list held down (the same 0x100002cd
    // family through buildDialogButton).
    // The dialog may still be open from the previous scene (toggle = close): open it only when absent.
    evalJs: `(() => { const ui = window.__ac.gameUI; if (!document.querySelector('[data-layout-id="0x21000009"]')) ui.toggleKeyboardConfigPanel(); ui.keyboardConfigTab = 1; ui.refreshKeyboardTabs();
      setTimeout(() => { for (const sel of ['[data-layout-id="0x21000009"] [data-element-id="0x1000002c"]', '[data-keybind-row="Move Forward"] [data-keybind-slot="0"]']) { const el = document.querySelector(sel); if (el) el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } }, 800); })()`,
    cleanupJs: `(() => { const ui = window.__ac.gameUI; if (document.querySelector('[data-layout-id="0x21000009"]')) ui.closeKeyboardConfigPanel(false); })()`,
    notes: 'the Keyboard Config modal with OK and the first Mapping button held down (CORE.17.k.b.b.b): the pressed plate art + the black p33 halo on both labels (state 0x3 of template 0x21000040:0x100002cd); everything else as hud-keyboard-config-over-world' },
  { name: 'hud-social-friends-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 2500, refs: ['friends-panel.jpg', 'reddit-shutdown.jpg'],
    // CORE.17.k.b.b.c.b — the social panel on its Friends tab (seeded list):
    // Add / Send Tell / Remove are 0x21000040:0x100002cd instances driven
    // through the DAT states (Send Tell / Remove ghosted 0xd with no
    // selection, Add ghosted until a name is typed), their labels and the
    // Friend / Status / Friend Name: headers white from their own descs.
    evalJs: `(() => { const ui = window.__ac.gameUI; ui.seedSocialTestData('friends'); ui.socialTab = 'friends'; if (!ui.socialPanelVisible) ui.toggleSocialPanel(); else ui.renderSocialPanel(); })()`,
    cleanupJs: `(() => { const ui = window.__ac.gameUI; if (ui.socialPanelVisible) ui.toggleSocialPanel(); })()`,
    notes: 'social panel Friends tab OVER gameplay (CORE.17.k.b.b.c.b) — white button labels on the ghosted / normal plates, white headers; the panel docked in the right column without touching the bars; the rest of the HUD unchanged' },
  { name: 'hud-contracts-journal-over-world', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 2500, refs: ['reddit-shutdown.jpg'],
    // CORE.17.k.b.b.c.b — the contracts panel on its Journal tab: the text
    // buttons (0x21000066:0x1000057e) green from the template, a disabled one
    // white (its 0xd), the paper labels black — no retail frame of the
    // journal is in the corpus.
    evalJs: `(() => { const ui = window.__ac.gameUI; ui.contractTab = 'journal'; if (!document.querySelector('[data-layout-id="0x21000063"]')) ui.toggleContractPanel(); else ui.renderContractPanel(); })()`,
    cleanupJs: `(() => { const ui = window.__ac.gameUI; if (document.querySelector('[data-layout-id="0x21000063"]')) ui.toggleContractPanel(); })()`,
    notes: 'contracts panel Journal tab OVER gameplay (CORE.17.k.b.b.c.b) — green text buttons with the dark-green outline, the disabled First / Last white, black paper labels; the rest of the HUD unchanged' },
  { name: 'hud-combat', teleport: HOLTBURG, timeOfDay: 0.5, evalJs: 'window.acDebug.combatMode && window.acDebug.combatMode("melee")', settleMs: 2500, refs: ['rawg_02.jpg', 'rawg_05.jpg', 'rawg_06.jpg'],
    notes: 'combat mode engaged — weapon drawn + combat stance, power/accuracy bar present and sized like retail, HUD state change' },
  { name: 'hud-chat-active', teleport: HOLTBURG, timeOfDay: 0.5, evalJs: 'window.acDebug.sendChat && window.acDebug.sendChat("Hello Dereth")', refs: ['chat-panel.jpg', 'reddit-shutdown.jpg'],
    notes: 'chat with real content — font, line spacing, colours per channel, window size/opacity against the retail chat panel' },
  // CORE.17.g.a — the main chat window's maximize box (0x1000046f) and
  // drag/resize borders are live: gmMainChatUI::HandleMaximizeButton @
  // 004cce50 grows the window by half the screen height (upward from the
  // bottom edge), the type-2 bar drags it and the type-9 grips resize it.
  { name: 'hud-chat-maximized', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0,
    evalJs: chatMaximizeJs(), cleanupJs: chatMaximizeJs(),
    refs: ['reddit-shutdown.jpg'],
    notes: 'main chat maximized via its DAT maximize box — bottom-left window grown up by screenH/2, box art 0x06005e64' },
  { name: 'hud-chat-moved-resized', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0,
    evalJs: chatDragJs(0x1000069c, 120, -140) + chatDragJs(0x100006a1, 160, 40),
    cleanupJs: chatDragJs(0x100006a1, -160, -40) + chatDragJs(0x1000069c, -120, 140),
    refs: ['reddit-shutdown.jpg'],
    notes: 'main chat dragged by its top bar and widened by the bottom-right grip — chrome/log/input reflow by DAT edges' },
  // CORE.17.g.b — the log text re-wraps at the new width on every resize
  // (UIElement_Text::ResizeTo @ 00467a30 dirties the whole element); the
  // narrowed state is where the old bake-at-append-time lines used to clip.
  { name: 'hud-chat-narrowed', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0,
    evalJs: chatDragJs(0x1000069e, 80, 0),
    cleanupJs: chatDragJs(0x1000069e, -80, 0),
    refs: ['reddit-shutdown.jpg'],
    notes: 'main chat narrowed by 80px via its left grip (410 -> 330 wide) — every log line re-wraps at the narrower width instead of clipping at the scrollbar column' },
  // CORE.17.h.a — the Chat Options opacity sliders are UIOption_Sliders bound
  // to gameplay options 0x10000080/81 (gmChatOptionsUI::InitOptions @
  // 0049fc60). With no PlayerModule option (a fresh character) each shows the
  // DAT GameplayOptionDefaults 0x78000001 value — Inactive 0.5, Active 1.0 —
  // and the pair is linked (OnOptionChanged @ 0049f5d0): Active dragged below
  // Inactive pulls Inactive down with it, both applying live.
  { name: 'hud-options-chat', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-opt'],
    evalJs: optionsChatTabJs(), refs: ['chat-options.jpg'],
    notes: 'Options panel Chat tab over the world — Inactive Opacity thumb at the DAT default midpoint (0.5), Active at Opaque (1.0); no PlayerModule option exists yet' },
  { name: 'hud-options-chat-active-lowered', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-opt'],
    evalJs: optionsChatTabJs() + chatOpacitySliderDragJs('Active Opacity', 0.3),
    cleanupJs: chatOpacityOptionsForgetJs(), refs: ['chat-options.jpg'],
    notes: 'Active Opacity dragged to 30% — the linked Inactive thumb follows it down and the main chat window (bottom-left) re-reads the options live, sitting at 0.3 over the world' },
  // CORE.17.h.d — the Config tab is the densest option page: every list
  // template of 0x2100002b at once (menu / checkbox+slider / toggle / slider
  // with captions / header + separator), so its whole-screen frame is the
  // side-by-side for the option widgets' own DAT art and row geometry.
  { name: 'hud-options-config', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-opt'],
    evalJs: optionsTabJs('config'), refs: ['options-config.jpg'],
    notes: 'Options panel Config tab over the world — UIOption_Slider gradient tracks + 7px widgets, right-justified label column ending at x 138, menu plate + arrow art, separator-before-header sections' },
  // CORE.17.h.g — the Config list is taller than its page (Degrade Distance +
  // the Rendering Quality / Input / UI sections follow Adaptive Degrade
  // Bias, gmConfigUI::InitOptions decomp :158684-158729); this frame shows
  // the list scrolled to its end.
  { name: 'hud-options-config-scrolled', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-opt'],
    evalJs: optionsTabJs('config') + optionsListScrollToEndJs(), refs: ['options-config.jpg'],
    notes: 'Options panel Config tab scrolled to the bottom — Degrade Distance, Rendering Quality Options (4 menus + 2 toggles), Input Options (bare sensitivity slider + 2 toggles), UI Options (2 font menus), closing rule' },
  // CORE.17.h.b — with an Inactive Opacity option present (0x10000080 = 0.5)
  // the main window sits at the inactive level until the entry is ACTIVATED
  // (ChatInterface::IsTextEntryFocused @ 004f30a0: chat root is the manager's
  // active element AND the entry is its focus descendant); Send with
  // stay-in-chat off relinquishes + deactivates the entry (HandleEnterKey @
  // 004f52d0) and the window fades back to the inactive level.
  { name: 'hud-chat-inactive-opacity-idle', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0,
    evalJs: chatInactiveOpacityPresentJs(0.5) + chatEntryBlurJs(),
    cleanupJs: chatOpacityOptionsForgetJs(), refs: ['reddit-shutdown.jpg'],
    notes: 'Inactive Opacity option present at 0.5, nothing activated — main chat (bottom-left) at the inactive level over the world' },
  { name: 'hud-chat-inactive-opacity-entry-active', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0,
    evalJs: chatInactiveOpacityPresentJs(0.5) + chatEntryFocusJs(),
    cleanupJs: chatEntryBlurJs() + chatOpacityOptionsForgetJs(), refs: ['reddit-shutdown.jpg'],
    notes: 'same option, chat entry activated (Activate + TakeFocus) — the window is at the ACTIVE level (1.0), fully opaque like the retail frames' },
  { name: 'hud-chat-inactive-opacity-after-send', teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0,
    evalJs: chatInactiveOpacityPresentJs(0.5) + chatEntryFocusJs() + chatEntrySendJs('Hello Dereth'),
    cleanupJs: chatOpacityOptionsForgetJs(), refs: ['reddit-shutdown.jpg'],
    notes: 'same option, a message sent with Stay-in-chat-mode OFF — HandleEnterKey relinquished + deactivated the entry, so the window is back at the inactive level' },
];

// ── SIDE-BY-SIDE scenes (tools/sidebyside.ts) ────────────────────────────
//
// DEBT.tools-sprawl: ~60 per-task `capture-*-sidebyside.ts` scripts each
// re-implemented "log in, open a panel, capture ours, crop a retail
// reference, compose an HTML sheet". One row here replaces a new script:
//   npx tsx tools/sidebyside.ts --scene <name> [--tag before|after]
// A world row names a SCENES entry above for its frame (teleport, pinned
// time / day group, toggles, page JS, cleanup) or carries the same pins
// inline; a pre-world row names the character-select / chargen page.

/** A crop box in an image's own pixels. */
export interface CropBox { x: number; y: number; w: number; h: number }

/** One retail reference cell. */
export interface SideBySideRef {
  /** repo-relative path (reference/images/…, docs/images/…). */
  file: string;
  /** omitted → the whole image. */
  crop?: CropBox;
  label: string;
}

/** Scene pins for a world row that has no SCENES entry of its own (same meaning as Scene's fields). */
export type SideBySidePins = Partial<Pick<Scene, 'teleport' | 'timeOfDay' | 'weather' | 'dayGroup' | 'yaw' | 'cameraDistance' | 'toggles' | 'evalJs' | 'cleanupJs' | 'holdKeys' | 'settleMs'>>;

export interface SideBySideScene {
  name: string;
  title: string;
  stage: 'world' | 'charselect' | 'chargen';
  /** world: the SCENES entry whose pins set the frame. */
  worldScene?: string;
  /** world: inline pins, merged OVER the worldScene's. */
  pins?: SideBySidePins;
  /** chargen: wizard page, 0 heritage · 1 profession · 2 skills · 3 appearance · 4 town · 5 summary. */
  chargenPage?: number;
  /**
   * Our crop: a CSS selector or a page expression yielding the element (its
   * live bounding box, `pad` px around it); `box` is the fallback in the
   * 1568x775 capture when the element is missing; `letterbox` crops the
   * 800x600 pre-world design space out of the letterboxed frame. None of
   * them → the whole frame.
   */
  ours: { element?: string; pad?: number; box?: CropBox; letterbox?: boolean };
  refs: SideBySideRef[];
  /** crop magnification (default 2). */
  zoom?: number;
  /** scale every crop to our crop's height instead of a common zoom (pre-world: 800x600 refs vs a 1.29x letterbox). */
  matchHeight?: boolean;
  notes?: string;
}

const WINE_HOLTBURG = 'docs/images/retail-client-wine-inworld-holtburg.png';
/** Multi-line text the edit-field rows type (two paragraphs, one long enough to wrap). */
const TYPED_NOTES = 'Holtburg notes:\nBuy scarabs and taper from the shopkeeper, then head north to the Glenden Wood portal.';
const REDDIT = 'reference/images/hud/reddit-shutdown.jpg';
const WINE_LABEL = 'retail EoL client under Wine (1024x768, Holtburg 42.1N 33.6E)';
const REDDIT_LABEL = 'retail 1920x1080 (reddit-shutdown, Jan 2017)';
// VISUAL.options-panel-eol-window — the options panel opens in the EoL panels
// window (310x372 riding the toolbar), the inventory / character panels' rect.
const OPTIONS_BOX: CropBox = { x: 1290, y: 428, w: 310, h: 372 };

export const SIDE_BY_SIDE_SCENES: SideBySideScene[] = [
  // VISUAL.lifestone-crystal-glow — the retail A/B spot (tools/retail-ab-scenes.ts
  // HOLTBURG_SPOT) at the retail frame's day phase: the crystal (surface
  // 0x080011DE, luminosity 0.75) against verification/retail-ab/holtburg.
  { name: 'lifestone-holtburg', title: 'Holtburg lifestone from the A/B spot: crystal 0x080011DE (luminosity 0.75) — retail | ours', stage: 'world',
    pins: { teleport: '@teleloc 0xA9B40019 [84.3 5.0 94] 0.9969 0 0 -0.0785', timeOfDay: 0.46, settleMs: 4000 },
    ours: {}, zoom: 1, matchHeight: true,
    refs: [{ file: 'verification/retail-ab/holtburg/retail.png', label: 'retail EoL client under Wine (A/B spot, phase ~0.46, 2026-10-02)' }] },
  { name: 'lifestone-holtburg-night', title: 'Holtburg lifestone from the A/B spot at night (phase 0.994) — retail | ours', stage: 'world',
    pins: { teleport: '@teleloc 0xA9B40019 [84.3 5.0 94] 0.9969 0 0 -0.0785', timeOfDay: 0.994, dayGroup: 'Sunny', settleMs: 4000 },
    ours: {}, zoom: 1, matchHeight: true,
    refs: [{ file: 'verification/night-sky/retail-before-after-0.994-x3.png', crop: { x: 0, y: 0, w: 1600, h: 300 }, label: 'retail at phase 0.994, brightened x3 (top row of the night-sky sheet)' }] },
  // VISUAL.scorecard-world-town-framing — the scorecard's world-at-spawn
  // screen, like-for-like: world-town-day from the retail A/B spot against
  // both retail Holtburg frames (llvmpipe 2026-09-26 HUD/placement; mac-gpu
  // 2026-10-04 lighting, sky phase 0.805 by its server tick).
  { name: 'world-town-day', title: 'World at spawn: Holtburg from the retail A/B spot — retail | ours', stage: 'world', worldScene: 'world-town-day',
    // past a 0x1a notice's 5 s life (gmSpewBoxUI): the teleport's notice sat behind the vitals bar at 2.5 s
    pins: { settleMs: 6000 },
    ours: {}, zoom: 1, matchHeight: true,
    refs: [
      { file: 'verification/retail-client/ab/retail-holtburg.png', label: 'retail EoL client under Wine, llvmpipe (A/B spot, 2026-09-26)' },
      { file: 'verification/retail-ab/holtburg/retail.png', label: 'retail EoL client under Wine, mac-gpu (A/B spot, phase 0.805, 2026-10-04)' },
    ],
    notes: 'ours is pinned to noon (Sunny); the retail frames carry their own server clock, so sky colour is judged on the retail-ab holtburg scene' },
  { name: 'world-xarabydun-pit', title: 'Xarabydun arrival: the dungeon pit, its entrance and torches — retail | ours', stage: 'world', worldScene: 'world-xarabydun-pit',
    ours: {}, zoom: 1, matchHeight: true,
    refs: [{ file: 'verification/retail-ab/town-xarabydun/retail.png', label: 'retail EoL client under Wine (@telepoi Xarabydun, 2026-10-02 world tour)' }],
    notes: 'VISUAL.landblock-statics-missing-vs-retail — PortalPunch.ts + outdoorGround.ts' },
  { name: 'portal-space', title: 'Portal space (gmSmartBoxUI portal-space viewport, game FOV) — retail | ours', stage: 'world', worldScene: 'hud-idle-over-world',
    pins: { evalJs: 'window.__ac.gameUI.showPortalSpace()', cleanupJs: 'window.__ac.gameUI.hidePortalSpace()', settleMs: 2600 },
    ours: {}, zoom: 1, matchHeight: true,
    refs: [{ file: 'reference/images/preworld/portal-space-ref1.jpg', label: 'portal-space-ref1.jpg — retail EoL video frame (1280x720)' }],
    notes: 'VISUAL.portal-space-retail: the literal retail viewport — Setup 0x02000306 + Animation 0x030005AC from the PostInit camera (docs/portal-space-rebuild-2026-06-12.md, 2026-09-27 correction)' },
  { name: 'portal-space-hud', title: 'In-world teleport: tunnel under the HUD (3D-view layer 0x2100000f) — retail | ours', stage: 'world', worldScene: 'hud-idle-over-world',
    pins: { evalJs: 'window.__ac.gameUI.showPortalSpace()', cleanupJs: 'window.__ac.gameUI.hidePortalSpace()', settleMs: 2600 },
    ours: {}, zoom: 1, matchHeight: true,
    refs: [{ file: 'verification/bug-spew-under-vitals/retail-portal-2.png', label: 'retail EoL client under Wine, @telepoi mid-tunnel (1600x900)' }],
    notes: 'BUG.portal-tunnel-hides-hud: vitals, radar, chat, toolbar and the spew strip paint over the tunnel' },
  { name: 'container-open', title: 'Open chest: strip 0x21000008 + the selection (toolbar name, VividTargetIndicator corners 0x2100000f:0x10000038) — retail | ours', stage: 'world', worldScene: 'hud-container-chest-stocked-over-world',
    ours: {}, zoom: 1, matchHeight: true,
    refs: [{ file: 'verification/retail-client/ab/retail-container-open.png', label: 'retail EoL client under Wine: @create 143 at the Holtburg spawn, double-click Use (1600x900)' }],
    notes: 'VISUAL.container-open-selected-name: the chest stays selected after Use — "Chest" in the toolbar readout and the four selection wedges around its selection sphere' },
  { name: 'examine-npc', title: 'Examine window, character page (CharExamineUI, 3D model viewport 0x10000148) — retail | ours', stage: 'world', worldScene: 'hud-examine-npc-over-world',
    ours: { element: 'window.__ac.gameUI.examinePanel', box: { x: 948, y: 304, w: 310, h: 400 } }, zoom: 1, matchHeight: true,
    refs: [
      { file: 'verification/retail-client/ab/retail-examine-npc.png', crop: { x: 979, y: 426, w: 314, h: 396 }, label: 'retail EoL client under Wine (same account, Alcott at Holtburg, 1600x900)' },
      { file: 'reference/images/hud/examine-npc.jpg', label: 'examine-npc.jpg — older docked-era panel (judge the model behind the rows, header and rows; not the frame)' },
    ],
    notes: 'VISUAL.examine-creature-portrait-blank(.a): BasicCreatureExamineUI::Init draws the examined creature (heading 191.3679, DISTANT_LIGHT 2.0, whole-body bbox fit); the viewport owns its UIObject (attr 0xcd) so it draws OVER the stat rows\' scrims' },
  { name: 'inventory', title: 'Inventory panel (0x21000024 paperdoll + pack grid) — retail | ours', stage: 'world', worldScene: 'hud-inventory-over-world',
    ours: { element: 'window.__ac.gameUI.inventoryPanel', box: { x: 1266, y: 140, w: 302, h: 535 } }, zoom: 2,
    refs: [
      { file: 'verification/retail-client/ab/retail-inventory-vendor.png', crop: { x: 1292, y: 430, w: 304, h: 368 }, label: 'retail EoL client under Wine (same account + character, 1600x900)' },
      { file: 'reference/images/hud/inventory-panel.jpg', label: 'inventory-panel.jpg — ToD-era slot chrome (wrong era for the chrome; valid for figure framing + slot positions)' },
    ],
    notes: 'ported from tools/archive/capture-core17-inventory-sidebyside.ts (CORE.17.l-.p); EoL Wine ref added for VISUAL.paperdoll-slots-gem-state' },
  { name: 'inventory-shortcut-tags', title: 'Inventory pack grid UIItems: shortcut tags, no stack counts — retail | ours', stage: 'world', worldScene: 'hud-inventory-shortcut-tags-over-world',
    ours: { element: 'window.__ac.gameUI.inventoryPanel', box: { x: 1266, y: 140, w: 302, h: 535 } }, zoom: 2,
    refs: [
      { file: 'verification/retail-client/ab/retail-inventory-vendor.png', crop: { x: 1292, y: 430, w: 304, h: 368 }, label: 'retail EoL client under Wine (1600x900): the 5,000-pyreal stack carries no count' },
    ],
    notes: 'RECON.inventory-grid-dat-cells — UIElement_UIItem overlays 0x21000037:0x10000346 (SetShortcutNum tag, UpdateQuantityDisplay vendor-only)' },
  { name: 'toolbar-stack-selected', title: 'Toolbar selected stack: split entry + slider — retail | ours', stage: 'world', worldScene: 'hud-toolbar-stack-selected-over-world',
    ours: { element: 'window.__ac.gameUI.targetPanel', pad: 24 }, zoom: 3,
    refs: [
      { file: 'verification/retail-client/ab/retail-stack-selected.png', crop: { x: 1340, y: 812, w: 200, h: 56 }, label: 'retail EoL client under Wine (1600x900): a 5000-Pyreal stack selected, "5000" right-justified in the entry' },
    ],
    notes: 'RECON.dom-chrome-sweep.c — entry 0x21000016:0x100001a3 (base 0x2100003f:0x10000376: font 0x40000000, white, p20 3, p36 2)' },
  { name: 'inventory-sell-state', title: 'Pack grid / paperdoll UIItems on the sell list: the 0x10000437 badge — retail | ours', stage: 'world', worldScene: 'hud-vendor-sell-state-over-world',
    ours: { element: 'window.__ac.gameUI.inventoryPanel', box: { x: 1266, y: 140, w: 302, h: 535 } }, zoom: 2,
    refs: [
      { file: 'verification/retail-client/ab/retail-inventory-vendor.png', crop: { x: 1292, y: 430, w: 304, h: 368 }, label: 'retail EoL client under Wine (1600x900), vendor open, nothing listed: the bare cells' },
    ],
    notes: 'RECON.inventory-grid-dat-cells.c — UIItem_Update @ 004e21d0 m_elem_Icon_SellState; no retail frame shows a listed item, so the badge art is judged against the DAT (0x060012d9 at overlays 0x10000346 child 0x10000437, 32x32 at (0,0))' },
  { name: 'character', title: 'Character panel, Attributes (0x2100002e in the panels window) — retail | ours', stage: 'world', worldScene: 'hud-character-over-world',
    ours: { element: 'window.__ac.gameUI.charPanel', box: { x: 1290, y: 428, w: 310, h: 372 } }, zoom: 2,
    refs: [
      { file: 'verification/retail-client/ab/retail-options-gameplay.png', crop: { x: 1290, y: 428, w: 310, h: 372 }, label: 'retail EoL client under Wine: the same panels window (options page) — body = one 0x06004cc2 scrim over the world' },
      { file: 'reference/images/hud/character-panel-attributes.jpg', label: 'character-panel-attributes.jpg — classic-era stone body (wrong era for the body; valid for rows, header, footer)' },
    ],
    notes: 'VISUAL.char-panel-body-too-bright(.a): the body is the panels-window scrim over the live world (not leather), and the panel opens in the panels window itself — 310x372 riding the toolbar in the 5 px 0x060074bf-c6 frame, the inventory\'s rect' },
  { name: 'social', title: 'Social panel, Friends (0x21000031) — retail | ours', stage: 'world', worldScene: 'hud-social-friends-over-world',
    ours: { element: 'window.__ac.gameUI.socialPanel' }, zoom: 2,
    refs: [
      { file: 'verification/social-wells/retail-friends.png', crop: { x: 250, y: 8, w: 310, h: 372 }, label: 'retail EoL client under Wine, Friends tab: body = one 0x06004cc2 scrim, list + Friend Name field = two' },
      { file: 'reference/images/hud/friends-panel.jpg', label: 'friends-panel.jpg — classic-skin stone body (wrong era for the body; valid for layout, labels, rows)' },
    ],
    notes: 'VISUAL.char-panel-body-too-bright.c/.a.a/.c.a: the panel opens in the panels window (slot 0x1000018f); the window root\'s one 0x06004cc2 scrim is the body (no pane copy, no 0x0600114d leather); the list 0x10000517 and name field 0x1000051b keep their own scrim (a darker well)' },
  { name: 'social-fellowship', title: 'Social panel, Fellowship tab (0x21000031 pane 0x10000292), no fellowship — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, evalJs: `(() => { const ui = window.__ac.gameUI; ui.socialTab = 'fellowship'; if (!ui.socialPanelVisible) ui.toggleSocialPanel(); else ui.renderSocialPanel(); })()` },
    ours: { element: 'window.__ac.gameUI.socialPanel' }, zoom: 2,
    refs: [{ file: 'verification/social-wells/retail-fellowship.png', crop: { x: 250, y: 8, w: 310, h: 372 }, label: 'retail EoL client under Wine, Fellowship tab, no fellowship: the Fellowship Name field 0x1000026f reads two scrim layers' }],
    notes: 'VISUAL.char-panel-body-too-bright.c.a: the Fellowship Name field keeps its own 0x06004cc2 (a darker well over the one-layer body)' },
  { name: 'social-fellowship-members', title: 'Social panel, Fellowship tab with members (0x21000030 row template 0x10000281) — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, evalJs: `(() => { const ui = window.__ac.gameUI; ui.seedSocialTestData('fellowship'); ui.socialTab = 'fellowship'; if (!ui.socialPanelVisible) ui.toggleSocialPanel(); else ui.renderSocialPanel(); })()`,
      cleanupJs: `(() => { const ui = window.__ac.gameUI; ui.seedSocialTestData('clear'); if (ui.socialPanelVisible) ui.toggleSocialPanel(); })()` },
    ours: { element: 'window.__ac.gameUI.socialPanel' }, zoom: 2,
    refs: [{ file: 'reference/images/hud/fellowship-panel-2.jpg', label: 'fellowship-panel-2.jpg — classic-skin era (valid for the row grammar: white name + LVL/XP, three Cur/Max bars, scrollbar drawn with few fellows)' }],
    notes: 'RECON.social-rows-dat-templates: member rows from template 0x10000281 (white 0x40000000 name / LVL/XP / bar readouts, no halo); the list scrollbar 0x1000027a (p121 = false) drawn with the parked full-track thumb' },
  { name: 'social-squelch', title: 'Social panel, Squelch tab (0x21000060 row template 0x10000541) — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, evalJs: `(() => { const ui = window.__ac.gameUI; ui.seedSocialTestData('squelch'); ui.socialTab = 'squelch'; if (!ui.socialPanelVisible) ui.toggleSocialPanel(); else ui.renderSocialPanel(); })()`,
      cleanupJs: `(() => { const ui = window.__ac.gameUI; ui.seedSocialTestData('clear'); if (ui.socialPanelVisible) ui.toggleSocialPanel(); })()` },
    ours: { element: 'window.__ac.gameUI.socialPanel' }, zoom: 2,
    refs: [],
    notes: 'RECON.social-rows-dat-templates: rows from template 0x10000541 (font 0x40000001; Type pale yellow Character / red Account per state). No retail frame of the squelch tab in the corpus' },
  { name: 'social-allegiance', title: 'Social panel, Allegiance tab (0x21000031 pane 0x10000291), nothing selected — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, evalJs: `(() => { const ui = window.__ac.gameUI; ui.hudState.target = null; ui.socialTab = 'allegiance'; if (!ui.socialPanelVisible) ui.toggleSocialPanel(); else ui.renderSocialPanel(); ui.updateHUD(); })()` },
    ours: { element: 'window.__ac.gameUI.socialPanel' }, zoom: 2,
    refs: [{ file: 'reference/images/hud/allegiance-panel.jpg', label: 'allegiance-panel.jpg — EoL skin, no allegiance, no target: Swear / Break / Kick all dark' }],
    notes: 'VISUAL.allegiance-swear-enabled-without-target: Swear stays disabled (state 0xd) until a selected non-self player outside the allegiance exists (UpdateSwearButton @ 004908e0)' },
  { name: 'dungeon-sconces', title: 'Holtburg Dungeon stone hall (0x01F6) — lit sconces / braziers — retail | ours', stage: 'world', worldScene: 'world-dungeon-stone',
    ours: {}, zoom: 1, matchHeight: true,
    refs: [
      { file: 'reference/images/hud/rawg_04.jpg', label: 'rawg_04.jpg — retail dungeon, lit wall braziers' },
      { file: 'reference/images/hud/rawg_09.jpg', label: 'rawg_09.jpg — retail dungeon corridor' },
    ],
    notes: 'VISUAL.dat-static-default-scripts: every sconce 0x020001eb plays its Setup DefaultScript 0x3300000b (flame 0x3200002f + glow 0x32000141)' },
  { name: 'holtburg-smoke', title: 'Holtburg spawn view — the domed oven smoke (static DefaultScript) — retail | ours', stage: 'world', worldScene: 'hud-idle-over-world',
    // Facing north like the retail frame (its radar has N up; yaw 0 faces south).
    pins: { yaw: Math.PI, settleMs: 8000 },
    ours: {}, zoom: 1, matchHeight: true,
    refs: [{ file: 'verification/retail-client/ab/retail-options-gameplay.png', label: 'retail EoL client under Wine — smoke rising from the Holtburg oven' }],
    notes: 'VISUAL.dat-static-default-scripts: landblock statics run their Setup DefaultScript (smoke, lamp glows)' },
  { name: 'chat', title: 'Main chat window (0x2100006f) — retail | ours', stage: 'world', worldScene: 'hud-idle-over-world',
    ours: { element: '#hud-chat', box: { x: 0, y: 670, w: 430, h: 105 } }, zoom: 3,
    refs: [{ file: WINE_HOLTBURG, crop: { x: 0, y: 660, w: 430, h: 108 }, label: WINE_LABEL }, { file: REDDIT, crop: { x: 0, y: 975, w: 430, h: 105 }, label: REDDIT_LABEL }],
    notes: 'ported from tools/archive/capture-core17g/h-chat-sidebyside.ts' },
  { name: 'options-gameplay', title: 'Options panel, Gameplay tab (0x2100002b) — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-opt'], evalJs: optionsTabJs('gameplay') },
    ours: { element: 'window.__ac.gameUI.optionsPanel', box: OPTIONS_BOX }, zoom: 2,
    refs: [
      { file: 'verification/retail-client/ab/retail-options-gameplay.png', crop: { x: 1290, y: 428, w: 310, h: 372 }, label: 'retail EoL client under Wine (1600x900): the panels window, Gameplay Options page' },
      { file: 'reference/images/hud/options-gameplay.jpg', label: 'options-gameplay.jpg — pre-EoL (six buttons, "Leave World"; wrong era for the page)' },
    ],
    notes: 'VISUAL.options-panel-eol-window: the panel opens in the panels window over the toolbar, one 0x06004cc2 scrim over the world, and the Gameplay page is 0x2100002a itself (blue gold-edged 0x060074a7-af buttons in three groups)' },
  { name: 'options-chat', title: 'Options panel, Chat tab — retail | ours', stage: 'world', worldScene: 'hud-options-chat',
    ours: { element: 'window.__ac.gameUI.optionsPanel', box: OPTIONS_BOX }, zoom: 2,
    refs: [{ file: 'reference/images/hud/chat-options.jpg', label: 'retail Chat tab (chat-options.jpg)' }],
    notes: 'ported from tools/archive/capture-core3d-sidebyside.ts' },
  { name: 'options-config', title: 'Options panel, Config tab — retail | ours', stage: 'world', worldScene: 'hud-options-config',
    ours: { element: 'window.__ac.gameUI.optionsPanel', box: OPTIONS_BOX }, zoom: 2,
    refs: [{ file: 'reference/images/hud/options-config.jpg', crop: { x: 0, y: 0, w: 300, h: 520 }, label: 'retail Config tab (options-config.jpg)' }],
    notes: 'ported from tools/archive/capture-core17hd/he/hf/hg/hgd-options-sidebyside.ts' },
  { name: 'spellbook', title: 'Magic panel, Spellbook tab (0x21000032) — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-magic'], settleMs: 9000 },
    ours: { element: 'window.__ac.gameUI.magicPanel', box: { x: 1290, y: 428, w: 310, h: 372 } }, zoom: 2,
    refs: [
      { file: 'verification/retail-client/ab/retail-options-gameplay.png', crop: { x: 1290, y: 428, w: 310, h: 372 }, label: 'retail EoL client under Wine: a docked panel body = one 0x06004cc2 scrim over the world' },
      { file: 'reference/images/hud/spellbook-panel.jpg', label: 'retail Spellbook tab (spellbook-panel.jpg; classic skin: valid for layout, not the body)' },
    ],
    notes: 'VISUAL.char-panel-body-too-bright.a.a: the spellbook opens in the panels window (slot 0x10000190) over the toolbar, one 0x06004cc2 scrim (the window root\'s) over the world' },
  { name: 'map', title: 'World panel, Map tab (0x21000027 in the panels window) — retail | ours', stage: 'world', worldScene: 'hud-map-over-world',
    ours: { element: 'window.__ac.gameUI.mapPanel', box: { x: 1258, y: 303, w: 310, h: 372 } }, zoom: 2,
    refs: [
      { file: 'verification/retail-client/ab/retail-options-gameplay.png', crop: { x: 1290, y: 428, w: 310, h: 372 }, label: 'retail EoL client under Wine: the panels window rect + scrim' },
      { file: 'reference/images/hud/map-panel.jpg', label: 'retail Map tab (map-panel.jpg)' },
    ],
    notes: 'VISUAL.char-panel-body-too-bright.a.a: the World panel is slot 0x1000018c of the panels window; the map block (T3/B3) centres in the 362 px body' },
  { name: 'effects-positive', title: 'Beneficial Spells in Effect (0x2100001b:0x1000011f in the panels window) — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 2500,
      evalJs: `(() => { const ui = window.__ac.gameUI; const add = (spellId, name, duration) => ui.addEnchantment({ spellId, layer: 1, name, iconId: 0, isBeneficial: true, isVitae: false, isCooldown: false, duration, startTime: 0, casterGuid: 0 }); add(2, 'Strength Self I', 1800); add(18, 'Armor Self I', 1800); add(1328, 'Sneak Attack Mastery Self I', 1800); if (!ui.isEffectsPanelVisible('positive')) ui.togglePositiveEffectsPanel(); })()`,
      cleanupJs: `(() => { const ui = window.__ac.gameUI; if (ui.isEffectsPanelVisible('positive')) ui.togglePositiveEffectsPanel(); })()` },
    ours: { element: 'window.__ac.gameUI.effectsWindows.positive.root', box: { x: 1290, y: 428, w: 310, h: 372 } }, zoom: 2,
    refs: [
      { file: 'verification/retail-client/ab/retail-options-gameplay.png', crop: { x: 1290, y: 428, w: 310, h: 372 }, label: 'retail EoL client under Wine: the panels window rect, 5 px frame + scrim (options page)' },
      { file: 'reference/images/hud/beneficial-spells.jpg', label: 'beneficial-spells.jpg — retail Beneficial Spells window (rows, title, info block)' },
    ],
    notes: 'VISUAL.char-panel-body-too-bright.a.b: the effects windows are slots 0x10000184 / 0x10000185 of the panels window, so they open in its 5 px 0x060074bf-c6 frame at the inventory\'s rect' },
  { name: 'vitae', title: 'Vitae panel (0x21000020 in the panels window) — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 2500,
      evalJs: `(() => { const ui = window.__ac.gameUI; if (!ui.vitaePanelSource) ui.vitaePanelSource = () => ({ vitaePenalty: 0.05, vitaeCpPool: 120, deathLevel: 5, level: 5 }); if (!ui.vitaePanelVisible) ui.toggleVitaePanel(); })()`,
      cleanupJs: `(() => { const ui = window.__ac.gameUI; if (ui.vitaePanelVisible) ui.toggleVitaePanel(); })()` },
    ours: { element: 'window.__ac.gameUI.vitaePanel', box: { x: 1290, y: 428, w: 310, h: 372 } }, zoom: 2,
    refs: [
      { file: 'verification/retail-client/ab/retail-options-gameplay.png', crop: { x: 1290, y: 428, w: 310, h: 372 }, label: 'retail EoL client under Wine: the panels window rect, 5 px frame + scrim (no retail vitae frame yet)' },
    ],
    notes: 'VISUAL.char-panel-body-too-bright.a.a.a: gmVitaeUI is slot 0x1000018a of the panels window (0x10000049: hands the slot back)' },
  { name: 'link-status', title: 'Link Status panel (0x2100001d in the panels window) — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 2500,
      evalJs: `(() => { const ui = window.__ac.gameUI; if (!ui.isLinkStatusPanelOpen()) ui.toggleLinkStatusPanel(); })()`,
      cleanupJs: `(() => { const ui = window.__ac.gameUI; if (ui.isLinkStatusPanelOpen()) ui.toggleLinkStatusPanel(); })()` },
    ours: { element: 'window.__ac.gameUI.linkStatusPanel', box: { x: 1290, y: 428, w: 310, h: 372 } }, zoom: 2,
    refs: [
      { file: 'verification/retail-client/ab/retail-options-gameplay.png', crop: { x: 1290, y: 428, w: 310, h: 372 }, label: 'retail EoL client under Wine: the panels window rect, 5 px frame + scrim' },
      { file: 'reference/images/hud/link-status.jpg', label: 'link-status.jpg — retail Link Status panel' },
    ],
    notes: 'VISUAL.char-panel-body-too-bright.a.a.a: gmLinkStatusUI is slot 0x10000187 of the panels window' },
  { name: 'mini-game', title: 'Mini-game panel (0x2100001e in the panels window) — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 2500,
      evalJs: `(() => { const ui = window.__ac.gameUI; if (!ui.isMiniGamePanelOpen()) ui.toggleMiniGamePanel(); })()`,
      cleanupJs: `(() => { const ui = window.__ac.gameUI; if (ui.isMiniGamePanelOpen()) ui.toggleMiniGamePanel(); })()` },
    ours: { element: 'window.__ac.gameUI.miniGamePanelHandle.root.parentElement', box: { x: 1290, y: 428, w: 310, h: 372 } }, zoom: 2,
    refs: [
      { file: 'reference/images/hud/game-center-chess.jpg', label: 'game-center-chess.jpg — retail chess panel' },
    ],
    notes: 'VISUAL.char-panel-body-too-bright.a.a.a: gmMiniGameUI is slot 0x10000188 of the panels window' },
  { name: 'contracts', title: 'Contracts panel (0x21000063 in the panels window) — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-journal'], settleMs: 9000 },
    ours: { element: 'window.__ac.gameUI.contractPanel', box: { x: 1258, y: 303, w: 310, h: 372 } }, zoom: 2,
    refs: [
      { file: 'verification/social-wells/retail-contracts.png', crop: { x: 250, y: 4, w: 310, h: 372 }, label: 'retail EoL client under Wine: Contracts tab, no contracts (bare well, scrollbar drawn)' },
      { file: 'verification/retail-client/ab/retail-options-gameplay.png', crop: { x: 1290, y: 428, w: 310, h: 372 }, label: 'retail EoL client under Wine: the panels window rect + scrim' },
    ],
    notes: 'VISUAL.char-panel-body-too-bright.a.a: slot 0x10000559 of the panels window; the pane draws no scrim or leather of its own. VISUAL.contracts-empty-list-invented-text: empty list is a bare well with the p121=false scrollbar drawn' },
  // RECON.dom-chrome-sweep.a — the multi-line edit fields typed into: the
  // DAT font + p27 colour wrapped into GlyphList lines, the 1-px caret on
  // its glyph line (the blink is pinned during captures).
  { name: 'journal-notes-typed', title: 'Journal notes 0x1000056d typed (multi-line DatEditField) — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-journal'], settleMs: 9000,
      evalJs: `(() => { const ui = window.__ac.gameUI; ui.contractTab = 'journal'; ui.renderContractPanel();
        setTimeout(() => { const ta = document.querySelector('textarea.journal-notes-input'); if (!ta) return;
          ta.focus(); ta.value = ${JSON.stringify(TYPED_NOTES)}; ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.setSelectionRange(14, 14); ta.dispatchEvent(new Event('select')); }, 800); })()` },
    ours: { element: 'window.__ac.gameUI.contractPanel', box: { x: 1258, y: 303, w: 310, h: 372 } }, zoom: 2,
    refs: [
      { file: 'verification/social-wells/retail-contracts.png', crop: { x: 250, y: 4, w: 310, h: 372 }, label: 'retail EoL client under Wine: Contracts tab (the panels window the journal shares)' },
    ],
    notes: 'RECON.dom-chrome-sweep.a: the notes draw the desc font (0x2100003f:0x10000377 p26) in its p27 ink, wrapped by Recalculate; the DAT scrollbar 0x1000056e (p121 false) stays drawn. No retail frame of typed journal notes exists: judge font/colour against the DAT, layout against the Wine frame' },
  { name: 'book-editor-typed', title: 'Book page editor 0x10000111 typed (multi-line DatEditField) — ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, settleMs: 6000,
      evalJs: `(() => { const ui = window.__ac.gameUI;
        ui.openBook(0x7f000001, 3, [{ authorId: 0, authorName: '', textIncluded: true, ignoreAuthor: true, pageText: ${JSON.stringify(TYPED_NOTES)} }], '', 0, '');
        setTimeout(() => { const ta = document.querySelector('textarea.ac-book-editor'); if (!ta) return;
          ta.focus(); ta.setSelectionRange(20, 31); ta.dispatchEvent(new Event('select')); }, 800); })()`,
      cleanupJs: `(() => { const ui = window.__ac.gameUI; const h = ui.bookPanelHandle; if (h) h.close(); })()` },
    ours: { element: 'window.__ac.gameUI.bookPanelHandle && window.__ac.gameUI.bookPanelHandle.root.parentElement', box: { x: 1258, y: 303, w: 310, h: 372 } }, zoom: 2,
    refs: [
      { file: 'verification/ui-fidelity-2026-10-04/w-5-book-page-1.png', label: 'ours 2026-10-04: the read-only page (DAT text cell) the editor must match' },
    ],
    notes: 'RECON.dom-chrome-sweep.a: the editable page draws the same desc font/colour as the read-only page (base 0x2100003f:0x10000389, p36 = 4), wrapped by Recalculate, a selection inverted across the glyph line' },
  { name: 'toolbar', title: 'Toolbar window (0x21000016) — retail | ours', stage: 'world', worldScene: 'hud-idle-over-world',
    ours: { element: '#hud-toolbar-window', box: { x: 1254, y: 673, w: 314, h: 102 } }, zoom: 3,
    refs: [{ file: WINE_HOLTBURG, crop: { x: 714, y: 668, w: 310, h: 100 }, label: WINE_LABEL }, { file: REDDIT, crop: { x: 1606, y: 978, w: 314, h: 102 }, label: REDDIT_LABEL }],
    notes: 'ported from tools/archive/capture-core17c-toolbar-sidebyside.ts' },
  { name: 'spew-strip', title: 'Spew strip (gmSpewBoxUI, 0x2100000f pane at y 20) under the stacked vitals plate — retail | ours', stage: 'world', worldScene: 'hud-idle-over-world',
    // The row's teleport pin lands in portal space first; post the notice once the HUD is back (the item lives 5 s).
    pins: { evalJs: "setTimeout(() => window.__ac.gameUI.displayErrorText('You must specify the text you wish to say!'), 9000)", settleMs: 10000 },
    ours: { element: '#hud-spew-box', pad: 24 }, zoom: 2,
    refs: [{ file: 'verification/bug-spew-under-vitals/retail-reply-short.png', crop: { x: 551, y: 0, w: 498, h: 96 },
      label: 'retail EoL client under Wine, @reply with no text (1600x900, 2026-09-28)' }],
    notes: 'BUG.spew-newest-line-under-vitals: the newest (row 0) line draws behind the vitals plate in retail too; retail text is yellow #FEFE00 (BUG.spew-text-color-yellow-in-retail)' },
  { name: 'chat-reply-error', title: 'Main chat after typing "@reply" with no text: the red 0x1a line in the log + the spew strip — retail | ours', stage: 'world', worldScene: 'hud-idle-over-world',
    // Types into the real #chat-input and presses Enter, so the line goes through main.ts's DoReply-equivalent and the command-source routing.
    pins: { evalJs: "setTimeout(() => { const i = document.getElementById('chat-input'); i.focus(); i.value = '@reply'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }, 9000)", settleMs: 10500 },
    ours: { element: '#hud-chat', box: { x: 0, y: 670, w: 430, h: 105 } }, zoom: 2,
    refs: [{ file: 'verification/bug-spew-under-vitals/retail-reply-short.png', crop: { x: 0, y: 800, w: 410, h: 100 },
      label: 'retail EoL client under Wine, @reply with no text (1600x900, 2026-09-28)' }],
    notes: 'BUG.main-chat-shows-error-lines-in-retail: DoReply targets m_idCurrentCommandSource, so the 0x1a line shows in the typing window despite Errors off' },
  { name: 'combat-melee', title: 'Melee combat mode: power bar + combat HUD over the world — retail | ours', stage: 'world', worldScene: 'hud-combat',
    ours: { box: { x: 470, y: 576, w: 628, h: 110 } }, zoom: 2,
    refs: [{ file: 'verification/retail-client/ab/retail-combat-melee.png', crop: { x: 486, y: 692, w: 628, h: 110 },
      label: 'retail EoR client under Wine, Tab/` combat toggle, unarmed (1600x900, 2026-09-28)' }],
    notes: 'first retail combat-mode frame (scorecard flow-combat); the self-selection hover label in the retail frame is from the welcome-popup dismiss click' },
  { name: 'combat-bar-tooltip', title: 'Combat bar checkbox hover tooltip (gmCombatUI SetTooltip ID_PlayerOption_*_Help) — retail | ours', stage: 'world', worldScene: 'hud-combat',
    // hud-combat's melee pin (inline pins replace its evalJs), then StartTooltipAtMouse on "Repeat Attacks" (the instant path; tools/archive/probe-combat-bar-tooltips.ts drives the real 0.25 s hover).
    pins: { evalJs: "window.acDebug.combatMode('melee'); setTimeout(() => { const el = document.querySelector('[data-option-key=\"repeatAttacks\"]'); const b = el.getBoundingClientRect(); window.__ac.gameUI.startHudTooltipAtMouse(el, b.left + b.width / 2, b.top + b.height / 2); }, 2800)", settleMs: 3600 },
    ours: { box: { x: 470, y: 576, w: 628, h: 160 } }, zoom: 2,
    refs: [
      { file: 'verification/retail-client/ab/retail-combat-melee.png', crop: { x: 486, y: 692, w: 628, h: 110 },
        label: 'retail EoR client under Wine, combat bar (1600x900, 2026-09-28) — checkbox rows, no hover' },
      { file: 'reference/images/hud/item-stack-tooltip.jpg', label: 'retail in-game tooltip chrome (0x21000041 root 0x10000395)' },
    ],
    notes: 'VISUAL.combat-bar-checkbox-tooltips: 0x23000003 help text in the HUD tooltip root at mouse + 32; no retail frame of this exact hover exists' },
  // VISUAL.options-rows-help-tooltips — an Options row's help tooltip (SetToggleLabel / UIOption::SetTooltip), instant StartTooltipAtMouse on the widget.
  { name: 'options-character-tooltip', title: 'Options Character row hover tooltip (SetToggleLabel ID_PlayerOption_*_Help) — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-opt'], settleMs: 3600,
      evalJs: optionsTabJs('character') + optionsHoverTooltipJs('.option-toggle-row[data-option-key="sideBySideVitals"]') },
    ours: { box: { x: 1000, y: 380, w: 600, h: 440 } }, zoom: 2,
    refs: [
      { file: 'reference/images/hud/options-character.jpg', label: 'retail Character tab (options-character.jpg) — rows, no hover' },
      { file: 'reference/images/hud/item-stack-tooltip.jpg', label: 'retail in-game tooltip chrome (0x21000041)' },
    ],
    notes: 'VISUAL.options-rows-help-tooltips: the Side-by-Side Vitals row shows its 0x23000003 help in the 0x10000397 tooltip root at mouse + 32; no retail frame of this exact hover exists' },
  { name: 'options-config-tooltip', title: 'Options Config slider hover tooltip (AttachPreference help → UIOption::SetTooltip) — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-opt'], settleMs: 3600,
      evalJs: optionsTabJs('config') + optionsHoverTooltipJs('[data-option-key="cameraStiffness"] [data-slider-label]') },
    ours: { box: { x: 1000, y: 380, w: 600, h: 440 } }, zoom: 2,
    refs: [
      { file: 'reference/images/hud/options-config.jpg', crop: { x: 0, y: 0, w: 300, h: 520 }, label: 'retail Config tab (options-config.jpg) — rows, no hover' },
      { file: 'reference/images/hud/item-stack-tooltip.jpg', label: 'retail in-game tooltip chrome (0x21000041)' },
    ],
    notes: 'VISUAL.options-rows-help-tooltips: the Camera Stiffness slider shows ID_Camera_Stiffness_Help; the row label carries no tooltip' },
  { name: 'options-chat-tooltip', title: 'Options Chat channel hover tooltip (AddChild ID_ChatOption_TextFilter_*_Desc) — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-opt'], settleMs: 3600,
      evalJs: optionsTabJs('chat') + optionsHoverTooltipJs('.option-toggle-row[data-option-key="chatMainWindowCombat"]') },
    ours: { box: { x: 1000, y: 380, w: 600, h: 440 } }, zoom: 2,
    refs: [
      { file: 'reference/images/hud/chat-options.jpg', label: 'retail Chat tab (chat-options.jpg) — rows, no hover' },
      { file: 'reference/images/hud/item-stack-tooltip.jpg', label: 'retail in-game tooltip chrome (0x21000041)' },
    ],
    notes: 'VISUAL.options-rows-help-tooltips.a: the Main Chat Window Combat row shows ID_ChatOption_TextFilter_Combat_Desc (0x2300000d) in the 0x10000397 root; no retail frame of this exact hover exists' },
  { name: 'options-chat-slider-tooltip', title: 'Options Chat opacity slider hover tooltip (GameplayOptionList 0xd5) — retail | ours', stage: 'world',
    pins: { teleport: HOLTBURG, timeOfDay: 0.5, yaw: 0, toggles: ['tb-opt'], settleMs: 3600,
      evalJs: optionsTabJs('chat') + optionsHoverTooltipJs('[data-option-key="chatInactiveOpacity"] [data-slider-label]') },
    ours: { box: { x: 1000, y: 380, w: 600, h: 440 } }, zoom: 2,
    refs: [
      { file: 'reference/images/hud/chat-options.jpg', label: 'retail Chat tab (chat-options.jpg) — rows, no hover' },
      { file: 'reference/images/hud/item-stack-tooltip.jpg', label: 'retail in-game tooltip chrome (0x21000041)' },
    ],
    notes: 'VISUAL.options-rows-help-tooltips.a: the Inactive Opacity slider shows its gameplay-option 0xd5 tooltip (241731587 in 0x2300000d)' },
  { name: 'radar', title: 'Radar disc (gmRadarUI) — retail | ours', stage: 'world', worldScene: 'hud-idle-over-world',
    ours: { element: '#hud-radar' }, zoom: 4,
    refs: [
      { file: WINE_HOLTBURG, crop: { x: 904, y: 0, w: 120, h: 120 }, label: WINE_LABEL },
      { file: 'reference/images/hud/rawg_07.jpg', crop: { x: 680, y: 30, w: 118, h: 118 }, label: 'retail rawg_07.jpg (800x600)' },
      { file: REDDIT, crop: { x: 1612, y: 8, w: 128, h: 128 }, label: REDDIT_LABEL },
    ],
    notes: 'ported from tools/archive/capture-core17d-radar-sidebyside.ts (its blip-size pixel checks are an assertion, not a sheet, and are not ported)' },
  { name: 'vitals', title: 'Vitals strip (health / stamina / mana) — retail | ours', stage: 'world', worldScene: 'hud-idle-over-world',
    ours: { element: '#hud-vitals', pad: 2 }, zoom: 3,
    refs: [{ file: WINE_HOLTBURG, crop: { x: 432, y: 0, w: 160, h: 58 }, label: WINE_LABEL }, { file: 'reference/images/hud/status-panels.png', label: 'retail status-panels.png' }] },
  { name: 'vendor', title: 'Vendor bar (0x21000012, Selling tab) over the world — retail | ours', stage: 'world', worldScene: 'hud-vendor-over-world',
    ours: { element: 'window.__ac.gameUI.vendorWrapper', pad: 4 }, zoom: 2,
    refs: [{ file: 'verification/retail-client/ab/retail-vendor-selling.png', crop: { x: 490, y: 696, w: 620, h: 128 },
      label: 'retail EoR client under Wine, Shopkeeper Selling tab (1600x900, 2026-09-26)' }],
    notes: 'retail ref from the GAP.retail-client-reference-frames A/B set (scorecard flow-vendor); ported from tools/archive/capture-core17kbbccaaacaaaaaa-vendor-sell-drag.ts' },
  { name: 'char-select', title: 'Character select (0x21000004) — retail | ours', stage: 'charselect',
    ours: { letterbox: true }, zoom: 1, matchHeight: true,
    refs: [{ file: 'docs/images/retail-client-wine-charselect.png', label: 'retail EoL client under Wine (800x600)' }],
    notes: 'ported from tools/archive/capture-core17kbba-preworld-sidebyside.ts' },
  { name: 'chargen-heritage', title: 'Character creation — Heritage page — retail | ours', stage: 'chargen', chargenPage: 0,
    ours: { letterbox: true }, zoom: 1, matchHeight: true,
    refs: [{ file: 'reference/images/preworld/char-create-ref1.png', label: 'retail EoL heritage page (char-create-ref1.png)' }, { file: 'reference/images/preworld/char-create-race-ref1.webp', label: 'retail (char-create-race-ref1.webp)' }] },
  { name: 'chargen-profession', title: 'Character creation — Profession page — retail | ours', stage: 'chargen', chargenPage: 1,
    ours: { letterbox: true }, zoom: 1, matchHeight: true,
    refs: [{ file: 'reference/images/preworld/char-create-step2-ref1.webp', label: 'retail EoL profession page (char-create-step2-ref1.webp)' }] },
  { name: 'chargen-skills', title: 'Character creation — Skills page — retail | ours', stage: 'chargen', chargenPage: 2,
    ours: { letterbox: true }, zoom: 1, matchHeight: true,
    refs: [{ file: 'reference/images/preworld/char-create-step3-ref1.webp', label: 'retail EoL skills page (char-create-step3-ref1.webp)' }] },
  { name: 'chargen-skills-selected', title: 'Character creation — Skills page, first row selected — retail | ours', stage: 'chargen', chargenPage: 2,
    pins: { evalJs: "(() => { const c = document.querySelector('.chargen-skill-row .chargen-skill-cell'); if (!c) return 'no row'; c.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'ok'; })()", settleMs: 800 },
    ours: { letterbox: true }, zoom: 1, matchHeight: true,
    refs: [{ file: 'verification/retail-ab/chargen-skills/retail.png', label: 'retail EoR client, Skills page, nothing selected (retail-ab 2026-10-02)' }],
    notes: 'VISUAL.chargen-skills-list-rows.a: the selected row draws white (0x100002fe state 6) and the box 0x100003fa shows ShowSkillsText; no retail frame of a selected row is on file' },
  { name: 'chargen-skills-scrolled', title: 'Character creation — Skills page, down arrow clicked 8 times — retail | ours', stage: 'chargen', chargenPage: 2,
    pins: { evalJs: "(() => { const b = document.querySelector('.chargen-skill-scrollbar [data-dat-scroll-btn=\"down\"]'); if (!b) return 'no button'; for (let i = 0; i < 8; i++) b.click(); const l = document.querySelector('.chargen-skill-listbox'); return 'scrollTop ' + (l ? l.scrollTop : -1); })()", settleMs: 800 },
    ours: { letterbox: true }, zoom: 1, matchHeight: true,
    refs: [{ file: 'reference/images/preworld/char-create-step3-ref1.webp', label: 'retail EoL skills page, unscrolled (char-create-step3-ref1.webp)' }],
    notes: 'VISUAL.chargen-skills-list-rows.b: the 0x100003f8 gem tracks the list (UIElement_ListBox::InqScrollDelta steps one row per click); no retail frame of a scrolled list is on file' },
  { name: 'chargen-heritage-scrolled', title: 'Character creation — Heritage page, lore down arrow clicked 10 times — retail | ours', stage: 'chargen', chargenPage: 0,
    pins: { evalJs: "(() => { const b = document.querySelector('.ac-dat-frame-scrollbar [data-dat-scroll-btn=\"down\"]'); if (!b) return 'no button'; for (let i = 0; i < 10; i++) b.click(); const l = document.querySelector('.heritage-lore'); return 'scrollTop ' + (l ? l.scrollTop : -1); })()", settleMs: 800 },
    ours: { letterbox: true }, zoom: 1, matchHeight: true,
    refs: [{ file: 'reference/images/preworld/char-create-ref1.png', label: 'retail EoL heritage page, lore unscrolled (char-create-ref1.png)' }],
    notes: 'VISUAL.chargen-skills-list-rows.b.a: the 0x100002e7 gem tracks the lore text (UIElement_Text::InqScrollDelta steps one glyph line per click); no retail frame of scrolled lore is on file' },
  { name: 'chargen-appearance', title: 'Character creation — Appearance page — ours', stage: 'chargen', chargenPage: 3,
    ours: { letterbox: true }, zoom: 1, matchHeight: true, refs: [], notes: 'no retail appearance-page reference on file' },
  { name: 'chargen-town', title: 'Character creation — Town page — ours', stage: 'chargen', chargenPage: 4,
    ours: { letterbox: true }, zoom: 1, matchHeight: true, refs: [], notes: 'no retail town-page reference on file' },
  { name: 'chargen-summary', title: 'Character creation — Summary page — ours', stage: 'chargen', chargenPage: 5,
    ours: { letterbox: true }, zoom: 1, matchHeight: true,
    refs: [{ file: 'verification/retail-ab/chargen-summary/retail.png', label: 'retail EoR client, Summary page on open: the name prompt focused and selected whole (retail-ab)' }],
    notes: 'RECON.dom-chrome-sweep.b.a: gmCGSummaryPage::Update TakeFocus + SelectAll — "[ Name ]" drawn inverted on open; the figure / stats differ by the random roll' },
  { name: 'chargen-summary-name-typed', title: 'Character creation — Summary name field, "Asheron Wolfhound" typed, caret at the end — retail | ours', stage: 'chargen', chargenPage: 5,
    pins: { evalJs: "(() => { const i = document.getElementById('char-name-input'); if (!i) return 'no field'; i.focus(); i.value = 'Asheron Wolfhound'; i.dispatchEvent(new Event('input', { bubbles: true })); i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new KeyboardEvent('keyup')); return 'caret ' + (document.querySelector('.summary-name-box .ac-dat-edit-layer')?.dataset.acCaret ?? 'none'); })()", settleMs: 300 },
    ours: { letterbox: true }, zoom: 1, matchHeight: true,
    refs: [{ file: 'verification/retail-ab/chargen-summary/retail.png', label: 'retail EoR client, Summary page, name prompt selected on open (retail-ab)' }],
    notes: 'RECON.dom-chrome-sweep.b: the caret is a 1-px line in the field colour at the DAT advance of the typed name (DatEditField); no retail frame of a typed name is on file' },
  { name: 'chargen-profession-value-focused', title: 'Character creation — Profession page, Strength value box focused (SelectAll) — retail | ours', stage: 'chargen', chargenPage: 1,
    pins: { evalJs: "(() => { const i = document.querySelector('.attr-value-input[data-attr=\"strength\"]'); if (!i) return 'no box'; i.focus(); return 'selected ' + i.selectionStart + '-' + i.selectionEnd; })()", settleMs: 300 },
    ours: { letterbox: true }, zoom: 1, matchHeight: true,
    refs: [{ file: 'verification/retail-ab/chargen-profession/retail.png', label: 'retail EoR client, Profession page, nothing focused (retail-ab)' }],
    notes: 'RECON.dom-chrome-sweep.b: the right-justified (p20 = 3) value drawn by DatEditField with its selection inverted; no retail frame of a focused value box is on file' },
];

/** The world pins a side-by-side row runs with: its worldScene's, overlaid by its inline pins; the day group defaults like the scene pass. */
export function sideBySidePins(row: SideBySideScene): SideBySidePins & { dayGroup: string | number } {
  const base = row.worldScene ? SCENES.find((s) => s.name === row.worldScene) : undefined;
  if (row.worldScene && !base) throw new Error(`side-by-side ${row.name}: no SCENES entry "${row.worldScene}"`);
  const src: SideBySidePins = { ...(base ?? {}), ...(row.pins ?? {}) };
  return {
    teleport: src.teleport, timeOfDay: src.timeOfDay, weather: src.weather, dayGroup: src.dayGroup ?? DEFAULT_DAY_GROUP,
    yaw: src.yaw, cameraDistance: src.cameraDistance, toggles: src.toggles, evalJs: src.evalJs, cleanupJs: src.cleanupJs,
    holdKeys: src.holdKeys, settleMs: src.settleMs,
  };
}

/** The 800x600 pre-world design space inside a letterboxed viewport (uniform scale, centred). */
export function letterboxBox(view: { width: number; height: number }): CropBox {
  const scale = Math.min(view.width / 800, view.height / 600);
  const w = Math.round(800 * scale);
  const h = Math.round(600 * scale);
  return { x: Math.round((view.width - w) / 2), y: Math.round((view.height - h) / 2), w, h };
}

/** HARNESS.scene-spawn-leak — every weenie class any scene @creates (swept after each teleport). */
export const SPAWNED_WCIDS: readonly number[] = [...new Set(SCENES.flatMap((s) => s.spawns ?? []))];

/**
 * What a scene left behind: inventory items it added, and world objects of
 * its declared `spawns` classes it added. Dynamic guids only (>= 0x80000000);
 * landblock-placed objects (0x7…) and players (0x5…) are never touched.
 */
export function leftoversOf(
  before: { inv: number[]; world: number[] },
  after: { inv: number[]; world: Array<{ guid: number; wcid: number }> },
  spawns: readonly number[],
): number[] {
  const inv0 = new Set(before.inv), world0 = new Set(before.world);
  // Spawned world objects first: deleting a container takes the items a
  // scene stored in it along, so they need no @delete of their own.
  const out = after.world.filter((o) => !world0.has(o.guid) && spawns.includes(o.wcid) && (o.guid >>> 0) >= 0x80000000).map((o) => o.guid);
  for (const g of after.inv) if (!inv0.has(g) && !out.includes(g)) out.push(g);
  return out;
}
