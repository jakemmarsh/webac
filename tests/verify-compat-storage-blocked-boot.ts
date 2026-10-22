/**
 * COMPAT.storage-blocked-boot — with site data blocked (Firefox "Block
 * cookies" / dom.storage.enabled = false, Safari "Block all cookies", Chrome
 * "Don't allow sites to save data") reading `window.localStorage` itself
 * throws a SecurityError. GameUI's chat-history field initializer read it
 * bare, so constructing the GameUI threw and the game never booted. These
 * tests install throwing storage getters and drive the real pageStorage and
 * the real GameUI constructor in happy-dom.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow } from './_harness/dom.js';
import { pageStorage, MemoryStorage } from '../packages/renderer/src/utils/pageStorage.js';

function blockedGlobal(): object {
  const g = {};
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(g, name, { get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
  }
  return g;
}

describe('pageStorage', () => {
  it('blocked storage (the getter throws) is an in-memory Storage for the page, the same one each call', () => {
    const g = blockedGlobal();
    const a = pageStorage('local', g);
    expect(a).toBeInstanceOf(MemoryStorage);
    a.setItem('k', 'v');
    expect(pageStorage('local', g).getItem('k')).toBe('v');
    expect(pageStorage('session', g)).not.toBe(a);
    expect(pageStorage('session', g).getItem('k')).toBeNull();
  });

  it('the real Storage when the browser gives it', () => {
    const real = new MemoryStorage();
    expect(pageStorage('local', { localStorage: real })).toBe(real);
  });

  it('MemoryStorage behaves like Storage', () => {
    const s = new MemoryStorage();
    s.setItem('a', '1'); s.setItem('b', '2');
    expect(s.length).toBe(2);
    expect(s.key(1)).toBe('b');
    s.removeItem('a');
    expect(s.getItem('a')).toBeNull();
    s.clear();
    expect(s.length).toBe(0);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

describe('the GameUI boots with site data blocked', () => {
  const DOM_GLOBALS = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
  const g = globalThis as Record<string, unknown>;
  const saved: Record<string, PropertyDescriptor | undefined> = {};

  beforeAll(() => {
    for (const key of [...DOM_GLOBALS, 'localStorage', 'sessionStorage']) saved[key] = Object.getOwnPropertyDescriptor(g, key);
    for (const key of DOM_GLOBALS) g[key] = key === 'window' ? domWindow : domWindow[key];
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(g, name, { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
    }
  });
  afterAll(() => {
    for (const [key, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(g, key, d); else delete g[key];
    }
  });

  it('new GameUI() does not throw, and chat history still records in memory', async () => {
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ui: any;
    expect(() => { ui = new mod.GameUI(container); }).not.toThrow();
    expect(() => ui.pushChatHistory('hello')).not.toThrow();
    expect(pageStorage('local')).toBeInstanceOf(MemoryStorage);
  });
});
