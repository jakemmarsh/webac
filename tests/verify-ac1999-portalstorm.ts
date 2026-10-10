/**
 * The 1999 portal-storm warnings (packages/network/src/era1999/codecs/PortalStorm1999.ts),
 * built as the AC1999 server writes them (ChatMsgs.cpp PortalStormMessage: opcode, then a
 * discarded u32 for brewing/imminent, an AcString for the storm, nothing for subsided), go
 * through the full codec set (what Connection1999 uses) into our REAL ServerMessageHandler.
 */
import { describe, expect, it } from 'vitest';
import { ChatMessageType } from '@ac/shared';
import { Adapter1999 } from '../packages/network/src/era1999/Adapter1999.js';
import { codecs1999 } from '../packages/network/src/era1999/codecs/index.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { deserializeMessage } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';

function run(messages: Uint8Array[]) {
  const logs: string[] = [];
  const a = new Adapter1999(codecs1999(), { account: 'acjs', log: (m) => logs.push(m) });
  const got: Array<[string, unknown]> = [];
  const h = new ServerMessageHandler();
  h.setHandlers({
    onPortalStormBrewing: (d) => got.push(['brewing', d]),
    onPortalStormImminent: (d) => got.push(['imminent', d]),
    onPortalStorm: () => got.push(['storm', null]),
    onPortalStormSubsided: () => got.push(['subsided', null]),
    onServerMessage: (d) => got.push(['server', d]),
  });
  for (const m of messages) for (const e of a.inbound(m, 4)) h.handleMessage(deserializeMessage(e));
  return { got, logs, a };
}

describe('1999 portal storm (0x9C–0x9F)', () => {
  it('escalates through the end-of-retail handlers in order, nothing dropped', () => {
    const text = 'The Portal Storm has teleported you away from the crowded area!';
    const { got, logs, a } = run([
      new Writer1999().u32(0x9d).u32(0).toBytes(),
      new Writer1999().u32(0x9e).u32(0).toBytes(),
      new Writer1999().u32(0x9f).acString(text).toBytes(),
      new Writer1999().u32(0x9c).toBytes(),
    ]);
    expect(got).toEqual([
      ['brewing', { extent: 0 }],
      ['imminent', { extent: 1 }],
      // 1999 prints the server's own text in chat; no fixed EoL banner.
      ['server', { message: text, chatType: ChatMessageType.Broadcast }],
      ['subsided', null],
    ]);
    expect([...a.unknownInbound.keys()]).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('a short brewing message (no unused word) fails to translate, never half-read', () => {
    const { got, logs } = run([new Writer1999().u32(0x9d).toBytes()]);
    expect(got).toEqual([]);
    expect(logs.join()).toMatch(/0x9d failed to translate/);
  });
});
