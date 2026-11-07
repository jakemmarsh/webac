/**
 * The agent daemon's dev server must leave its pages nothing that reloads them. 2026-10-18: closing the
 * Mac's lid (DarkWake, "Clamshell Sleep") made Chrome close every socket; the game's would have resumed,
 * but /@vite/client's closed too, pinged the server ("vite-ping"), got an answer and called
 * location.reload(), which broke both stream players' sessions four times. `hmr: false` alone still
 * answers that ping; the daemon's config and ACJS_VITE_NO_RELOAD turn Vite's WebSocket off.
 * Drives a real Vite dev server through the real config files.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import WebSocket from 'ws';
import {
  AGENT_VITE_CONFIG_SOURCE, NO_RELOAD_CLIENT_SOURCE, NO_RELOAD_ENV, isViteClientRequest, noReloadClientPlugin, noReloadServerOptions,
} from '../tools/lib/vite-no-reload';

let tmp: string;
let server: ViteDevServer | null = null;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'acjs-vite-noreload-'));
  writeFileSync(join(tmp, 'index.html'), '<!doctype html><title>t</title>');
  // Stands in for a snapshot's vite.config.ts: a function config, as the repo's is.
  writeFileSync(join(tmp, 'vite.config.ts'),
    `export default () => ({ root: ${JSON.stringify(tmp)}, logLevel: 'silent', publicDir: false,\n` +
    `  server: { host: '127.0.0.1', port: 0, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });\n`);
  writeFileSync(join(tmp, 'vite.hmr-off-only.mjs'),
    "import base from './vite.config.ts';\nexport default async (env) => { const c = await base(env); return { ...c, server: { ...c.server, hmr: false } }; };\n");
  writeFileSync(join(tmp, 'vite.agent.config.mjs'), AGENT_VITE_CONFIG_SOURCE);
});
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });
afterEach(async () => { await server?.close(); server = null; });

async function start(configFile: string): Promise<number> {
  server = await createServer({ configFile: join(tmp, configFile), root: tmp });
  await server.listen();
  return (server.httpServer!.address() as AddressInfo).port;
}

/** What /@vite/client's waitForSuccessfulPing does before location.reload(): true when the ping opens. */
function vitePingOpens(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, 'vite-ping');
    const done = (v: boolean) => { clearTimeout(t); ws.removeAllListeners(); ws.on('error', () => {}); ws.terminate(); resolve(v); };
    const t = setTimeout(() => done(false), 3000);
    ws.on('open', () => done(true));
    ws.on('error', () => done(false));
    ws.on('close', () => done(false));
  });
}

describe('agent dev server: nothing in the page reloads it', () => {
  it('hmr: false alone still answers the ping that reloads a page (the 2026-10-18 shape)', async () => {
    expect(await vitePingOpens(await start('vite.hmr-off-only.mjs'))).toBe(true);
  });

  it("the daemon's vite.agent.config.mjs answers no ping, and still serves the page", async () => {
    const port = await start('vite.agent.config.mjs');
    expect(server!.config.server.hmr).toBe(false);
    expect(server!.config.server.ws).toBe(false);
    expect(await vitePingOpens(port)).toBe(false);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.ok).toBe(true);
    expect(await res.text()).toContain('<title>t</title>');
  });

  it('ACJS_VITE_NO_RELOAD=1 gives vite.config.ts the same options; unset leaves HMR on', () => {
    expect(noReloadServerOptions({ [NO_RELOAD_ENV]: '1' })).toEqual({ hmr: false, ws: false });
    expect(noReloadServerOptions({})).toEqual({});
    expect(noReloadServerOptions({ [NO_RELOAD_ENV]: '0' })).toEqual({});
    expect(noReloadClientPlugin({})).toBeNull();
    expect(noReloadClientPlugin({ [NO_RELOAD_ENV]: '1' })?.name).toBe('acjs-no-reload-client');
  });
});

// The live gate's first full run (2026-11-07): with `ws: false` Vite still served the real /@vite/client,
// which opened ws://…/?token=… and logged "Unexpected response code: 200" twice per load; the play-through
// counts console errors, so every era's enter-world failed. A no-reload server now serves an inert client.
describe('no-reload dev server: /@vite/client opens no socket', () => {
  const clientOf = async (port: number) => (await fetch(`http://127.0.0.1:${port}/@vite/client`)).text();

  it("the daemon's config serves the stand-in, with no WebSocket in it", async () => {
    const port = await start('vite.agent.config.mjs');
    const js = await clientOf(port);
    expect(js).toContain('acjs no-reload /@vite/client stand-in');
    expect(js).not.toMatch(/WebSocket|location\.reload/);
  });

  it('vite.config.ts\'s plugin (ACJS_VITE_NO_RELOAD=1) serves it too, query string or not; without it the real client', async () => {
    server = await createServer({
      configFile: false, root: tmp, logLevel: 'silent', publicDir: false, optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [noReloadClientPlugin({ [NO_RELOAD_ENV]: '1' }) as Plugin],
      server: { host: '127.0.0.1', port: 0, watch: null, ...noReloadServerOptions({ [NO_RELOAD_ENV]: '1' }) },
    });
    await server.listen();
    const port = (server.httpServer!.address() as AddressInfo).port;
    expect(await clientOf(port)).toBe(NO_RELOAD_CLIENT_SOURCE);
    expect(await (await fetch(`http://127.0.0.1:${port}/@vite/client?t=1`)).text()).toBe(NO_RELOAD_CLIENT_SOURCE);
    expect(isViteClientRequest('/@vite/clientx')).toBe(false);
    await server.close();
    server = await createServer({ configFile: join(tmp, 'vite.config.ts'), root: tmp });
    await server.listen();
    expect(await clientOf((server.httpServer!.address() as AddressInfo).port)).toMatch(/new WebSocket/);
  });

  it('exports everything the real client exports (dev modules import them)', () => {
    const real = readFileSync(join(__dirname, '..', 'node_modules/vite/dist/client/client.mjs'), 'utf8');
    const names = (/export \{([^}]*)\}/.exec(real)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    expect(names.length).toBeGreaterThan(3);
    for (const n of names) expect(NO_RELOAD_CLIENT_SOURCE, n).toMatch(new RegExp(`export (function|class) ${n}\\b`));
  });

  it('the stand-in applies and removes CSS as Vite does; hot contexts are inert; injectQuery matches Vite', async () => {
    interface FakeEl { attrs: Record<string, string>; textContent: string; setAttribute(k: string, v: string): void; insertAdjacentElement(w: string, e: FakeEl): void }
    const head: FakeEl[] = [];
    const mk = (): FakeEl => {
      const el: FakeEl = {
        attrs: {} as Record<string, string>, textContent: '',
        setAttribute(k: string, v: string) { el.attrs[k] = v; },
        insertAdjacentElement(_w: string, e: typeof el) { head.splice(head.indexOf(el) + 1, 0, e); },
      };
      return el;
    };
    const g = globalThis as Record<string, unknown>;
    const prev = g.document;
    g.document = { createElement: mk, head: { appendChild: (e: never) => head.push(e), removeChild: (e: never) => head.splice(head.indexOf(e), 1) } };
    try {
      const mod = await import(`data:text/javascript,${encodeURIComponent(NO_RELOAD_CLIENT_SOURCE)}`);
      mod.updateStyle('/a.css', 'a{}');
      mod.updateStyle('/b.css', 'b{}');
      expect(head.map((s) => [s.attrs['data-vite-dev-id'], s.textContent])).toEqual([['/a.css', 'a{}'], ['/b.css', 'b{}']]);
      mod.updateStyle('/a.css', 'a{color:red}');
      expect(head[0].textContent).toBe('a{color:red}');
      mod.removeStyle('/a.css');
      expect(head.map((s) => s.attrs['data-vite-dev-id'])).toEqual(['/b.css']);
      const hot = mod.createHotContext('/x.ts');
      expect(() => { hot.accept(); hot.dispose(() => {}); hot.on('x', () => {}); hot.invalidate(); }).not.toThrow();
      expect(mod.injectQuery('/a.ts?x=1#h', 'import')).toBe('/a.ts?import&x=1#h');
      expect(mod.injectQuery('https://e/a.ts', 'import')).toBe('https://e/a.ts');
    } finally { g.document = prev; }
  });
});
