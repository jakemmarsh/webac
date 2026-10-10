/**
 * BUG.login-position-restore-unreachable-positiontypes — lifestone/portal
 * Tie binds are driven from the SendChatMessage confirmation text, not a
 * position packet.
 *
 * Ground truth (reference/ACE/Source/ACE.Server/): the login snapshot's
 * Position hash table (GameEventPlayerDescription.cs:202-212) is built from
 * exactly one entry (`WriteHeader(Writer, 1, 16)` around PositionType
 * .LastOutsideDeath only), and the sole `new GameMessagePrivateUpdatePosition`
 * call site across the whole server (Creature_Death.cs:559) is also
 * LastOutsideDeath-only. Binding a lifestone/portal
 * (WorldObject_Magic.cs:967-1029, the LifestoneTie1/PortalTie1/PortalTie2
 * cases) only calls `player.LinkedLifestone = ...` / `player
 * .LinkedPortalOneDID = ...` / `player.LinkedPortalTwoDID = ...` — property
 * setters that route through WorldObject_Properties.cs SetPosition, which
 * writes positionCache/Biota only (no network send) — plus a plain
 * SendChatMessage("You have successfully linked with the life
 * stone."/"...with the portal.", ChatMessageType.Magic). That chat line is
 * therefore the only client-visible signal a Tie succeeded, and — since
 * ACE reuses the identical string for PortalTie1 and PortalTie2 — the
 * client must track which Tie spell its own HearSpeech echo just confirmed
 * (SpellId 47/2644/2646, verified below against the live SpellTable DAT) to
 * know which of lifestoneSystem/recallSystem(PrimaryPortal)/
 * recallSystem(SecondaryPortal) to update.
 *
 * This drives the real packages/shared/src/systems/TieBindResolver.ts
 * module (imported by main.ts's onServerMessage/onHearSpeech handlers)
 * rather than regex-matching main.ts source text.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isTieSpell,
  isTieBindConfirmationText,
  resolveTieBindConfirmation,
  SPELLID_PORTAL_TIE1,
  SPELLID_LIFESTONE_TIE1,
  SPELLID_PORTAL_TIE2,
  LIFESTONE_TIE_CONFIRM_TEXT,
  PORTAL_TIE_CONFIRM_TEXT,
} from '../packages/shared/src/systems/TieBindResolver.js';
import { openDat } from './_harness/dat.js';

const pos = { cellId: 0x1234ffff, x: 10, y: 20, z: 30 };

describe('BUG.login-position-restore-unreachable-positiontypes — isTieSpell', () => {
  it('recognizes all three Tie spells', () => {
    expect(isTieSpell(SPELLID_LIFESTONE_TIE1)).toBe(true);
    expect(isTieSpell(SPELLID_PORTAL_TIE1)).toBe(true);
    expect(isTieSpell(SPELLID_PORTAL_TIE2)).toBe(true);
  });

  it('rejects an unrelated spellId', () => {
    expect(isTieSpell(1)).toBe(false); // StrengthOther1
  });
});

describe('BUG.login-position-restore-unreachable-positiontypes — isTieBindConfirmationText', () => {
  it('recognizes both ACE confirmation strings', () => {
    expect(isTieBindConfirmationText(LIFESTONE_TIE_CONFIRM_TEXT)).toBe(true);
    expect(isTieBindConfirmationText(PORTAL_TIE_CONFIRM_TEXT)).toBe(true);
  });

  it('rejects an unrelated chat line (e.g. a failed Tie)', () => {
    expect(isTieBindConfirmationText('You cannot link that.')).toBe(false);
  });
});

describe('BUG.login-position-restore-unreachable-positiontypes — resolveTieBindConfirmation', () => {
  it('resolves a lifestone bind when the pending cast was LifestoneTie1', () => {
    const action = resolveTieBindConfirmation(
      { spellId: SPELLID_LIFESTONE_TIE1, targetGuid: 0x5000abcd },
      LIFESTONE_TIE_CONFIRM_TEXT,
      pos,
    );
    expect(action).toEqual({ kind: 'lifestone', ...pos });
  });

  it('resolves PrimaryPortal when the pending cast was PortalTie1', () => {
    const action = resolveTieBindConfirmation(
      { spellId: SPELLID_PORTAL_TIE1, targetGuid: 0x5000abcd },
      PORTAL_TIE_CONFIRM_TEXT,
      pos,
    );
    expect(action).toEqual({ kind: 'portalOne', ...pos });
  });

  it('resolves SecondaryPortal when the pending cast was PortalTie2 — same confirmation text as PortalTie1, disambiguated by the pending spellId', () => {
    const action = resolveTieBindConfirmation(
      { spellId: SPELLID_PORTAL_TIE2, targetGuid: 0x5000abcd },
      PORTAL_TIE_CONFIRM_TEXT,
      pos,
    );
    expect(action).toEqual({ kind: 'portalTwo', ...pos });
  });

  it('fails closed (undefined) when the confirmation text and pending spellId disagree', () => {
    // Lifestone confirmation text while a portal Tie was pending should
    // never happen against a real server, but must not silently bind the
    // wrong subsystem.
    expect(resolveTieBindConfirmation(
      { spellId: SPELLID_PORTAL_TIE1, targetGuid: 1 },
      LIFESTONE_TIE_CONFIRM_TEXT,
      pos,
    )).toBeUndefined();
  });

  it('fails closed (undefined) for a non-Tie confirmation message', () => {
    expect(resolveTieBindConfirmation(
      { spellId: SPELLID_LIFESTONE_TIE1, targetGuid: 1 },
      'You cannot link that.',
      pos,
    )).toBeUndefined();
  });
});

const REPO = resolve(__dirname, '..');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const hasPortalDat = existsSync(PORTAL_DAT);

describe.skipIf(!hasPortalDat)('Tie SpellId constants match the live SpellTable DAT', () => {
  let spellTable: import('@ac/dat-parser').SpellTable;

  beforeAll(async () => {
    const { DatDatabase, DatReader, SpellTable } = await import('@ac/dat-parser');
    const portalDb = openDat(PORTAL_DAT);
    const data = portalDb.getFileData(0x0E00000E);
    spellTable = new SpellTable(new DatReader(data!));
  });

  it('SPELLID_PORTAL_TIE1 (47) is "Primary Portal Tie"', () => {
    expect(spellTable.spells.get(SPELLID_PORTAL_TIE1)?.name).toBe('Primary Portal Tie');
  });

  it('SPELLID_LIFESTONE_TIE1 (2644) is "Lifestone Tie"', () => {
    expect(spellTable.spells.get(SPELLID_LIFESTONE_TIE1)?.name).toBe('Lifestone Tie');
  });

  it('SPELLID_PORTAL_TIE2 (2646) is "Secondary Portal Tie"', () => {
    expect(spellTable.spells.get(SPELLID_PORTAL_TIE2)?.name).toBe('Secondary Portal Tie');
  });
});
