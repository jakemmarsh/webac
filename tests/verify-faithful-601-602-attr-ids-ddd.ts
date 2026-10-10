/**
 * FAITHFUL.601 + FAITHFUL.602 (faithfulness sweep findings #14, #15).
 *
 * 601 — AttributeId aligned to ACE PropertyAttribute (Quickness=3,
 *       Coordination=4). The sweep classified the swap as LATENT, but it was
 *       NOT: GameUI's attrIdMap fed its raw value straight into
 *       GameActionRaiseAttribute's u32 (read as PropertyAttribute by ACE
 *       GameActionRaiseAttribute.cs:10) — so the Character panel's
 *       Coordination raise button raised QUICKNESS on the server and vice
 *       versa. Both the finder and the skeptic missed the raw literal map
 *       (they only audited symbolic AttributeId.* usages).
 *
 * 602 — DDD_ErrorMessage (0xF7E4) gets a dispatch case (was the single
 *       ACE-sendable opcode falling to logUnhandled). Payload per
 *       GameMessageDDDErrorMessage.cs: resourceType + dataId + errorType.
 *
 * DEBT.test-harness-hygiene: the GameUI.ts / ServerMessageHandler.ts source
 * pins are now behavioural (real syncFromPlayerState; real handleMessage fed
 * hand-built bytes).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AttributeId } from '../packages/shared/src/character/AttributeSystem.js';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameMessageOpcode } from '@ac/network';
import { mountGameUI } from './_harness/gameui.js';

describe('FAITHFUL.601: AttributeId values match ACE PropertyAttribute.cs', () => {
  it('Quickness=3 and Coordination=4 (the wire values), not the pre-fix swap', () => {
    expect(AttributeId.Strength).toBe(1);
    expect(AttributeId.Endurance).toBe(2);
    expect(AttributeId.Quickness).toBe(3);
    expect(AttributeId.Coordination).toBe(4);
    expect(AttributeId.Focus).toBe(5);
    expect(AttributeId.Self).toBe(6);
  });

  it('GameUI ATTR_WIRE_IDS (wire-bound via GameActionRaiseAttribute) has quickness:3, coordination:4', async () => {
    // CORE.7 — converted from a source-text pin to the real runtime map
    // (the raise flow feeds GameUI.ATTR_WIRE_IDS[attr] into
    // GameActionRaiseAttribute's u32; see verify-stat-raise-footer.ts for
    // the end-to-end click → callback coverage).
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((GameUI as any).ATTR_WIRE_IDS).toEqual({
      strength: 1, endurance: 2, quickness: 3, coordination: 4, focus: 5, self: 6,
    });
  });

  it('syncFromPlayerState reads each attribute row by its aligned id (quickness=3, coordination=4)', async () => {
    // Distinct innate values per attribute prove each row reads its own
    // PropertyAttribute id.
    const H = await mountGameUI();
    try {
      const state = new PlayerState();
      const rows: Array<[string, AttributeId, number]> = [
        ['strength', AttributeId.Strength, 11], ['endurance', AttributeId.Endurance, 22],
        ['quickness', AttributeId.Quickness, 33], ['coordination', AttributeId.Coordination, 44],
        ['focus', AttributeId.Focus, 55], ['self', AttributeId.Self, 66],
      ];
      for (const [, id, v] of rows) state.attributes.setInnate(id, v);
      H.ui.syncFromPlayerState(state);
      for (const [name, , v] of rows) expect(H.ui.charInfo.attributes[name].base, name).toBe(v);
    } finally {
      H.teardown();
    }
  });
});

describe('FAITHFUL.602: DDD_ErrorMessage dispatch case exists (behavioural)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reads resourceType + dataId + errorType (GameMessageDDDErrorMessage.cs) and never reaches logUnhandled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const w = new BinaryWriter(16);
    w.writeUInt32(0x06);
    w.writeUInt32(0x0600abcd);
    w.writeUInt32(7);
    const h = new ServerMessageHandler();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.handleMessage({ type: 'direct', opcode: GameMessageOpcode.DDD_ErrorMessage, payload: w.toBuffer() } as any);
    expect(warn).toHaveBeenCalledWith('[AC] DDD_ErrorMessage: resourceType=0x6 dataId=0x600abcd errorType=7');
    expect(log.mock.calls.some(c => String(c[0]).includes('Unhandled'))).toBe(false);
  });
});
