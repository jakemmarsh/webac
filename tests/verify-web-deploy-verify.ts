/**
 * OPS.web-deploy-asset-check — a web deploy is checked by what players load, and rolls itself
 * back. 2026-11-04: a production deploy's new entry bundle answered HTTP 500 after ~47 s for
 * minutes while version.json and index.html looked fine (tools/lib/web-deploy-verify.mjs header).
 *
 * The module runs against a stub fetch; tools/web-cf-ship.sh runs for real against a local HTTP
 * server standing in for both hosts, with a stub `npx` (wrangler) first on PATH.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extractAssetPaths, verifyDeploy, liveVersionId, type FetchLike } from '../tools/lib/web-deploy-verify.mjs';

const ROOT = resolve(__dirname, '..');

// What a Vite build's index.html looks like (shape of the 2a2ccfb2d release).
const indexHtml = (tag: string) => `<!doctype html>
<html lang="en"><head>
  <meta charset="UTF-8" />
  <link rel="icon" href="/favicon.ico" />
  <script type="module" crossorigin src="/assets/index-${tag}.js"></script>
  <link rel="modulepreload" crossorigin href="/assets/three-${tag}.js">
  <link rel="modulepreload" crossorigin href="./assets/dat-${tag}.js">
  <link rel="stylesheet" crossorigin href="/assets/index-${tag}.css">
  <link rel="preconnect" href="https://dats.playwebac.com">
</head><body><div id="app"></div></body></html>`;

const SIZES: Record<string, number> = {
  '/assets/index-NEW.js': 4000, '/assets/three-NEW.js': 900, '/assets/dat-NEW.js': 300, '/assets/index-NEW.css': 120,
  '/assets/index-OLD.js': 3900, '/assets/three-OLD.js': 880, '/assets/dat-OLD.js': 290, '/assets/index-OLD.css': 110,
};

type Handler = (url: string, call: number) => { status: number; body: string | Uint8Array } | 'hang';

/** A fetch whose answer per URL is decided by `handler`; counts calls per URL. Honors abort. */
function stubFetch(handler: Handler): FetchLike & { calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const f = (async (url: string, init?: { signal?: AbortSignal }) => {
    const n = (calls.get(url) ?? 0) + 1;
    calls.set(url, n);
    const r = handler(url, n);
    if (r === 'hang') {
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    const bytes = typeof r.body === 'string' ? new TextEncoder().encode(r.body) : r.body;
    return { status: r.status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  }) as FetchLike & { calls: Map<string, number> };
  f.calls = calls;
  return f;
}

/** A healthy host serving build `build` with assets tagged `tag`, with per-path overrides. */
function healthy(build: string, tag: string, override: (path: string, call: number) => ReturnType<Handler> | null = () => null): Handler {
  return (url, call) => {
    const path = new URL(url).pathname;
    const o = override(path, call);
    if (o) return o;
    if (path === '/version.json') return { status: 200, body: JSON.stringify({ build, urgent: false }) };
    if (path === '/') return { status: 200, body: indexHtml(tag) };
    if (SIZES[path] != null) return { status: 200, body: new Uint8Array(SIZES[path]) };
    return { status: 404, body: 'not found' };
  };
}

/** A fake clock: sleep advances it, so a 60 s window runs instantly. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

const HOSTS = ['https://playwebac.com', 'https://next.playwebac.com'];
const localSize = (p: string) => SIZES[p] ?? null;

describe('extractAssetPaths', () => {
  it('finds the entry script first, then modulepreloads and stylesheets, normalised to /assets/…', () => {
    const { entry, assets } = extractAssetPaths(indexHtml('NEW'));
    expect(entry).toBe('/assets/index-NEW.js');
    expect(assets).toEqual(['/assets/index-NEW.js', '/assets/three-NEW.js', '/assets/dat-NEW.js', '/assets/index-NEW.css']);
  });
  it('ignores non-asset links and external scripts; no entry when there is no module script', () => {
    const html = '<link rel="icon" href="/favicon.ico"><script src="https://x.example/a.js"></script><link rel="stylesheet" href="/assets/a.css">';
    expect(extractAssetPaths(html)).toEqual({ entry: null, assets: ['/assets/a.css'] });
  });
  it('handles attribute order, single quotes and query strings', () => {
    const html = "<script src='/assets/main-1.js?v=2' type='module'></script>";
    expect(extractAssetPaths(html)).toEqual({ entry: '/assets/main-1.js', assets: ['/assets/main-1.js'] });
  });
});

describe('verifyDeploy', () => {
  it('passes when both hosts serve the build, its index and every asset at the release size', async () => {
    const clock = fakeClock();
    const f = stubFetch(healthy('NEWBUILD', 'NEW'));
    const r = await verifyDeploy({ hosts: HOSTS, expectBuild: 'NEWBUILD', expectIndex: indexHtml('NEW'), localSize, fetch: f, ...clock });
    expect(r.ok).toBe(true);
    expect(r.rounds).toBe(1);
    expect(r.passed).toHaveLength(8); // 4 assets × 2 hosts
    for (const h of HOSTS) for (const p of Object.keys(SIZES).filter((k) => k.includes('NEW'))) expect(f.calls.get(`${h}${p}`)).toBe(1);
  });

  it('retries an asset that answers 500 once, and passes when it recovers', async () => {
    const clock = fakeClock();
    const f = stubFetch(healthy('NEWBUILD', 'NEW', (p, call) => (p === '/assets/index-NEW.js' && call === 1 ? { status: 500, body: 'oops' } : null)));
    const lines: string[] = [];
    const r = await verifyDeploy({ hosts: HOSTS, expectBuild: 'NEWBUILD', localSize, fetch: f, ...clock, log: (l) => lines.push(l) });
    expect(r.ok).toBe(true);
    expect(r.rounds).toBe(2);
    expect(lines.some((l) => l.includes('/assets/index-NEW.js: HTTP 500'))).toBe(true);
    // Only the failing asset is fetched again.
    expect(f.calls.get('https://playwebac.com/assets/index-NEW.js')).toBe(2);
    expect(f.calls.get('https://playwebac.com/assets/three-NEW.js')).toBe(1);
  });

  it('fails after the window when an asset never recovers (the caller rolls back)', async () => {
    const clock = fakeClock();
    const f = stubFetch(healthy('NEWBUILD', 'NEW', (p) => (p === '/assets/index-NEW.js' ? { status: 500, body: '' } : null)));
    const r = await verifyDeploy({ hosts: HOSTS, expectBuild: 'NEWBUILD', localSize, fetch: f, ...clock, windowMs: 60_000, intervalMs: 10_000 });
    expect(r.ok).toBe(false);
    expect(r.rounds).toBe(7); // t = 0, 10 … 60 s
    expect(r.failures).toEqual(HOSTS.map((host) => ({ host, path: '/assets/index-NEW.js', reason: expect.stringMatching(/^HTTP 500/) })));
  });

  it('counts a request slower than the timeout as a failure (the 47 s 500 of 2026-11-04)', async () => {
    const f = stubFetch(healthy('NEWBUILD', 'NEW', (p) => (p === '/assets/index-NEW.js' ? 'hang' : null)));
    const r = await verifyDeploy({ hosts: [HOSTS[0]], expectBuild: 'NEWBUILD', localSize, fetch: f, windowMs: 0, timeoutMs: 30 });
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([{ host: HOSTS[0], path: '/assets/index-NEW.js', reason: 'timed out after 30 ms' }]);
  });

  it('fails on a size that differs from the release file', async () => {
    const clock = fakeClock();
    const f = stubFetch(healthy('NEWBUILD', 'NEW', (p) => (p === '/assets/three-NEW.js' ? { status: 200, body: new Uint8Array(17) } : null)));
    const r = await verifyDeploy({ hosts: [HOSTS[0]], expectBuild: 'NEWBUILD', localSize, fetch: f, ...clock, windowMs: 20_000 });
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([{ host: HOSTS[0], path: '/assets/three-NEW.js', reason: 'size 17, release has 900' }]);
  });

  it('fails when index.html references no entry bundle', async () => {
    const clock = fakeClock();
    const f = stubFetch(healthy('NEWBUILD', 'NEW', (p) => (p === '/' ? { status: 200, body: '<html><head><link rel="stylesheet" href="/assets/index-NEW.css"></head></html>' } : null)));
    const r = await verifyDeploy({ hosts: [HOSTS[0]], expectBuild: 'NEWBUILD', localSize, fetch: f, ...clock, windowMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([{ host: HOSTS[0], path: '/', reason: 'index.html references no /assets/*.js entry bundle' }]);
  });

  it('waits for version.json to show the new build, then checks the assets', async () => {
    const clock = fakeClock();
    const f = stubFetch((url, call) => healthy(new URL(url).pathname === '/version.json' && call < 3 ? 'OLDBUILD' : 'NEWBUILD', 'NEW')(url, call));
    const r = await verifyDeploy({ hosts: [HOSTS[0]], expectBuild: 'NEWBUILD', localSize, fetch: f, ...clock });
    expect(r.ok).toBe(true);
    expect(r.rounds).toBe(3);
  });

  it('fails when the host index.html is not the release\'s', async () => {
    const clock = fakeClock();
    const f = stubFetch(healthy('NEWBUILD', 'OLD'));
    const r = await verifyDeploy({ hosts: [HOSTS[0]], expectBuild: 'NEWBUILD', expectIndex: indexHtml('NEW'), localSize, fetch: f, ...clock, windowMs: 0 });
    expect(r.failures).toEqual([{ host: HOSTS[0], path: '/', reason: "index.html differs from the release's" }]);
  });
});

describe('liveVersionId', () => {
  it('reads the 100% version from `wrangler deployments status --json`', () => {
    const json = JSON.stringify({ id: 'd1', versions: [{ version_id: 'a', percentage: 10 }, { version_id: 'b', percentage: 90 }] });
    expect(liveVersionId(json)).toBe('b');
    expect(liveVersionId('not json')).toBeNull();
    expect(liveVersionId('{"versions":[]}')).toBeNull();
  });
});

// ---- tools/web-cf-ship.sh, for real, against a local server and a stub wrangler ----

describe('web-cf-ship.sh wiring (stub wrangler, local hosts)', () => {
  let dir: string, release: string, bin: string, state: string, wlog: string;
  let server: Server, port: number;
  let brokenNewEntry = false;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'webac-ship-test-'));
    release = join(dir, 'release');
    bin = join(dir, 'bin');
    state = join(dir, 'state');
    wlog = join(dir, 'wrangler.log');
    mkdirSync(join(release, 'assets'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(release, 'index.html'), indexHtml('NEW'));
    // The release carries the previous build's hashed assets too (build-web-release.mjs).
    for (const [p, n] of Object.entries(SIZES)) writeFileSync(join(release, p), new Uint8Array(n));
    // Stub npx: `npx --yes wrangler@4 <cmd> …`.
    writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash
echo "$*" >> "$STUB_WLOG"
shift 2
case "$1" in
  deployments) [ -n "$STUB_NO_STATUS" ] || echo '{"id":"dep-1","versions":[{"version_id":"prev-version-id","percentage":100}]}' ;;
  deploy) echo new > "$STUB_STATE"; echo "Uploaded 4 of 4 assets" ;;
  rollback) echo old > "$STUB_STATE" ;;
esac
`);
    chmodSync(join(bin, 'npx'), 0o755);
    server = createServer((req, res) => {
      const live = readFileSync(state, 'utf8').trim();
      const build = live === 'new' ? 'NEWBUILD' : 'OLDBUILD';
      const tag = live === 'new' ? 'NEW' : 'OLD';
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/assets/index-NEW.js' && brokenNewEntry) { res.writeHead(500).end(); return; }
      const r = healthy(build, tag)(`http://x${path}`, 1);
      if (r === 'hang') return;
      res.writeHead(r.status).end(Buffer.from(r.body));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((ok) => server.close(ok));
    rmSync(dir, { recursive: true, force: true });
  });

  const ship = (extra: string[] = [], env: Record<string, string> = {}) => {
    writeFileSync(state, 'old\n');
    if (existsSync(wlog)) rmSync(wlog);
    return new Promise<{ code: number; out: string; wrangler: string[] }>((done) => {
      const child = spawn('bash', [join(ROOT, 'tools/web-cf-ship.sh'), '--release', release, '--build', 'NEWBUILD', '--env', 'production', ...extra], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          STUB_WLOG: wlog,
          STUB_STATE: state,
          WEBAC_CF_HOSTS: `http://127.0.0.1:${port},http://localhost:${port}`,
          WEBAC_CF_VERIFY_WINDOW_MS: '400',
          WEBAC_CF_VERIFY_INTERVAL_MS: '100',
          WEBAC_CF_VERIFY_TIMEOUT_MS: '3000',
          ...env,
        },
      });
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (out += c));
      child.on('close', (code) => done({ code: code ?? -1, out, wrangler: existsSync(wlog) ? readFileSync(wlog, 'utf8').trim().split('\n') : [] }));
    });
  };

  it('a healthy deploy captures the rollback target, deploys, verifies both hosts and exits 0', async () => {
    brokenNewEntry = false;
    const r = await ship();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('rollback target: version prev-version-id (build OLDBUILD)');
    expect(r.out).toContain('build NEWBUILD verified');
    expect(r.wrangler.map((l) => l.split(' ')[2])).toEqual(['deployments', 'deploy']);
    expect(r.wrangler[1]).toContain(`--env production --assets ${release}`);
  }, 30_000);

  it('a deploy whose entry bundle keeps failing is rolled back to the captured version and checked', async () => {
    brokenNewEntry = true;
    const r = await ship();
    expect(r.code, r.out).toBe(1);
    expect(r.wrangler.map((l) => l.split(' ')[2])).toEqual(['deployments', 'deploy', 'rollback']);
    expect(r.wrangler[2]).toMatch(/^--yes wrangler@4 rollback prev-version-id .*--env production -y -m /);
    expect(r.out).toMatch(/FAILED .*\/assets\/index-NEW\.js: HTTP 500/);
    expect(r.out).toContain('ROLLED BACK');
    expect(readFileSync(state, 'utf8').trim()).toBe('old');
  }, 30_000);

  it('--no-rollback reports the failure and leaves the deploy live', async () => {
    brokenNewEntry = true;
    const r = await ship(['--no-rollback']);
    expect(r.code, r.out).toBe(1);
    expect(r.wrangler.map((l) => l.split(' ')[2])).toEqual(['deploy']);
    expect(r.out).toContain('STILL LIVE (--no-rollback)');
    expect(readFileSync(state, 'utf8').trim()).toBe('new');
  }, 30_000);

  it('refuses to deploy when the rollback target cannot be read', async () => {
    brokenNewEntry = false;
    const r = await ship([], { STUB_NO_STATUS: '1' });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("can't read the rollback target");
    expect(r.wrangler.map((l) => l.split(' ')[2])).toEqual(['deployments']);
    expect(readFileSync(state, 'utf8').trim()).toBe('old');
  }, 30_000);
});
