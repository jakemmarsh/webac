/**
 * ConnectionData — manages connection state for the AC protocol handshake.
 *
 * Handles the three-way handshake:
 *   1. Client sends LoginRequest
 *   2. Server sends ConnectRequest (with cookie, seeds)
 *   3. Client echoes ConnectResponse (with cookie)
 *
 * After handshake, ISAAC ciphers are initialized for encrypted checksums.
 *
 * Ported from ACE.Server.Network.Managers.SessionConnectionData.
 */

import { CryptoSystem } from './ISAAC.js';

export enum SessionState {
  AuthLoginRequest    = 0,
  AuthConnectResponse = 1,
  AuthConnected       = 2,
  WorldConnected      = 3,
}

export interface ConnectRequestData {
  serverTime: number;     // 64-bit double
  cookie: Uint8Array;     // 8 bytes
  clientId: number;       // uint32
  serverSeed: Uint8Array; // 4 bytes
  clientSeed: Uint8Array; // 4 bytes
}

export interface LoginRequestData {
  clientVersion: string;
  netAuthType: number;    // 0=password, 1=GLS ticket
  authFlags: number;
  timestamp: number;
  account: string;
  accountToLoginAs: string;
  password: string;       // if netAuthType=0
  glsTicket: string;      // if netAuthType=1
}

/**
 * Generate random bytes for seeds and cookies.
 */
function randomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  } else {
    // Fallback for environments without Web Crypto
    for (let i = 0; i < length; i++) {
      buf[i] = Math.floor(Math.random() * 256);
    }
  }
  return buf;
}

/**
 * ConnectionData manages the protocol state for a single connection.
 */
export class ConnectionData {
  state: SessionState = SessionState.AuthLoginRequest;
  clientSeed: Uint8Array;
  serverSeed: Uint8Array;
  connectionCookie: Uint8Array;
  clientId: number;

  /** ISAAC-based crypto for verifying C2S checksums. */
  cryptoClient: CryptoSystem | null = null;
  /** ISAAC-based crypto for S2C checksums. */
  cryptoServer: CryptoSystem | null = null;

  /** Packet sequence counter. */
  packetSequence: number = 0;
  /** Fragment sequence counter. */
  fragmentSequence: number = 0;

  /**
   * clientId is the header Id (retail recID_) the client stamps on every
   * packet. It is unknown until the server's ConnectRequest assigns it
   * (initializeCryptoFromConnect; retail ClientNet::HandleConnectionRequest
   * @ 00545ac0 takes recID_ from that packet), so a fresh connection starts at
   * 0: the connectionless id. GDLE only routes a LoginRequest whose wRecID is
   * 0 to its login path (Network.cpp: `if (wRecID == 0)
   * ProcessConnectionless`); any other id goes to client validation, finds no
   * session and the login is silently dropped. ACE ignores the Id on
   * LoginRequest, so 0 works there too. (The old default of 1 never let us
   * log in to GDLE.)
   */
  constructor(clientId: number = 0) {
    this.clientSeed = randomBytes(4);
    this.serverSeed = randomBytes(4);
    this.connectionCookie = randomBytes(8);
    this.clientId = clientId;
  }

  /**
   * Initialize crypto from seeds (called after handshake completes).
   */
  initializeCrypto(): void {
    this.cryptoClient = new CryptoSystem(this.clientSeed);
    this.cryptoServer = new CryptoSystem(this.serverSeed);
  }

  /**
   * Initialize crypto from received ConnectRequest data (client-side).
   */
  initializeCryptoFromConnect(data: ConnectRequestData): void {
    this.clientSeed = data.clientSeed;
    this.serverSeed = data.serverSeed;
    this.connectionCookie = data.cookie;
    this.clientId = data.clientId;
    this.cryptoClient = new CryptoSystem(this.clientSeed);
    this.cryptoServer = new CryptoSystem(this.serverSeed);
  }

  /**
   * Get the next packet sequence number.
   */
  nextPacketSequence(): number {
    return ++this.packetSequence;
  }

  /**
   * Get the next fragment sequence number.
   */
  nextFragmentSequence(): number {
    return ++this.fragmentSequence;
  }

  /**
   * Build the ConnectRequest payload (server → client).
   */
  buildConnectRequest(serverTime: number = 0): Uint8Array {
    const buf = new Uint8Array(32);
    const view = new DataView(buf.buffer);

    view.setFloat64(0, serverTime, true);       // serverTime (8B)
    buf.set(this.connectionCookie, 8);           // cookie (8B)
    view.setUint32(16, this.clientId, true);     // clientId (4B)
    buf.set(this.serverSeed, 20);                // serverSeed (4B)
    buf.set(this.clientSeed, 24);                // clientSeed (4B)
    view.setUint32(28, 0, true);                 // padding (4B)

    return buf;
  }

  /**
   * Parse a ConnectRequest payload (client-side).
   */
  static parseConnectRequest(data: Uint8Array): ConnectRequestData {
    const view = new DataView(data.buffer, data.byteOffset, data.length);
    return {
      serverTime: view.getFloat64(0, true),
      cookie: data.slice(8, 16),
      clientId: view.getUint32(16, true),
      serverSeed: data.slice(20, 24),
      clientSeed: data.slice(24, 28),
    };
  }

  /**
   * Build a ConnectResponse payload (client → server).
   */
  buildConnectResponse(): Uint8Array {
    const buf = new Uint8Array(8);
    buf.set(this.connectionCookie, 0); // echo cookie
    return buf;
  }

  /**
   * Verify a ConnectResponse payload (server-side).
   */
  verifyConnectResponse(data: Uint8Array): boolean {
    if (data.length < 8) return false;
    for (let i = 0; i < 8; i++) {
      if (data[i] !== this.connectionCookie[i]) return false;
    }
    return true;
  }
}
