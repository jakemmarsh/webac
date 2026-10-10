/**
 * Upload a staged streaming DAT set (tools/publish-dats-r2.ts --stage-only)
 * to R2 without an R2 API token, through a short-lived bucket-bound Worker
 * (the same route as tools/upload-era-set-r2.ts; docs/dark-majesty-support.md
 * "Hosted classic sets"). Mirrors publish-dats-r2's upload exactly:
 *   1. every v1/o/<hash> object, skipping ones the bucket already holds
 *      (content-addressed: a classic set shares most objects with end of
 *      retail), Cache-Control immutable, application/octet-stream;
 *   2. a check that every object of the set is in the bucket;
 *   3. the pointer v1/sets/<set>.json LAST (max-age=60, application/json).
 *
 *   UPLOAD_KEY=… npx tsx tools/upload-stream-set-r2.ts <worker url> [--known <stage dir>] <stage dir> [<stage dir>…]
 *     e.g. --known $TMPDIR/acjs-dat-publish/eol-p2072-c982-h497-l994 $TMPDIR/acjs-dat-publish/classicace-infiltration-1.9
 *   --no-pointer: objects only (steps 1–2); the pointer stays as it is, so a
 *   new object set can be measured from the bucket before it goes live
 *   (RELEASE.streaming-area-packs: tools/stage-proxy.ts serves the staged
 *   pointer and passes the objects through).
 *   --known: a set already live in the bucket; its objects are not sent (a
 *   classic set shares ~94% of end of retail's). Step 2 checks every sent key
 *   plus a random 300 of the shared ones (checking all ~48k shared keys one
 *   request at a time took over 20 min per set).
 *
 * UPLOADER_WORKER (binding B = the bucket; header x-upload-key = UPLOAD_KEY):
 *   /batch   body = repeated [u16 keyLen][key][u32 len][bytes]; keys v1/o/<16 hex> only;
 *            head-then-put each → { written, skipped }
 *   /exists  JSON key list → { missing }
 *   /pointer?key=v1/sets/classic….json  body = the pointer JSON
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const argv = process.argv.slice(2);
const knownAt = argv.indexOf('--known');
const knownDir = knownAt >= 0 ? argv.splice(knownAt, 2)[1] : null;
const noPointerAt = argv.indexOf('--no-pointer');
const writePointer = noPointerAt < 0;
if (!writePointer) argv.splice(noPointerAt, 1);
const [workerUrl, ...stageDirs] = argv;
const known = new Set(knownDir ? readdirSync(join(knownDir, 'v1/o')).map((h) => `v1/o/${h}`) : []);
const key = process.env.UPLOAD_KEY;
if (!workerUrl || !stageDirs.length || !key) {
  console.error('usage: UPLOAD_KEY=… npx tsx tools/upload-stream-set-r2.ts <worker url> <stage dir>…');
  process.exit(2);
}
const BATCH = 10;
/** Bytes per /batch body: area packs reach 12 MB, and a Worker request body is capped at 100 MB. */
const BATCH_BYTES = 24 * 1024 * 1024;
/** Keys per /exists check: each is one R2 head inside one Worker request, and the free plan's
 *  per-request limit fails at 40 (Error 1102, 2026-10-06), as it did for /batch. */
const EXISTS_BATCH = 10;
const CONCURRENCY = 6;

async function post(path: string, body: BodyInit, attempt = 1): Promise<unknown> {
  try {
    const r = await fetch(new URL(path, workerUrl), { method: 'POST', headers: { 'x-upload-key': key! }, body });
    if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
    return await r.json();
  } catch (err) {
    if (attempt >= 5) throw err;
    await new Promise((res) => setTimeout(res, 2000 * attempt));
    return post(path, body, attempt + 1);
  }
}

function pack(dir: string, keys: string[]): ArrayBuffer {
  const parts: Buffer[] = [];
  for (const k of keys) {
    const kb = Buffer.from(k, 'utf8');
    const data = readFileSync(join(dir, k));
    const head = Buffer.alloc(6);
    head.writeUInt16LE(kb.length, 0);
    head.writeUInt32LE(data.length, 2);
    parts.push(head.subarray(0, 2), kb, head.subarray(2, 6), data);
  }
  return new Uint8Array(Buffer.concat(parts)).buffer;
}

for (const dir of stageDirs) {
  const set = basename(dir);
  const pointer = join(dir, 'v1/sets', `${set}.json`);
  statSync(pointer); // the staged pointer must exist
  const keys = readdirSync(join(dir, 'v1/o')).map((h) => `v1/o/${h}`);
  const toSend = keys.filter((k) => !known.has(k));
  const batches: string[][] = [];
  let cur: string[] = [], curBytes = 0;
  for (const k of toSend) {
    const size = statSync(join(dir, k)).size;
    if (cur.length && (cur.length >= BATCH || curBytes + size > BATCH_BYTES)) { batches.push(cur); cur = []; curBytes = 0; }
    cur.push(k); curBytes += size;
  }
  if (cur.length) batches.push(cur);
  let next = 0, written = 0, skipped = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < batches.length) {
      const b = batches[next++];
      const r = await post('/batch', pack(dir, b)) as { written: number; skipped: number };
      written += r.written; skipped += r.skipped;
    }
  }));
  console.log(`${set}: ${keys.length} objects, ${toSend.length} not in --known — ${written} uploaded, ${skipped} already there (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  const shared = keys.filter((k) => known.has(k)).sort(() => Math.random() - 0.5).slice(0, 300);
  const check = [...toSend, ...shared];
  const missing: string[] = [];
  const groups: string[][] = [];
  for (let i = 0; i < check.length; i += EXISTS_BATCH) groups.push(check.slice(i, i + EXISTS_BATCH));
  let g = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (g < groups.length) missing.push(...((await post('/exists', JSON.stringify(groups[g++]))) as { missing: string[] }).missing);
  }));
  if (missing.length) throw new Error(`${set}: ${missing.length} objects missing after upload (e.g. ${missing[0]}); pointer NOT written`);
  if (!writePointer) { console.log(`${set}: every object present; pointer left as it is (--no-pointer)`); continue; }
  await post(`/pointer?key=${encodeURIComponent(`v1/sets/${set}.json`)}`, new Uint8Array(readFileSync(pointer)).buffer);
  console.log(`${set}: every object present; pointer v1/sets/${set}.json written`);
}
