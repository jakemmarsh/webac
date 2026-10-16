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

/** Why the bridge refused this connection. */
export type BridgeRefusal = 'ip_cap';

/** The refusal a WebSocket close code names, or null for an ordinary close. */
export function bridgeRefusalFromClose(code: number | undefined): BridgeRefusal | null {
  return code === BRIDGE_CLOSE_IP_CAP ? 'ip_cap' : null;
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
