/**
 * BUG.multi-tab-login-pingpong — a refusal the bridge states with a WebSocket
 * close code rather than an HTTP status a browser can't read.
 *
 * The bridge caps sessions per client address (services/ws-tcp-bridge
 * server.ts `CLOSE_IP_CAP`, the same value). A refused upgrade used to be a
 * bare HTTP 429, which the page saw only as a socket that never opened, and
 * reported as retail's "Couldn't create local socket. Make sure you have a
 * working network." A player who had opened the game in eight tabs on
 * 2026-10-16 was locked out with that text. Now the bridge accepts the
 * upgrade and closes it at once with this code; the connection reports it as
 * an 'error' with `bridgeRefusal` and no 'disconnected' (there was never a
 * session to lose).
 */
export const BRIDGE_CLOSE_IP_CAP = 4429;
/**
 * A world the bridge gives each session its own address (its per-address
 * caps would otherwise be shared by every webAC player; the bridge's
 * egress.ts) has no free address right now (server.ts CLOSE_WORLD_FULL).
 */
export const BRIDGE_CLOSE_WORLD_FULL = 4503;
/**
 * On such a world the login named a new account, and the player's own
 * address has already made the world's limit of new accounts through webAC
 * (server.ts CLOSE_NEW_ACCOUNT_CAP). Closed before the login reached the
 * server, so after the socket opened.
 */
export const BRIDGE_CLOSE_NEW_ACCOUNT_CAP = 4403;
/**
 * On such a world the login named a new account, and none of the bridge's
 * addresses may create one any more (the world caps account creations per
 * address for life) and no fresh address could be had
 * (server.ts CLOSE_NEW_ACCOUNT_UNAVAILABLE). Existing accounts still log in.
 */
export const BRIDGE_CLOSE_NEW_ACCOUNT_UNAVAILABLE = 4504;

/**
 * The close reason (with BRIDGE_CLOSE_IP_CAP) for an egress world's own
 * per-address session limit applied to the player's real IP, as
 * `server_ip_cap:<sessionsPerAddress>` (server.ts serverIpCapCloseReason): a
 * page that predates it reads the code alone, as the bridge's ip_cap.
 */
export const BRIDGE_SERVER_IP_CAP_REASON = 'server_ip_cap';

/**
 * Why the bridge refused this connection. 'server_ip_cap': the server lets
 * only so many sessions in per address and this player's network already has
 * them (not the bridge's own cap across every server).
 */
export type BridgeRefusal = 'ip_cap' | 'server_ip_cap' | 'world_full' | 'new_account_cap' | 'new_account_unavailable';

/** `server_ip_cap[:<n>]` → n (null: no number, or another reason). */
function serverIpCapOf(reason: string | undefined): { perAddress: number | null } | null {
  const m = /^server_ip_cap(?::(\d{1,4}))?$/.exec(reason ?? '');
  if (!m) return null;
  const n = m[1] === undefined ? NaN : parseInt(m[1], 10);
  return { perAddress: n > 0 ? n : null };
}

/** The refusal a WebSocket close code (and reason) names, or null for an ordinary close. */
export function bridgeRefusalFromClose(code: number | undefined, reason?: string): BridgeRefusal | null {
  switch (code) {
    case BRIDGE_CLOSE_IP_CAP: return serverIpCapOf(reason) ? 'server_ip_cap' : 'ip_cap';
    case BRIDGE_CLOSE_WORLD_FULL: return 'world_full';
    case BRIDGE_CLOSE_NEW_ACCOUNT_CAP: return 'new_account_cap';
    case BRIDGE_CLOSE_NEW_ACCOUNT_UNAVAILABLE: return 'new_account_unavailable';
    default: return null;
  }
}

/** On 'server_ip_cap': the sessions the server allows per address, from the close reason (null: not said). */
export function bridgeRefusalPerAddress(code: number | undefined, reason?: string): number | null {
  return code === BRIDGE_CLOSE_IP_CAP ? serverIpCapOf(reason)?.perAddress ?? null : null;
}

/** A bridge health probe (probeBridgeHealth) the bridge refused with a readable close. */
export class BridgeRefusalError extends Error {
  constructor(readonly refusal: BridgeRefusal) {
    super(`Bridge refused the connection (${refusal})`);
    this.name = 'BridgeRefusalError';
  }
}

/** The refusal behind a rejected probe, or null for any other failure. */
export function bridgeRefusalOf(err: unknown): BridgeRefusal | null {
  return err instanceof BridgeRefusalError ? err.refusal : null;
}
