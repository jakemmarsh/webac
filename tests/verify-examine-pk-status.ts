/**
 * GAP.64 — [PK/PvP] PK Lite + Full PK.
 *
 * PREMISE / GROUND TRUTH: retail AC has NO client-side NPK→PK toggle,
 * command, UI, or altar — becoming a PK/PKLite is server-authoritative (ACE
 * Player.cs handles the transitions; the /pk fire-and-forget opt-in and PK
 * arenas / altars are server objects). The client only RENDERS status.
 *
 * Examining a player shows their PK status. Now verifies the shipped EoL
 * builder `packages/renderer/src/ui/examine/CreatureAppraisalText.ts`:
 * CharExamineUI::SetAppraiseInfo @ 004b45f0 fills the character header's
 * third line 0x10000152 from the examined object's live PublicWeenieDesc
 * bitfield — ACCWeenieObject IsPK (bit 0x20) → "Player Killer", IsPKLite
 * (bit 0x02000000) → "Player Killer Lite", otherwise "Non-Player Killer"
 * (retail DOES label NPKs). It never reads PropertyInt 134 from the
 * appraisal, and with no weenie object it leaves the line untouched.
 * A monster gets the creature page (0x1000014d header), which has no PK
 * line at all. The @ac/shared playerKillerAssessLabel pins are kept.
 *
 * radarColor is NOT the PK path: ACE only sets a player's RadarColor for
 * Advocate/Lifestone overrides, so PK coloring is client-derived.
 */
import { describe, it, expect } from 'vitest';
import { playerKillerAssessLabel, PlayerKillerStatus } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import {
  buildCreatureExaminePage, CREATURE_EXAMINE_ELEMENTS,
  type CharacterPageModel, type CreatureExamineContext,
} from '../packages/renderer/src/ui/examine/CreatureAppraisalText.js';

describe('GAP.64 — playerKillerAssessLabel (shipped, drives the examine PK row)', () => {
  it('PK bit → "Player Killer" (red)', () => {
    expect(playerKillerAssessLabel(PlayerKillerStatus.PK)).toBe('Player Killer');
  });
  it('PKLite bit → "Player Killer Lite" (pink)', () => {
    expect(playerKillerAssessLabel(PlayerKillerStatus.PKLite)).toBe('Player Killer Lite');
  });
  it('NPK → null (no row; retail warns only on PK/PKLite)', () => {
    expect(playerKillerAssessLabel(PlayerKillerStatus.NPK)).toBeNull();
  });
  it('non-player states (Protected/Unprotected/RubberGlue/Free) → null (never mislabel a monster/NPC)', () => {
    expect(playerKillerAssessLabel(PlayerKillerStatus.Protected)).toBeNull();
    expect(playerKillerAssessLabel(PlayerKillerStatus.Unprotected)).toBeNull();
    expect(playerKillerAssessLabel(PlayerKillerStatus.RubberGlue)).toBeNull();
    expect(playerKillerAssessLabel(PlayerKillerStatus.Free)).toBeNull();
    expect(playerKillerAssessLabel(PlayerKillerStatus.Undef)).toBeNull();
  });
  it('PK bit takes priority when combined with other bits', () => {
    expect(playerKillerAssessLabel(PlayerKillerStatus.PK | PlayerKillerStatus.NPK)).toBe('Player Killer');
  });
});

const PK_PROP = 134; // PropertyInt.PlayerKillerStatus
const CHARACTER_TITLE_ID = 261; // PropertyInt.CharacterTitleId — a player → the character page
const PWD_PK = 0x20;
const PWD_PK_LITE = 0x02000000;

const player = (ints: Array<[number, number]> = []): IdentifyResponseData => ({
  guid: 0x50001111, flags: 0,
  propertiesInt: new Map([[CHARACTER_TITLE_ID, 1], [25, 50], ...ints]),
  creatureProfile: { profileFlags: 0, health: 100, healthMax: 100 },
});
const examine = (d: IdentifyResponseData, ctx: Partial<CreatureExamineContext>) => buildCreatureExaminePage(d, { success: true, ...ctx });

describe('GAP.64 — examine character page PK line 0x10000152 (CharExamineUI::SetAppraiseInfo @ 004b45f0)', () => {
  it('a player uses the character header, whose third line is the PK status', () => {
    const page = examine(player(), { publicWeenieBitfield: PWD_PK }) as CharacterPageModel;
    expect(page.page).toBe('character');
    expect(page.headerPanel).toBe(CREATURE_EXAMINE_ELEMENTS.characterHeader);
    expect(CREATURE_EXAMINE_ELEMENTS.playerKiller).toBe(0x10000152);
  });

  it('PWD IsPK → "Player Killer"; IsPKLite → "Player Killer Lite"', () => {
    expect((examine(player(), { publicWeenieBitfield: PWD_PK }) as CharacterPageModel).playerKiller).toBe('Player Killer');
    expect((examine(player(), { publicWeenieBitfield: PWD_PK_LITE }) as CharacterPageModel).playerKiller).toBe('Player Killer Lite');
    expect((examine(player(), { publicWeenieBitfield: PWD_PK | PWD_PK_LITE }) as CharacterPageModel).playerKiller).toBe('Player Killer');
  });

  it('an NPK player reads "Non-Player Killer" (retail labels every character)', () => {
    expect((examine(player(), { publicWeenieBitfield: 0 }) as CharacterPageModel).playerKiller).toBe('Non-Player Killer');
  });

  it('the live weenie bitfield decides — PropertyInt 134 in the appraisal is not read', () => {
    const page = examine(player([[PK_PROP, PlayerKillerStatus.PK]]), { publicWeenieBitfield: 0 }) as CharacterPageModel;
    expect(page.playerKiller).toBe('Non-Player Killer');
  });

  it('no weenie object known → the line is left untouched (null)', () => {
    expect((examine(player(), {}) as CharacterPageModel).playerKiller).toBeNull();
  });

  it('a monster gets the creature page — no PK line (never mislabel)', () => {
    const monster: IdentifyResponseData = {
      guid: 0x80004444, flags: 0,
      propertiesInt: new Map([[PK_PROP, PlayerKillerStatus.Unprotected], [2, 3]]),
      creatureProfile: { profileFlags: 0, health: 10, healthMax: 10 },
    };
    const page = examine(monster, { publicWeenieBitfield: PWD_PK })!;
    expect(page.page).toBe('creature');
    expect(page.headerPanel).toBe(CREATURE_EXAMINE_ELEMENTS.creatureHeader);
    expect('playerKiller' in page).toBe(false);
  });
});
