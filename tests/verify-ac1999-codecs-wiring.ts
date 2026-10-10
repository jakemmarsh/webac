/**
 * The full 1999 codec set (codecs1999(), what Connection1999 uses) against
 * the real 1999 client's session: every server message translates (none
 * dropped as unknown), every client message the real client sent has a
 * codec, and no module silently overrides another's registration.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Adapter1999, emptyCodecs, type Codecs1999 } from '../packages/network/src/era1999/Adapter1999.js';
import { codecs1999 } from '../packages/network/src/era1999/codecs/index.js';
import { registerCharSelect1999 } from '../packages/network/src/era1999/codecs/CharSelect1999.js';
import { registerMovement1999 } from '../packages/network/src/era1999/codecs/Movement1999.js';
import { registerObjects1999 } from '../packages/network/src/era1999/codecs/Objects1999.js';
import { registerPortalStorm1999 } from '../packages/network/src/era1999/codecs/PortalStorm1999.js';
import { registerCombat1999 } from '../packages/network/src/era1999/codecs/Combat1999.js';
import { registerInventory1999 } from '../packages/network/src/era1999/codecs/Inventory1999.js';
import { registerMisc1999 } from '../packages/network/src/era1999/codecs/Misc1999.js';
import { deserializeMessage } from '../packages/network/src/MessageSerializer.js';
import { decodeCapture } from '../tools/ac1999/decode-capture.js';

const messages = decodeCapture(readFileSync(resolve(__dirname, 'fixtures', 'ac1999-session-001.jsonl.gz')));
const DAT_SYNC = new Set([0xf7b8, 0xf7b7]); // handled inside Connection1999, not the adapter

describe('codecs1999 over the real 1999 session', () => {
  it('translates every server message into end-of-retail messages that deserialize', () => {
    const notes: string[] = [];
    const adapter = new Adapter1999(codecs1999(), { account: 'acjsdbja', log: (m) => notes.push(m) });
    let out = 0;
    for (const m of messages) {
      if (m.dir !== 's2c' || DAT_SYNC.has(m.opcode)) continue;
      for (const e of adapter.inbound(m.data, m.group)) { expect(() => deserializeMessage(e)).not.toThrow(); out++; }
    }
    expect([...adapter.unknownInbound.keys()]).toEqual([]);
    expect(notes.filter((n) => /failed to translate/.test(n))).toEqual([]);
    expect(out).toBeGreaterThan(150);
  });

  it('has a codec for every message kind the real client sent', () => {
    const c = codecs1999();
    const kinds = new Set(messages.filter((m) => m.dir === 'c2s').map((m) => (m.opcode === 0xf7b1 ? `a${m.inner}` : `d${m.opcode}`)));
    const missing = [...kinds].filter((k) => (k[0] === 'a'
      ? !c.outboundAction.has(Number(k.slice(1))) : !c.outbound.has(Number(k.slice(1)))));
    // 0x5C (squelch upload) and 0xCA (appraisal request) have no end-of-retail action that would produce them.
    expect(missing.map((k) => Number(k.slice(1)).toString(16)).sort()).toEqual(['5c', 'ca']);
  });

  it('modules claim disjoint opcodes (the player module only wraps, by design)', () => {
    const maps = (register: (c: Codecs1999) => void): Codecs1999 => { const c = emptyCodecs(); register(c); return c; };
    const parts = [
      maps(registerCharSelect1999), maps((c) => registerObjects1999(c, {})), maps((c) => registerMovement1999(c)),
      maps(registerPortalStorm1999), maps((c) => registerCombat1999(c, {})), maps((c) => registerInventory1999(c, {})),
      maps((c) => registerMisc1999(c, {})),
    ];
    for (const key of ['inbound', 'inboundEvent', 'outbound', 'outboundAction'] as const) {
      const seen = new Map<number, number>();
      parts.forEach((p, i) => p[key].forEach((_, op) => {
        expect(seen.has(op), `${key} 0x${op.toString(16)} registered by modules ${seen.get(op)} and ${i}`).toBe(false);
        seen.set(op, i);
      }));
    }
  });
});

describe('character select with an existing character (live bytes, 2026-10-06)', () => {
  // A real 0xF658 from the local AC1999 server for an account with one character:
  // count 1, 0, then {slot 0, guid 0x50000011, "Acjsstreamtwo", timeout 0}, then the 28-byte tail.
  const LIVE_F658 = '58f60000010000000000000000000000110000500e0041636a7373747265616d74776f00000000000000000061636a737732000000000000000000000000000000000000';
  it('reads the slot-led entry: the guid and name survive into the end-of-retail list', async () => {
    const { parseCharacterList } = await import('../packages/network/src/MessageSerializer.js');
    const adapter = new Adapter1999(codecs1999(), { account: 'acjsw2', log: () => {} });
    const [out] = adapter.inbound(Uint8Array.from(Buffer.from(LIVE_F658, 'hex')), 4);
    const list = parseCharacterList(out.subarray(4));
    expect(list.characters).toEqual([{ id: 0x50000011, name: 'Acjsstreamtwo', deleteTime: 0 }]);
    expect(list.accountName).toBe('acjsw2');
  });
  it('passes CharacterError (0xF659) through with its code', () => {
    const adapter = new Adapter1999(codecs1999(), { account: 'a', log: () => {} });
    const [out] = adapter.inbound(Uint8Array.from([0x59, 0xf6, 0, 0, 13, 0, 0, 0]), 4);
    expect(Array.from(out)).toEqual([0x59, 0xf6, 0, 0, 13, 0, 0, 0]);
  });
});
