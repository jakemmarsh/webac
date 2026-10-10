/**
 * ASSESS: Keyboard Config dialog model + emote action map (VISUAL.127).
 *
 * Exercises the SHIPPED pure model that the gmKeyboardUI dialog renders from
 * (rows, tabs, DAT string ids) and the emote-command → MotionCommand mapping
 * the live router dispatches through — all 87 emotes must resolve.
 */
import { describe, it, expect } from 'vitest';
import { KeybindRegistry } from '@ac/renderer/input/KeybindRegistry.js';
import { ActionClass } from '@ac/renderer/input/KeybindActionClass.js';
import { ACT, DEFAULT_KEYBINDS } from '@ac/renderer/input/KeybindDefaults.js';
import {
  buildKeyboardRows, keyboardTabs, KEYBOARD_COLUMN_STRINGS, KEYBOARD_BUTTON_STRINGS,
} from '@ac/renderer/ui/KeyboardConfigModel.js';
import { buildEmoteMotionMap } from '@ac/renderer/input/EmoteActionMap.js';
import { MotionCommand } from '@ac/renderer/animation/MotionCommands.js';

describe('buildKeyboardRows', () => {
  it('produces a row per command with friendly Mapping labels', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    const rows = buildKeyboardRows(r, ActionClass.Movement);
    const fwd = rows.find((x) => x.id === ACT.MoveForward)!;
    expect(fwd.name).toBe('Move Forward');
    expect(fwd.mappings).toEqual(['W', 'Up', '']);
  });

  it('shows blank mappings for unbound commands (still listed)', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    const rows = buildKeyboardRows(r, ActionClass.Emotes);
    expect(rows.length).toBe(87);
    expect(rows.every((x) => x.mappings.length === 3)).toBe(true);
    // Emotes have no default keys.
    expect(rows[0].mappings).toEqual(['', '', '']);
  });
});

describe('keyboardTabs', () => {
  it('returns the six retail tabs in layout-strip order with DAT string ids', () => {
    const r = new KeybindRegistry();
    const tabs = keyboardTabs(r);
    expect(tabs.map((t) => t.cls)).toEqual([
      ActionClass.Movement, ActionClass.Camera, ActionClass.Combat,
      ActionClass.UI, ActionClass.CharacterSettings, ActionClass.Emotes,
    ]);
    expect(tabs.map((t) => t.label)).toEqual([
      'Movement', 'Camera', 'Combat', 'UI', 'CharacterSettings', 'Emotes',
    ]);
    // DAT string ids from options.md spec.
    expect(tabs[0].stringId).toBe(87231042);
    expect(tabs[5].stringId).toBe(171574434);
    expect(tabs.find((t) => t.cls === ActionClass.Emotes)!.count).toBe(87);
  });
});

describe('DAT string ids', () => {
  it('pins the column + button string ids from layout 0x21000009', () => {
    expect(KEYBOARD_COLUMN_STRINGS.command).toBe(266175644);
    expect(KEYBOARD_COLUMN_STRINGS.mapping1).toBe(219267532);
    expect(KEYBOARD_COLUMN_STRINGS.mapping2).toBe(222413260);
    expect(KEYBOARD_COLUMN_STRINGS.mapping3).toBe(221364684);
    expect(KEYBOARD_BUTTON_STRINGS.loadFile).toBe(115934318);
    expect(KEYBOARD_BUTTON_STRINGS.saveAs).toBe(76038318);
    expect(KEYBOARD_BUTTON_STRINGS.defaults).toBe(60641838);
    expect(KEYBOARD_BUTTON_STRINGS.revert).toBe(125812910);
    expect(KEYBOARD_BUTTON_STRINGS.ok).toBe(5624846);
    expect(KEYBOARD_BUTTON_STRINGS.cancel).toBe(140852158);
  });
});

describe('buildEmoteMotionMap', () => {
  it('maps every one of the 87 emote commands to a MotionCommand', () => {
    const map = buildEmoteMotionMap();
    const r = new KeybindRegistry();
    const emotes = r.actionsForClass(ActionClass.Emotes);
    expect(map.size).toBe(emotes.length);
    expect(emotes.every((a) => map.has(a.id))).toBe(true);
  });

  it('resolves the four aliased labels to the right MotionCommand', () => {
    const map = buildEmoteMotionMap();
    const r = new KeybindRegistry();
    const idOf = (name: string) => r.actionsForClass(ActionClass.Emotes).find((a) => a.name === name)!.id;
    expect(map.get(idOf('Mime Drinking'))).toBe(MotionCommand.MimeDrink);
    expect(map.get(idOf('Mime Eating'))).toBe(MotionCommand.MimeEat);
    expect(map.get(idOf('Cheer'))).toBe(MotionCommand.Cheer);
  });
});
