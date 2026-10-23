import { describe, expect, it } from 'vitest';
import {
  type ClientProbe, type PlaythroughDriver, type Signals, type Step, type StepContext, ONE_ITEM_AT_A_TIME,
  assessHealth, awayFrom, chatCommandStep, cheapestAffordable, confirmNoStep, emptySignals, eraPlan, exitCode, fail,
  freshState, killStep, logoutAndBackStep, mergeCreatureFacts, nearestTown, ok, panelStep, parseCreatureDanger, parsePlaythroughArgs,
  parseVendorListing, pickPrey, playthroughSteps, playthroughUrl, preyVerdict, renderReport, runPlaythrough,
  selectSteps, skip, statusLabel, vendorBuyStep,
  type VendorStockRow, type Place, type MagicFacts, type SkillRow, adminPrepStep, armForKill, castAtSelfStep, castVerdict, magicModeStep, pickCastable, schoolTrained, schoolsToTrain, selfEnchantment, atCreatureSpell, ADMIN_PREP_COMMANDS, acceptedGift, castAtCreatureStep, parseGiveTable, refusedSaleEcho, cellTarget, nearestVendorSpot, sameFloorOnly, vendorSpotsIn, vendorWeenies, giveCandidates, giveStep, planSupplies, preyReachable, saleEcho, vendorSellStep, vendorSuppliesStep,
} from '../tools/lib/playthrough.ts';
import type { AgentItem, AgentSpell } from '../packages/renderer/src/agent/types.ts';
import type { AgentObject } from '../packages/renderer/src/agent/types.ts';

// TOOL.ac1999-playthrough: the step runner, the health checks after each step and the report, driven by a fake
// client (the real one is Playwright + window.__acAgent in tools/ac1999-playthrough.ts, run live by the lead).

const HEALTHY: ClientProbe = { screen: 'world', inventoryRequest: null, busy: 0, dead: false, health: 1, character: 'Tester' };

class FakeDriver implements PlaythroughDriver {
  t = 0;
  sig: Signals = emptySignals();
  /** Probes handed out in order; the last one repeats. */
  probes: ClientProbe[] = [HEALTHY];
  ui: Record<string, unknown> | null = {};
  calls: Array<[string, unknown[]]> = [];
  chats: string[] = [];
  shots = 0;
  enter = { ok: true, detail: 'logged in' };
  constructor(public handlers: Record<string, (...a: any[]) => unknown> = {}) {}
  enterWorld() { return Promise.resolve(this.enter); }
  async call<T>(method: string, args: unknown[] = []): Promise<T> {
    this.calls.push([method, args]);
    const h = this.handlers[method];
    if (!h) throw new Error(`unexpected call ${method}`);
    return (await h(...args)) as T;
  }
  probe() { return Promise.resolve(this.probes.length > 1 ? this.probes.shift()! : this.probes[0]); }
  uiState() { return Promise.resolve(this.ui); }
  async chat(text: string) { this.chats.push(text); this.handlers.onChat?.(text); }
  peek(): Signals { return { chat: [...this.sig.chat], spew: [...this.sig.spew], consoleErrors: [...this.sig.consoleErrors], refusals: [...this.sig.refusals] }; }
  drains = 0;
  drain(): Signals { const s = this.sig; this.sig = emptySignals(); this.drains++; this.handlers.onDrain?.(this.drains); return s; }
  creatures: number[] | null = null;
  npcCreatures(guids: number[]) { return Promise.resolve(this.creatures ?? guids); }
  stock: VendorStockRow[] | null = null;
  vendorStock() { return Promise.resolve(this.stock); }
  places: { me: Place; objects: Record<number, Place> } = { me: 'outdoors', objects: {} };
  placeOf() { return Promise.resolve(this.places); }
  /** The magic steps' facts: no skills listed (training unknown) unless a test says. */
  magic: MagicFacts = { skills: [], mana: {} };
  magicFacts() { return Promise.resolve(this.magic); }
  indicator = { found: false, lit: false };
  indicatorClicks = 0;
  clickIndicator() { this.indicatorClicks++; this.handlers.onIndicator?.(); return Promise.resolve(this.indicator); }
  screenshot(name: string) { this.shots++; return Promise.resolve(`${this.shots}-${name}.png`); }
  sleep(ms: number) { this.t += ms; this.handlers.onSleep?.(ms); return Promise.resolve(); }
  now() { return this.t; }
}

const ctxOf = (driver: FakeDriver, era = 'ac1999-retail'): StepContext => ({ driver, era: eraPlan(era), facts: null, state: freshState(), log: () => undefined });
const step = (id: string, run: Step['run'], extra: Partial<Step> = {}): Step => ({ id, title: id, run, ...extra });
const mon = (name: string, dist: number, extra: Partial<AgentObject> = {}): AgentObject => ({ guid: Math.floor(dist * 100), name, kind: 'monster', dist, bearing: 90, relBearing: 0, dz: 0, ...extra });

describe('playthrough: health after a step', () => {
  it('a quiet, settled client is healthy', () => {
    expect(assessHealth(HEALTHY, emptySignals())).toEqual([]);
  });
  it('a pending inventory request, a busy cursor and a death are each a problem', () => {
    const p = assessHealth({ ...HEALTHY, inventoryRequest: { objectId: 0x8000_1234, request: 9 }, busy: 2, dead: true }, emptySignals());
    expect(p.join('\n')).toMatch(/still pending: \{"objectId":2147488308,"request":9\}/);
    expect(p.join('\n')).toMatch(/busy cursor count is 2/);
    expect(p.join('\n')).toMatch(/dead/);
  });
  it('"one item at a time" fails a step even when the step allows every line', () => {
    const s = { ...emptySignals(), spew: ['You can only move or use one item at a time'], chat: ['You can only move or use one item at a time'] };
    const p = assessHealth(HEALTHY, s, [/[\s\S]*/]);
    expect(p).toEqual(['"You can only move or use one item at a time"']);
    expect(ONE_ITEM_AT_A_TIME.test('You can only move or use one item at a time')).toBe(true);
  });
  it('an unexpected spew refusal fails; a notice (NOT_REFUSAL) and an allowed refusal do not', () => {
    const s = { ...emptySignals(), spew: ['You must select a suitable target before casting this spell', 'AutoRun ON', 'Casting Flame Bolt I', 'Your spell fizzled.'] };
    const p = assessHealth(HEALTHY, s, [/fizzle/i]);
    expect(p).toEqual(['unexpected refusal (spew): "You must select a suitable target before casting this spell"']);
  });
  it('chat lines are judged as refusals by REFUSAL_TEXT, once (a spew line is not counted again)', () => {
    const s = { ...emptySignals(), spew: ["You can't do that while in the air!"], chat: ["You can't do that while in the air!", 'Not enough pack space!', 'Bob says, "Hello."'] };
    const p = assessHealth(HEALTHY, s);
    expect(p).toEqual(['unexpected refusal (spew): "You can\'t do that while in the air!"', 'unexpected refusal (chat): "Not enough pack space!"']);
  });
  it('client_refusal telemetry: server codes count, the client\'s spew ones are left to the spew check', () => {
    const s = { ...emptySignals(), refusals: [
      { source: 'server', code: 'we:0x0029', context: 'weenie_error', text: null },
      { source: 'client', code: 'c:12345678', context: 'spew', text: 'You must select _' },
      { source: 'server', code: 'we:0x051b', context: 'weenie_error', text: '_ is not interested' },
    ] };
    expect(assessHealth(HEALTHY, s, [/not interested/])).toEqual(['client_refusal we:0x0029 (weenie_error) (no text shown)']);
  });
  it('console errors fail the step unless benign (favicon, telemetry posts)', () => {
    const s = { ...emptySignals(), consoleErrors: ['Failed to load resource (http://localhost:5291/favicon.ico)', 'uncaught: TypeError: x is undefined', 'Failed to load resource (http://localhost:9312/client-preworld)'] };
    expect(assessHealth(HEALTHY, s)).toEqual(['console error: uncaught: TypeError: x is undefined']);
  });
});

describe('playthrough: the run', () => {
  it('records each step; a health problem turns an ok step into FAIL; a skip stays a skip', async () => {
    const d = new FakeDriver();
    const steps = [
      step('a', async () => ok('fine')),
      step('b', async () => { d.sig.spew.push('You can only move or use one item at a time'); return ok('looked fine'); }),
      step('c', async () => skip('no vendor near')),
      step('d', async () => fail('broken')),
      step('e', async () => { throw new Error('boom'); }),
    ];
    const res = await runPlaythrough(steps, ctxOf(d));
    expect(res.records.map((r) => r.status)).toEqual(['ok', 'fail', 'skipped', 'fail', 'fail']);
    expect(res.records[1].problems).toEqual(['"You can only move or use one item at a time"']);
    expect(res.records[4].detail).toMatch(/threw: boom/);
    expect(res.aborted).toBeNull();
    expect(exitCode(res)).toBe(1);
  });
  it('waits for a pending request to clear before judging (settle)', async () => {
    const d = new FakeDriver();
    d.probes = [{ ...HEALTHY, inventoryRequest: { r: 1 }, busy: 1 }, { ...HEALTHY, busy: 1 }, HEALTHY];
    const res = await runPlaythrough([step('a', async () => ok('x'))], ctxOf(d));
    expect(res.records[0].status).toBe('ok');
    expect(d.t).toBe(1000 + 750); // two 500 ms polls, then the 750 ms grace for the last telemetry post
  });
  it('a request still pending after the settle time is a FAIL', async () => {
    const d = new FakeDriver();
    d.probes = [{ ...HEALTHY, inventoryRequest: { r: 1 } }];
    const res = await runPlaythrough([step('a', async () => ok('x'))], ctxOf(d), { settleMs: 3000 });
    expect(res.records[0].status).toBe('fail');
    expect(res.records[0].problems[0]).toMatch(/still pending/);
  });
  it('a death ends the run', async () => {
    const d = new FakeDriver();
    let ran = false;
    const steps = [step('fight', async () => { d.probes = [{ ...HEALTHY, dead: true }]; return ok('swung'); }), step('after', async () => { ran = true; return ok('x'); })];
    const res = await runPlaythrough(steps, ctxOf(d));
    expect(res.aborted).toMatch(/died during "fight"/);
    expect(ran).toBe(false);
    expect(res.records).toHaveLength(1);
    expect(exitCode(res)).toBe(1);
  });
  it('a required step that does not pass ends the run', async () => {
    const d = new FakeDriver();
    d.enter = { ok: false, detail: 'never entered the world' };
    const res = await runPlaythrough(playthroughSteps(eraPlan('ac1999-retail')), ctxOf(d));
    expect(res.records).toHaveLength(1);
    expect(res.records[0].status).toBe('fail');
    expect(res.aborted).toMatch(/enter-world/);
  });
  it('signals drained before a step are not blamed on it', async () => {
    const d = new FakeDriver();
    d.sig.consoleErrors.push('uncaught: from before');
    const res = await runPlaythrough([step('a', async () => ok('x'))], ctxOf(d));
    expect(res.records[0].status).toBe('ok');
  });
});

describe('playthrough: report', () => {
  it('labels each step ok / skipped (why) / FAIL (details) and says PASS or FAIL', async () => {
    const d = new FakeDriver();
    const res = await runPlaythrough([
      step('a', async () => ok('fine', { screenshots: ['01-a.png'] })),
      step('b', async () => skip('no caster held')),
      step('c', async () => { d.sig.spew.push('You are too busy!'); return ok('x'); }),
    ], ctxOf(d));
    const md = renderReport(res, { era: eraPlan('ac1999-retail'), url: 'http://x/?account=a&password=secret', account: 'a', character: 'Tester', started: new Date(0), finished: new Date(5000) });
    expect(md).toMatch(/Result: \*\*FAIL\*\*: 1 ok, 1 skipped, 1 failed/);
    expect(md).toMatch(/\| 2 \| b \(`b`\) \| skipped \(no caster held\) \|/);
    expect(md).toMatch(/FAIL \(x; unexpected refusal \(spew\): "You are too busy!"\)/);
    expect(md).toContain('![a](01-a.png)');
    expect(md).toContain('password=***');
    expect(md).not.toContain('secret');
    expect(statusLabel({ status: 'ok', detail: 'x', problems: [] })).toBe('ok');
  });
  it('a clean run exits 0', async () => {
    const res = await runPlaythrough([step('a', async () => ok('x'))], ctxOf(new FakeDriver()));
    expect(exitCode(res)).toBe(0);
  });
});

describe('playthrough: panels', () => {
  const spec = { id: 'inventory', title: 'Inventory', actions: ['Show/Hide Inventory Panel'], flag: 'inventoryVisible' };
  const panelDriver = (opts: { bound?: boolean; opens?: boolean; closes?: boolean }) => {
    const d = new FakeDriver();
    let presses = 0;
    d.handlers = {
      close: () => ({ ok: true, message: 'closed' }),
      press: () => {
        if (opts.bound === false) return { ok: false, message: '"Show/Hide Inventory Panel" has no key bound' };
        presses++;
        d.ui = { inventoryVisible: presses === 1 ? opts.opens !== false : opts.closes === false };
        return { ok: true, message: 'pressed F12 (Show/Hide Inventory Panel)' };
      },
    };
    return d;
  };
  it('opens with its key, screenshots, and the same key closes it', async () => {
    const d = panelDriver({});
    const r = await panelStep(spec).run(ctxOf(d));
    expect(r.status).toBe('ok');
    expect(r.screenshots).toEqual(['1-panel-inventory.png']);
  });
  it('no key in this era is a skip, not a failure', async () => {
    const r = await panelStep(spec).run(ctxOf(panelDriver({ bound: false })));
    expect(r.status).toBe('skipped');
    expect(r.detail).toMatch(/no key opens it in this era/);
  });
  it('a key that does not open it, or a second press that leaves it open, fails', async () => {
    expect((await panelStep(spec).run(ctxOf(panelDriver({ opens: false })))).status).toBe('fail');
    const r = await panelStep(spec).run(ctxOf(panelDriver({ closes: false })));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/left it open/);
  });
  it('the Create Spell page is in 1999\'s plan only; the confirm command follows the era', () => {
    const ids = (e: string) => playthroughSteps(eraPlan(e)).map((s) => s.id);
    expect(ids('ac1999-retail')).toContain('panel-create-spell');
    expect(ids('eor')).not.toContain('panel-create-spell');
    expect(ids('ac1999-retail')).toContain('cmd-lifestone-no');
    expect(ids('eor')).toContain('cmd-die-no');
    expect(ids('classicace-customdm')).toContain('cmd-die-no');
    for (const e of ['ac1999-retail', 'eor', 'classicace-customdm']) expect(ids(e)[0]).toBe('enter-world');
    expect(ids('ac1999-retail').at(-1)).toBe('logout-relogin');
  });
});

describe('playthrough: what is safe to fight', () => {
  const WASP = `INSERT INTO \`weenie_properties_int\` (\`object_Id\`, \`type\`, \`value\`)
VALUES (12,   1,         16) /* ItemType - Creature */
     , (12,  25,          3) /* Level */;

INSERT INTO \`weenie_properties_string\` (\`object_Id\`, \`type\`, \`value\`)
VALUES (12,   1, 'Red Phyntos Wasp') /* Name */;

INSERT INTO \`weenie_properties_attribute_2nd\` (\`object_Id\`, \`type\`, \`init_Level\`, \`level_From_C_P\`, \`c_P_Spent\`, \`current_Level\`)
VALUES (12,   1,     5, 0, 0, 20) /* MaxHealth */;

INSERT INTO \`weenie_properties_body_part\` (\`object_Id\`, \`key\`, \`d_Type\`, \`d_Val\`, \`d_Var\`, \`base_Armor\`)
VALUES (12,  0,  2,  3,  0.5,   10) /* Head */
     , (12, 16,  4,  0,    0,   10) /* Torso */;

INSERT INTO \`weenie_properties_spell_book\` (\`object_Id\`, \`spell\`, \`probability\`)
VALUES (12,    28,    2.4)  /* Frost Bolt I */;
`;
  it('reads level, health, hits, spells and weapons from a weenie\'s SQL', () => {
    expect(parseCreatureDanger(WASP)).toEqual({ name: 'Red Phyntos Wasp', level: 3, maxHealth: 20, casts: true, maxHit: 4.5, armed: false });
    const armed = WASP.replace(/INSERT INTO `weenie_properties_spell_book`[\s\S]*$/, '').replace("'Red Phyntos Wasp'", "'Drudge Skulker'")
      + 'INSERT INTO `weenie_properties_create_list` (`object_Id`, `destination_Type`, `weenie_Class_Id`)\nVALUES (12, 2, 309) /* Create Club for Wield */;\n';
    expect(parseCreatureDanger(armed)).toMatchObject({ name: 'Drudge Skulker', casts: false, armed: true });
    expect(parseCreatureDanger(WASP.replace('16) /* ItemType', '1) /* ItemType'))).toBeNull();
  });
  const facts = mergeCreatureFacts([
    { name: 'Red Phyntos Wasp', level: 3, maxHealth: 20, casts: true, maxHit: 4.5, armed: false },
    { name: 'Brown Rabbit', level: 1, maxHealth: 5, casts: false, maxHit: 7, armed: false },
    { name: 'Drudge Skulker', level: 2, maxHealth: 20, casts: false, maxHit: 5.3, armed: false },
    { name: 'Drudge Skulker', level: 8, maxHealth: 42, casts: false, maxHit: 5.3, armed: true },
    { name: 'Mosswart Chief', level: 4, maxHealth: 40, casts: false, maxHit: 6, armed: false },
    { name: 'Tough Rat', level: 3, maxHealth: 90, casts: false, maxHit: 6, armed: false },
  ]);
  it('never the Red Phyntos Wasp (a level 3 that casts), nor a never-fought kind, nor big health', () => {
    expect(preyVerdict({ name: 'Red Phyntos Wasp', level: 3 }, facts).ok).toBe(false);
    expect(preyVerdict({ name: 'Red Phyntos Wasp', level: 3 }, null).ok).toBe(false);
    expect(preyVerdict({ name: 'Mosswart Chief', level: 4 }, facts).ok).toBe(false);
    expect(preyVerdict({ name: 'Tough Rat', level: 3 }, facts)).toEqual({ ok: false, why: '90 health' });
    expect(preyVerdict({ name: 'Unknown Thing', level: 1 }, facts).ok).toBe(false);
  });
  it('a name with several weenies is judged by the level the server sent, else by the worst', () => {
    expect(preyVerdict({ name: 'Drudge Skulker', level: 2 }, facts).ok).toBe(true);
    expect(preyVerdict({ name: 'Drudge Skulker', level: 8 }, facts)).toEqual({ ok: false, why: 'wields a weapon' });
    expect(preyVerdict({ name: 'Drudge Skulker' }, facts).ok).toBe(false);
  });
  it('with no world data, only the allow list at a known low level', () => {
    expect(preyVerdict({ name: 'Brown Rabbit', level: 1 }, null).ok).toBe(true);
    expect(preyVerdict({ name: 'Brown Rabbit' }, null).ok).toBe(false);
    expect(preyVerdict({ name: 'Brown Rabbit', level: 9 }, null).ok).toBe(false);
    expect(preyVerdict({ name: 'Armoredillo', level: 2 }, null).ok).toBe(false);
  });
  it('picks the nearest safe creature in reach and says what it passed over', () => {
    const r = pickPrey([mon('Brown Rabbit', 60, { level: 1 }), mon('Red Phyntos Wasp', 10, { level: 3 }), mon('Brown Rabbit', 200, { level: 1 }), mon('Drudge Skulker', 30, { level: 2, dz: 40 })], facts);
    expect(r.prey?.dist).toBe(60);
    expect(r.rejected).toEqual(['Red Phyntos Wasp: a kind never fought here', 'Drudge Skulker (40 m up at 30 m: a cliff)']);
    expect(pickPrey([mon('Brown Rabbit', 60, { level: 1 })], facts, { exclude: [6000] }).prey).toBeNull();
    expect(pickPrey([{ ...mon('Brown Rabbit', 5, { level: 1 }), kind: 'npc' }], facts).prey).toBeNull();
  });
  const fightDriver = (opts: { hp?: number; dies?: boolean }) => {
    const walks: unknown[] = [];
    const rabbit = mon('Brown Rabbit', 20, { guid: 0x80000042, level: 1 });
    const d = new FakeDriver({
      observe: (o: { filter: string }) => ({ me: null, nearby: o.filter === 'monster' ? [mon('Red Phyntos Wasp', 5), rabbit] : o.filter === 'corpse' ? [{ ...rabbit, guid: 0x80000043, name: 'Corpse of Brown Rabbit', kind: 'corpse' }] : [], remembered: [], dialogs: [] }),
      inventory: () => [],
      attack: (g: number) => { expect(g).toBe(0x80000042); return { ok: true, message: 'attacking Brown Rabbit' }; },
      waitFor: () => (opts.hp === undefined && !opts.dies ? [{ type: 'target-died', text: 'You killed the Brown Rabbit!', guid: 0x80000042 }] : []),
      self: () => ({ dead: !!opts.dies, health: { cur: opts.hp ?? 50, max: 50 } }),
      walkTo: (t: string) => { walks.push(t); return { ok: true, message: 'walked' }; },
    });
    return { d, walks };
  };
  it('the kill step fights the safe creature, never the wasp beside it, and finds its corpse', async () => {
    const { d } = fightDriver({});
    const ctx = ctxOf(d);
    const r = await killStep.run(ctx);
    expect(r.status).toBe('ok');
    expect(ctx.state.kill).toEqual({ name: 'Brown Rabbit', guid: 0x80000042, corpse: 0x80000043 });
  });
  it('below half health it backs off and skips; a death is a failure', async () => {
    const { d, walks } = fightDriver({ hp: 20 });
    const r = await killStep.run(ctxOf(d));
    expect(r.status).toBe('skipped');
    expect(r.detail).toMatch(/health fell to 40%/);
    expect(walks).toEqual(['40m W']);
    expect((await killStep.run(ctxOf(fightDriver({ dies: true }).d))).status).toBe('fail');
  });
  it('hills are fine outdoors, cliffs and other floors are not (the 1999 run passed over every rabbit on the Samsur dunes)', () => {
    // The live run's rabbits: 8 to 26 m up or down, at 60 m and more.
    for (const [dz, dist] of [[8, 60], [12, 70], [21, 90], [26, 110], [-16, 80]]) expect(preyReachable(dz, dist, false)).toBe(true);
    expect(preyReachable(4, 2, false)).toBe(true);
    expect(preyReachable(30, 20, false)).toBe(false);
    expect(preyReachable(2, 30, true)).toBe(true);
    expect(preyReachable(4, 30, true)).toBe(false);
    const rabbits = [mon('Brown Rabbit', 60, { level: 1, dz: 8 }), mon('Black Rabbit', 90, { level: 1, dz: 21 })];
    expect(pickPrey(rabbits, facts).prey?.name).toBe('Brown Rabbit');
    expect(pickPrey(rabbits, facts, { sameFloor: () => true }).rejected).toEqual(['Brown Rabbit (8 m up at 60 m: another floor)', 'Black Rabbit (21 m up at 90 m: another floor)']);
  });
  it('backs off the way it came: the walk offset points away from the creature', () => {
    expect(awayFrom(90, 40)).toBe('40m W');
    expect(awayFrom(0, 15)).toBe('15m S');
  });
});

describe('playthrough: vendor', () => {
  const LISTING = 'Grocer sells (Pyreals; you have 120, and only coins pay: trade notes don\'t):\n  #80001a2b Apple  5\n  #80001a2c Bread  3  (stack 10)\n  #80001a2d Heal Self I  40  (service: Grocer casts it on you when you buy it; not a scroll)\n  #80001a2e Fine Sword  500';
  it('reads the listing and picks the cheapest goods the purse pays for (never a service)', () => {
    const rows = parseVendorListing(LISTING);
    expect(rows.map((r) => [r.name, r.price, r.service])).toEqual([['Apple', 5, false], ['Bread', 3, false], ['Heal Self I', 40, true], ['Fine Sword', 500, false]]);
    expect(cheapestAffordable(rows, 120)?.name).toBe('Bread');
    expect(cheapestAffordable(rows, 2)).toBeNull();
  });
  it('walks to the nearest vendor, buys the cheapest item and finds it in the pack', async () => {
    let bought = false;
    const d = new FakeDriver({
      observe: () => ({ me: null, nearby: [{ guid: 0x7a7b4003, name: 'Grocer', kind: 'vendor', dist: 30, bearing: 0, relBearing: 0, dz: 0 }], remembered: [], dialogs: [] }),
      vendorAt: () => ({ ok: true, message: `(used Grocer to open its window)\n${LISTING}` }),
      self: () => ({ pyreals: 120 }),
      inventory: () => (bought ? [{ guid: 1, name: 'Sword', where: 'equipped' }, { guid: 0x8000beef, name: 'Bread', where: 'pack' }] : [{ guid: 1, name: 'Sword', where: 'equipped' }]),
      buy: (g: number, n: number, v: number) => { expect([g, n, v]).toEqual([0x80001a2c, 1, 0x7a7b4003]); bought = true; return { ok: true, message: 'bought 1 Bread' }; },
    });
    const ctx = ctxOf(d);
    const r = await vendorBuyStep.run(ctx);
    expect(r.status).toBe('ok');
    expect(ctx.state.bought).toEqual({ guid: 0x8000beef, name: 'Bread' });
    expect(ctx.state.vendor?.name).toBe('Grocer');
  });
  it('no vendor around is a skip', async () => {
    const d = new FakeDriver({ observe: () => ({ me: null, nearby: [], remembered: [], dialogs: [] }), self: () => ({ coords: null }) });
    expect((await vendorBuyStep.run(ctxOf(d))).status).toBe('skipped');
  });
  it('1999: with none in view, walks into the nearest town first and looks again', async () => {
    expect(nearestTown('42.0N, 33.9E', eraPlan('ac1999-retail').towns)).toMatchObject({ name: 'Holtburg', at: '42.3N, 33.6E' });
    expect(nearestTown('31.0S, 13.0E', [['Al-Arqas', -31.1, 13.7]])?.at).toBe('31.1S, 13.7E');
    expect(nearestTown('0.0N, 0.0E', [['Far', 40, 40]])).toBeNull();
    let inTown = false;
    const walks: unknown[] = [];
    const d = new FakeDriver({
      observe: () => ({ me: null, nearby: inTown ? [{ guid: 5, name: 'Shopkeeper', kind: 'vendor', dist: 20, bearing: 0, relBearing: 0, dz: 0 }] : [], remembered: [], dialogs: [] }),
      self: () => ({ coords: '30.9S, 13.5E', pyreals: 0 }),
      walkTo: (t: string) => { walks.push(t); inTown = true; return { ok: true, message: 'arrived' }; },
      vendorAt: () => ({ ok: true, message: 'Shopkeeper sells:\n  #00000009 Apple  5' }),
    });
    const r = await vendorBuyStep.run(ctxOf(d));
    expect(walks).toEqual(['31.1S, 13.7E']);
    // Found and opened; 0 pyreals buy nothing, so the buy itself is skipped and says so.
    expect(r.status).toBe('skipped');
    expect(r.detail).toMatch(/sells nothing 0 pyreals pay for/);
  });
});

describe('playthrough: chat commands', () => {
  it('a reply is ok; no reply in 6 s fails; an unknown command is a skip', async () => {
    const d = new FakeDriver({ onChat: (t: string) => { d.sig.chat.push(`You say, "${t}"`); if (t === '@loc') d.sig.chat.push('Your location is: 0x7D64000D [44.1 22.3 12.0]'); if (t === '@version') d.sig.chat.push('Unknown command: version'); } });
    expect((await chatCommandStep('@loc').run(ctxOf(d))).status).toBe('ok');
    expect((await chatCommandStep('@help').run(ctxOf(d))).status).toBe('fail');
    const v = await chatCommandStep('@version').run(ctxOf(d));
    expect(v.status).toBe('skipped');
    expect(v.detail).toMatch(/doesn't know @version/);
  });
  it('the era\'s Yes / No command is answered No and nothing happens', async () => {
    let open = false;
    const d = new FakeDriver({
      onChat: (t: string) => { if (t === '@lifestone') open = true; },
      where: () => ({ x: 10, y: 10 }),
      observe: () => ({ me: null, nearby: [], remembered: [], dialogs: open ? [{ text: 'Do you really want to kill your character?', buttons: ['Yes', 'No'] }] : [] }),
      dialog: (b: string) => { expect(b).toBe('No'); open = false; return { ok: true, message: 'pressed No' }; },
      self: () => ({ dead: false }),
    });
    const r = await confirmNoStep(eraPlan('ac1999-retail')).run(ctxOf(d));
    expect(r.status).toBe('ok');
    expect(d.chats).toEqual(['@lifestone']);
  });
  it('no question at all fails', async () => {
    const d = new FakeDriver({ where: () => null, observe: () => ({ me: null, nearby: [], remembered: [], dialogs: [] }) });
    const r = await confirmNoStep(eraPlan('eor')).run(ctxOf(d, 'eor'));
    expect(r.status).toBe('fail');
    expect(d.chats).toEqual(['@die']);
  });
});

describe('playthrough: logout and back', () => {
  it('logs out to character select and enters again as the same character', async () => {
    const d = new FakeDriver({ logout: () => { d.probes = [{ ...HEALTHY, screen: 'loading' }, { ...HEALTHY, screen: 'character-select' }]; return { ok: true, message: 'logging out' }; },
      enterWorld: (n: string) => { expect(n).toBe('Tester'); d.probes = [HEALTHY]; return { ok: true, message: 'in the world as Tester' }; } });
    const ctx = ctxOf(d);
    ctx.state.character = 'Tester';
    const r = await logoutAndBackStep.run(ctx);
    expect(r.status).toBe('ok');
    expect(r.screenshots).toEqual(['1-character-select.png', '2-back-in-world.png']);
  });
});

describe('playthrough: arguments', () => {
  it('defaults to the 1999 era with its short account; other eras take theirs', () => {
    const a = parsePlaythroughArgs([], {}, () => 0);
    expect(a.era.key).toBe('ac1999-retail');
    expect(a.account).toBe('ptrun99');
    expect(a.account.length).toBeLessThanOrEqual(8);
    expect(a.password).toBe('ptrun99');
    expect(a.character).toBe('Firsthour Aaaaa');
    expect(parsePlaythroughArgs(['--era', 'eor']).account).toBe('testacjs3');
    expect(parsePlaythroughArgs(['--era=classicace-customdm', '--account', 'agentapp99dm']).era.id).toBe('classicace-customdm');
    expect(eraPlan('1999').key).toBe('ac1999-retail');
    expect(() => eraPlan('nope')).toThrow(/unknown era/);
  });
  it('builds the dev-server login URL with the agent API and the era', () => {
    const a = parsePlaythroughArgs(['--base', 'http://localhost:5291', '--bridge', 'ws://localhost:9312', '--query', 'datSet=x']);
    expect(playthroughUrl(a)).toBe('http://localhost:5291/?ace&agent&bridge=ws://localhost:9312&account=ptrun99&password=ptrun99&era=ac1999-retail&datSet=x');
    expect(playthroughUrl(parsePlaythroughArgs(['--era', 'eor', '--base', 'http://h/']))).not.toMatch(/era=/);
  });
  it('--only keeps the world entry and the named steps, and refuses unknown ids', () => {
    const all = playthroughSteps(eraPlan('ac1999-retail'));
    expect(selectSteps(all, ['kill', 'loot-rest']).map((s) => s.id)).toEqual(['enter-world', 'kill', 'loot-rest']);
    expect(() => selectSteps(all, ['killl'])).toThrow(/unknown step id/);
  });
});

describe('playthrough: live-run calibration (2026-10-23 1999 run)', () => {
  it('a use\'s status lines ("Approaching %s", "Using the %s") are notices, not refusals', () => {
    const s = { ...emptySignals(), spew: ['Approaching Hudriffa', 'Using the Bread', 'Using the Door', 'Using the Healing Kit on Firsthour Yejkm'] };
    expect(assessHealth(HEALTHY, s)).toEqual([]);
    // A real refusal beside them still counts.
    expect(assessHealth(HEALTHY, { ...s, spew: [...s.spew, "You can't open or close this Door that way."] })).toEqual(['unexpected refusal (spew): "You can\'t open or close this Door that way."']);
  });
  const echo = { source: 'server', code: 'we:0x0037', context: 'inventory_failed', text: 'Unable to move to object!', sink: 'none' };
  it('1999: the server\'s silent 0xA0 (error 55) after a sale is expected; shown, or in another era, it fails', () => {
    const allow1999 = saleEcho(eraPlan('ac1999-retail'));
    const one = { ...emptySignals(), refusals: [echo] };
    expect(assessHealth(HEALTHY, one, [], allow1999)).toEqual([]);
    expect(assessHealth(HEALTHY, { ...one, refusals: [{ ...echo, sink: 'spew' }] }, [], allow1999)).toHaveLength(1);
    expect(assessHealth(HEALTHY, { ...one, refusals: [{ ...echo, code: 'we:0x0029' }] }, [], allow1999)).toHaveLength(1);
    expect(saleEcho(eraPlan('eor'))).toBeUndefined();
    expect(assessHealth(HEALTHY, one, [], saleEcho(eraPlan('eor')))[0]).toMatch(/we:0x0037 \(inventory_failed, shown: none\)/);
  });
  it('the sell step passes with the echo in 1999', async () => {
    const d = new FakeDriver({
      inventory: () => [{ guid: 0x90000e80, name: 'Arrow', where: 'pack', value: 2 }],
      sell: () => { d.sig.refusals.push(echo); return { ok: true, message: 'sold Arrow for 1 pyreals' }; },
      close: () => ({ ok: true, message: 'closed' }),
    });
    const ctx = ctxOf(d);
    ctx.state.vendor = { guid: 5, name: 'Hudriffa' };
    ctx.state.bought = { guid: 0x90000e80, name: 'Arrow' };
    const res = await runPlaythrough([vendorSellStep], ctx);
    expect(res.records[0].status).toBe('ok');
  });
  const item = (name: string, extra: Partial<AgentItem> = {}): AgentItem => ({ guid: name.length, name, where: 'pack', value: 5, ...extra });
  it('gives only what the server lets go of: never the Welcome Letter (writable, worth nothing), nor needed or worn gear', () => {
    const inv = [
      item('Welcome Letter', { value: 0, itemType: 0x2000 }), item('Healing Kit', { itemType: 0x80 }), item('Wand', { itemType: 0x8000 }),
      item('Leather Cap', { where: 'equipped', itemType: 0x2 }), item('Pyreal', { itemType: 0x40 }), item('Apple', { value: 3, itemType: 0x20 }), item('Jar', { value: 1, itemType: 0x80 }),
    ];
    expect(giveCandidates(inv).map((i) => i.name)).toEqual(['Jar', 'Apple']);
  });
  it('a give the server refuses for the item tries the next; none giveable is a skip with the reason', async () => {
    const tried: string[] = [];
    const d = new FakeDriver({
      observe: () => ({ me: null, nearby: [{ guid: 7, name: 'Hardunna', kind: 'npc', dist: 10, bearing: 0, relBearing: 0, dz: 0 }], remembered: [], dialogs: [] }),
      inventory: () => [item('Jar', { value: 1 }), item('Apple', { value: 3, itemType: 0x20 })],
      give: (g: number) => { tried.push(String(g)); return g === 3 ? { ok: false, message: "The Jar can't be given" } : { ok: true, message: 'You give Hardunna Apple.' }; },
    });
    const r = await giveStep.run(ctxOf(d));
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/gave Apple to Hardunna:.*after: Jar/);
    const none = new FakeDriver({ observe: d.handlers.observe, inventory: () => [item('Welcome Letter', { value: 0, itemType: 0x2000 })] });
    const s = await giveStep.run(ctxOf(none));
    expect(s.status).toBe('skipped');
    expect(s.detail).toMatch(/nothing giveable held/);
  });
  const stock: VendorStockRow[] = [
    { guid: 1, name: 'Arrow', price: 2, itemType: 0x80000 },
    { guid: 2, name: 'Healing Kit', price: 30, itemType: 0x80 },
    { guid: 3, name: 'Wand', price: 80, itemType: 0x8000 },
    { guid: 4, name: 'Bread', price: 3, itemType: 0x20 },
    { guid: 5, name: 'Heal Self I', price: 10, itemType: 0x00100000, service: true },
  ];
  it('plans the supplies the later steps need: kit and caster first, only what is not held and the purse pays for', () => {
    const p = planSupplies(stock, [], 100);
    expect(p.buy.map((b) => [b.kind, b.row.name])).toEqual([['kit', 'Healing Kit'], ['food', 'Bread']]);
    expect(p.why).toEqual({ caster: 'the cheapest at the vendor, Wand, costs 80 and 70 pyreals are left', scroll: 'the vendor sells none' });
    const held = planSupplies(stock, [{ guid: 9, name: 'Healing Kit', where: 'pack' }, { guid: 8, name: 'Apple', where: 'pack', itemType: 0x20 }], 200);
    expect(held.buy.map((b) => b.kind)).toEqual(['caster']);
  });
  it('the supplies step buys them, and a later step that finds none says why', async () => {
    const bought: number[] = [];
    const d = new FakeDriver({
      vendorAt: () => ({ ok: true, message: 'Hudriffa sells:' }),
      inventory: () => [],
      self: () => ({ pyreals: 100 }),
      buy: (g: number) => { bought.push(g); return { ok: true, message: 'bought' }; },
      close: () => ({ ok: true, message: 'closed' }),
    });
    d.stock = stock;
    const ctx = ctxOf(d);
    ctx.state.vendor = { guid: 5, name: 'Hudriffa' };
    const r = await vendorSuppliesStep.run(ctx);
    expect(r.status).toBe('ok');
    expect(bought).toEqual([2, 4]);
    expect(r.detail).toMatch(/not bought: caster: the cheapest at the vendor, Wand, costs 80/);
    const magic = playthroughSteps(eraPlan('ac1999-retail')).find((s) => s.id === 'magic-mode')!;
    const m = await magic.run({ ...ctx, driver: new FakeDriver({ inventory: () => [] }) });
    expect(m.status).toBe('skipped');
    expect(m.detail).toMatch(/no caster .* held \(not bought: the cheapest at the vendor, Wand, costs 80/);
  });
  it('a vendor still busy from the sale ("You\'re too busy!", the AC1999 server\'s UseChecked on the target) is waited out once, the refusal allowed', async () => {
    let calls = 0;
    const d = new FakeDriver({
      vendorAt: () => (++calls === 1 ? { ok: false, message: "used Hudriffa: / You're too busy! / no shop window opened for Hudriffa" } : { ok: true, message: 'Hudriffa sells:' }),
      inventory: () => [],
      self: () => ({ pyreals: 100 }),
      buy: () => ({ ok: true, message: 'bought' }),
      close: () => ({ ok: true, message: 'closed' }),
    });
    d.stock = stock;
    const ctx = ctxOf(d);
    ctx.state.vendor = { guid: 5, name: 'Hudriffa' };
    const r = await vendorSuppliesStep.run(ctx);
    expect(calls).toBe(2);
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/reopened after "too busy"/);
    expect(r.allow?.some((re) => re.test("You're too busy!"))).toBe(true);
  });
  it('the supplies step comes after the sale (so it never sells what it bought) and before the items are used', () => {
    const ids = playthroughSteps(eraPlan('ac1999-retail')).map((s) => s.id);
    expect(ids.indexOf('vendor-supplies')).toBe(ids.indexOf('vendor-sell') + 1);
    expect(ids.indexOf('vendor-supplies')).toBeLessThan(ids.indexOf('use-healing-kit'));
    expect(ids.indexOf('vendor-supplies')).toBeLessThan(ids.indexOf('magic-mode'));
  });
});

describe('playthrough: second live-run calibration (2026-10-23 run 2 and the EoR / Dark Majesty runs)', () => {
  const rabbitFacts = mergeCreatureFacts([{ name: 'Brown Rabbit', level: 1, maxHealth: 5, casts: false, maxHit: 7, armed: false }]);
  it('an outdoor player and a rabbit 9 m up at 84 m: it qualifies', () => {
    const rabbit = mon('Brown Rabbit', 84, { level: 1, dz: 9 });
    expect(sameFloorOnly('outdoors', 'outdoors')).toBe(false);
    expect(pickPrey([rabbit], rabbitFacts, { sameFloor: () => sameFloorOnly('outdoors', 'outdoors') }).prey?.name).toBe('Brown Rabbit');
  });
  it('the floor rule only where a floor is the question: a dungeon, or a creature in a room', () => {
    // Run 2 started in a Holtburg shop (0xA9B00111, a SeenOutside room): the rabbits outside are the landscape's.
    expect(sameFloorOnly('building', 'outdoors')).toBe(false);
    expect(sameFloorOnly('building', 'unknown')).toBe(false);
    expect(sameFloorOnly('outdoors', 'building')).toBe(true);
    expect(sameFloorOnly('dungeon', 'unknown')).toBe(true);
    expect(sameFloorOnly('outdoors', 'dungeon')).toBe(true);
  });
  it('the kill step reads the places through the driver', async () => {
    const rabbit = mon('Brown Rabbit', 84, { guid: 0x80000042, level: 1, dz: 9 });
    const d = new FakeDriver({
      observe: (o: { filter: string }) => ({ me: null, nearby: o.filter === 'monster' ? [rabbit] : [], remembered: [], dialogs: [] }),
      inventory: () => [],
      attack: () => ({ ok: true, message: 'attacking' }),
      waitFor: () => [{ type: 'target-died', text: 'You killed the Brown Rabbit!', guid: 0x80000042 }],
      self: () => ({ dead: false, health: { cur: 50, max: 50 } }),
    });
    d.places = { me: 'building', objects: { [0x80000042]: 'outdoors' } };
    expect((await killStep.run({ ...ctxOf(d), facts: rabbitFacts })).status).toBe('ok');
    d.places = { me: 'dungeon', objects: {} };
    const r = await killStep.run({ ...ctxOf(d), facts: rabbitFacts });
    expect(r.status).toBe('skipped');
    expect(r.detail).toMatch(/another floor/);
  });
  it('ACE\'s login notices sent as WeenieErrors are not refusals; a real refusal still is', () => {
    const s = { ...emptySignals(), refusals: [
      { source: 'server', code: 'we:0x051d', context: 'weenie_error', text: 'Turbine Chat is enabled.', sink: 'none' },
      { source: 'server', code: 'we:0x051b', context: 'weenie_error_str', text: 'You have entered the _ channel.', sink: 'chat' },
      { source: 'server', code: 'we:0x001c', context: 'weenie_error', text: null, sink: 'none' },
    ] };
    expect(assessHealth(HEALTHY, s)).toEqual(['client_refusal we:0x001c (weenie_error, shown: none) (no text shown)']);
  });
  it('reads the era\'s vendor spawns from its world SQL and picks the nearest', () => {
    const vendors = vendorWeenies(['/w/3-Core/9 WeenieDefaults/SQL/Vendor/Creature/04433 Hudriffa.sql', '/w/9 x/SQL/Vendor/Misc/00012 Shopkeeper Bob.sql']);
    expect([...vendors]).toEqual([[4433, 'Hudriffa'], [12, 'Shopkeeper Bob']]);
    const sql = "VALUES (0x7A9B0000,  4433, 0xA9B00102, 37.5406, 152.008, 58.005, -0.309567, 0, 0, -0.950878, False, '2005-02-09 10:00:00'); /* Hudriffa */\n"
      + "VALUES (0x7A9B0001,   412, 0xA9B0010D, 37.76, 107.05, 64.01, -0.707107, 0, 0, -0.707107, False, '2005-02-09 10:00:00'); /* Door */\n";
    const spots = vendorSpotsIn(sql, vendors);
    expect(spots).toEqual([{ name: 'Hudriffa', wcid: 4433, cell: 0xa9b00102, x: 0xa9 * 192 + 37.5406, y: 0xb0 * 192 + 152.008 }]);
    expect(nearestVendorSpot(spots, { x: 0xa9 * 192 + 60, y: 0xb0 * 192 + 120 })?.name).toBe('Hudriffa');
    expect(nearestVendorSpot(spots, { x: 0, y: 0 })).toBeNull();
    expect(cellTarget(0xa9b00102)).toBe('0xA9B00102');
  });
  it('with no vendor in view, walks into the world data\'s nearest vendor\'s room by its cell', async () => {
    let there = false;
    const walks: unknown[] = [];
    const d = new FakeDriver({
      observe: () => ({ me: null, nearby: there ? [{ guid: 5, name: 'Hudriffa', kind: 'vendor', dist: 3, bearing: 0, relBearing: 0, dz: 0 }] : [], remembered: [], dialogs: [] }),
      where: () => ({ x: 0xa9 * 192 + 60, y: 0xb0 * 192 + 120 }),
      walkTo: (t: string) => { walks.push(t); there = true; return { ok: true, message: 'arrived' }; },
      vendorAt: () => ({ ok: true, message: 'Hudriffa sells:\n  #00000009 Arrow  2' }),
      self: () => ({ pyreals: 0, coords: null }),
    });
    const ctx = { ...ctxOf(d), vendorSpots: [{ name: 'Hudriffa', wcid: 4433, cell: 0xa9b00102, x: 0xa9 * 192 + 37.5, y: 0xb0 * 192 + 152 }] };
    const r = await vendorBuyStep.run(ctx);
    expect(walks).toEqual(['0xA9B00102']);
    expect(ctx.state.vendor?.name).toBe('Hudriffa');
    expect(r.detail).toMatch(/sells nothing 0 pyreals pay for/);
  });
  const effects = playthroughSteps(eraPlan('ac1999-retail')).find((s) => s.id === 'panel-effects')!;
  const noKey = () => ({ ok: false, message: '"Show/Hide Positive Magic Panel" has no key bound' });
  it('1999 opens the Spells in Effect panel by its lit indicator (no key: the 1999 keymap has no such command)', async () => {
    const d = new FakeDriver({ close: () => ({ ok: true, message: 'closed' }), press: noKey, onIndicator: () => { d.ui = { positiveEffectsVisible: d.indicatorClicks === 1 }; } });
    d.indicator = { found: true, lit: true };
    const r = await effects.run(ctxOf(d));
    expect(r.status).toBe('ok');
    expect(d.indicatorClicks).toBe(2);
    d.indicator = { found: true, lit: false };
    const u = await effects.run(ctxOf(d));
    expect(u.status).toBe('skipped');
    expect(u.detail).toMatch(/unlit/);
  });
  it('the effects panel step runs after the cast at yourself, so a spell is in effect', () => {
    for (const e of ['ac1999-retail', 'eor']) {
      const ids = playthroughSteps(eraPlan(e)).map((s) => s.id);
      expect(ids.indexOf('panel-effects')).toBe(ids.indexOf('cast-self') + 1);
    }
  });
  it('give examines its candidates first and leaves out what turns out attuned (the 1999 Calling Stone)', async () => {
    let appraised = false;
    const stone = { guid: 21, name: 'Calling Stone', where: 'pack', value: 10, itemType: 0x80 } as AgentItem;
    const apple = { guid: 22, name: 'Apple', where: 'pack', value: 3, itemType: 0x20 } as AgentItem;
    const gave: number[] = [];
    const d = new FakeDriver({
      observe: () => ({ me: null, nearby: [{ guid: 7, name: 'Hardunna', kind: 'npc', dist: 10, bearing: 0, relBearing: 0, dz: 0 }], remembered: [], dialogs: [] }),
      inventory: () => (appraised ? [{ ...stone, appraised: true, attuned: true }, { ...apple, appraised: true }] : [stone, apple]),
      appraise: () => { appraised = true; return { ok: true, message: 'examined' }; },
      close: () => ({ ok: true, message: 'closed' }),
      give: (g: number) => { gave.push(g); return { ok: true, message: 'You give Hardunna Apple.' }; },
    });
    const r = await giveStep.run(ctxOf(d));
    expect(r.status).toBe('ok');
    expect(gave).toEqual([22]);
  });
});

describe('playthrough: third calibration (2026-10-23 three-era run)', () => {
  it('a roll-up of a refusal already judged is never a problem (the relog step was blamed for the give\'s repeats)', () => {
    const s = { ...emptySignals(), refusals: [{ source: 'server', code: 'we:0x046a', context: 'weenie_error_str', text: '_ doesn\'t know what to do with that.', sink: 'chat', rollup: true }] };
    expect(assessHealth(HEALTHY, s)).toEqual([]);
  });
  it('signals that arrive after a step\'s drain count against that step, not the next', async () => {
    const d = new FakeDriver({
      // Drains: the run's start, the late check before "give", then the end of "give" (3): a refusal posts just after it.
      onDrain: (n: number) => { if (n === 3) d.sig.refusals.push({ source: 'server', code: 'we:0x0029', context: 'weenie_error', text: null, sink: 'none' }); },
    });
    const res = await runPlaythrough([step('give', async () => ok('gave')), step('relog', async () => ok('back in'))], ctxOf(d));
    expect(res.records.map((r) => r.status)).toEqual(['fail', 'ok']);
    expect(res.records[0].problems[0]).toMatch(/we:0x0029.*arrived after the step ended/);
  });
  const npcObs = (list: Array<{ guid: number; name: string }>) => () => ({ me: null, nearby: list.map((x) => ({ ...x, kind: 'npc', dist: 10, bearing: 0, relBearing: 0, dz: 0 })), remembered: [], dialogs: [] });
  it('give goes only to NPC creatures: a forge or a shrine statue is skipped with the reason', async () => {
    const d = new FakeDriver({ observe: npcObs([{ guid: 1, name: 'Fletching Forge' }, { guid: 2, name: 'Tusker Shrine Statue' }]) });
    d.creatures = [];
    const r = await giveStep.run(ctxOf(d));
    expect(r.status).toBe('skipped');
    expect(r.detail).toMatch(/no NPC creature within 80 m \(passed over, not creatures: Fletching Forge, Tusker Shrine Statue\)/);
  });
  it('give prefers what an NPC here takes by the world data (one of a stack), and an NPC that doesn\'t want it is an expected no', async () => {
    expect(parseGiveTable("INSERT INTO `weenie_properties_string` (`object_Id`, `type`, `value`)\nVALUES (99,   1, 'Orcud the Beggar') /* Name */;\n\nINSERT INTO `weenie_properties_emote` (`object_Id`, `category`, `probability`, `weenie_Class_Id`)\nVALUES (99,  6 /* Give */,      1, 273 /* Pyreal */, NULL);\n"))
      .toEqual({ name: 'Orcud the Beggar', accepts: [273] });
    const tables = new Map([['orcud the beggar', new Set([273])]]);
    const npcs = [{ guid: 9, name: 'Orcud the Beggar', kind: 'npc', dist: 20, bearing: 0, relBearing: 0, dz: 0 } as AgentObject];
    const purse = { guid: 5, name: 'Pyreal', where: 'pack', wcid: 273, stack: 120 } as AgentItem;
    expect(acceptedGift(npcs, [purse], tables)?.item.name).toBe('Pyreal');
    expect(acceptedGift(npcs, [{ ...purse, wcid: 300 }], tables)).toBeNull();
    const gives: unknown[][] = [];
    const d = new FakeDriver({ observe: npcObs([{ guid: 9, name: 'Orcud the Beggar' }]), inventory: () => [purse], give: (...a: unknown[]) => { gives.push(a); return { ok: true, message: 'You give Orcud the Beggar 1 Pyreal.' }; } });
    const r = await giveStep.run({ ...ctxOf(d), giveTables: tables });
    expect(r.status).toBe('ok');
    expect(gives).toEqual([[5, 9, 1]]);
    const no = new FakeDriver({ observe: npcObs([{ guid: 7, name: 'Hardunna' }]), inventory: () => [{ guid: 3, name: 'Apple', where: 'pack', value: 3, itemType: 0x20, appraised: true }],
      give: () => ({ ok: false, message: "Hardunna did not get your Apple; the server said:\nHardunna doesn't know what to do with that." }) });
    expect((await giveStep.run(ctxOf(no))).status).toBe('ok');
  });
  it('the vendor step prefers a general vendor within 600 m to a specialist in view', async () => {
    let walked = false;
    const d = new FakeDriver({
      observe: () => ({ me: null, nearby: walked ? [{ guid: 8, name: 'Fispur Ansel the Grocer', kind: 'vendor', dist: 4, bearing: 0, relBearing: 0, dz: 0 }] : [{ guid: 6, name: 'Ladim al-Faji the Bowyer', kind: 'vendor', dist: 10, bearing: 0, relBearing: 0, dz: 0 }], remembered: [], dialogs: [] }),
      where: () => ({ x: 1000, y: 1000 }),
      walkTo: () => { walked = true; return { ok: true, message: 'arrived' }; },
      vendorAt: (g: number) => ({ ok: true, message: `${g === 8 ? 'Fispur' : 'Ladim'} sells:` }),
      self: () => ({ pyreals: 0 }),
    });
    const ctx = { ...ctxOf(d, 'eor'), vendorSpots: [{ name: 'Fispur Ansel the Grocer', wcid: 1, cell: 0x0a0b0104, x: 1200, y: 1100, general: true }, { name: 'Ladim al-Faji the Bowyer', wcid: 2, cell: 0x0a0b0105, x: 1010, y: 1000, general: false }] };
    await vendorBuyStep.run(ctx);
    expect(ctx.state.vendor?.name).toBe('Fispur Ansel the Grocer');
  });
  const aceEcho = { source: 'server', code: 'we:0x0000', context: 'inventory_failed', text: null, sink: 'none' };
  it('ACE\'s silent answer to a refused sale item is expected once a sale was refused; a sale after it still passes', async () => {
    expect(refusedSaleEcho(aceEcho)).toBe(true);
    expect(refusedSaleEcho({ ...aceEcho, sink: 'spew' })).toBe(false);
    const d = new FakeDriver({
      inventory: () => [{ guid: 1, name: 'Arrow', where: 'pack', value: 2 }, { guid: 2, name: 'Hawthorn', where: 'pack', value: 140 }],
      sell: (g: number) => { if (g === 1) { d.sig.refusals.push(aceEcho); return { ok: false, message: 'Arrow was not sold\nThe Arrow is unsellable.' }; } return { ok: true, message: 'sold Hawthorn for 70 pyreals' }; },
      close: () => ({ ok: true, message: 'closed' }),
    });
    const ctx = ctxOf(d, 'classicace-customdm');
    ctx.state.vendor = { guid: 5, name: 'Oi Ra the Shopkeeper' };
    ctx.state.bought = { guid: 1, name: 'Arrow' };
    expect((await runPlaythrough([vendorSellStep], ctx)).records[0].status).toBe('ok');
    // All refused (the EoR Bowyer): a skip, not a FAIL.
    const all = new FakeDriver({ inventory: () => [{ guid: 1, name: 'Quarrel', where: 'pack', value: 2 }], sell: () => { all.sig.refusals.push(aceEcho); return { ok: false, message: 'The Quarrel is unsellable.' }; }, close: () => ({ ok: true, message: 'closed' }) });
    const c2 = ctxOf(all, 'eor');
    c2.state.vendor = { guid: 6, name: 'Ladim al-Faji the Bowyer' };
    expect((await runPlaythrough([vendorSellStep], c2)).records[0].status).toBe('skipped');
  });
  const castDriver = (opts: { components: boolean; refuse?: string }) => {
    const walks: unknown[][] = [];
    const rabbit = mon('Brown Rabbit', 45.6, { guid: 0x8000a5bc, level: 1 });
    const d = new FakeDriver({
      spells: () => [{ id: 27, name: 'Flame Bolt I', school: 'War Magic', range: 33.5, targetType: 0x10 }],
      observe: (o: { filter: string }) => ({ me: null, nearby: o.filter === 'monster' ? [rabbit] : [], remembered: [], dialogs: [] }),
      walkTo: (...a: unknown[]) => { walks.push(a); return { ok: true, message: 'arrived' }; },
      cast: () => (opts.refuse ? { ok: false, message: opts.refuse } : { ok: true, message: 'You cast Flame Bolt I' }),
      inventory: () => (opts.components ? [{ guid: 4, name: 'Lead Scarab', where: 'pack', itemType: 0x1000 }] : []),
      attack: () => ({ ok: true, message: 'casting' }),
      waitFor: () => [{ type: 'target-died', text: 'You killed the Brown Rabbit!', guid: 0x8000a5bc }],
      self: () => ({ dead: false, health: { cur: 50, max: 50 } }),
    });
    const ctx = ctxOf(d, 'classicace-customdm');
    ctx.state.caster = { guid: 1, name: 'Wand' };
    ctx.facts = mergeCreatureFacts([{ name: 'Brown Rabbit', level: 1, maxHealth: 5, casts: false, maxHit: 7, armed: false }]);
    return { ctx, walks };
  };
  it('cast-creature walks into the spell\'s reach first (45.6 m off, 33.5 m reach)', async () => {
    const { ctx, walks } = castDriver({ components: true });
    expect((await castAtCreatureStep.run(ctx)).status).toBe('ok');
    expect(walks[0]).toEqual([0x8000a5bc, { within: 29, stopOnAggro: false }]);
  });
  it('"You don\'t have all the components" is a skip without components, a FAIL with them', async () => {
    const refuse = 'Flame Bolt I not cast: the server refused it: You don\'t have all the components for this spell. (YouDontHaveAllTheComponents)';
    const none = await castAtCreatureStep.run(castDriver({ components: false, refuse }).ctx);
    expect(none.status).toBe('skipped');
    expect(none.detail).toMatch(/holds none/);
    const held = await castAtCreatureStep.run(castDriver({ components: true, refuse }).ctx);
    expect(held.status).toBe('fail');
    expect(held.detail).toMatch(/while holding Lead Scarab/);
  });
  it('an attack that never swings is a FAIL said plainly', async () => {
    const rabbit = mon('Brown Rabbit', 20, { guid: 0x60001dc9, level: 1 });
    let t = 0;
    const d = new FakeDriver({
      observe: (o: { filter: string }) => ({ me: null, nearby: o.filter === 'monster' ? [rabbit] : [], remembered: [], dialogs: [] }),
      inventory: () => [],
      attack: () => ({ ok: true, message: 'attacking' }),
      waitFor: () => { t++; return t > 3 ? [{ type: 'target-lost', text: 'Brown Rabbit #60001dc9: no swings either way for 20 s (blocked, unreachable, fleeing, or not there on the server\'s side)' }] : []; },
      self: () => ({ dead: false, health: { cur: 50, max: 50 } }),
    });
    const r = await killStep.run({ ...ctxOf(d), facts: mergeCreatureFacts([{ name: 'Brown Rabbit', level: 1, maxHealth: 5, casts: false, maxHit: 7, armed: false }]) });
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/^ATTACK NEVER SWUNG at Brown Rabbit/);
  });
});

describe('playthrough: fourth calibration (2026-10-23 1999 run with agenta99: Wand, Item Enchantment 79, War Magic untrained)', () => {
  const sk = (trained: string[]): SkillRow[] => ['War Magic', 'Life Magic', 'Creature Enchantment', 'Item Enchantment', 'Void Magic']
    .map((name) => ({ name, training: trained.includes(name) ? 'trained' : 'untrained' }));
  const AGENTA99 = sk(['Item Enchantment']);
  const portalRecall: AgentSpell = { id: 157, name: 'Portal Recall', school: 'Item Enchantment', self: true, power: 50 };
  const acidBane: AgentSpell = { id: 1, name: 'Acid Bane I', school: 'Item Enchantment', buff: true, targetType: 0x6, power: 1 };
  const strengthSelf: AgentSpell = { id: 2, name: 'Strength Self I', school: 'Creature Enchantment', buff: true, self: true, targetType: 0x10, power: 1 };
  const armorSelf: AgentSpell = { id: 3, name: 'Armor Self I', school: 'Life Magic', buff: true, self: true, targetType: 0x10, power: 1 };
  const flameBolt: AgentSpell = { id: 27, name: 'Flame Bolt I', school: 'War Magic', targetType: 0x10, range: 33.5, power: 1 };
  const harmOther: AgentSpell = { id: 4, name: 'Harm Other I', school: 'Life Magic', targetType: 0x10, range: 30, power: 1 };
  const rabbit = mon('Brown Rabbit', 20, { guid: 0x60001fb5, level: 1 });
  const rabbitFacts = mergeCreatureFacts([{ name: 'Brown Rabbit', level: 1, maxHealth: 5, casts: false, maxHit: 7, armed: false }]);

  /** A 1999 character in magic mode: its spells, skills, mana, and the server's answer to each cast (lines pushed as chat). */
  const magicDriver = (o: { spells: AgentSpell[]; skills: SkillRow[]; manaCost?: Record<number, number>; mana?: number; answer?: (n: number) => { ok: boolean; message: string; lines?: string[]; refusal?: string } }) => {
    const casts: unknown[][] = [];
    const modes: string[] = [];
    const d = new FakeDriver({
      spells: () => o.spells,
      self: () => ({ dead: false, health: { cur: 19, max: 19 }, mana: { cur: o.mana ?? 13, max: 29 }, combatMode: 'magic' }),
      observe: (q: { filter: string }) => ({ me: null, nearby: q.filter === 'monster' ? [rabbit] : [], remembered: [], dialogs: [] }),
      walkTo: () => ({ ok: true, message: 'arrived' }),
      cast: (...a: unknown[]) => {
        casts.push(a);
        const r = o.answer ? o.answer(casts.length) : { ok: true, message: 'You cast it.' };
        for (const l of r.lines ?? []) d.sig.chat.push(l);
        if (r.refusal) d.sig.refusals.push({ source: 'server', code: 'we:0x0401', context: 'weenie_error', text: r.refusal, sink: 'spew' });
        return { ok: r.ok, message: r.message };
      },
      combatMode: (m: string) => { modes.push(m); return { ok: true, message: m }; },
      inventory: () => [],
      attack: () => ({ ok: true, message: 'casting' }),
      waitFor: () => [{ type: 'target-died', text: 'You killed the Brown Rabbit!', guid: rabbit.guid }],
    });
    d.magic = { skills: o.skills, mana: o.manaCost ?? {} };
    const ctx = { ...ctxOf(d), facts: rabbitFacts };
    ctx.state.caster = { guid: 9, name: 'Wand' };
    return { d, ctx, casts, modes };
  };

  it('a school counts as trained only when the Skills panel says so (a 1999 name\'s trailing NUL ignored); no skills listed = unknown', () => {
    expect(schoolTrained('Item Enchantment', AGENTA99)).toBe(true);
    expect(schoolTrained('War Magic', AGENTA99)).toBe(false);
    expect(schoolTrained('Creature Enchantment', [{ name: 'Creature Enchantment\0', training: 'specialized' }])).toBe(true);
    expect(schoolTrained('War Magic', [])).toBeNull();
  });

  it('Portal Recall is no enchantment and an Item Enchantment goes on an item: neither is a self enchantment', () => {
    expect(selfEnchantment(portalRecall)).toBe(false);
    expect(selfEnchantment(acidBane)).toBe(false);
    expect(selfEnchantment(strengthSelf)).toBe(true);
    expect(atCreatureSpell(flameBolt)).toBe(true);
    expect(atCreatureSpell(strengthSelf)).toBe(false);
  });

  it('picks a trained school with the mana there, and says why each other spell was passed over', () => {
    const facts: MagicFacts = { skills: sk(['Life Magic']), mana: { 2: 10, 3: 20 } };
    const p = pickCastable([strengthSelf, armorSelf], facts, 13, selfEnchantment, [/^creature/i, /^life/i]);
    expect(p.spell).toBeNull();
    expect(p.passed).toEqual(['Strength Self I (Creature Enchantment untrained)', 'Armor Self I (up to 20 mana, you have 13)']);
    const q = pickCastable([strengthSelf, armorSelf], { ...facts, mana: { 3: 10 } }, 13, selfEnchantment, [/^creature/i, /^life/i]);
    expect(q.spell?.name).toBe('Armor Self I');
    expect(q.why).toBe('Life Magic trained, up to 10 mana of 13');
  });

  it('the cast verdict: run 4\'s "not trained" and "not enough Mana" are the character\'s, a fizzle is a miss, the agent\'s no is a refusal', () => {
    expect(castVerdict({ ok: true, message: 'casting Flame Bolt I at Brown Rabbit #60001fb5' }, ['You are not trained in that skill!']).kind).toBe('character');
    expect(castVerdict({ ok: true, message: 'casting Portal Recall on yourself\nYou don\'t have enough Mana to cast this spell.' }, []).kind).toBe('character');
    expect(castVerdict({ ok: true, message: 'casting' }, ['Your spell fizzled.']).kind).toBe('missed');
    expect(castVerdict({ ok: false, message: 'Strength Self I not cast: you are in portal space' }, []).kind).toBe('refused');
    expect(castVerdict({ ok: true, message: 'You cast Strength Self I on yourself' }, []).kind).toBe('landed');
  });

  it('cast-self never casts Portal Recall: with only Item Enchantment trained it skips, saying why', async () => {
    const { ctx, casts } = magicDriver({ spells: [portalRecall, acidBane, strengthSelf], skills: AGENTA99 });
    const r = await castAtSelfStep.run(ctx);
    expect(casts).toEqual([]);
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('no enchantment that goes on you the character can cast: Strength Self I (Creature Enchantment untrained)');
    const only = magicDriver({ spells: [portalRecall, acidBane], skills: AGENTA99 });
    const u = await castAtSelfStep.run(only.ctx);
    expect(u.status).toBe('skipped');
    expect(u.detail).toBe('no enchantment that goes on you known (known enchantments that go on an item, not on you: Acid Bane I)');
  });

  it('cast-self casts a trained-school enchantment and passes when it lands; Portal Recall is passed over', async () => {
    const { ctx, casts } = magicDriver({ spells: [portalRecall, strengthSelf], skills: sk(['Creature Enchantment']), manaCost: { 2: 10 } });
    const r = await castAtSelfStep.run(ctx);
    expect(casts).toEqual([[2, 'self', null]]);
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/^Strength Self I \(Creature Enchantment trained, up to 10 mana of 13\)/);
  });

  it('a server "not enough Mana" FAILS cast-self when the client had the mana, and skips when the cost was unknown', async () => {
    const answer = () => ({ ok: true, message: 'casting Strength Self I on yourself', refusal: 'You don\'t have enough Mana to cast this spell.' });
    const known = magicDriver({ spells: [strengthSelf], skills: sk(['Creature Enchantment']), manaCost: { 2: 10 }, answer });
    const res = await runPlaythrough([castAtSelfStep], known.ctx);
    expect(res.records[0].status).toBe('fail');
    expect(res.records[0].detail).toMatch(/the server refused it \("You don't have enough Mana to cast this spell\."\) though the client has the mana/);
    const unknown = magicDriver({ spells: [strengthSelf], skills: sk(['Creature Enchantment']), answer });
    const u = await runPlaythrough([castAtSelfStep], unknown.ctx);
    expect(u.records[0].status).toBe('skipped');
    expect(u.records[0].detail).toMatch(/the character can't \(too little mana\)/);
    expect(u.records[0].problems).toEqual([]);
  });

  it('cast-self: too little mana for every enchantment is a skip before any cast', async () => {
    const { ctx, casts } = magicDriver({ spells: [strengthSelf], skills: sk(['Creature Enchantment']), manaCost: { 2: 15 }, mana: 13 });
    const r = await castAtSelfStep.run(ctx);
    expect(casts).toEqual([]);
    expect(r.detail).toMatch(/Strength Self I \(up to 15 mana, you have 13\)/);
  });

  it('cast-self tries again after a fizzle; fizzling every time is a skip; another server refusal FAILS', async () => {
    const again = magicDriver({ spells: [strengthSelf], skills: sk(['Creature Enchantment']), answer: (n) => (n < 2 ? { ok: true, message: 'casting', lines: ['Your spell fizzled.'] } : { ok: true, message: 'You cast Strength Self I on yourself' }) });
    const a = await runPlaythrough([castAtSelfStep], again.ctx);
    expect(again.casts).toHaveLength(2);
    expect(a.records[0].status).toBe('ok');
    const fizz = magicDriver({ spells: [strengthSelf], skills: sk(['Creature Enchantment']), answer: () => ({ ok: true, message: 'casting', lines: ['Your spell fizzled.'] }) });
    const f = await runPlaythrough([castAtSelfStep], fizz.ctx);
    expect(fizz.casts).toHaveLength(3);
    expect(f.records[0].status).toBe('skipped');
    const other = magicDriver({ spells: [strengthSelf], skills: sk(['Creature Enchantment']), answer: () => ({ ok: true, message: 'casting', refusal: 'You can\'t cast that here.' }) });
    const o = await runPlaythrough([castAtSelfStep], other.ctx);
    expect(o.records[0].status).toBe('fail');
    expect(o.records[0].problems.join('\n')).toMatch(/You can't cast that here/);
  });

  it('cast-creature never picks Flame Bolt I with War Magic untrained: a trained school\'s spell, or a skip with the reason', async () => {
    const none = magicDriver({ spells: [flameBolt], skills: AGENTA99 });
    const r = await castAtCreatureStep.run(none.ctx);
    expect(none.casts).toEqual([]);
    expect(r.status).toBe('skipped');
    expect(r.detail).toBe('no spell cast at a creature the character can cast: Flame Bolt I (War Magic untrained)');
    const life = magicDriver({ spells: [flameBolt, harmOther], skills: sk(['Life Magic']) });
    expect((await castAtCreatureStep.run(life.ctx)).status).toBe('ok');
    expect(life.casts[0][0]).toBe(4);
  });

  it('cast-creature: the server\'s "not trained" with the school trained on the client is a FAIL (their states disagree)', async () => {
    const { ctx } = magicDriver({ spells: [flameBolt], skills: sk(['War Magic']), answer: () => ({ ok: true, message: 'casting Flame Bolt I at Brown Rabbit', lines: ['You are not trained in that skill!'] }) });
    const res = await runPlaythrough([castAtCreatureStep], ctx);
    expect(res.records[0].status).toBe('fail');
    expect(res.records[0].detail).toMatch(/though the client has War Magic trained/);
  });

  const wand = { guid: 9, name: 'Wand', where: 'equipped', itemType: 0x8000 } as AgentItem;
  const killDriver = (o: { skills: SkillRow[]; inv?: AgentItem[]; unequip?: { ok: boolean; message: string } }) => {
    const calls: string[] = [];
    const d = new FakeDriver({
      inventory: () => o.inv ?? [wand],
      spells: () => [flameBolt],
      self: () => ({ dead: false, health: { cur: 19, max: 19 }, mana: { cur: 13, max: 29 } }),
      unequip: (g: number) => { calls.push(`unequip ${g}`); return o.unequip ?? { ok: true, message: 'took off Wand' }; },
      equip: (g: number) => { calls.push(`equip ${g}`); return { ok: true, message: 'wielded' }; },
      observe: (q: { filter: string }) => ({ me: null, nearby: q.filter === 'monster' ? [rabbit] : [], remembered: [], dialogs: [] }),
      attack: () => { calls.push('attack'); return { ok: true, message: 'attacking' }; },
      waitFor: () => [{ type: 'target-died', text: 'You killed the Brown Rabbit!', guid: rabbit.guid }],
    });
    d.magic = { skills: o.skills, mana: {} };
    return { d, ctx: { ...ctxOf(d), facts: rabbitFacts }, calls };
  };

  it('kill with a caster wielded and no attack spell castable: the caster comes off and the fight is bare-handed (or a held sword)', async () => {
    const { ctx, calls } = killDriver({ skills: AGENTA99 });
    const r = await killStep.run(ctx);
    expect(calls).toEqual(['unequip 9', 'attack']);
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/took Wand off \(no attack spell the character can cast: Flame Bolt I \(War Magic untrained\)\); no melee weapon held, so bare hands/);
    expect(ctx.state.unwielded).toEqual({ guid: 9, name: 'Wand' });
    const sword = killDriver({ skills: AGENTA99, inv: [wand, { guid: 12, name: 'Short Sword', where: 'pack', itemType: 0x1 } as AgentItem] });
    await killStep.run(sword.ctx);
    expect(sword.calls).toEqual(['unequip 9', 'equip 12', 'attack']);
  });

  it('kill keeps the caster when an attack spell of a trained school is castable; a failed unwield is a skip with the reason', async () => {
    const war = killDriver({ skills: sk(['War Magic']) });
    expect(await armForKill(war.ctx)).toEqual({ note: 'with Wand wielded the attack casts Flame Bolt I (War Magic trained)' });
    expect(war.calls).toEqual([]);
    const stuck = killDriver({ skills: AGENTA99, unequip: { ok: false, message: 'not taken off: Wand' } });
    const r = await killStep.run(stuck.ctx);
    expect(r.status).toBe('skipped');
    expect(r.detail).toMatch(/Wand is wielded, so the attack is a spell, and no attack spell .*; taking it off failed: not taken off: Wand/);
    expect(stuck.calls).toEqual(['unequip 9']);
  });

  it('magic mode wields the caster the kill took off again', async () => {
    const equips: number[] = [];
    const d = new FakeDriver({
      inventory: () => [{ ...wand, where: 'pack' }],
      equip: (g: number) => { equips.push(g); return { ok: true, message: 'wielded' }; },
      combatMode: () => ({ ok: true, message: 'magic' }),
      self: () => ({ combatMode: 'magic' }),
    });
    const ctx = ctxOf(d);
    ctx.state.unwielded = { guid: 9, name: 'Wand' };
    const r = await magicModeStep.run(ctx);
    expect(equips).toEqual([9]);
    expect(r.detail).toBe('Wand wielded again (the kill step took it off); in magic mode');
    expect(ctx.state.unwielded).toBeNull();
  });

  it('--admin: off by default; on, the prep runs right after entering the world, with --only too', () => {
    expect(parsePlaythroughArgs([]).admin).toBe(false);
    expect(parsePlaythroughArgs(['--admin']).admin).toBe(true);
    expect(playthroughSteps(eraPlan('ac1999-retail')).some((s) => s.id === 'admin-prep')).toBe(false);
    const ids = playthroughSteps(eraPlan('ac1999-retail'), { admin: true }).map((s) => s.id);
    expect(ids.slice(0, 2)).toEqual(['enter-world', 'admin-prep']);
    expect(selectSteps(playthroughSteps(eraPlan('ac1999-retail'), { admin: true }), ['cast-self']).map((s) => s.id)).toEqual(['enter-world', 'admin-prep', 'cast-self']);
    expect(ADMIN_PREP_COMMANDS.map((c) => c.text)).toEqual(['@spellcomps 74 5', '@spawnwcidinv 2472']);
  });

  it('the schools to train: one per magic step with none of its spells\' schools trained', () => {
    expect(schoolsToTrain([flameBolt, harmOther, acidBane, strengthSelf, armorSelf], AGENTA99)).toEqual(['War Magic', 'Creature Enchantment']);
    expect(schoolsToTrain([flameBolt, harmOther, strengthSelf], sk(['Life Magic']))).toEqual(['Creature Enchantment']);
    expect(schoolsToTrain([flameBolt], [])).toEqual([]);
  });

  it('--admin prep types the commands into the chat box, sees the components and the wand arrive, and trains the schools', async () => {
    let inv: AgentItem[] = [];
    const trained: string[] = [];
    const d = new FakeDriver({
      onChat: (t: string) => {
        if (t.startsWith('@spellcomps')) d.sig.chat.push('Spawned 74 spell component types (5 each), 0 failed.');
        if (t.startsWith('@spawnwcidinv')) inv = [{ guid: 0x90000abc, name: 'Wand', where: 'pack', itemType: 0x8000 } as AgentItem];
      },
      inventory: () => inv,
      spells: () => [flameBolt, strengthSelf],
      trainSkill: (s: string) => { trained.push(s); return { ok: true, message: `trained ${s}` }; },
    });
    d.magic = { skills: AGENTA99, mana: {} };
    const r = await adminPrepStep.run(ctxOf(d));
    expect(d.chats).toEqual(['@spellcomps 74 5', '@spawnwcidinv 2472']);
    expect(trained).toEqual(['War Magic', 'Creature Enchantment']);
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/@spellcomps 74 5: "Spawned 74 spell component types \(5 each\), 0 failed\."; @spawnwcidinv 2472: Wand #90000abc in the pack; trained with credits/);
  });

  it('--admin prep on a player account fails saying it needs an admin account ("Unknown command!")', async () => {
    const d = new FakeDriver({ onChat: () => { d.sig.chat.push('Unknown command!'); }, inventory: () => [] });
    const r = await adminPrepStep.run(ctxOf(d));
    expect(r.status).toBe('fail');
    expect(r.detail).toBe('@spellcomps 74 5 (spell components for the casts): "Unknown command!": --admin needs an admin test account');
  });
});
