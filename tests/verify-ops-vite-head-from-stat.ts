/**
 * OPS.vite-head-dat-stall: the dev server answers HEAD for a public-dir file
 * (the DATs) from stat. Stock Vite (sirv) piped the whole file into a HEAD
 * response: 2.2 s for the 926 MB portal DAT, with the server answering
 * nothing else meanwhile. Drives a real Vite dev server.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, type ViteDevServer } from 'vite';
import {
  headFromStatPlugin, headFromStatMiddleware, resolvePublicFile,
} from '../tools/lib/vite-head-from-stat';

let tmp: string;
let pub: string;
const DAT = 'client_test.dat';
const DAT_SIZE = 64 * 1024;

async function startVite(withPlugin: boolean): Promise<{ server: ViteDevServer; base: string }> {
  const server = await createServer({
    configFile: false,
    root: tmp,
    publicDir: pub,
    logLevel: 'silent',
    plugins: withPlugin ? [headFromStatPlugin()] : [],
    server: { port: 0, host: '127.0.0.1', headers: { 'X-Acjs-Dev': 'yes' }, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  const { port } = server.httpServer!.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

const pick = (h: Headers) => Object.fromEntries(
  ['content-length', 'content-type', 'last-modified', 'etag', 'cache-control', 'vary', 'x-acjs-dev']
    .map((k) => [k, h.get(k)]),
);

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'acjs-head-'));
  pub = join(tmp, 'pub');
  mkdirSync(pub);
  mkdirSync(join(pub, 'sub'));
  writeFileSync(join(tmp, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(pub, DAT), Buffer.alloc(DAT_SIZE, 7));
  utimesSync(join(pub, DAT), new Date('2019-07-17T12:32:48Z'), new Date('2019-07-17T12:32:48Z'));
  writeFileSync(join(pub, 'meta.json'), '{"a":1}');
  writeFileSync(join(tmp, 'secret.dat'), 'outside');
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const realCreateReadStream = fs.createReadStream;
afterEach(() => {
  vi.restoreAllMocks();
  fs.createReadStream = realCreateReadStream;
  syncBuiltinESMExports();
});

/** Paths fs.createReadStream opened, as Vite's `import * as fs from 'node:fs'` sees it. */
function recordReadStreams(): string[] {
  const opened: string[] = [];
  fs.createReadStream = ((...args: Parameters<typeof fs.createReadStream>) => {
    opened.push(String(args[0]));
    return realCreateReadStream(...args);
  }) as typeof fs.createReadStream;
  syncBuiltinESMExports();
  return opened;
}

describe('dev server HEAD for a public file (real Vite)', () => {
  it('answers from stat: no read stream is opened for the file', async () => {
    const { server, base } = await startVite(true);
    try {
      const opened = recordReadStreams();
      const r = await fetch(`${base}/${DAT}`, { method: 'HEAD' });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-length')).toBe(String(DAT_SIZE));
      expect(opened.filter((p) => p.endsWith(DAT))).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('stock Vite reads the whole file for the same HEAD (the stall this removes)', async () => {
    const { server, base } = await startVite(false);
    try {
      const opened = recordReadStreams();
      const r = await fetch(`${base}/${DAT}`, { method: 'HEAD' });
      expect(r.status).toBe(200);
      expect(opened.filter((p) => p.endsWith(DAT)).length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it('sends the same headers stock sirv sends (incl. CORS Vary and server.headers)', async () => {
    const stock = await startVite(false);
    let stockHead: Record<string, string | null>;
    let stockJson: Record<string, string | null>;
    try {
      stockHead = pick((await fetch(`${stock.base}/${DAT}`, { method: 'HEAD' })).headers);
      stockJson = pick((await fetch(`${stock.base}/meta.json`, { method: 'HEAD' })).headers);
    } finally {
      await stock.server.close();
    }
    const ours = await startVite(true);
    try {
      const head = pick((await fetch(`${ours.base}/${DAT}`, { method: 'HEAD' })).headers);
      expect(head).toEqual(stockHead);
      expect(head['etag']).toBe(`W/"${DAT_SIZE}-${Date.parse('2019-07-17T12:32:48Z')}"`);
      expect(head['vary']).toBe('Origin');
      expect(head['x-acjs-dev']).toBe('yes');
      expect(pick((await fetch(`${ours.base}/meta.json`, { method: 'HEAD' })).headers)).toEqual(stockJson);
    } finally {
      await ours.server.close();
    }
  });

  it('a matching If-None-Match is a 304; GET and Range GET still stream the bytes', async () => {
    const { server, base } = await startVite(true);
    try {
      const etag = (await fetch(`${base}/${DAT}`, { method: 'HEAD' })).headers.get('etag')!;
      const nm = await fetch(`${base}/${DAT}`, { method: 'HEAD', headers: { 'If-None-Match': etag } });
      expect(nm.status).toBe(304);
      const get = await fetch(`${base}/${DAT}`);
      expect((await get.arrayBuffer()).byteLength).toBe(DAT_SIZE);
      const range = await fetch(`${base}/${DAT}`, { headers: { Range: 'bytes=10-13' } });
      expect(range.status).toBe(206);
      expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([7, 7, 7, 7]);
    } finally {
      await server.close();
    }
  });
});

describe('resolvePublicFile / middleware edges', () => {
  it('serves only plain files inside the public dir', () => {
    expect(resolvePublicFile(pub, `/${DAT}`)?.stats.size).toBe(DAT_SIZE);
    expect(resolvePublicFile(pub, `/${DAT}?import`)).toBeNull();
    expect(resolvePublicFile(pub, '/@vite/client')).toBeNull();
    expect(resolvePublicFile(pub, '/../secret.dat')).toBeNull();
    expect(resolvePublicFile(pub, '/%2e%2e/secret.dat')).toBeNull();
    expect(resolvePublicFile(pub, '/sub')).toBeNull();
    expect(resolvePublicFile(pub, '/missing.dat')).toBeNull();
    expect(resolvePublicFile(pub, undefined)).toBeNull();
  });

  it('passes non-HEAD and unknown paths to the next middleware', () => {
    const mw = headFromStatMiddleware(pub);
    const next = vi.fn();
    const res = { writeHead: vi.fn(), end: vi.fn() };
    mw({ method: 'GET', url: `/${DAT}`, headers: {} } as never, res as never, next);
    mw({ method: 'HEAD', url: '/missing.dat', headers: {} } as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(res.writeHead).not.toHaveBeenCalled();
  });
});
