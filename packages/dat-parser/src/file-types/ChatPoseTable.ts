import { DatReader } from '../DatReader.js';

/**
 * ChatPoseTable — portal.dat file 0x0E000007.
 *
 * Authoritative source for every player-typed emote command in AC. Two
 * hash tables:
 *  - `commandToState`: lowercase emote command (e.g. "wave") → state name
 *    (e.g. "Waving"). The state name doubles as the canonical MotionCommand
 *    name in the ACE EnumMapper so client code can resolve the matching
 *    motion via a name lookup.
 *  - `stateToEmote`: state name → { myEmote, otherEmote } — the exact
 *    self/other-targeted chat strings shown in retail, WITHOUT a subject:
 *      "Wave" → { myEmote: "wave.", otherEmote: "waves." }
 *    The retail client (ClientCommunicationSystem::Pose @ 00580480) prints
 *    "You" + " " + myEmote locally and ships otherEmote (with "%p" → his/her)
 *    to the server; receivers print senderName + " " + otherEmote
 *    (CORE.17.t — see @ac/shared emote-lines.ts).
 *
 * Reference: ACE.DatLoader/FileTypes/ChatPoseTable.cs
 *            ACE.DatLoader/Entity/ChatEmoteData.cs
 */
export interface ChatEmoteData {
  /** Emote text shown to the player performing the emote (1st-person, no "You " — the client prepends it). */
  myEmote: string;
  /** Emote text sent to other players (3rd-person, no name — receivers prepend it; may carry a `%p` possessive-pronoun placeholder). */
  otherEmote: string;
}

export class ChatPoseTable {
  id: number = 0;
  /** Lowercased emote command → motion state name (matches MotionCommand enum names). */
  commandToState: Map<string, string> = new Map();
  /** Motion state name → emote text pair. */
  stateToEmote: Map<string, ChatEmoteData> = new Map();

  static read(reader: DatReader): ChatPoseTable {
    const t = new ChatPoseTable();
    t.id = reader.readUInt32();

    // ACE PackableHashTable layout: totalObjects (uint16) + bucketSize (uint16, ignored)
    const totalPose = reader.readUInt16();
    reader.readUInt16(); // bucket size — unused for in-order iteration
    for (let i = 0; i < totalPose; i++) {
      const key = reader.readPString(); reader.align(4);
      const value = reader.readPString(); reader.align(4);
      t.commandToState.set(key.toLowerCase(), value);
    }

    const totalEmote = reader.readUInt16();
    reader.readUInt16(); // bucket size — unused
    for (let i = 0; i < totalEmote; i++) {
      const key = reader.readPString(); reader.align(4);
      const myEmote = reader.readPString(); reader.align(4);
      const otherEmote = reader.readPString(); reader.align(4);
      t.stateToEmote.set(key, { myEmote, otherEmote });
    }

    return t;
  }

  /**
   * Resolve a lowercased emote command (e.g. "wave") to the 1st-person emote
   * text as stored in the DAT (e.g. "wave." — the caller prepends "You ").
   * Returns null if the command isn't a known emote in the table.
   */
  myEmoteFor(command: string): string | null {
    const state = this.commandToState.get(command.toLowerCase());
    if (!state) return null;
    return this.stateToEmote.get(state)?.myEmote ?? null;
  }

  /**
   * Resolve a lowercased emote command to the 3rd-person emote text as
   * stored in the DAT (e.g. "waves." / "shakes %p fist."). The retail client
   * sends this text to the server after replacing `%p` with the actor's
   * possessive pronoun (@ac/shared substituteEmotePronoun); the receiving
   * client prepends the sender's name. The DAT carries no `%s` placeholder.
   */
  otherEmoteFor(command: string): string | null {
    const state = this.commandToState.get(command.toLowerCase());
    if (!state) return null;
    return this.stateToEmote.get(state)?.otherEmote ?? null;
  }

  /**
   * Resolve a lowercased emote command to the underlying motion-state name
   * (e.g. "Waving"). The motion-state name is the canonical MotionCommand
   * enum entry name, so client code can convert it to a MotionCommand value
   * via a name-to-enum lookup.
   */
  stateFor(command: string): string | null {
    return this.commandToState.get(command.toLowerCase()) ?? null;
  }

  /** List every known emote command (lowercase) — for /em autocomplete or help. */
  commands(): string[] {
    return [...this.commandToState.keys()];
  }
}
