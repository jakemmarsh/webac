/**
 * Two AC1999 reports that are the server's, pinned so our side stays "display as sent".
 *
 * BUG.plural-name-arrowheadses — "5 Bundle of Arrowheadses". The weenie has PluralName
 * "Bundles of Arrowheads" (AC1999 SQL 04586), but the AC1999 server's ObjectCreate builder
 * (ObjectMsgs.cpp BuildPublicWeenieDesc1999) never sets header bit 0x1, so no plural reaches any
 * client; only the vendor list's CreateFromQualities1999 sends one. The 1999 client's
 * GetObjectName @ 0x004e04f0 then appends "es" after a trailing 's', as EoL GetObjectName
 * @ 0058e6e0 does and as our getPluralName does. When the server sends the plural, the adapter
 * carries it through (1999 AcString, odd length, 4-byte realign) and the name is right.
 *
 * "<name> has been saved." — the AC1999 server's own line (Player.cpp, every PLAYER_SAVE_INTERVAL
 * = 300 s, SendText(..., LTT_DEFAULT) → 0xF62C channel 0). Channel 0 in the 1999 client
 * (PanelUI_AddTextToScroll @ 0x004f9b70: UI+0x1c4, the green set in the UI ctor @ 0x004c4af0) is
 * green, so ours is a green chat line, nothing in the spew box.
 */
import { describe, expect, it } from 'vitest';
import { Adapter1999 } from '../packages/network/src/era1999/Adapter1999.js';
import { codecs1999 } from '../packages/network/src/era1999/codecs/index.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { BinaryReader, deserializeMessage, parseCreateObjectFromReader } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { addServerTextLine } from '../packages/renderer/src/ui/ServerMessageText.js';
import { SERVER_TEXT_SLOTS_1999 } from '../packages/renderer/src/era/EraFeatures.js';
import { getPluralName } from '../packages/shared/src/inventory/objectName.js';

const ARROWHEADS = 0x80000aa1;

/** A 1999 0xF745 for a stackable on the ground, with or without the 0x1 plural. */
function create1999(guid: number, name: string, plural: string | null): Uint8Array {
  const w = new Writer1999().u32(0xf745).u32(guid);
  w.u8(0x11).u8(1).u8(0).u8(1).u16(0x007e).u16(0x8123).u8(0).u8(0).u8(2).u16(0x9001).align4();
  w.u32(0x1 | 0x2 | 0x20000 | 0x8000).u32(0x14).u32(0x65);
  w.u32(0xa9b40019).f32(10).f32(20).f32(30).f32(1).f32(0).f32(0).f32(0);
  w.u32(0x09000001).u32(0x020000c4);
  for (let i = 0; i < 9; i++) w.u16(i + 1);
  w.align4();
  const header = (plural !== null ? 0x1 : 0) | 0x8 | 0x1000 | 0x2000;
  w.u32(header).acString(name).u16(0x11ea).u16(0x1aa5).u32(0x40000).u32(0x10);
  if (plural !== null) w.acString(plural);
  w.u32(10).u16(5).u16(25); // value, stack, max stack
  return w.align4().toBytes();
}

function parse(m: Uint8Array) {
  const msg = deserializeMessage(m);
  if (msg.type !== 'direct') throw new Error('not a direct message');
  const r = new BinaryReader(msg.payload);
  const obj = parseCreateObjectFromReader(r);
  expect(r.position).toBe(msg.payload.length);
  return obj;
}

describe('BUG.plural-name-arrowheadses: what the AC1999 server sends is what shows', () => {
  it('no 0x1 plural (the AC1999 server ObjectCreate today): the 1999 fallback, "Bundle of Arrowheadses"', () => {
    const a = new Adapter1999(codecs1999(), { account: 'acjs', log: () => {} });
    const obj = parse(a.inbound(create1999(ARROWHEADS, 'Bundle of Arrowheads', null), 3)[0]);
    expect(obj.name).toBe('Bundle of Arrowheads');
    expect(obj.pluralName ?? '').toBe('');
    expect(obj.stackSize).toBe(5);
    expect(getPluralName(obj.name, obj.pluralName)).toBe('Bundle of Arrowheadses');
  });

  it('with the 0x1 plural (odd-length AcString, realigned): "Bundles of Arrowheads", and the fields after it intact', () => {
    const a = new Adapter1999(codecs1999(), { account: 'acjs', log: () => {} });
    const obj = parse(a.inbound(create1999(ARROWHEADS, 'Bundle of Arrowheads', 'Bundles of Arrowheads'), 3)[0]);
    expect(obj.pluralName).toBe('Bundles of Arrowheads');
    expect([obj.value, obj.stackSize, obj.maxStackSize]).toEqual([10, 5, 25]);
    expect(getPluralName(obj.name, obj.pluralName)).toBe('Bundles of Arrowheads');
  });
});

describe('"<name> has been saved.": the AC1999 server\'s 0xF62C channel 0, a green chat line', () => {
  it('through the real adapter and handler, painted by the 1999 slot table', () => {
    const a = new Adapter1999(codecs1999(), { account: 'acjs', log: () => {} });
    const lines: Array<{ text: string; color?: string; type?: number; spew?: boolean }> = [];
    const ui = {
      displayErrorText: (text: string) => { lines.push({ text, spew: true }); },
      addSystemMessage: (text: string, color?: string, type?: number) => { lines.push({ text, color, type }); },
    };
    const h = new ServerMessageHandler();
    h.setHandlers({ onServerMessage: (d) => addServerTextLine(ui, SERVER_TEXT_SLOTS_1999, d.message, d.chatType) });
    const bytes = new Writer1999().u32(0xf62c).acString('Arrowhand has been saved.').u32(0).toBytes();
    for (const out of a.inbound(bytes, 4)) h.handleMessage(deserializeMessage(out));
    expect(lines).toEqual([{ text: 'Arrowhand has been saved.', color: '#80ff7f', type: 0 }]);
  });
});
