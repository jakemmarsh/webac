/**
 * FAITHFUL.522 — `stripOlthoiSuffix` helper applied to every chat path.
 *
 *  ACE `Player_Properties.cs:GetNameWithSuffix()` returns:
 *    `Name + "&"` for an Olthoi player who CAN talk
 *    `Name + "^"` for an Olthoi player who CANNOT talk (NoOlthoiTalk)
 *  This suffix-bearing name is what every chat broadcast uses:
 *    Player.cs:796 — HearSpeech (HandleActionTalk)
 *    Player.cs:826 — EmoteText (HandleActionEmote)
 *    Player.cs:839 — SoulEmote (HandleActionSoulEmote)
 *    EmoteManager.cs:1124 — Say/SayDirected (NPC-Olthoi monologue)
 *    GameActionTell.cs:11 — Tell (explicit Olthoi branch)
 *
 *  FAITHFUL.521 handled only the /tell case. This extension centralizes
 *  the strip into a `stripOlthoiSuffix(name)` helper, exported from
 *  packages/renderer/src/chat/OlthoiSuffix.ts and imported into main.ts,
 *  applied to onHearSpeech, onHearRangedSpeech, onEmoteText, onSoulEmote,
 *  and onTell. Each handler builds a local `senderName` from the helper
 *  and routes downstream squelch lookup + display through it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripOlthoiSuffix } from '../packages/renderer/src/chat/OlthoiSuffix.js';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
const HELPER = readFileSync(resolve(REPO, 'packages/renderer/src/chat/OlthoiSuffix.ts'), 'utf8');

describe('FAITHFUL.522 — stripOlthoiSuffix helper', () => {
  it('main.ts imports the helper from the extracted module (not a local closure)', () => {
    expect(MAIN).toMatch(/import \{ stripOlthoiSuffix \} from '\.\/chat\/OlthoiSuffix\.js'/);
  });

  it('helper handles both "&" (0x26) and "^" (0x5E) terminators', () => {
    expect(stripOlthoiSuffix('Foo&')).toBe('Foo');
    expect(stripOlthoiSuffix('Foo^')).toBe('Foo');
    expect(stripOlthoiSuffix('Foo')).toBe('Foo');
  });

  it('cites both ACE source sites', () => {
    expect(HELPER).toMatch(/Player_Properties\.cs/);
    expect(HELPER).toMatch(/EmoteManager\.cs/);
    expect(HELPER).toMatch(/GameActionTell\.cs/);
  });
});

describe('FAITHFUL.522 — every chat handler routes through stripOlthoiSuffix', () => {
  const handlers = [
    'onHearSpeech',
    'onHearRangedSpeech',
    'onEmoteText',
    'onSoulEmote',
    'onTell',
  ];

  for (const handlerName of handlers) {
    it(`${handlerName} builds a local senderName from stripOlthoiSuffix`, () => {
      const block = MAIN.match(
        new RegExp(`${handlerName}: \\([^)]+\\) => \\{[\\s\\S]+?^      \\},`, 'm'),
      )?.[0] ?? '';
      expect(block.length).toBeGreaterThan(50);
      expect(block).toMatch(/stripOlthoiSuffix\(data\.senderName\)/);
    });
  }
});
