#!/usr/bin/env node
/**
 * The static web's URL contract: requests every path playwebac.com answers (and a few it
 * doesn't) from two origins and diffs status, Location, Content-Type, Cache-Control, the
 * security headers and the body, so moving hosts (AWS Caddy → Cloudflare Workers Static Assets,
 * docs/web-hosting-cloudflare-plan.md) can't silently change one.
 *
 *   node tools/web-url-contract.mjs https://playwebac.com https://next.playwebac.com
 *   node tools/web-url-contract.mjs --pin-a 184.193.176.126 https://playwebac.com https://playwebac.com
 *      (--pin-a / --pin-b pin that origin's host to an IP: the AWS host after the DNS flip, or a
 *       new name this Mac's resolver still has cached as missing)
 *
 * Exits 1 on any difference not in EXPECTED.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
let resolveIp = null, pinB = null;
for (;;) {
  if (args[0] === '--pin-a') { resolveIp = args[1]; args.splice(0, 2); continue; }
  if (args[0] === '--pin-b') { pinB = args[1]; args.splice(0, 2); continue; }
  break;
}
const [A, B] = args;
if (!A || !B) { console.error('usage: web-url-contract.mjs [--pin-a <ip>] [--pin-b <ip>] <origin A> <origin B>'); process.exit(2); }

const html = (s) => `/${s}`;
const site = ['about', 'how-to-play-asherons-call', 'servers', 'mac-linux', 'eras'];
const assetFrom = (indexHtml) => [...indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);

/** curl, so --resolve can pin a host, and nothing is followed or decompressed behind our back. */
function get(origin, path, method = 'GET', pin = null) {
  const url = origin + path;
  const host = new URL(origin).host;
  const out = execFileSync('curl', ['-sS', '-X', method, '-D', '-', '-o', '-', '--max-time', '20', ...(pin ? ['--resolve', `${host}:443:${pin}`] : []),
    ...(method === 'HEAD' ? ['-I'] : []), url], { maxBuffer: 64 << 20 });
  const text = out.toString('latin1');
  const split = text.search(/\r?\n\r?\n/);
  const head = text.slice(0, split), body = out.subarray(Buffer.byteLength(text.slice(0, split), 'latin1') + (text[split] === '\r' ? 4 : 2));
  const [statusLine, ...lines] = head.split(/\r?\n/);
  const headers = {};
  for (const l of lines) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
  return { status: Number(statusLine.split(' ')[1]), headers, body };
}

const COMPARED = ['location', 'content-type', 'cache-control', 'content-security-policy', 'x-frame-options', 'referrer-policy',
  'permissions-policy', 'cross-origin-opener-policy', 'strict-transport-security', 'x-content-type-options'];
/** Known, accepted differences: [path pattern, header, why]. */
const EXPECTED = [
  [/.*/, 'content-security-policy', "Cloudflare's CSP lists each connect-src origin once (Caddy repeated dats 3x)"],
  [/^\/(about|servers|eras|mac-linux|how-to-play-asherons-call)$/, 'location', 'Caddy answers a relative Location, Cloudflare an absolute one; same target'],
  [/^\/(about|servers|eras|mac-linux|how-to-play-asherons-call)$/, 'content-type', "a 308's body type"],
  [/^\/(about|servers|eras|mac-linux|how-to-play-asherons-call)$/, 'body', "a 308's body"],
  [/^\/(nope|nope\/|About\/|favicon\.ico|assets\/missing\.js)$/, '*', "a 404's body and headers (Cloudflare's 404 carries the security headers; Caddy's carried none)"],
  [/^\/(robots\.txt|sitemap\.xml|llms\.txt|llms-full\.txt|og-image\.jpg|favicon\.png|about\/combat\.jpg|about\/inventory\.jpg|[0-9a-f]{32}\.txt)$/, 'cache-control', "Caddy sent none; Workers' default revalidates"],
  [/^\/healthz$/, '*', 'an empty health file (only the AWS deploy agent read /healthz)'],
  [/^\/assets\/.*\.js$/, 'content-type', 'text/javascript without "; charset=utf-8" (module scripts are UTF-8 by spec)'],
];
const expected = (path, field) => EXPECTED.find(([re, f]) => re.test(path) && (f === field || f === '*'));
const normLocation = (loc, origin) => (loc ? new URL(loc, origin + '/').pathname : loc);

const index = get(A, '/', 'GET', resolveIp).body.toString('utf8');
const paths = ['/', '/index.html', '/?world=Coldeve', '/config.json', '/version.json', '/robots.txt', '/sitemap.xml', '/llms.txt', '/llms-full.txt',
  '/og-image.jpg', '/favicon.png', '/about/combat.jpg', '/about/inventory.jpg', '/healthz',
  ...site.flatMap((s) => [html(s), `${html(s)}/`, `${html(s)}/index.html`]),
  ...assetFrom(index).slice(0, 4),
  '/nope', '/nope/', '/About/', '/favicon.ico', '/assets/missing.js'];

let failures = 0;
for (const path of paths) {
  const a = get(A, path, 'GET', resolveIp), b = get(B, path, 'GET', pinB);
  const diffs = [];
  if (a.status !== b.status) diffs.push(`status ${a.status} vs ${b.status}`);
  for (const h of COMPARED) {
    let va = a.headers[h], vb = b.headers[h];
    if (h === 'location') { va = normLocation(va, A); vb = normLocation(vb, B); }
    if ((va ?? '') !== (vb ?? '') && !expected(path, h)) diffs.push(`${h}: ${JSON.stringify(va)} vs ${JSON.stringify(vb)}`);
  }
  const ha = createHash('sha256').update(a.body).digest('hex').slice(0, 12), hb = createHash('sha256').update(b.body).digest('hex').slice(0, 12);
  // Bodies that name their own host (none should) would differ; the config's bridge URL is absolute and host-free.
  if (ha !== hb && !expected(path, 'body') && !expected(path, '*')) diffs.push(`body ${ha} vs ${hb}`);
  if (diffs.length) failures++;
  console.log(`${diffs.length ? 'DIFF' : 'ok  '} ${String(a.status).padEnd(3)} ${path}${diffs.length ? '\n       ' + diffs.join('\n       ') : ''}`);
}
console.log(failures ? `\n${failures} path(s) differ` : `\nall ${paths.length} paths match (accepted differences: ${EXPECTED.map((e) => e[2]).join('; ')})`);
process.exit(failures ? 1 : 0);
