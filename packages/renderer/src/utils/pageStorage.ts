/**
 * COMPAT.storage-blocked-boot — the page's localStorage / sessionStorage,
 * never throwing.
 *
 * With site data blocked (Firefox "Block cookies" / dom.storage.enabled
 * false, Safari "Block all cookies", Chrome "Don't allow sites to save
 * data"), merely READING `window.localStorage` throws a SecurityError
 * (https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage#exceptions);
 * `typeof localStorage` throws too, since it runs the same getter. GameUI's
 * chat-history field initializer read it bare, so the GameUI constructor threw
 * and the game never booted; the login path's sessionStorage reads did the
 * same mid-connect. Here a blocked store becomes an in-memory one for the
 * page's lifetime: settings simply don't outlive the tab.
 */

/** A Storage held in memory (the stand-in when the browser refuses the real one). */
export class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string): void { this.map.delete(key); }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
}

const fallbacks: Partial<Record<'local' | 'session', MemoryStorage>> = {};

/** `globalThis.localStorage` / `sessionStorage`, or a per-page MemoryStorage when access throws or is missing. */
export function pageStorage(kind: 'local' | 'session', g: object = globalThis): Storage {
  try {
    const s = (g as { localStorage?: Storage; sessionStorage?: Storage })[kind === 'local' ? 'localStorage' : 'sessionStorage'];
    if (s) return s;
  } catch { /* SecurityError: site data blocked */ }
  return (fallbacks[kind] ??= new MemoryStorage());
}
