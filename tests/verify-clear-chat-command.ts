/**
 * @clear — CM_UI::SendNotice_ClearChatBuffer on the GameUI side.
 *
 * Retail ClientCommunicationSystem::DoClear @ 356590 clears the window the
 * command was typed in, or every window for "@clear all", and prints nothing
 * (the handler is driven in verify-retail-commands-text-ui-help.ts; main.ts
 * wires its clearChatBuffer to GameUI.clearChatWindow). FAITHFUL.426's
 * invented /cls alias and its "Chat cleared." echo are gone. This drives the
 * real GameUI methods in happy-dom.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { MAIN_CHAT_WINDOW_ID } from '../packages/renderer/src/ui/FloatyChatModel.js';

describe('GameUI.clearChatPanel / clearChatWindow (DoClear)', () => {
  let H: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let floaty: any[];
  beforeAll(async () => { H = await mountGameUI(); }, 60_000);
  afterAll(() => H?.teardown());

  /** A main log and two popup windows (ids 2 and 3), each holding two lines. */
  function fill(): { main: HTMLElement; w2: HTMLElement; w3: HTMLElement } {
    const doc = H.win.document;
    const log = () => {
      const el = doc.createElement('div');
      el.appendChild(doc.createElement('div'));
      el.appendChild(doc.createElement('div'));
      return el;
    };
    const main = log(), w2 = log(), w3 = log();
    H.ui.chatMessages = main;
    floaty = [{ def: { index: 1, windowId: 2 }, logEl: w2 }, { def: { index: 2, windowId: 3 }, logEl: w3 }];
    H.ui.floatyChatInstances.push(...floaty);
    return { main, w2, w3 };
  }
  function unfill(): void {
    for (const inst of floaty) H.ui.floatyChatInstances.splice(H.ui.floatyChatInstances.indexOf(inst), 1);
  }

  it('clearChatPanel removes every line of the main log and no-ops without one', () => {
    const { main } = fill();
    H.ui.clearChatPanel();
    expect(main.children.length).toBe(0);
    unfill();
    H.ui.chatMessages = null;
    expect(() => H.ui.clearChatPanel()).not.toThrow();
  });

  it('a popup window id clears only that window', () => {
    const { main, w2, w3 } = fill();
    H.ui.clearChatWindow(3);
    expect([main.children.length, w2.children.length, w3.children.length]).toEqual([2, 2, 0]);
    unfill();
  });

  it('the main window id clears only the main log', () => {
    const { main, w2, w3 } = fill();
    H.ui.clearChatWindow(MAIN_CHAT_WINDOW_ID);
    expect([main.children.length, w2.children.length, w3.children.length]).toEqual([0, 2, 2]);
    unfill();
  });

  it('window 0 ("@clear all") clears every window', () => {
    const { main, w2, w3 } = fill();
    H.ui.clearChatWindow(0);
    expect([main.children.length, w2.children.length, w3.children.length]).toEqual([0, 0, 0]);
    unfill();
  });
});
