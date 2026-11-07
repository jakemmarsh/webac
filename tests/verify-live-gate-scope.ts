/**
 * The live gate's fast tier: what a diff makes it play (tools/lib/live-gate-scope.ts, tools/live-gate-scope.ts).
 * Every play-through step of every era and every capture must be reachable from some path; unknown paths fail safe
 * to the broad set; docs/tests/tools-only diffs get the smoke alone; the steps resolve per era against the real plan.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AREAS, IMPLICIT_STEPS, KNOWN_CAPTURES, PATH_RULES, STEP_DEPS, type AreaId, areasForPath, globToRegExp, scopeFor, stepsForEra,
} from '../tools/lib/live-gate-scope.ts';
import { ERA_PLANS, eraPlan, playthroughSteps } from '../tools/lib/playthrough.ts';
import { regressionSteps, withRegressionSteps } from '../tools/lib/playthrough-regressions.ts';

const REPO = resolve(__dirname, '..');
const ERAS = Object.keys(ERA_PLANS);
const planIds = (era: string): string[] => withRegressionSteps(playthroughSteps(eraPlan(era)), regressionSteps(eraPlan(era))).map((s) => s.id);
const SMOKE = ['panel-inventory', 'walk-short', 'logout-relogin'];

describe('globToRegExp', () => {
  it('* stays in a segment, ** crosses any depth (including none), ? is one character', () => {
    expect(globToRegExp('docs/**').test('docs/a/b.md')).toBe(true);
    expect(globToRegExp('**/*.md').test('README.md')).toBe(true);
    expect(globToRegExp('**/*.md').test('packages/x/README.md')).toBe(true);
    expect(globToRegExp('packages/renderer/src/ui/Toolbar*.ts').test('packages/renderer/src/ui/ToolbarTabs.ts')).toBe(true);
    expect(globToRegExp('packages/renderer/src/ui/Toolbar*.ts').test('packages/renderer/src/ui/sub/ToolbarTabs.ts')).toBe(false);
    expect(globToRegExp('vite.config.*').test('vite.config.ts')).toBe(true);
    expect(globToRegExp('vite.config.*').test('viteXconfig.ts')).toBe(false); // the dot is literal
    expect(globToRegExp('LICENSE?').test('LICENSE2')).toBe(true);
  });
});

describe('path → areas', () => {
  const cases: Array<[string, AreaId[]]> = [
    ['packages/renderer/src/ui/InventoryPanel.ts', ['inventory']],
    ['packages/renderer/src/inventory/dragSplit.ts', ['inventory', 'items']],
    ['packages/renderer/src/player/LandingCoast.ts', ['movement']],
    ['packages/renderer/src/world/CollisionGrid.ts', ['movement']],
    ['packages/renderer/src/animation/MotionManager.ts', ['movement', 'wield']],
    ['packages/renderer/src/world/WieldAttach.ts', ['wield', 'movement']],
    ['packages/renderer/src/ui/CharacterCreate.ts', ['chargen']],
    ['packages/renderer/src/session/SessionLifecycle.ts', ['chargen']],
    ['packages/renderer/src/launcher/LauncherScreen.ts', ['chargen']],
    ['packages/renderer/src/era/EraWorldRules.ts', ['options']],
    ['packages/renderer/src/ui/PlayerOptions.ts', ['options']],
    ['packages/renderer/src/main.ts', ['broad']],
    ['packages/renderer/src/ui/GameUI.ts', ['broad']],
    ['packages/network/src/ClientConnection.ts', ['broad']],
    ['packages/shared/src/enums.ts', ['broad']],
    ['services/ws-tcp-bridge/src/bridge.ts', ['broad']],
    ['packages/renderer/src/agent/AgentApi.ts', ['broad']],
    ['docs/verification-workflows.md', ['none']],
    ['tests/verify-live-gate.ts', ['none']],
    ['tools/live-gate.sh', ['none']],
    ['progress.md', ['none']],
    ['tasks.json', ['none']],
  ];
  it.each(cases)('%s → %j', (path, want) => {
    expect(areasForPath(path).sort()).toEqual([...want].sort());
  });
  it('a path no rule names gets the broad set (fail safe toward more coverage)', () => {
    expect(areasForPath('packages/renderer/src/brand-new-dir/Thing.ts')).toEqual(['broad']);
    expect(areasForPath('packages/renderer/src/ui/SomeNewPanel.ts')).toEqual(['broad']);
    expect(areasForPath('weird-root-file.cfg')).toEqual(['broad']);
  });
  it('every rule names areas that exist, and every area but none is named by some rule', () => {
    const named = new Set<string>();
    for (const [glob, areas] of PATH_RULES) {
      expect(areas.length, glob).toBeGreaterThan(0);
      for (const a of areas) { expect(Object.keys(AREAS), `${glob} → ${a}`).toContain(a); named.add(a); }
    }
    for (const a of Object.keys(AREAS)) if (a !== 'smoke') expect(named, a).toContain(a);
  });
});

describe('scopeFor', () => {
  it('docs / tests / tools only: the smoke alone', () => {
    const s = scopeFor(['docs/a.md', 'tests/b.ts', 'tools/live-gate.sh', 'progress.md']);
    expect(s.areas).toEqual(['smoke']);
    expect(s.captures.sort()).toEqual(['hud-overview', 'inventory']);
    for (const e of ERAS) expect(stepsForEra(s.steps, planIds(e))).toEqual(SMOKE);
  });
  it('an empty diff (HEAD is the live build) still smokes every era', () => {
    expect(scopeFor([]).areas).toEqual(['smoke']);
    for (const e of ERAS) expect(stepsForEra(scopeFor([]).steps, planIds(e))).toEqual(SMOKE);
  });
  it('inventory UI: the pack steps and the inventory captures, plus the smoke', () => {
    const s = scopeFor(['packages/renderer/src/ui/InventoryPanel.ts']);
    expect(s.areas).toEqual(['smoke', 'inventory']);
    expect(stepsForEra(s.steps, planIds('eor'))).toEqual(['panel-inventory', 'walk-short', 'pack-scroll-sort', 'pack-bars', 'toolbar-relog', 'logout-relogin']);
    expect(s.captures).toEqual(expect.arrayContaining(['inventory', 'inventory-sidepack', 'toolbar-used-kit', 'hud-overview']));
  });
  it('movement → the running jump and the short walk; held items → shield-relog; chargen → create-character-click; options → option-defaults', () => {
    const ids = (p: string) => stepsForEra(scopeFor([p]).steps, planIds('eor'));
    expect(ids('packages/renderer/src/player/JumpLaunch.ts')).toEqual(expect.arrayContaining(['running-jump-coast', 'walk-short']));
    expect(ids('packages/renderer/src/models/WieldedItemVisual.ts')).toContain('shield-relog');
    expect(ids('packages/renderer/src/ui/CharacterSelect.ts')).toContain('create-character-click');
    expect(ids('packages/renderer/src/era/EraFeatures.ts')).toEqual(expect.arrayContaining(['option-defaults', 'panel-options']));
    expect(scopeFor(['packages/renderer/src/era/EraFeatures.ts']).captures).toEqual(expect.arrayContaining(['options', 'options-config']));
  });
  it('shared core (network, main.ts) → the broad set: every regression step and a panel sweep', () => {
    const s = scopeFor(['packages/network/src/PacketBuilder.ts']);
    expect(s.areas).toContain('broad');
    const ids = stepsForEra(s.steps, planIds('ac1999-retail'));
    for (const id of ['option-defaults', 'walk-short', 'pack-scroll-sort', 'pack-bars', 'toolbar-relog', 'shield-relog', 'running-jump-coast', 'create-character-click', 'panel-create-spell', 'vendor-buy', 'kill'])
      expect(ids, id).toContain(id);
  });
  it('byPath reports each file and its areas', () => {
    expect(scopeFor(['docs/a.md', 'packages/renderer/src/main.ts']).byPath).toEqual([
      { path: 'docs/a.md', areas: ['none'] }, { path: 'packages/renderer/src/main.ts', areas: ['broad'] },
    ]);
  });
});

describe('stepsForEra: aliases, dependencies, the era\'s own plan', () => {
  it('cmd-confirm-no is the era\'s Yes / No command', () => {
    expect(stepsForEra(['cmd-confirm-no'], planIds('ac1999-retail'))).toEqual(['cmd-lifestone-no']);
    expect(stepsForEra(['cmd-confirm-no'], planIds('eor'))).toEqual(['cmd-die-no']);
    expect(stepsForEra(['cmd-confirm-no'], planIds('classicace-customdm'))).toEqual(['cmd-die-no']);
  });
  it('a step brings what it depends on, in plan order', () => {
    expect(stepsForEra(['panel-effects'], planIds('eor'))).toEqual(['vendor-buy', 'vendor-supplies', 'magic-mode', 'cast-self', 'panel-effects']);
    expect(stepsForEra(['loot-rest'], planIds('eor'))).toEqual(['kill', 'corpse-open', 'loot-rest']);
    expect(stepsForEra(['vendor-sell'], planIds('eor'))).toEqual(['vendor-buy', 'vendor-sell']);
  });
  it('a step the era lacks is dropped (the Create Spell page is 1999\'s); the implicit steps are never listed', () => {
    expect(stepsForEra(['panel-create-spell', 'enter-world'], planIds('eor'))).toEqual([]);
    expect(stepsForEra(['panel-create-spell', 'enter-world'], planIds('ac1999-retail'))).toEqual(['panel-create-spell']);
  });
  it('every dependency names a real step of some era', () => {
    const all = new Set(ERAS.flatMap(planIds));
    for (const [id, deps] of Object.entries(STEP_DEPS)) {
      expect(all, id).toContain(id);
      for (const d of deps) expect(all, `${id} → ${d}`).toContain(d);
    }
  });
});

describe('coverage: nothing is unreachable', () => {
  // The paths the rules can produce: one sample path per rule (its glob with the wildcards filled in).
  const samples = PATH_RULES.map(([glob]) => glob.replace(/\*\*\//g, 'x/').replace(/\*\*/g, 'x/y.ts').replace(/\*/g, 'X').replace(/\?/g, '1'));
  it('each sample path matches its own rule (the sampler is honest)', () => {
    PATH_RULES.forEach(([glob], i) => expect(globToRegExp(glob).test(samples[i]), `${glob} ← ${samples[i]}`).toBe(true));
  });
  it('every play-through step of every era is reachable from some path', () => {
    for (const era of ERAS) {
      const reached = new Set<string>();
      for (const p of samples) for (const id of stepsForEra(scopeFor([p]).steps, planIds(era))) reached.add(id);
      for (const id of planIds(era)) if (!IMPLICIT_STEPS.has(id)) expect(reached, `${era}: ${id}`).toContain(id);
    }
  });
  it('every known capture is reachable from some path, and every area names only known captures', () => {
    const reached = new Set(samples.flatMap((p) => scopeFor([p]).captures));
    for (const c of KNOWN_CAPTURES) expect(reached, c).toContain(c);
    for (const [a, area] of Object.entries(AREAS)) for (const c of area.captures) expect(KNOWN_CAPTURES as readonly string[], `${a}: ${c}`).toContain(c);
  });
  it('every area step is a real step (or alias) in some era', () => {
    const all = new Set([...ERAS.flatMap(planIds), 'cmd-confirm-no']);
    for (const [a, area] of Object.entries(AREAS)) for (const s of area.steps) expect(all, `${a}: ${s}`).toContain(s);
  });
});

describe('tools/live-gate-scope.ts (the CLI live-gate.sh reads)', () => {
  it('prints areas, the file count, each era\'s --only ids and the captures, tab-separated', () => {
    const out = execFileSync('npx', ['tsx', 'tools/live-gate-scope.ts', '--paths', 'packages/renderer/src/ui/InventoryPanel.ts,docs/x.md', '--explain'], { cwd: REPO, encoding: 'utf8' });
    const row = (k: string) => out.split('\n').find((l) => l.startsWith(`${k}\t`))?.split('\t').slice(1);
    expect(row('areas')).toEqual(['smoke,inventory']);
    expect(row('files')).toEqual(['2']);
    expect(row('steps-eor')).toEqual(['panel-inventory,walk-short,pack-scroll-sort,pack-bars,toolbar-relog,logout-relogin']);
    expect(row('steps-ac1999-retail')).toEqual(['panel-inventory,walk-short,pack-scroll-sort,pack-bars,toolbar-relog,logout-relogin']);
    expect(row('captures')).toEqual(['hud-overview inventory inventory-sidepack toolbar-used-kit']);
    expect(out).toContain('path\tdocs/x.md\tnone');
  });
});
