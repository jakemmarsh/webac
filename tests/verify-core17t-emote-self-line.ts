/**
 * CORE.17.t — slash-emote chat lines are composed the retail way.
 *
 * Ground truth (decompiled EoL client, docs/retail-client-symbols.md CORE.17.t):
 *  - ClientCommunicationSystem::Pose @ 00580480: InqChatPoseCommand →
 *    { pose, myEmote, otherEmote }; "%p" in otherEmote → "his" (Gender == 1)
 *    / "her"; Event_SoulEmote(otherEmote) to the server (0x01E1); the self
 *    line via Handle_Communication__HearSoulEmote(0, "You", myEmote).
 *  - Handle_Communication__HearSoulEmote @ 0057d020: sender == player_id →
 *    return without printing (the server's echo of our own emote is dropped).
 *  - Handle_Communication__HearEmote @ 0057cbe0: name + (text[0] == '\''
 *    ? "" : " ") + text, chat type 0x0C.
 *  - The EoL ChatPoseTable strings carry no subject ("wave." / "waves.").
 *
 * FAITHFUL.509 (tests/verify-no-double-you-emote-prefix.ts, now retired)
 * stripped the "You " on the premise that the DAT already carried it — its
 * evidence was a synthetic fixture. This file replaces that source-text pin
 * with behavioural checks over the shipped helpers and the real DAT.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadDomWindow } from './_harness/dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SELF_EMOTE_SPEAKER,
  substituteEmotePronoun,
  composeHeardEmoteLine,
  composeSelfEmoteLine,
  isOwnSoulEmoteEcho,
} from '../packages/shared/src/emote-lines';
import { ChatPoseTable } from '../packages/dat-parser/src/file-types/ChatPoseTable';
import { DatReader } from '../packages/dat-parser/src/DatReader';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');
const CHAT_POSE_TABLE_ID = 0x0E000007;

describe('CORE.17.t — the self line is "You" + " " + myEmote (Pose @ 00580480 → HearEmote @ 0057cbe0)', () => {
  it('prepends the retail speaker "You" with a single space', () => {
    expect(SELF_EMOTE_SPEAKER).toBe('You');
    expect(composeSelfEmoteLine('wave.')).toBe('You wave.');
    expect(composeSelfEmoteLine('decide to rest for a while.')).toBe('You decide to rest for a while.');
  });

  it('never doubles the prefix — the DAT text is used as the verb phrase only', () => {
    expect(composeSelfEmoteLine('wave.')).not.toMatch(/You You/);
    expect(composeSelfEmoteLine('wave.').split('You ').length).toBe(2);
  });

  it('HearEmote joins name and text with a space unless the text starts with an apostrophe', () => {
    expect(composeHeardEmoteLine('Aerlinthe', 'waves.')).toBe('Aerlinthe waves.');
    expect(composeHeardEmoteLine('Aerlinthe', "'s hat falls off.")).toBe("Aerlinthe's hat falls off.");
    expect(composeHeardEmoteLine('You', "'re tired.")).toBe("You're tired.");
  });
});

describe('CORE.17.t — "%p" becomes the actor\'s possessive pronoun (Pose @ 00580480, PropertyInt Gender 0x71)', () => {
  it('Gender 1 (Male) → "his", every occurrence', () => {
    expect(substituteEmotePronoun('puts %p hands on %p hips.', 1)).toBe('puts his hands on his hips.');
  });

  it('any other gender value → "her"', () => {
    expect(substituteEmotePronoun('shakes %p fist.', 2)).toBe('shakes her fist.');
    expect(substituteEmotePronoun('shakes %p fist.', 0)).toBe('shakes her fist.');
  });

  it('text without a placeholder passes through unchanged', () => {
    expect(substituteEmotePronoun('waves.', 1)).toBe('waves.');
  });
});

describe('CORE.17.t — the server echo of our own soul emote is dropped (HearSoulEmote @ 0057d020)', () => {
  it('sender == our player id → dropped', () => {
    expect(isOwnSoulEmoteEcho(0x50000123, 0x50000123)).toBe(true);
  });

  it('another sender → rendered', () => {
    expect(isOwnSoulEmoteEcho(0x50000124, 0x50000123)).toBe(false);
  });

  it('no player id yet (pre-login) → never dropped', () => {
    expect(isOwnSoulEmoteEcho(0x50000123, null)).toBe(false);
    expect(isOwnSoulEmoteEcho(0x50000123, undefined)).toBe(false);
  });
});

describe.skipIf(!existsSync(PORTAL))('CORE.17.t — the real EoL ChatPoseTable carries no subject', () => {
  let table: ChatPoseTable;

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase');
    const db = openDat(PORTAL);
    const data = db.getFileData(CHAT_POSE_TABLE_ID);
    if (!data) throw new Error('0x0E000007 (ChatPoseTable) missing from client_portal.dat');
    table = ChatPoseTable.read(new DatReader(data));
  });

  it('no myEmote starts with "You" and no string carries a "%s" name placeholder', () => {
    expect(table.stateToEmote.size).toBeGreaterThan(0);
    for (const [state, e] of table.stateToEmote) {
      expect(e.myEmote, state).not.toMatch(/^You\b/);
      expect(e.myEmote, state).not.toContain('%s');
      expect(e.otherEmote, state).not.toContain('%s');
    }
  });

  it('/afk and /wave compose the retail self lines from the DAT text', () => {
    expect(composeSelfEmoteLine(table.myEmoteFor('afk')!)).toBe('You decide to rest for a while.');
    expect(composeSelfEmoteLine(table.myEmoteFor('wave')!)).toBe('You wave.');
    expect(composeSelfEmoteLine(table.myEmoteFor('sit')!)).toBe('You sit down.');
  });

  it('the text shipped to the server is the 3rd-person form with the pronoun resolved', () => {
    expect(substituteEmotePronoun(table.otherEmoteFor('afk')!, 1)).toBe('decides to rest for a while.');
    expect(substituteEmotePronoun(table.otherEmoteFor('wave')!, 2)).toBe('waves.');
    expect(substituteEmotePronoun(table.otherEmoteFor('akimbo')!, 1)).toBe('puts his hands on his hips.');
    expect(substituteEmotePronoun(table.otherEmoteFor('akimbo')!, 2)).toBe('puts her hands on her hips.');
    expect(composeHeardEmoteLine('Aerlinthe', substituteEmotePronoun(table.otherEmoteFor('shakefist')!, 2))).toBe('Aerlinthe shakes her fist.');
  });
});

// ---------------------------------------------------------------------------
// The chat log row carries its source text + chat type as data attributes
// (the row itself is canvas-rendered, so tooling reads dataset.chatText).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('CORE.17.t — a posted emote line is a type-0x0C row whose dataset carries the text (happy-dom, real GameUI)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ChatMessageTypeEnum: any;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) g[key] = key === 'window' ? domWindow : domWindow[key];
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
    ChatMessageTypeEnum = (await import('../packages/shared/src/enums/ChatMessageType.js')).ChatMessageType;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function stubLayoutRenderer(ui: any): void {
    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div') as HTMLElement;
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const getOrCreate = (id: number): HTMLElement => {
        let el = elements.get(id);
        if (!el) { el = domWindow.document.createElement('div') as HTMLElement; root.appendChild(el); elements.set(id, el); }
        return el;
      };
      return {
        root,
        elements: { get: (id: number) => getOrCreate(id), set: () => {} },
        setText: () => {}, setInteractive: () => {}, setState: () => {},
        setVisible: () => {}, setFill: () => {}, setPalette: () => {},
        setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
        close: () => { root.remove(); }, destroy: () => { root.remove(); },
      };
    };
    ui.getTexURL = () => null;
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      getTextureDataURLWithAlpha: () => null,
    };
  }

  it('addSystemMessage("You wave.", …, Emote) → one row, dataset.chatText "You wave.", dataset.chatType "12"', () => {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    stubLayoutRenderer(ui);
    ui.showGame();
    const chat = container.querySelector('#chat-messages') as HTMLElement;
    expect(chat).toBeTruthy();
    const before = chat.children.length;
    ui.addSystemMessage(composeSelfEmoteLine('wave.'), '#c0c0c0', ChatMessageTypeEnum.Emote);
    expect(chat.children.length).toBe(before + 1);
    const row = chat.children[chat.children.length - 1] as HTMLElement;
    expect(row.dataset.chatText).toBe('You wave.');
    expect(row.dataset.chatType).toBe(String(ChatMessageTypeEnum.Emote));
    expect(ChatMessageTypeEnum.Emote).toBe(0x0C);
  });
});
