#!/usr/bin/env node
/**
 * Assembles a static web release for Cloudflare Workers Static Assets: the Vite build, the site
 * pages (deploy/web/site/), the generated config.json / version.json / _headers / _redirects, and
 * the hashed /assets/* of recent earlier releases, so a tab opened before a deploy still finds
 * the lazy chunks it asks for later (the Caddy container lost them on every deploy).
 *
 *   node tools/build-web-release.mjs --dist <vite out> --out <release dir> --build <id>
 *        [--site <deploy/web/site of the built commit>] [--env deploy/web/env/production.json] [--urgent] [--keep-days 14]
 *
 * Sourcemaps stay out (Workers' 25 MiB per-file cap; the entry map is ~20 MB) and are kept
 * beside the carried assets for stack traces. tools/deploy-web-cf.sh runs this.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildConfig, buildCsp, buildHeadersFile, buildRedirectsFile, buildVersion } from './lib/web-release.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const dist = arg('dist'), out = arg('out'), build = arg('build');
if (!dist || !out || !build) { console.error('usage: build-web-release.mjs --dist <dir> --out <dir> --build <id> [--env file] [--urgent] [--keep-days N]'); process.exit(2); }
const envFile = arg('env', path.join(REPO, 'deploy/web/env/production.json'));
const site = arg('site', path.join(REPO, 'deploy/web/site'));
const keepDays = Number(arg('keep-days', '14'));
const CACHE = path.join(os.homedir(), '.cache/webac/web-assets');
const MAX_FILE = 24 * 1024 * 1024;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const copyTree = (src, dst, skip = () => false) => {
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (skip(s, ent)) continue;
    if (ent.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyTree(s, d, skip); }
    else fs.copyFileSync(s, d);
  }
};
const isMap = (p) => p.endsWith('.map');

// 1. This build (no sourcemaps), then the site pages over it, as the Dockerfile layers them.
copyTree(dist, out, (p) => isMap(p));
copyTree(site, out);

// 2. Earlier releases' hashed assets (never overwriting this build's own).
fs.mkdirSync(CACHE, { recursive: true });
const now = Date.now();
let carried = 0;
for (const rel of fs.readdirSync(CACHE)) {
  const dir = path.join(CACHE, rel);
  const ageDays = (now - fs.statSync(dir).mtimeMs) / 86_400_000;
  if (ageDays > keepDays) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
  if (rel === build) continue;
  const assets = path.join(dir, 'assets');
  if (!fs.existsSync(assets)) continue;
  for (const f of fs.readdirSync(assets)) {
    if (isMap(f)) continue;
    const dst = path.join(out, 'assets', f);
    if (!fs.existsSync(dst)) { fs.copyFileSync(path.join(assets, f), dst); carried++; }
  }
}
// Keep this build's assets (with maps) for the next releases to carry.
const mine = path.join(CACHE, build, 'assets');
fs.rmSync(path.join(CACHE, build), { recursive: true, force: true });
fs.mkdirSync(mine, { recursive: true });
copyTree(path.join(dist, 'assets'), mine);

// 3. Runtime files, headers and redirects.
const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
const config = buildConfig(env);
const pageDirs = fs.readdirSync(site, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(site, e.name, 'index.html'))).map((e) => e.name).sort();
fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify(config) + '\n');
fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify(buildVersion(build, process.argv.includes('--urgent') || env.updateUrgent === true)) + '\n');
const textFiles = fs.readdirSync(out).filter((f) => f.endsWith('.txt') && f !== 'build-id.txt').sort();
fs.writeFileSync(path.join(out, '_headers'), buildHeadersFile(buildCsp(config), pageDirs, textFiles));
fs.writeFileSync(path.join(out, '_redirects'), buildRedirectsFile(pageDirs));
fs.writeFileSync(path.join(out, 'healthz'), '');

// 4. Limits: Workers Static Assets refuses files over 25 MiB and more than 20,000 files.
let files = 0;
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p);
  else { files++; const size = fs.statSync(p).size; if (size > MAX_FILE) throw new Error(`${p} is ${(size / 1048576).toFixed(1)} MiB, over the 24 MiB release cap`); }
} };
walk(out);
if (files > 19_000) throw new Error(`${files} files, near Workers' 20,000-file cap: lower --keep-days`);
console.log(`release ${build}: ${files} files (${carried} assets carried from earlier releases), pages: ${pageDirs.join(', ')}`);
