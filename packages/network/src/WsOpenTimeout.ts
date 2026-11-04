/**
 * BUG.resume-hung-socket — how long a session WebSocket may stay CONNECTING
 * before the client gives up on it.
 *
 * A browser WebSocket has no open timeout of its own: on a path that drops
 * packets without refusing them (Wi-Fi associated with no route, a captive
 * portal, a VPN tunnel that is going down) the TCP connect waits for the
 * operating system's own give-up, about 21 s on Windows, 75 s on macOS and
 * over two minutes on Linux / Android. During an automatic resume that left
 * the connecting screen up the whole time with no next attempt.
 *
 * 15 s: a healthy open is DNS + TCP + TLS + the HTTP upgrade, four round trips
 * (about 2.5 s at a 600 ms satellite / poor-mobile RTT). 15 s also covers the
 * SYN retransmissions a lossy link needs and still opens on: Windows resends
 * at 3 s and 9 s, Linux at 1, 3 and 7 s.
 * A socket still CONNECTING after that is not opening. The client then reports
 * it exactly as a socket that failed to open (retail ClientNet::InitAddresses'
 * ID_NetError_CantSocket), with `openTimedOut` set, so the caller's ordinary
 * failure path (the resume's next attempt, or the launcher's refusal dialog)
 * runs instead of a wait the player can't see the end of.
 *
 * Only the socket connect() opens has this timer. A planned handover's socket
 * is bounded by SocketHandover's own stage timeouts; an open socket never
 * times out here (the dead-server checks own a live session).
 */
export const WS_OPEN_TIMEOUT_MS = 15_000;

/** WebSocket.CONNECTING (a literal: a worker or a test may not define the WebSocket statics). */
export const WS_CONNECTING = 0;

/** The members of a socket the timer reads. */
export interface OpeningSocket {
  readonly readyState: number;
}

/**
 * Arm the open timeout for `socket`: `onTimeout` runs once after `ms` if the
 * socket is still CONNECTING then. Returns the disarm function (call it when
 * the socket opens, fails, or is left).
 */
export function armOpenTimeout(
  socket: OpeningSocket,
  onTimeout: () => void,
  ms: number = WS_OPEN_TIMEOUT_MS,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void } = {
    set: (fn, t) => setTimeout(fn, t),
    clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
): () => void {
  let handle: unknown = timers.set(() => {
    handle = null;
    if (socket.readyState === WS_CONNECTING) onTimeout();
  }, ms);
  return () => {
    if (handle !== null) { timers.clear(handle); handle = null; }
  };
}
