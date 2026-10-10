/**
 * DECOMP sweep 2026-09-30, group M — the client's reaction to server
 * messages, against the decompiled EoL client (reference/client-eol/decomp/
 * acclient-decompiled.annotated.c; docs/decomp-diff-sweep-2026-09-30.md):
 *
 *  M1  evasion lines        HandleEvasion{Attacker,Defender}NotificationEvent @ 0056c7a0 / 0056c620
 *  M3  kill / death lines   HandleVictimNotificationEvent @ 0056c410, HandlePlayerDeathEvent @ 0056c320
 *  M4  LoginComplete timing gmSmartBoxUI::UseTime (TAS_WORLD_FADE_IN) → SendLoginCompleteNotification @ 00562e90
 *  M5  TransientString      Handle_Communication__TransientString @ 0057d460 (0x1a)
 *  M7  confirmation text    Handle_Character__ConfirmationRequest @ 005640a0
 *  M11 PopupString dialog   Handle_Communication__PopUpString @ 0057fe80
 *  M12 channel listings     Handle_Communication__ChannelIndex @ 0057d0c0 / ChannelList @ 0057d230
 *
 * (M2 hit lines: verify-combat-dialog.ts / verify-attack-conditions.ts; M6:
 * verify-weenie-error-text.ts; M8: verify-end-trade-reason.ts; M9:
 * verify-allegiance-login-name-lookup.ts.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chatColorFor } from '@ac/shared';
import {
  addTextToScroll, evasionAttackerLine, evasionDefenderLine, victimOrKillerLine, playerKilledLine,
  transientStringLine, channelIndexLines, channelListLines, confirmationRequestText,
  CONFIRMATION_STRING_IDS, CONFIRMATION_STRING_TABLE, ConfirmationType, type ScrollLine,
} from '../packages/renderer/src/ui/ServerMessageText.js';
import { LoginCompleteNotifier } from '../packages/renderer/src/network/LoginCompleteNotifier.js';
import { TeleportAnimState } from '../packages/renderer/src/effects/PortalSpaceModel.js';
import {
  DatDatabase, DatReader, parseStringTable, registerStringTable, getStringPartsFromTable, acStringHash,
} from '../packages/dat-parser/src/index.js';

const REPO = resolve(__dirname, '..');
const LANG_DAT = resolve(REPO, 'dat/client_local_English.dat');

/** A recording AddTextToScroll surface. */
function recorder(): { calls: string[]; ui: Parameters<typeof addTextToScroll>[0] } {
  const calls: string[] = [];
  return {
    calls,
    ui: {
      displayErrorText: (t) => calls.push(`spew:${t}`),
      addSystemMessage: (t, c, ty) => calls.push(`chat:${ty}:${c}:${t}`),
    },
  };
}

describe('M1 DECOMP.evasion-chat-lines', () => {
  it('attacker side: "<name> evaded your attack." as CombatSelf 0x16', () => {
    expect(evasionAttackerLine('Drudge Skulker')).toEqual({ text: 'Drudge Skulker evaded your attack.', type: 0x16 });
  });
  it('defender side: "You evaded <name>!" as CombatEnemy 0x15', () => {
    expect(evasionDefenderLine('Drudge Skulker')).toEqual({ text: 'You evaded Drudge Skulker!', type: 0x15 });
  });
  it('the type picks the retail colour (0x16 light red, 0x15 dark red) and the Combat filters', () => {
    const r = recorder();
    addTextToScroll(r.ui, evasionAttackerLine('A'));
    addTextToScroll(r.ui, evasionDefenderLine('B'));
    expect(r.calls).toEqual([
      `chat:22:${chatColorFor(0x16)}:A evaded your attack.`,
      `chat:21:${chatColorFor(0x15)}:You evaded B!`,
    ]);
    expect(chatColorFor(0x16)).toBe('#f57572');
    expect(chatColorFor(0x15)).toBe('#ff3f3f');
  });
});

describe('M3 DECOMP.kill-death-chat-lines', () => {
  it('Killer and Victim notifications are type-0 lines (green), nothing for an empty string', () => {
    expect(victimOrKillerLine('You killed the Drudge!')).toEqual({ text: 'You killed the Drudge!', type: 0 });
    expect(victimOrKillerLine('')).toBeNull();
  });
  it('PlayerKilled is suppressed when we are the victim OR the killer', () => {
    const me = 0x50000001;
    expect(playerKilledLine('Bob was killed by Me', 0x50000002, me, me)).toBeNull();
    expect(playerKilledLine('Me was killed by Bob', me, 0x50000002, me)).toBeNull();
    expect(playerKilledLine('Bob was killed by Al', 0x50000002, 0x50000003, me))
      .toEqual({ text: 'Bob was killed by Al', type: 0 });
    expect(playerKilledLine('', 0x50000002, 0x50000003, me)).toBeNull();
  });
});

describe('M5 DECOMP.transient-string-notice', () => {
  it('a TransientString goes to the 0x1a spew strip, not a purple chat line', () => {
    const r = recorder();
    addTextToScroll(r.ui, transientStringLine('You are out of ammunition!'));
    expect(r.calls).toEqual(['spew:You are out of ammunition!']);
  });
});

describe('M7 DECOMP.confirmation-dialog-text (DAT-less fallback)', () => {
  it('ACE ConfirmationType values', () => {
    expect(ConfirmationType).toEqual({
      SwearAllegiance: 1, AlterSkill: 2, AlterAttribute: 3, Fellowship: 4,
      CraftInteraction: 5, Augmentation: 6, YesNo: 7,
    });
  });
  it('types 1 and 4 fill the string-table templates with the name', () => {
    expect(confirmationRequestText(1, 'Bob')).toBe('Bob would like to swear allegiance to you. Do you accept?');
    expect(confirmationRequestText(4, 'Bob')).toBe('Bob has invited you to join their fellowship. Do you accept?');
  });
  it('types 2 / 3 / 5 / 6 append " Continue?"; type 7 is as-is; others raise nothing', () => {
    for (const t of [2, 3, 5, 6]) expect(confirmationRequestText(t, 'Spend 10 credits?')).toBe('Spend 10 credits? Continue?');
    expect(confirmationRequestText(7, 'Do it?')).toBe('Do it?');
    expect(confirmationRequestText(0, 'x')).toBeNull();
    expect(confirmationRequestText(8, 'x')).toBeNull();
  });
  it('the ids are compute_str_hash of the retail tokens', () => {
    expect(CONFIRMATION_STRING_IDS.fellowship).toBe(acStringHash('ID_Fellowship_FellowshipRequest'));
    expect(CONFIRMATION_STRING_IDS.swearAllegiance).toBe(acStringHash('ID_Allegiance_AcceptSwearConfirmation'));
  });
});

describe.skipIf(!existsSync(LANG_DAT))('M7 — the templates come from StringTable 0x23000001', () => {
  beforeAll(() => {
    const buf = readFileSync(LANG_DAT);
    const db = new DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    registerStringTable(parseStringTable(new DatReader(db.getFileData(CONFIRMATION_STRING_TABLE)!)));
  });
  it('both templates exist as [prefix, suffix] around %PLAYER% and match the fallback wording', () => {
    expect(getStringPartsFromTable(CONFIRMATION_STRING_TABLE, CONFIRMATION_STRING_IDS.fellowship))
      .toEqual(['', ' has invited you to join their fellowship. Do you accept?']);
    expect(getStringPartsFromTable(CONFIRMATION_STRING_TABLE, CONFIRMATION_STRING_IDS.swearAllegiance))
      .toEqual(['', ' would like to swear allegiance to you. Do you accept?']);
    expect(confirmationRequestText(4, 'Bob')).toBe('Bob has invited you to join their fellowship. Do you accept?');
  });
});

describe('M12 DECOMP.admin-channel-list-text', () => {
  const texts = (lines: ScrollLine[]) => lines.map((l) => `${l.type}:${l.text}`);
  it('ChannelIndex: the header then "   name" per channel, all type 0', () => {
    expect(texts(channelIndexLines(['Admin', 'Sentinel']))).toEqual([
      '0:The following channels are available to you:', '0:   Admin', '0:   Sentinel',
    ]);
  });
  it('ChannelList: the listener header then "   name" per player; the header even when empty', () => {
    expect(texts(channelListLines(['Bob']))).toEqual([
      '0:The following characters are currently listening on the channel:', '0:   Bob',
    ]);
    expect(texts(channelListLines([]))).toEqual([
      '0:The following characters are currently listening on the channel:',
    ]);
  });
});

describe('M4 DECOMP.login-complete-timing — LoginCompleteNotifier', () => {
  function make() {
    let sent = 0;
    const n = new LoginCompleteNotifier({ send: () => { sent++; } });
    return { n, sent: () => sent };
  }

  it('first login: nothing is sent until the teleport animation finishes', () => {
    const { n, sent } = make();
    n.notePlayerCreated();
    n.notePlayerDescription([0xa1, 0xa2]);
    n.noteObjectCreated(0xa1);
    n.noteObjectCreated(0xa2);
    expect(sent()).toBe(0); // no send on PlayerCreate / the objects alone
    n.sendLoginCompleteNotification(); // TAS_WORLD_FADE_IN → TAS_OFF
    expect(sent()).toBe(1);
    expect(n.isPending).toBe(false);
  });

  it('a send before every contained object exists goes pending, and fires when the last one arrives', () => {
    const { n, sent } = make();
    n.notePlayerCreated();
    n.notePlayerDescription([0xa1, 0xa2]);
    n.noteObjectCreated(0xa1);
    n.sendLoginCompleteNotification();
    expect(sent()).toBe(0);
    expect(n.isPending).toBe(true);
    n.noteObjectCreated(0xa2); // AttemptSendLoginCompleteNotification
    expect(sent()).toBe(1);
    expect(n.isPending).toBe(false);
    n.noteObjectCreated(0xa3);
    expect(sent()).toBe(1); // no repeat without a new pending send
  });

  it('a pending send waits for player_desc_received too', () => {
    const { n, sent } = make();
    n.notePlayerCreated();
    n.sendLoginCompleteNotification(); // no desc yet: the lists are empty → sends
    expect(sent()).toBe(1);
    const b = make();
    b.n.sendLoginCompleteNotification(); // the player's weenie does not exist yet → pending
    expect(b.sent()).toBe(0);
    b.n.notePlayerCreated();
    b.n.noteObjectCreated(0x1);
    expect(b.sent()).toBe(0); // AttemptSend needs player_desc_received
    b.n.notePlayerDescription([]);
    expect(b.sent()).toBe(1);
  });

  it('a destroyed pack item never blocks a later teleport', () => {
    const { n, sent } = make();
    n.notePlayerCreated();
    n.notePlayerDescription([0xa1]);
    n.noteObjectCreated(0xa1);
    n.sendLoginCompleteNotification();
    n.noteObjectDeleted(0xa1); // e.g. a drunk potion
    n.sendLoginCompleteNotification(); // the next teleport's animation ends
    expect(sent()).toBe(2);
  });

  it('reset() starts a new character session', () => {
    const { n, sent } = make();
    n.notePlayerCreated();
    n.reset();
    n.sendLoginCompleteNotification();
    expect(sent()).toBe(0);
    expect(n.isPending).toBe(true);
  });
});

describe('GameUI (happy-dom): the teleport animation end and the PopupString dialog', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let H: any;
  let finished = 0;
  beforeAll(async () => {
    const { mountGameUI } = await import('./_harness/gameui.js');
    H = await mountGameUI({ callbacks: { onTeleportAnimationFinished: () => { finished++; } } });
    H.ui.setUIHost({ gameFov: 90, setViewDistanceRatio: () => {} });
    H.ui.playUISound = () => {};
  });
  afterAll(() => H?.teardown());

  it('M4: onTeleportAnimationFinished fires once, on the TAS_WORLD_FADE_IN → TAS_OFF step', () => {
    const ui = H.ui;
    ui.showPortalSpace();
    const t0 = performance.now() / 1000;
    ui.teleportTick(t0);
    ui.endPortalSpace();
    ui.teleportTick(t0 + 6.0);
    ui.teleportTick(t0 + 7.1);
    expect(ui.portalSpaceState).toBe(TeleportAnimState.WorldFadeIn);
    expect(finished).toBe(0); // the tunnel is gone but the world is still zooming in
    ui.teleportTick(t0 + 8.2);
    expect(ui.portalSpaceState).toBe(TeleportAnimState.Off);
    expect(finished).toBe(1);
    ui.teleportTick(t0 + 9);
    expect(finished).toBe(1);
  });

  it('M4: a torn-down animation (disconnect) never reports finished', () => {
    const ui = H.ui;
    const before = finished;
    ui.showPortalSpace();
    ui.teleportTick(performance.now() / 1000);
    ui.hidePortalSpace();
    expect(finished).toBe(before);
  });

  it('M11: PopupString raises the type-3 OK dialog; a second popup stacks; each OK closes its own', () => {
    const ui = H.ui;
    const doc = H.win.document;
    ui.showPopupStringDialog('Welcome to the server!');
    ui.showPopupStringDialog('Message of the day');
    const dialogs = [...doc.querySelectorAll('.ac-popup-string-dialog')] as HTMLElement[];
    expect(dialogs.length).toBe(2);
    expect(ui.popupStringDialogCount).toBe(2);
    // The same plate as the OK message dialog: 400x95, one OK at x=160.
    expect(dialogs[0].style.width).toBe('400px');
    expect(dialogs[0].querySelector('.ac-message-dialog-text')!.textContent).toContain('Welcome to the server!');
    const oks = dialogs[0].querySelectorAll('.ac-dialog-button');
    expect(oks.length).toBe(1);
    expect((oks[0] as HTMLElement).style.left).toBe('160px');
    // A PopupString is not the char-management error dialog: it does not block it.
    expect(ui.messageDialogOpen).toBe(false);
    (oks[0] as HTMLElement).dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
    expect(ui.popupStringDialogCount).toBe(1);
    expect(doc.querySelectorAll('.ac-popup-string-dialog').length).toBe(1);
    expect(doc.querySelector('.ac-popup-string-dialog .ac-message-dialog-text')!.textContent).toContain('Message of the day');
  });
});
