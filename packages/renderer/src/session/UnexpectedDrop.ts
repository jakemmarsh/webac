/**
 * BUG.link-dead-no-resume — what the page does when its own 40 s link check
 * (CPlayerSystem::UseTime's DISCONNECT_TIME, main.ts link tick) finds the
 * session dead while the connection itself has not closed.
 *
 * The connection's 'disconnected' event already resumes an in-world drop
 * (SessionLifecycle.RESUME_DELAYS_MS, the named CLAUDE.md exception). The
 * link check went straight to retail's Disconnected screen and ended the
 * resume, so a drop it caught first never came back (2026-10-16 production:
 * a Snowreap world_left with endCause link_dead, then a page that sat on the
 * Disconnected screen for 21 min). It now ends the world the same way and
 * tries the resume first; the Disconnected screen only when there is nothing
 * to resume (not in the world, a deliberate logout) or the budget is spent.
 *
 * The dead socket is closed by scheduleResume's own disconnect(): that close
 * is deliberate ('local'), so the 'disconnected' event it raises neither
 * reports the drop again nor schedules a second resume, and it never marks a
 * logout (only SessionLifecycle.noteLoggedOut does), so the resume stands.
 */
import type { SessionLifecycle } from './SessionLifecycle.js';

export interface UnexpectedDropHost {
  lifecycle: SessionLifecycle;
  /** world_left with the drop's cause and diagnostics (WorldReporter.left: once per world session). */
  reportLeft(): void;
  /** Tear the world down: world state, the link tick, the connection indicator. */
  teardownWorld(): void;
  /**
   * The next resume attempt (main.ts scheduleResume: closes what is left of
   * the connection, shows the connecting screen, reconnects after the delay);
   * false when the lifecycle has nothing to resume or the budget is spent.
   */
  scheduleResume(): boolean;
  /** Retail's Disconnected screen (main.ts raiseServerDied). */
  raiseServerDied(): void;
}

/** End a session found dead by the page: resume it from the world when possible, else the Disconnected screen. */
export function handleUnexpectedDrop(host: UnexpectedDropHost): 'resuming' | 'server_died' {
  const { lifecycle } = host;
  if (lifecycle.inWorld || lifecycle.resumingAfterDrop) {
    host.reportLeft();
    lifecycle.noteDisconnected();
    host.teardownWorld();
    if (host.scheduleResume()) return 'resuming';
  }
  host.raiseServerDied();
  return 'server_died';
}
