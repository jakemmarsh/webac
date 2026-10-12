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
