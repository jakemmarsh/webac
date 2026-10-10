/**
 * Wire-consumption probe (RECON.wire-full-consumption).
 *
 * Runs a real parser over a payload and reports how many bytes the furthest
 * BinaryReader over that payload left unread. Parsers construct their own
 * reader internally, so the probe instruments BinaryReader.prototype for the
 * duration of one call and records every reader that touched the payload.
 * A parser that stops early (skipped trailing tables, a missed pad) leaves
 * `remaining > 0`; one that over-reads throws or returns null.
 */
import { BinaryReader } from '@ac/network';

type ReaderInternals = { _data: Uint8Array; remaining: number };

export function probeConsumption<T>(payload: Uint8Array, parse: (p: Uint8Array) => T): { result: T; remaining: number | null } {
  const proto = BinaryReader.prototype as unknown as Record<string, unknown>;
  const touched = new Set<ReaderInternals>();
  const originals = new Map<string, (...a: unknown[]) => unknown>();
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor') continue;
    const desc = Object.getOwnPropertyDescriptor(proto, key);
    if (!desc || typeof desc.value !== 'function') continue;
    const fn = desc.value as (...a: unknown[]) => unknown;
    originals.set(key, fn);
    proto[key] = function (this: ReaderInternals, ...args: unknown[]) {
      touched.add(this);
      return fn.apply(this, args);
    };
  }
  try {
    const result = parse(payload);
    let remaining: number | null = null;
    for (const r of touched) {
      if (r._data !== payload) continue;
      remaining = remaining === null ? r.remaining : Math.min(remaining, r.remaining);
    }
    return { result, remaining };
  } finally {
    for (const [key, fn] of originals) proto[key] = fn;
  }
}
