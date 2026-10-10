/**
 * FAITHFUL.578 — listChannels must ship a Channel u32, not an empty payload.
 *
 * SOURCE-PIN.faithful-576-578-outbound-gameaction-payloads: this suite
 * previously readFileSync'd main.ts and regex-matched the helper's source
 * text instead of driving the real send-path and inspecting actual bytes.
 * Fixed by extracting the payload construction into `buildListChannelsPayload()`
 * / `parseListChannelsPayload()` in packages/network/src/MessageSerializer.ts
 * (mirrors buildJumpActionPayload/buildUseWithTargetPayload/
 * buildListAvailableHousesPayload/buildQueryLordPayload); main.ts's
 * `listChannels` helper now calls the shared, exported, testable function.
 *
 * Pre-fix the `acDebug.listChannels` helper shipped a zero-byte payload
 * (`new Uint8Array(0)`), but ACE
 * `reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionChannelList.cs:11`
 * reads ONE u32 off the payload:
 *
 *     var chatChannelID = (Channel)message.Payload.ReadUInt32();
 *
 * The handler then short-circuits unless the calling session is advocate-or-higher
 * and `ChannelsAllowed.HasFlag(chatChannelID)`. With an empty payload the
 * server's `BinaryReader.ReadUInt32` throws `EndOfStreamException`. ACE catches
 * it in `InboundMessageManager.cs:135-143` and silently log.Errors — the
 * `GameEventChannelList` response is NEVER enqueued. Visible effect: the
 * `/channel list <name>` command returns nothing; the advocate-channel UI
 * receives no roster even when the caller has the required access.
 *
 * Sibling fix to FAITHFUL.576 (ListAvailableHouses HouseType u32) and
 * FAITHFUL.577 (QueryLord slumlordGuid u32). Same shape: one-field server
 * read that pre-fix client dropped silently.
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildListChannelsPayload, parseListChannelsPayload, BinaryReader } from '@ac/network';

const REPO = resolve(__dirname, '..');

const ACE_ACTION_CS = resolve(
  REPO,
  'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionChannelList.cs',
);
const ACE_INBOUND_CS = resolve(
  REPO,
  'reference/ACE/Source/ACE.Server/Network/Managers/InboundMessageManager.cs',
);
const ACE_CHANNEL_CS = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Channel.cs',
);
const HAS_ACE_SRC =
  aceReferenceExists(ACE_ACTION_CS) && aceReferenceExists(ACE_INBOUND_CS) && aceReferenceExists(ACE_CHANNEL_CS);

describe('FAITHFUL.578 — ACE source still reads Channel u32 off ListChannels payload', () => {
  it.skipIf(!HAS_ACE_SRC)('GameActionChannelList.cs reads `(Channel)message.Payload.ReadUInt32()` exactly once', () => {
    const src = readFileSync(ACE_ACTION_CS, 'utf8');
    expect(src).toMatch(/var\s+chatChannelID\s*=\s*\(Channel\)message\.Payload\.ReadUInt32\(\)/);
    const readCount = (src.match(/message\.Payload\.Read/g) ?? []).length;
    expect(readCount).toBe(1);
  });

  it.skipIf(!HAS_ACE_SRC)('handler only enqueues GameEventChannelList when ChannelsAllowed.HasFlag(chatChannelID)', () => {
    const src = readFileSync(ACE_ACTION_CS, 'utf8');
    expect(src).toMatch(/ChannelsAllowed[\s\S]+HasFlag\(chatChannelID\)/);
    expect(src).toMatch(/new GameEventChannelList\(session,\s*chatChannelID\)/);
  });

  it.skipIf(!HAS_ACE_SRC)('Channel enum declares Abuse=0x01 (our safe default)', () => {
    const src = readFileSync(ACE_CHANNEL_CS, 'utf8');
    expect(src).toMatch(/Abuse\s*=\s*0x0*1\b/);
  });

  it.skipIf(!HAS_ACE_SRC)('InboundMessageManager catches read-past-end exceptions silently', () => {
    const src = readFileSync(ACE_INBOUND_CS, 'utf8');
    expect(src).toMatch(/actionHandlerInfo\.Handler\.Invoke\(message,\s*session\)/);
    expect(src).toMatch(/catch\s*\(Exception\s+ex\)[\s\S]+log\.Error/);
  });
});

describe('buildListChannelsPayload produces byte-exact wire bytes (behavioral)', () => {
  it('is exactly 4 bytes (never the pre-fix empty payload)', () => {
    expect(buildListChannelsPayload(0x01).length).toBe(4);
  });

  it('round-trips through parseListChannelsPayload with a distinct sentinel value', () => {
    const payload = buildListChannelsPayload(0x401); // AllBroadcast
    expect(parseListChannelsPayload(payload)).toEqual({ channel: 0x401 });
  });

  it('matches GameActionChannelList.cs field order via a raw BinaryReader', () => {
    // Bypass parseListChannelsPayload entirely so this test can't share a
    // bug with it.
    const payload = buildListChannelsPayload(0x02); // Admin
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0x02);
    expect(reader.remaining).toBe(0);
  });

  it('supports the default value of 0x01 (Abuse — the lowest-tier advocate channel)', () => {
    const payload = buildListChannelsPayload(0x01);
    expect(parseListChannelsPayload(payload)).toEqual({ channel: 0x01 });
  });
});
