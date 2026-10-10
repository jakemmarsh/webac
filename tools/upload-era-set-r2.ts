/**
 * Upload a classic era's own DAT files to R2 for hosting
 * (docs/dark-majesty-support.md, "Hosted classic sets"), without an R2 API
 * token: through a short-lived Worker bound to the bucket that does R2
 * multipart uploads (wrangler's `r2 object put` stops at 315 MB; a portal
 * is ~930 MB).
 *
 *   1. npx wrangler@3 login                       (OAuth; no token to copy)
 *   2. deploy the uploader Worker (worker source + wrangler.toml are in this
 *      file's UPLOADER_WORKER comment), `wrangler secret put UPLOAD_KEY`
 *   3. UPLOAD_KEY=… npx tsx tools/upload-era-set-r2.ts <worker url> <set name> <dir> [file…]
 *      e.g. … classicace-infiltration-1.9 dat-sets/classicace-infiltration-1.9
 *           client_portal.dat client_cell_1.dat client_local_English.dat
 *   4. `wrangler delete` the Worker, `wrangler logout`.
 *
 * Objects land at v1/raw/<set>/<file> (served as https://dats.playwebac.com/v1/raw/<set>/<file>)
 * with Cache-Control immutable: a new data release gets a new set name.
 * Each file is checked afterwards: the public size, plus 1 MiB byte ranges at
 * the start, middle and end against the local file.
 *
 * UPLOADER_WORKER (worker.js; binding B = the bucket; only keys under
 * v1/raw/classicace- are accepted):
 *   /create?key → createMultipartUpload · /part?key&uploadId&n (body) → uploadPart
 *   /complete?key&uploadId (JSON parts) → complete · /put?key (body) · /head?key
 *   every request needs header x-upload-key = the UPLOAD_KEY secret.
 */
import { openSync, readSync, statSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const [workerUrl, set, dir, ...files] = process.argv.slice(2);
const key = process.env.UPLOAD_KEY;
const PUBLIC = process.env.PUBLIC_BASE ?? 'https://dats.playwebac.com';
if (!workerUrl || !set || !dir || !key) {
  console.error('usage: UPLOAD_KEY=… npx tsx tools/upload-era-set-r2.ts <worker url> <set> <dir> [file…]');
  process.exit(2);
}
const names = files.length ? files : ['client_portal.dat', 'client_cell_1.dat', 'client_local_English.dat'];
const PART = 32 * 1024 * 1024;
const CONCURRENCY = 4;

/** A Buffer's bytes as a standalone ArrayBuffer (a fetch body). */
const body = (b: Buffer): ArrayBuffer => new Uint8Array(b).buffer;

function readRange(path: string, offset: number, length: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

async function call(path: string, params: Record<string, string>, body?: BodyInit): Promise<unknown> {
  const u = new URL(path, workerUrl);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(u, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-upload-key': key! }, body });
      if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
      return await r.json();
    } catch (err) {
      if (attempt >= 5) throw err;
      console.warn(`  retry ${attempt} ${path} ${params.n ?? ''}: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function upload(file: string): Promise<void> {
  const path = join(dir, file);
  const size = statSync(path).size;
  const objKey = `v1/raw/${set}/${file}`;
  const t0 = Date.now();
  if (size <= PART) {
    await call('/put', { key: objKey }, body(readRange(path, 0, size)));
  } else {
    const { uploadId } = await call('/create', { key: objKey }) as { uploadId: string };
    const count = Math.ceil(size / PART);
    const parts: Array<{ partNumber: number; etag: string }> = [];
    let next = 0;
    const worker = async () => {
      while (next < count) {
        const i = next++;
        const p = await call('/part', { key: objKey, uploadId, n: String(i + 1) }, body(readRange(path, i * PART, PART))) as { partNumber: number; etag: string };
        parts.push(p);
        if (parts.length % 5 === 0 || parts.length === count) console.log(`  ${file}: ${parts.length}/${count} parts`);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    parts.sort((a, b) => a.partNumber - b.partNumber);
    await call('/complete', { key: objKey, uploadId }, JSON.stringify(parts));
  }
  console.log(`uploaded ${objKey} (${(size / 1e6).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  // A fresh cache key: the edge keeps a 404 it answered before the upload
  // (no Cache-Control; ~3 min), which failed the check and stopped a
  // multi-file upload after the first file (2026-10-08). Players' plain URL
  // serves the object once that cached 404 expires.
  await verify(path, size, `${PUBLIC}/${objKey}?verify=${Date.now()}`);
}

/** The public object: size, and three 1 MiB ranges byte-for-byte. */
async function verify(path: string, size: number, url: string): Promise<void> {
  const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  const len = Number(head.headers.get('content-length'));
  if (!head.ok || len !== size) throw new Error(`verify ${url}: HTTP ${head.status}, size ${len} ≠ ${size}`);
  const n = Math.min(1 << 20, size);
  for (const off of [0, Math.floor(size / 2), size - n]) {
    const want = readRange(path, off, n);
    // Right after a large upload completes the edge can answer once with a
    // stale or non-ranged body (seen 2026-10-06); retry before failing.
    for (let attempt = 1; ; attempt++) {
      const r = await fetch(url, { headers: { range: `bytes=${off}-${off + n - 1}` }, cache: 'no-store' });
      const got = Buffer.from(await r.arrayBuffer());
      if (r.status === 206 && got.equals(want)) break;
      if (attempt >= 4) throw new Error(`verify ${url}: bytes differ at ${off} (HTTP ${r.status}, ${got.length} bytes)`);
      await new Promise((res) => setTimeout(res, 3000 * attempt));
    }
  }
  console.log(`verified ${url}: ${size} bytes, content-type ${head.headers.get('content-type')}, ranges match`);
}

for (const f of names) await upload(f);
