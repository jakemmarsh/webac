/**
 * openDat — the one way tests open a DAT (2026-09-30 test-memory fix).
 *
 * `new DatDatabase(readFileSync(portal))` put the whole 926 MB portal.dat
 * (often twice, via `buf.buffer.slice`) in every test file's heap; with
 * vitest's default ~13 workers one suite run peaked at 21 GB and parallel
 * runs crashed the machine. openDat reads sectors on demand through
 * FileDatBytes and caches one DatDatabase per path per worker process, so a
 * DAT costs its directory map, shared by every test file in the worker.
 *
 * Inputs CI does not have still use the describe.skipIf + beforeAll pattern:
 * call openDat inside beforeAll, never at describe-callback top level.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../../packages/dat-parser/src/node/FileDatBytes.js';

const REPO = resolve(__dirname, '..', '..');

/** The end-of-retail DATs (dataPath: this checkout's, or ACJS_DAT_DIR's). */
export const DAT_PATHS = {
  portal: dataPath('dat/client_portal.dat'),
  cell: dataPath('dat/client_cell_1.dat'),
  highres: dataPath('dat/client_highres.dat'),
  local: dataPath('dat/client_local_English.dat'),
} as const;

/** The era DAT sets (`dat-sets/`: ac1999-retail, classic-dereth-1.1, …): this checkout's, or ACJS_DAT_SETS_DIR (dataPath). */
export const DAT_SETS_DIR = dataPath('dat-sets');

type Cache = Map<string, DatDatabase>;
const g = globalThis as unknown as { __acjsTestDats?: Cache };

/** A lazily-read DatDatabase for `path` (absolute, or relative to the repo root), cached per worker. */
export function openDat(path: string): DatDatabase {
  const abs = resolve(REPO, path);
  const cache = (g.__acjsTestDats ??= new Map());
  let db = cache.get(abs);
  if (!db) {
    db = new DatDatabase(new FileDatBytes(abs));
    cache.set(abs, db);
  }
  return db;
}

/**
 * A gitignored data path (`dat/…`, `dat-sets/…`) for a test: this checkout's own, or the directory an
 * explicit `ACJS_DAT_DIR` / `ACJS_DAT_SETS_DIR` names (a worktree with no DATs; nothing copied or linked).
 * Never discovered from the main checkout: tools/ci-local.sh's CI-shaped run is itself a git worktree and
 * must see no DATs, as CI does (a discovered fallback made it run DAT tests, 2026-11-01).
 */
export function dataPath(rel: string): string {
  const own = resolve(REPO, rel);
  if (existsSync(own)) return own;
  const top = rel.split('/')[0];
  const env = top === 'dat' ? process.env.ACJS_DAT_DIR : top === 'dat-sets' ? process.env.ACJS_DAT_SETS_DIR : undefined;
  if (env) return resolve(env, rel.slice(top.length + 1));
  return own;
}
