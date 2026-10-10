/**
 * RELEASE.dat-streaming — run a one-shot build in a miss scope and, if it
 * read files that were not resident yet, run it again once they land
 * (retail's DBObj::Get blocks until the file is local, so its one-shot
 * builds never come out incomplete). For idempotent builds whose output a
 * second run fills in: the entered dungeon's collision, the sky objects of a
 * new day group. Bounded, so a file missing from the set can't loop; a run
 * nobody wants any more (`stillWanted` false) is dropped.
 */
import { FetchPriority, type FileKey } from './DatStore.js';

export interface RetryStore {
  scoped<T>(fn: () => T): { result: T; scope: { missed: boolean; keys: Iterable<FileKey> } };
  ensure(keys: Iterable<FileKey>, priority?: FetchPriority): Promise<void>;
}

/** The run count cap (first run included). */
export const MAX_ARRIVAL_RETRIES = 4;

export function runRetryingOnArrival(
  store: RetryStore | null | undefined,
  run: () => void,
  stillWanted: () => boolean = () => true,
  maxRuns = MAX_ARRIVAL_RETRIES,
): void {
  if (!store) { run(); return; }
  const attempt = (n: number): void => {
    const { scope } = store.scoped(run);
    if (!scope.missed || n + 1 >= maxRuns) return;
    store.ensure(scope.keys, FetchPriority.Critical).then(
      () => { if (stillWanted()) attempt(n + 1); },
      () => { /* failed fetch: keep what was built */ },
    );
  };
  attempt(0);
}
