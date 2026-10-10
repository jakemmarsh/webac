/**
 * The 1999 portal-storm warnings (docs/ac1999-support.md). Seen live from the
 * local AC1999 server (0x9D when a probe crowd gathered). Layouts from the
 * AC1999 server's writer (ChatMsgs.cpp PortalStormMessage, sent flat, never
 * 0xF7B0-wrapped) and the 1999 client's handlers (AC1999 kb
 * messages/server-to-client/PortalStorm: Net_DispatchServerMessage 0x4c83b0).
 * End of retail sends the same four as GameEvents (ACE GameEventPortalStorm*.cs),
 * which our ServerMessageHandler turns into the retail banners and the
 * PortalStorm script on the player.
 *
 *   0x9D Brewing   1999: u32 unused (0)   → EoL event 0x2C9 {f32 extent}. 1999 has no extent;
 *                  0.0 is written (the brewing stage's script mod; our EoL HUD shows no extent).
 *   0x9E Imminent  1999: u32 unused (0)   → EoL event 0x2CA {f32 extent}, 1.0 likewise.
 *   0x9F Storm     1999: AcString text    → EoL 0xF7E0 ServerMessage {text, Broadcast 0}: the
 *                  1999 client only prints the server's text in chat (Net_AddTextToScroll(text, 0))
 *                  and clears its panel icon; there is no banner, so EoL's 0x2CB (a fixed
 *                  banner line) would show text the 1999 player never saw.
 *   0x9C Subsided  1999: (nothing)        → EoL event 0x2CC.
 *
 * The events carry guid 0 / sequence 0: 1999 has no envelope, and our handler reads neither.
 */
import { ChatMessageType } from '@ac/shared';
import type { BinaryWriter } from '../../MessageSerializer.js';
import { eol, type Codecs1999 } from '../Adapter1999.js';

const EOL_EVENT = { Brewing: 0x2c9, Imminent: 0x2ca, Subsided: 0x2cc } as const;

/** An end-of-retail GameEvent with no envelope fields the handler reads. */
function event(type: number, build?: (w: BinaryWriter) => void): Uint8Array {
  return eol(0xf7b0, (w) => { w.writeUInt32(0); w.writeUInt32(0); w.writeUInt32(type); build?.(w); });
}

export function registerPortalStorm1999(c: Codecs1999): void {
  c.inbound.set(0x9d, (r) => { r.u32(); return [event(EOL_EVENT.Brewing, (w) => w.writeFloat32(0))]; });
  c.inbound.set(0x9e, (r) => { r.u32(); return [event(EOL_EVENT.Imminent, (w) => w.writeFloat32(1))]; });
  c.inbound.set(0x9f, (r) => {
    const text = r.acString();
    return [eol(0xf7e0, (w) => { w.writeString16(text); w.writeUInt32(ChatMessageType.Broadcast); })];
  });
  c.inbound.set(0x9c, () => [event(EOL_EVENT.Subsided)]);
}
