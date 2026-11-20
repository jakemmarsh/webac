/**
 * PERF.long-session-record-caps — the session-long record maps (kept object records, quiet
 * appraisals, stored-item stashes) are bounded: an hours-long macro session kills, loots,
 * appraises and sells thousands of objects, and each of those maps grew by one or more
 * entries per object with nothing taking them out.
 *
 * Retail's CObjectMaint drops a contained weenie when its container goes (and releases what
 * it has not seen for a while); these helpers give ours the same shape: an insertion-ordered
 * cap (a re-set refreshes the entry, so the oldest untouched entry goes first) and a cascade
 * that forgets everything a deleted container held, nested packs included.
 */

/**
 * Set `key` → `value` as the newest entry of `map`, then evict the oldest entries while the map
 * holds more than `cap`. An entry `pinned` says is still needed (an item the player carries) is
 * passed over. Returns the evicted keys (empty when nothing went).
 */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, cap: number, pinned?: (key: K) => boolean): K[] {
  map.delete(key);
  map.set(key, value);
  if (map.size <= cap) return [];
  const evicted: K[] = [];
  for (const k of map.keys()) {
    if (map.size <= cap) break;
    if (k === key || pinned?.(k)) continue;
    map.delete(k);
    evicted.push(k);
  }
  return evicted;
}

/**
 * Forget every record held, directly or through nested containers, by `containerGuid` (by each
 * record's `containerId`). A record `keep` says is still needed stays, and so do its contents.
 * Returns the forgotten guids.
 */
export function forgetContainedRecords(
  records: Map<number, { containerId?: number }>,
  containerGuid: number,
  keep?: (guid: number) => boolean,
): number[] {
  const forgotten: number[] = [];
  if ((containerGuid >>> 0) === 0) return forgotten;
  const containers = new Set<number>([containerGuid >>> 0]);
  let found = true;
  while (found) {
    found = false;
    for (const [guid, rec] of records) {
      if (!containers.has((rec.containerId ?? 0) >>> 0) || keep?.(guid)) continue;
      records.delete(guid);
      forgotten.push(guid);
      containers.add(guid >>> 0);
      found = true;
    }
  }
  return forgotten;
}
