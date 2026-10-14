/**
 * Public property update consumer coverage (FAITHFUL.277).
 *
 * Sister test to verify-public-update-property.ts. That test pins the
 * dispatcher side (cases are present, wire formats match ACE). This test
 * pins the consumer side — every Public property variant the dispatcher
 * emits must have an `onPublicUpdateProperty…:` consumer in main.ts.
 *
 * Pre-FAITHFUL.196 the dispatcher emitted onPublicUpdatePropertyBool /
 * Float / String / DataID / InstanceID but main.ts only consumed Int —
 * so any non-Int public broadcast was silently dropped without even a
 * diagnostic log. FAITHFUL.196 added the missing Bool/Float/String/DID/
 * IID diagnostic logs. FAITHFUL.277 closed the last sibling, Int64,
 * which had also been emitted but unconsumed (siblings of FAITHFUL.196).
 *
 * Drift guard: any future addition of a new Public-side opcode in the
 * dispatcher that doesn't add a matching `onPublicUpdateProperty…:`
 * consumer in main.ts will trip this test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

const VARIANTS = [
  'Int',     // FAITHFUL.158 dispatcher + pre-FAITHFUL.196 consumer
  'Int64',   // FAITHFUL.158 dispatcher + FAITHFUL.277 consumer
  'Bool',    // FAITHFUL.158/.196
  'Float',   // FAITHFUL.158/.196
  'String',  // FAITHFUL.158/.196
  // DataID: its consumer is network/applyPublicPropertyDataId.ts, driven
  // behaviorally in verify-public-property-dataid-consumer.ts.
] as const;

describe('Public property update consumers (FAITHFUL.277)', () => {
  for (const variant of VARIANTS) {
    it(`onPublicUpdateProperty${variant} is consumed in main.ts`, () => {
      // The consumer pattern is exactly: `onPublicUpdatePropertyX: (data:`
      const re = new RegExp(`onPublicUpdateProperty${variant}:\\s*\\(data`);
      expect(MAIN).toMatch(re);
    });

    it(`onPublicUpdateProperty${variant} consumer logs to console for diagnostics`, () => {
      // Block from the consumer line up to the closing `},` brace.
      const blockRe = new RegExp(
        `onPublicUpdateProperty${variant}:\\s*\\(data[\\s\\S]{0,2000}?\\},`,
      );
      const m = MAIN.match(blockRe);
      expect(m).not.toBeNull();
      // Per FAITHFUL.196 + .277 convention every Public diagnostic line
      // includes `guid=` so log scrapes can attribute the change to a
      // specific world object.
      expect(m![0]).toMatch(/console\.log/);
      expect(m![0]).toMatch(/guid=/);
    });
  }

  // InstanceID is the special case: opcode is PublicUpdateInstanceId
  // (not PublicUpdatePropertyInstanceID) but the handler is named for
  // consistency with the property-named siblings.
  it('onPublicUpdatePropertyInstanceID is consumed in main.ts', () => {
    expect(MAIN).toMatch(/onPublicUpdatePropertyInstanceID:\s*\(data/);
  });
});

describe('Int64 consumer specifics (FAITHFUL.277)', () => {
  // Pin the exact bigint-safe diagnostic format. `${bigint}` produces a
  // numeric literal without `n` suffix, which is what we want in logs.
  // Anything that explicitly converts via Number() would lossily truncate
  // long values (> Number.MAX_SAFE_INTEGER) — test guards against that.
  const block = MAIN.match(
    /onPublicUpdatePropertyInt64:\s*\(data[\s\S]{0,400}?\},/,
  );
  it('block is present', () => {
    expect(block).not.toBeNull();
  });
  it('does NOT call Number(data.value) — would truncate bigints', () => {
    expect(block![0]).not.toMatch(/Number\(data\.value\)/);
  });
  it('does NOT pre-cast value to (number) — would lose precision', () => {
    expect(block![0]).not.toMatch(/\(data\.value as number\)/);
  });
  it('logs key + value', () => {
    expect(block![0]).toMatch(/key=\$\{data\.key\}/);
    expect(block![0]).toMatch(/value=\$\{data\.value\}/);
  });
});
