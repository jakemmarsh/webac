/**
 * ASSESS: direct unit tests for the LruMap utility backing the renderer's
 * bounded caches (fresh-eyes audit 2026-06-10 §performance — unbounded
 * caches leaked over long sessions). Exercises the real shipped class.
 */
import { describe, it, expect } from 'vitest';
import { LruMap } from '@ac/renderer/utils/LruMap.js';

describe('LruMap — basic Map semantics', () => {
  it('stores and retrieves values', () => {
    const m = new LruMap<string, number>(4);
    m.set('a', 1).set('b', 2);
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe(2);
    expect(m.get('missing')).toBeUndefined();
    expect(m.size).toBe(2);
  });

  it('has() and peek() report without mutating', () => {
    const m = new LruMap<string, number>(2);
    m.set('a', 1).set('b', 2);
    expect(m.has('a')).toBe(true);
    expect(m.peek('a')).toBe(1);
    expect(m.has('zzz')).toBe(false);
    expect(m.peek('zzz')).toBeUndefined();
  });

  it('set() on an existing key updates the value without growing', () => {
    const m = new LruMap<string, number>(2);
    m.set('a', 1).set('a', 99);
    expect(m.size).toBe(1);
    expect(m.get('a')).toBe(99);
  });

  it('delete() removes and reports presence', () => {
    const m = new LruMap<string, number>(2);
    m.set('a', 1);
    expect(m.delete('a')).toBe(true);
    expect(m.delete('a')).toBe(false);
    expect(m.size).toBe(0);
  });

  it('clear() empties the map', () => {
    const m = new LruMap<string, number>(4);
    m.set('a', 1).set('b', 2);
    m.clear();
    expect(m.size).toBe(0);
    expect(m.has('a')).toBe(false);
  });

  it('rejects negative and non-integer capacities', () => {
    expect(() => new LruMap(-1)).toThrow(RangeError);
    expect(() => new LruMap(1.5)).toThrow(RangeError);
    expect(() => new LruMap(NaN)).toThrow(RangeError);
  });
});

describe('LruMap — eviction order', () => {
  it('evicts the least recently inserted entry when over capacity', () => {
    const m = new LruMap<string, number>(3);
    m.set('a', 1).set('b', 2).set('c', 3).set('d', 4);
    expect(m.size).toBe(3);
    expect(m.has('a')).toBe(false); // oldest evicted
    expect(m.has('b')).toBe(true);
    expect(m.has('c')).toBe(true);
    expect(m.has('d')).toBe(true);
  });

  it('get() refreshes recency, protecting the entry from eviction', () => {
    const m = new LruMap<string, number>(3);
    m.set('a', 1).set('b', 2).set('c', 3);
    m.get('a'); // now b is LRU
    m.set('d', 4);
    expect(m.has('a')).toBe(true);
    expect(m.has('b')).toBe(false);
  });

  it('peek() and has() do NOT refresh recency', () => {
    const m = new LruMap<string, number>(3);
    m.set('a', 1).set('b', 2).set('c', 3);
    m.peek('a');
    m.has('a');
    m.set('d', 4);
    expect(m.has('a')).toBe(false); // still LRU → evicted
  });

  it('set() on an existing key refreshes recency', () => {
    const m = new LruMap<string, number>(3);
    m.set('a', 1).set('b', 2).set('c', 3);
    m.set('a', 10); // refresh
    m.set('d', 4);
    expect(m.has('a')).toBe(true);
    expect(m.has('b')).toBe(false);
  });

  it('iterates in LRU→MRU order', () => {
    const m = new LruMap<string, number>(3);
    m.set('a', 1).set('b', 2).set('c', 3);
    m.get('a');
    expect([...m.keys()]).toEqual(['b', 'c', 'a']);
    expect([...m.values()]).toEqual([2, 3, 1]);
    expect([...m]).toEqual([['b', 2], ['c', 3], ['a', 1]]);
  });
});

describe('LruMap — onEvict callback', () => {
  it('fires with the evicted key and value, in eviction order', () => {
    const evicted: Array<[string, number]> = [];
    const m = new LruMap<string, number>(2, (k, v) => evicted.push([k, v]));
    m.set('a', 1).set('b', 2).set('c', 3).set('d', 4);
    expect(evicted).toEqual([['a', 1], ['b', 2]]);
  });

  it('does NOT fire for explicit delete() or clear()', () => {
    const evicted: string[] = [];
    const m = new LruMap<string, number>(2, (k) => evicted.push(k));
    m.set('a', 1).set('b', 2);
    m.delete('a');
    m.clear();
    expect(evicted).toEqual([]);
  });

  it('does NOT fire when an existing key is overwritten at capacity', () => {
    const evicted: string[] = [];
    const m = new LruMap<string, number>(2, (k) => evicted.push(k));
    m.set('a', 1).set('b', 2);
    m.set('b', 22); // overwrite, no eviction
    expect(evicted).toEqual([]);
    expect(m.size).toBe(2);
  });
});

describe('LruMap — capacity edge cases', () => {
  it('capacity 0 retains nothing and evicts every set immediately', () => {
    const evicted: Array<[string, number]> = [];
    const m = new LruMap<string, number>(0, (k, v) => evicted.push([k, v]));
    m.set('a', 1);
    expect(m.size).toBe(0);
    expect(m.has('a')).toBe(false);
    expect(m.get('a')).toBeUndefined();
    expect(evicted).toEqual([['a', 1]]);
  });

  it('capacity 1 keeps only the most recent entry', () => {
    const evicted: string[] = [];
    const m = new LruMap<string, number>(1, (k) => evicted.push(k));
    m.set('a', 1);
    expect(m.size).toBe(1);
    m.set('b', 2);
    expect(m.size).toBe(1);
    expect(m.has('a')).toBe(false);
    expect(m.get('b')).toBe(2);
    expect(evicted).toEqual(['a']);
    // get + overwrite still work at capacity 1
    m.set('b', 20);
    expect(m.get('b')).toBe(20);
    expect(evicted).toEqual(['a']);
  });
});
