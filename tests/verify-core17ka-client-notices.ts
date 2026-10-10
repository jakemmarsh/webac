/**
 * CORE.17.k.a — client-originated notices go through their retail sink.
 *
 * Retail (decompiled EoL client) routes text the CLIENT authors three ways:
 *   - spew box: `SendNotice_DisplayStringInfo(0x1a, …)` / `AddTextToScroll(…,
 *     0x1a, …)` — every argument/validation failure of a chat command
 *     (DoTell @ 363430, DoReply @ 363131/363147, DoReTell @ 363301, DoFriends
 *     @ 367119, DoFriendsAdd @ 364592/364635, DoSquelch @ 365356, DoPermit @
 *     363913, DoConsent @ 368933, DoHouse @ 370954, DoAllegiance @ 368645) and
 *     the UI's own pre-checks (cast target @ 350300, portal storm @ 347589+).
 *   - chat (type 0): state confirmations — AFK @ 367940/367945, consent @
 *     368840/368866, "Turbine chat is not available." @ 368724.
 *   - nothing: commands retail never had (no Do* handler) — ours echo to the
 *     developer console.
 *
 * These tests drive the real catalogue + dispatcher (ClientNotices.ts), the
 * real main.ts-facing surface through a fake GameUI, and the real GameUI in
 * happy-dom for the spew-vs-chat split.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadDomWindow } from './_harness/dom.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CLIENT_NOTICES, raiseClientNotice, allClientNotices, type ClientNotice, type NoticeSurface,
} from '../packages/renderer/src/ui/ClientNotices.js';
import { portalStormPresentation } from '../packages/renderer/src/network/portalStormEvents.js';
import { ERROR_TEXT_TYPE } from '../packages/renderer/src/ui/SpewBoxModel.js';

function fakeUI() {
  const spew: string[] = [];
  const chat: Array<{ text: string; color?: string; type?: number }> = [];
  const log: string[] = [];
  const ui: NoticeSurface = {
    displayErrorText: (t) => { spew.push(t); },
    addSystemMessage: (text, color, type) => { chat.push({ text, color, type }); },
  };
  return { ui, spew, chat, log: (line: string) => log.push(line), lines: log };
}

describe('CORE.17.k.a — raiseClientNotice delivers each sink exactly once', () => {
  it('spew notices reach displayErrorText only', () => {
    const f = fakeUI();
    expect(raiseClientNotice(f.ui, CLIENT_NOTICES.castNoTarget, { log: f.log })).toBe('spew');
    expect(f.spew).toEqual(['You must select a suitable target before casting this spell']);
    expect(f.chat).toEqual([]);
    expect(f.lines).toEqual([]);
  });

  it('chat notices reach addSystemMessage with the caller colour/type only', () => {
    const f = fakeUI();
    expect(raiseClientNotice(f.ui, CLIENT_NOTICES.afkOn, { color: '#abcdef', type: 0, log: f.log })).toBe('chat');
    expect(f.chat).toEqual([{ text: 'You are now set to away-from-keyboard.', color: '#abcdef', type: 0 }]);
    expect(f.spew).toEqual([]);
    expect(f.lines).toEqual([]);
  });

  it('console notices never touch the UI', () => {
    const f = fakeUI();
    expect(raiseClientNotice(f.ui, CLIENT_NOTICES.reconnecting, { log: f.log })).toBe('console');
    expect(f.lines).toEqual(['[AC] Reconnecting to the ACE server…']);
    expect(f.spew).toEqual([]);
    expect(f.chat).toEqual([]);
  });

  it('a text override keeps the entry sink (dynamic notices)', () => {
    const f = fakeUI();
    raiseClientNotice(f.ui, CLIENT_NOTICES.castNoTarget, { text: 'Pick a target', log: f.log });
    raiseClientNotice(f.ui, CLIENT_NOTICES.restoredToLife, { text: 'Restored: x', log: f.log });
    expect(f.spew).toEqual(['Pick a target']);
    expect(f.lines).toEqual(['[AC] Restored: x']);
  });

  it('every catalogue entry is frozen, uniquely keyed, non-empty and cited', () => {
    const all = allClientNotices();
    expect(all.length).toBe(Object.keys(CLIENT_NOTICES).length);
    expect(all.length).toBeGreaterThan(20); // the command-feedback entries moved to chat/commands/ (2026-10-06)
    const ids = new Set<string>();
    for (const [key, entry] of Object.entries(CLIENT_NOTICES) as Array<[string, ClientNotice]>) {
      expect(entry.id).toBe(key);
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(Object.isFrozen(entry)).toBe(true);
      expect(entry.text.length).toBeGreaterThan(0);
      expect(entry.cite.length).toBeGreaterThan(0);
      expect(['spew', 'chat', 'console']).toContain(entry.sink);
    }
  });
});

describe('CORE.17.k.a — retail wording and sink per command family', () => {
  const spew = (k: keyof typeof CLIENT_NOTICES, text: string) => {
    expect(CLIENT_NOTICES[k].sink).toBe('spew');
    expect(CLIENT_NOTICES[k].text).toBe(text);
  };
  const chat = (k: keyof typeof CLIENT_NOTICES, text: string) => {
    expect(CLIENT_NOTICES[k].sink).toBe('chat');
    expect(CLIENT_NOTICES[k].text).toBe(text);
  };
  const consoleOnly = (k: keyof typeof CLIENT_NOTICES) => expect(CLIENT_NOTICES[k].sink).toBe('console');

  it('state confirmations are plain chat lines (type 0) with the retail wording', () => {
    chat('afkOn', 'You are now set to away-from-keyboard.');
    chat('afkOff', 'You are no longer set to away-from-keyboard.');
  });

  it('SWEEP1006B — "Logging off..." is CPlayerSystem::RequestLogOff\'s untargeted type-0 chat line (ASCII dots)', () => {
    chat('loggingOff', 'Logging off...');
    expect(CLIENT_NOTICES.loggingOff.commandFeedback).toBe(false);
    const f = fakeUI();
    expect(raiseClientNotice(f.ui, CLIENT_NOTICES.loggingOff, { log: f.log })).toBe('chat');
    expect(f.chat.map((c) => c.text)).toEqual(['Logging off...']);
    expect(f.lines).toEqual([]);
    expect(f.spew).toEqual([]);
  });

  it('the cast pre-check uses the retail 0x1a literal', () => {
    // (Not enough mana is the server's WeenieError 0x401, printed by
    // HandleFailureEvent — retail has no local mana pre-check.)
    spew('castNoTarget', 'You must select a suitable target before casting this spell');
  });

  it('the portal storm notices are 0x1a and identical to portalStormPresentation()', () => {
    spew('portalStormBrewing', portalStormPresentation('brewing').text);
    spew('portalStormImminent', portalStormPresentation('imminent').text);
    spew('portalStormSubsided', portalStormPresentation('subsided').text);
  });

  it('fellowship / allegiance guards are validation failures (0x1a); retail literals where they exist', () => {
    for (const k of ['noTargetSelected', 'swearNeedsPlayer', 'swearAlreadyMember', 'breakNeedsPlayer'] as const) {
      expect(CLIENT_NOTICES[k].sink).toBe('spew');
    }
  });

  it('commands retail never had echo to the console only', () => {
    for (const k of [
      'reconnecting', 'allegianceSwearing', 'restoredToLife',
    ] as const) consoleOnly(k);
  });

  it('BUG.main-chat-shows-error-lines-in-retail — Do* feedback targets the command source window; UI sites and window-0 lines do not', () => {
    const targets: Array<{ text: string; target?: number }> = [];
    const surface: NoticeSurface = {
      displayErrorText: (text, target) => { targets.push({ text, target }); },
      addSystemMessage: (text, _c, _t, target) => { targets.push({ text, target }); },
      commandSourceWindowId: 3,
    };
    // Do* command feedback now prints through the retail command system
    // (chat/commands/, CommandRun.reply → the source window); the catalogue
    // holds only UI-site notices.
    // SendNotice_DisplayStringInfo(0x1a, str) UI sites and AddTextToScroll(…, 0) — untargeted.
    for (const k of ['castNoTarget', 'castNoSpellSelected', 'portalStormBrewing', 'afkOn', 'afkOff', 'swearNeedsPlayer'] as const) {
      expect(CLIENT_NOTICES[k].commandFeedback).toBe(false);
      targets.length = 0;
      raiseClientNotice(surface, CLIENT_NOTICES[k]);
      expect(targets).toEqual([{ text: CLIENT_NOTICES[k].text, target: 0 }]);
    }
    // A surface that never saw a typed command falls back to untargeted.
    const bare: NoticeSurface = { displayErrorText: (text, target) => { targets.push({ text, target }); }, addSystemMessage: () => {} };
    targets.length = 0;
    raiseClientNotice(bare, CLIENT_NOTICES.castNoTarget);
    expect(targets).toEqual([{ text: CLIENT_NOTICES.castNoTarget.text, target: 0 }]);
  });

  it('no notice text carries a trailing newline or whitespace (retail right-trims spew items)', () => {
    for (const entry of allClientNotices()) expect(entry.text).toBe(entry.text.replace(/\s+$/u, ''));
  });
});

/* ── Real GameUI in happy-dom: spew vs chat split ─────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('CORE.17.k.a — real GameUI: spew notices stay out of the chat log, chat notices stay out of the spew box', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) g[key] = key === 'window' ? domWindow : domWindow[key];
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
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

  function makeUI() {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    stubLayoutRenderer(ui);
    ui.showGame();
    const rows = () => [...container.querySelectorAll('#hud-spew-box .spew-item')].map((r) => (r as HTMLElement).textContent);
    const chat = () => (container.querySelector('#chat-messages') as HTMLElement).textContent ?? '';
    return { ui, rows, chat };
  }

  // BUG.main-chat-shows-error-lines-in-retail: DoTell @ 363430 targets
  // m_idCurrentCommandSource, so the line ALSO lands in the chat window the
  // command came from (main = 8 by default) despite Errors being off —
  // verification/bug-spew-under-vitals/retail-two-lines.png shows it red in
  // the retail main chat. A UI-site 0x1a notice stays spew-only.
  it('a @tell usage failure is a spew row AND a line in the source (main) chat; a UI-site 0x1a notice is spew-only', () => {
    const { ui, rows, chat } = makeUI();
    // The command system prints DoTell's 0x1a line to the command's window (CommandRun.reply → print(…, 0x1a, source)).
    ui.displayErrorText('Use comma after the name for targeted chat.', 8);
    expect(rows()).toEqual(['Use comma after the name for targeted chat.']);
    expect(chat()).toContain('Use comma after the name for targeted chat.');
    raiseClientNotice(ui, CLIENT_NOTICES.castNoTarget);
    expect(rows()[0]).toBe(CLIENT_NOTICES.castNoTarget.text);
    expect(chat()).not.toContain(CLIENT_NOTICES.castNoTarget.text);
  });

  it('an AFK confirmation is a chat line and not a spew row', () => {
    const { ui, rows, chat } = makeUI();
    raiseClientNotice(ui, CLIENT_NOTICES.afkOn, { color: '#ffffff' });
    expect(rows()).toEqual([]);
    expect(chat()).toContain('You are now set to away-from-keyboard.');
  });

  it('a console notice leaves both surfaces untouched', () => {
    const { ui, rows, chat } = makeUI();
    const lines: string[] = [];
    raiseClientNotice(ui, CLIENT_NOTICES.reconnecting, { log: (l) => lines.push(l) });
    expect(rows()).toEqual([]);
    expect(chat()).not.toContain('Reconnecting');
    expect(lines).toEqual(['[AC] Reconnecting to the ACE server…']);
  });

  it('SWEEP1006B — "Logging off..." lands in the main chat log as a line, not in the spew box or the console', () => {
    const { ui, rows, chat } = makeUI();
    const lines: string[] = [];
    raiseClientNotice(ui, CLIENT_NOTICES.loggingOff, { log: (l) => lines.push(l) });
    expect(rows()).toEqual([]);
    expect(chat()).toContain('Logging off...');
    expect(lines).toEqual([]);
  });

  it('with Chat Options > Errors ticked a spew notice also lands in chat as type 0x1a', () => {
    const { ui, rows, chat } = makeUI();
    ui.optionsSettings.chatMainWindowErrors = true;
    const seen: number[] = [];
    const orig = ui.addSystemMessage.bind(ui);
    ui.addSystemMessage = (t: string, c?: string, ty?: number) => { seen.push(ty ?? -1); orig(t, c, ty); };
    raiseClientNotice(ui, CLIENT_NOTICES.castNoTarget);
    expect(rows()).toEqual([CLIENT_NOTICES.castNoTarget.text]);
    expect(chat()).toContain(CLIENT_NOTICES.castNoTarget.text);
    expect(seen).toEqual([ERROR_TEXT_TYPE]);
  });
});

/* ── Decompiled-client evidence (skipped without reference/client-eol) ── */

const DECOMP = resolve(__dirname, '..', 'reference', 'client-eol', 'decomp', 'acclient-decompiled.c');

describe.skipIf(!existsSync(DECOMP))('CORE.17.k.a — decompiled EoL client pins', () => {
  let lines: string[] = [];
  beforeAll(async () => {
    const { readFileSync } = await import('node:fs');
    lines = readFileSync(DECOMP, 'utf8').split('\n');
  });
  /** The decompiled statement around a cited line: literal a few lines up, the type argument a few lines down. */
  const win = (line: number, back = 40, fwd = 6) => lines.slice(Math.max(0, line - 1 - back), line - 1 + fwd).join('\n');

  it('DoTell / DoReply / DoReTell raise their argument errors at text type 0x1a', () => {
    for (const [line, text] of [
      [363430, 'Use comma after the name for targeted chat.'],
      [363147, 'Someone must @tell you first!'],
      [363131, 'You must specify the text you wish to say!'],
      [363301, 'You must first provide a name using @tell'],
    ] as Array<[number, string]>) {
      const w = win(line, 8);
      expect(w).toContain(text);
      expect(w).toMatch(/AddTextToScroll[\s\S]*0x1a,true/);
    }
  });

  it('DoFriends / DoFriendsAdd / DoSquelch / DoPermit / DoConsent / DoHouse / DoAllegiance likewise', () => {
    for (const [line, text] of [
      [367119, 'Invalid friends command specified.'],
      [364592, 'You must specify the name of the friend you wish to add.'],
      [364635, 'You must specify the name of the friend you wish to remove.'],
      [365356, 'You have not specified a squelch target.'],
      [363913, 'Please specify a valid permit command.'],
      [368933, 'Please specify a valid consent command.'],
      [370954, 'Please see @help House for more information on how to use this command'],
      [368645, 'Please see @help Allegiance for more information on how to use this command.'],
    ] as Array<[number, string]>) {
      const w = win(line, 8);
      expect(w).toContain(text);
      expect(w).toMatch(/AddTextToScroll[\s\S]*0x1a,/);
    }
  });

  it('state confirmations go out at type 0 (AFK, consent, Turbine chat)', () => {
    expect(win(367940, 4, 4)).toMatch(/You are now set to away-from-keyboard\.\\n",0,true,0/);
    expect(win(367945, 4, 4)).toMatch(/You are no longer set to away-from-keyboard\.\\n",0,true,0/);
    const consent = win(368840, 8, 4);
    expect(consent).toContain('You can now accept corpse looting permissions from other players.');
    expect(consent).toMatch(/AddTextToScroll[\s\S]*,0,true,/);
    const turbine = win(368724, 8, 4);
    expect(turbine).toContain('Turbine chat is not available.\\n"');
    expect(turbine).toMatch(/AddTextToScroll[\s\S]*,0,true,/);
  });

  it('the portal storm and cast-target notices are SendNotice_DisplayStringInfo(0x1a) UI call sites', () => {
    expect(win(347589)).toMatch(/The Portal Storm has subsided[\s\S]*SendNotice_DisplayStringInfo\(0x1a/);
    expect(win(347620)).toMatch(/a Portal Storm is brewing[\s\S]*SendNotice_DisplayStringInfo\(0x1a/);
    expect(win(347661)).toMatch(/A Portal Storm is imminent[\s\S]*SendNotice_DisplayStringInfo\(0x1a/);
    expect(win(350300)).toMatch(/You must select a suitable target before casting this spell[\s\S]*SendNotice_DisplayStringInfo\(0x1a/);
    expect(win(145107)).toMatch(/That person is not in the fellowship\.[\s\S]*SendNotice_DisplayStringInfo\(0x1a/);
  });

  it('DoClear only clears the buffer — no confirmation text', () => {
    const start = lines.findIndex((l) => l.startsWith('ClientCommunicationSystem::DoClear(ClientCommunicationSystem *this'));
    expect(start).toBeGreaterThan(0);
    const body = lines.slice(start, start + 40).join('\n');
    expect(body).toContain('SendNotice_ClearChatBuffer');
    expect(body).not.toContain('AddTextToScroll');
  });

  it('there is no retail chat-command handler for logout/time/who/reconnect/cancelattack/fellow', () => {
    const handlers = new Set<string>();
    const re = /ClientCommunicationSystem::(Do[A-Za-z0-9_]+)\(ClientCommunicationSystem \*this/;
    for (const l of lines) { const m = re.exec(l); if (m) handlers.add(m[1]); }
    expect(handlers.has('DoTell')).toBe(true);
    expect(handlers.has('DoClear')).toBe(true);
    for (const missing of ['DoLogout', 'DoLogoff', 'DoQuit', 'DoTime', 'DoWho', 'DoReconnect', 'DoCancelAttack', 'DoFellow', 'DoFellowship', 'DoQueryMana']) {
      expect(handlers.has(missing)).toBe(false);
    }
  });
});
