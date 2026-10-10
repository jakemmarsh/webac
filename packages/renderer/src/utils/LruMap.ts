/**
 * ASSESS: generic bounded LRU map — backstop for renderer caches that
 * previously grew without bound over long sessions (2026-06-10 fresh-eyes
 * audit §performance). Built on the insertion-order guarantee of ES Map:
 * refreshing recency = delete + re-set; the least recently used entry is
 * always the first key in iteration order.
 *
 * Semantics:
 *  - `get` refreshes recency; `has`/`peek` do not (Map-like reads).
 *  - `onEvict` fires ONLY for capacity evictions — explicit `delete`/`clear`
 *    leave resource disposal to the caller, which knows the teardown context.
 *  - capacity 0 = nothing is retained (every `set` immediately evicts).
 */
export class LruMap<K, V> {
  private map = new Map<K, V>();
  readonly capacity: number;
  private onEvict?: (key: K, value: V) => void;

  constructor(capacity: number, onEvict?: (key: K, value: V) => void) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError(`LruMap capacity must be a non-negative integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.onEvict = onEvict;
  }

  get size(): number {
    return this.map.size;
  }

  /** Read a value and mark it most recently used. */
  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  /** Read a value WITHOUT refreshing recency. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Insert/update a value as most recently used, evicting LRU entries over capacity. */
  set(key: K, value: V): this {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldestKey = this.map.keys().next().value as K;
      const oldestValue = this.map.get(oldestKey)!;
      this.map.delete(oldestKey);
      this.onEvict?.(oldestKey, oldestValue);
    }
    return this;
  }

  /** Remove a key. Does NOT fire onEvict — caller owns disposal on explicit removal. */
  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** Remove everything. Does NOT fire onEvict — caller owns disposal on teardown. */
  clear(): void {
    this.map.clear();
  }

  /** Keys in LRU order (least recently used first). */
  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  /** Values in LRU order (least recently used first). */
  values(): IterableIterator<V> {
    return this.map.values();
  }

  /** Entries in LRU order (least recently used first). */
  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}
