/**
 * Retail-faithful combat chat dialog (FAITHFUL.332).
 *
 * Pre-FAITHFUL.332 onAttackerNotification / onDefenderNotification rendered
 * the generic strings:
 *   "You hit X for N points of slashing damage."
 *   "X hits you for N points of slashing damage."
 *
 * Both fields ignored by the renderer:
 *   - `severity` (percent of target maxHealth) → drives verb tier selection.
 *   - `bodyPart` / DamageLocation (defender only) → "...your lower arm..." clause.
 *
 * Plus the retail "Critical hit! " prefix convention wasn't honored.
 *
 * Authoritative anchors:
 *   - ACE wire format: `GameEventAttackerNotification.cs` + `GameEventDefenderNotification.cs`
 *     (+ `Player_Combat.cs:163,423,493` for percent = damage / target.maxHealth).
 *   - Verb + body-part labels: `asheron.fandom.com/wiki/Combat_Dialog` table
 *     + `asheron.fandom.com/wiki/Combat` body-zones article ("Tumerok Gladiator
 *     grazes your lower arm for 2 points of bludgeoning damage!" example).
 *   - DamageLocation enum: ACE `Network/Enum/DamageLocation.cs` (Head=0..Foot=8).
 */
import { describe, it, expect } from 'vitest';
import {
  DamageType,
  DamageLocation, damageLocationLabel,
  combatSeverityTier, combatVerb,
  formatAttackerChat, formatDefenderChat,
} from '@ac/shared';
import { attackerHitLine, defenderHitLine } from '../packages/renderer/src/ui/ServerMessageText.js';

describe('DamageLocation labels (FAITHFUL.332)', () => {
  it('all nine ACE locations have lowercase retail wording', () => {
    expect(damageLocationLabel(DamageLocation.Head)).toBe('head');
    expect(damageLocationLabel(DamageLocation.Chest)).toBe('chest');
    expect(damageLocationLabel(DamageLocation.Abdomen)).toBe('abdomen');
    expect(damageLocationLabel(DamageLocation.UpperArm)).toBe('upper arm');
    expect(damageLocationLabel(DamageLocation.LowerArm)).toBe('lower arm');
    expect(damageLocationLabel(DamageLocation.Hand)).toBe('hand');
    expect(damageLocationLabel(DamageLocation.UpperLeg)).toBe('upper leg');
    expect(damageLocationLabel(DamageLocation.LowerLeg)).toBe('lower leg');
    expect(damageLocationLabel(DamageLocation.Foot)).toBe('foot');
  });

  it('multi-word zones use a space (retail convention, not hyphen)', () => {
    expect(damageLocationLabel(DamageLocation.UpperArm)).not.toContain('-');
    expect(damageLocationLabel(DamageLocation.LowerLeg)).not.toContain('-');
  });

  it('out-of-range value returns null so caller can degrade gracefully', () => {
    expect(damageLocationLabel(-1)).toBeNull();
    expect(damageLocationLabel(99)).toBeNull();
  });

  it('DamageLocation enum values match ACE Network/Enum/DamageLocation.cs', () => {
    expect(DamageLocation.Head).toBe(0x0);
    expect(DamageLocation.Chest).toBe(0x1);
    expect(DamageLocation.Abdomen).toBe(0x2);
    expect(DamageLocation.UpperArm).toBe(0x3);
    expect(DamageLocation.LowerArm).toBe(0x4);
    expect(DamageLocation.Hand).toBe(0x5);
    expect(DamageLocation.UpperLeg).toBe(0x6);
    expect(DamageLocation.LowerLeg).toBe(0x7);
    expect(DamageLocation.Foot).toBe(0x8);
  });
});

describe('combatSeverityTier — per the wiki Combat_Dialog thresholds', () => {
  it('tier 0 for severity > 50%', () => {
    expect(combatSeverityTier(0.51)).toBe(0);
    expect(combatSeverityTier(0.99)).toBe(0);
    expect(combatSeverityTier(1.0)).toBe(0);
    // Lethal one-shot — percent can technically exceed 1.0 if damage > maxHealth
    expect(combatSeverityTier(2.5)).toBe(0);
  });

  it('tier 1 for 25% < severity ≤ 50%', () => {
    expect(combatSeverityTier(0.50)).toBe(1);
    expect(combatSeverityTier(0.26)).toBe(1);
  });

  it('tier 2 for 10% < severity ≤ 25%', () => {
    expect(combatSeverityTier(0.25)).toBe(2);
    expect(combatSeverityTier(0.11)).toBe(2);
  });

  it('tier 3 for severity ≤ 10%', () => {
    expect(combatSeverityTier(0.10)).toBe(3);
    expect(combatSeverityTier(0.05)).toBe(3);
    expect(combatSeverityTier(0)).toBe(3);
  });
});

describe('combatVerb — full verb table from asheron.fandom.com/wiki/Combat_Dialog', () => {
  // The four severity tiers (lethal/heavy/medium/light) for each damage type.
  type Row = [number, [string, string][]];
  const ROWS: Row[] = [
    [DamageType.Slash,    [['mangle','mangles'],       ['slash','slashes'],     ['cut','cuts'],         ['scratch','scratches']]],
    [DamageType.Pierce,   [['gore','gores'],           ['impale','impales'],    ['stab','stabs'],       ['nick','nicks']]],
    [DamageType.Bludgeon, [['crush','crushes'],        ['smash','smashes'],     ['bash','bashes'],      ['graze','grazes']]],
    [DamageType.Fire,     [['incinerate','incinerates'],['burn','burns'],       ['scorch','scorches'],  ['singe','singes']]],
    [DamageType.Cold,     [['freeze','freezes'],       ['frost','frosts'],      ['chill','chills'],     ['numb','numbs']]],
    [DamageType.Acid,     [['dissolve','dissolves'],   ['corrode','corrodes'],  ['sear','sears'],       ['blister','blisters']]],
    [DamageType.Electric, [['blast','blasts'],         ['jolt','jolts'],        ['shock','shocks'],     ['spark','sparks']]],
    [DamageType.Health,   [['deplete','depletes'],     ['siphon','siphons'],    ['exhaust','exhausts'], ['drain','drains']]],
    [DamageType.Nether,   [['eradicate','eradicates'], ['wither','withers'],    ['twist','twists'],     ['scar','scars']]],
  ];

  // Pick a percent value strictly inside each tier so the test isn't
  // entangled with the boundary semantics (those are covered above).
  const SAMPLE_PERCENTS = [0.75, 0.40, 0.20, 0.05];

  it.each(ROWS)('damageType=0x%x → tier-correct verb pair', (dmgType, expected) => {
    for (let tier = 0; tier < 4; tier++) {
      const [base, third] = combatVerb(dmgType, SAMPLE_PERCENTS[tier]);
      expect(base).toBe(expected[tier][0]);
      expect(third).toBe(expected[tier][1]);
    }
  });

  it('strips the Base overlay bit (0x10000000) before lookup', () => {
    const overlaid = DamageType.Slash | DamageType.Base;
    expect(combatVerb(overlaid, 0.40)).toEqual(['slash', 'slashes']);
  });

  it('falls back to hit/hits for damage types without a verb table entry', () => {
    expect(combatVerb(DamageType.Stamina, 0.5)).toEqual(['hit', 'hits']);
    expect(combatVerb(DamageType.Mana, 0.5)).toEqual(['hit', 'hits']);
    expect(combatVerb(DamageType.Undef, 0.5)).toEqual(['hit', 'hits']);
  });
});

describe('formatAttackerChat — retail "You [verb] X for N points of Y damage!" template', () => {
  it('matches the wiki critical-hit example verbatim', () => {
    // From asheron.fandom.com/wiki/Combat (Critical Hits section):
    //   "Critical hit! You impale Olthoi Ripper for 1320 points of piercing damage!"
    // severity tier 1 → "impale" for Pierce. The retail binary's attacker
    // prefix has TWO spaces ("Critical hit!  ", DECOMP.hit-chat-lines); the
    // wiki's HTML collapsed them.
    expect(formatAttackerChat('Olthoi Ripper', DamageType.Pierce, 0.40, 1320, true))
      .toBe('Critical hit!  You impale Olthoi Ripper for 1320 points of piercing damage!');
  });

  it('omits Critical hit! prefix for non-crits', () => {
    const s = formatAttackerChat('Drudge', DamageType.Slash, 0.30, 50, false);
    expect(s).toBe('You slash Drudge for 50 points of slashing damage!');
    expect(s).not.toContain('Critical hit!');
  });

  it('uses 2nd-person base verb (You slash, not You slashes)', () => {
    expect(formatAttackerChat('Eater', DamageType.Slash, 0.40, 119, false))
      .toBe('You slash Eater for 119 points of slashing damage!');
  });

  it('uses heaviest-tier verb for severity > 50%', () => {
    expect(formatAttackerChat('Drudge', DamageType.Bludgeon, 0.80, 200, false))
      .toContain('You crush Drudge');
  });

  it('uses lightest-tier verb for severity ≤ 10%', () => {
    expect(formatAttackerChat('Drudge', DamageType.Bludgeon, 0.05, 2, false))
      .toContain('You graze Drudge');
  });

  it('damage type rendered lowercase ("piercing", not "Piercing")', () => {
    const s = formatAttackerChat('X', DamageType.Pierce, 0.4, 100, false);
    expect(s).toContain('piercing damage');
    expect(s).not.toContain('Piercing damage');
  });
});

describe('formatDefenderChat — retail "[Attacker] [verb-s] your [body part]..." template', () => {
  it('matches the wiki body-zones example verbatim', () => {
    // From asheron.fandom.com/wiki/Combat (Body Zones and Armor section):
    //   "Tumerok Gladiator grazes your lower arm for 2 points of bludgeoning damage!"
    // severity tier 3 → "grazes" (3rd-person), location 0x4 → "lower arm".
    expect(formatDefenderChat('Tumerok Gladiator', DamageType.Bludgeon, 0.05, 2, DamageLocation.LowerArm, false))
      .toBe('Tumerok Gladiator grazes your lower arm for 2 points of bludgeoning damage!');
  });

  it('omits body-part clause for unknown location, keeps "you"', () => {
    const s = formatDefenderChat('X', DamageType.Slash, 0.30, 10, 999, false);
    expect(s).toBe('X slashes you for 10 points of slashing damage!');
  });

  it('uses 3rd-person verb form (slashes, not slash)', () => {
    expect(formatDefenderChat('Drudge', DamageType.Slash, 0.30, 10, DamageLocation.Head, false))
      .toContain('Drudge slashes your head');
  });

  it('Critical hit! prefix honored on defender side too', () => {
    expect(formatDefenderChat('Olthoi', DamageType.Pierce, 0.40, 50, DamageLocation.Chest, true))
      .toBe('Critical hit! Olthoi impales your chest for 50 points of piercing damage!');
  });

  it('all DamageLocation values produce a grammatical sentence', () => {
    for (let loc = 0; loc <= 8; loc++) {
      const s = formatDefenderChat('X', DamageType.Slash, 0.30, 10, loc, false);
      expect(s).toMatch(/X slashes your [a-z ]+ for 10 points of slashing damage!$/);
    }
  });
});

describe('DECOMP.hit-chat-lines — the decompiled retail line (HandleAttacker/DefenderNotificationEvent)', () => {
  it('attacker crit prefix is "Critical hit!  " — two spaces (.rdata 0x7cf5d0)', () => {
    expect(formatAttackerChat('Olthoi Ripper', DamageType.Pierce, 0.40, 1320, true))
      .toBe('Critical hit!  You impale Olthoi Ripper for 1320 points of piercing damage!');
  });

  it('exactly 1 damage reads "1 point" on both sides', () => {
    expect(formatAttackerChat('Drudge', DamageType.Slash, 0.05, 1, false))
      .toBe('You scratch Drudge for 1 point of slashing damage!');
    expect(formatDefenderChat('Drudge', DamageType.Slash, 0.05, 1, DamageLocation.Foot, false))
      .toBe('Drudge scratches your foot for 1 point of slashing damage!');
  });

  it('the type word is AppraisalSystem::DamageTypeToString, lower-cased ("electrical", not "electric")', () => {
    expect(formatAttackerChat('Drudge', DamageType.Electric, 0.3, 20, false))
      .toBe('You jolt Drudge for 20 points of electrical damage!');
  });

  it('a mask with no named damage type reads "of damage!" (no stray word or space)', () => {
    expect(formatDefenderChat('Drudge', DamageType.Health, 0.3, 20, DamageLocation.Head, false))
      .toBe('Drudge siphons your head for 20 points of damage!');
  });

  it('the hit lines post as CombatSelf (0x16, attacker) / CombatEnemy (0x15, defender)', () => {
    expect(attackerHitLine('x').type).toBe(0x16);
    expect(defenderHitLine('x').type).toBe(0x15);
  });
});
