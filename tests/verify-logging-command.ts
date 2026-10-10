/**
 * GameUI's chat-line tap: every addChatMessage / addSystemMessage line goes
 * to callbacks.onChatLine. main.ts appends those lines to the open @log file
 * (retail ClientCommunicationSystem::DoSetOutput, chat/commands/
 * TextUiHelpCommands.ts; driven in verify-retail-commands-text-ui-help.ts).
 * FAITHFUL.270's invented /logging toggle (localStorage 'ac.chat.log' +
 * /logging dump|clear) is gone with the retail command port.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { GameUICallbacks } from '../packages/renderer/src/ui/GameUI.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('FAITHFUL.270 — GameUI chat-line tap (behavioural)', () => {
  let H: GameUIFixture;
  const lines: string[] = [];
  // Typed against the real interface: a renamed/retyped onChatLine fails tsc.
  const onChatLine: NonNullable<GameUICallbacks['onChatLine']> = (line: string) => { lines.push(line); };
  beforeAll(async () => {
    H = await mountGameUI({ callbacks: { onChatLine } });
    // Stand in for the HUD's main chat log (renderHUD needs DAT layouts).
    H.ui.chatMessages = H.win.document.createElement('div');
  });
  afterAll(() => H.teardown());

  it('addChatMessage emits onChatLine with "sender: text"', () => {
    lines.length = 0;
    H.ui.addChatMessage('Zeb', 'hello there');
    expect(lines).toEqual(['Zeb: hello there']);
    expect(H.ui.chatMessages.textContent).toContain('hello there');
  });

  it('addSystemMessage emits onChatLine with the text', () => {
    lines.length = 0;
    H.ui.addSystemMessage('You have entered the Portal Storm.');
    expect(lines).toEqual(['You have entered the Portal Storm.']);
  });
});
