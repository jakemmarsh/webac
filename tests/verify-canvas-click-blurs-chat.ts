/**
 * FAITHFUL.466 — a press on the 3D canvas blurs the chat input.
 *
 *  Pre-fix, with the chat input focused (typing a tell or command), a press
 *  on a creature/NPC in the 3D world resolved the target but left the chat
 *  input focused, so WASD kept typing into it. The world press now drops
 *  chat focus — only the chat input, and only when it is the active element.
 *
 *  Behavioral (converted from a main.ts source-text pin, DECOMP.empty-click-
 *  deselects): drives the real controllers/WorldSelectPress.releaseChatFocus
 *  against a happy-dom document; main.ts's world select press calls it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadDomWindow } from './_harness/dom.js';
import { releaseChatFocus } from '../packages/renderer/src/controllers/WorldSelectPress.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let win: any;

beforeAll(async () => {
  win = await loadDomWindow();
});

function setup(): { doc: Document; chat: HTMLInputElement; other: HTMLInputElement } {
  const doc = win.document as Document;
  doc.body.innerHTML = '<input id="chat-input"><input id="other">';
  return {
    doc,
    chat: doc.getElementById('chat-input') as HTMLInputElement,
    other: doc.getElementById('other') as HTMLInputElement,
  };
}

describe('FAITHFUL.466 — a world press releases chat focus', () => {
  it('blurs the focused chat input', () => {
    const { doc, chat } = setup();
    chat.focus();
    expect(doc.activeElement).toBe(chat);
    expect(releaseChatFocus(doc)).toBe(true);
    expect(doc.activeElement).not.toBe(chat);
  });

  it('leaves another focused input alone', () => {
    const { doc, other } = setup();
    other.focus();
    expect(releaseChatFocus(doc)).toBe(false);
    expect(doc.activeElement).toBe(other);
  });

  it('is a no-op without a chat input', () => {
    const doc = win.document as Document;
    doc.body.innerHTML = '';
    expect(releaseChatFocus(doc)).toBe(false);
  });
});
