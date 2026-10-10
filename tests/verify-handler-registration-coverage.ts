/**
 * FAITHFUL.198 — Network handler registration coverage drift guard.
 *
 * Asserts that every non-Raw `on*` handler exposed by ServerMessageHandler
 * is actually registered in main.ts. Without this guard, the network
 * dispatcher fires handlers that have no listener — events vanish silently.
 *
 * Three earlier FAITHFUL passes closed real gaps via the same audit
 * (194, 195, 197) — this test pins the result so the same regression
 * can't return without a CI failure.
 *
 * `*Raw` handlers are deliberately unwired because we use the parsed
 * variants instead.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const HANDLER_SRC = readFileSync(
  resolve(REPO, 'packages/renderer/src/network/ServerMessageHandler.ts'),
  'utf-8',
);
const MAIN_SRC = readFileSync(
  resolve(REPO, 'packages/renderer/src/main.ts'),
  'utf-8',
);

describe('ServerMessageHandler registration coverage', () => {
  it('every non-Raw handler defined in ServerMessageHandler is registered in main.ts', () => {
    // Match handler-interface lines like "  onFoo?: HandlerFn<...>"
    const defined = new Set<string>();
    for (const m of HANDLER_SRC.matchAll(/^  (on[A-Z][a-zA-Z]+)\?:/gm)) {
      defined.add(m[1]);
    }
    expect(defined.size).toBeGreaterThan(100); // sanity: should be 150+

    const registered = new Set<string>();
    for (const m of MAIN_SRC.matchAll(/(on[A-Z][a-zA-Z]+):/g)) {
      registered.add(m[1]);
    }

    const missing: string[] = [];
    for (const name of defined) {
      // Skip Raw pre-parse variants intentionally; the parsed siblings are used.
      if (name.endsWith('Raw')) continue;
      if (!registered.has(name)) missing.push(name);
    }
    if (missing.length > 0) {
      throw new Error(
        `These ServerMessageHandler handlers are defined but never registered ` +
        `in main.ts (events vanish silently): ${missing.join(', ')}`,
      );
    }
  });

  it('the Raw allowlist exists for at least 5 handler families', () => {
    // Spot-check that the Raw pattern is real and we're not falsely passing.
    expect(HANDLER_SRC).toContain('onHouseProfileRaw?:');
    expect(HANDLER_SRC).toContain('onHouseDataRaw?:');
    expect(HANDLER_SRC).toContain('onHouseUpdateHARRaw?:');
    expect(HANDLER_SRC).toContain('onChessOpponentTurnRaw?:');
    expect(HANDLER_SRC).toContain('onAllegianceInfoResponseRaw?:');
  });
});
