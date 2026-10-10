/**
 * Portal storm event presentation — BUG.portalstorm-extent-ignored.
 *
 * Behavioral coverage (converted from a FAITHFUL.124-era source-grep pin on
 * main.ts, per CLAUDE.md "tests must execute the shipped code"):
 *
 * 1. The four retail chat lines, byte-for-byte from the decompiled EoL
 *    client's ClientUISystem::Handle_Misc__PortalStorm* handlers
 *    (acclient-decompiled.c lines 347572-347697). Two of the four were
 *    previously wrong ("A Portal Storm is imminent!" vs retail's
 *    "...- leave this crowded area!"; an invented "You are in the path of a
 *    Portal Storm!" vs retail's "...has teleported you away from the crowded
 *    area!") and Subsided carried a period retail doesn't print.
 *
 * 2. The PS_PortalStorm script retail plays on the local player: Brewing →
 *    PhysicsScriptTable mod 0.0, Imminent → mod 1.0
 *    (CPhysicsObj::play_script(PS_PortalStorm, 0.0/1.0) in the same
 *    handlers); Storm/Subsided play none.
 *
 * 3. The wire parse end-to-end: real GameEvent bytes through
 *    ServerMessageHandler deliver the f32 extent (ACE defaults 0.4/0.6 per
 *    GameEventPortalStormBrewing/Imminent.cs) to the Brewing/Imminent
 *    handlers, and the payload-less Storm/Subsided events fire theirs.
 *
 * Era note: the extent drives NO HUD element at end-of-retail — the only
 * gmUIElement_PortalStormIndicator element in the EoL DAT (0x100000f1,
 * layout 0x21000015) belongs to the classic statusbar family that the EoL
 * floaty HUD (root 0x21000005) does not incorporate. Full citations in
 * packages/renderer/src/network/portalStormEvents.ts.
 */
import { describe, it, expect } from 'vitest';
import { portalStormPresentation } from '../packages/renderer/src/network/portalStormEvents.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameEventType, GameMessageOpcode } from '@ac/network';
import { PlayScript } from '@ac/shared';

let seq = 900;
function event(eventType: GameEventType, payload: Uint8Array) {
  return {
    type: 'event' as const,
    opcode: GameMessageOpcode.GameEvent as GameMessageOpcode.GameEvent,
    objectGuid: 0x50000001,
    sequence: seq++,
    eventType,
    payload,
  };
}

describe('Portal storm presentation (BUG.portalstorm-extent-ignored)', () => {
  it('brewing: retail wording + PS_PortalStorm mod 0.0', () => {
    const p = portalStormPresentation('brewing');
    expect(p.text).toBe('This area is getting too crowded - a Portal Storm is brewing.');
    expect(p.playScript).toEqual({ scriptId: PlayScript.PortalStorm, mod: 0.0 });
  });

  it('imminent: retail wording + PS_PortalStorm mod 1.0', () => {
    const p = portalStormPresentation('imminent');
    expect(p.text).toBe('A Portal Storm is imminent - leave this crowded area!');
    expect(p.playScript).toEqual({ scriptId: PlayScript.PortalStorm, mod: 1.0 });
  });

  it('storm strike: retail wording, no script', () => {
    const p = portalStormPresentation('storm');
    expect(p.text).toBe('The Portal Storm has teleported you away from the crowded area!');
    expect(p.playScript).toBeNull();
  });

  it('subsided: retail wording (no trailing period), no script', () => {
    const p = portalStormPresentation('subsided');
    expect(p.text).toBe('The Portal Storm has subsided');
    expect(p.playScript).toBeNull();
  });
});

describe('Portal storm wire parse → handler payloads', () => {
  it('Brewing bytes (f32 0.4) deliver extent to onPortalStormBrewing', () => {
    const h = new ServerMessageHandler();
    let cap: { extent: number } | null = null;
    h.setHandlers({ onPortalStormBrewing: (d) => { cap = d; } });
    const w = new BinaryWriter();
    w.writeFloat32(0.4);
    h.handleMessage(event(GameEventType.MiscPortalStormBrewing, w.toBuffer()));
    expect(cap).not.toBeNull();
    expect(cap!.extent).toBeCloseTo(0.4, 6);
  });

  it('Imminent bytes (f32 0.6) deliver extent to onPortalStormImminent', () => {
    const h = new ServerMessageHandler();
    let cap: { extent: number } | null = null;
    h.setHandlers({ onPortalStormImminent: (d) => { cap = d; } });
    const w = new BinaryWriter();
    w.writeFloat32(0.6);
    h.handleMessage(event(GameEventType.MiscPortalStormImminent, w.toBuffer()));
    expect(cap).not.toBeNull();
    expect(cap!.extent).toBeCloseTo(0.6, 6);
  });

  it('payload-less Storm and Subsided events fire their handlers', () => {
    const h = new ServerMessageHandler();
    let storm = false;
    let subsided = false;
    h.setHandlers({
      onPortalStorm: () => { storm = true; },
      onPortalStormSubsided: () => { subsided = true; },
    });
    h.handleMessage(event(GameEventType.MiscPortalStorm, new Uint8Array(0)));
    h.handleMessage(event(GameEventType.MiscPortalStormSubsided, new Uint8Array(0)));
    expect(storm).toBe(true);
    expect(subsided).toBe(true);
  });
});
