import { describe, it, expect } from 'vitest';
import { PatchStatusLatch, patchFailureText } from '../packages/renderer/src/ui/PatchScreen.js';

describe('patch failure latch (playwebac.com stuck on "Patching data...", 2026-10-04)', () => {
  it('ordinary status writes are allowed until a failure, then blocked', () => {
    const latch = new PatchStatusLatch();
    expect(latch.allows()).toBe(true);
    expect(latch.failed).toBe(false);
    expect(latch.fail('boom')).toBe('boom');
    expect(latch.failed).toBe(true);
    // The late bridge probe's "Connected!" must not paint over the error.
    expect(latch.allows()).toBe(false);
  });

  it('a DAT 404 reads as unavailable game data, not a raw stack message', () => {
    const err = new Error('Failed to fetch https://dats.playwebac.com/v1/raw/eol/client_portal.dat: 404');
    expect(patchFailureText(err)).toBe('Game data is unavailable right now (HTTP 404). Please try again later.');
    const side = new Error('Failed to fetch https://x/weenie-setups.json: 503');
    expect(patchFailureText(side)).toContain('HTTP 503');
  });

  it('a truncated download asks for a reload', () => {
    expect(patchFailureText(new Error('Truncated download: received 1024 of 926941184 bytes'))).toBe('The game data download was interrupted. Reload to try again.');
  });

  it('a network failure asks the player to check their connection', () => {
    expect(patchFailureText(new TypeError('Failed to fetch'))).toBe('Could not reach the game data server. Check your connection and reload.');
  });

  it('anything else keeps its message', () => {
    expect(patchFailureText(new Error('WebGL2 unavailable'))).toBe('Error: WebGL2 unavailable');
    expect(patchFailureText('weird')).toBe('Error: weird');
  });
});
