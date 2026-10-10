/**
 * AttackConditions enum + label helper tests.
 *
 * Locks in:
 * 1. AttackConditions wire values match ACE C# source exactly
 *    (reference/ACE/Source/ACE.Entity/Enum/AttackConditions.cs).
 * 2. DECOMP.hit-chat-lines — the conditions fold into the single hit line
 *    exactly as the decompiled retail client builds it (CombatDialog.ts).
 *
 * FAITHFUL.120: closes the gap where attackConditions was parsed from the
 * wire (ServerMessageHandler.handleAttacker/DefenderNotification) but never
 * surfaced as the canonical chat callouts ("Reckless!", "Sneak Attack!",
 * "Overpower!", "Your Critical Protection augmentation…").
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AttackConditions } from '../packages/shared/src/combat/AttackConditions.js';
import * as shared from '../packages/shared/src/index.js';
import { formatAttackerChat, formatDefenderChat, DamageLocation } from '../packages/shared/src/combat/CombatDialog.js';
import { DamageType } from '../packages/shared/src/game-types.js';

const REPO = resolve(__dirname, '..');
const ACE_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/AttackConditions.cs');

interface AceEntry { name: string; value: number; }

function parseAce(): AceEntry[] {
  const src = readFileSync(ACE_PATH, 'utf8');
  const lines = src.split('\n');
  const out: AceEntry[] = [];
  let inside = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (/^public enum AttackConditions\b/.test(t)) { inside = true; continue; }
    if (!inside) continue;
    if (t === '}' || t.startsWith('};')) break;
    const m = t.match(/^(\w+)\s*=\s*(0x[0-9a-fA-F]+|\d+)/);
    if (m) out.push({ name: m[1], value: Number(m[2]) });
  }
  return out;
}

describe('AttackConditions enum (FAITHFUL.120)', () => {
  it.skipIf(!aceReferenceExists(ACE_PATH))('matches ACE C# source values 1:1', () => {
    const entries = parseAce();
    expect(entries.length).toBeGreaterThan(0);
    for (const { name, value } of entries) {
      expect(
        (AttackConditions as unknown as Record<string, number>)[name],
        `AttackConditions.${name} should be ${value}`,
      ).toBe(value);
    }
  });

  it('canonical bit positions per ACE', () => {
    expect(AttackConditions.None).toBe(0x0);
    expect(AttackConditions.CriticalProtectionAugmentation).toBe(0x1);
    expect(AttackConditions.Recklessness).toBe(0x2);
    expect(AttackConditions.SneakAttack).toBe(0x4);
    expect(AttackConditions.Overpower).toBe(0x8);
  });
});

describe('DECOMP.hit-chat-lines — conditions fold into the ONE hit line', () => {
  // Retail HandleAttackerNotificationEvent @ 0056b420 / HandleDefenderNotificationEvent
  // @ 0056c920 build one AddTextToScroll per event; the conditions are prefixes /
  // a suffix of it, never separate lines. Overpower (0x8) is never tested by the
  // client, so it adds nothing.
  it('the old one-line-per-condition helper is gone', () => {
    expect('attackConditionsLabels' in shared).toBe(false);
  });

  it('attacker: Sneak Attack then Recklessness prefixes, after the two-space crit prefix', () => {
    const all = AttackConditions.SneakAttack | AttackConditions.Recklessness;
    expect(formatAttackerChat('Drudge', DamageType.Slash, 0.3, 12, true, all))
      .toBe('Critical hit!  Sneak Attack! Recklessness! You slash Drudge for 12 points of slashing damage!');
  });

  it('defender: "Reckless! " (not "Recklessness! ") and a one-space crit prefix', () => {
    const all = AttackConditions.SneakAttack | AttackConditions.Recklessness;
    expect(formatDefenderChat('Drudge', DamageType.Slash, 0.3, 12, DamageLocation.Head, true, all))
      .toBe('Critical hit! Sneak Attack! Reckless! Drudge slashes your head for 12 points of slashing damage!');
  });

  it('Critical Protection is a suffix, worded per side', () => {
    const cp = AttackConditions.CriticalProtectionAugmentation;
    expect(formatAttackerChat('Drudge', DamageType.Slash, 0.3, 12, false, cp))
      .toBe("You slash Drudge for 12 points of slashing damage! Your target's Critical Protection augmentation allows them to avoid your critical hit!");
    expect(formatDefenderChat('Drudge', DamageType.Slash, 0.3, 12, DamageLocation.Head, false, cp))
      .toBe('Drudge slashes your head for 12 points of slashing damage! Your Critical Protection augmentation allows you to avoid a critical hit!');
  });

  it('Overpower and upper garbage bits add nothing', () => {
    const plain = formatAttackerChat('Drudge', DamageType.Slash, 0.3, 12, false);
    expect(formatAttackerChat('Drudge', DamageType.Slash, 0.3, 12, false, AttackConditions.Overpower)).toBe(plain);
    expect(formatAttackerChat('Drudge', DamageType.Slash, 0.3, 12, false, 0xffff0000)).toBe(plain);
  });
});
