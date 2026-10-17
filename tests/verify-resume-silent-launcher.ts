/**
 * BUG.resume-silent-launcher — production 2026-10-17 02:34Z (Snowreap, Dark
 * Majesty era, launcher login): a link_dead drop's auto-resume got the
 * character list, the page closed its own socket 13 s later and sat on the
 * server select, and no telemetry said why. The resume's auto-enter called
 * onEnterWorld without EnterGame's Entering World dialog, so GDLE's "character
 * still in the world" (0x0D) retries ran behind a live character select (its
 * World box and EXIT lead to the launcher), and neither the retries nor the
 * return to the launcher reported anything.
 *
 * Now (verify-charselect-exit-enter.ts covers the dialog): the first retry of
 * each enter sends enter_retry (token 'resume' for the resume), every return
 * to the launcher sends left_for_launcher with its reason, a resume whose
 * character is gone sends resume_ended, and the bridge accepts all three.
 */
import { describe, it, expect } from 'vitest';
import { CharacterError } from '@ac/shared';
import { PreworldReporter, LAUNCHER_LEAVE_REASONS, type PreworldEvent, type LauncherLeaveReason } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { sanitizeClientPreworld, PREWORLD_OUTCOMES } from '../services/ws-tcp-bridge/src/clientPreworld.js';

function rig() {
  const sent: PreworldEvent[] = [];
  const clock = { t: 10_000 };
  const r = new PreworldReporter({
    endpoint: 'http://x/client-preworld', build: 'eb3bcb5e', era: () => 'classic-dereth-1-0', server: () => 'snowreap',
    screen: () => 'char-select', chargenStep: () => null, now: () => clock.t, trace: 'feedc0de12345678',
    send: (_u, raw) => { sent.push(JSON.parse(raw) as PreworldEvent); },
  });
  return { r, sent, clock };
}

describe('BUG.resume-silent-launcher — the resume\'s enter retries are visible', () => {
  it('enter_retry once per enter request, with the code, resume vs enter, and the time since the request', () => {
    const { r, sent, clock } = rig();
    r.loginStarted();
    r.characterList(3);
    r.enterRequested();
    clock.t += 1200;
    r.enterRetry(CharacterError.EnterGameCharacterInWorld, true);
    clock.t += 3000;
    r.enterRetry(CharacterError.EnterGameCharacterInWorld, true); // the second retry of the same enter: nothing
    const retries = sent.filter(e => e.outcome === 'enter_retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ outcome: 'enter_retry', code: 0x0d, token: 'resume', sinceEnterMs: 1200, screen: 'char-select' });
    // The player's own next enter is a new request: its first retry reports again.
    r.enterRequested();
    r.enterRetry(CharacterError.EnterGameCharacterInWorld, false);
    expect(sent.filter(e => e.outcome === 'enter_retry').map(e => e.token)).toEqual(['resume', 'enter']);
  });

  it('a resume that gave up on the budget still ends in enter_refused (the existing CharacterError path)', () => {
    const { r, sent } = rig();
    r.characterList(3);
    r.enterRequested();
    r.enterRetry(CharacterError.EnterGameCharacterInWorld, true);
    r.connectionError({ characterError: CharacterError.EnterGameCharacterInWorld }, null);
    expect(sent.map(e => e.outcome)).toEqual(['char_list', 'enter_retry', 'enter_refused']);
  });
});

describe('BUG.resume-silent-launcher — every return to the launcher says why', () => {
  it('left_for_launcher carries each closed reason; anything else sends nothing', () => {
    const { r, sent } = rig();
    for (const why of LAUNCHER_LEAVE_REASONS) r.leftForLauncher(why);
    r.leftForLauncher('typed text' as LauncherLeaveReason);
    expect(sent.map(e => [e.outcome, e.token])).toEqual(LAUNCHER_LEAVE_REASONS.map(w => ['left_for_launcher', w]));
  });

  it('resume_ended names a resume whose character is gone', () => {
    const { r, sent } = rig();
    r.resumeEnded('character_gone');
    expect(sent[0]).toMatchObject({ outcome: 'resume_ended', token: 'character_gone' });
  });
});

describe('BUG.resume-silent-launcher — the bridge keeps the new outcomes', () => {
  it('enter_retry / left_for_launcher / resume_ended pass its sanitizer field by field', () => {
    const { r, sent } = rig();
    r.enterRequested();
    r.enterRetry(CharacterError.EnterGameCharacterInWorld, true);
    r.leftForLauncher('world_box');
    r.resumeEnded('character_gone');
    for (const ev of sent) {
      expect(PREWORLD_OUTCOMES).toContain(ev.outcome);
      const clean = sanitizeClientPreworld(ev);
      expect(clean).toMatchObject({ outcome: ev.outcome, token: ev.token, code: ev.code, server: 'snowreap', screen: 'char-select' });
      expect(clean && 'net' in clean).toBe(false);
    }
  });
});
