/**
 * tools/ac-agent/client.ts findDaemon: a profile named by argument or
 * AC_AGENT_PROFILE never resolves to another profile's daemon. On 2026-10-12
 * `AC_AGENT_PROFILE=sppb cli stop` (sppb's daemon had already exited) fell back
 * to "the only running daemon" and stopped another session's player.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir: string;
let findDaemon: typeof import('../tools/ac-agent/client').findDaemon;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'find-daemon-'));
  vi.stubEnv('ACJS_AGENT_STATE_DIR', dir);
  vi.stubEnv('AC_AGENT_PROFILE', '');
  vi.resetModules();
  const state = await import('../tools/ac-agent/state');
  ({ findDaemon } = await import('../tools/ac-agent/client'));
  // One live daemon (this process's pid), someone else's.
  state.writeInfo({ profile: 'stream', pid: process.pid, port: 1 } as Parameters<typeof state.writeInfo>[0]);
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe('findDaemon', () => {
  it('a named profile with no daemon finds nothing, even with one other daemon running', () => {
    expect(findDaemon('sppb', undefined)).toBeNull();
    expect(findDaemon(undefined, 'sppb')).toBeNull();
  });

  it('finds the named profile', () => {
    expect(findDaemon('stream', undefined)?.profile).toBe('stream');
    expect(findDaemon(undefined, 'stream')?.profile).toBe('stream');
  });

  it('with no profile named at all, the one running daemon is still the default', () => {
    expect(findDaemon(undefined, undefined)?.profile).toBe('stream');
  });
});
