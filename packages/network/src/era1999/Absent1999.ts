/**
 * Features the November 1999 client (4.35752) does not have: post-launch
 * additions with no builder in the 1999 binary, so a 1999 server never hears
 * their end-of-retail GameActions (docs/ac1999-support-scope.md Phase 4,
 * "Things 1999 doesn't have"). The adapter drops these messages; the
 * interface hides their controls while connected to a 1999 server (Phase 5,
 * renderer era/EraFeatures.ts), so no control does nothing.
 *
 * Evidence: the AC1999 knowledge base's builder scans over the 1999 client
 * (knowledge/kb/game-mechanics/*-absent.md, messages/client-to-server/
 * 0xF7B1-GameAction.md's complete 1999 inner-opcode catalog). Opcodes are
 * the end-of-retail GameAction types our client sends (GameActionType.ts).
 */

export type Absent1999Feature =
  | 'secureTrade' | 'housing' | 'consent' | 'chess' | 'turbineChat' | 'contracts'
  | 'characterTitles' | 'salvage' | 'fellowshipLeadership' | 'allegianceAdmin'
  | 'afk' | 'postLaunchRecalls' | 'pkLite' | 'squelchFilters' | 'confirmations' | 'pluginQueries'
  | 'barber' | 'characterRestore';

export interface Absent1999Entry {
  /** What it is and when retail added it. */
  note: string;
  /** End-of-retail GameAction types (inside 0xF7B1) that carry it. */
  actions: readonly number[];
  /** End-of-retail top-level opcodes that carry it. */
  opcodes?: readonly number[];
}

const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

export const ABSENT_1999: Readonly<Record<Absent1999Feature, Absent1999Entry>> = Object.freeze({
  // kb trade-absent.md: no builder for 0x1F6-0x204, no trade UI or trade options in the client.
  secureTrade: { note: 'secure trade (September 2000)', actions: [0x1f6, 0x1f7, 0x1f8, 0x1fa, 0x1fb, 0x204] },
  // kb house-absent.md: Dark Majesty, 2001-10-29.
  housing: {
    note: 'player housing (Dark Majesty, October 2001)',
    actions: [0x42, 0x21c, 0x21e, 0x21f, 0x221, 0x245, 0x246, 0x247, 0x249, 0x24a, 0x24c, 0x24d,
      0x258, 0x25c, 0x25e, 0x25f, 0x262, 0x266, 0x267, 0x268, 0x270, 0x278],
  },
  // kb consent-absent.md: A Reign of Stone, April 2001.
  consent: { note: 'corpse-looting /consent and /permit (April 2001)', actions: range(0x216, 0x21a) },
  // kb chess-absent.md: Festivus, October 2002.
  chess: { note: 'chess (October 2002)', actions: [0x269, 0x26a, 0x26b, 0x26d, 0x26e] },
  // The 1999 channels are the 0x145-0x149 ChannelBroadcast family (@f/@m/@p/@v);
  // the 1999 CharacterList carries useTurbineChat = 0.
  turbineChat: { note: 'TurbineChat rooms (General, Trade, LFG, Roleplay, Society, Olthoi, Allegiance)', actions: [], opcodes: [0xf7de] },
  // Not in the 1999 inner-opcode catalog (0xF7B1-GameAction.md).
  contracts: { note: 'contracts and the quest journal', actions: [0x316] },
  // 0x2C has no 1999 builder; the 1999 dispatcher has no CharacterTitle event (0x29 is the vital update).
  characterTitles: { note: 'character titles', actions: [0x2c] },
  // No 1999 builder for the Ust salvage request or the crafting confirmation.
  salvage: { note: 'salvaging and tinkering', actions: [0x27d] },
  // kb Fellowship/README.md: 1999 has create / quit (no disband field) / dismiss / recruit / update only.
  fellowshipLeadership: { note: 'fellowship leader hand-off, openness and disband', actions: [0x290, 0x291] },
  // kb post-launch-actions-absent.md. Allegiance names (0x30/0x31/0x33) and the hometown recall
  // (0x2AB, the allegiance bind point) too: the 1999 AllegianceHierarchy carries no name, bind point
  // or any of the admin block (kb structures/AllegianceHierarchy), and the 1999 builders are only
  // swear / break / update (kb client-to-server/Allegiance).
  allegianceAdmin: {
    note: 'allegiance administration (officers, bans, MOTD, boot, allegiance name, hometown recall)',
    actions: [0x30, 0x31, 0x33, ...range(0x3b, 0x41), 0x254, 0x255, 0x256, 0x277, 0x27b, 0x2a0, 0x2a1, 0x2a2,
      0x2a3, 0x2a5, 0x2a6, 0x2a7, 0x2ab],
  },
  // No 1999 builder (Client/reference/symbols.json names every CM_* builder; no AFK one), and the
  // AC1999 server's SET_AFK_MODE / SET_AFK_MESSAGE cases read nothing.
  afk: { note: '/afk mode and message', actions: [0x0f, 0x10] },
  // kb post-launch-actions-absent.md (RECALL_MARKET); the PK / PKL arenas came later still.
  postLaunchRecalls: { note: 'Marketplace and PK / PKL arena recalls', actions: [0x26, 0x27, 0x28d] },
  // kb post-launch-actions-absent.md (PKLITE).
  pkLite: { note: 'PK Lite', actions: [0x28f] },
  // 1999's squelch list is per character id, every channel (kb client-behavior/squelch-list.md,
  // builders 0x58-0x5C): no account-wide squelch, no per-channel /filter.
  squelchFilters: { note: 'account squelch and the /filter channel filters', actions: [0x59, 0x5b] },
  // The response to ConfirmationRequest 0x274, which the 1999 client has no handler for (the KB has no
  // 0x274 page; the adapter drops the server's leftover crafting / emote Yes-No requests).
  confirmations: { note: 'Yes / No confirmation dialogs', actions: [0x275] },
  // Replies to the server's plugin queries (0x2AE / 0x2B1), which the AC1999 server never sends.
  pluginQueries: { note: 'plugin list queries', actions: [0x2af, 0x2b2] },
  // The reply to StartBarber 0x75 (an admin-only command on the AC1999 server; dropped inbound).
  barber: { note: 'the barber', actions: [0x311] },
  // The AC1999 server's Client.cpp has no 0xF7D9 case: a deleted character stays "Temporarily
  // Unavailable" until it expires (an admin can @restorechar it).
  characterRestore: { note: 'restoring a deleted character', actions: [], opcodes: [0xf7d9] },
});

/** The absent feature an end-of-retail GameAction type belongs to, or null. */
export function absent1999FeatureOfAction(action: number): Absent1999Feature | null {
  for (const [f, e] of Object.entries(ABSENT_1999) as Array<[Absent1999Feature, Absent1999Entry]>) {
    if (e.actions.includes(action)) return f;
  }
  return null;
}

/** The absent feature an end-of-retail top-level opcode belongs to, or null. */
export function absent1999FeatureOfOpcode(opcode: number): Absent1999Feature | null {
  for (const [f, e] of Object.entries(ABSENT_1999) as Array<[Absent1999Feature, Absent1999Entry]>) {
    if (e.opcodes?.includes(opcode)) return f;
  }
  return null;
}
