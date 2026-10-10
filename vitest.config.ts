import { configDefaults, defineConfig } from 'vitest/config';
import { cpus } from 'os';
import { resolve } from 'path';

/**
 * Memory budget (2026-09-30: eight concurrent full runs crashed a 36 GB Mac).
 * Measured on the M3 Max, full suite:
 *   default (~13 workers) 20.9 GB peak / 50 s; 4 workers 12.7 GB / 74 s;
 *   4 workers + 1.5 GB heap cap 9.6 GB / 78 s; 2 workers 8.2 GB / 148 s.
 * So: at most 4 workers (ACJS_TEST_WORKERS overrides), each worker's heap
 * capped at 1.5 GB (the heaviest file needs ~1 GB), and
 * tests/_harness/suite-guard.ts allows one run per machine at a time.
 */
const WORKERS = Number(process.env.ACJS_TEST_WORKERS) || Math.max(1, Math.min(4, cpus().length - 1));

export default defineConfig({
  resolve: {
    alias: {
      '@ac/shared': resolve(__dirname, 'packages/shared/src'),
      '@ac/dat-parser': resolve(__dirname, 'packages/dat-parser/src'),
      '@ac/renderer': resolve(__dirname, 'packages/renderer/src'),
      '@ac/network': resolve(__dirname, 'packages/network/src'),
    },
  },
  test: {
    testTimeout: 30000,
    // beforeAll hooks that import + construct the real GameUI under happy-dom
    // can exceed the 10 s default when the whole suite runs in parallel.
    hookTimeout: 60000,
    include: ['tests/**/*.ts', '**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    // tests/_harness/ holds shared helpers imported BY tests (e.g. the
    // happy-dom loader) — never collect them as test files.
    exclude: [...configDefaults.exclude, 'tests/_harness/**'],
    globalSetup: ['tests/_harness/suite-guard.ts'],
    maxWorkers: WORKERS,
    execArgv: ['--max-old-space-size=1536'],
  },
});
