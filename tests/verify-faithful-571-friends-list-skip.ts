/**
 * FAITHFUL.571 — parseFriendsListUpdate must skip the friend-of-friend AND
 * inverse-friend list bytes that ACE writes between each friend record.
 *
 * ACE `GameEventFriendsListUpdate.cs:80-91` writes per friend:
 *   FriendId u32
 *   isOnline u32
 *   appearOffline u32
 *   friendName String16L
 *   friendFriendCount u32 + N × FriendId u32   ← always 0 in live ACE (TODO)
 *   inverseFriendCount u32 + N × FriendId u32  ← always 0 in live ACE (TODO)
 * Then after all friends:
 *   updateType u32
 *
 * Live ACE writes count=0 for both lists (the `Writer.Write((uint)0/* TODO …`
 * lines have been there since the original port), so currently no list bytes
 * follow. Pre-FAITHFUL.571 our parser read the two counts as uint32s and
 * threw them away — fine when both are 0, but if a future ACE patch ever
 * enables the actual friend-of-friend send, every subsequent friend record
 * would silently misalign (their FriendId u32 would land in the previous
 * record's friend-of-friend list, then the parser would walk off the end of
 * the payload).
 *
 * Same defensive pattern as FAITHFUL.560 (fellowship post-name alignment
 * skip) — fix the latent wire-format bug before it bites.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { aceReferenceExists } from './_harness/reference.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFriendsListUpdate } from '../packages/network/src/MessageSerializer';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const ACE_FRIENDS_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventFriendsListUpdate.cs');

/** Build a String16L: u16 length + bytes + pad to 4-byte boundary. */
function pushString16L(out: number[], s: string): void {
  const bytes = new TextEncoder().encode(s);
  out.push(bytes.length & 0xFF, (bytes.length >> 8) & 0xFF);
  for (const b of bytes) out.push(b);
  // pad (2 + len) to multiple of 4
  const total = 2 + bytes.length;
  const rem = total % 4;
  if (rem !== 0) for (let i = 0; i < 4 - rem; i++) out.push(0);
}

function pushU32LE(out: number[], v: number): void {
  v = v >>> 0;
  out.push(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF);
}

// DEBT.test-harness-hygiene: the former MessageSerializer.ts regex pins
// ("reads both counts and skips count × 4 bytes") are proven by the roundtrip
// below — a payload with 3 friend-of-friend + 2 inverse-friend ids only
// parses Friend 2 + the trailer correctly if both lists are skipped exactly.
describe('FAITHFUL.571 — synthetic payload roundtrip', () => {
  it('parser correctly reads a payload with 2 friends + non-zero friend-of-friend lists', () => {
    const out: number[] = [];
    pushU32LE(out, 2); // count = 2 friends
    // ── Friend 1 ──
    pushU32LE(out, 0x50000001); // FriendId
    pushU32LE(out, 1);          // isOnline
    pushU32LE(out, 0);          // appearOffline
    pushString16L(out, 'Alice');
    pushU32LE(out, 3);          // friend-of-friend count = 3
    pushU32LE(out, 0xAAAA0001); // ff1
    pushU32LE(out, 0xAAAA0002); // ff2
    pushU32LE(out, 0xAAAA0003); // ff3
    pushU32LE(out, 2);          // inverse-friend count = 2
    pushU32LE(out, 0xBBBB0001); // inv1
    pushU32LE(out, 0xBBBB0002); // inv2
    // ── Friend 2 ──
    pushU32LE(out, 0x50000002); // FriendId
    pushU32LE(out, 0);          // isOnline
    pushU32LE(out, 0);          // appearOffline
    pushString16L(out, 'Bob');
    pushU32LE(out, 0);          // friend-of-friend count = 0
    pushU32LE(out, 0);          // inverse-friend count = 0
    // ── Trailer ──
    pushU32LE(out, 0);          // updateType = FullList

    const payload = new Uint8Array(out);
    const result = parseFriendsListUpdate(payload);

    expect(result).not.toBeNull();
    expect(result!.friends).toHaveLength(2);
    expect(result!.friends[0]).toEqual({
      guid: 0x50000001,
      name: 'Alice',
      isOnline: true,
    });
    expect(result!.friends[1]).toEqual({
      guid: 0x50000002,
      name: 'Bob',
      isOnline: false,
    });
    expect(result!.updateType).toBe(0);
  });

  it('parser still works with the live-ACE case (both counts = 0)', () => {
    const out: number[] = [];
    pushU32LE(out, 1); // count = 1 friend
    pushU32LE(out, 0x50000010);
    pushU32LE(out, 1);
    pushU32LE(out, 0);
    pushString16L(out, 'Charlie');
    pushU32LE(out, 0);          // friend-of-friend count = 0 (live ACE)
    pushU32LE(out, 0);          // inverse-friend count = 0 (live ACE)
    pushU32LE(out, 1);          // updateType = FriendAdded

    const payload = new Uint8Array(out);
    const result = parseFriendsListUpdate(payload);

    expect(result).not.toBeNull();
    expect(result!.friends).toHaveLength(1);
    expect(result!.friends[0].name).toBe('Charlie');
    expect(result!.updateType).toBe(1);
  });
});

describe.skipIf(!aceReferenceExists(ACE_FRIENDS_PATH))('FAITHFUL.571 — ACE source still has the per-friend list writes', () => {
  let ACE_FRIENDS: string;
  beforeAll(() => { ACE_FRIENDS = readFileSync(ACE_FRIENDS_PATH, 'utf-8'); });

  it('ACE writes friendFriendList count (currently 0 via TODO)', () => {
    // The literal `Writer.Write((uint)0/* TODO` pattern that anchors the
    // currently-zero-but-shaped-as-count behavior we defend against.
    expect(ACE_FRIENDS).toMatch(/Writer\.Write\(\(uint\)0\/\*\s*TODO[\s\S]+?CharacterPropertiesFriendList\.Count/);
  });

  it('ACE writes inverse-friend list count (also TODO, also currently 0)', () => {
    // There are TWO Writer.Write((uint)0/* TODO ... */) calls in the per-friend
    // loop — one for friendFriendCount, one for inverseFriendCount.
    const matches = ACE_FRIENDS.match(/Writer\.Write\(\(uint\)0\/\*\s*TODO/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('ACE still writes the trailing updateType u32 after all friends', () => {
    expect(ACE_FRIENDS).toMatch(/Writer\.Write\(\(uint\)updateType\)/);
  });
});
