/**
 * BUG.portal-space-barrel-roll-duration-wrong — the portal-space roll interval
 * is retail's RandDouble(0.6, 1.8) s (gmSmartBoxUI::UseTime @ 004d6e30,
 * teleportRotationDuration), not the old [0.4, 1.3) "faster eased roll".
 * Now driven through the real TeleportAnimation (PortalSpaceModel.ts).
 */
import { describe, it, expect } from 'vitest';
import { TeleportAnimation, TeleportAnimState } from '../packages/renderer/src/effects/PortalSpaceModel.js';

/** The time of each new roll segment for a given RNG. */
function segmentStarts(rand: () => number, until = 60): number[] {
  const a = new TeleportAnimation(rand);
  a.begin(TeleportAnimState.Tunnel, 0);
  const starts: number[] = [];
  for (let t = 0; t <= until; t += 0.001) if (a.update(t, 0).postNotice) starts.push(t);
  return starts;
}

describe('BUG.portal-space-barrel-roll-duration-wrong: the roll lasts RandDouble(0.6, 1.8)', () => {
  it('RNG 0 → 0.6 s segments, RNG 1 → 1.8 s, RNG 0.5 → 1.2 s', () => {
    for (const [r, d] of [[0, 0.6], [0.999999, 1.8], [0.5, 1.2]] as const) {
      const s = segmentStarts(() => r, 10);
      expect(s[2] - s[1]).toBeCloseTo(d, 2);
    }
  });
  it('with Math.random every segment lies in [0.6, 1.8] and some exceed the old 1.3 cap', () => {
    const s = segmentStarts(Math.random, 200);
    const d = s.slice(1).map((t, i) => t - s[i]);
    for (const x of d) { expect(x).toBeGreaterThanOrEqual(0.6 - 0.002); expect(x).toBeLessThanOrEqual(1.8 + 0.002); }
    expect(Math.max(...d)).toBeGreaterThan(1.3);
  });
});
