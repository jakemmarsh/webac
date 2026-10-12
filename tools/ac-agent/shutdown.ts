/**
 * The daemon's shutdown, made to end the process every time (2026-10-12: after `stop` the daemon logged
 * "shutting down (requested)", its bridge saw the page close, and then the daemon, npx and its node children
 * stayed up for 20+ minutes ignoring SIGTERM until a SIGKILL). The steps (logout, browser.close) can hang:
 * Playwright's close waited on a headed Chromium that never answered, so `process.exit` was never reached,
 * and the SIGTERM handler only re-entered a shutdown already under way and returned.
 *
 *  - a deadline: whatever the steps are doing, the children are killed and the process exits;
 *  - a second request (SIGTERM / SIGINT again) during the shutdown ends it at once;
 *  - children (bridge, Vite) are spawned in their own process group and killed as a group (npx → tsx →
 *    node: a kill of the npx pid alone left the node grandchildren running), SIGTERM then SIGKILL.
 */
import type { ChildProcess } from 'node:child_process';

export interface ShutdownDeps {
  say(line: string): void;
  /** The orderly part (log out, close the browser): may hang, the deadline covers it. */
  steps(why: string): Promise<void>;
  /** The children to end (null ones are skipped). */
  children(): Array<ChildProcess | null>;
  exit(code: number): void;
  /** Most the orderly part may take, ms. */
  deadlineMs?: number;
  /** How long a child gets after SIGTERM before SIGKILL, ms. */
  killGraceMs?: number;
  /** process.kill (tests replace it). */
  kill?(pid: number, signal: NodeJS.Signals): void;
}

export const SHUTDOWN_DEADLINE_MS = 30_000;
export const CHILD_KILL_GRACE_MS = 2_000;

/** End a child and everything it started: its process group (spawned detached), else the child alone. */
export async function killTree(child: ChildProcess, graceMs: number, kill: (pid: number, signal: NodeJS.Signals) => void): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  const signal = (s: NodeJS.Signals): void => {
    try { kill(-pid, s); } catch { try { kill(pid, s); } catch { /* already gone */ } }
  };
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  signal('SIGTERM');
  const done = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs))]);
  if (!done) signal('SIGKILL');
}

/** The shutdown function: call it for a /shutdown request, a signal, or the browser going away. */
export function createShutdown(deps: ShutdownDeps): (why: string) => Promise<void> {
  const kill = deps.kill ?? ((pid: number, s: NodeJS.Signals) => { process.kill(pid, s); });
  const grace = deps.killGraceMs ?? CHILD_KILL_GRACE_MS;
  let state: 'running' | 'stopping' | 'done' = 'running';
  const finish = async (code: number): Promise<void> => {
    if (state === 'done') return;
    state = 'done';
    await Promise.all(deps.children().filter((c): c is ChildProcess => !!c).map((c) => killTree(c, grace, kill).catch(() => {})));
    deps.exit(code);
  };
  return async (why: string): Promise<void> => {
    if (state === 'done') return;
    if (state === 'stopping') {
      // Asked again while stopping (a second SIGTERM, Ctrl-C twice): stop waiting on the orderly part.
      deps.say(`shutting down now (${why}, during the shutdown)`);
      return finish(1);
    }
    state = 'stopping';
    deps.say(`shutting down (${why})`);
    const deadline = setTimeout(() => {
      deps.say(`shutdown still not done after ${Math.round((deps.deadlineMs ?? SHUTDOWN_DEADLINE_MS) / 1000)} s: ending it`);
      void finish(1);
    }, deps.deadlineMs ?? SHUTDOWN_DEADLINE_MS);
    try {
      await deps.steps(why);
    } catch (e) {
      deps.say(`shutdown step failed: ${(e as Error)?.message ?? e}`);
    }
    clearTimeout(deadline);
    await finish(0);
  };
}
