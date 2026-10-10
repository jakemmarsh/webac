/**
 * CORE.17.s — default chat text colours come from the retail EoL client, not a
 * hand-written table.
 *
 * Ground truth (reference/client-eol, decompiled EoL client acclient.exe
 * build ac1_sep13):
 *
 *   ChatInterface::BuildChatColorLookupTable @ 004f31c0 — called from the
 *   ChatInterface ctor tail @ 004f3e60 for EVERY chat window (main window id 8
 *   and the floaty windows alike). It builds the text element's colour lookup
 *   table (property 0x1b, consumed per line by UIElement_Text::
 *   AppendStringInfoWithFont @ 00469de0 → SetFontColorHelper(0x1b, type)):
 *     1. appends colorGreen 0x22 (34) times — text types 0x00..0x21 all
 *        default to GREEN;
 *     2. then overrides groups: Speech(2)=white; Emote(0xc)=grey;
 *        Tell(3)/AdminTell(0x1f)/Social(0xa)/Fellowship(0x13)=yellow;
 *        OutgoingTell(4)/SocialSend(0xb)=tan; Channel(8)/ChannelSend(9)=pink;
 *        Allegiance(0x12)/0x21=orange; 0x1b/0x1c/0x1d/0x1e/0x20/Abuse(0xe)=
 *        blueGrey; Help(0xf)/Combat(6)/CombatEnemy(0x15)=darkRed;
 *        CombatSelf(0x16)=lightRed; Magic(7)/Spellcasting(0x11)=lightBlue;
 *        Advancement(0xd)=cyan; System(5)=brightPurple; 0x1a=brightRed.
 *   The 14 colour globals are float RGBA quads in .data (0x81c4a8..0x81c578);
 *   the function references them by address in exactly the order above
 *   (0x4f321a colorGreen … 0x4f376d colorBrightRed). 0x1a = pure red is the
 *   spew-box colour (layout 0x21000011 colour 0x1b = 0xFFFF0000), which
 *   corroborates the mapping.
 *
 * Consequence: the ACE login welcome — GameMessageSystemChat(info,
 * ChatMessageType.Broadcast) at WorldManager.cs:268 — is green in the retail
 * client (docs/images/retail-client-wine-inworld-holtburg.png), as are the
 * ~800 other Broadcast-typed ACE lines. Ours drew Broadcast white and even
 * re-routed a Broadcast ServerMessage to the System colour.
 *
 * The exe-backed suite re-derives the 14 colours from acclient.exe itself and
 * skips when reference/client-eol is absent (CI).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ChatMessageType,
  chatColorFor,
  buildRetailChatColorTable,
  RETAIL_CHAT_COLORS,
  RETAIL_CHAT_TEXT_TYPE_COUNT,
} from '@ac/shared';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameMessageOpcode } from '@ac/network';

const EXE = join(process.cwd(), 'reference', 'client-eol', 'acclient.exe');
const HAS_EXE = existsSync(EXE);

describe('CORE.17.s — chatColorFor mirrors ChatInterface::BuildChatColorLookupTable @ 004f31c0', () => {
  it('seeds every text type 0x00..0x21 green before the overrides (the 0x22-iteration append loop)', () => {
    const table = buildRetailChatColorTable();
    expect(table).toHaveLength(RETAIL_CHAT_TEXT_TYPE_COUNT);
    expect(RETAIL_CHAT_TEXT_TYPE_COUNT).toBe(0x22);
    // Types the loop leaves untouched stay colorGreen.
    for (const t of [
      ChatMessageType.Broadcast, ChatMessageType.AllChannels, ChatMessageType.Appraisal,
      ChatMessageType.WorldBroadcast, ChatMessageType.Recall, ChatMessageType.Craft, ChatMessageType.Salvaging,
    ]) {
      expect(chatColorFor(t)).toBe(RETAIL_CHAT_COLORS.green);
    }
  });

  it('the ACE login welcome (Broadcast 0x00) is green, like the retail Wine frame', () => {
    expect(chatColorFor(ChatMessageType.Broadcast)).toBe('#80ff7f');
  });

  it('applies the override groups in the decompiled order', () => {
    const c = RETAIL_CHAT_COLORS;
    expect(chatColorFor(ChatMessageType.Speech)).toBe(c.white);
    expect(chatColorFor(ChatMessageType.Emote)).toBe(c.grey);
    for (const t of [ChatMessageType.Tell, ChatMessageType.AdminTell, ChatMessageType.Social, ChatMessageType.Fellowship]) {
      expect(chatColorFor(t)).toBe(c.yellow);
    }
    for (const t of [ChatMessageType.OutgoingTell, ChatMessageType.SocialSend]) expect(chatColorFor(t)).toBe(c.tan);
    for (const t of [ChatMessageType.Channel, ChatMessageType.ChannelSend]) expect(chatColorFor(t)).toBe(c.pink);
    for (const t of [ChatMessageType.Allegiance, 0x21]) expect(chatColorFor(t)).toBe(c.orange);
    for (const t of [0x1b, 0x1c, 0x1d, 0x1e, 0x20, ChatMessageType.Abuse]) expect(chatColorFor(t)).toBe(c.blueGrey);
    for (const t of [ChatMessageType.Help, ChatMessageType.Combat, ChatMessageType.CombatEnemy]) expect(chatColorFor(t)).toBe(c.darkRed);
    expect(chatColorFor(ChatMessageType.CombatSelf)).toBe(c.lightRed);
    for (const t of [ChatMessageType.Magic, ChatMessageType.Spellcasting]) expect(chatColorFor(t)).toBe(c.lightBlue);
    expect(chatColorFor(ChatMessageType.Advancement)).toBe(c.cyan);
    expect(chatColorFor(ChatMessageType.System)).toBe(c.brightPurple);
    expect(chatColorFor(0x1a)).toBe(c.brightRed);
  });

  it('the client-notice type 0x1a is the spew-box red (layout 0x21000011 colour 0xFFFF0000)', () => {
    expect(chatColorFor(0x1a)).toBe('#ff0000');
  });

  it('a type outside the 34-entry table falls back to the UIElement_Text default (white), never grey', () => {
    expect(chatColorFor(0x22)).toBe('#ffffff');
    expect(chatColorFor(0xff)).toBe('#ffffff');
    expect(chatColorFor(-1)).toBe('#ffffff');
  });

  it('every retail hex is well-formed and the 14 named colours are distinct', () => {
    const hexes = Object.values(RETAIL_CHAT_COLORS);
    expect(hexes).toHaveLength(14);
    for (const h of hexes) expect(h).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(hexes).size).toBe(14);
  });

  it('a real GameMessageSystemChat Broadcast payload dispatches type 0 → green (the welcome path)', () => {
    const message = "Welcome to Asheron's Call\n  powered by ACEmulator";
    const bytes = Array.from(message, (ch) => ch.charCodeAt(0));
    const total = 2 + bytes.length;
    const pad = (4 - (total % 4)) % 4;
    const payload = new Uint8Array(total + pad + 4);
    payload[0] = bytes.length & 0xff; payload[1] = (bytes.length >> 8) & 0xff;
    payload.set(bytes, 2);
    // int32 chatType = 0 (Broadcast) — already zero.
    const calls: Array<{ message: string; chatType: number }> = [];
    const h = new ServerMessageHandler();
    h.setHandlers({ onServerMessage: (d) => calls.push(d) });
    h.handleMessage({ type: 'direct', opcode: GameMessageOpcode.ServerMessage, payload } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0].chatType).toBe(ChatMessageType.Broadcast);
    // main.ts onServerMessage colours by the wire type directly (retail:
    // the table is indexed by the type, there is no 0 → System remap).
    expect(chatColorFor(calls[0].chatType)).toBe(RETAIL_CHAT_COLORS.green);
    expect(chatColorFor(calls[0].chatType)).not.toBe(chatColorFor(ChatMessageType.System));
  });
});

describe.skipIf(!HAS_EXE)('CORE.17.s — the 14 colour globals re-read from acclient.exe (.data float RGBA)', () => {
  // PE section table of build ac1_sep13: .text VA 0x1000 raw 0x1000, .data VA
  // 0x40a000 raw 0x40a000 (VA == raw offset for both, which the test asserts
  // from the headers rather than assumes).
  let exe: Buffer;
  let sections: Array<{ name: string; va: number; vsize: number; raw: number; rsize: number }>;
  const BASE = 0x400000;
  const v2f = (va: number): number => {
    for (const s of sections) {
      if (va >= BASE + s.va && va < BASE + s.va + Math.max(s.vsize, s.rsize)) return s.raw + (va - BASE - s.va);
    }
    throw new Error(`VA ${va.toString(16)} not in any section`);
  };
  const hexAt = (va: number): string => {
    const f = v2f(va);
    const ch = [0, 4, 8].map((o) => Math.round(exe.readFloatLE(f + o) * 255));
    return `#${ch.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  };

  beforeAll(() => {
    exe = readFileSync(EXE);
    const pe = exe.readUInt32LE(0x3c);
    const nsec = exe.readUInt16LE(pe + 6);
    const optsz = exe.readUInt16LE(pe + 20);
    const opt = pe + 24;
    expect(exe.readUInt32LE(opt + 28)).toBe(BASE);
    sections = [];
    for (let i = 0; i < nsec; i++) {
      const o = opt + optsz + i * 40;
      sections.push({
        name: exe.subarray(o, o + 8).toString('ascii').replace(/\0+$/, ''),
        vsize: exe.readUInt32LE(o + 8), va: exe.readUInt32LE(o + 12),
        rsize: exe.readUInt32LE(o + 16), raw: exe.readUInt32LE(o + 20),
      });
    }
  });

  it('BuildChatColorLookupTable references the globals in the decompiled order, and each holds the pinned colour', () => {
    const start = 0x004f31c0, end = 0x004f3840; // next symbol: ListenToGlobalMessage
    const code = exe.subarray(v2f(start), v2f(end));
    const refs: number[] = [];
    for (let i = 0; i + 4 <= code.length; i++) {
      const imm = code.readUInt32LE(i);
      if (imm >= 0x81c400 && imm < 0x81c700) refs.push(imm);
    }
    const expectedOrder: Array<keyof typeof RETAIL_CHAT_COLORS> = [
      'green', 'white', 'grey', 'yellow', 'tan', 'pink', 'orange', 'blueGrey',
      'darkRed', 'lightRed', 'lightBlue', 'cyan', 'brightPurple', 'brightRed',
    ];
    expect(refs).toHaveLength(expectedOrder.length);
    expectedOrder.forEach((name, i) => {
      expect(hexAt(refs[i])).toBe(RETAIL_CHAT_COLORS[name]);
    });
    // Alpha is 1.0 on every entry (opaque text).
    for (const va of refs) expect(exe.readFloatLE(v2f(va) + 12)).toBe(1);
  });

  it('the append loop count in the function is 0x22 (mov ecx/edi, 0x22 immediately before the loop)', () => {
    const code = exe.subarray(v2f(0x004f31c0), v2f(0x004f3840));
    // `mov reg, imm32` with imm 0x22 (0xB8+reg): B8..BF 22 00 00 00
    let found = false;
    for (let i = 0; i + 5 <= code.length; i++) {
      if (code[i] >= 0xb8 && code[i] <= 0xbf && code.readUInt32LE(i + 1) === 0x22) { found = true; break; }
    }
    expect(found).toBe(true);
  });
});
