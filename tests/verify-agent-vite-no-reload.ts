/**
 * The agent daemon's dev server must leave its pages nothing that reloads them. 2026-10-18: closing the
 * Mac's lid (DarkWake, "Clamshell Sleep") made Chrome close every socket; the game's would have resumed,
 * but /@vite/client's closed too, pinged the server ("vite-ping"), got an answer and called
 * location.reload(), which broke both stream players' sessions four times. `hmr: false` alone still
 * answers that ping; the daemon's config and ACJS_VITE_NO_RELOAD turn Vite's WebSocket off.
 * Drives a real Vite dev server through the real config files.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, type ViteDevServer } from 'vite';
import WebSocket from 'ws';
import { AGENT_VITE_CONFIG_SOURCE, NO_RELOAD_ENV, noReloadServerOptions } from '../tools/lib/vite-no-reload';

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
  });
});
