/**
 * BUG.floating-damage-numbers-invented — retail draws no floating combat
 * text (and no world-anchored text of any kind).
 *
 * Decomp (EoL acclient, reference/client-eol/decomp): every combat
 * notification handler — ClientCombatSystem::HandleAttackerNotificationEvent
 * @ 0056b420, HandleDefenderNotificationEvent @ 0056c920,
 * HandleEvasionAttackerNotificationEvent @ 0056c7a0,
 * HandleEvasionDefenderNotificationEvent @ 0056c620 — builds its sentence and
 * hands it to ClientSystem::AddTextToScroll (the chat scroll); nothing else.
 * Speech is the same: Handle_Communication__HearSpeech @ 005712a0,
 * HearEmote @ 0057cbe0 (HearSoulEmote @ 0057d020 forwards to it) and
 * gmCCommunicationSystem::HandleRangedTalkEvent @ 00589f60 (HearRangedSpeech)
 * print to the scroll only. The client has no class that projects text into
 * the world (no bubble / billboard / floaty-text symbol in the 18k-symbol
 * PDB; the gmFloaty*UI classes are detachable panels). A hit's visual is the
 * server's Splatter PlayScript and the target's health is the selection
 * health bar.
 *
 * So the FloatingText layer (damage numbers, Evade!/Resist!/Protected!
 * callouts, +N heal / +N XP floats, speech bubbles), its spell-chat parser,
 * its XP-delta helper, its colour palette and its z-layer are all removed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as shared from '@ac/shared';
import { AC_COLORS } from '../packages/renderer/src/ui/GameUI.js';
import { ZLayer } from '../packages/renderer/src/ui/ZIndexRegistry.js';
import * as som from '../packages/renderer/src/world/ServerObjectManager.js';

const REPO = resolve(__dirname, '..');

describe('the invented floating-text layer is gone', () => {
  it('FloatingText, the spell-chat float parser and the XP-float helper no longer exist', async () => {
    const gone = [
      '../packages/renderer/src/effects/FloatingText.js',
      '../packages/renderer/src/effects/parseSpellFloatingText.js',
      '../packages/renderer/src/effects/formatXpGain.js',
    ];
    for (const m of gone) await expect(import(/* @vite-ignore */ m)).rejects.toThrow();
  });

  it('no floating-text palette entries, damage-type tint helpers or z-layer remain', () => {
    expect(Object.keys(AC_COLORS).filter((k) => k.startsWith('floating'))).toEqual([]);
    expect((ZLayer as Record<string, number>).FLOATING_TEXT).toBeUndefined();
    expect((shared as Record<string, unknown>).damageTypeColor).toBeUndefined();
    expect((shared as Record<string, unknown>).damageTypeColorNum).toBeUndefined();
    // Only the floats needed the name-only notification → object lookup.
    expect((som as Record<string, unknown>).resolveNotificationTarget).toBeUndefined();
  });

  it('combat results still reach chat in retail wording', () => {
    // The chat line is the retail output (HandleAttackerNotificationEvent →
    // AddTextToScroll); it stays.
    const line = shared.formatAttackerChat('Drudge Skulker', shared.DamageType.Slash, 0.1, 7, false);
    expect(line).toMatch(/Drudge Skulker/);
    expect(line).toMatch(/7 points of slashing damage/);
  });
});

const DECOMP = resolve(REPO, 'reference/client-eol/decomp/acclient-decompiled.annotated.c');

function functionBody(src: string, name: string): string {
  const header = `// ===== ${name} @ `;
  const i = src.indexOf(header);
  if (i < 0) throw new Error(`missing ${name}`);
  const j = src.indexOf('\n// ===== ', i + header.length);
  return src.slice(i, j < 0 ? undefined : j);
}

describe.skipIf(!existsSync(DECOMP))('retail ground truth: combat + speech handlers only print to the chat scroll', () => {
  let src = '';
  beforeAll(() => { src = readFileSync(DECOMP, 'utf8'); });

  const OUTPUT_CALLS = /[A-Za-z_]\w*(?:UI|System|Manager|Maint|Obj|Renderer)::\w+/g;
  const ALLOWED = new Set([
    'ClientSystem::AddTextToScroll',
    'gmCCommunicationSystem::IsSquelched', 'gmCCommunicationSystem::CanHear',
    'gmCCommunicationSystem::HandleRangedTalkEvent', 'gmCCommunicationSystem::SetLastTeller',
    'gmCCommunicationSystem::SetLastTellerName',
    'CombatSystem::InqCombatHitAdjectives', 'AppraisalSystem::DamageTypeToString',
    'CPlayerSystem::GetPlayerSystem', 'CPlayerSystem::IsOlthoi', 'InterfaceSystem::GetInstance',
    'InterfaceSystem::GetClass', 'ClientUISystem::GetUISystem',
    // the evade/defender handlers' own combat-state follow-ups
    'ClientCombatSystem::ToggleCombatMode', 'ClientCombatSystem::SetRequestedAttackHeight',
    'ClientCombatSystem::HandleAttackerNotificationEvent', 'ClientCombatSystem::HandleDefenderNotificationEvent',
    'ClientCombatSystem::HandleEvasionAttackerNotificationEvent', 'ClientCombatSystem::HandleEvasionDefenderNotificationEvent',
    'ClientCommunicationSystem::Handle_Communication__HearSpeech',
    'ClientCommunicationSystem::Handle_Communication__HearEmote',
  ]);

  for (const fn of [
    'ClientCombatSystem::HandleAttackerNotificationEvent',
    'ClientCombatSystem::HandleDefenderNotificationEvent',
    'ClientCombatSystem::HandleEvasionAttackerNotificationEvent',
    'ClientCombatSystem::HandleEvasionDefenderNotificationEvent',
    'ClientCommunicationSystem::Handle_Communication__HearSpeech',
    'ClientCommunicationSystem::Handle_Communication__HearEmote',
    'gmCCommunicationSystem::HandleRangedTalkEvent',
  ]) {
    it(`${fn} → AddTextToScroll, and no other UI/render output`, () => {
      const body = functionBody(src, fn);
      expect(body).toContain('ClientSystem::AddTextToScroll');
      const others = [...new Set(body.match(OUTPUT_CALLS) ?? [])].filter((c) => !ALLOWED.has(c));
      expect(others).toEqual([]);
    });
  }
});
