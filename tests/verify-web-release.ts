/**
 * SITE.web-off-host — the static web release for Cloudflare Workers Static Assets
 * (tools/lib/web-release.mjs, tools/build-web-release.mjs) reproduces what the web container's
 * Caddy served: the same config.json, the CSP entrypoint.sh derives (origins listed once), Caddy's
 * security headers and per-path cache rules, its 308 for a directory without its slash, and no
 * implicit redirects. The assembler carries earlier releases' hashed chunks and keeps sourcemaps out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
// @ts-expect-error -- a plain .mjs tool without type declarations
import { buildConfig, buildCsp, buildHeadersFile, buildRedirectsFile, buildVersion, validEraMap, originOf, htmlPaths } from '../tools/lib/web-release.mjs';

const ROOT = resolve(__dirname, '..');
const prod = JSON.parse(readFileSync(resolve(ROOT, 'deploy/web/env/production.json'), 'utf8'));

describe('config.json and version.json', () => {
  it('config.json has entrypoint.sh\'s keys in its order, with the site links on', () => {
    const c = buildConfig(prod);
    expect(Object.keys(c)).toEqual(['assetBase', 'bridgeUrl', 'datSet', 'sourceUrl', 'siteLinks', 'eraAssetBases', 'eraDatSets']);
    expect(c.bridgeUrl).toBe('wss://bridge.playwebac.com');
    expect(c.datSet).toEqual({ manifestUrl: prod.datSetUrl });
    expect(c.siteLinks).toBe(true);
    expect(Object.keys(c.eraDatSets)).toContain('ac1999-retail');
  });

  it('an era map that is not a flat id → http(s) URL object becomes {}, as entrypoint.sh\'s ERA_PAIR check does', () => {
    expect(validEraMap({ 'classic-dereth': 'https://x.example/a' })).toEqual({ 'classic-dereth': 'https://x.example/a' });
    expect(validEraMap({ 'Bad Id': 'https://x' })).toEqual({});
    expect(validEraMap({ ok: 'javascript:alert(1)' })).toEqual({});
    expect(validEraMap({ ok: { nested: 1 } })).toEqual({});
    expect(validEraMap(['https://x'])).toEqual({});
    expect(buildConfig({}).datSet).toBeNull();
    expect(buildConfig({}).sourceUrl).toBeNull();
  });

  it('version.json carries the build id and the urgent flag', () => {
    expect(buildVersion('3e352df7abcd')).toEqual({ build: '3e352df7abcd', urgent: false });
    expect(buildVersion('x', true).urgent).toBe(true);
    expect(buildVersion('').build).toBe('dev');
  });
});

describe('headers and redirects', () => {
  it('the CSP connects to the bridge (ws + http), the DAT host and each era host, each once', () => {
    expect(originOf('wss://bridge.playwebac.com/x?y')).toBe('wss://bridge.playwebac.com');
    expect(originOf('nonsense')).toBe('');
    const csp = buildCsp(buildConfig(prod));
    const connect = /connect-src ([^;]+);/.exec(csp)![1].split(' ');
    expect(connect).toEqual(["'self'", 'wss:', 'wss://bridge.playwebac.com', 'https://bridge.playwebac.com', 'https://dats.playwebac.com']);
    for (const d of ["script-src 'self'", "font-src 'self' data:", "frame-ancestors 'none'", "worker-src 'self' blob:"]) expect(csp).toContain(d);
  });

  it('_headers puts Caddy\'s security headers on every path and its cache rules on the right ones', () => {
    const h: string = buildHeadersFile('CSP-HERE', ['about', 'servers']);
    const rules = Object.fromEntries(h.trim().split(/\n(?=\/)/).map((b) => {
      const [path, ...lines] = b.split('\n');
      return [path, Object.fromEntries(lines.map((l) => l.trim().split(/: (.*)/s).slice(0, 2)))];
    }));
    expect(rules['/*']).toEqual({
      'Content-Security-Policy': 'CSP-HERE', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', 'Cross-Origin-Opener-Policy': 'same-origin',
    });
    expect(rules['/assets/*']['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect(rules['/s/*']['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect(rules['/config.json']['Cache-Control']).toBe('no-store');
    expect(rules['/version.json']['Cache-Control']).toBe('no-store');
    for (const p of htmlPaths(['about', 'servers'])) {
      expect(rules[p]['Cache-Control'], p).toBe('no-cache');
      expect(rules[p]['Content-Type'], p).toBe('text/html; charset=utf-8');
    }
    for (const p of ['/robots.txt', '/llms.txt', '/llms-full.txt']) expect(rules[p]['Content-Type'], p).toBe('text/plain; charset=utf-8');
    expect(rules['/sitemap.xml']['Content-Type']).toBe('text/xml; charset=utf-8');
    expect(htmlPaths(['about'])).toEqual(['/', '/index.html', '/about/', '/about/index.html']);
  });

  it('_redirects answers 308 for a page without its slash and serves the slash form from index.html', () => {
    expect(buildRedirectsFile(['about', 'eras']).trim().split('\n')).toEqual([
      '/ /index.html 200', '/about /about/ 308', '/about/ /about/index.html 200', '/eras /eras/ 308', '/eras/ /eras/index.html 200',
    ]);
  });
});

describe('tools/build-web-release.mjs', () => {
  let tmp: string;
  let home: string;
  const run = (dist: string, out: string, build: string) => execFileSync('node', [resolve(ROOT, 'tools/build-web-release.mjs'), '--dist', dist, '--out', out, '--build', build], {
    env: { ...process.env, HOME: home }, encoding: 'utf8',
  });
  const fakeDist = (name: string, chunk: string) => {
    const d = join(tmp, name);
    mkdirSync(join(d, 'assets'), { recursive: true });
    writeFileSync(join(d, 'index.html'), `<!doctype html><script src="/assets/${chunk}"></script>`);
    writeFileSync(join(d, 'assets', chunk), 'x');
    writeFileSync(join(d, 'assets', `${chunk}.map`), 'map');
    return d;
  };
  beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'web-release-')); home = join(tmp, 'home'); mkdirSync(home); });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('layers the site pages over the build, writes the runtime files and leaves sourcemaps out', () => {
    const out = join(tmp, 'rel1');
    const log = run(fakeDist('dist1', 'index-AAA.js'), out, 'aaaaaaaaaaaa');
    expect(log).toContain('release aaaaaaaaaaaa');
    expect(existsSync(join(out, 'assets/index-AAA.js'))).toBe(true);
    expect(existsSync(join(out, 'assets/index-AAA.js.map'))).toBe(false);
    expect(existsSync(join(out, 'about/index.html'))).toBe(true);
    expect(existsSync(join(out, 'servers/index.html'))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, 'version.json'), 'utf8'))).toEqual({ build: 'aaaaaaaaaaaa', urgent: false });
    expect(JSON.parse(readFileSync(join(out, 'config.json'), 'utf8')).siteLinks).toBe(true);
    expect(readFileSync(join(out, '_redirects'), 'utf8')).toContain('/servers /servers/ 308');
    expect(readFileSync(join(out, '_headers'), 'utf8')).toContain('/how-to-play-asherons-call/\n  Cache-Control: no-cache');
    expect(readFileSync(join(out, 'healthz'), 'utf8')).toBe('');
    // The build's own maps are kept beside its carried assets for stack traces.
    expect(existsSync(join(home, '.cache/webac/web-assets/aaaaaaaaaaaa/assets/index-AAA.js.map'))).toBe(true);
  });

  it('the next release carries the previous release\'s chunks, and forgets releases older than the window', () => {
    const out = join(tmp, 'rel2');
    run(fakeDist('dist2', 'index-BBB.js'), out, 'bbbbbbbbbbbb');
    expect(existsSync(join(out, 'assets/index-BBB.js'))).toBe(true);
    expect(existsSync(join(out, 'assets/index-AAA.js'))).toBe(true);
    // Age release aaaa past 14 days: the next release neither carries it nor keeps it.
    const old = join(home, '.cache/webac/web-assets/aaaaaaaaaaaa');
    const past = new Date(Date.now() - 20 * 86_400_000);
    utimesSync(old, past, past);
    const out3 = join(tmp, 'rel3');
    run(fakeDist('dist3', 'index-CCC.js'), out3, 'cccccccccccc');
    expect(existsSync(join(out3, 'assets/index-AAA.js'))).toBe(false);
    expect(existsSync(join(out3, 'assets/index-BBB.js'))).toBe(true);
    expect(existsSync(old)).toBe(false);
  });
});
