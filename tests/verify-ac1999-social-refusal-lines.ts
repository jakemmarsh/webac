/**
 * BUG.ac1999-fellow-recruit-silent (prod 2026-11-02 21:55Z, build d0eb70b86): a 1999 player pressed
 * Recruit about 25 times in under a minute; the AC1999 server refused each with a bare 0x1C
 * WERROR_FELLOWSHIP_MEMBER (0x41A), which neither the 1999 client (UI_HandleFailureEvent @ 0x004ccd10)
 * nor end of retail (HandleFailureEvent @ 00571990) has an arm for, so telemetry logged sink "none"
 * and the player saw nothing.
 *
 * The fix (ui/SocialRefusalLines1999.ts): a refused recruit / swear whose code the era's switch left
 * silent gets one line, named after the request's target. Driven through shipped code: AC1999 0x1C
 * bytes through the real 1999 adapter and ServerMessageHandler, the era rules, the real 1999 failure
 * switch, deliverWeenieError and the RefusalReporter, as main.ts's onWeenieError composes them.
 */
import { describe, it, expect } from 'vitest';
import {
  SOCIAL_REFUSAL_LINES_1999, SOCIAL_REFUSAL_WINDOW_MS, SocialRefusalMemo, WERROR_1999, socialRefusalNameTemplates,
} from '../packages/renderer/src/ui/SocialRefusalLines1999';
import { FAILURE_EVENT_TEXT_1999 } from '../packages/renderer/src/ui/FailureEventText1999';
import { deliverWeenieError } from '../packages/renderer/src/ui/WeenieErrorNotices';
import { eraClientRules, type EraClientRules } from '../packages/renderer/src/era/EraFeatures';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles';
import { RefusalReporter, weenieCode, type RefusalEvent } from '../packages/renderer/src/telemetry/RefusalReporter';
import { matchClientTemplate, nameSafeText } from '../packages/renderer/src/telemetry/RefusalTemplates';
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
const RECRUIT = 0x50000044;
const NAMES: Record<number, string> = { [RECRUIT]: 'Kyra Tumerok' };
const nameOf = (g: number): string | undefined => NAMES[g];

/** One client: the real 1999 adapter + handler, with main.ts's onWeenieError composition. */
function client1999(rules: EraClientRules = R1999) {
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
      const departure = memo?.lineFor(d.errorType, clock.t, nameOf) ?? null;
      const silentLine = departure ? null : rules.silentRefusalLines?.get(d.errorType) ?? null;
      const shown = reporter.quietly(() => deliverWeenieError(ui, d.errorType, weenieErrorText(d.errorType), rules.failureEventText, departure?.arm ?? silentLine));
      const template = departure && shown.text === departure.arm.text ? departure.template : weenieErrorText(d.errorType);
      reporter.serverCode('weenie_error', d.errorType, template, shown.sink);
    },
  } as never);
  const c = emptyCodecs();
  registerCombat1999(c, { player: () => ({ guid: PLAYER, eventSequence: 0 }) });
  const adapter = new Adapter1999(c, { account: 'acjs', log: () => {} });
  /** The server's NotifyWeenieError: a flat 0x1C AttemptFailed {u32 code}. */
  const attemptFailed = (code: number): void => {
    for (const e of adapter.inbound(new Writer1999().u32(0x1c).i32(code).toBytes(), 4)) h.handleMessage(deserializeMessage(e));
  };
  return { clock, spew, chat, events, memo, attemptFailed };
}

describe('era data: only the 1999 era adds the lines', () => {
  it('1999 carries the departure table; end of retail and Dark Majesty have none', () => {
    expect(R1999.socialRefusalLines).toBe(SOCIAL_REFUSAL_LINES_1999);
    expect(REOR.socialRefusalLines).toBeNull();
    expect(RDM.socialRefusalLines).toBeNull();
  });

  it('no departure code has a 1999 arm, so a line is never doubled', () => {
    for (const m of [...SOCIAL_REFUSAL_LINES_1999.byAction.values(), SOCIAL_REFUSAL_LINES_1999.any]) {
      for (const code of m.keys()) expect(FAILURE_EVENT_TEXT_1999.has(code), `0x${code.toString(16)}`).toBe(false);
    }
  });

  it('the codes the server or another path already words stay out: squelched (server chat), locked recruiter (0x28B)', () => {
    const all = new Set([...SOCIAL_REFUSAL_LINES_1999.byAction.values(), SOCIAL_REFUSAL_LINES_1999.any].flatMap((m) => [...m.keys()]));
    expect(all.has(0x418)).toBe(false); // WERROR_FELLOWSHIP_SQUELCHED: the server SendTexts its own line
    expect(all.has(0x40e)).toBe(false); // WERROR_ALLEGIANCE_SQUELCHED: likewise
    expect(all.has(0x518)).toBe(false); // WERROR_FELLOWSHIP_LOCKED_RECRUITER: WithString, end of retail's chat line
  });
});

describe('AC1999 0x1C refusals of a recruit', () => {
  it('prod repro: FELLOW_RECRUIT refused with 0x41A now says who is already in a fellowship (was sink none)', () => {
    const k = client1999();
    k.memo!.note('recruit', RECRUIT, k.clock.t);
    k.clock.t += 120;
    k.attemptFailed(WERROR_1999.FELLOWSHIP_MEMBER);
    expect(k.spew).toEqual(['Kyra Tumerok is already a member of a Fellowship.']);
    expect(k.events).toHaveLength(1);
    expect(k.events[0]).toMatchObject({
      source: 'server', code: weenieCode(0x41a), context: 'weenie_error', sink: 'spew',
      text: '_ is already a member of a Fellowship.', // the name never goes out
    });
  });

  it('every one of a burst of presses gets its line (refusals arriving after the next send still read)', () => {
    const k = client1999();
    for (let i = 0; i < 6; i++) {
      k.memo!.note('recruit', RECRUIT, k.clock.t);
      k.clock.t += 80;
      if (i > 0) k.attemptFailed(WERROR_1999.FELLOWSHIP_MEMBER);
    }
    k.attemptFailed(WERROR_1999.FELLOWSHIP_MEMBER);
    expect(k.spew).toHaveLength(6);
  });

  it('ignoring requests (0x417); an unknown name falls back to "That person"', () => {
    const k = client1999();
    k.memo!.note('recruit', RECRUIT, k.clock.t);
    k.attemptFailed(WERROR_1999.FELLOWSHIP_IGNORING_REQUESTS);
    k.memo!.note('recruit', 0x5000ffff, k.clock.t);
    k.attemptFailed(WERROR_1999.FELLOWSHIP_MEMBER);
    expect(k.spew).toEqual([
      'Kyra Tumerok is not accepting fellowship requests.',
      'That person is already a member of a Fellowship.',
    ]);
  });

  it('task 3, checked 1999: 0x3D is the 1999 client\'s own "You charged too far!", unchanged; the arm wins over a departure', () => {
    const k = client1999();
    k.memo!.note('recruit', RECRUIT, k.clock.t);
    k.attemptFailed(0x3d); // WERROR_TOO_FAR (FellowshipManager::Recruit, 16 m or more)
    k.attemptFailed(0x41e); // full
    k.attemptFailed(0x1d); // busy
    expect(k.spew).toEqual(['You charged too far!', 'Your Fellowship is full', "You're too busy!"]);
  });

  it('the same code with no recruit pending, or after the window, keeps 1999\'s silence', () => {
    const k = client1999();
    k.attemptFailed(WERROR_1999.FELLOWSHIP_MEMBER);
    k.memo!.note('recruit', RECRUIT, k.clock.t);
    k.clock.t += SOCIAL_REFUSAL_WINDOW_MS + 1;
    k.attemptFailed(WERROR_1999.FELLOWSHIP_MEMBER);
    k.memo!.note('swear', RECRUIT, k.clock.t);
    k.attemptFailed(WERROR_1999.FELLOWSHIP_MEMBER); // not a swear's answer
    k.memo!.clear();
    k.attemptFailed(WERROR_1999.FELLOWSHIP_MEMBER);
    expect(k.spew).toEqual([]);
    expect(k.events.every((e) => e.sink === 'none')).toBe(true);
  });

  it('the recruitee of a locked fellowship (0x519, no action of theirs) gets end of retail\'s chat line', () => {
    const k = client1999();
    k.attemptFailed(WERROR_1999.FELLOWSHIP_LOCKED_RECRUITEE);
    expect(k.chat).toEqual([['The fellowship is locked, you were not added to the fellowship.', 0]]);
  });
});

describe('AC1999 0x1C refusals of a swear', () => {
  it('patron busy (0x412), ignoring requests (0x40D), out of range (0x550) each get one line', () => {
    const k = client1999();
    k.memo!.note('swear', RECRUIT, k.clock.t);
    k.attemptFailed(WERROR_1999.ALLEGIANCE_PATRON_BUSY);
    k.attemptFailed(WERROR_1999.ALLEGIANCE_IGNORING_REQUESTS);
    k.attemptFailed(WERROR_1999.MISSILE_OUT_OF_RANGE);
    k.attemptFailed(0x40b); // already sworn: the 1999 arm
    expect(k.spew).toEqual([
      'Kyra Tumerok is busy.',
      'Kyra Tumerok is not accepting allegiance requests.',
      'Out of Range!',
      "You've already sworn your Allegiance",
    ]);
  });

  it('0x550 from anything but a swear reads the same (BUG.ac1999-silent-refusals: an out-of-range cast)', () => {
    const k = client1999();
    k.memo!.note('recruit', RECRUIT, k.clock.t);
    k.attemptFailed(WERROR_1999.MISSILE_OUT_OF_RANGE);
    expect(k.spew).toEqual(['Out of Range!']);
  });
});

describe('end of retail and Dark Majesty: unchanged', () => {
  it('their switch: 0x41A / 0x417 / 0x412 / 0x40D stay silent, 0x550 and 0x519 keep retail\'s texts', () => {
    for (const rules of [REOR, RDM]) {
      const out: string[] = [];
      const ui = { displayErrorText: (t: string) => { out.push(`spew:${t}`); }, addSystemMessage: (t: string) => { out.push(`chat:${t}`); } };
      for (const code of [0x41a, 0x417, 0x412, 0x40d]) {
        expect(deliverWeenieError(ui, code, weenieErrorText(code), rules.failureEventText).sink).toBe('none');
      }
      expect(deliverWeenieError(ui, 0x550, weenieErrorText(0x550), rules.failureEventText)).toMatchObject({ sink: 'spew', type: WEENIE_ERROR_TEXT_TYPE_SPEW });
      deliverWeenieError(ui, 0x519, weenieErrorText(0x519), rules.failureEventText);
      expect(out).toEqual(['spew:Out of Range!', 'chat:The fellowship is locked, you were not added to the fellowship.']);
    }
  });
});

describe('refusal telemetry: the named lines key by template', () => {
  it('a named line scrubs to its template', () => {
    expect(socialRefusalNameTemplates()).toContain('%s is already a member of a Fellowship.');
    expect(matchClientTemplate('Kyra Tumerok is already a member of a Fellowship.')).toBe('_ is already a member of a Fellowship.');
    expect(nameSafeText('Kyra Tumerok is not accepting allegiance requests.').text).toBe('_ is not accepting allegiance requests.');
  });
});
