# R2 uploader (short-lived Worker)

Uploads a raw DAT set (`tools/upload-era-set-r2.ts`) or a streaming set
(`tools/upload-stream-set-r2.ts`) to the `webac-dats` bucket
(https://dats.playwebac.com) without a standing R2 write key. The Worker lives
only for the upload. Source: `worker.js` (its header lists the API and the key
allowlist). Before 2026-10-06 the Worker existed only in sessions' temp dirs;
it is kept here so the next upload doesn't rebuild it.

```bash
cd tools/r2-uploader
npx wrangler@3 login                                   # OAuth in the browser (Jake's Cloudflare account)
# ALLOWED_SETS: comma-separated set-name prefixes this deploy may write (raw sets, stream objects, pointers)
npx wrangler@3 deploy --var ALLOWED_SETS:ac1999-       # prints the workers.dev URL
openssl rand -hex 24 | tee /tmp/upload-key | npx wrangler@3 secret put UPLOAD_KEY
cd ../..
# a raw set (immutable: a new release gets a new set name)
UPLOAD_KEY=$(cat /tmp/upload-key) npx tsx tools/upload-era-set-r2.ts <worker url> <set> <dir> <file…>
# a streaming set staged with tools/publish-dats-r2.ts --stage-only
UPLOAD_KEY=$(cat /tmp/upload-key) npx tsx tools/upload-stream-set-r2.ts <worker url> --known <eol stage dir> <stage dir>
cd tools/r2-uploader && npx wrangler@3 delete --force && npx wrangler@3 logout; rm -f /tmp/upload-key
```

Area packs for a set that is already live (RELEASE.streaming-area-packs,
docs/dat-streaming.md §6.12) go up in two steps, so they can be measured from
the bucket before any client sees them:

```bash
npx tsx tools/publish-dats-r2.ts --areas-only https://dats.playwebac.com/v1/sets/<set>.json \
  [--dat-dir <that set's DATs>] [--world-db none] [--overlay ac1999] --stage <scratch>/<set>   # the dir name is the set name
UPLOAD_KEY=… npx tsx tools/upload-stream-set-r2.ts <worker url> --no-pointer <scratch>/<set>  # objects only
npx tsx tools/stage-proxy.ts <scratch>/<set>        # serves the staged pointer, everything else from the bucket
#   probe with --set http://localhost:9177/v1/sets/<set>.json (tools/probe-dat-streaming.ts --edge-bust)
UPLOAD_KEY=… npx tsx tools/upload-stream-set-r2.ts <worker url> <scratch>/<set>               # the pointer: live
```

Deploy the Worker with `--var ALLOWED_SETS:` naming every set whose pointer
you write (comma-separated prefixes). Batches are capped at 24 MB (area packs
reach 12 MB; a Worker request body is capped at 100 MB).

The Worker refuses: keys outside `v1/raw/<allowed set>/…`, `v1/o/<16 hex>` and
`v1/sets/<allowed set>.json`; any write over an existing raw object (sets are
immutable); a request without the key. So a deploy for one era cannot touch end
of retail's objects or pointer.

**Gotchas (2026-10-08).**
- The edge caches a 404 for about 3 minutes, so a file players requested before it was uploaded keeps answering 404 at its plain URL until that expires. The upload tools verify through a fresh cache key.
- The raw end-of-retail set also carries the client's wcid side files (`weenie-setups.json`, `weenie-combat-styles.json`, `weenie-attack-types.json`, `weenie-weapon-time.json`; `npx tsx tools/export-weenie-setups.ts` from `dat/world.sqlite`). Attack types and weapon time were missing until 2026-10-08, so production swings used the default attack types and the unarmed swing speed. Upload a new side file with `upload-era-set-r2.ts <worker> eol-p2072-c982-h497-l994 dat <file>` (new keys only; the set is immutable).
