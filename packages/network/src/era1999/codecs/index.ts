/**
 * Every 1999 codec, by milestone (docs/ac1999-support-scope.md Phase 4).
 * Adding a milestone = one register function here. Each opcode is registered
 * by exactly one module (tests/verify-ac1999-codecs-wiring.ts holds that).
 */
import { emptyCodecs, type Codecs1999 } from '../Adapter1999.js';
import { registerCharSelect1999 } from './CharSelect1999.js';
import { registerCombat1999 } from './Combat1999.js';
import { registerContainOrder1999 } from './ContainOrder1999.js';
import { registerInventory1999 } from './Inventory1999.js';
import { registerMisc1999 } from './Misc1999.js';
import { registerMovement1999 } from './Movement1999.js';
import { registerObjects1999 } from './Objects1999.js';
import { registerPlayer1999, type Player1999State } from './Player1999.js';
import { registerPortalStorm1999 } from './PortalStorm1999.js';

export function codecs1999(): Codecs1999 {
  const c = emptyCodecs();
  registerCharSelect1999(c);
  // A create's MOVEMENT section is 1999 MovementData, which is the end-of-retail
  // layout byte for byte (Movement1999.ts: 0xF74C passes through), so it does too.
  registerObjects1999(c, { movement: (blob) => blob });
  // The Jump falls back to the server's latest position for the player (0xF748 for our guid);
  // the player module learns that guid, so it is read lazily.
  let player: Player1999State | null = null;
  registerMovement1999(c, { playerGuid: () => player?.guid ?? 0 });
  registerPortalStorm1999(c);
  // Flat 1999 events become end-of-retail 0xF7B0 events in the player's name (lazy, as above).
  registerCombat1999(c, { player: () => player });
  registerInventory1999(c, { player: () => player });
  // Social, books, options, shortcuts, channels, queries (docs/ac1999-support.md "Client actions").
  registerMisc1999(c, { player: () => player });
  // Last: it wraps CharSelect's 0xF657 and Objects' 0xF746 codecs to learn the player's guid.
  player = registerPlayer1999(c);
  // The 1999 server's SpawnInContainer sends the 0x22 before the item's CreateObject; put it after.
  registerContainOrder1999(c);
  return c;
}
