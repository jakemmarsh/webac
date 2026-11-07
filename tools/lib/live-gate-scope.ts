/**
 * The live gate's fast tier picks what to play from what changed (Jake, 2026-11-07: "yes agreed w/ fast and full
 * split"). `tools/live-gate.sh --fast` runs `tools/live-gate-scope.ts`, which feeds `git diff --name-only
 * <live web build>..HEAD` through `scopeFor` here: each changed path names one or more AREAS (PATH_RULES, first
 * column), each area names play-through steps (tools/ac1999-playthrough.ts `--only` ids) and screen-regression
 * captures (tools/capture-ui-screens.ts names, `--ui` panels). The smoke area is always in: enter the world, open
 * the inventory, walk a few metres, log out and back, and the HUD + inventory captures (plus the pre-world flow,
 * which every screen run captures), in every era.
 *
 * Fail safe toward more coverage: a path no rule names gets the broad set. A path the local gate never exercises
 * (docs, tests, tools, the deploy configs) gets the smoke alone.
 *
 * To extend: add a row to PATH_RULES (globs: `*` = within one path segment, `**` = any depth) naming existing
 * areas, or add an area to AREAS. tests/verify-live-gate-scope.ts checks that every play-through step of every era
 * and every known capture is reachable from some path, and that every rule names real areas.
 */

/** An area of the client: the play-through steps and screen captures that exercise it. */
export interface Area {
  /** Play-through step ids (STEP_ALIASES and STEP_DEPS are applied per era by stepsForEra). */
  steps: readonly string[];
  /** Screen-regression capture names (the era's own panel set is intersected in tools/screen-regression-eras.sh). */
  captures: readonly string[];
  why: string;
}

const PANEL_STEPS = ['panel-inventory', 'panel-attributes', 'panel-skills', 'panel-spellbook', 'panel-components', 'panel-create-spell', 'panel-map', 'panel-options', 'panel-fellowship'] as const;

export const AREAS = {
  smoke: {
    steps: ['enter-world', 'panel-inventory', 'walk-short', 'logout-relogin'],
    captures: ['hud-overview', 'inventory'],
    why: 'every run: enter the world, open the inventory, walk a few metres, log out and back',
  },
  none: { steps: [], captures: [], why: 'not exercised by the local gate (docs, tests, tools, deploy configs): smoke only' },
  inventory: {
    steps: ['panel-inventory', 'pack-scroll-sort', 'pack-bars', 'toolbar-relog'],
    captures: ['inventory', 'inventory-sidepack', 'toolbar-used-kit', 'hud-overview'],
    why: 'packs, item cells, drag and drop, the toolbar',
  },
  items: {
    steps: ['vendor-buy', 'vendor-sell', 'vendor-supplies', 'read-scroll', 'use-food', 'use-healing-kit', 'give-npc', 'loot-walk-away', 'loot-rest'],
    captures: ['inventory'],
    why: 'vendors, trade, giving, using and looting items',
  },
  wield: { steps: ['shield-relog'], captures: ['inventory'], why: 'held items: wield, attach, the paperdoll' },
  movement: { steps: ['walk-short', 'running-jump-coast'], captures: ['hud-overview'], why: 'movement, physics, collision, animation' },
  combat: { steps: ['kill', 'corpse-open', 'loot-walk-away', 'loot-rest'], captures: ['hud-overview'], why: 'attacking, corpses' },
  magic: {
    steps: ['vendor-supplies', 'magic-mode', 'cast-creature', 'cast-self', 'panel-spellbook', 'panel-components', 'panel-create-spell', 'panel-effects'],
    captures: ['magic-spellbook', 'magic-components'],
    why: 'spells, the spellbook, components, spell research',
  },
  chargen: {
    steps: ['create-character-click', 'logout-relogin'],
    captures: ['hud-overview'],
    why: 'launcher, character select, chargen, login and session (the pre-world captures run every time)',
  },
  options: {
    steps: ['option-defaults', 'panel-options'],
    captures: ['options', 'options-character', 'options-chat', 'options-config'],
    why: 'options and era rules',
  },
  character: { steps: ['panel-attributes', 'panel-skills'], captures: ['char-attributes', 'char-skills', 'char-titles'], why: 'the character panel' },
  social: {
    steps: ['panel-fellowship'],
    captures: ['social-fellowship', 'social-allegiance', 'social-friends', 'social-fellowship-seeded', 'social-allegiance-seeded', 'social-friends-seeded', 'social-fellowship-ctxmenu'],
    why: 'fellowship, allegiance, friends',
  },
  map: { steps: ['panel-map'], captures: ['map', 'map-house', 'hud-overview'], why: 'the map, radar and markers' },
  chat: { steps: ['cmd-help', 'cmd-loc', 'cmd-version', 'cmd-confirm-no'], captures: ['hud-overview', 'report-abuse', 'report-abuse-input'], why: 'chat, commands, server text' },
  panels: { steps: PANEL_STEPS, captures: ['hud-overview', 'inventory', 'char-attributes', 'magic-spellbook', 'social-fellowship', 'options-config', 'map'], why: 'shared panel and layout code' },
  broad: {
    steps: [
      'enter-world', 'option-defaults', ...PANEL_STEPS, 'vendor-buy', 'vendor-sell', 'kill', 'corpse-open',
      'walk-short', 'pack-scroll-sort', 'pack-bars', 'toolbar-relog', 'shield-relog', 'running-jump-coast', 'create-character-click',
      'cmd-loc', 'logout-relogin',
    ],
    captures: ['hud-overview', 'inventory', 'inventory-sidepack', 'toolbar-used-kit', 'char-attributes', 'magic-spellbook', 'social-fellowship', 'options-config', 'map'],
    why: 'shared core (network, protocol, the bridge, main.ts, GameUI, DAT parsing) or a path no rule names: the broad set',
  },
} as const satisfies Record<string, Area>;

export type AreaId = keyof typeof AREAS;

/**
 * Path globs → areas. Every rule a path matches counts (their areas are unioned); a path no rule matches gets
 * `broad`. Order doesn't matter. Paths are repo-relative with forward slashes.
 */
export const PATH_RULES: ReadonlyArray<readonly [glob: string, areas: readonly AreaId[]]> = [
  // Not exercised by the local gate: smoke only.
  ['docs/**', ['none']], ['tests/**', ['none']], ['tools/**', ['none']], ['verification/**', ['none']], ['.claude/**', ['none']],
  ['.github/**', ['none']], ['deploy/**', ['none']], ['**/*.md', ['none']], ['tasks.json', ['none']], ['reference/**', ['none']],
  ['GOAL.md', ['none']], ['.gitignore', ['none']], ['LICENSE*', ['none']],

  // Shared core: the broad set.
  ['packages/shared/**', ['broad']], ['packages/network/**', ['broad']], ['packages/dat-parser/**', ['broad']], ['services/**', ['broad']],
  ['packages/renderer/src/main.ts', ['broad']], ['packages/renderer/src/app.ts', ['broad']], ['packages/renderer/src/GameLoop.ts', ['broad']],
  ['packages/renderer/src/index.ts', ['broad']], ['packages/renderer/src/network/**', ['broad']], ['packages/renderer/src/dat/**', ['broad']],
  ['packages/renderer/src/agent/**', ['broad']], // the API the play-through drives
  ['packages/renderer/src/config/**', ['broad']], ['packages/renderer/src/utils/**', ['broad']],
  ['packages/renderer/src/ui/GameUI.ts', ['broad']], ['packages/renderer/src/ui/UIManager.ts', ['broad']], ['packages/renderer/src/ui/UIHost.ts', ['broad']],
  ['package.json', ['broad']], ['package-lock.json', ['broad']], ['tsconfig*.json', ['broad']], ['vite.config.*', ['broad']], ['index.html', ['broad']],
  ['public/**', ['broad']], ['packages/*/package.json', ['broad']], ['packages/*/tsconfig*.json', ['broad']],

  // Inventory, packs, items.
  ['packages/renderer/src/inventory/**', ['inventory', 'items']],
  ['packages/renderer/src/ui/InventoryPanel.ts', ['inventory']], ['packages/renderer/src/ui/ItemIconComposite.ts', ['inventory']],
  ['packages/renderer/src/ui/structureBar.ts', ['inventory']], ['packages/renderer/src/ui/UIItemDragAccept.ts', ['inventory']],
  ['packages/renderer/src/ui/ScrollKeep.ts', ['inventory']], ['packages/renderer/src/ui/Toolbar*.ts', ['inventory']],
  ['packages/renderer/src/ui/EncumbranceNotice.ts', ['inventory']], ['packages/renderer/src/ui/CombatAmmoCount.ts', ['inventory']],
  ['packages/renderer/src/ui/TransactionDock.ts', ['inventory', 'items']], ['packages/renderer/src/controllers/InventoryController.ts', ['inventory', 'items']],
  ['packages/renderer/src/player/sidePackOrder.ts', ['inventory']], ['packages/renderer/src/player/deletedOwnedItem.ts', ['inventory']],
  ['packages/renderer/src/ui/wheelScroll.ts', ['inventory']], ['packages/renderer/src/ui/ScrollbarButtons.ts', ['inventory', 'panels']],
  ['packages/renderer/src/ui/Vendor*.ts', ['items']], ['packages/renderer/src/ui/SecureTradePanel.ts', ['items']],
  ['packages/renderer/src/ui/tradeItemEntry.ts', ['items']], ['packages/renderer/src/ui/SalvagePanel.ts', ['items']],
  ['packages/renderer/src/ui/BookModel.ts', ['items']], ['packages/renderer/src/world/OpenContainerTracker.ts', ['items']],
  ['packages/renderer/src/world/CloseCurrentContainer.ts', ['items']], ['packages/renderer/src/world/ViewContentsRouter.ts', ['items']],
  ['packages/renderer/src/input/UseObject.ts', ['items']], ['packages/renderer/src/input/CorpseCommands.ts', ['items', 'combat']],

  // Held items and wielding.
  ['packages/renderer/src/models/WieldedItemVisual.ts', ['wield']], ['packages/renderer/src/world/WieldAttach.ts', ['wield']],
  ['packages/renderer/src/ui/PaperDoll*.ts', ['wield', 'inventory']], ['packages/renderer/src/ui/Paperdoll*.ts', ['wield', 'inventory']],
  ['packages/renderer/src/inventory/ServerWieldObject.ts', ['wield']], ['packages/renderer/src/inventory/PaperdollDragObject.ts', ['wield']],
  ['packages/renderer/src/inventory/ItemHolderPlacement.ts', ['wield']],
  ['packages/renderer/src/models/**', ['wield', 'movement']], ['packages/renderer/src/animation/**', ['movement', 'wield']],

  // Movement, physics, collision, rendering of the world.
  ['packages/renderer/src/player/**', ['movement']], ['packages/renderer/src/world/**', ['movement']],
  ['packages/renderer/src/controllers/MoveToManager.ts', ['movement']], ['packages/renderer/src/controllers/StopCompletely.ts', ['movement']],
  ['packages/renderer/src/input/**', ['movement', 'panels']], ['packages/renderer/src/scene/**', ['movement']],
  ['packages/renderer/src/terrain/**', ['movement']], ['packages/renderer/src/effects/**', ['movement', 'magic']],
  ['packages/renderer/src/optimization/**', ['movement']],

  // Combat.
  ['packages/renderer/src/controllers/Combat*.ts', ['combat']], ['packages/renderer/src/controllers/AttackRequest.ts', ['combat']],
  ['packages/renderer/src/controllers/PowerBarStep.ts', ['combat']], ['packages/renderer/src/ui/CombatWindow.ts', ['combat']],
  ['packages/renderer/src/controllers/SelectNext.ts', ['combat']], ['packages/renderer/src/controllers/World*.ts', ['combat', 'items']],
  ['packages/renderer/src/controllers/BackgroundAppraisal.ts', ['items']], ['packages/renderer/src/controllers/EscapeAction.ts', ['panels']],
  ['packages/renderer/src/world/MissilePhysics.ts', ['combat', 'movement']],

  // Magic.
  ['packages/renderer/src/magic/**', ['magic']], ['packages/renderer/src/controllers/MagicController.ts', ['magic']],
  ['packages/renderer/src/ui/Spell*.ts', ['magic']], ['packages/renderer/src/ui/spellbookFilter.ts', ['magic']],
  ['packages/renderer/src/ui/*ComponentList.ts', ['magic']], ['packages/renderer/src/ui/splitpea/**', ['magic']],
  ['packages/renderer/src/ui/EffectsPanelModel.ts', ['magic']], ['packages/renderer/src/ui/cooldownMeter.ts', ['magic']],

  // Pre-world: launcher, character select, chargen, login, session.
  ['packages/renderer/src/launcher/**', ['chargen']], ['packages/renderer/src/session/**', ['chargen']],
  ['packages/renderer/src/boot/**', ['chargen']], ['packages/renderer/src/ui/Chargen*.ts', ['chargen']],
  ['packages/renderer/src/ui/chargen*.ts', ['chargen']], ['packages/renderer/src/ui/Charsel*.ts', ['chargen']],
  ['packages/renderer/src/ui/CharacterCreate.ts', ['chargen']], ['packages/renderer/src/ui/CharacterSelect.ts', ['chargen']],
  ['packages/renderer/src/ui/Heritage*.ts', ['chargen']], ['packages/renderer/src/ui/PreworldScale.ts', ['chargen']],
  ['packages/renderer/src/ui/LoadingOverlay.ts', ['chargen']], ['packages/renderer/src/ui/PatchScreen.ts', ['chargen']],
  ['packages/renderer/src/ui/CreditsScreen.ts', ['chargen']], ['packages/renderer/src/ui/ConnectionNotices.ts', ['chargen']],
  ['packages/renderer/src/ui/BarberModel.ts', ['chargen']], ['packages/renderer/src/ui/BarberPanel.ts', ['chargen']],
  ['packages/renderer/src/update/**', ['chargen']],

  // Options and era rules.
  ['packages/renderer/src/era/**', ['options']], ['packages/renderer/src/ui/PlayerOptions.ts', ['options']],
  ['packages/renderer/src/ui/OptionsStrings.ts', ['options']], ['packages/renderer/src/ui/EraOptionPrefs.ts', ['options']],
  ['packages/renderer/src/ui/LocalOptionEffects.ts', ['options']], ['packages/renderer/src/ui/KeyboardConfigModel.ts', ['options']],
  ['packages/renderer/src/ui/MouseTurningDefaults.ts', ['options', 'movement']], ['packages/renderer/src/ui/CharacterSettingsModel.ts', ['options']],
  ['packages/renderer/src/ui/ScreenGamma.ts', ['options']],

  // Character panel, social, map, chat.
  ['packages/renderer/src/ui/SkillDisplay.ts', ['character']], ['packages/renderer/src/ui/attributePictograms.ts', ['character']],
  ['packages/renderer/src/ui/CharacterInfoReport.ts', ['character']], ['packages/renderer/src/ui/VitaePanelText.ts', ['character']],
  ['packages/renderer/src/ui/Fellowship*.ts', ['social']], ['packages/renderer/src/ui/fellowship*.ts', ['social']],
  ['packages/renderer/src/ui/Allegiance*.ts', ['social']], ['packages/renderer/src/ui/SocialRefusalLines1999.ts', ['social']],
  ['packages/renderer/src/ui/maps/**', ['map']], ['packages/renderer/src/ui/MapMarkers.ts', ['map']], ['packages/renderer/src/ui/Minimap.ts', ['map']],
  ['packages/renderer/src/ui/Radar*.ts', ['map']], ['packages/renderer/src/ui/goarrow/**', ['map']],
  ['packages/renderer/src/chat/**', ['chat']], ['packages/renderer/src/ui/Chat*.ts', ['chat']], ['packages/renderer/src/ui/FloatyChat*.ts', ['chat']],
  ['packages/renderer/src/ui/SpewBoxModel.ts', ['chat']], ['packages/renderer/src/ui/ServerMessageText.ts', ['chat']],
  ['packages/renderer/src/ui/*Refusal*.ts', ['chat']], ['packages/renderer/src/ui/*Notices.ts', ['chat']],
  ['packages/renderer/src/ui/FailureEventText1999.ts', ['chat']], ['packages/renderer/src/ui/DialogPanel.ts', ['chat']],

  // Shared panel and layout code.
  ['packages/renderer/src/ui/Layout*.ts', ['panels']], ['packages/renderer/src/ui/Dat*.ts', ['panels']], ['packages/renderer/src/ui/HUD.ts', ['panels']],
  ['packages/renderer/src/ui/PanelsWindow.ts', ['panels']], ['packages/renderer/src/ui/PanelPressGuard.ts', ['panels']],
  ['packages/renderer/src/ui/ACFontRenderer.ts', ['panels', 'chat']], ['packages/renderer/src/ui/UITextureLoader.ts', ['panels']],
  ['packages/renderer/src/ui/UIElementTextLayout.ts', ['panels']], ['packages/renderer/src/ui/ZIndexRegistry.ts', ['panels']],
  ['packages/renderer/src/ui/TabStripShare.ts', ['panels']], ['packages/renderer/src/ui/CursorManager.ts', ['panels']],
  ['packages/renderer/src/ui/GlobalCursor.ts', ['panels']], ['packages/renderer/src/ui/HudTooltips.ts', ['panels']],
  ['packages/renderer/src/ui/examine/**', ['panels', 'items']], ['packages/renderer/src/ui/Examine*.ts', ['panels', 'items']],
  ['packages/renderer/src/ui/examineHeader.ts', ['panels', 'items']], ['packages/renderer/src/ui/appraisalColors.ts', ['panels', 'items']],
  ['packages/renderer/src/ui/automation/**', ['panels']], ['packages/renderer/src/ui/magtools/**', ['panels']],

  // Little or nothing the gate can see beyond the smoke.
  ['packages/renderer/src/audio/**', ['none']], ['packages/renderer/src/telemetry/**', ['none']],
];

/** A glob to a RegExp: `**` any depth (including none), `*` within one segment, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const COMPILED = PATH_RULES.map(([glob, areas]) => ({ glob, re: globToRegExp(glob), areas }));

/** The areas one path names (`broad` when no rule names it). */
export function areasForPath(path: string): AreaId[] {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const hit = new Set<AreaId>();
  for (const r of COMPILED) if (r.re.test(p)) for (const a of r.areas) hit.add(a);
  return hit.size ? [...hit] : ['broad'];
}

export interface Scope {
  /** Areas in play, smoke first. */
  areas: AreaId[];
  /** Step tokens before per-era resolution (aliases unresolved). */
  steps: string[];
  /** Capture names. */
  captures: string[];
  /** Each changed path and the areas it named (for --explain and the run log). */
  byPath: Array<{ path: string; areas: AreaId[] }>;
}

/** The fast tier's scope for a list of changed paths. The smoke area is always in. */
export function scopeFor(changed: readonly string[]): Scope {
  const areas = new Set<AreaId>(['smoke']);
  const byPath = changed.filter(Boolean).map((path) => ({ path, areas: areasForPath(path) }));
  for (const b of byPath) for (const a of b.areas) if (a !== 'none') areas.add(a);
  const steps = new Set<string>();
  const captures = new Set<string>();
  for (const a of areas) {
    for (const s of AREAS[a].steps) steps.add(s);
    for (const c of AREAS[a].captures) captures.add(c);
  }
  return { areas: [...areas], steps: [...steps], captures: [...captures], byPath };
}

/** Step tokens that stand for an era-specific id: the era's Yes / No command (`cmd-lifestone-no`, `cmd-die-no`). */
export const STEP_ALIASES: Record<string, (planIds: readonly string[]) => string[]> = {
  'cmd-confirm-no': (ids) => ids.filter((id) => /^cmd-.+-no$/.test(id)),
};

/**
 * What a step needs an earlier step to have done (its run state): a sale needs the purchase's vendor, the loot needs
 * the kill's corpse, a cast needs magic mode's caster. Added transitively so an --only run never skips for a reason
 * the full run wouldn't.
 */
export const STEP_DEPS: Record<string, readonly string[]> = {
  'vendor-sell': ['vendor-buy'],
  'vendor-supplies': ['vendor-buy'],
  'read-scroll': ['vendor-supplies'],
  'use-food': ['vendor-supplies'],
  'use-healing-kit': ['vendor-supplies'],
  'corpse-open': ['kill'],
  'loot-walk-away': ['kill', 'corpse-open'],
  'loot-rest': ['kill', 'corpse-open'],
  'magic-mode': ['vendor-supplies'],
  'cast-creature': ['magic-mode'],
  'cast-self': ['magic-mode'],
  'panel-effects': ['cast-self'],
};

/** Steps the play-through always runs itself (selectSteps: required / withOnly), never passed to --only. */
export const IMPLICIT_STEPS = new Set(['enter-world', 'admin-prep', 'pack-space']);

/**
 * The --only ids for one era: aliases resolved against the era's plan, dependencies added, ids the era doesn't have
 * dropped (panel-create-spell outside 1999), in the plan's order, without the implicit steps.
 */
export function stepsForEra(tokens: readonly string[], planIds: readonly string[]): string[] {
  const want = new Set<string>();
  const add = (id: string): void => {
    if (want.has(id)) return;
    want.add(id);
    for (const d of STEP_DEPS[id] ?? []) add(d);
  };
  for (const t of tokens) {
    const alias = STEP_ALIASES[t];
    if (alias) alias(planIds).forEach(add); else add(t);
  }
  return planIds.filter((id) => want.has(id) && !IMPLICIT_STEPS.has(id));
}

/** Every capture tools/capture-ui-screens.ts makes in --ui mode (its CAPTURES names; the pre-world flow is always captured). */
export const KNOWN_CAPTURES = [
  'hud-overview', 'inventory', 'char-attributes', 'char-skills', 'char-titles', 'magic-spellbook', 'magic-components',
  'social-fellowship', 'social-allegiance', 'social-friends', 'social-allegiance-seeded', 'social-fellowship-seeded',
  'social-fellowship-ctxmenu', 'social-friends-seeded', 'options', 'options-character', 'options-chat', 'options-config',
  'report-abuse', 'report-abuse-input', 'inventory-sidepack', 'toolbar-used-kit', 'map', 'map-house',
] as const;
