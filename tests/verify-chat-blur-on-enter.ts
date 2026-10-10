/**
 * FAITHFUL.265 — Chat input blurs after Enter/Send so movement keys re-enable.
 *
 * Pre-fix the chat-input Enter handler cleared the input but didn't blur it.
 * Focus stayed → uiManager.inputFocused stayed true → document keydown WASD
 * handler short-circuited (main.ts:8875). Player got stranded without WASD
 * until they pressed Escape or clicked elsewhere.
 *
 * Fix: call chatInput.blur() right after the input.value clear in both the
 * Enter keydown handler AND the Send button click handler.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const GAMEUI_TS = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf-8');
const MAIN_TS = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('FAITHFUL.265 — chat input blur after Enter/Send', () => {
  it('Enter keydown handler calls chatInput.blur() after clearing', () => {
    const block = GAMEUI_TS.match(/if \(e\.key === 'Enter' && chatInput\.value\.trim\(\)\) \{[\s\S]+?\} else if/)?.[0] ?? '';
    expect(block).toMatch(/chatInput\.value = '';[\s\S]+?chatInput\.blur\(\);/);
  });

  it('Enter keydown stops propagation to prevent document refocus on chat-input', () => {
    // The document keydown handler has a `case 'Enter':` branch (line 8971
    // area in main.ts) that re-focuses the chat input. Without
    // stopPropagation here the same Enter event would bubble up and
    // immediately refocus the input after our blur.
    const block = GAMEUI_TS.match(/if \(e\.key === 'Enter' && chatInput\.value\.trim\(\)\) \{[\s\S]+?\} else if/)?.[0] ?? '';
    expect(block).toContain('e.preventDefault();');
    expect(block).toContain('e.stopPropagation();');
  });

  it('Send button click handler also calls input.blur() after clearing', () => {
    // The Send button setInteractive callback.
    const block = GAMEUI_TS.match(/setInteractive\(0x10000019, \(\) => \{[\s\S]+?\}\);/)?.[0] ?? '';
    expect(block).toMatch(/input\.value = '';[\s\S]+?input\.blur\(\);/);
  });

  it('blur is gated on a successful send (only fires when there was a message)', () => {
    // The blur is inside the `if (chatInput.value.trim())` branch — empty
    // Enter presses are no-ops and don't blur.
    const enterBlock = GAMEUI_TS.match(/if \(e\.key === 'Enter' && chatInput\.value\.trim\(\)\) \{[\s\S]+?\} else if/)?.[0] ?? '';
    expect(enterBlock).toContain('chatInput.blur();');
    const sendBlock = GAMEUI_TS.match(/setInteractive\(0x10000019, \(\) => \{[\s\S]+?\}\);/)?.[0] ?? '';
    expect(sendBlock).toContain('input.blur();');
  });

  it('document keydown WASD handler still has the inputFocused early-return guard', () => {
    // Regression pin — the fix relies on this guard to know when to block.
    expect(MAIN_TS).toMatch(/if \(gameUI\.ui\.inputFocused\) return;/);
  });
});
