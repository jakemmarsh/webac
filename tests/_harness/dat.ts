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
import { resolve } from 'node:path';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../../packages/dat-parser/src/node/FileDatBytes.js';

const REPO = resolve(__dirname, '..', '..');

export const DAT_PATHS = {
  portal: resolve(REPO, 'dat/client_portal.dat'),
  cell: resolve(REPO, 'dat/client_cell_1.dat'),
  highres: resolve(REPO, 'dat/client_highres.dat'),
  local: resolve(REPO, 'dat/client_local_English.dat'),
} as const;

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
