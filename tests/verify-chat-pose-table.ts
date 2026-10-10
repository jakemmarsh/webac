/**
 * FAITHFUL.174 — ChatPoseTable (DAT 0x0E000007) parser parity with ACE.
 *
 * Pre-FAITHFUL.174 we had a hardcoded `ChatEmoteMap` with 8 entries and the
 * chat text was a generic `You ${command}.` for every emote. ACE serves the
 * full retail emote table from `client_portal.dat` file `0x0E000007`:
 *  - A 2-level hash (`commandToState` → `stateToEmote`) so the same animation
 *    state can back multiple command aliases.
 *  - Per-state 1st- and 3rd-person text (`myEmote`, `otherEmote`). Neither
 *    carries a subject: the EoL DAT stores "wave." / "waves." and the retail
 *    client prepends "You " locally / the sender's name on receipt
 *    (CORE.17.t — tests/verify-core17t-emote-self-line.ts; the earlier
 *    `{ myEmote: 'You wave.', otherEmote: '%s waves.' }` fixture here was
 *    invented and misled FAITHFUL.509).
 *
 * This pass pins:
 *   1) The PackableHashTable wire format ACE uses (uint16 total + uint16
 *      bucket size + N×PString-pair, with each PString followed by 4-byte
 *      alignment padding).
 *   2) Case-insensitive command lookup.
 *   3) The 3rd-person emote text is returned as stored (no `%s` substitution
 *      — the DAT has none; `%p` is the client's pronoun placeholder).
 *   4) An unknown command returns null: retail Pose @ 00580480 then leaves
 *      the *span* in the spoken text (no fallback map — the invented
 *      ChatEmoteMap is gone).
 *
 * Reference: ACE.DatLoader/FileTypes/ChatPoseTable.cs
 *            ACE.DatLoader/Entity/ChatEmoteData.cs
 */
import { describe, it, expect } from 'vitest';
import { ChatPoseTable } from '@ac/dat-parser';
import { DatReader } from '@ac/dat-parser/DatReader.js';

/**
 * Helper: builds a buffer matching ACE's PString + 4-byte-align serialization
 * for ChatPoseTable. Each PString is a uint16 length followed by ASCII bytes;
 * the reader aligns to 4 after each string.
 */
function buildChatPoseDat(
  id: number,
  poseEntries: Array<[string, string]>,
  emoteEntries: Array<[string, string, string]>,
): ArrayBuffer {
  // Conservatively size the buffer — every entry contributes a length-prefixed string + up to 3 align bytes.
  const buf = new ArrayBuffer(2048);
  const view = new DataView(buf);
  let off = 0;

  const writePString = (s: string): void => {
    view.setUint16(off, s.length, true); off += 2;
    for (let i = 0; i < s.length; i++) {
      view.setUint8(off++, s.charCodeAt(i));
    }
    // Align to 4
    while (off % 4 !== 0) view.setUint8(off++, 0);
  };

  view.setUint32(off, id, true); off += 4;
  view.setUint16(off, poseEntries.length, true); off += 2;
  view.setUint16(off, 0, true); off += 2; // bucket size — unused
  for (const [cmd, state] of poseEntries) {
    writePString(cmd);
    writePString(state);
  }
  view.setUint16(off, emoteEntries.length, true); off += 2;
  view.setUint16(off, 0, true); off += 2;
  for (const [state, mine, other] of emoteEntries) {
    writePString(state);
    writePString(mine);
    writePString(other);
  }
  return buf.slice(0, off);
}

describe('ChatPoseTable — binary parser', () => {
  it('decodes a minimal table with one command + one emote state', () => {
    const buf = buildChatPoseDat(
      0x0E000007,
      [['wave', 'Waving']],
      [['Waving', 'wave.', 'waves.']],
    );
    const t = ChatPoseTable.read(new DatReader(buf));
    expect(t.id).toBe(0x0E000007);
    expect(t.commandToState.size).toBe(1);
    expect(t.stateToEmote.size).toBe(1);
    expect(t.commandToState.get('wave')).toBe('Waving');
    expect(t.stateToEmote.get('Waving')).toEqual({ myEmote: 'wave.', otherEmote: 'waves.' });
  });

  it('decodes multiple commands sharing the same state — alias path', () => {
    const buf = buildChatPoseDat(
      0x0E000007,
      [['wave', 'Waving'], ['hi', 'Waving'], ['hello', 'Waving']],
      [['Waving', 'wave at everyone.', 'waves.']],
    );
    const t = ChatPoseTable.read(new DatReader(buf));
    expect(t.commandToState.size).toBe(3);
    expect(t.commandToState.get('wave')).toBe('Waving');
    expect(t.commandToState.get('hi')).toBe('Waving');
    expect(t.commandToState.get('hello')).toBe('Waving');
    expect(t.myEmoteFor('hi')).toBe('wave at everyone.');
    expect(t.myEmoteFor('hello')).toBe('wave at everyone.');
  });

  it('handles PString align-to-4 padding for odd-length strings', () => {
    // "wave" is 4 chars, "salute" is 6 chars, "Saluting" is 8 chars — three lengths
    // that exercise zero / 2-byte / zero padding after the length prefix.
    const buf = buildChatPoseDat(
      0x0E000007,
      [['wave', 'Waving'], ['salute', 'Saluting']],
      [['Waving', 'wave.', 'waves.'], ['Saluting', 'salute.', 'salutes.']],
    );
    const t = ChatPoseTable.read(new DatReader(buf));
    expect(t.commandToState.get('wave')).toBe('Waving');
    expect(t.commandToState.get('salute')).toBe('Saluting');
    expect(t.stateToEmote.get('Saluting')?.myEmote).toBe('salute.');
  });

  it('case-insensitive command lookup', () => {
    const buf = buildChatPoseDat(
      0x0E000007,
      [['wave', 'Waving']],
      [['Waving', 'wave.', 'waves.']],
    );
    const t = ChatPoseTable.read(new DatReader(buf));
    expect(t.myEmoteFor('WAVE')).toBe('wave.');
    expect(t.myEmoteFor('Wave')).toBe('wave.');
    expect(t.myEmoteFor('wAvE')).toBe('wave.');
  });

  it('otherEmoteFor returns the 3rd-person text as stored, %p placeholder intact', () => {
    const buf = buildChatPoseDat(
      0x0E000007,
      [['wave', 'Waving'], ['akimbo', 'AkimboState']],
      [['Waving', 'wave.', 'waves.'], ['AkimboState', 'put your hands on your hips.', 'puts %p hands on %p hips.']],
    );
    const t = ChatPoseTable.read(new DatReader(buf));
    expect(t.otherEmoteFor('wave')).toBe('waves.');
    expect(t.otherEmoteFor('akimbo')).toBe('puts %p hands on %p hips.');
  });

  it('returns null for unknown commands — Pose finds no pose and the span stays in the text', () => {
    const buf = buildChatPoseDat(
      0x0E000007,
      [['wave', 'Waving']],
      [['Waving', 'wave.', 'waves.']],
    );
    const t = ChatPoseTable.read(new DatReader(buf));
    expect(t.myEmoteFor('nonexistent')).toBe(null);
    expect(t.otherEmoteFor('nonexistent')).toBe(null);
    expect(t.stateFor('nonexistent')).toBe(null);
  });

  it('exposes the full command list for /em autocomplete', () => {
    const buf = buildChatPoseDat(
      0x0E000007,
      [['wave', 'Waving'], ['bow', 'BowDeep'], ['salute', 'Saluting']],
      [
        ['Waving', 'wave.', 'waves.'],
        ['BowDeep', 'bow deeply.', 'bows deeply.'],
        ['Saluting', 'salute.', 'salutes.'],
      ],
    );
    const t = ChatPoseTable.read(new DatReader(buf));
    const cmds = t.commands().sort();
    expect(cmds).toEqual(['bow', 'salute', 'wave']);
  });
});

describe('ChatPoseTable — module surface', () => {
  it('is re-exported from @ac/dat-parser', () => {
    expect(typeof ChatPoseTable).toBe('function');
  });
});
