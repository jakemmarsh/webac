/**
 * BUG.ac1999-server-no-mtable-data — why the AC1999 server answers a healing kit with 0x43 WERROR_NO_MTABLE_DATA,
 * and what the client does with it.
 *
 * 1. The data (1999 portal.dat, the human motion table 0x09000001): the healer's motions
 *    (Healer.cpp CHealerUseEvent::OnReadyToUse: Motion_SkillHealSelf 0x1000010e on yourself, Motion_Woah
 *    0x13000099 on another player) are linked only from NonCombat's Ready. In every combat stance
 *    PhatSDK CMotionTable::GetObjectSequence finds no link (get_link, then the style-default detour), so
 *    MotionTableManager::PerformMovement returns WERROR_NO_MTABLE_DATA, ExecuteUseAnimation cancels the use
 *    and NotifyUseDone sends a flat 0x1C AttemptFailed(0x43). The 1999 client sends the same 0x35 in any
 *    stance (ItemHolder_UseObject @ 0x004e5ee0 has no stance check), so a 1999 player got the same refusal:
 *    a server / data limitation, not a client request it should not have made. End of retail's table has
 *    SkillHealSelf in every stance; Woah is NonCombat-only there too (ACE goes to peace first).
 *    Eat / Drink / Pickup / Reading / CastSpell exist in every 1999 stance; Sanctuary (a lifestone),
 *    ClapHands, Kneel and BowDeep only in NonCombat, the wand motions only in Magic.
 * 2. The client: both clients' failure switch prints nothing for 0x43, but first ends a repeating attack
 *    (end of retail HandleFailureEvent @ 00571990, 1999 UI_HandleFailureEvent @ 0x004ccd10, for 0x23, 0x36,
 *    0x3e, 0x43, 0x3f7). Ours never did (abortRepeatAttackOnFailure).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { MotionTable } from '../packages/dat-parser/src/file-types/MotionTable.js';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerCombat1999 } from '../packages/network/src/era1999/codecs/Combat1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { deserializeMessage } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { AttackRequestController, type AttackRequestDeps } from '../packages/renderer/src/controllers/AttackRequest.js';
import {
  abortRepeatAttackOnFailure, deliverWeenieError, FAILURE_ABORTS_REPEAT_ATTACK,
} from '../packages/renderer/src/ui/WeenieErrorNotices.js';
import { FAILURE_EVENT_TEXT_1999 } from '../packages/renderer/src/ui/FailureEventText1999.js';
import { SILENT_REFUSAL_LINES_1999 } from '../packages/renderer/src/ui/SilentRefusalLines1999.js';
import { openDat, DAT_PATHS, DAT_SETS_DIR } from './_harness/dat.js';

const PORTAL_1999 = `${DAT_SETS_DIR}/ac1999-retail/portal.dat`;
const HUMAN_TABLE = 0x09000001;
const READY = 0x41000003;
const NON_COMBAT = 0x8000003d;
const COMBAT_STANCES_1999 = [0x8000003c, 0x8000003e, 0x8000003f, 0x80000040, 0x80000041, 0x80000047, 0x80000049, 0x800000e8, 0x800000e9];
const M = {
  SkillHealSelf: 0x1000010e, Woah: 0x13000099, Pickup: 0x40000018, Eat: 0x4000001a, Drink: 0x4000001b,
  Reading: 0x4000001c, Sanctuary: 0x10000057, ClapHands: 0x1300007e, Kneel: 0x13000092, BowDeep: 0x1300007d,
  CastSpell: 0x400000d3, UseMagicWand: 0x400000e1,
} as const;

const key = (style: number, motion: number) => (((style << 16) | (motion & 0xffffff)) >>> 0);

/**
 * Whether PhatSDK CMotionTable::GetObjectSequence (MotionTable.cpp) can play `motion` from (style, Ready): a
 * substate needs a cycle in the style or the default style; an action needs a link from Ready (get_link,
 * including its substate-0 fallback) or the style-default detour.
 */
function canPlay(t: MotionTable, style: number, motion: number): boolean {
  const link = (from: number, to: number) => t.links.get(key(style, from))?.get(to) ?? t.links.get(key(style, 0))?.get(to);
  if (motion & 0x40000000) return !!(t.cycles.get(key(style, motion)) ?? t.cycles.get(key(t.defaultStyle, motion)));
  if (motion & 0x10000000) {
    if (!t.cycles.get(key(style, READY))) return false;
    if (link(READY, motion)) return true;
    const def = t.styleDefaults.get(style) ?? 0;
    return !!(link(READY, def) && link(def, motion));
  }
  return false;
}

describe.skipIf(!existsSync(PORTAL_1999))('the 1999 human motion table (BUG.ac1999-server-no-mtable-data)', () => {
  let t1999: MotionTable;
  let tEol: MotionTable | null = null;
  beforeAll(() => {
    t1999 = new MotionTable(new DatReader(openDat(PORTAL_1999).getFileData(HUMAN_TABLE)!));
    if (existsSync(DAT_PATHS.portal)) tEol = new MotionTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(HUMAN_TABLE)!));
  });

  it('has the ten stances, NonCombat the default', () => {
    expect(t1999.defaultStyle).toBe(NON_COMBAT);
    expect([...t1999.styleDefaults.keys()].sort()).toEqual([NON_COMBAT, ...COMBAT_STANCES_1999].sort());
  });

  it('links the healer motions only from NonCombat: a kit in any combat stance is WERROR_NO_MTABLE_DATA', () => {
    expect(canPlay(t1999, NON_COMBAT, M.SkillHealSelf)).toBe(true);
    expect(canPlay(t1999, NON_COMBAT, M.Woah)).toBe(true);
    for (const s of COMBAT_STANCES_1999) {
      expect(canPlay(t1999, s, M.SkillHealSelf), `SkillHealSelf in 0x${s.toString(16)}`).toBe(false);
      expect(canPlay(t1999, s, M.Woah), `Woah in 0x${s.toString(16)}`).toBe(false);
    }
  });

  it('the sweep: food, drink, pickup, scrolls and casting work in every stance; lifestone and emotes only in peace; wands only in magic', () => {
    for (const s of [NON_COMBAT, ...COMBAT_STANCES_1999]) {
      for (const m of [M.Pickup, M.Eat, M.Drink, M.Reading, M.CastSpell]) expect(canPlay(t1999, s, m)).toBe(true);
      for (const m of [M.Sanctuary, M.ClapHands, M.Kneel, M.BowDeep]) expect(canPlay(t1999, s, m)).toBe(s === NON_COMBAT);
      expect(canPlay(t1999, s, M.UseMagicWand)).toBe(s === 0x80000049);
    }
  });

  it.skipIf(!existsSync(DAT_PATHS.portal))('end of retail added SkillHealSelf to the combat stances (Woah stays NonCombat-only)', () => {
    for (const s of COMBAT_STANCES_1999.filter((x) => x !== 0x800000e8 && x !== 0x800000e9)) {
      expect(canPlay(tEol!, s, M.SkillHealSelf)).toBe(true);
      expect(canPlay(tEol!, s, M.Woah)).toBe(false);
    }
  });
});

function repeatingController() {
  const state = { t: 10, sent: 0, cancels: 0 };
  const deps: AttackRequestDeps = {
    now: () => state.t, getTarget: () => 0x80000001, isAttackable: () => true, inReadyPosition: () => true,
    combatMode: () => 'melee', currentStyle: () => 0, sliderPower: () => 0.5, autoRepeat: () => true,
    sendAttack: () => { state.sent++; }, setPowerBarLevel: () => {}, showError: () => {},
    sendCancelAttack: () => { state.cancels++; }, autoTarget: () => false, lastAttacker: () => 0,
    objectPresent: () => false, selectObject: () => {}, selectNextCompassItem: () => {},
  };
  const c = new AttackRequestController(deps);
  c.setRequestedAttackHeight('high');
  state.t += 0.6; c.useTime();
  c.endAttackRequest();
  c.handleCommenceAttack();
  return { c, state };
}

/** The AC1999 server's flat 0x1C AttemptFailed (Player.cpp NotifyWeenieError), through the real adapter + handler. */
function attemptFailed1999(code: number): number[] {
  const c = emptyCodecs();
  registerCombat1999(c, { player: () => ({ guid: 0x50000001, eventSequence: 1 }) });
  const a = new Adapter1999(c, { account: 'acjs', log: () => {} });
  const codes: number[] = [];
  const h = new ServerMessageHandler();
  h.setHandlers({ onWeenieError: (d: { errorType: number }) => { codes.push(d.errorType); } });
  for (const e of a.inbound(new Writer1999().u32(0x1c).i32(code).toBytes(), 4)) h.handleMessage(deserializeMessage(e));
  return codes;
}

describe('0x43 on the client: silent, and it ends a repeating attack (HandleFailureEvent)', () => {
  const ui = () => {
    const shown: string[] = [];
    return { shown, surface: { displayErrorText: (t: string) => shown.push(t), addSystemMessage: (t: string) => shown.push(t) } as never };
  };

  it('the AC1999 server bytes reach onWeenieError as 0x43; neither the 1999 switch nor its departures print it', () => {
    expect(attemptFailed1999(0x43)).toEqual([0x43]);
    const u = ui();
    expect(deliverWeenieError(u.surface, 0x43, null, FAILURE_EVENT_TEXT_1999, SILENT_REFUSAL_LINES_1999.get(0x43) ?? null).sink).toBe('none');
    expect(u.shown).toEqual([]);
  });

  it('aborts a running repeat attack: CancelAttack goes out and the repeat stops', () => {
    const { c, state } = repeatingController();
    expect(c.repeatAttackInProgress()).toBe(true);
    const [code] = attemptFailed1999(0x43);
    expect(abortRepeatAttackOnFailure(code, c)).toBe(true);
    expect(state.cancels).toBe(1);
    expect(c.repeatAttacking).toBe(false);
  });

  it('exactly the five codes both clients list abort; others (an out-of-range cast 0x550, too busy 0x1d) do not', () => {
    expect([...FAILURE_ABORTS_REPEAT_ATTACK].sort((x, y) => x - y)).toEqual([0x23, 0x36, 0x3e, 0x43, 0x3f7]);
    for (const code of [0x550, 0x1d, 0x4fc, 0x498]) {
      const { c, state } = repeatingController();
      expect(abortRepeatAttackOnFailure(code, c)).toBe(false);
      expect(state.cancels).toBe(0);
      expect(c.repeatAttacking).toBe(true);
    }
  });

  it('with no attack running (a kit used at rest) nothing is sent', () => {
    const state = { cancels: 0 };
    const idle = { repeatAttackInProgress: () => false, abortAutomaticAttack: () => { state.cancels++; } };
    expect(abortRepeatAttackOnFailure(0x43, idle)).toBe(false);
    expect(abortRepeatAttackOnFailure(0x43, null)).toBe(false);
    expect(state.cancels).toBe(0);
  });
});
