import type { ContractTiming } from '@ac/shared';
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
  /** BUG.contract-status-strings-not-retail — the flags FillProgressString / UpdateButtons read. */
  descriptionProgress?: string;
  questflagTimer?: string;
  questflagRepeatTime?: string;
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
  stage: number;
  /**
   * BUG.contract-status-strings-not-retail — the tracker values + table flags
   * the panel words at draw time (contractProgressText / contractTimedText,
   * every 0.5 s while open, as gmContractsUI::RefreshContractListbox does).
   */
  timing: ContractTiming;
}

/** A tracker entry as main.ts keeps it: the wire values + the client clock at receipt. */
export interface TimedContractEntry extends ContractTrackerEntry {
  /** Seconds (the panel's clock) when this entry arrived; 0 = unknown. */
  updatedAtSec?: number;
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

/**
 * The tracker table main.ts keeps (CPlayerSystem's contract list): a full
 * ContractTrackerTable replaces it; a single ContractTracker either deletes
 * its contract (the server's answer to AbandonContract — the row goes on
 * the next RebuildContractList) or upserts it with the receipt time.
 */
export function applyContractTrackerTable(state: Map<number, TimedContractEntry>, entries: Iterable<ContractTrackerEntry>, nowSec: number): void {
  state.clear();
  for (const entry of entries) state.set(entry.contractId, { ...entry, updatedAtSec: nowSec });
}

export function applyContractTracker(state: Map<number, TimedContractEntry>, contract: ContractTrackerEntry, deleteContract: boolean, nowSec: number): void {
  if (deleteContract) state.delete(contract.contractId);
  else state.set(contract.contractId, { ...contract, updatedAtSec: nowSec });
}

export function buildContractRows(
  entries: Iterable<TimedContractEntry>,
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
      // The Notes text (m_pNotesText) is the table's description; an
      // unknown contract has none (the invented stage-label fallback is gone).
      description: meta?.description ?? '',
      // CORE.15 — retail gmContractsUI detail rows (Contact / Contact
      // Location / Quest Location) from the ContractTable entry.
      contact: contact.name,
      contactLoc: contractLocText(contact.location),
      questLoc: contractLocText(meta?.locationQuestArea),
      stage: entry.stage,
      // GAP.32 — BOTH wire fields are remaining-seconds countdowns (ACE
      // ContractTracker.cs GetNextSolveTime().TotalSeconds), not epochs;
      // they count from updatedAtSec.
      timing: {
        stage: entry.stage,
        timeWhenDone: entry.timeWhenDone,
        timeWhenRepeats: entry.timeWhenRepeats,
        updatedAtSec: entry.updatedAtSec ?? 0,
        hasTimerFlag: !!meta?.questflagTimer,
        hasRepeatFlag: !!meta?.questflagRepeatTime,
        descriptionProgress: meta?.descriptionProgress ?? '',
      },
    };
  });
}
