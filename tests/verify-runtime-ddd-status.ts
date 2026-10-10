/**
 * RELEASE.streaming-memory-and-progress — the power bar's DDD mode text and
 * fill (gmPowerbarUI::RecvNotice_RuntimeDDDStatus @ 004da5c0): StringTable
 * entry ID_Powerbar_DDDModeText = ["Download: ", " / ", ""] around CURRENT
 * and TOTAL ("???" when the total is 0). The DAT-backed GameUI wiring is
 * covered in verify-dat-streaming-charselect.ts.
 */
import { describe, expect, it } from 'vitest';
import { acStringHash } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { DDD_MODE_TEXT_ID, runtimeDDDStatusFill, runtimeDDDStatusText } from '../packages/renderer/src/ui/RuntimeDDDStatusText.js';

describe('RuntimeDDDStatus power-bar text', () => {
  it('addresses ID_Powerbar_DDDModeText by the retail string hash (117639460 in StringTable 0x23000001)', () => {
    expect(DDD_MODE_TEXT_ID).toBe(acStringHash('ID_Powerbar_DDDModeText'));
    expect(DDD_MODE_TEXT_ID).toBe(117639460);
  });

  it('fills CURRENT / TOTAL into the fragments, "???" for an unknown total', () => {
    expect(runtimeDDDStatusText(3, 9)).toBe('Download: 3 / 9');
    expect(runtimeDDDStatusText(0, 0)).toBe('Download: 0 / ???');
  });

  it('the meter is done / total, clamped; unchanged when the total is unknown', () => {
    expect(runtimeDDDStatusFill(3, 9)).toBeCloseTo(1 / 3);
    expect(runtimeDDDStatusFill(12, 9)).toBe(1);
    expect(runtimeDDDStatusFill(0, 0)).toBeNull();
  });
});
