/**
 * The short-lived R2 uploader Worker behind tools/upload-era-set-r2.ts (raw
 * DAT sets, multipart) and tools/upload-stream-set-r2.ts (streaming sets).
 * There is no standing R2 write key (docs/release-plan.md security posture):
 * deploy this under `wrangler login` (OAuth), upload, then `wrangler delete`
 * and `wrangler logout`. Recipe: tools/r2-uploader/README.md.
 *
 * Binding B = the bucket (webac-dats). Every request needs header
 * x-upload-key = the UPLOAD_KEY secret. Writes are limited to:
 *   - v1/raw/<set>/<file> where <set> starts with one of ALLOWED_SETS
 *     (comma-separated var), never over an existing object (sets are immutable);
 *   - v1/o/<16 hex> content-addressed objects (head-then-put: never rewritten);
 *   - the pointer v1/sets/<set>.json for <set> in ALLOWED_SETS (the one
 *     mutable key, written last by the stream uploader).
 * So a deploy for one era cannot touch end of retail's set or pointer.
 *
 * Raw (upload-era-set-r2.ts): /create?key → { uploadId } · /part?key&uploadId&n (body) → { partNumber, etag }
 *   · /complete?key&uploadId (JSON parts) · /put?key (body) · /head?key → { size } | 404
 * Stream (upload-stream-set-r2.ts): /batch (body = repeated [u16 keyLen][key][u32 len][bytes]) → { written, skipped }
 *   · /exists (JSON key list) → { missing } · /pointer?key=v1/sets/<set>.json (body)
 */
const IMMUTABLE = 'public, max-age=31536000, immutable';
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

function setAllowed(env, set) {
  return String(env.ALLOWED_SETS || '').split(',').map((s) => s.trim()).filter(Boolean).some((p) => set.startsWith(p));
}

function rawKeyOk(env, key) {
  const m = /^v1\/raw\/([a-z0-9][a-z0-9.-]{0,79})\/([A-Za-z0-9_.-]{1,64})$/.exec(key);
  return !!m && setAllowed(env, m[1]);
}

const objectKeyOk = (key) => /^v1\/o\/[0-9a-f]{16}$/.test(key);

function pointerKeyOk(env, key) {
  const m = /^v1\/sets\/([a-z0-9][a-z0-9.-]{0,79})\.json$/.exec(key);
  return !!m && setAllowed(env, m[1]);
}

export default {
  async fetch(req, env) {
    if (!env.UPLOAD_KEY || req.headers.get('x-upload-key') !== env.UPLOAD_KEY) return json({ error: 'forbidden' }, 403);
    const url = new URL(req.url);
    const key = url.searchParams.get('key') || '';
    const B = env.B;
    switch (url.pathname) {
      case '/head': {
        if (!rawKeyOk(env, key) && !objectKeyOk(key)) return json({ error: 'key not allowed' }, 400);
        const h = await B.head(key);
        return h ? json({ size: h.size }) : json({ error: 'missing' }, 404);
      }
      case '/put': {
        if (!rawKeyOk(env, key)) return json({ error: 'key not allowed' }, 400);
        if (await B.head(key)) return json({ error: 'exists (sets are immutable)' }, 409);
        await B.put(key, req.body, { httpMetadata: { cacheControl: IMMUTABLE, contentType: 'application/octet-stream' } });
        return json({ ok: true });
      }
      case '/create': {
        if (!rawKeyOk(env, key)) return json({ error: 'key not allowed' }, 400);
        if (await B.head(key)) return json({ error: 'exists (sets are immutable)' }, 409);
        const up = await B.createMultipartUpload(key, { httpMetadata: { cacheControl: IMMUTABLE, contentType: 'application/octet-stream' } });
        return json({ uploadId: up.uploadId });
      }
      case '/part': {
        if (!rawKeyOk(env, key)) return json({ error: 'key not allowed' }, 400);
        const up = B.resumeMultipartUpload(key, url.searchParams.get('uploadId'));
        const part = await up.uploadPart(Number(url.searchParams.get('n')), req.body);
        return json({ partNumber: part.partNumber, etag: part.etag });
      }
      case '/complete': {
        if (!rawKeyOk(env, key)) return json({ error: 'key not allowed' }, 400);
        const up = B.resumeMultipartUpload(key, url.searchParams.get('uploadId'));
        await up.complete(await req.json());
        return json({ ok: true });
      }
      case '/batch': {
        const buf = new Uint8Array(await req.arrayBuffer());
        const dv = new DataView(buf.buffer);
        let o = 0;
        let written = 0;
        let skipped = 0;
        while (o < buf.length) {
          const kl = dv.getUint16(o, true); o += 2;
          const k = new TextDecoder().decode(buf.subarray(o, o + kl)); o += kl;
          const n = dv.getUint32(o, true); o += 4;
          const bytes = buf.slice(o, o + n); o += n;
          if (!objectKeyOk(k)) return json({ error: `key not allowed: ${k}` }, 400);
          if (await B.head(k)) { skipped++; continue; }
          await B.put(k, bytes, { httpMetadata: { cacheControl: IMMUTABLE, contentType: 'application/octet-stream' } });
          written++;
        }
        return json({ written, skipped });
      }
      case '/exists': {
        const keys = await req.json();
        const missing = [];
        for (const k of keys) {
          if (!objectKeyOk(k) && !rawKeyOk(env, k)) return json({ error: `key not allowed: ${k}` }, 400);
          if (!(await B.head(k))) missing.push(k);
        }
        return json({ missing });
      }
      case '/pointer': {
        if (!pointerKeyOk(env, key)) return json({ error: 'pointer not allowed' }, 400);
        await B.put(key, await req.arrayBuffer(), { httpMetadata: { cacheControl: 'public, max-age=60', contentType: 'application/json' } });
        return json({ ok: true });
      }
      default:
        return json({ error: 'not found' }, 404);
    }
  },
};
