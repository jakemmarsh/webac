/**
 * How long the local daemon holds a /call before answering (tools/ac-agent/daemon.ts). Node's fetch (undici) gives
 * up on a response whose headers take more than 300 s (headersTimeout) with a bare "fetch failed", and a long walk
 * (walk_to timeout_s=240, plus the time it stands searching, which its own limit doesn't count) ran past that: the
 * CLI printed "error: fetch failed" while the walk went on and later arrived (2026-10-12). So the daemon answers by
 * DAEMON_REPLY_MS at the latest: an acting call still running then "is still in progress" (ok) and keeps going in the
 * game, as the hosted relay's calls do (relayTab.ts); its task-done event says when it ends. A reading call that
 * slow is an error.
 */
import { READ_METHODS, stillInProgressMessage } from '../../packages/renderer/src/agent/claudeControl.ts';

export const DAEMON_REPLY_MS = 240_000;
/** The shortest reply deadline a caller may ask for. */
export const MIN_REPLY_MS = 5000;

/**
 * The reply deadline for one call: the caller's own (`replyMs`, from AC_AGENT_REPLY_S: a stream player sets 30 s) for an
 * acting call, else DAEMON_REPLY_MS. A stream player's session (`claude -p`) sends a Bash command still running at
 * 120 s to the background, and while a call runs the player can neither talk nor react: a 120 s follow beside a
 * leader who had stopped, and a /f line queued behind it for two minutes (rehearsals of 2026-10-13). A wait and a
 * read keep the daemon's deadline: a wait is meant to sleep its timeout, and a read cut short is an error.
 */
export function replyDeadlineMs(method: string, replyMs?: unknown): number {
  const n = Number(replyMs);
  if (replyMs === undefined || replyMs === null || !Number.isFinite(n) || n <= 0) return DAEMON_REPLY_MS;
  if (method === 'wait' || READ_METHODS.has(method)) return DAEMON_REPLY_MS;
  return Math.min(Math.max(n, MIN_REPLY_MS), DAEMON_REPLY_MS);
}

export async function withCallDeadline<T>(work: Promise<T>, method: string, timeoutMs: number, replyMs = DAEMON_REPLY_MS): Promise<T | { ok: true; message: string }> {
  const ms = Math.max(1000, Math.min(timeoutMs, replyMs));
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The work goes on after the answer: a late failure must not surface as an unhandled rejection.
  work.catch(() => {});
  const deadline = new Promise<'deadline'>((res) => { timer = setTimeout(() => res('deadline'), ms); });
  try {
    const out = await Promise.race([work, deadline]);
    if (out !== 'deadline') return out as T;
    if (READ_METHODS.has(method)) throw new Error(`${method} timed out after ${ms} ms`);
    return { ok: true, message: stillInProgressMessage(method, Math.round(ms / 1000)) };
  } finally { if (timer) clearTimeout(timer); }
}
