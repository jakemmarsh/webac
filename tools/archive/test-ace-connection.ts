/**
 * test-ace-connection.ts — Test ACE server connectivity through ws-udp-bridge.
 *
 * Usage: npx tsx tools/test-ace-connection.ts [bridgeUrl] [account] [password]
 * Default: ws://localhost:9090, account "testacjs", password "testacjs"
 *
 * This sends a LoginRequest through the bridge and prints what comes back.
 */

import WebSocket from 'ws';

const BRIDGE_URL = process.argv[2] || 'ws://localhost:9090';
const ACCOUNT = process.argv[3] || 'testacjs';
const PASSWORD = process.argv[4] || 'testacjs';

// AC packet header: 20 bytes (seq, flags, checksum, id, time, size, iteration)
const HEADER_SIZE = 20;

// Packet header flags
const FLAG_LOGIN_REQUEST    = 0x00010000;
const FLAG_CONNECT_REQUEST  = 0x00040000;
const FLAG_CONNECT_RESPONSE = 0x00080000;
const FLAG_BLOB_FRAGMENTS   = 0x00000004;
const FLAG_ACK_SEQUENCE     = 0x00004000;
const FLAG_TIME_SYNC        = 0x01000000;
const FLAG_ECHO_REQUEST     = 0x02000000;
const FLAG_ECHO_RESPONSE    = 0x04000000;
const FLAG_FLOW             = 0x08000000;
const FLAG_DISCONNECT       = 0x00008000;
const FLAG_NET_ERROR        = 0x00100000;
const FLAG_NET_ERROR_DISC   = 0x00200000;

function flagsToString(flags: number): string {
  const names: string[] = [];
  if (flags & 0x00000001) names.push('Retransmission');
  if (flags & 0x00000002) names.push('EncryptedChecksum');
  if (flags & FLAG_BLOB_FRAGMENTS) names.push('BlobFragments');
  if (flags & 0x00000100) names.push('ServerSwitch');
  if (flags & 0x00001000) names.push('RequestRetransmit');
  if (flags & 0x00002000) names.push('RejectRetransmit');
  if (flags & FLAG_ACK_SEQUENCE) names.push('AckSequence');
  if (flags & FLAG_DISCONNECT) names.push('Disconnect');
  if (flags & FLAG_LOGIN_REQUEST) names.push('LoginRequest');
  if (flags & 0x00020000) names.push('WorldLoginRequest');
  if (flags & FLAG_CONNECT_REQUEST) names.push('ConnectRequest');
  if (flags & FLAG_CONNECT_RESPONSE) names.push('ConnectResponse');
  if (flags & FLAG_NET_ERROR) names.push('NetError');
  if (flags & FLAG_NET_ERROR_DISC) names.push('NetErrorDisconnect');
  if (flags & FLAG_TIME_SYNC) names.push('TimeSync');
  if (flags & FLAG_ECHO_REQUEST) names.push('EchoRequest');
  if (flags & FLAG_ECHO_RESPONSE) names.push('EchoResponse');
  if (flags & FLAG_FLOW) names.push('Flow');
  return names.join(' | ') || `0x${flags.toString(16)}`;
}

function hexDump(data: Uint8Array, maxBytes: number = 64): string {
  const hex: string[] = [];
  for (let i = 0; i < Math.min(data.length, maxBytes); i++) {
    hex.push(data[i].toString(16).padStart(2, '0'));
  }
  if (data.length > maxBytes) hex.push('...');
  return hex.join(' ');
}

// Simple hash32 (from Hash32.ts)
function hash32(data: Uint8Array, offset: number, length: number): number {
  let checksum = length << 16;
  let cursor = 0;
  while (cursor + 4 <= length) {
    const v = new DataView(data.buffer, data.byteOffset + offset + cursor);
    checksum = (checksum + v.getUint32(0, true)) >>> 0;
    cursor += 4;
  }
  // remaining bytes
  let remaining = 0;
  for (let i = 0; i < length - cursor; i++) {
    remaining |= data[offset + cursor + i] << (i * 8);
  }
  if (length - cursor > 0) {
    checksum = (checksum + remaining) >>> 0;
  }
  return checksum;
}

/**
 * Write a String16L field: 2-byte LE length + chars + padding to 4-byte boundary.
 * Returns number of bytes written.
 */
function writeString16L(buf: Uint8Array, offset: number, str: string): number {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  const view = new DataView(buf.buffer, buf.byteOffset);
  view.setUint16(offset, bytes.length, true);
  buf.set(bytes, offset + 2);
  const rawLen = 2 + bytes.length;
  const padded = Math.ceil(rawLen / 4) * 4;
  return padded;
}

/**
 * Write a String32L field: 4-byte LE data length + packed word prefix byte + chars.
 * The "data length" includes the packed word prefix byte(s).
 * Returns number of bytes written.
 */
function writeString32L(buf: Uint8Array, offset: number, str: string): number {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  const view = new DataView(buf.buffer, buf.byteOffset);

  // Data length = 1 (packed word prefix byte) + string bytes
  // For strings <= 255 chars, the packed word is 1 byte
  const dataLen = 1 + bytes.length;
  view.setUint32(offset, dataLen, true);
  buf[offset + 4] = bytes.length; // packed word: 1 byte for length <= 255
  buf.set(bytes, offset + 5);
  const rawLen = 4 + dataLen;
  const padded = Math.ceil(rawLen / 4) * 4;
  return padded;
}

/**
 * Calculate String16L total size in bytes (for pre-allocation).
 */
function string16LSize(str: string): number {
  const rawLen = 2 + new TextEncoder().encode(str).length;
  return Math.ceil(rawLen / 4) * 4;
}

/**
 * Calculate String32L total size in bytes.
 */
function string32LSize(str: string): number {
  const rawLen = 4 + 1 + new TextEncoder().encode(str).length;
  return Math.ceil(rawLen / 4) * 4;
}

function buildLoginPacket(account: string, password: string): Uint8Array {
  // ACE LoginRequest format (from PacketInboundLoginRequest.cs):
  //   1. ClientVersion (String16L) — "1802"
  //   2. DataLength (uint32) — remaining bytes after this point
  //   3. NetAuthType (uint32) — 0x00000002 = AccountPassword
  //   4. AuthFlags (uint32) — 0
  //   5. Timestamp (uint32) — 0
  //   6. Account (String16L)
  //   7. AccountToLoginAs (String16L)
  //   8. Password (String32L) — packed word encoding

  const versionSize = string16LSize('1802');
  const acctSize = string16LSize(account);
  const loginAsSize = string16LSize(account); // same as account
  const passSize = string32LSize(password);

  // DataLength = everything after the DataLength field itself
  const dataLength = 4 + 4 + 4 + acctSize + loginAsSize + passSize; // NetAuth + Flags + Timestamp + account + loginAs + pass

  const payloadSize = versionSize + 4 + dataLength; // version + DataLength field + rest
  const totalSize = HEADER_SIZE + payloadSize;
  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);

  let offset = HEADER_SIZE;

  // 1. ClientVersion
  offset += writeString16L(buf, offset, '1802');

  // 2. DataLength
  view.setUint32(offset, dataLength, true); offset += 4;

  // 3. NetAuthType = AccountPassword (0x00000002)
  view.setUint32(offset, 0x00000002, true); offset += 4;

  // 4. AuthFlags = 0
  view.setUint32(offset, 0, true); offset += 4;

  // 5. Timestamp = 0
  view.setUint32(offset, 0, true); offset += 4;

  // 6. Account
  offset += writeString16L(buf, offset, account);

  // 7. AccountToLoginAs (same as account for normal login)
  offset += writeString16L(buf, offset, account);

  // 8. Password (String32L)
  offset += writeString32L(buf, offset, password);

  // Write packet header
  // CRITICAL: LoginRequest MUST use sequence 0. ACE initializes lastReceivedPacketSequence=1
  // and drops packets with seq <= 1 (except seq=0, which is special-cased for connect packets).
  const CHECKSUM_SENTINEL = 0xBADD70DD;
  view.setUint32(0, 0, true);               // sequence = 0 (connect packet)
  view.setUint32(4, FLAG_LOGIN_REQUEST, true); // flags
  view.setUint32(8, CHECKSUM_SENTINEL, true);  // checksum placeholder
  view.setUint16(12, 0, true);               // id
  view.setUint16(14, 0, true);               // time
  view.setUint16(16, payloadSize, true);     // size
  view.setUint16(18, 0, true);               // iteration

  // Calculate checksum
  const headerHash = hash32(buf, 0, HEADER_SIZE);
  const payloadHash = hash32(buf, HEADER_SIZE, payloadSize);
  view.setUint32(8, (headerHash + payloadHash) >>> 0, true);

  return buf;
}

function buildConnectResponse(cookie: Uint8Array): Uint8Array {
  const totalSize = HEADER_SIZE + 8;
  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer);

  // Payload: echo 8-byte cookie
  buf.set(cookie, HEADER_SIZE);

  // Header
  const CHECKSUM_SENTINEL = 0xBADD70DD;
  const seq = 0; // connect phase packets use seq 0
  const flags = FLAG_CONNECT_RESPONSE;

  view.setUint32(0, seq, true);
  view.setUint32(4, flags, true);
  view.setUint32(8, CHECKSUM_SENTINEL, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0, true);
  view.setUint16(16, 8, true);
  view.setUint16(18, 0, true);

  const headerHash = hash32(buf, 0, HEADER_SIZE);
  const payloadHash = hash32(buf, HEADER_SIZE, 8);
  view.setUint32(8, (headerHash + payloadHash) >>> 0, true);

  return buf;
}

// ─── Main ────────────────────────────────────────────

console.log(`[test] Connecting to bridge at ${BRIDGE_URL}`);
console.log(`[test] Account: ${ACCOUNT}`);

const ws = new WebSocket(BRIDGE_URL);
ws.binaryType = 'arraybuffer';

let packetsReceived = 0;
let handshakeStartTime: number;

ws.on('open', () => {
  console.log('[test] WebSocket connected to bridge');
  handshakeStartTime = Date.now();

  // Send LoginRequest
  const loginPacket = buildLoginPacket(ACCOUNT, PASSWORD);
  console.log(`[test] Sending LoginRequest (${loginPacket.length} bytes)`);
  console.log(`[test] Payload hex: ${hexDump(loginPacket)}`);
  ws.send(loginPacket);
});

ws.on('message', (data: ArrayBuffer) => {
  const bytes = new Uint8Array(data);
  packetsReceived++;

  if (bytes.length < HEADER_SIZE) {
    console.log(`[test] Received short packet (${bytes.length} bytes): ${hexDump(bytes)}`);
    return;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const seq = view.getUint32(0, true);
  const flags = view.getUint32(4, true);
  const checksum = view.getUint32(8, true);
  const payloadSize = view.getUint16(16, true);

  console.log(`\n[test] Packet #${packetsReceived}: ${bytes.length} bytes, seq=${seq}, flags=${flagsToString(flags)}, size=${payloadSize}`);
  console.log(`[test] Header hex: ${hexDump(bytes.slice(0, HEADER_SIZE))}`);

  if (bytes.length > HEADER_SIZE) {
    console.log(`[test] Payload hex: ${hexDump(bytes.slice(HEADER_SIZE), 128)}`);
  }

  // Handle ConnectRequest
  if (flags & FLAG_CONNECT_REQUEST) {
    const elapsed = Date.now() - handshakeStartTime;
    console.log(`\n[test] *** Got ConnectRequest from ACE server! (${elapsed}ms) ***`);

    const offset = HEADER_SIZE;
    if (bytes.length >= offset + 32) {
      const serverTime = view.getFloat64(offset, true);
      const cookie = bytes.slice(offset + 8, offset + 16);
      const clientId = view.getUint32(offset + 16, true);
      const serverSeed = bytes.slice(offset + 20, offset + 24);
      const clientSeed = bytes.slice(offset + 24, offset + 28);

      console.log(`[test] ServerTime: ${serverTime}`);
      console.log(`[test] Cookie: ${hexDump(cookie)}`);
      console.log(`[test] ClientId: ${clientId}`);
      console.log(`[test] ServerSeed: ${hexDump(serverSeed)}`);
      console.log(`[test] ClientSeed: ${hexDump(clientSeed)}`);

      // Send ConnectResponse
      console.log(`[test] Sending ConnectResponse (echo cookie)...`);
      const response = buildConnectResponse(cookie);
      ws.send(response);
    }
  }

  // Handle Disconnect / NetError
  if (flags & FLAG_DISCONNECT) {
    console.log(`[test] *** Server sent Disconnect ***`);
  }
  if (flags & FLAG_NET_ERROR) {
    console.log(`[test] *** Server sent NetError ***`);
  }
  if (flags & FLAG_NET_ERROR_DISC) {
    console.log(`[test] *** Server sent NetErrorDisconnect ***`);
  }

  // Handle BlobFragments (character list, etc.)
  if (flags & FLAG_BLOB_FRAGMENTS) {
    console.log(`[test] *** Contains BlobFragments (game messages) ***`);
    // Just log for now — we could parse fragments to see character list
    let fOffset = HEADER_SIZE;

    // Skip optional headers
    if (flags & FLAG_ACK_SEQUENCE) fOffset += 4;
    if (flags & FLAG_TIME_SYNC) fOffset += 8;
    if (flags & FLAG_ECHO_REQUEST) fOffset += 4;
    if (flags & FLAG_FLOW) fOffset += 6;

    // Read fragment headers
    let fragNum = 0;
    while (fOffset + 16 <= bytes.length) {
      const fragView = new DataView(bytes.buffer, bytes.byteOffset + fOffset);
      const fragSeq = fragView.getUint32(0, true);
      const fragId = fragView.getUint32(4, true);
      const fragCount = fragView.getUint16(8, true);
      const fragSize = fragView.getUint16(10, true);
      const fragIndex = fragView.getUint16(12, true);
      const fragGroup = fragView.getUint16(14, true);

      console.log(`[test]   Fragment ${fragNum}: seq=${fragSeq} id=${fragId} ${fragIndex+1}/${fragCount} size=${fragSize} group=${fragGroup}`);

      if (fragSize > 16) {
        const fragData = bytes.slice(fOffset + 16, fOffset + fragSize);
        console.log(`[test]   Data: ${hexDump(fragData, 64)}`);
      }

      fOffset += fragSize;
      fragNum++;
      if (fragNum > 20) break; // safety
    }
  }
});

ws.on('error', (err) => {
  console.error(`[test] WebSocket error:`, err.message);
});

ws.on('close', (code, reason) => {
  console.log(`[test] WebSocket closed: code=${code} reason=${reason.toString()}`);
  console.log(`[test] Total packets received: ${packetsReceived}`);
  process.exit(0);
});

// Timeout after 15 seconds
setTimeout(() => {
  console.log(`\n[test] Timeout — ${packetsReceived} packets received total`);
  if (packetsReceived === 0) {
    console.log('[test] FAIL: No response from ACE server through bridge');
  } else {
    console.log('[test] Connection test complete');
  }
  ws.close();
  process.exit(packetsReceived > 0 ? 0 : 1);
}, 15000);
