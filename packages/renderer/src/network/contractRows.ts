import { contractStageLabel, formatContractTimer } from '@ac/shared';
import { gidToLcoord, mapCoordinateText, mapCoordsOfCell } from '../ui/MapMarkers.js';
import type { ContractTrackerEntry } from './ServerMessageHandler.js';

/**
 * FAITHFUL.284 / GAP.32 / GAP.35 / CORE.15 / CORE.15.a — builds the
 * contract-panel rows from ContractTracker wire entries + ContractTable
 * (0x0E00001D) metadata. Extracted from main.ts's publishContracts closure
 * so the behavior is testable directly (the previous coverage was a
 * source-text pin over main.ts, converted per the no-source-pin rule).
 */

/** Structural subset of the dat-parser ContractTable entry the rows need. */
export interface ContractMetaLike {
  contractName: string;
  description: string;
  nameNpcStart: string;
  nameNpcEnd?: string;
  locationNpcStart?: ContractPositionLike;
  locationNpcEnd?: ContractPositionLike;
  locationQuestArea?: ContractPositionLike;
}

export interface ContractPositionLike {
  objCellId: number;
  frame: { origin: { x: number; y: number } };
}

export interface ContractRow {
  id: number;
  name: string;
  description: string;
  contact: string;
  contactLoc: string;
  questLoc: string;
  timer: string;
  status: string;
  stage: number;
  repeatsSec: number;
}

/**
 * gmContractsUI::UpdateButtons @ 00499200: a location's text. No cell
 * (objCellId 0) leaves it blank; otherwise LandDefs::gid_to_lcoord of the
 * cell id alone (the frame is not read), "Indoors" when that fails, else
 * the map's "%.1f%s, %.1f%s" of the cell's (c − 1024) × 0.1 + 0.5.
 */
export const CONTRACT_INDOORS_TEXT = 'Indoors';
export function contractLocText(pos?: ContractPositionLike): string {
  if (!pos || !pos.objCellId) return '';
  const l = gidToLcoord(pos.objCellId >>> 0);
  return l ? mapCoordinateText(mapCoordsOfCell(l.x, l.y)) : CONTRACT_INDOORS_TEXT;
}

/**
 * gmContractsUI::UpdateButtons @ 00499200: which NPC the Contact rows name.
 * The start NPC when there's no end NPC, or while the stage is not 2 and
 * below 4 and a start NPC exists; otherwise the end NPC (who you hand the
 * contract in to).
 */
export function contractContact(meta: ContractMetaLike | undefined, stage: number): { name: string; location?: ContractPositionLike } {
  if (!meta) return { name: '' };
  const end = meta.nameNpcEnd ?? '';
  if (end === '' || (stage !== 2 && stage < 4 && meta.nameNpcStart !== '')) {
    return { name: meta.nameNpcStart, location: meta.locationNpcStart };
  }
  return { name: end, location: meta.locationNpcEnd };
}

export function buildContractRows(
  entries: Iterable<ContractTrackerEntry>,
  getMeta: (contractId: number) => ContractMetaLike | undefined,
): ContractRow[] {
  return [...entries].map(entry => {
    // FAITHFUL.206 — resolve real quest name + description from
    // ContractTable. Falls back to "Contract #N" if the table didn't load
    // or the contractId isn't a known quest.
    const meta = getMeta(entry.contractId);
    const contact = contractContact(meta, entry.stage);
    return {
      id: entry.contractId,
      name: meta?.contractName || `Contract #${entry.contractId}`,
      // FAITHFUL.284 — stage labels via the shared ContractStage enum +
      // contractStageLabel (the pre-fix inline map missed
      // ProgressCounter=0x4 and mislabeled DoneOrPendingRepeat=0x3).
      description: meta?.description || contractStageLabel(entry.stage, entry.timeWhenRepeats),
      // CORE.15 — retail gmContractsUI detail rows (Contact / Contact
      // Location / Quest Location) from the ContractTable entry.
      contact: contact.name,
      contactLoc: contractLocText(contact.location),
      questLoc: contractLocText(meta?.locationQuestArea),
      // GAP.32 — BOTH wire fields are remaining-seconds countdowns (ACE
      // ContractTracker.cs GetNextSolveTime().TotalSeconds), not epochs.
      timer: entry.timeWhenDone > 0
        ? `Done in ${formatContractTimer(entry.timeWhenDone)}`
        : entry.timeWhenRepeats > 0
          ? `Repeats in ${formatContractTimer(entry.timeWhenRepeats)}`
          : '',
      // GAP.35 — timeWhenRepeats splits DoneOrPendingRepeat into
      // 'Pending Repeat' (cooldown running) vs 'Done'.
      status: contractStageLabel(entry.stage, entry.timeWhenRepeats),
      // CORE.15.a — raw stage + remaining repeat seconds so the panel's
      // Status header sort can order repeat-cooldown contracts by
      // remaining time (retail ContractInfoSortStatus @ 004987a0).
      stage: entry.stage,
      repeatsSec: entry.timeWhenRepeats,
    };
  });
}
