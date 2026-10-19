// playwebac.com's one Worker script: it runs ONLY for /__webac/* (wrangler.jsonc
// assets.run_worker_first), so every other request stays a free asset request and never
// counts against the Free plan's 100,000 Worker requests a day.
//
// BUG.world-list-unreachable (2026-10-19): a player's launcher could not fetch the world list
// from the bridge, and the bridge had no trace of the request, so the page reports such failures
// to its own origin instead (packages/renderer/src/telemetry/WebReport.ts). This logs one
// `web_report` line per report to Workers Logs (observability) with Cloudflare's country / ASN /
// colo. Read them: `npx wrangler@4 tail webac-web --env production --format json`, or the
// dashboard's Workers Logs (docs/web-hosting-cloudflare-plan.md).

export const REPORT_PATH = '/__webac/report';
export const MAX_REPORT_BYTES = 4096;

const KINDS = new Set(['world_list_failed', 'launcher_connect_failed']);
const STEPS = new Set(['healthz', 'servers', 'json', 'websocket']);

/** A string field bounded to `max` chars, or null. */
function str(v, max) {
  return typeof v === 'string' && v ? v.slice(0, max) : null;
}

/** A non-negative integer bounded to `max`, or null. */
function int(v, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : null;
}

/**
 * The report's fields, each validated; null when the body is not a report.
 * Only this closed set is ever logged, whatever else the body carries.
 */
export function validateReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !KINDS.has(body.kind)) return null;
  return {
    kind: body.kind,
    build: str(body.build, 40),
    attempts: int(body.attempts, 100),
    elapsedMs: int(body.elapsedMs, 86_400_000),
    failedStep: STEPS.has(body.failedStep) ? body.failedStep : null,
    errorName: str(body.errorName, 40),
    errorMessage: str(body.errorMessage, 120),
    online: typeof body.online === 'boolean' ? body.online : null,
    bridgeHost: typeof body.bridgeHost === 'string' && /^[a-z0-9.-]{1,253}$/i.test(body.bridgeHost) ? body.bridgeHost : null,
    ua: str(body.ua, 160),
    lang: str(body.lang, 35),
  };
}

async function handleReport(request) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_REPORT_BYTES) return new Response(null, { status: 413 });
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_REPORT_BYTES) return new Response(null, { status: 413 });
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return new Response(null, { status: 400 });
  }
  const report = validateReport(body);
  if (!report) return new Response(null, { status: 400 });
  const cf = request.cf ?? {};
  console.log(JSON.stringify({
    event: 'web_report',
    ...report,
    cf: { country: cf.country ?? null, asn: cf.asn ?? null, colo: cf.colo ?? null },
    ip: request.headers.get('cf-connecting-ip'),
  }));
  return new Response(null, { status: 204 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === REPORT_PATH) return handleReport(request);
    // Anything else run_worker_first sends here (the rest of /__webac/*) is the assets' answer.
    return env.ASSETS.fetch(request);
  },
};
