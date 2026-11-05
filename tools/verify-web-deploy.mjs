#!/usr/bin/env node
/**
 * Post-deploy check of what a player's browser loads from each host: version.json's build,
 * index.html, and every /assets/*.js / *.css index.html references (HTTP 200 within the timeout,
 * the release file's size). Retries failing items over the window. Exit 0 = all good, 1 = not.
 * tools/web-cf-ship.sh runs it; the logic is tools/lib/web-deploy-verify.mjs.
 *
 *   node tools/verify-web-deploy.mjs --hosts https://a,https://b [--build <id>] [--release <dir>]
 *        [--match-index] [--window-ms 60000] [--interval-ms 10000] [--timeout-ms 15000]
 *
 * --release: sizes come from <dir>/assets/*; with --match-index each host's index.html must equal
 * <dir>/index.html byte for byte. A path missing from <dir> passes on any non-empty 200.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { verifyDeploy } from './lib/web-deploy-verify.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const hosts = (arg('hosts', '') ?? '').split(',').map((h) => h.trim()).filter(Boolean);
if (!hosts.length) { console.error('usage: verify-web-deploy.mjs --hosts https://a[,https://b] [--build id] [--release dir] [--match-index]'); process.exit(2); }
const release = arg('release');
const num = (name, dflt) => { const v = Number(arg(name, String(dflt))); return Number.isFinite(v) && v >= 0 ? v : dflt; };

const localSize = (p) => {
  if (!release) return null;
  try { return fs.statSync(path.join(release, p)).size; } catch { return null; }
};
const expectIndex = process.argv.includes('--match-index') && release ? fs.readFileSync(path.join(release, 'index.html'), 'utf8') : null;

const result = await verifyDeploy({
  hosts,
  expectBuild: arg('build') ?? null,
  expectIndex,
  localSize,
  windowMs: num('window-ms', 60_000),
  intervalMs: num('interval-ms', 10_000),
  timeoutMs: num('timeout-ms', 15_000),
  log: (line) => console.log(line),
});
const byHost = new Map();
for (const p of result.passed) byHost.set(p.host, (byHost.get(p.host) ?? []).concat(p));
for (const [host, list] of byHost) {
  const slowest = list.reduce((a, b) => (b.ms > a.ms ? b : a));
  console.log(`[verify] ${host}: ${list.length} assets OK (slowest ${slowest.path} ${slowest.ms} ms, ${slowest.size} B)`);
}
if (result.ok) { console.log(`[verify] OK after ${result.rounds} round(s)`); process.exit(0); }
for (const f of result.failures) console.log(`[verify] FAILED ${f.host}${f.path}: ${f.reason}`);
process.exit(1);
