/**
 * The power bar's DDD mode (RELEASE.streaming-memory-and-progress): retail's
 * in-world display of runtime DAT download progress.
 *
 * gmPowerbarUI::RecvNotice_RuntimeDDDStatus @ 004da5c0 (decomp :210288),
 * fed by ECM_DDD::SendNotice_RuntimeDDDStatus from CellManager's portal-space
 * prefetch (PreFetchCells @ 00455820: (true, done, total) while
 * blocking_for_cells, (false, 0, 0) when it clears):
 *   - blocking: BeginPowerbar(PBM_DDD = 4) unless already in that mode (state
 *     0x10000045), the caption 0x10000035 = StringInfo ID_Powerbar_DDDModeText
 *     (table 0x10000001) with CURRENT = done and TOTAL = total ("???" when the
 *     total is 0), the meter 0x10000034 attribute 0x69 = done / total;
 *   - clear: FinishPowerbar(PBM_DDD): resets and hides the bar if it is
 *     still in DDD mode.
 *
 * ID_Powerbar_DDDModeText (117639460) in StringTable 0x23000001 is the
 * fragment list ["Download: ", " / ", ""] around %CURRENT% and %TOTAL%.
 */
import { acStringHash, getStringParts } from '@ac/dat-parser/file-types/LayoutDesc.js';

export const DDD_MODE_TEXT_ID = acStringHash('ID_Powerbar_DDDModeText');
/** Verbatim DAT fragments — fallback when the string tables aren't loaded. */
const FALLBACK_PARTS = ['Download: ', ' / ', ''];

/** The caption: "Download: <done> / <total>" (TOTAL "???" when total is 0). */
export function runtimeDDDStatusText(done: number, total: number): string {
  const parts = getStringParts(DDD_MODE_TEXT_ID) ?? FALLBACK_PARTS;
  const values = [String(done >>> 0), total > 0 ? String(total >>> 0) : '???'];
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
    if (i < values.length && i < parts.length - 1) out += values[i];
  }
  return out;
}

/** The meter fill (attribute 0x69): done / total, unchanged (null) when the total is 0. */
export function runtimeDDDStatusFill(done: number, total: number): number | null {
  return total > 0 ? Math.max(0, Math.min(1, done / total)) : null;
}
