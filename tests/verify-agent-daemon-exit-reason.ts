import { describe, expect, it } from 'vitest';
import { daemonExitReason } from '../tools/ac-agent/client.ts';

// startDaemon reads only the bytes this start appended to the profile's log; daemonExitReason picks the line
// that explains the exit. 2026-10-12: a page.goto failure was reported as a two-day-old git error instead.
describe('agent CLI: why the daemon exited', () => {
  it('takes the last Error: line', () => {
    expect(daemonExitReason('x\nError: first\nmore\nError: second\n')).toBe('second');
  });
  it('reports a Playwright page.goto failure, which has no Error: prefix', () => {
    const log = '2026-10-12T20:31:11Z game snapshot served\npage.goto: Navigation to "http://x" is interrupted by another navigation to "about:blank"\nCall log:\n    at main (daemon.ts:371:16) {\n  name: \'Error\'\n}\n';
    expect(daemonExitReason(log)).toMatch(/^page\.goto: Navigation .* interrupted/);
  });
  it('says nothing when the new lines hold no error', () => {
    expect(daemonExitReason('bridge started\ngame snapshot served\n')).toBeNull();
  });
});
