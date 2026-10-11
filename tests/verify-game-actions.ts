/**
 * DEBT.acdebug-production-coupling — the GameActions real features ship
 * (Options → SetSingleCharacterOption, spell-bar favorites, barber,
 * fellowship leader / dismiss, the ping heartbeat, spellbook Delete, Report
 * Abuse) are sent by network/GameActions.ts, not by reaching through the
 * `window.acDebug` console helper. Drives the real class and decodes the
 * payload bytes against the ACE GameAction handlers' read order; also pins
 * the acDebug install gate (dev server / `?debug` only).
 */
import { describe, it, expect } from 'vitest';
import { GameActions, type SendGameAction } from '../packages/renderer/src/network/GameActions.js';
import { PingLatencyTracker } from '../packages/renderer/src/network/PingLatencyTracker.js';
import { debugToolsEnabled } from '../packages/renderer/src/utils/debugTools.js';
import { GameActionType, parseFinishBarberPayload } from '../packages/network/src/index.js';

function u32s(payload: Uint8Array): number[] {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const out: number[] = [];
  for (let i = 0; i + 4 <= payload.byteLength; i += 4) out.push(dv.getUint32(i, true));
  return out;
}

function harness() {
  const sent: Array<{ type: GameActionType; payload: Uint8Array }> = [];
  const send: SendGameAction = (type, payload) => { sent.push({ type, payload }); return true; };
  let connected = true;
  const tracker = new PingLatencyTracker(() => 1000);
  const actions = new GameActions(() => (connected ? send : null), tracker);
  return { sent, actions, tracker, disconnect: () => { connected = false; } };
}

describe('GameActions — each production action ships its ACE-anchored opcode + payload', () => {
  it('setCharacterOption → SetSingleCharacterOption: option u32 + bool u32 (GameActionSetSingleCharacterOption.cs)', () => {
    const h = harness();
    h.actions.setCharacterOption(0x2f, true);
    h.actions.setCharacterOption(0x10, false);
    expect(h.sent.map((s) => s.type)).toEqual([GameActionType.SetSingleCharacterOption, GameActionType.SetSingleCharacterOption]);
    expect(u32s(h.sent[0].payload)).toEqual([0x2f, 1]);
    expect(u32s(h.sent[1].payload)).toEqual([0x10, 0]);
  });

  it('addSpellFavorite → spellId + position + bar; removeSpellFavorite → spellId + bar (GameActionAdd/RemoveSpellFavorite.cs)', () => {
    const h = harness();
    h.actions.addSpellFavorite(1636, 3, 2);
    h.actions.removeSpellFavorite(1636, 2);
    expect(h.sent[0].type).toBe(GameActionType.AddSpellFavorite);
    expect(u32s(h.sent[0].payload)).toEqual([1636, 3, 2]);
    expect(h.sent[1].type).toBe(GameActionType.RemoveSpellFavorite);
    expect(u32s(h.sent[1].payload)).toEqual([1636, 2]);
  });

  it('finishBarber → the 16 u32 FinishBarber fields in StartBarber order (Player_Character.HandleActionFinishBarber)', () => {
    const h = harness();
    const fields = {
      paletteBaseId: 0x0400007e, headObjectDID: 0x010004a0,
      hairTexture: 0x050000a1, defaultHairTexture: 0x050000a2,
      eyesTextureDID: 0x050000b1, defaultEyesTextureDID: 0x050000b2,
      noseTextureDID: 0x050000c1, defaultNoseTextureDID: 0x050000c2,
      mouthTextureDID: 0x050000d1, defaultMouthTextureDID: 0x050000d2,
      skinPaletteDID: 0x04000011, hairPaletteDID: 0x04000012, eyesPaletteDID: 0x04000013,
      setupTableId: 0x02000001, optionBound: 1, optionUnk: 0,
    };
    h.actions.finishBarber(fields);
    expect(h.sent[0].type).toBe(GameActionType.FinishBarber);
    expect(h.sent[0].payload.byteLength).toBe(64);
    expect(parseFinishBarberPayload(h.sent[0].payload)).toEqual(fields);
  });

  it('fellowship leader / dismiss → playerId u32 (GameActionFellowshipAssignNewLeader.cs / FellowshipDismiss.cs)', () => {
    const h = harness();
    h.actions.fellowshipAssignNewLeader(0x50001234);
    h.actions.fellowshipDismiss(0x50005678);
    expect(h.sent.map((s) => s.type)).toEqual([GameActionType.FellowshipAssignNewLeader, GameActionType.FellowshipDismiss]);
    expect(u32s(h.sent[0].payload)).toEqual([0x50001234]);
    expect(u32s(h.sent[1].payload)).toEqual([0x50005678]);
  });

  it('removeSpellC2S → spellId u32 (GameActionMagicRemoveSpellId.cs); abuseLogRequest → name, 1, complaint (Event_AbuseLogRequest @ 006a2a30)', () => {
    const h = harness();
    h.actions.removeSpellC2S(2);
    h.actions.abuseLogRequest('Bob', 'spam');
    expect(h.sent[0].type).toBe(GameActionType.RemoveSpellC2S);
    expect(u32s(h.sent[0].payload)).toEqual([2]);
    expect(h.sent[1].type).toBe(GameActionType.AbuseLogRequest);
    // PString "Bob" (u16 3 + 3 bytes, padded to 8), u32 1, PString "spam" (u16 4 + 4 bytes, padded to 8).
    expect([...h.sent[1].payload]).toEqual([
      3, 0, 0x42, 0x6f, 0x62, 0, 0, 0,
      1, 0, 0, 0,
      4, 0, 0x73, 0x70, 0x61, 0x6d, 0, 0,
    ]);
  });

  it('pingRequest stamps the latency tracker then ships an empty PingRequest (FAITHFUL.272)', () => {
    const h = harness();
    expect(h.tracker.responseReceived()).toBeNull();
    h.actions.pingRequest();
    expect(h.sent[0].type).toBe(GameActionType.PingRequest);
    expect(h.sent[0].payload.byteLength).toBe(0);
    expect(h.tracker.responseReceived()).not.toBeNull();
  });

  it('before / after the ACE session every action is a silent no-op (the old acDebug `if (!sendGameAction) return` guard)', () => {
    const h = harness();
    h.disconnect();
    h.actions.setCharacterOption(1, true);
    h.actions.addSpellFavorite(1, 0, 0);
    h.actions.removeSpellFavorite(1, 0);
    h.actions.finishBarber({
      paletteBaseId: 0, headObjectDID: 0, hairTexture: 0, defaultHairTexture: 0,
      eyesTextureDID: 0, defaultEyesTextureDID: 0, noseTextureDID: 0, defaultNoseTextureDID: 0,
      mouthTextureDID: 0, defaultMouthTextureDID: 0, skinPaletteDID: 0, hairPaletteDID: 0,
      eyesPaletteDID: 0, setupTableId: 0,
    });
    h.actions.fellowshipAssignNewLeader(1);
    h.actions.fellowshipDismiss(1);
    h.actions.pingRequest();
    h.actions.removeSpellC2S(1);
    h.actions.abuseLogRequest('a', 'b');
    expect(h.sent).toEqual([]);
    // No ping went out, so none is in flight.
    expect(h.tracker.responseReceived()).toBeNull();
  });

  it('resolves the send function per call — a session opened after construction is used', () => {
    const sent: GameActionType[] = [];
    let send: SendGameAction | null = null;
    const actions = new GameActions(() => send, new PingLatencyTracker(() => 0));
    actions.abuseLogRequest('a', 'b');
    send = (type) => { sent.push(type); return true; };
    actions.abuseLogRequest('a', 'b');
    expect(sent).toEqual([GameActionType.AbuseLogRequest]);
  });
});

describe('acDebug install gate (utils/debugTools.ts)', () => {
  it('always on in the Vite dev server (every tools/ probe drives localhost:3000)', () => {
    expect(debugToolsEnabled(true, '')).toBe(true);
    expect(debugToolsEnabled(true, '?ace&bridge=ws://localhost:9090')).toBe(true);
  });

  it('a deployed build never installs them, ?debug or not (Jake, 2026-10-11: dev only)', () => {
    expect(debugToolsEnabled(false, '')).toBe(false);
    expect(debugToolsEnabled(false, '?debug')).toBe(false);
    expect(debugToolsEnabled(false, '?ace&debug=1', false)).toBe(false);
  });

  it('a URL-overrides build (VITE_ACJS_URL_OVERRIDES=1 preview) installs them only when the URL carries `debug`', () => {
    expect(debugToolsEnabled(false, '', true)).toBe(false);
    expect(debugToolsEnabled(false, '?ace&bridge=ws://localhost:9090&account=a&password=b', true)).toBe(false);
    expect(debugToolsEnabled(false, '?debug', true)).toBe(true);
    expect(debugToolsEnabled(false, '?ace&debug', true)).toBe(true);
    expect(debugToolsEnabled(false, '?ace&debug=1', true)).toBe(true);
    // A parameter merely containing the word is not the flag.
    expect(debugToolsEnabled(false, '?nodebug=1', true)).toBe(false);
  });
});
