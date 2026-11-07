import { describe, expect, it } from 'vitest';
import type { HeldPose } from '../packages/renderer/src/models/HeldPose.ts';
import {
  type ClientProbe, type PlaythroughDriver, type Step, type Signals, type StepContext, emptySignals, eraPlan, freshState, playthroughSteps,
  renderReport, runPlaythrough, selectSteps,
} from '../tools/lib/playthrough.ts';
import {
  type ChargenPoll, type GridCell, type GridState, type MoveSample, ADMIN_COMMANDS, REGRESSION_STEP_IDS, RETAIL_COAST_PER_MPS,
  bottomRowAt, capacityBarFraction, coastFromSamples, fillNeeded, freeShortcutSlot, judgeChargenWait, judgeCoast, judgeMeter,
  judgeOptionDefaults, judgeScrollKept, judgeShortcutIcon, lastWield, optionDefaultsFor, optionDefaultsStep, parseWieldLine, pickDragPair,
  regressionSteps, rowOf, scrollTargetFor, shieldRelogStep, structureBarFraction, usedTool, sidePackFiller, visibleRowsOf, withRegressionSteps,
  WALK_SHORT_METRES, WALK_SHORT_MIN_MOVED, WALK_BEARINGS, judgeWalk, pointAlong, walkPlan, walkShortStep, shortcutTrayRefusal,
  type KeysState, judgeKeysState, readyForKeys, runningJumpCoastStep,
  PACK_SPACE_WANTED, leavesNoTrace, mainPackFree, packSpaceStep, spawnHeld,
} from '../tools/lib/playthrough-regressions.ts';

// The week's player-reported regressions as play-through steps (2026-11-07): the step order, --only, the report,
// and the pure verdicts each step reaches from what the page drew. The steps themselves run live (the lead).

const ERAS = ['ac1999-retail', 'eor', 'classicace-customdm'] as const;
const plan = (era: string, admin = false) => withRegressionSteps(playthroughSteps(eraPlan(era), { admin }), regressionSteps(eraPlan(era), { admin }));

describe('regression steps: where they run and --only', () => {
  it('every era runs all nine; option-defaults and pack-space right after entering the world, the rest before @help; the run still ends with the logout', () => {
    for (const e of ERAS) {
      const ids = plan(e).map((s) => s.id);
      for (const id of REGRESSION_STEP_IDS) expect(ids, `${e} ${id}`).toContain(id);
      expect(ids[0]).toBe('enter-world');
      expect(ids.slice(1, 3)).toEqual(['option-defaults', 'pack-space']);
      const rest = REGRESSION_STEP_IDS.slice(1).map((id) => ids.indexOf(id));
      expect(rest).toEqual([...rest].sort((a, b) => a - b));
      expect(ids.indexOf('create-character-click') + 1).toBe(ids.indexOf('cmd-help'));
      expect(ids.indexOf('pack-scroll-sort')).toBeGreaterThan(ids.indexOf('give-npc'));
      expect(ids.at(-1)).toBe('logout-relogin');
    }
  });
  it('with --admin the prep runs right before the magic, after the vendor and loot steps', () => {
    const ids = plan('ac1999-retail', true).map((s) => s.id);
    expect(ids.slice(0, 3)).toEqual(['enter-world', 'option-defaults', 'pack-space']);
    expect(ids.indexOf('admin-prep') + 1).toBe(ids.indexOf('magic-mode'));
    expect(ids.indexOf('admin-prep')).toBeGreaterThan(ids.indexOf('vendor-sell'));
  });
  it('--only runs a new step alone (the world entry and the pack-space check always; the --admin prep only for magic)', () => {
    expect(selectSteps(plan('eor'), ['pack-bars']).map((s) => s.id)).toEqual(['enter-world', 'pack-space', 'pack-bars']);
    expect(selectSteps(plan('ac1999-retail', true), ['shield-relog', 'running-jump-coast']).map((s) => s.id)).toEqual(['enter-world', 'pack-space', 'shield-relog', 'running-jump-coast']);
    expect(selectSteps(plan('ac1999-retail', true), ['cast-self']).map((s) => s.id)).toEqual(['enter-world', 'pack-space', 'admin-prep', 'cast-self']);
    expect(selectSteps(plan('classicace-customdm'), ['option-defaults']).map((s) => s.id)).toEqual(['enter-world', 'option-defaults', 'pack-space']);
    expect(() => selectSteps(plan('eor'), ['pack-bar'])).toThrow(/unknown step id.*pack-bars/);
  });
  it('every era has spawn and set-health commands for --admin', () => {
    expect(ADMIN_COMMANDS['ac1999-retail'].spawn(511)).toBe('@spawnwcidinv 511');
    expect(ADMIN_COMMANDS.eor.spawn(511)).toBe('@ci 511');
    expect(ADMIN_COMMANDS['classicace-customdm'].setHealth(9)).toBe('@sethealth 9');
  });
  it('the report names the era\'s steps a --only run left out', () => {
    const all = plan('eor');
    const res = { records: [{ id: 'enter-world', title: 'Enter the world', status: 'ok' as const, detail: 'in', problems: [], screenshots: [], ms: 1000, signals: emptySignals() },
      { id: 'pack-bars', title: 'bars', status: 'ok' as const, detail: 'drawn', problems: [], screenshots: [], ms: 1000, signals: emptySignals() }], aborted: null };
    const md = renderReport(res, { era: eraPlan('eor'), url: 'http://x/?password=p', account: 'a', character: 'C', started: new Date(0), finished: new Date(1000), planned: all });
    expect(md).toMatch(/Not run this time \(--only\): .*`option-defaults`.*`pack-scroll-sort`/);
    expect(md).not.toMatch(/Not run this time[^\n]*`pack-bars`/);
    expect(md).toMatch(/\| 2 \| bars \(`pack-bars`\) \| ok \|/);
  });
});

describe('option-defaults: the era\'s fresh-profile values', () => {
  it('1999: Environment Detail Textures off, both texture menus Full; end of retail and Dark Majesty: on, Medium / High', () => {
    const want = (e: string) => Object.fromEntries(optionDefaultsFor(eraPlan(e)).map((o) => [o.key, o.kind === 'menu' ? o.label : o.on]));
    expect(want('ac1999-retail')).toEqual({ buildingDetailTextures: false, landscapeTextureDetail: 'Full', environmentTextureDetail: 'Full', landscapeDetailTextures: false });
    for (const e of ['eor', 'classicace-customdm']) expect(want(e)).toEqual({ buildingDetailTextures: true, landscapeTextureDetail: 'Medium', environmentTextureDetail: 'High', landscapeDetailTextures: false });
  });
  const want1999 = optionDefaultsFor(eraPlan('ac1999-retail'));
  const good = [
    { key: 'buildingDetailTextures', present: true, kind: 'toggle' as const, visible: true, on: false, art: 'off' as const },
    { key: 'landscapeTextureDetail', present: true, kind: 'menu' as const, visible: true, value: 'Full' },
    { key: 'environmentTextureDetail', present: true, kind: 'menu' as const, visible: true, value: 'full' },
    { key: 'landscapeDetailTextures', present: false },
  ];
  it('rows that show the defaults pass (an optional row the era doesn\'t draw is fine)', () => {
    expect(judgeOptionDefaults(want1999, good)).toEqual([]);
  });
  it('a wrong value, a bullet drawing the other art, a covered row and a missing row each fail', () => {
    const bad = good.map((r) => (r.key === 'buildingDetailTextures' ? { ...r, on: true, art: 'on' as const } : r.key === 'landscapeTextureDetail' ? { ...r, value: 'Medium', visible: false } : r));
    const p = judgeOptionDefaults(want1999, bad).join('\n');
    expect(p).toMatch(/buildingDetailTextures: on, the era's default is off/);
    expect(p).toMatch(/buildingDetailTextures: the bullet draws the on art, not off/);
    expect(p).toMatch(/landscapeTextureDetail: shows "Medium", the era's default is "Full"/);
    expect(p).toMatch(/landscapeTextureDetail: the row is covered/);
    expect(judgeOptionDefaults(want1999, good.filter((r) => r.key !== 'environmentTextureDetail'))).toEqual(['environmentTextureDetail: no row on the Config page']);
  });
  it('the bullet art must agree with the row state (data-option-on alone is not what the player sees)', () => {
    const p = judgeOptionDefaults(want1999, good.map((r) => (r.key === 'buildingDetailTextures' ? { ...r, art: 'on' as const } : r)));
    expect(p).toEqual(['buildingDetailTextures: the bullet draws the on art, not off']);
  });
  it('a reused profile (--profile) skips: its options are what it saved', async () => {
    const d = new FakeDriver();
    d.freshProfile = false;
    const r = await optionDefaultsStep().run(ctxOf(d));
    expect(r.status).toBe('skipped');
    expect(r.detail).toMatch(/reuses a browser profile/);
  });
});

/** A 6-column grid of `n` items in a 3-row (96 px) viewport scrolled to `scrollTop`, cells laid out on screen. */
function gridOf(n: number, scrollTop: number, opts: { slots?: number; bottomHit?: number; order?: number[] } = {}): GridState {
  const slots = opts.slots ?? 102;
  const viewport = { x: 100, y: 200, w: 192, h: 96 };
  const order = opts.order ?? Array.from({ length: n }, (_, i) => 0x8000_0000 + i);
  const cells: GridCell[] = Array.from({ length: slots }, (_, i) => ({
    i, guid: i < n ? order[i] : 0, rect: { x: 100 + (i % 6) * 32, y: 200 + Math.floor(i / 6) * 32 - scrollTop, w: 32, h: 32 },
  }));
  const bottom = bottomRowAt(scrollTop, 96, 32);
  return { cols: 6, rowPx: 32, clientHeight: 96, scrollTop, maxScroll: Math.ceil(slots / 6) * 32 - 96, viewport, down: { x: 300, y: 280, w: 16, h: 16 }, up: { x: 300, y: 200, w: 16, h: 16 }, cells, bottomHit: opts.bottomHit ?? bottom * 6 };
}

describe('pack-scroll-sort: filling, scrolling and the drag (webac#27)', () => {
  it('fills until the last item sits two rows past a 3-row viewport', () => {
    expect(visibleRowsOf(96, 32)).toBe(3);
    expect(fillNeeded(10, 3, 6)).toBe(15); // 25 items: the last in row 5 (index 24)
    expect(fillNeeded(30, 3, 6)).toBe(0);
    expect(rowOf(24, 6)).toBe(4);
  });
  it('scrolls so the last item\'s row is the bottom one, in whole rows, within the list', () => {
    expect(scrollTargetFor(24, 6, 32, 96, 1536)).toBe(64); // rows 2-4 on screen
    expect(scrollTargetFor(4, 6, 32, 96, 1536)).toBe(0);
    expect(scrollTargetFor(101, 6, 32, 96, 448)).toBe(448); // the last of 102 fixed cells: the list's end
    expect(bottomRowAt(64, 96, 32)).toBe(4);
  });
  it('drags an item of the bottom row onto one in the row above', () => {
    const g = gridOf(25, 64);
    const pair = pickDragPair(g)!;
    expect(rowOf(pair.from.i, 6)).toBe(4);
    expect(pair.from.i).toBe(24);
    expect(rowOf(pair.to.i, 6)).toBe(3);
  });
  it('no pair when the bottom row holds nothing', () => {
    expect(pickDragPair(gridOf(12, 64))).toBeNull();
  });
  it('kept: the same offset and the same bottom row after the move pass', () => {
    const before = gridOf(25, 64);
    const moved = before.cells[24].guid;
    const order = before.cells.slice(0, 25).map((c) => c.guid).filter((g) => g !== moved);
    order.splice(18, 0, moved);
    expect(judgeScrollKept(before, gridOf(25, 64, { order }), moved)).toEqual([]);
  });
  it('reset to the top (the reported bug) fails twice over: the offset and the rows on screen', () => {
    const before = gridOf(25, 64);
    const moved = before.cells[24].guid;
    const order = before.cells.slice(0, 25).map((c) => c.guid).filter((g) => g !== moved);
    order.splice(18, 0, moved);
    const p = judgeScrollKept(before, gridOf(25, 0, { order, bottomHit: 12 }), moved);
    expect(p.join('\n')).toMatch(/scroll offset went from 64 px to 0 px \(webac#27/);
    expect(p.join('\n')).toMatch(/bottom row shows grid row 2 .*not row 4/);
  });
  it('a drag that moved nothing is reported (the check can\'t be judged)', () => {
    const before = gridOf(25, 64);
    expect(judgeScrollKept(before, gridOf(25, 64), before.cells[24].guid)[0]).toMatch(/moved nothing/);
  });
});

describe('pack-bars: the meters as drawn (webac#25)', () => {
  it('a side pack holding 3 of 12 shows a quarter; a used kit 12 of 20 shows 60%', () => {
    expect(judgeMeter('sack', { shown: true, barH: 30, fillH: 8, covered: false }, capacityBarFraction(12, 3))).toEqual([]);
    expect(judgeMeter('kit', { shown: true, barH: 30, fillH: 18, covered: false }, structureBarFraction(12, 20))).toEqual([]);
  });
  it('a missing bar, a wrong fill and a covered cell each fail; a bar where none belongs fails', () => {
    expect(judgeMeter('kit', { shown: false, barH: 0, fillH: 0, covered: false }, 0.6)[0]).toMatch(/no bar drawn \(it should show 60%\)/);
    expect(judgeMeter('kit', null, 0.6)[0]).toMatch(/no bar drawn/);
    expect(judgeMeter('kit', { shown: true, barH: 30, fillH: 30, covered: false }, 0.6)[0]).toMatch(/fill shows 100%, it should show 60%/);
    expect(judgeMeter('kit', { shown: true, barH: 30, fillH: 18, covered: true }, 0.6)[0]).toMatch(/drawn over the cell/);
    expect(judgeMeter('full kit', { shown: true, barH: 30, fillH: 30, covered: false }, structureBarFraction(20, 20))[0]).toMatch(/drawn where none should be/);
    expect(judgeMeter('empty sack', null, capacityBarFraction(12, 0))).toEqual([]);
  });
  it('a meter scaled with the HUD (45 px bar) is judged by its fraction', () => {
    expect(judgeMeter('kit', { shown: true, barH: 45, fillH: 27, covered: false }, 0.6)).toEqual([]);
  });
  it('a used kit or lockpick is one below its max uses; a full one or a sword is not', () => {
    const it = (name: string, structure?: number, maxStructure?: number) => ({ guid: 1, name, wcid: 628, container: 0, structure, maxStructure, itemType: 0, validLocations: 0 });
    expect(usedTool(it('Crude Healing Kit', 19, 20))).toBe(true);
    expect(usedTool(it('Crude Lockpick', 3, 20))).toBe(true);
    expect(usedTool(it('Crude Healing Kit', 20, 20))).toBe(false);
    expect(usedTool(it('Sword', 5, 10))).toBe(false);
  });
  it('what pack-bars may put in the side pack: never a kit or lockpick (fast run 4 moved the Handy Healing Kit into the Sack), a pack or a wearable', () => {
    const it = (name: string, o: { maxStructure?: number; itemType?: number; validLocations?: number } = {}) => ({ name, itemType: o.itemType ?? 0x80, validLocations: o.validLocations ?? 0, maxStructure: o.maxStructure });
    expect(sidePackFiller(it('Handy Healing Kit', { maxStructure: 20 }))).toBe(false);
    expect(sidePackFiller(it('Crude Lockpick'))).toBe(false);
    expect(sidePackFiller(it('Sack', { itemType: 0x200 }))).toBe(false);
    expect(sidePackFiller(it('Leather Cap', { validLocations: 0x1 }))).toBe(false);
    expect(sidePackFiller(it('Calling Stone'))).toBe(true);
  });
  it('the kit goes on the first empty of slots 2-9 (slot 1 is toolbar-relog\'s), or stays where it already is', () => {
    expect(freeShortcutSlot([5, 6, 0, 0], 9)).toBe(2);
    expect(freeShortcutSlot([0, 0, 0], 9)).toBe(1);
    expect(freeShortcutSlot([5, 6, 9], 9)).toBe(2);
    expect(freeShortcutSlot([1, 2, 3, 4, 5, 6, 7, 8, 9], 99)).toBe(-1);
  });
});

describe('shield-relog: what the shield DRAWS after the relog against right after equipping (webac#26)', () => {
  const equipLine = '[Wield] Attached Metal Round Shield (setup 0x2000155) to part_14 (location=3, placement=6 from ParentEvent, frame=0)';
  const loginLine = '[Wield] Attached Metal Round Shield (setup 0x2000155) to part_14 (location=3, placement=0 from CreateObject, frame=0)';
  const restingLine = '[Wield] Attached Metal Round Shield (setup 0x2000155) to part_14 (location=3, placement=101 from CreateObject, frame=101)';
  it('parses the player\'s attach line; a creature\'s line and an undefined placement are not it', () => {
    expect(parseWieldLine(equipLine)).toEqual({ name: 'Metal Round Shield', placement: 6, source: 'ParentEvent', frame: 0 });
    expect(parseWieldLine('[Wield] Attached Metal Round Shield to Drudge Skulker part_3 (location=3, placement=0 from CreateObject, frame=0)')).toBeNull();
    expect(parseWieldLine('[Wield] Attached Metal Round Shield (setup 0x2000155) to part_14 (location=3, placement=undefined from CreateObject)')).toBeNull();
    expect(lastWield(['x', equipLine, '[Wield] Attached Sword (setup 0x1) to part_10 (location=1, placement=0 from CreateObject, frame=0)'], 'Metal Round Shield')?.placement).toBe(6);
  });
  it('placement 6 at the equip and 0 after the relog, drawing the same pose, pass (the 2026-11-07 false failure)', async () => {
    const same = await runShield([equipLine], [loginLine], SHIELD_POSE, SHIELD_POSE);
    expect(same.status).toBe('ok');
    expect(same.detail).toMatch(/placement 6 → frame 0 \(ParentEvent\) right after equipping, placement 0 \(CreateObject\) after the relog: the same pose/);
  });
  it('the Resting (0x65) pose after the relog fails as webac#26', async () => {
    const bad = await runShield([equipLine], [restingLine], SHIELD_POSE, RESTING_POSE);
    expect(bad.status).toBe('fail');
    expect(bad.detail).toMatch(/placement 101 \(CreateObject\) after the relog: the relog draws it differently \(part_0 turned 90\.0°\) \(webac#26\)/);
  });
  it('no acDebug.heldPose: the resolved frames from the attach lines decide', async () => {
    expect((await runShield([equipLine], [loginLine])).status).toBe('ok');
    expect((await runShield([equipLine], [restingLine])).status).toBe('fail');
  });
  it('no shield held and no --admin: a skip that says how to get one', async () => {
    const d = new FakeDriver({ ...heldHandlers([]) });
    const r = await shieldRelogStep().run(ctxOf(d));
    expect(r.status).toBe('skipped');
    expect(r.detail).toMatch(/no shield held \(run with --admin/);
  });
});

describe('toolbar-relog: the slot draws the item\'s own icon, not only its guid', () => {
  it('a different drawn icon is named; a pending or missing icon is not judged', () => {
    expect(judgeShortcutIcon('url("data:a")', 'url("data:a")', 'Crude Lockpick')).toBeNull();
    expect(judgeShortcutIcon('url("data:b")', 'url("data:a")', 'Crude Lockpick')).toMatch(/draws a different icon than Crude Lockpick's own pack cell/);
    expect(judgeShortcutIcon(null, 'url("data:a")', 'x')).toBeNull();
    expect(judgeShortcutIcon('url("data:a")', undefined, 'x')).toBeNull();
  });
});

describe('running-jump-coast: the coast after landing (BUG.remote-running-jump-snapback)', () => {
  /** Run at `v` m/s, jump (airborne `air` s), then coast as calc_friction does (v e^-ln20·t) or stop dead. */
  function jump(v: number, opts: { dead?: boolean; air?: number } = {}): MoveSample[] {
    const out: MoveSample[] = [];
    let t = 0, x = 0;
    const dt = 16;
    for (; t < 1500; t += dt) { x += v * dt / 1000; out.push({ t, x, z: 0, g: true }); }
    const land = t + (opts.air ?? 0.6) * 1000;
    for (; t < land; t += dt) { x += v * dt / 1000; out.push({ t, x, z: 0, g: false }); }
    let s = opts.dead ? 0 : v;
    for (const end = t + 3000; t < end; t += dt) { x += s * dt / 1000; s *= Math.exp(-Math.log(20) * dt / 1000); out.push({ t, x, z: 0, g: true }); }
    return out;
  }
  it('retail\'s coast is v / ln 20: 2.18 m at 6.54 m/s', () => {
    expect(6.54 * RETAIL_COAST_PER_MPS).toBeCloseTo(2.18, 2);
  });
  it('a calc_friction coast measures v / ln 20 and passes', () => {
    const c = coastFromSamples(jump(6.54));
    if (typeof c === 'string') throw new Error(c);
    expect(c.landingSpeed).toBeCloseTo(6.54, 1);
    expect(c.coast).toBeGreaterThan(2.0);
    expect(c.coast).toBeLessThan(2.25);
    expect(judgeCoast(c)).toEqual([]);
  });
  it('a dead stop at touchdown fails as the regression', () => {
    const c = coastFromSamples(jump(6.54, { dead: true }));
    if (typeof c === 'string') throw new Error(c);
    expect(c.coast).toBeLessThan(0.15);
    expect(judgeCoast(c)[0]).toMatch(/a dead stop \(BUG.remote-running-jump-snapback\)/);
  });
  it('no jump, no landing, a frame jump of metres and a walk-speed landing are each named', () => {
    expect(coastFromSamples(jump(6).map((s) => ({ ...s, g: true })))).toMatch(/never left the ground/);
    expect(coastFromSamples(jump(6).slice(0, 110))).toMatch(/never landed/);
    const tp = jump(6); tp[50] = { ...tp[50], x: tp[50].x + 50 };
    expect(coastFromSamples(tp)).toMatch(/jumped more than 3 m/);
    const walk = coastFromSamples(jump(1.2));
    if (typeof walk === 'string') throw new Error(walk);
    expect(judgeCoast(walk)[0]).toMatch(/not a running jump/);
  });
  it('a run that never stops is named, not passed', () => {
    const s = jump(6.54);
    const going = s.map((p, i) => ({ ...p, x: p.x + (i > 130 ? (i - 130) * 0.1 : 0) }));
    expect(coastFromSamples(going)).toMatch(/never came to rest/);
  });
});

describe('create-character-click: chargen opens, Please Wait until it does (UX.chargen-click-during-texture-load)', () => {
  const p = (t: number, screen: string, waiting = false): ChargenPoll => ({ t, screen, waiting });
  it('Please Wait, then chargen: ok, and it says it waited', () => {
    const v = judgeChargenWait([p(250, 'character-select'), p(750, 'character-select', true), p(4000, 'character-select', true), p(4250, 'character-create')]);
    expect(v.ok).toBe(true);
    expect(v.detail).toMatch(/opened 4\.3 s after the click, behind Please Wait/);
  });
  it('chargen at once is ok', () => {
    expect(judgeChargenWait([p(250, 'character-create')]).ok).toBe(true);
  });
  it('the click lost (char select with no Please Wait after the grace) fails', () => {
    const v = judgeChargenWait([p(250, 'character-select'), p(750, 'character-select'), p(1000, 'character-select')]);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/0\.8 s after the click neither chargen nor Please Wait.*lost/);
  });
  it('Please Wait that never ends fails', () => {
    const v = judgeChargenWait([p(250, 'character-select', true), p(90_000, 'character-select', true)]);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/never opened in 90 s/);
  });
});

// ── A fake page for the step runs ──────────────────────────────────────────

const HEALTHY: ClientProbe = { screen: 'world', inventoryRequest: null, busy: 0, dead: false, health: 1, character: 'Tester' };

class FakeDriver implements PlaythroughDriver {
  t = 0;
  sig: Signals = emptySignals();
  lines: string[] = [];
  freshProfile = true;
  screen = 'world';
  constructor(public handlers: Record<string, (...a: any[]) => unknown> = {}) {}
  enterWorld() { return Promise.resolve({ ok: true, detail: 'in' }); }
  async call<T>(method: string, args: unknown[] = []): Promise<T> {
    const h = this.handlers[method];
    if (!h) throw new Error(`unexpected call ${method}`);
    return (await h(...args)) as T;
  }
  probe() { return Promise.resolve({ ...HEALTHY, screen: this.screen }); }
  uiState() { return Promise.resolve({}); }
  async chat() { /* none */ }
  peek(): Signals { return this.sig; }
  drain(): Signals { const s = this.sig; this.sig = emptySignals(); return s; }
  npcCreatures(g: number[]) { return Promise.resolve(g); }
  vendorStock() { return Promise.resolve(null); }
  placeOf() { return Promise.resolve({ me: 'outdoors' as const, objects: {} }); }
  magicFacts() { return Promise.resolve({ skills: [], mana: {} }); }
  clickIndicator() { return Promise.resolve({ found: false, lit: false }); }
  screenshot(name: string) { return Promise.resolve(`${name}.png`); }
  sleep(ms: number) { this.t += ms; this.handlers.onSleep?.(ms); return Promise.resolve(); }
  now() { return this.t; }
  async evaluate<T>(js: string): Promise<T> { return (await this.handlers.evaluate?.(js)) as T; }
  async click() { /* none */ }
  async drag() { /* none */ }
  async key() { /* none */ }
  consoleLines() { return this.lines; }
}

const ctxOf = (driver: FakeDriver, era = 'ac1999-retail'): StepContext => ({ driver, era: eraPlan(era), facts: null, state: { ...freshState(), character: 'Tester' }, log: () => undefined });

/** evaluate() answering HELD_JS with these items (everything else null). */
function heldHandlers(items: Array<{ guid: number; name: string; validLocations: number }>, equipped: typeof items = []) {
  const m = (i: (typeof items)[number]) => ({ ...i, wcid: 1313, container: 1, itemType: 2, structure: undefined, maxStructure: undefined });
  return { evaluate: (js: string) => (js.includes('sidePackGuids') ? { packs: [1], items: items.map(m), equipped: equipped.map(m), mainCapacity: 102, selectedPack: 0, open: false } : null) };
}

const posed = (q: [number, number, number, number], frame = 0): HeldPose => ({
  placement: frame, frame, holding: { p: [0.05, -0.02, 0.1], q: [0, 0, 0, 1] },
  parts: [{ name: 'part_0', p: [0, 0, 0], q }],
});
/** The 1999 shield at frame 0 (identity) and at Resting 0x65 (-90° about X, AC (w, x) = (√½, -√½) swapped to three.js). */
const SHIELD_POSE = posed([0, 0, 0, 1]);
const RESTING_POSE = posed([Math.SQRT1_2, 0, 0, Math.SQRT1_2], 101);

/** Run shield-relog with the attach lines the client logs and the poses acDebug.heldPose reports at the equip and after the relog (none: no hook). */
async function runShield(atEquip: string[], atLogin: string[], equipPose?: HeldPose, loginPose?: HeldPose) {
  const shield = { guid: 0x8000_0042, name: 'Metal Round Shield', validLocations: 0x00200000 };
  let pose: HeldPose | undefined;
  const base = heldHandlers([shield]);
  const d: FakeDriver = new FakeDriver({
    ...base,
    evaluate: (js: string) => (js.includes('heldPose') ? (equipPose ? pose ?? null : 'no-hook') : base.evaluate(js)),
    equip: () => { d.lines.push(...atEquip); pose = equipPose; return { ok: true, message: 'wielded' }; },
    logout: () => { d.screen = 'character-select'; pose = undefined; },
    enterWorld: () => { d.screen = 'world'; d.lines.push(...atLogin); pose = loginPose; return { ok: true, message: 'in the world' }; },
  });
  return shieldRelogStep().run(ctxOf(d));
}

describe('a regression step inside the run is judged like any other', () => {
  it('the shield step\'s outcome lands in the run\'s records', async () => {
    const shield = { guid: 7, name: 'Metal Round Shield', validLocations: 0x00200000 };
    const d: FakeDriver = new FakeDriver({
      ...heldHandlers([shield]),
      equip: () => { d.lines.push('[Wield] Attached Metal Round Shield (setup 0x1) to part_14 (location=3, placement=6 from ParentEvent, frame=0)'); return { ok: true, message: 'ok' }; },
      logout: () => { d.screen = 'character-select'; },
      enterWorld: () => { d.screen = 'world'; d.lines.push('[Wield] Attached Metal Round Shield (setup 0x1) to part_14 (location=3, placement=0 from CreateObject, frame=0)'); return { ok: true, message: 'in' }; },
    });
    const res = await runPlaythrough(selectSteps(plan('ac1999-retail'), ['shield-relog']).filter((s) => s.id === 'shield-relog'), ctxOf(d));
    expect(res.records.map((r) => [r.id, r.status])).toEqual([['shield-relog', 'ok']]);
  });
});

describe('walk-short: the live gate\'s smoke walk', () => {
  it('judgeWalk passes a walk of at least the minimum, fails a stand-still or a missing position', () => {
    expect(judgeWalk({ x: 0, y: 0 }, { x: 3, y: 4 })).toEqual([]);
    expect(judgeWalk({ x: 0, y: 0 }, { x: 0.5, y: 0 })).toEqual([`moved 0.50 m (want at least ${WALK_SHORT_MIN_MOVED} m)`]);
    expect(judgeWalk(null, { x: 1, y: 1 })).toEqual(['the agent API has no position']);
  });
  it('pointAlong: 0° is north (+y), 90° east (+x)', () => {
    const n = pointAlong({ x: 10, y: 10 }, 0, 8);
    expect(n.x).toBeCloseTo(10); expect(n.y).toBeCloseTo(18);
    const e = pointAlong({ x: 10, y: 10 }, 90, 8);
    expect(e.x).toBeCloseTo(18); expect(e.y).toBeCloseTo(10);
  });
  const walkDriver = (opts: { openBearing: number | null; moves: boolean }) => {
    let at = { x: 100, y: 100, heading: 0 };
    const asked: string[] = [];
    const d = new FakeDriver({
      close: () => undefined,
      where: () => ({ ...at }),
      // Open ground only along `openBearing`: the probe reaches the point there, stops 3 m short elsewhere.
      probe: (to: { x: number; y: number }) => {
        if (opts.openBearing === null) return { x: at.x, y: at.y };
        const p = pointAlong(at, opts.openBearing, WALK_SHORT_METRES);
        return Math.hypot(p.x - to.x, p.y - to.y) < 0.01 ? to : { x: at.x, y: at.y };
      },
      walkTo: (target: string) => { asked.push(target); if (opts.moves) at = { ...at, x: at.x + 5 }; return { ok: opts.moves, message: opts.moves ? 'arrived' : 'blocked' }; },
    });
    return { d, asked };
  };
  it('walks toward a compass point with open ground and passes when the position follows', async () => {
    const { d, asked } = walkDriver({ openBearing: 270, moves: true });
    const res = await runPlaythrough([walkShortStep()], ctxOf(d, 'eor'));
    expect(asked).toEqual([`${WALK_SHORT_METRES - 0.5}m W`]);
    expect(res.records.map((r) => [r.id, r.status])).toEqual([['walk-short', 'ok']]);
  });
  it('walkPlan: the most open bearing, half a metre short of what stopped the probe; boxed in (under 2.5 m) gives none', () => {
    expect(walkPlan([{ bearing: 270, reach: 2 }, { bearing: 180, reach: 3 }, { bearing: 0, reach: 2 }])).toEqual({ bearing: 180, metres: 2.5 });
    expect(walkPlan([{ bearing: 90, reach: 20 }])).toEqual({ bearing: 90, metres: WALK_SHORT_METRES });
    expect(walkPlan([{ bearing: 90, reach: 2.4 }, { bearing: 0, reach: 1 }])).toBeNull();
  });
  it('fast run 5 (a fresh AC1999 character in a small room: S 3 m, N 2 m, E 2 m, W 2 m): it walks S, the most open way', async () => {
    let at = { x: 100, y: 100 };
    const asked: unknown[] = [];
    const reach: Record<number, number> = { 0: 2, 90: 2, 180: 3, 270: 2, 45: 1, 135: 1, 225: 1, 315: 1 };
    const d = new FakeDriver({
      close: () => undefined,
      where: () => ({ ...at }),
      probe: (to: { x: number; y: number }) => {
        const b = WALK_BEARINGS.find((bb) => { const p = pointAlong(at, bb, WALK_SHORT_METRES); return Math.hypot(p.x - to.x, p.y - to.y) < 0.01; })!;
        return pointAlong(at, b, reach[b]);
      },
      walkTo: (target: unknown) => { asked.push(target); at = { ...at, y: at.y - 2.5 }; return { ok: true, message: 'arrived' }; },
    });
    const res = await runPlaythrough([walkShortStep()], ctxOf(d, 'ac1999-retail'));
    expect(asked).toEqual(['2.5m S']);
    expect(res.records[0].status).toBe('ok');
  });
  it('boxed in: out through the nearest door; with no door it fails saying so (never a pass on 0 m)', async () => {
    let at = { x: 100, y: 100 };
    const asked: unknown[] = [];
    const mk = (doors: Array<{ guid: number; name: string; kind: string; dist: number }>) => new FakeDriver({
      close: () => undefined,
      where: () => ({ ...at }),
      probe: () => ({ ...at }),
      observe: () => ({ nearby: doors }),
      walkTo: (target: unknown) => { asked.push(target); at = { ...at, x: at.x + 6 }; return { ok: true, message: 'arrived' }; },
    });
    const res = await runPlaythrough([walkShortStep()], ctxOf(mk([{ guid: 0x7001, name: 'Door', kind: 'door', dist: 4 }]), 'ac1999-retail'));
    expect(asked).toEqual([0x7001]);
    expect(res.records[0].status).toBe('ok');
    expect(res.records[0].detail).toContain('out through Door 4 m off');
    const none = await runPlaythrough([walkShortStep()], ctxOf(mk([]), 'ac1999-retail'));
    expect(none.records[0].status).toBe('fail');
    expect(none.records[0].detail).toMatch(/^boxed in: no bearing has 2.5 m open/);
  });
  it('a walk that goes nowhere fails, naming the distance', async () => {
    const { d } = walkDriver({ openBearing: 270, moves: false });
    const res = await runPlaythrough([walkShortStep()], ctxOf(d, 'eor'));
    expect(res.records[0].status).toBe('fail');
    expect(res.records[0].detail).toContain('moved 0.00 m');
  });
  it('the 1999 tray refuses an unusable item exactly as ShortcutSlot::AcceptDragObject @ 0x00500240 does (fast run 5\'s Calling Stone, ItemUseable No); other eras take any', () => {
    const callingStone = { usable: 1, itemType: 0x800, validLocations: 0 };
    expect(shortcutTrayRefusal('ac1999-retail', callingStone)).toBe('Only usable items can go here');
    expect(shortcutTrayRefusal('eor', callingStone)).toBeNull();
    expect(shortcutTrayRefusal('ac1999-retail', { usable: 0x20000000 | 0x8, itemType: 0x80, validLocations: 0 })).toBeNull(); // usable
    expect(shortcutTrayRefusal('ac1999-retail', { usable: 1, itemType: 0x2, validLocations: 0x1 })).toBeNull(); // wearable
    expect(shortcutTrayRefusal('ac1999-retail', { usable: 1, itemType: 0x8000, validLocations: 0 })).toBeNull(); // a caster
  });
  it('is part of every era\'s plan, after option-defaults and before the pack steps', () => {
    for (const e of ERAS) {
      const ids = plan(e).map((s) => s.id);
      expect(ids.indexOf('walk-short')).toBeGreaterThan(ids.indexOf('option-defaults'));
      expect(ids.indexOf('walk-short')).toBeLessThan(ids.indexOf('pack-scroll-sort'));
    }
  });
});

describe('keys to the 3D view (the live gate\'s first fast run: ClassicACE\'s welcome Book ate the jump\'s keys)', () => {
  const clear: KeysState = { open: [], under: 'canvas#game', underIsWorld: true, focus: 'body', typing: false };
  it('judgeKeysState names what would take the keys', () => {
    expect(judgeKeysState(clear)).toEqual([]);
    expect(judgeKeysState({ ...clear, open: ['Book'] })).toEqual(['still open after closing every window: Book']);
    expect(judgeKeysState({ ...clear, under: 'div#book-panel', underIsWorld: false })).toEqual(["the 3D view's click point is covered by div#book-panel"]);
    expect(judgeKeysState({ ...clear, typing: true, focus: 'textarea#book-editor' })).toEqual(['a text field keeps the focus (textarea#book-editor)']);
    expect(judgeKeysState(null)).toEqual(['the page answered nothing']);
  });
  it('readyForKeys closes every window, then a window still listed by name, then clicks the 3D view', async () => {
    let open = ['Book'];
    const closed: string[] = [];
    let clicks = 0;
    const d = new FakeDriver({
      close: (w: string) => { closed.push(w); if (w !== 'all') open = open.filter((x) => x !== w); },
      evaluate: (js: string) => (js.includes('innerWidth') ? { w: 1000, h: 800 } : { ...clear, open: [...open] }),
    });
    d.click = async () => { clicks++; };
    expect(await readyForKeys(ctxOf(d, 'classicace-customdm'))).toEqual([]);
    expect(closed).toEqual(['all', 'Book']);
    expect(clicks).toBe(1);
  });
  it('a window that will not close fails the step with the reason, before any key is pressed', async () => {
    const d = new FakeDriver({
      close: () => undefined,
      where: () => ({ x: 0, y: 0, z: 0, heading: 0 }),
      probe: (to: { x: number; y: number }) => to, // open ground everywhere
      turn: () => undefined,
      evaluate: (js: string) => (js.includes('innerWidth') ? { w: 1000, h: 800 } : { ...clear, open: ['Book'] }),
    });
    let keys = 0;
    d.key = async () => { keys++; };
    const res = await runPlaythrough([runningJumpCoastStep()], ctxOf(d, 'classicace-customdm'));
    expect(res.records[0].status).toBe('fail');
    expect(res.records[0].detail).toBe('the keys would not reach the 3D view: still open after closing every window: Book');
    expect(keys).toBe(0);
  });
});

// Fast run 2 (2026-11-07): spawned filler and admin components filled ClassicACE's pack, and the vendor steps failed
// on "not enough pack space". Every step now leaves the character as it found it.
describe('a step leaves the character as it found it', () => {
  type HI = { guid: number; name: string; wcid: number; container: number; itemType: number; validLocations: number };
  const MAIN = 0x50000001;
  const hi = (guid: number, wcid: number, container = MAIN): HI => ({ guid, name: wcid === 511 ? 'Crude Lockpick' : wcid === 166 ? 'Sack' : `Item ${guid}`, wcid, container, itemType: 0x80, validLocations: 0 });
  const heldDriver = (state: { packs: number[]; items: HI[]; equipped: HI[]; mainCapacity: number }, extra: Record<string, (...a: any[]) => unknown> = {}) => {
    const dropped: number[] = [];
    const moved: Array<[number, number]> = [];
    const d = new FakeDriver({
      evaluate: (js: string) => (js.includes('sidePackGuids') ? { ...state, selectedPack: 0, open: false } : null),
      drop: (g: number) => { dropped.push(g); state.items = state.items.filter((i) => i.guid !== g && i.container !== g); state.packs = state.packs.filter((p) => p !== g); return { ok: true, message: 'dropped' }; },
      moveItem: (g: number, slot: number) => { moved.push([g, slot]); state.items = state.items.map((i) => (i.guid === g ? { ...i, container: state.packs[slot] } : i)); return { ok: true, message: 'moved' }; },
      unequip: (g: number) => { const e = state.equipped.find((x) => x.guid === g); state.equipped = state.equipped.filter((x) => x.guid !== g); if (e) state.items.push({ ...e, container: MAIN }); return { ok: true, message: 'off' }; },
      ...extra,
    });
    (d as unknown as { chat: (t: string) => Promise<void> }).chat = async (t: string) => { extra.onChat?.(t); };
    return { d, dropped, moved };
  };

  it('mainPackFree counts only the main pack (side packs and their contents are not in it)', () => {
    expect(mainPackFree({ packs: [MAIN, 9], mainCapacity: 102, items: [hi(1, 1), hi(2, 1), hi(9, 166), hi(3, 1, 9)] as never })).toBe(100);
  });

  it('pack-space drops leftover filler until enough main-pack slots are free; the character\'s own things stay', async () => {
    const own = Array.from({ length: 80 }, (_, i) => hi(100 + i, 999));
    const filler = Array.from({ length: 20 }, (_, i) => hi(500 + i, 511));
    const state = { packs: [MAIN], items: [...own, ...filler], equipped: [], mainCapacity: 102 };
    const { d, dropped } = heldDriver(state);
    const r = await packSpaceStep().run(ctxOf(d, 'classicace-customdm'));
    expect(r.status).toBe('ok');
    expect(dropped).toHaveLength(PACK_SPACE_WANTED - 2);
    expect(dropped.every((g) => g >= 500)).toBe(true);
    expect(mainPackFree(state as never)).toBe(PACK_SPACE_WANTED);
    // Full of its own things: a FAIL that says so (the vendor steps would fail for it anyway).
    const full = { packs: [MAIN], items: Array.from({ length: 100 }, (_, i) => hi(100 + i, 999)), equipped: [], mainCapacity: 102 };
    const r2 = await packSpaceStep().run(ctxOf(heldDriver(full).d, 'eor'));
    expect(r2.status).toBe('fail');
    expect(r2.detail).toContain('the pack is full of the character\'s own things');
  });

  it('leavesNoTrace drops what the step spawned (a worn shield taken off first; a spawned sack with its filler, the character\'s own item moved out first)', async () => {
    const state = { packs: [MAIN], items: [hi(1, 999)], equipped: [] as HI[], mainCapacity: 102 };
    const { d, dropped, moved } = heldDriver(state, {
      onChat: (t: string) => {
        if (t === '@ci 166') { state.packs.push(0x80000010); state.items.push(hi(0x80000010, 166)); }
        if (t === '@ci 511') state.items.push(hi(0x80000020 + state.items.length, 511, 0x80000010));
        if (t === '@ci 1313') state.equipped.push({ ...hi(0x80000030, 1313), name: 'Metal Round Shield' });
      },
    });
    const inner: Step = {
      id: 'x', title: 'x',
      async run(ctx) {
        await spawnHeld(ctx, 166, 1);
        await spawnHeld(ctx, 511, 1);
        state.items = state.items.map((i) => (i.guid === 1 ? { ...i, container: 0x80000010 } : i)); // the step moved an own item in
        state.equipped.push({ ...hi(0x80000030, 1313), name: 'Metal Round Shield' });
        state.items.push(hi(0x80000030, 1313)); // seen held once, then worn
        await spawnHeld(ctx, 1313, 1);
        state.items = state.items.filter((i) => i.guid !== 0x80000030);
        return { status: 'ok', detail: 'did it' };
      },
    };
    const r = await leavesNoTrace(inner).run(ctxOf(d, 'eor'));
    expect(r.status).toBe('ok');
    expect(moved).toEqual([[1, 0]]);
    expect(dropped).toContain(0x80000010);
    expect(state.items.map((i) => i.guid)).toEqual([1]);
    expect(r.detail).toMatch(/^did it; dropped the \d+ item\(s\) it spawned$/);
    // --keep-spawned leaves them.
    const s2 = { packs: [MAIN], items: [] as HI[], equipped: [] as HI[], mainCapacity: 102 };
    const k = heldDriver(s2, { onChat: () => { s2.items.push(hi(0x80000040, 511)); } });
    const spawnOne: Step = { id: 'y', title: 'y', async run(ctx) { await spawnHeld(ctx, 511, 1); return { status: 'ok', detail: 'kept' }; } };
    expect((await leavesNoTrace(spawnOne, { keepSpawned: true }).run(ctxOf(k.d, 'eor'))).detail).toBe('kept');
    expect(k.dropped).toEqual([]);
  });

  it('the spawning regression steps are wrapped; the plan runs them after the vendor and loot steps', () => {
    const ids = plan('eor', true).map((s) => s.id);
    for (const id of ['pack-scroll-sort', 'pack-bars', 'shield-relog']) {
      expect(ids.indexOf(id)).toBeGreaterThan(ids.indexOf('loot-rest'));
      expect(ids.indexOf(id)).toBeGreaterThan(ids.indexOf('vendor-supplies'));
    }
  });
});
