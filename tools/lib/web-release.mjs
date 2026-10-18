/**
 * The files a static web release carries besides the build: config.json, version.json, and the
 * Cloudflare Workers Static Assets _headers and _redirects that reproduce what the web container's
 * Caddy served (deploy/web/Caddyfile, deploy/web/entrypoint.sh). Pure functions, so the release
 * is tested here rather than discovered live. tools/deploy-web-cf.sh writes them; the plan and the
 * URL contract are in docs/web-hosting-cloudflare-plan.md.
 */

/** Only a flat {"era-id":"http(s)://…"} map passes, as entrypoint.sh's ERA_PAIR check. */
const ERA_ID = /^[a-z0-9][a-z0-9-]*$/;
const ERA_URL = /^https?:\/\/[^"\\\s]+$/;
export function validEraMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  const entries = Object.entries(map);
  if (!entries.every(([k, v]) => ERA_ID.test(k) && typeof v === 'string' && ERA_URL.test(v))) return {};
  return Object.fromEntries(entries);
}

/** config.json, key for key as entrypoint.sh writes it. */
export function buildConfig(env) {
  return {
    assetBase: env.assetBase ?? '',
    bridgeUrl: env.bridgeUrl ?? 'ws://localhost:9090',
    datSet: env.datSetUrl ? { manifestUrl: env.datSetUrl } : null,
    sourceUrl: env.sourceUrl || null,
    siteLinks: true,
    eraAssetBases: validEraMap(env.eraAssetBases),
    eraDatSets: validEraMap(env.eraDatSets),
  };
}

export function buildVersion(buildId, urgent = false) {
  return { build: buildId || 'dev', urgent: urgent === true };
}

/** scheme://host[:port] of a URL, or '' (entrypoint.sh origin_of). */
export function originOf(url) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/.exec(url ?? '');
  return m ? m[1] : '';
}

/** The CSP entrypoint.sh derives from the config, with its repeated origins listed once. */
export function buildCsp(config) {
  const bridge = originOf(config.bridgeUrl);
  const bridgeHttp = bridge.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
  const eraOrigins = [...new Set([...Object.values(config.eraAssetBases), ...Object.values(config.eraDatSets)].map(originOf).filter(Boolean))].sort();
  const connect = [...new Set(["'self'", 'wss:', bridge, bridgeHttp, originOf(config.assetBase), originOf(config.datSet?.manifestUrl), ...eraOrigins].filter(Boolean))];
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; worker-src 'self' blob:; connect-src ${connect.join(' ')}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
}

/** Directory pages (each served from <dir>/index.html), e.g. ['about', 'servers']. */
export function htmlPaths(pageDirs) {
  return ['/', '/index.html', ...pageDirs.flatMap((d) => [`/${d}/`, `/${d}/index.html`])];
}

/**
 * _headers: Caddy's security headers on every response, its cache rules per path. HSTS and
 * nosniff come from the zone (Cloudflare's HSTS setting adds both), so they're not repeated.
 */
export function buildHeadersFile(csp, pageDirs, textFiles = ['robots.txt', 'llms.txt', 'llms-full.txt']) {
  const block = (path, headers) => `${path}\n${Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n`;
  return [
    block('/*', {
      'Content-Security-Policy': csp,
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
    }),
    block('/assets/*', { 'Cache-Control': 'public, max-age=31536000, immutable' }),
    block('/s/*', { 'Cache-Control': 'public, max-age=31536000, immutable' }),
    block('/config.json', { 'Cache-Control': 'no-store' }),
    block('/version.json', { 'Cache-Control': 'no-store' }),
    // Caddy named the charset; Workers' inferred types don't, and a text file read without it
    // may show its curly quotes and middle dots as mojibake. (Module scripts are UTF-8 by spec.)
    ...htmlPaths(pageDirs).map((p) => block(p, { 'Cache-Control': 'no-cache', 'Content-Type': 'text/html; charset=utf-8' })),
    ...textFiles.map((f) => block(`/${f}`, { 'Content-Type': 'text/plain; charset=utf-8' })),
    block('/sitemap.xml', { 'Content-Type': 'text/xml; charset=utf-8' }),
  ].join('');
}

/**
 * _redirects: a directory page without its slash answers 308 to the slash (as Caddy's
 * file_server does), and the slash form is served from its index.html (html_handling is "none",
 * so /index.html and /about/index.html stay 200 instead of redirecting).
 */
export function buildRedirectsFile(pageDirs) {
  return [
    '/ /index.html 200',
    ...pageDirs.flatMap((d) => [`/${d} /${d}/ 308`, `/${d}/ /${d}/index.html 200`]),
  ].join('\n') + '\n';
}
