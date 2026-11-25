/**
 * The page's link check: retail CPlayerSystem::UseTime @ 00563110.
 *
 * Every CHECK_LINK_STATUS_INTERVAL (4 s) retail samples LinkStatusHolder
 * (connected + seconds since the last packet from the server) and raises
 * ServerDied when `DISCONNECT_TIME (40 s) < seconds since || !connected`.
 * The same sample drives the Link Indicator (gmUIElement_LinkStatusIndicator).
 *
 * CPlayerSystem is one of UIQueueManager's client systems (created in
 * UIQueueManager::OnStartup @ 0055ab50), and UIQueueManager::UseTime
 * @ 0055d330 calls every system's UseTime each frame from the moment the
 * client starts, so retail ran this check at character select and in
 * character creation as well as in the world. Ours ran only from entering the
 * world (and on through a logout), so a session that went silent in chargen or
 * at character select was never noticed: BUG.preworld-link-dead-finish
 * (2026-11-24, The Tower, end of retail: a hidden tab's net tick stopped for
 * 163 s in chargen, ACE dropped the session, and FINISH waited out its 20 s
 * into a refusal instead of the chargen resume that keeps every choice).
 *
 * One check per page, running while a session is live: started when a
 * session's character list arrives (the session is proven) and on entering
 * the world, stopped when that session ends (a drop, the Disconnected screen,
 * leaving for the launcher). start() is idempotent: chargen → FINISH → enter
 * world never runs two. A dead sample stops the check before reporting it, so
 * one dead session gets one verdict; the next session's character list starts
 * it again.
 *
 * Only a connected sample can be dead here: a closed socket is the
 * connection's own 'disconnected' event (main.ts onSessionEnded), and a
 * sample from a session still in its handshake (ClientConnection: below
 * AuthConnected) reads not connected.
 *
 * The 40 s is counted over the time the receiving thread ran
 * (BUG.linkcheck-verdict-after-freeze, ConnectionNotices.linkSampleIsDead):
 * a machine that froze the worker in pieces under 40 s read a live session as
 * link_dead on the first tick after it woke.
 */
import type { LinkSample } from '@ac/network';
import { linkDeadCause, linkSampleIsDead } from '../ui/ConnectionNotices.js';

/** How often the page samples the link: the Link Indicator's own cadence (its model re-evaluates every 4 s). */
export const LINK_CHECK_TICK_MS = 250;

export type LinkDeadCause = 'link_dead' | 'client_suspended';

export interface LinkCheckHost {
  /** The connection's link sample (NetConnection.getLinkStatus). */
  sample(): LinkSample;
  /** Feed the Link Indicator (GameUI.updateLinkStatus). */
  show(sample: LinkSample): void;
  /** The session is dead: end it (main.ts endDeadSession). The check has already stopped. */
  dead(cause: LinkDeadCause, sample: LinkSample): void;
}

export interface LinkCheckTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

const DEFAULT_TIMERS: LinkCheckTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

export class LinkCheck {
  private id: unknown = null;

  constructor(
    private readonly host: LinkCheckHost,
    private readonly tickMs: number = LINK_CHECK_TICK_MS,
    private readonly timers: LinkCheckTimers = DEFAULT_TIMERS,
  ) {}

  get running(): boolean { return this.id !== null; }

  /** A session is live (its character list, or the world): check it. No-op while already running. */
  start(): void {
    if (this.id !== null) return;
    this.id = this.timers.setInterval(() => this.tick(), this.tickMs);
  }

  /** The session ended (or the page left it): stop checking. */
  stop(): void {
    if (this.id === null) return;
    this.timers.clearInterval(this.id);
    this.id = null;
  }

  /** One sample: the indicator, then retail's ServerDied test. */
  tick(): void {
    const sample = this.host.sample();
    this.host.show(sample);
    if (!sample.connected || !linkSampleIsDead(sample)) return;
    this.stop();
    this.host.dead(linkDeadCause(sample), sample);
  }
}

/**
 * Whether a connection's session is dead for a send that needs it: the
 * socket is not connected, or the link check's own test finds it silent past
 * DISCONNECT_TIME (the check may not have ticked since the page woke from a
 * frozen background tab, or not be running on this screen). null when live.
 */
export function deadSessionCause(connection: {
  readonly isConnected: boolean;
  getLinkStatus(): LinkSample;
}): LinkDeadCause | null {
  if (!connection.isConnected) return 'link_dead';
  const sample = connection.getLinkStatus();
  return sample.connected && linkSampleIsDead(sample) ? linkDeadCause(sample) : null;
}
