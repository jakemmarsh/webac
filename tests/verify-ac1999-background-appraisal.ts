/**
 * BUG.ac1999-auto-turn-to-mobs (webac#20, AC1999): "Characters will periodically turn towards mobs (especially
 * when they spawn) even without inspection … When running, this will stop a character from moving."
 *
 * The AC1999 server turns the appraiser to face what they appraise (CClientEvents::Identify →
 * TurnToAppraiseTarget, reference/ac1999/Server/Source/ClientEvents.cpp; 1999 retail until the 2002-07
 * Repercussions patch). Ours appraised on its own: the agent API's level look at every monster newly coming at
 * you (it ticks for every player), Mag-Tools' corpse check, UB's nametag assessor, a routine's door ID, and the
 * Examine window's 0.75 s re-appraisal (gmExaminationUI::UseTime, end of retail only). Each one turned the 1999
 * player. Driven through the real modules: the verdict, the era rules, and the AgentApi on the fake host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TargetLocations } from '@ac/shared';
import { backgroundAppraisalVerdict } from '../packages/renderer/src/controllers/BackgroundAppraisal.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { AgentApi, type AgentHostObject } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const R1999 = eraClientRules(eraProfile('ac1999-retail')).world;
const EOR = eraClientRules(eraProfile('eor')).world;
const DM = eraClientRules(eraProfile('classic-dereth')).world;

const SELF = 0x50000001;
const DRUDGE = 0x80001ca1;
const PACK_ITEM = 0x80002001;
const WORN = 0x80002002;
const CORPSE_ITEM = 0x80002003;
const SHOP_ITEM = 0x80002004;

function where(world: number[]): TargetLocations {
  return {
    inPack: (g) => g === PACK_ITEM,
    worn: (g) => g === WORN,
    inOpenContainer: (g) => g === CORPSE_ITEM,
    inWorld: (g) => world.includes(g),
    forSale: (g) => g === SHOP_ITEM,
  };
}

describe('the era rules', () => {
  it('only the AC1999 server turns the appraiser; only the 1999 client lacks the Examine re-appraisal', () => {
    expect(R1999.appraisalTurnsAppraiser).toBe(true);
    expect(R1999.examineReappraise).toBe(false);
    for (const r of [EOR, DM]) {
      expect(r.appraisalTurnsAppraiser).toBe(false);
      expect(r.examineReappraise).toBe(true);
    }
  });
});

describe('backgroundAppraisalVerdict', () => {
  const ctx = (turnsAppraiser: boolean, examineOpen = false) => ({ selfGuid: SELF, where: where([DRUDGE, SELF]), turnsAppraiser, examineOpen });

  it('1999: a monster in the world is not looked at (the server would turn you to face it)', () => {
    expect(backgroundAppraisalVerdict(DRUDGE, ctx(R1999.appraisalTurnsAppraiser))).toBe('turns-player');
  });

  it('1999: what you carry, wear, loot, are buying, or yourself stays allowed (no turn, or you face it already)', () => {
    for (const g of [SELF, PACK_ITEM, WORN, CORPSE_ITEM, SHOP_ITEM]) expect(backgroundAppraisalVerdict(g, ctx(true))).toBe('send');
  });

  it('end of retail / Dark Majesty: a world monster is looked at, except while the Examine window holds the appraisal target', () => {
    expect(backgroundAppraisalVerdict(DRUDGE, ctx(EOR.appraisalTurnsAppraiser))).toBe('send');
    expect(backgroundAppraisalVerdict(DRUDGE, ctx(DM.appraisalTurnsAppraiser))).toBe('send');
    expect(backgroundAppraisalVerdict(DRUDGE, ctx(false, true))).toBe('examine-open');
    // Your own pack item is never the examined creature's rival.
    expect(backgroundAppraisalVerdict(PACK_ITEM, ctx(false, true))).toBe('send');
  });

  it('an object known nowhere is left to the send path\'s own resolve gate', () => {
    expect(backgroundAppraisalVerdict(0x80009999, ctx(true))).toBe('send');
  });
});

describe('AgentApi background looks go through the host\'s gate', () => {
  let host: FakeHost;
  let api: AgentApi;
  let allowed: boolean;
  const monster = (guid: number, name: string, x: number, y: number, extra: Partial<AgentHostObject> = {}): AgentHostObject =>
    host.add({ guid, name, itemType: 0x10, objectDescFlags: 0x10, x, y, ...extra });
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    host.me.level = 20;
    allowed = false;
    (host as FakeHost & { backgroundAppraisalAllowed?: (g: number) => boolean }).backgroundAppraisalAllowed = () => allowed;
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('a monster that spawns and comes at you raises aggro but sends no appraisal where the gate says no (1999)', async () => {
    const drudge = monster(DRUDGE, 'Drudge Skulker', 80, 60);
    run(api, host, 500, { physics: false });
    const w = api.wait({ types: ['aggro'] }, 5000);
    drudge.seeks = { guid: host.me.guid, kind: 'move' };
    run(api, host, 300, { physics: false });
    const evs = await w;
    expect(evs[0]?.guid).toBe(DRUDGE);
    expect(host.appraiseCalls).toEqual([]);
  });

  it('the same aggro looks the monster\'s level up where the gate allows it (end of retail)', async () => {
    allowed = true;
    const drudge = monster(DRUDGE, 'Drudge Skulker', 80, 60);
    run(api, host, 500, { physics: false });
    const w = api.wait({ types: ['aggro'] }, 5000);
    drudge.seeks = { guid: host.me.guid, kind: 'move' };
    run(api, host, 300, { physics: false });
    await w;
    expect(host.appraiseCalls).toEqual([{ guid: DRUDGE, quiet: true }]);
  });

  it('the player\'s own look (observe) skips the level looks while gated, and takes them once allowed', () => {
    for (let i = 0; i < 3; i++) monster(0x80005000 + i, `Drudge Skulker ${i}`, 80 + i * 5, 30);
    const dispatch = api.surface() as Record<string, (...a: unknown[]) => unknown>;
    dispatch.observe({});
    expect(host.appraiseCalls).toEqual([]);
    allowed = true;
    dispatch.observe({});
    expect(host.appraiseCalls.map((c) => c.guid)).toEqual([0x80005000, 0x80005001, 0x80005002]);
  });

  it('backgroundAppraise says whether it sent', () => {
    expect(api.backgroundAppraise(DRUDGE)).toBe(false);
    allowed = true;
    expect(api.backgroundAppraise(DRUDGE)).toBe(true);
    expect(host.appraiseCalls).toEqual([{ guid: DRUDGE, quiet: true }]);
  });

  it('an explicit appraisal (ac_appraise, the player\'s examine) is still sent: in 1999 it turns you, as the server intends', async () => {
    monster(DRUDGE, 'Drudge Skulker', 80, 40);
    const p = api.appraise(DRUDGE);
    expect(host.appraiseCalls).toEqual([{ guid: DRUDGE, quiet: false }]);
    await vi.advanceTimersByTimeAsync(11_000);
    await p;
  });
});
