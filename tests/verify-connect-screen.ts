/**
 * AGENT.hosted-mcp-connector — Claude's connect page as a launcher screen
 * (launcher/ConnectScreen.ts): the pairing code while it waits, ALLOW / DENY
 * and the character scope once the game has sent the code, then back to
 * Claude's callback (and nowhere else). happy-dom with a fake LauncherKit and
 * a fake bridge, as verify-launcher-client drives the launcher.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { isClaudeCallback, type ConnectStatus } from '../packages/renderer/src/launcher/ConnectScreen';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'] as const;

describe('isClaudeCallback', () => {
  it('Claude\'s callbacks and loopback only', () => {
    expect(isClaudeCallback('https://claude.ai/api/mcp/auth_callback?code=x&state=y')).toBe(true);
    expect(isClaudeCallback('https://claude.com/api/mcp/auth_callback?code=x')).toBe(true);
    expect(isClaudeCallback('http://127.0.0.1:33418/callback?code=x')).toBe(true);
    expect(isClaudeCallback('https://claude.ai.evil.example/api/mcp/auth_callback')).toBe(false);
    expect(isClaudeCallback('https://evil.example/cb')).toBe(false);
    expect(isClaudeCallback('javascript:alert(1)')).toBe(false);
  });
});

describe('ConnectScreen (behavioral, fake kit and bridge)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    mod = await import('../packages/renderer/src/launcher/ConnectScreen');
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  function setup(statuses: ConnectStatus[], decision: { redirect?: string; error?: string } = { redirect: 'https://claude.ai/api/mcp/auth_callback?code=c&state=s' }) {
    const mount = domWindow.document.createElement('div');
    domWindow.document.body.replaceChildren(mount);
    const kit = {
      prepareScreen: () => { mount.replaceChildren(); return mount; },
      renderLayout: () => null, desc: () => null, texUrl: () => null,
      text: (text: string) => { const s = domWindow.document.createElement('span'); s.textContent = text; return s; },
      measure: (_r: string, t: string) => t.length * 6, textColor: () => null, lineHeight: () => 12, bindEditField: () => null,
      onlineColor: 'green', attachScale: () => {}, plate: () => domWindow.document.createElement('div'),
      message: () => {}, textEntry: () => {}, confirmExit: () => {}, openCredits: () => {}, justifyLabel: () => {}, tagElement: () => {},
    };
    const decided: Array<[boolean, boolean]> = [];
    const copied: string[] = [];
    let copyWorks = true;
    const navigated: string[] = [];
    let wake: (() => void) | null = null;
    let i = 0;
    const api = {
      status: async () => statuses[Math.min(i++, statuses.length - 1)],
      decide: async (_req: string, approve: boolean, only: boolean) => { decided.push([approve, only]); return decision; },
      navigate: (u: string) => navigated.push(u),
      copy: async (t: string) => { copied.push(t); return copyWorks; },
      // Each poll waits for the test to step it.
      sleep: () => new Promise<void>((r) => { wake = r; }),
    };
    const screen = new mod.ConnectScreen(kit, api, 'req123456789');
    const done = screen.run();
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const step = async () => { await flush(); const w = wake; wake = null; w?.(); await flush(); };
    const text = () => [...mount.querySelectorAll('.connect-line')].map((n: Element) => n.textContent).join(' ');
    const btn = (cls: string) => mount.querySelector(`.${cls}`) as HTMLButtonElement;
    return { screen, done, step, text, btn, decided, navigated, flush, copied, mount, failCopy: () => { copyWorks = false; } };
  }

  it('multiboxing: a second tab typing the same code joins before ALLOW; the page lists both and how to add another', async () => {
    const two = { state: 'paired' as const, client: 'Claude', code: 'HRCBN3', account: 'coldeve:enkarta', character: 'Enkarta', accounts: [{ account: 'coldeve:enkarta', character: 'Enkarta' }, { account: 'coldeve:enkartaalt', character: 'Alty' }] };
    const s = setup([
      { state: 'waiting', client: 'Claude', code: 'HRCBN3' },
      { state: 'paired', client: 'Claude', code: 'HRCBN3', account: 'coldeve:enkarta', character: 'Enkarta', accounts: [{ account: 'coldeve:enkarta', character: 'Enkarta' }] },
      two,
    ]);
    await s.flush();
    await s.step();
    expect(s.text()).toContain('Account: enkarta');
    await s.step(); // still polling while paired: the second tab shows up
    expect(s.text()).toContain('Accounts: enkarta (Enkarta), enkartaalt (Alty)');
    expect(s.text()).toContain('Claude may play only Enkarta, Alty.');
    expect(s.text()).toContain('Another account too? Type /automation pair HRC-BN3 in its tab.');
    s.btn('connect-allow').click();
    expect(await s.done).toBe('allowed');
    expect(s.decided).toEqual([[true, true]]);
  });

  it('waiting: the code to type in chat, the buttons off; then the account and character, ALLOW back to Claude, one character by default', async () => {
    const s = setup([
      { state: 'waiting', client: 'Claude', code: 'HRCBN3' },
      { state: 'waiting', client: 'Claude', code: 'HRCBN3' },
      { state: 'paired', client: 'Claude', account: '26d9ec3d-9fbf-4fda-95f9-8d87e005ae3a:enkarta', character: 'Enkarta' },
    ]);
    await s.flush();
    expect(s.text()).toContain('Connect Claude');
    expect(s.text()).toContain('/automation pair HRC-BN3');
    expect(s.text()).toContain('Waiting for the code from the game…');
    expect(s.btn('connect-allow').disabled).toBe(true);
    expect(s.btn('connect-scope').style.display).toBe('none');
    await s.step();
    await s.step();
    expect(s.text()).toContain('Let Claude play?');
    expect(s.text()).toContain('Account: enkarta');
    expect(s.text()).toContain('In the world now: Enkarta');
    expect(s.text()).toContain('Claude may play only Enkarta.');
    expect(s.btn('connect-allow').disabled).toBe(false);
    expect(s.btn('connect-scope').textContent).toBe('ONLY ONE');
    s.btn('connect-scope').click();
    expect(s.text()).toContain('Claude may play any character on this account.');
    expect(s.btn('connect-scope').textContent).toBe('ANY ONE');
    s.btn('connect-scope').click();
    s.btn('connect-allow').click();
    expect(await s.done).toBe('allowed');
    expect(s.decided).toEqual([[true, true]]);
    expect(s.navigated).toEqual(['https://claude.ai/api/mcp/auth_callback?code=c&state=s']);
  });

  it('DENY goes back to Claude with the refusal; no character in the world: no scope choice, any character', async () => {
    const s = setup([{ state: 'paired', client: 'Claude Code', account: 'local-eor:agentclaude', character: null }], { redirect: 'http://127.0.0.1:5000/cb?error=access_denied' });
    await s.flush();
    expect(s.btn('connect-scope').style.display).toBe('none');
    expect(s.text()).toContain('Claude may play any character on this account.');
    s.btn('connect-deny').click();
    expect(await s.done).toBe('denied');
    expect(s.decided).toEqual([[false, false]]);
    expect(s.navigated).toEqual(['http://127.0.0.1:5000/cb?error=access_denied']);
  });

  it('expired says so; a redirect that is not Claude\'s is never followed', async () => {
    const e = setup([{ state: 'expired' }]);
    expect(await e.done).toBe('expired');
    expect(e.text()).toContain('This pairing has expired');
    const bad = setup([{ state: 'paired', client: 'Claude', account: 'x:y', character: null }], { redirect: 'https://evil.example/steal' });
    await bad.flush();
    bad.btn('connect-allow').click();
    expect(await bad.done).toBe('error');
    expect(bad.navigated).toEqual([]);
    expect(bad.text()).toContain('the answer from the server was not a Claude address');
  });

  it('the command is selectable text, COPY copies it, and polling doesn\'t redraw it (a selection survives)', async () => {
    const s = setup([{ state: 'waiting', client: 'Claude', code: 'HRCBN3' }]);
    await s.flush();
    const sel = s.mount.querySelector('.connect-command-text') as HTMLElement;
    expect(sel.textContent).toBe('/automation pair HRC-BN3');
    expect(sel.style.userSelect).toBe('text');
    expect(sel.style.color).toBe('transparent');
    expect(s.btn('connect-copy').disabled).toBe(false);
    await s.step();
    await s.step();
    expect(s.mount.querySelector('.connect-command-text')).toBe(sel); // the same node: not redrawn
    s.btn('connect-copy').click();
    await s.flush();
    expect(s.copied).toEqual(['/automation pair HRC-BN3']);
    expect(s.text()).toContain('Copied. Paste it into the game\'s chat.');
    s.failCopy();
    s.btn('connect-copy').click();
    await s.flush();
    expect(s.text()).toContain('Copy didn\'t work here: select the command above and copy it.');
  });

  it('COPY goes once the code has been used (paired)', async () => {
    const s = setup([{ state: 'paired', client: 'Claude', account: 'x:y', character: null }]);
    await s.flush();
    expect(s.btn('connect-copy').style.display).toBe('none');
  });
});
