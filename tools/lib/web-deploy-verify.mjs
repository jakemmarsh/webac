/**
 * Checks that a web deploy serves what a player's browser actually loads, not just version.json.
 *
 * 2026-11-04: a production deploy of 2a2ccfb2d uploaded fine and version.json / index.html showed
 * the new build, but the new 4.9 MB entry bundle /assets/index-B_rcgC04.js answered HTTP 500 after
 * ~47 s on every request for minutes, so no new page load could boot the game. A redeploy of the
 * same build minutes later served it in 0.5 s: transient Cloudflare delivery of a just-uploaded
 * asset, invisible to a version.json check. tools/web-cf-ship.sh runs this after every deploy (and
 * again after its automatic rollback). docs/web-hosting-cloudflare-plan.md, "Deploy verification".
 *
 * Pure apart from the injected fetch / sleep / clock, so tests drive it with a stub fetch.
 */

/** The JS / CSS under /assets/ that index.html makes the browser load, entry script first. */
export function extractAssetPaths(html) {
  const text = String(html ?? '');
  const norm = (v) => {
    const m = /^(?:\.?\/)?(assets\/[^"'?#\s]+\.(?:js|css))(?:[?#].*)?$/.exec(v);
    return m ? `/${m[1]}` : null;
  };
  let entry = null;
  const assets = [];
  const add = (p) => { if (p && !assets.includes(p)) assets.push(p); };
  for (const tag of text.match(/<(?:script|link)\b[^>]*>/gi) ?? []) {
    const attr = (name) => {
      const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
      return m ? (m[1] ?? m[2] ?? m[3]) : null;
    };
    if (/^<script/i.test(tag)) {
      const p = norm(attr('src') ?? '');
      if (!p) continue;
      if (!entry && /^module$/i.test(attr('type') ?? '') && p.endsWith('.js')) entry = p;
      add(p);
    } else {
      const rel = (attr('rel') ?? '').toLowerCase().split(/\s+/);
      if (!rel.some((r) => r === 'modulepreload' || r === 'stylesheet' || r === 'preload')) continue;
      add(norm(attr('href') ?? ''));
    }
  }
  if (entry) assets.splice(assets.indexOf(entry), 1), assets.unshift(entry);
  return { entry, assets };
}

/** One GET with a hard timeout covering headers AND body. Never throws. */
export async function fetchChecked(fetchFn, url, timeoutMs) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, redirect: 'manual' });
    const body = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, body, ms: Date.now() - t0 };
  } catch (e) {
    const timedOut = ctrl.signal.aborted;
    return { status: 0, body: null, ms: Date.now() - t0, error: timedOut ? `timed out after ${timeoutMs} ms` : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

const decode = (b) => new TextDecoder().decode(b ?? new Uint8Array());

/**
 * Checks every host until each one serves version.json with `expectBuild`, the index.html
 * (`expectIndex`, when given, byte for byte) and every JS / CSS it references with HTTP 200 and
 * the local release file's size (`localSize(path)` → bytes, or null when the file isn't local: then
 * any non-empty 200 passes). Failing items are retried every `intervalMs` until `windowMs` has
 * passed since the start, because a fresh deploy can take a little while to reach every edge.
 *
 * → { ok, rounds, failures: [{ host, path, reason }], passed: [{ host, path, ms, size }] }
 */
export async function verifyDeploy({
  hosts,
  expectBuild = null,
  expectIndex = null,
  localSize = () => null,
  fetch: fetchFn = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  windowMs = 60_000,
  intervalMs = 10_000,
  timeoutMs = 15_000,
  concurrency = 4,
  log = () => {},
}) {
  if (!hosts?.length) throw new Error('verifyDeploy: no hosts');
  const start = now();
  // Per host: null until version.json + index.html pass, then the asset list.
  const state = new Map(hosts.map((h) => [h.replace(/\/+$/, ''), { assets: null, done: new Set(), fail: new Map() }]));
  const passed = [];
  let rounds = 0;

  const checkHost = async (host, st) => {
    if (!st.assets) {
      if (expectBuild != null) {
        const r = await fetchChecked(fetchFn, `${host}/version.json`, timeoutMs);
        let build = null;
        try { build = JSON.parse(decode(r.body)).build ?? null; } catch { /* reported below */ }
        if (r.status !== 200 || build !== expectBuild) {
          st.fail.set('/version.json', r.status !== 200 ? (r.error ?? `HTTP ${r.status}`) : `build ${JSON.stringify(build)}, expected ${JSON.stringify(expectBuild)}`);
          return;
        }
        st.fail.delete('/version.json');
      }
      const r = await fetchChecked(fetchFn, `${host}/`, timeoutMs);
      if (r.status !== 200) { st.fail.set('/', r.error ?? `HTTP ${r.status}`); return; }
      const html = decode(r.body);
      if (expectIndex != null && html !== expectIndex) { st.fail.set('/', 'index.html differs from the release\'s'); return; }
      const { entry, assets } = extractAssetPaths(html);
      if (!entry) { st.fail.set('/', 'index.html references no /assets/*.js entry bundle'); return; }
      st.fail.delete('/');
      st.assets = assets;
    }
    const todo = st.assets.filter((p) => !st.done.has(p));
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const p = todo[next++];
        const r = await fetchChecked(fetchFn, `${host}${p}`, timeoutMs);
        const want = localSize(p);
        let reason = null;
        if (r.status !== 200) reason = r.error ?? `HTTP ${r.status} after ${r.ms} ms`;
        else if (want != null && r.body.length !== want) reason = `size ${r.body.length}, release has ${want}`;
        else if (want == null && r.body.length === 0) reason = 'empty body';
        if (reason) st.fail.set(p, reason);
        else { st.fail.delete(p); st.done.add(p); passed.push({ host, path: p, ms: r.ms, size: r.body.length }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  };

  for (;;) {
    rounds++;
    await Promise.all([...state].map(([h, st]) => checkHost(h, st)));
    const failures = [...state].flatMap(([host, st]) => [...st.fail].map(([path, reason]) => ({ host, path, reason })));
    if (!failures.length) return { ok: true, rounds, failures, passed };
    const left = windowMs - (now() - start);
    for (const f of failures) log(`[verify] round ${rounds}: ${f.host}${f.path}: ${f.reason}`);
    if (left <= 0) return { ok: false, rounds, failures, passed };
    await sleep(Math.min(intervalMs, left));
  }
}

/** The version id carrying the most traffic in `wrangler deployments status --json` output. */
export function liveVersionId(statusJson) {
  let d;
  try { d = typeof statusJson === 'string' ? JSON.parse(statusJson) : statusJson; } catch { return null; }
  const versions = Array.isArray(d?.versions) ? d.versions : [];
  const top = versions.slice().sort((a, b) => (b.percentage ?? 0) - (a.percentage ?? 0))[0];
  return typeof top?.version_id === 'string' && top.version_id ? top.version_id : null;
}
