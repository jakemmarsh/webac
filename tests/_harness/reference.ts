/**
 * Guards for gitignored reference inputs (DEBT.test-harness-hygiene).
 *
 * CI (.github/workflows/ci.yml, "Clone ACE reference (pinned)") clones
 * reference/ACE — and ONLY reference/ACE: no DATs, no reference/client-eol,
 * no world DB. A test that skips or early-returns when reference/ACE is
 * missing therefore passes vacuously on CI if that clone ever breaks. Use
 * {@link aceReferenceExists} instead of a bare existsSync for reference/ACE
 * paths: locally (no CI env) it is a plain existence check so contributors
 * without the clone still get a clean skip; on CI a missing path THROWS so a
 * broken checkout fails loudly instead of turning parity suites green-by-skip.
 *
 * Inputs CI does NOT have (dat/, reference/client-eol, world-db-raw) keep the
 * documented describe.skipIf + beforeAll-load pattern (CLAUDE.md).
 */
import { existsSync } from 'node:fs';

/** True when running under CI (GitHub Actions sets CI=true). */
export const ON_CI = !!process.env.CI && process.env.CI !== 'false';

/**
 * existsSync for a reference/ACE path. Throws on CI when it is missing (CI
 * always clones reference/ACE); returns the plain existence result locally.
 */
export function aceReferenceExists(path: string): boolean {
  const ok = existsSync(path);
  if (!ok && ON_CI) {
    throw new Error(
      `reference/ACE input missing on CI: ${path}. ci.yml clones reference/ACE, so this is a broken `
      + 'checkout (or a stale path in the test) — failing instead of skipping the suite vacuously.',
    );
  }
  return ok;
}
