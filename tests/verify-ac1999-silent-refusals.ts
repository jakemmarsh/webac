/**
 * BUG.ac1999-silent-refusals (prod 2026-11-03, trace e864663f266999b1 and a week of `sink="none"`):
 *
 * 1. A 1999 player's 0x4B spell research drew WERROR 0x405 (MAGIC_SPELLBOOK_ADDSPELL_FAILURE) nine
 *    times, each logged `sink="none"`. Not silent: the AC1999 server's research handler sends its own
 *    "That is not a valid spell formula." line first (fewer than 5 components or no Talisman), then the
 *    code, which neither the 1999 client nor end of retail has an arm for. The telemetry now reports
 *    such a code with the line's sink, so `sink="none"` keeps meaning nothing showed.
 * 2. The truly silent ones: 0x550 out-of-range casts (about 150 a week), healing kits without the skill
 *    or on a creature, a wand low on mana, a wrong key, a use cancelled by moving off. Each now prints
 *    end of retail's line (ui/SilentRefusalLines1999.ts).
 *
 * Driven through shipped code: AC1999 0x1C bytes through the real 1999 adapter and
 * ServerMessageHandler, the era rules, deliverWeenieError and the RefusalReporter, composed as
 * main.ts's onWeenieError / onServerMessage compose them.
 */
import { describe, it, expect } from 'vitest';
import { SILENT_REFUSAL_LINES_1999, SILENT_WERROR_1999 } from '../packages/renderer/src/ui/SilentRefusalLines1999';
import { SOCIAL_REFUSAL_LINES_1999, SocialRefusalMemo } from '../packages/renderer/src/ui/SocialRefusalLines1999';
import { FAILURE_EVENT_TEXT_1999 } from '../packages/renderer/src/ui/FailureEventText1999';
import { deliverWeenieError } from '../packages/renderer/src/ui/WeenieErrorNotices';
import { eraClientRules, type EraClientRules } from '../packages/renderer/src/era/EraFeatures';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles';
import {
  RefusalReporter, SERVER_TEXT_PAIR_MS, isServerTextRefusal, weenieCode, type RefusalEvent,
} from '../packages/renderer/src/telemetry/RefusalReporter';
import { weenieErrorText, WEENIE_ERROR_TEXT_TYPE_SPEW } from '../packages/shared/src/index';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler';
import { deserializeMessage } from '../packages/network/src/MessageSerializer';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999';
import { registerCombat1999 } from '../packages/network/src/era1999/codecs/Combat1999';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999';

const R1999 = eraClientRules(eraProfile('ac1999-retail'));
const REOR = eraClientRules(eraProfile('eor'));
const RDM = eraClientRules(eraProfile('classicace-customdm'));
const PLAYER = 0x50000003;
const MAGIC_SPELLBOOK_ADDSPELL_FAILURE = 0x405;
const NO_MTABLE_DATA = 0x43;

function client(rules: EraClientRules = R1999) {
  const clock = { t: 10_000 };
  const spew: string[] = [];
  const chat: Array<[string, number | undefined]> = [];
  const events: RefusalEvent[] = [];
  const reporter = new RefusalReporter({
    endpoint: 'http://x/client-preworld', build: 'b1', trace: 'feedc0de12345678',
    era: () => 'ac1999-retail', server: () => 'ac1999', now: () => clock.t,
    send: (_url, body) => { events.push(JSON.parse(body) as RefusalEvent); },
  });
  const ui = {
    displayErrorText: (t: string) => { spew.push(t); reporter.clientSpew(t); },
    addSystemMessage: (t: string, _c?: string, type?: number) => { chat.push([t, type]); },
  };
  const memo = rules.socialRefusalLines ? new SocialRefusalMemo(rules.socialRefusalLines) : null;
  const h = new ServerMessageHandler();
  h.setHandlers({
    onWeenieError: (d: { errorType: number }) => {
      const departure = memo?.lineFor(d.errorType, clock.t, () => null) ?? null;
      const silentLine = departure ? null : rules.silentRefusalLines?.get(d.errorType) ?? null;
      const shown = reporter.quietly(() => deliverWeenieError(ui, d.errorType, weenieErrorText(d.errorType), rules.failureEventText, departure?.arm ?? silentLine));
      const template = departure && shown.text === departure.arm.text ? departure.template : weenieErrorText(d.errorType);
      reporter.serverCode('weenie_error', d.errorType, template, shown.sink);
    },
  } as never);
  const c = emptyCodecs();
  registerCombat1999(c, { player: () => ({ guid: PLAYER, eventSequence: 0 }) });
  const adapter = new Adapter1999(c, { account: 'acjs', log: () => {} });
  /** The server's NotifyWeenieError / NotifyUseDone(code): a flat 0x1C AttemptFailed {u32 code}. */
  const attemptFailed = (code: number): void => {
    for (const e of adapter.inbound(new Writer1999().u32(0x1c).i32(code).toBytes(), 4)) h.handleMessage(deserializeMessage(e));
  };
  /** The server's SendText(text, LTT_DEFAULT): a chat line, as main.ts's onServerMessage shows and reports it. */
  const serverText = (text: string, chatType = 0): void => {
    chat.push([text, chatType]);
    reporter.serverText('server_text', text, chatType);
  };
  return { clock, spew, chat, events, reporter, attemptFailed, serverText };
}

describe('era data', () => {
  it('only the 1999 era carries the lines; each is end of retail\'s own arm for the code', () => {
    expect(R1999.silentRefusalLines).toBe(SILENT_REFUSAL_LINES_1999);
    expect(REOR.silentRefusalLines).toBeNull();
    expect(RDM.silentRefusalLines).toBeNull();
    for (const [code, arm] of SILENT_REFUSAL_LINES_1999) expect(arm.text, `0x${code.toString(16)}`).toBe(weenieErrorText(code));
  });

  it('no code has a 1999 arm (a line is never doubled); 0x405 and 0x43 stay out', () => {
    for (const code of SILENT_REFUSAL_LINES_1999.keys()) expect(FAILURE_EVENT_TEXT_1999.has(code), `0x${code.toString(16)}`).toBe(false);
    expect(SILENT_REFUSAL_LINES_1999.has(MAGIC_SPELLBOOK_ADDSPELL_FAILURE)).toBe(false); // the server words it
    expect(SILENT_REFUSAL_LINES_1999.has(0x3fc)).toBe(false); // "You are not trained in that skill!" first
    expect(SILENT_REFUSAL_LINES_1999.has(0x1e)).toBe(false); // "<Name> is busy." first
    expect(SILENT_REFUSAL_LINES_1999.has(NO_MTABLE_DATA)).toBe(false); // a server motion failure
  });

  it('0x550 reads the same as the swear\'s own out-of-range line', () => {
    expect(SILENT_REFUSAL_LINES_1999.get(SILENT_WERROR_1999.MISSILE_OUT_OF_RANGE)!.text)
      .toBe(SOCIAL_REFUSAL_LINES_1999.byAction.get('swear')!.get(0x550)!.named);
  });
});

describe('AC1999: refusals of a click that showed nothing now get one line', () => {
  it('prod repro: a cast at a target past the spell\'s range (bare 0x550) says "Out of Range!" on the status line', () => {
    const k = client();
    k.attemptFailed(SILENT_WERROR_1999.MISSILE_OUT_OF_RANGE);
    expect(k.spew).toEqual(['Out of Range!']);
    expect(k.chat).toEqual([]);
    expect(k.events[0]).toMatchObject({ code: weenieCode(0x550), context: 'weenie_error', sink: 'spew', text: 'Out of Range!' });
  });

  it('healing kit, wand, key and moved-too-far: end of retail\'s text through its sink', () => {
    const k = client();
    for (const code of [0x4fc, 0x501, 0x4c8, 0x498, 0x4b2]) k.attemptFailed(code);
    expect(k.spew).toEqual([
      "You aren't trained in healing!",
      'You can only use Healing Kits on player characters.',
      "That item doesn't have enough Mana.",
      'You have moved too far!',
    ]);
    expect(k.chat).toEqual([["The key doesn't fit this lock.", 0]]);
    expect(k.events.map((e) => e.sink)).toEqual(['spew', 'spew', 'spew', 'spew', 'chat']);
    expect(k.events.find((e) => e.code === weenieCode(0x4b2))!.text).toBe("The key doesn't fit this lock.");
  });

  it('a code with a 1999 arm keeps the 1999 text (the arm wins)', () => {
    const k = client();
    k.attemptFailed(0x402);
    k.attemptFailed(0x1d);
    expect(k.chat).toEqual([['Your spell fizzled.', 7]]);
    expect(k.spew).toEqual(["You're too busy!"]);
  });

  it('other unarmed codes keep 1999\'s silence', () => {
    const k = client();
    k.attemptFailed(NO_MTABLE_DATA);
    k.attemptFailed(0x409); // MAGIC_GENERAL_FAILURE
    expect(k.spew).toEqual([]);
    expect(k.chat).toEqual([]);
    expect(k.events.every((e) => e.sink === 'none')).toBe(true);
  });
});

describe('0x405 after a research submission: the server already said why', () => {
  it('prod repro: the line shows once, nothing is added, and the code reports the line\'s sink (was "none")', () => {
    const k = client();
    k.reporter.noteActionSent(0x4b);
    k.serverText('That is not a valid spell formula.');
    k.attemptFailed(MAGIC_SPELLBOOK_ADDSPELL_FAILURE);
    expect(k.chat).toEqual([['That is not a valid spell formula.', 0]]);
    expect(k.spew).toEqual([]);
    const code = k.events.find((e) => e.code === weenieCode(MAGIC_SPELLBOOK_ADDSPELL_FAILURE))!;
    expect(code).toMatchObject({ context: 'weenie_error', sink: 'chat', action: 0x4b });
    expect(k.events.find((e) => e.context === 'server_text')).toMatchObject({ text: 'That is not a valid spell formula.', sink: 'chat' });
  });

  it('the inverse: the same code with no line before it, or a line too long before, still reports "none"', () => {
    const k = client();
    k.attemptFailed(MAGIC_SPELLBOOK_ADDSPELL_FAILURE);
    k.serverText('That is not a valid spell formula.');
    k.clock.t += SERVER_TEXT_PAIR_MS + 1;
    k.attemptFailed(MAGIC_SPELLBOOK_ADDSPELL_FAILURE);
    k.reporter.flush();
    expect(k.events.filter((e) => e.code === weenieCode(MAGIC_SPELLBOOK_ADDSPELL_FAILURE)).map((e) => e.sink)).toEqual(['none', 'none']);
  });

  it('a non-refusal server line (a notice) does not cover a silent code', () => {
    const k = client();
    k.serverText('You cast Flame Bolt I.', 7);
    k.attemptFailed(MAGIC_SPELLBOOK_ADDSPELL_FAILURE);
    expect(k.events.find((e) => e.code === weenieCode(MAGIC_SPELLBOOK_ADDSPELL_FAILURE))!.sink).toBe('none');
  });

  it('0x1E after the server\'s "<Name> is busy." is covered too, and that line now counts as a refusal', () => {
    expect(isServerTextRefusal('Agent Jameson is busy.', 0)).toBe(true);
    expect(isServerTextRefusal('Agent Jameson is busy crafting something.', 0)).toBe(true);
    const k = client();
    k.serverText('Agent Jameson is busy.');
    k.attemptFailed(0x1e);
    expect(k.events.find((e) => e.code === weenieCode(0x1e))!.sink).toBe('chat');
    expect(k.events.find((e) => e.context === 'server_text')!.text).toBe('_ is busy.');
  });

  it('a code that showed its own line keeps that line\'s sink, not the paired one', () => {
    const k = client();
    k.serverText('That is not a valid spell formula.');
    k.attemptFailed(0x1d);
    expect(k.events.find((e) => e.code === weenieCode(0x1d))!.sink).toBe('spew');
  });
});

describe('end of retail and Dark Majesty: unchanged', () => {
  it('their own switch: 0x550 / 0x4FC spew, 0x4B2 chat, 0x405 and 0x43 nothing', () => {
    for (const rules of [REOR, RDM]) {
      const k = client(rules);
      for (const code of [0x550, 0x4fc, 0x4b2, 0x405, 0x43]) k.attemptFailed(code);
      expect(k.spew).toEqual(['Out of Range!', "You aren't trained in healing!"]);
      expect(k.chat).toEqual([["The key doesn't fit this lock.", 0]]);
    }
  });

  it('deliverWeenieError with no table and no departure: the shared map decides', () => {
    const out: string[] = [];
    const ui = { displayErrorText: (t: string) => { out.push(t); }, addSystemMessage: () => {} };
    expect(deliverWeenieError(ui, 0x550, weenieErrorText(0x550))).toMatchObject({ sink: 'spew', type: WEENIE_ERROR_TEXT_TYPE_SPEW });
    expect(deliverWeenieError(ui, 0x405, weenieErrorText(0x405)).sink).toBe('none');
  });
});
