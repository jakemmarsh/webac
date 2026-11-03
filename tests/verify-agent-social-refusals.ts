/**
 * ac_fellowship recruit / ac_allegiance swear and break: a refusal that answers the request replaces the success
 * claim (packages/renderer/src/agent/socialRefusal.ts, AgentApi.fellowship / swearAllegiance /
 * breakAllegianceAnswered).
 *
 * 2026-11-02, AC1999: recruit printed "asked Claude Yak to join. They have 30 s to accept…" and then, under it, the
 * server's "Claude Yak is already a member of a Fellowship." (or "… is not accepting fellowship requests."). The
 * swear's own check knew only declined / refuse / cannot / not accepting / ignor, so "You charged too far!" and the
 * 1999 "… is busy." fell through to "asked to swear"; break said "broke from your patron" before any answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { isSocialRefusal, SOCIAL_REFUSAL_CODES } from '../packages/renderer/src/agent/socialRefusal.ts';
import { FAILURE_EVENT_TEXT_1999 } from '../packages/renderer/src/ui/FailureEventText1999.ts';
import { SOCIAL_REFUSAL_LINES_1999, SocialRefusalMemo, WERROR_1999 } from '../packages/renderer/src/ui/SocialRefusalLines1999.ts';
import { weenieErrorText, formatWeenieErrorWithString } from '../packages/shared/src/index.ts';
import { FakeHost } from './_harness/agentFake.ts';

const YAK = 0x5000000b;
const SPEW = 0x1a;

/** The line the AC1999 client shows for a refused recruit / swear (the real memo, as main.ts runs it). */
function line1999(action: 'recruit' | 'swear', code: number, name: string): string {
  const memo = new SocialRefusalMemo(SOCIAL_REFUSAL_LINES_1999);
  memo.note(action, YAK, 1000);
  const shown = memo.lineFor(code, 1200, () => name);
  if (!shown) throw new Error(`no 1999 line for 0x${code.toString(16)}`);
  return shown.arm.text;
}

describe('agent social refusals', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.add({ guid: YAK, name: 'Claude Yak', itemType: 0x10, objectDescFlags: 0x8 | 0x10, x: 81, y: 21 });
  });
  afterEach(() => vi.useRealTimers());

  /** The server answers the request 300 ms after it went out: each `reply` as a chat line, or a bare code. */
  const answer = (send: 'fellowshipAction' | 'swearAllegiance' | 'breakAllegiance', reply: Array<[string, number?] | number>) => {
    const orig = host[send] as (...a: unknown[]) => string | null;
    (host as unknown as Record<string, unknown>)[send] = (...a: unknown[]) => {
      const err = orig(...a);
      if (!err) setTimeout(() => { for (const r of reply) typeof r === 'number' ? api.pushWeenieError(r) : api.pushChat(r[0], r[1]); }, 300);
      return err;
    };
  };

  const recruit = async (reply: Array<[string, number?] | number>) => {
    answer('fellowshipAction', reply);
    const p = api.fellowship('recruit', 'Claude Yak');
    await vi.advanceTimersByTimeAsync(800);
    return p;
  };

  const RECRUIT_REFUSALS: Array<[string, Array<[string, number?] | number>]> = [
    ['AC1999: already in a fellowship (the client\'s own line for 0x41A)', [[line1999('recruit', WERROR_1999.FELLOWSHIP_MEMBER, 'Claude Yak'), SPEW], WERROR_1999.FELLOWSHIP_MEMBER]],
    ['AC1999: ignoring fellowship requests (0x417)', [[line1999('recruit', WERROR_1999.FELLOWSHIP_IGNORING_REQUESTS, 'Claude Yak'), SPEW]]],
    ['AC1999 failure switch: You charged too far!', [[FAILURE_EVENT_TEXT_1999.get(0x3d)!.text, SPEW]]],
    ['AC1999 failure switch: You\'re too busy!', [[FAILURE_EVENT_TEXT_1999.get(0x1d)!.text, SPEW]]],
    ['AC1999 failure switch: Unable to move to object!', [[FAILURE_EVENT_TEXT_1999.get(0x38)!.text, SPEW]]],
    ['AC1999 failure switch: Your Fellowship is full', [[FAILURE_EVENT_TEXT_1999.get(0x41e)!.text, SPEW]]],
    ['ACE: already a member (Broadcast chat)', [['Claude Yak is already a member of a Fellowship.', 0x00]]],
    ['ACE: not accepting, on the Fellowship channel, then FellowshipIgnoringRequests', [['Claude Yak is not accepting fellowship requests.', 0x12], [weenieErrorText(0x417)!, 0x00]]],
    ['ACE: the recruit is busy', [['Claude Yak is busy.', 0x00]]],
    ['end of retail: LockedFellowshipCannotRecruit_', [[formatWeenieErrorWithString(0x518, 'Claude Yak'), 0x00]]],
    ['end of retail: Olthoi cannot join', [[weenieErrorText(0x58b)!, 0x00]]],
  ];
  for (const [what, reply] of RECRUIT_REFUSALS) {
    it(`recruit: ${what} replaces the "asked … to join" claim, answered at once`, async () => {
      const r = await recruit(reply);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/^Claude Yak was not recruited: the server refused\n {2}\S/);
      expect(r.message).not.toMatch(/asked|30 s|ac_dialog/);
      const first = reply.find((x): x is [string, number?] => typeof x !== 'number')!;
      expect(r.message).toContain(first[0]);
      expect(host.sent).toContain("fellowship recruit Claude Yak 5000000b");
    });
  }

  it('recruit: a refusal code the era\'s client shows nothing for still refuses, named', async () => {
    const r = await recruit([WERROR_1999.FELLOWSHIP_MEMBER]);
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/^Claude Yak was not recruited: the server refused\n {2}refused \(WeenieError FellowshipMember\)/);
  });

  it('recruit: no answer, or only someone\'s words, keeps the 30 s claim (the dialog is theirs to answer)', async () => {
    answer('fellowshipAction', [['Claude Yak says, "I cannot join right now"', 0x02], ['[Fellowship] Claude Bob says, "Claude Yak is busy."', 0x12]]);
    const p = api.fellowship('recruit', 'Claude Yak');
    await vi.advanceTimersByTimeAsync(5200);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^asked Claude Yak to join\. They have 30 s .* ac_dialog button=Yes/);
  });

  it('recruit: an old refusal from before the request is not this one\'s answer', async () => {
    api.pushChat('Claude Yak is already a member of a Fellowship.', 0x00);
    api.pushWeenieError(0x41a);
    const p = api.fellowship('recruit', 'Claude Yak');
    await vi.advanceTimersByTimeAsync(5200);
    expect((await p).message).toMatch(/^asked Claude Yak to join/);
  });

  it('other fellowship buttons: a refusal reads as refused, not "sent (no change yet)"', async () => {
    answer('fellowshipAction', [[weenieErrorText(0x50f)!, 0x00]]);
    const p = api.fellowship('quit');
    await vi.advanceTimersByTimeAsync(800);
    expect(await p).toEqual({ ok: false, message: 'quit refused by the server\n  You do not belong to a Fellowship.' });
  });

  const SWEAR_REFUSALS: Array<[string, string]> = [
    ['AC1999: the patron is busy (0x412)', line1999('swear', WERROR_1999.ALLEGIANCE_PATRON_BUSY, 'Claude Yak')],
    ['AC1999: ignoring allegiance requests (0x40D)', line1999('swear', WERROR_1999.ALLEGIANCE_IGNORING_REQUESTS, 'Claude Yak')],
    ['AC1999: out of range (0x550)', line1999('swear', WERROR_1999.MISSILE_OUT_OF_RANGE, 'Claude Yak')],
    ['the approach: You charged too far!', FAILURE_EVENT_TEXT_1999.get(0x3d)!.text],
    ['already sworn', weenieErrorText(0x40b)!],
    ['not enough XP', weenieErrorText(0x40c)!],
  ];
  for (const [what, text] of SWEAR_REFUSALS) {
    it(`swear: ${what} reads as refused, not "asked to swear"`, async () => {
      answer('swearAllegiance', [[text, SPEW]]);
      const p = api.swearAllegiance('Claude Yak');
      await vi.advanceTimersByTimeAsync(800);
      const r = await p;
      expect(r.ok).toBe(false);
      expect(r.message).toBe(`Claude Yak did not take your oath: the server refused\n  ${text}`);
    });
  }

  it('break: waits for the answer; a refusal is said, a change is "broke", nothing is "asked … no change yet"', async () => {
    host.allegianceText = 'no allegiance (no patron, no vassals)';
    answer('breakAllegiance', [[weenieErrorText(0x495)!, 0x00]]);
    let p = api.breakAllegianceAnswered();
    await vi.advanceTimersByTimeAsync(800);
    expect(await p).toEqual({ ok: false, message: 'could not break from your patron: the server refused\n  No patron from which to break!' });

    host = new FakeHost(); api = new AgentApi(host);
    host.allegianceText = 'allegiance: 2 members\npatron: Jake Main (L50, online)';
    const orig = host.breakAllegiance;
    host.breakAllegiance = (n?: string) => { setTimeout(() => { host.allegianceText = 'no allegiance (no patron, no vassals)'; }, 300); return orig(n); };
    p = api.breakAllegianceAnswered();
    await vi.advanceTimersByTimeAsync(800);
    expect(await p).toEqual({ ok: true, message: 'broke from your patron\nno allegiance (no patron, no vassals)' });

    host.breakAllegiance = orig;
    p = api.breakAllegianceAnswered('Tink');
    await vi.advanceTimersByTimeAsync(5200);
    expect(await p).toEqual({ ok: true, message: 'asked to break allegiance with Tink; no change yet (ac_allegiance shows it)' });
    // The daemon's and the hosted connector's ac_allegiance action=break call the surface: it is the answered one.
    const surface = api.surface() as { breakAllegiance: (n?: string) => Promise<{ ok: boolean }> };
    const q = surface.breakAllegiance('Tink');
    await vi.advanceTimersByTimeAsync(5200);
    expect((await q).ok).toBe(true);
  });
});

describe('socialRefusal wording', () => {
  it('every 1999 failure-switch line a recruit or swear can draw is a refusal of it', () => {
    for (const req of ['recruit', 'swear'] as const) {
      for (const code of SOCIAL_REFUSAL_CODES[req]) {
        const arm = FAILURE_EVENT_TEXT_1999.get(code);
        if (arm) expect(isSocialRefusal(arm.text, req, true), `${req} 0x${code.toString(16)} ${arm.text}`).toBe(true);
      }
    }
  });
  it('every 1999 social line, named and generic, refuses its own request', () => {
    for (const [req, lines] of SOCIAL_REFUSAL_LINES_1999.byAction) {
      for (const l of lines.values()) {
        expect(isSocialRefusal(l.named.replace('%s', 'Claude Yak'), req, true)).toBe(true);
        expect(isSocialRefusal(l.generic, req, true)).toBe(true);
      }
    }
  });
  it('ordinary lines are not refusals', () => {
    for (const t of ['Claude Yak has joined your fellowship.', 'You have 5 free slots.', 'Claude Yak is now the leader of this fellowship.', 'Claude Yak swore allegiance to you.']) {
      expect(isSocialRefusal(t, 'recruit'), t).toBe(false);
      expect(isSocialRefusal(t, 'swear'), t).toBe(false);
    }
  });
});
