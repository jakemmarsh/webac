/**
 * FAITHFUL.521/.522 — Strip the Olthoi suffix appended by ACE
 * `Player_Properties.cs:GetNameWithSuffix()` from incoming tell sender names.
 *
 *  ACE `GameActionTell.cs:11` appends "&" to the sender name when the
 *  source character is Olthoi (and Player_Properties.cs's suffix logic
 *  appends "^" instead for a NoOlthoiTalk Olthoi):
 *    `var name = worldObject.CreatureType == CreatureType.Olthoi
 *                ? worldObject.Name + "&"
 *                : worldObject.Name;`
 *  This marker is a server-side signal that the retail client used to
 *  drive Olthoi-speak garbling for non-Olthoi observers. We don't
 *  implement the garbling, but the bare suffix leaking into the visible
 *  name AND breaking string-keyed downstream uses (squelch lookup,
 *  /reply target resolution) is itself a defect.
 *
 *  Pre-fix three concrete bugs:
 *    1. Display: "Bob& tells you, 'hi'" — visible "&" in the name.
 *    2. Squelch: `squelchedNames.has("bob&")` always misses when the
 *       squelch list keys are plain names.
 *    3. /reply: lastTellSender = "Bob&" → server can't resolve the
 *       reply target back to a player.
 *
 *  Fix: `stripOlthoiSuffix` (packages/renderer/src/chat/OlthoiSuffix.ts)
 *  strips a trailing "&" or "^" and onTell uses the result for ALL
 *  downstream paths (squelch check, lastTellSender cache, display).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripOlthoiSuffix } from '../packages/renderer/src/chat/OlthoiSuffix.js';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
const ON_TELL = MAIN.match(/onTell: \(data: TellData\) => \{[\s\S]+?^      \},/m)?.[0] ?? '';

describe('FAITHFUL.521/.522 — stripOlthoiSuffix', () => {
  it('strips a trailing "&" (Olthoi-talk marker)', () => {
    expect(stripOlthoiSuffix('Bob&')).toBe('Bob');
  });

  it('strips a trailing "^" (NoOlthoiTalk marker)', () => {
    expect(stripOlthoiSuffix('Bob^')).toBe('Bob');
  });

  it('is a no-op on a plain name with no suffix', () => {
    expect(stripOlthoiSuffix('Bob')).toBe('Bob');
  });

  it('is a no-op on an empty string', () => {
    expect(stripOlthoiSuffix('')).toBe('');
  });

  it('only strips a single trailing marker char, not an internal one', () => {
    expect(stripOlthoiSuffix('B&ob')).toBe('B&ob');
  });

  it('does not strip other trailing punctuation', () => {
    expect(stripOlthoiSuffix('Bob!')).toBe('Bob!');
  });
});

describe('FAITHFUL.521 — onTell wires stripOlthoiSuffix into squelch/reply/display', () => {
  it('onTell body parsed (sanity check)', () => {
    expect(ON_TELL.length).toBeGreaterThan(500);
  });

  it('imports stripOlthoiSuffix from the extracted chat/OlthoiSuffix module', () => {
    expect(MAIN).toMatch(/import \{ stripOlthoiSuffix \} from '\.\/chat\/OlthoiSuffix\.js'/);
  });

  it('strips the trailing Olthoi suffix into a local `senderName` via stripOlthoiSuffix', () => {
    expect(ON_TELL).toMatch(/const senderName = stripOlthoiSuffix\(data\.senderName\)/);
  });

  it('squelch lookup uses the cleaned senderName', () => {
    // BUG.squelch-mask-per-channel-discarded — onTell now masks on the
    // Tell channel bit via blocksChannel() rather than a blanket .has().
    expect(ON_TELL).toMatch(/squelchedNames\.blocksChannel\(senderName\.toLowerCase\(\), squelchMaskForChatType\(ChatMessageType\.Tell\)\)/);
  });

  it('lastTellSender stores the cleaned senderName (not data.senderName)', () => {
    expect(ON_TELL).toMatch(/lastTellSender = senderName/);
    expect(ON_TELL).not.toMatch(/lastTellSender = data\.senderName/);
  });

  it('chat display uses the cleaned senderName', () => {
    expect(ON_TELL).toMatch(/addSystemMessage\(`\$\{senderName\} tells you, "\$\{data\.message\}"`/);
  });

  it('cites FAITHFUL.521 + ACE GameActionTell.cs', () => {
    expect(ON_TELL).toMatch(/FAITHFUL\.521[\s\S]+?GameActionTell\.cs/);
  });
});
