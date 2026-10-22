/**
 * COMPAT.decompression-stream-gate — every streamed DAT object is gzip,
 * inflated with DecompressionStream (dat/streaming/DatStore.ts), which Safari
 * has only from 16.4 and Firefox from 113 (https://caniuse.com/mdn-api_decompressionstream).
 * Without it the boot failed somewhere inside the DAT download; the
 * capability screen now says so up front, as it does for WebGL 2.
 */
import { describe, it, expect } from 'vitest';
import { capabilityProblems, probeCapabilities, type CapabilityEnv } from '../packages/renderer/src/boot/Capability.js';

const ok: CapabilityEnv = { webgl2: true, websocket: true, deviceMemoryGb: null, finePointer: true };

describe('the capability screen gates on DecompressionStream', () => {
  it('missing (Safari 16.3, Firefox 112): a hard problem that names the update', () => {
    const p = capabilityProblems({ ...ok, decompressionStream: false });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ id: 'decompression', hard: true });
    expect(p[0].text).toContain('16.4');
  });

  it('present, or not probed: no problem', () => {
    expect(capabilityProblems({ ...ok, decompressionStream: true })).toEqual([]);
    expect(capabilityProblems(ok)).toEqual([]);
  });

  it('probeCapabilities reads the real global', () => {
    const fakeCanvas = { getContext: () => null, addEventListener: () => {}, removeEventListener: () => {} };
    const win = (withDs: boolean) => ({
      document: { createElement: () => fakeCanvas },
      location: { search: '' },
      navigator: { userAgent: 'x', webdriver: false },
      matchMedia: () => ({ matches: true }),
      WebSocket: function WebSocket() {},
      ...(withDs ? { DecompressionStream: function DecompressionStream() {} } : {}),
    }) as unknown as Window & typeof globalThis;
    expect(probeCapabilities(win(true)).decompressionStream).toBe(true);
    expect(probeCapabilities(win(false)).decompressionStream).toBe(false);
  });
});
