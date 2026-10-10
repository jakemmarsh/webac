/**
 * SWEEP1006B.message-reactions.fellowship-chat-lines-create-join
 *
 * Retail's gmFellowshipUI prints a type-0 chat line (AddTextToScroll(line, 0,
 * true, 0)) on create / recruit (RecvNotice_FellowshipUpdate @ 00490490),
 * join (FellowAdded @ 0048fc20), quit (FellowQuit @ 0048fae0), dismiss
 * (FellowDismissed @ 0048f970) and disband (FellowshipDisbanded @ 0048f8a0).
 * The strings are acclient.exe literals (wide, VAs in fellowshipChatLines.ts).
 *
 * Part 1 drives the pure line builders; part 2 drives the real GameUI
 * handlers main.ts calls and captures the chat lines they print.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  fellowshipUpdateLine, fellowAddedLine, fellowQuitLine, fellowDismissedLine, fellowshipDisbandedLine,
} from '../packages/renderer/src/ui/fellowshipChatLines.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { ChatMessageType } from '@ac/shared';

const ME = 0x50000001;
const LEADER = 0x50000002;
const OTHER = 0x50000003;

const snap = (leaderGuid: number, guids: Array<[number, string]>) => ({
  fellowshipName: 'Dereth Rangers', leaderGuid,
  fellows: guids.map(([guid, name]) => ({ guid, name })),
});

describe('fellowship chat line builders (retail gmFellowshipUI)', () => {
  it('created: we lead and had no fellowship before', () => {
    expect(fellowshipUpdateLine(null, snap(ME, [[ME, 'Me']]), ME))
      .toBe('You have created the Fellowship of Dereth Rangers.');
  });

  it('recruited: someone else leads; the open/closed word prints as "a" (narrow %hs on a wide literal)', () => {
    expect(fellowshipUpdateLine(null, snap(LEADER, [[LEADER, 'Lead'], [ME, 'Me']]), ME))
      .toBe('You have been recruited into the Dereth Rangers fellowship, a fellowship led by Lead.');
  });

  it('a FullUpdate while already in a fellowship prints nothing', () => {
    const prev = snap(ME, [[ME, 'Me']]);
    expect(fellowshipUpdateLine(prev, snap(ME, [[ME, 'Me'], [OTHER, 'Other']]), ME)).toBeNull();
  });

  it('an empty previous fellowship still counts as none (retail +0x14 == 0 test)', () => {
    expect(fellowshipUpdateLine(snap(ME, []), snap(ME, [[ME, 'Me']]), ME))
      .toBe('You have created the Fellowship of Dereth Rangers.');
  });

  it('fellow added only for a guid not already in the fellowship', () => {
    const prev = snap(ME, [[ME, 'Me']]);
    expect(fellowAddedLine(prev, { guid: OTHER, name: 'Other' })).toBe('Other is now a member of your Fellowship.');
    expect(fellowAddedLine(prev, { guid: ME, name: 'Me' })).toBeNull();
    expect(fellowAddedLine(null, { guid: OTHER, name: 'Other' })).toBeNull();
  });

  it('quit: self vs another fellow vs a stranger', () => {
    const s = snap(LEADER, [[LEADER, 'Lead'], [ME, 'Me'], [OTHER, 'Other']]);
    expect(fellowQuitLine(s, ME, ME)).toBe('You are no longer a member of the Dereth Rangers Fellowship.');
    expect(fellowQuitLine(s, OTHER, ME)).toBe('Other has left your Fellowship.');
    expect(fellowQuitLine(s, 0x50000099, ME)).toBeNull();
    expect(fellowQuitLine(null, ME, ME)).toBeNull();
  });

  it('dismissed: self names the leader; others depend on whether we lead', () => {
    const notLeading = snap(LEADER, [[LEADER, 'Lead'], [ME, 'Me'], [OTHER, 'Other']]);
    expect(fellowDismissedLine(notLeading, ME, ME)).toBe('Lead has dismissed you from the Fellowship.');
    expect(fellowDismissedLine(notLeading, OTHER, ME)).toBe('Other has been dismissed from the Fellowship.');
    const leading = snap(ME, [[ME, 'Me'], [OTHER, 'Other']]);
    expect(fellowDismissedLine(leading, OTHER, ME)).toBe('You dismiss Other from your Fellowship.');
    expect(fellowDismissedLine(leading, 0x50000099, ME)).toBeNull();
  });

  it('disbanded: leader vs member; nothing without a fellowship', () => {
    expect(fellowshipDisbandedLine(snap(ME, [[ME, 'Me']]), ME)).toBe('You have disbanded your Fellowship.');
    expect(fellowshipDisbandedLine(snap(LEADER, [[LEADER, 'Lead'], [ME, 'Me']]), ME)).toBe('Lead has disbanded your Fellowship.');
    expect(fellowshipDisbandedLine(null, ME)).toBeNull();
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

function fellow(guid: number, name: string) {
  return { guid, name, level: 20, healthCurrent: 50, healthMax: 50, staminaCurrent: 60, staminaMax: 60, manaCurrent: 40, manaMax: 40, shareLoot: true };
}
function full(leaderGuid: number, fellows: ReturnType<typeof fellow>[]) {
  return { fellowshipName: 'Dereth Rangers', leaderGuid, shareXP: true, evenShare: true, open: true, isLocked: false, selfGuid: ME, fellows };
}

describe('GameUI fellowship server events print retail lines as type-0 chat', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let lines: Array<{ text: string; type: number }>;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'animationFrame');
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const real = ui.addSystemMessage.bind(ui);
    ui.addSystemMessage = (text: string, color?: string, type?: number, win?: number) => {
      lines.push({ text, type: type ?? -1 });
      real(text, color, type, win);
    };
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));
  beforeEach(() => { ui.setFellowshipData(null); lines = []; });

  it('create, join, quit, disband as the leader', () => {
    ui.applyFellowshipFullUpdate(full(ME, [fellow(ME, 'Me')]));
    ui.updateFellowshipMember(fellow(OTHER, 'Other'));
    ui.updateFellowshipMember(fellow(OTHER, 'Other')); // vitals refresh: no line
    ui.applyFellowshipFullUpdate(full(ME, [fellow(ME, 'Me'), fellow(OTHER, 'Other')])); // no line
    ui.handleFellowshipQuitOrDismiss(OTHER, ME, 'quit');
    ui.applyFellowshipDisband(ME);
    expect(lines).toEqual([
      { text: 'You have created the Fellowship of Dereth Rangers.', type: ChatMessageType.Broadcast },
      { text: 'Other is now a member of your Fellowship.', type: ChatMessageType.Broadcast },
      { text: 'Other has left your Fellowship.', type: ChatMessageType.Broadcast },
      { text: 'You have disbanded your Fellowship.', type: ChatMessageType.Broadcast },
    ]);
    expect(ChatMessageType.Broadcast).toBe(0);
    expect(ui.fellowship).toBeNull();
  });

  it('recruited, then dismissed by the leader (name read before the fellowship is cleared)', () => {
    ui.applyFellowshipFullUpdate(full(LEADER, [fellow(LEADER, 'Lead'), fellow(ME, 'Me')]));
    ui.handleFellowshipQuitOrDismiss(ME, ME, 'dismiss');
    expect(lines.map((l) => l.text)).toEqual([
      'You have been recruited into the Dereth Rangers fellowship, a fellowship led by Lead.',
      'Lead has dismissed you from the Fellowship.',
    ]);
    expect(ui.fellowship).toBeNull();
  });

  it('a leader dismissing a member; a disband with no fellowship prints nothing', () => {
    ui.applyFellowshipFullUpdate(full(ME, [fellow(ME, 'Me'), fellow(OTHER, 'Other')]));
    lines = [];
    ui.handleFellowshipQuitOrDismiss(OTHER, ME, 'dismiss');
    expect(lines.map((l) => l.text)).toEqual(['You dismiss Other from your Fellowship.']);
    ui.setFellowshipData(null);
    lines = [];
    ui.applyFellowshipDisband(ME);
    expect(lines).toEqual([]);
  });
});
