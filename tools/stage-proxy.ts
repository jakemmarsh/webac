/**
 * Try a staged DAT set before it goes live: serve a staging dir
 * (tools/publish-dats-r2.ts --stage-only / --areas-only) over the live bucket.
 * A request for v1/sets/<set>.json or v1/o/<hash> is answered from the stage
 * when the stage has it, else redirected (302) to the live host, query string
 * kept, so probe-dat-streaming's --edge-bust still misses the edge for every
 * object the stage does not hold, and the browser fetches it from the bucket
 * itself (relaying bodies through one Node process skewed timings: 30 KB
 * objects took 3 s on 2026-10-08). CORS is open, like the bucket's.
 * --pointer-only: serve only the staged pointer, every object from the bucket
 * (after `upload-stream-set-r2.ts --no-pointer`: a fair cold-edge measurement).
 *
 *   npx tsx tools/stage-proxy.ts <stage dir> [--port 9177] [--upstream https://dats.playwebac.com] [--delay-ms 0] [--pointer-only]
 *   then load the game with &datSet=http://localhost:9177/v1/sets/<set>.json
 *
 * --delay-ms adds that much latency to every staged object, to stand in for
 * an edge miss when comparing against live objects (RELEASE.streaming-area-packs).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize } from 'node:path';

const argv = process.argv.slice(2);
const opt = (f: string, d: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const stage = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')));
if (!stage) { console.error('usage: npx tsx tools/stage-proxy.ts <stage dir> [--port 9177] [--upstream https://dats.playwebac.com] [--delay-ms 0]'); process.exit(2); }
const port = Number(opt('--port', '9177'));
const upstream = opt('--upstream', 'https://dats.playwebac.com');
const delayMs = Number(opt('--delay-ms', '0'));
const pointerOnly = argv.includes('--pointer-only');
let local = 0, passed = 0;

createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, ETag');
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', '*'); res.end(); return; }
  const url = new URL(req.url ?? '/', 'http://x');
  const path = normalize(url.pathname).replace(/^\/+/, '');
  if (!/^v1\/(sets\/[\w.-]+\.json|o\/[0-9a-f]{16})$/.test(path)) { res.statusCode = 404; res.end(); return; }
  const file = join(stage, path);
  if (existsSync(file) && (!pointerOnly || path.startsWith('v1/sets/'))) {
    local++;
    if (delayMs && path.startsWith('v1/o/')) await new Promise((r) => setTimeout(r, delayMs));
    res.setHeader('Content-Type', path.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    res.setHeader('Content-Length', String(statSync(file).size));
    createReadStream(file).pipe(res);
    return;
  }
  passed++;
  res.statusCode = 302;
  res.setHeader('Location', `${upstream}/${path}${url.search}`);
  res.end();
}).listen(port, () => console.log(`stage-proxy: ${stage} over ${upstream} on http://localhost:${port}/`));

setInterval(() => { if (local || passed) console.log(`stage-proxy: ${local} staged, ${passed} redirected`); }, 30_000).unref();
