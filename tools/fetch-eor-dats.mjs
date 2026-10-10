#!/usr/bin/env node
/**
 * fetch-eor-dats.mjs — self-provision the End-of-Retail DAT files into dat/.
 *
 * WHY THIS EXISTS (2026-07-04): remote/ephemeral dev environments (Claude Code
 * on the web, CI with network access) clone the repo fresh without the
 * gitignored dat/ directory. Without the DATs the client hard-fails at boot
 * and 695 DAT-gated tests skip. The AC community has hosted the EoR DAT set
 * publicly since the Jan-2017 sunset (linked from https://emulator.ac/how-to-play/
 * and https://www.accpp.net/manual-installation — the standard "End of Retail
 * Client Files" package everyone points private-server players at).
 *
 * The package is on Mega.nz, whose API is encrypted (plain curl can't fetch),
 * so this script uses megajs. It downloads ac-updates.zip (~507MB), extracts
 * client_portal.dat / client_cell_1.dat / client_local_English.dat into dat/,
 * and validates each against the DAT header (offset 0x140) + the exact byte
 * sizes recorded in CLAUDE.md. Idempotent: valid existing files are kept.
 *
 * NOT included in the package: client_highres.dat (retail mounts it as the HiFi
 * DAT and CORE.17.h.g.c.d draws its level at Very High; extraction recipe from the
 * archived retail installer is in docs/era-determination.md; see HIGHRES below).
 *
 * QUOTA SELF-EXHAUSTION FIX (2026-08-25, BUG.dat-provision-mega-quota-self-
 * exhaustion): ~10 fresh containers/day × 507MB is exactly Mega's free-tier
 * per-IP rolling quota, so the loop starved itself (three cycles blocked
 * 2026-08-24/25; freed windows were consumed within minutes by whichever
 * container's provisioning happened to poll first). The zip is therefore
 * cached on the in-repo orphan branch `reference-bundle` as a `dat-zip/`
 * layer (95MB parts + sha256 manifest — GitHub caps files at 100MB):
 *   1. RESTORE: before touching Mega, reassemble the zip from that layer.
 *   2. PUBLISH: after any successful Mega download, push the layer (best-
 *      effort) so the first container to win a quota window ends the
 *      starvation for every later one.
 *
 * Usage:  node tools/fetch-eor-dats.mjs            (provision dat/)
 *         node tools/fetch-eor-dats.mjs --self-test (chunk codec self-test)
 * Deps:   megajs (devDependency), system `unzip`
 */
import { existsSync, mkdirSync, statSync, openSync, readSync, closeSync, createWriteStream, unlinkSync, readFileSync, writeFileSync, writeSync, rmSync, cpSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAT_DIR = join(REPO, 'dat');

// The community EoR package (see header comment for provenance).
const MEGA_URL = 'https://mega.nz/file/Q98n0BiR#p5IugPS8ZkQ7uX2A_LdN3Un2_wMX4gZBHowgs1Qomng';

// Expected files: exact sizes + header fields per CLAUDE.md "Verified DAT
// Header Values" (portal/cell) + the EoR package's language DAT.
const EXPECTED = [
  { name: 'client_portal.dat', size: 926941184, blockSize: 1024, dataSet: 1 },
  { name: 'client_cell_1.dat', size: 348127232, blockSize: 256, dataSet: 2 },
  { name: 'client_local_English.dat', size: 1048576, blockSize: 1024, dataSet: 3 },
];

const BUNDLE_BRANCH = 'reference-bundle';
const BUNDLE_LAYER = 'dat-zip';
const PART_SIZE = 95 * 1024 * 1024; // GitHub rejects files >100MB

// HIGHRES (CORE.17.h.g.c.d, 2026-09-12): client_highres.dat — the HiFi DAT the
// retail client mounts for Environment Texture Detail "Very High" (iteration
// 497 = ACE ITERATION_HIRES; portal-style header, DataSet 1). It is NOT in
// the Mega package; it comes out of the archived retail installer
// (docs/era-determination.md). Cached on reference-bundle as its own raw
// chunk layer `dat-highres/` (2 × 95MB parts + manifest): restored when
// present, published (best-effort) from a valid dat/client_highres.dat when
// the layer is absent. Optional: a missing file only costs Very High.
const HIGHRES = { name: 'client_highres.dat', size: 133169152, blockSize: 1024, dataSet: 1 };
const HIGHRES_LAYER = 'dat-highres';

function sha256File(path) {
  // Stream in 8MB slices — the zip is ~507MB, never hold it whole.
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  let n;
  while ((n = readSync(fd, buf, 0, buf.length)) > 0) hash.update(buf.subarray(0, n));
  closeSync(fd);
  return hash.digest('hex');
}

/** Split `srcPath` into PART_SIZE chunks inside `outDir`; returns the manifest. */
function splitIntoParts(srcPath, outDir, partSize = PART_SIZE) {
  mkdirSync(outDir, { recursive: true });
  const size = statSync(srcPath).size;
  const fd = openSync(srcPath, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  const parts = [];
  let idx = 0;
  let remaining = size;
  while (remaining > 0) {
    const partName = `${basename(srcPath)}.part-${String(idx).padStart(3, '0')}`;
    const partLen = Math.min(partSize, remaining);
    const out = openSync(join(outDir, partName), 'w');
    const hash = createHash('sha256');
    let written = 0;
    while (written < partLen) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, partLen - written));
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      writeSync(out, buf, 0, n);
      written += n;
    }
    closeSync(out);
    parts.push({ name: partName, size: written, sha256: hash.digest('hex') });
    remaining -= written;
    idx++;
  }
  closeSync(fd);
  const manifest = { file: basename(srcPath), size, sha256: sha256File(srcPath), parts };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** Reassemble a split file from `partsDir` per its manifest.json; returns the
 *  output path or null on any mismatch (caller falls back to Mega). */
function reassembleFromParts(partsDir, outPath) {
  const manifest = JSON.parse(readFileSync(join(partsDir, 'manifest.json'), 'utf8'));
  const out = openSync(outPath, 'w');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  for (const part of manifest.parts) {
    const partPath = join(partsDir, part.name);
    if (!existsSync(partPath) || statSync(partPath).size !== part.size) {
      console.warn(`[fetch-eor-dats] bundle part bad/missing: ${part.name}`);
      closeSync(out);
      return null;
    }
    if (sha256File(partPath) !== part.sha256) {
      console.warn(`[fetch-eor-dats] bundle part sha256 mismatch: ${part.name}`);
      closeSync(out);
      return null;
    }
    const fd = openSync(partPath, 'r');
    let n;
    while ((n = readSync(fd, buf, 0, buf.length)) > 0) writeSync(out, buf, 0, n);
    closeSync(fd);
  }
  closeSync(out);
  if (statSync(outPath).size !== manifest.size || sha256File(outPath) !== manifest.sha256) {
    console.warn('[fetch-eor-dats] reassembled zip failed manifest validation');
    return null;
  }
  return outPath;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', ...opts });
}

/** Try to restore the zip from the reference-bundle dat-zip/ layer and extract
 *  the missing DATs. Returns true when every EXPECTED file validates after. */
function restoreFromBundle(missingNames) {
  const work = join(tmpdir(), `dat-zip-restore-${process.pid}`);
  try {
    git(['fetch', '--depth', '1', 'origin', BUNDLE_BRANCH], { stdio: 'pipe' });
    try {
      git(['cat-file', '-e', `FETCH_HEAD:${BUNDLE_LAYER}/manifest.json`], { stdio: 'pipe' });
    } catch {
      console.log('[fetch-eor-dats] reference-bundle has no dat-zip layer yet');
      return false;
    }
    console.log('[fetch-eor-dats] restoring zip from reference-bundle dat-zip layer…');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    execFileSync('bash', ['-c', `git archive --format=tar FETCH_HEAD ${BUNDLE_LAYER} | tar -x -C '${work}'`], { cwd: REPO });
    const zip = reassembleFromParts(join(work, BUNDLE_LAYER), join(work, 'ac-updates.zip'));
    if (!zip) return false;
    mkdirSync(DAT_DIR, { recursive: true });
    execFileSync('unzip', ['-o', zip, '-d', DAT_DIR, ...missingNames], { stdio: 'inherit' });
    const stillBad = EXPECTED.filter((e) => validate(join(DAT_DIR, e.name), e) !== null);
    if (stillBad.length) {
      console.warn(`[fetch-eor-dats] bundle restore left invalid DATs: ${stillBad.map((e) => e.name).join(', ')}`);
      return false;
    }
    console.log('[fetch-eor-dats] all DATs restored from reference-bundle — Mega not needed');
    return true;
  } catch (err) {
    console.warn(`[fetch-eor-dats] bundle restore unavailable: ${String(err).split('\n')[0]}`);
    return false;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Best-effort: publish the downloaded zip to reference-bundle as dat-zip/
 *  chunks so no later container ever needs Mega. Never throws. */
function publishToBundle(zipPath) {
  const work = join(tmpdir(), `dat-zip-publish-${process.pid}`);
  const wt = join(tmpdir(), `dat-zip-wt-${process.pid}`);
  try {
    git(['fetch', '--depth', '1', 'origin', BUNDLE_BRANCH], { stdio: 'pipe' });
    try {
      git(['cat-file', '-e', `FETCH_HEAD:${BUNDLE_LAYER}/manifest.json`], { stdio: 'pipe' });
      console.log('[fetch-eor-dats] reference-bundle already carries dat-zip — publish skipped');
      return;
    } catch { /* absent — publish below */ }
    console.log('[fetch-eor-dats] publishing zip to reference-bundle as dat-zip/ chunks…');
    rmSync(work, { recursive: true, force: true });
    splitIntoParts(zipPath, join(work, BUNDLE_LAYER));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        try { git(['worktree', 'remove', '--force', wt], { stdio: 'pipe' }); } catch { /* not registered */ }
        git(['worktree', 'add', '--detach', wt, 'FETCH_HEAD'], { stdio: 'pipe' });
        cpSync(join(work, BUNDLE_LAYER), join(wt, BUNDLE_LAYER), { recursive: true });
        execFileSync('git', ['add', BUNDLE_LAYER], { cwd: wt });
        execFileSync('git', ['-c', 'user.name=acjs-provision', '-c', 'user.email=noreply@anthropic.com',
          'commit', '-m', 'dat-zip: cache EoR ac-updates.zip as 95MB chunks (BUG.dat-provision-mega-quota-self-exhaustion) [skip-tests]'], { cwd: wt });
        // Hooks neutralized like provision-ace-stack.sh --make-bundle: the
        // repo's client hooks are meaningless for a binary-chunk commit on
        // the orphan bundle branch. (No hook runs the suite any more.)
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', `HEAD:refs/heads/${BUNDLE_BRANCH}`], { cwd: wt, stdio: 'pipe' });
        console.log('[fetch-eor-dats] dat-zip layer pushed — future containers restore without Mega');
        return;
      } catch (err) {
        console.warn(`[fetch-eor-dats] publish attempt ${attempt + 1} failed: ${String(err).split('\n')[0]}`);
        try { git(['worktree', 'remove', '--force', wt], { stdio: 'pipe' }); } catch { /* gone */ }
        // Non-FF race with another publisher: refetch and retry once on the new tip.
        try { git(['fetch', '--depth', '1', 'origin', BUNDLE_BRANCH], { stdio: 'pipe' }); } catch { break; }
      }
    }
    console.warn('[fetch-eor-dats] publish abandoned (best-effort) — a later successful cycle will publish');
  } catch (err) {
    console.warn(`[fetch-eor-dats] publish skipped: ${String(err).split('\n')[0]}`);
  } finally {
    try { git(['worktree', 'remove', '--force', wt], { stdio: 'pipe' }); } catch { /* not registered */ }
    rmSync(work, { recursive: true, force: true });
  }
}

/** Restore a raw (unzipped) file from a bundle layer's chunks into dat/. */
function restoreRawFromBundle(layer, exp) {
  const work = join(tmpdir(), `${layer}-restore-${process.pid}`);
  try {
    git(['fetch', '--depth', '1', 'origin', BUNDLE_BRANCH], { stdio: 'pipe' });
    try {
      git(['cat-file', '-e', `FETCH_HEAD:${layer}/manifest.json`], { stdio: 'pipe' });
    } catch {
      console.log(`[fetch-eor-dats] reference-bundle has no ${layer} layer — ${exp.name} not provisioned`);
      return false;
    }
    console.log(`[fetch-eor-dats] restoring ${exp.name} from reference-bundle ${layer} layer…`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    execFileSync('bash', ['-c', `git archive --format=tar FETCH_HEAD ${layer} | tar -x -C '${work}'`], { cwd: REPO });
    mkdirSync(DAT_DIR, { recursive: true });
    const out = reassembleFromParts(join(work, layer), join(DAT_DIR, exp.name));
    if (!out) { rmSync(join(DAT_DIR, exp.name), { force: true }); return false; }
    const problem = validate(join(DAT_DIR, exp.name), exp);
    if (problem) {
      console.warn(`[fetch-eor-dats] restored ${exp.name} invalid (${problem}) — removed`);
      rmSync(join(DAT_DIR, exp.name), { force: true });
      return false;
    }
    console.log(`[fetch-eor-dats] ${exp.name}: restored from reference-bundle`);
    return true;
  } catch (err) {
    console.warn(`[fetch-eor-dats] ${layer} restore unavailable: ${String(err).split('\n')[0]}`);
    return false;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Best-effort: publish a raw file to reference-bundle as `layer/` chunks. Never throws. */
function publishRawToBundle(layer, filePath, message) {
  const work = join(tmpdir(), `${layer}-publish-${process.pid}`);
  const wt = join(tmpdir(), `${layer}-wt-${process.pid}`);
  try {
    git(['fetch', '--depth', '1', 'origin', BUNDLE_BRANCH], { stdio: 'pipe' });
    try {
      git(['cat-file', '-e', `FETCH_HEAD:${layer}/manifest.json`], { stdio: 'pipe' });
      console.log(`[fetch-eor-dats] reference-bundle already carries ${layer} — publish skipped`);
      return;
    } catch { /* absent — publish below */ }
    console.log(`[fetch-eor-dats] publishing ${basename(filePath)} to reference-bundle as ${layer}/ chunks…`);
    rmSync(work, { recursive: true, force: true });
    splitIntoParts(filePath, join(work, layer));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        try { git(['worktree', 'remove', '--force', wt], { stdio: 'pipe' }); } catch { /* not registered */ }
        git(['worktree', 'add', '--detach', wt, 'FETCH_HEAD'], { stdio: 'pipe' });
        cpSync(join(work, layer), join(wt, layer), { recursive: true });
        execFileSync('git', ['add', layer], { cwd: wt });
        execFileSync('git', ['-c', 'user.name=acjs-provision', '-c', 'user.email=noreply@anthropic.com', 'commit', '-m', message], { cwd: wt });
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', `HEAD:refs/heads/${BUNDLE_BRANCH}`], { cwd: wt, stdio: 'pipe' });
        console.log(`[fetch-eor-dats] ${layer} layer pushed — future containers restore it from the bundle`);
        return;
      } catch (err) {
        console.warn(`[fetch-eor-dats] ${layer} publish attempt ${attempt + 1} failed: ${String(err).split('\n')[0]}`);
        try { git(['worktree', 'remove', '--force', wt], { stdio: 'pipe' }); } catch { /* gone */ }
        try { git(['fetch', '--depth', '1', 'origin', BUNDLE_BRANCH], { stdio: 'pipe' }); } catch { break; }
      }
    }
    console.warn(`[fetch-eor-dats] ${layer} publish abandoned (best-effort)`);
  } catch (err) {
    console.warn(`[fetch-eor-dats] ${layer} publish skipped: ${String(err).split('\n')[0]}`);
  } finally {
    try { git(['worktree', 'remove', '--force', wt], { stdio: 'pipe' }); } catch { /* not registered */ }
    rmSync(work, { recursive: true, force: true });
  }
}

/** client_highres.dat: keep a valid local copy (publishing it if the bundle lacks the layer), else restore from the bundle. */
function ensureHighRes() {
  const path = join(DAT_DIR, HIGHRES.name);
  const problem = validate(path, HIGHRES);
  if (!problem) {
    console.log(`[fetch-eor-dats] ${HIGHRES.name}: ok`);
    publishRawToBundle(HIGHRES_LAYER, path, 'dat-highres: cache client_highres.dat (iteration 497, the HiFi DAT for Very High texture detail — CORE.17.h.g.c.d) as 95MB chunks [skip-tests]');
    return true;
  }
  console.log(`[fetch-eor-dats] ${HIGHRES.name}: ${problem}`);
  return restoreRawFromBundle(HIGHRES_LAYER, HIGHRES);
}

// ── --highres-only: just the client_highres.dat step (restore or publish) ──
if (process.argv.includes('--highres-only')) {
  process.exit(ensureHighRes() ? 0 : 1);
}

// ── --self-test: chunk codec round-trip on a synthetic file, no network ──
if (process.argv.includes('--self-test')) {
  const dir = join(tmpdir(), `dat-zip-selftest-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const src = join(dir, 'synthetic.bin');
  // 10MB of random bytes split at 3MB → 4 parts incl. a short tail.
  writeFileSync(src, randomBytes(10 * 1024 * 1024));
  const manifest = splitIntoParts(src, join(dir, BUNDLE_LAYER), 3 * 1024 * 1024);
  if (manifest.parts.length !== 4) throw new Error(`expected 4 parts, got ${manifest.parts.length}`);
  const partsTotal = manifest.parts.reduce((s, p) => s + p.size, 0);
  if (partsTotal !== manifest.size) throw new Error(`parts total ${partsTotal} != size ${manifest.size}`);
  const out = reassembleFromParts(join(dir, BUNDLE_LAYER), join(dir, 'reassembled.bin'));
  if (!out) throw new Error('reassembly failed');
  if (sha256File(out) !== manifest.sha256) throw new Error('sha256 mismatch after round-trip');
  // Corruption must be detected: flip one byte in part 1, expect null.
  const p1 = join(dir, BUNDLE_LAYER, manifest.parts[1].name);
  const raw = readFileSync(p1);
  raw[1000] ^= 0xff;
  writeFileSync(p1, raw);
  if (reassembleFromParts(join(dir, BUNDLE_LAYER), join(dir, 'corrupt.bin')) !== null) {
    throw new Error('corrupted part was not detected');
  }
  rmSync(dir, { recursive: true, force: true });
  console.log('[fetch-eor-dats] --self-test PASS (split/manifest/reassemble/corruption-detect)');
  process.exit(0);
}

function validate(path, exp) {
  if (!existsSync(path)) return `missing`;
  const actual = statSync(path).size;
  if (actual !== exp.size) return `size ${actual} != expected ${exp.size}`;
  // DAT header lives at offset 0x140: FileType, BlockSize, FileSize, DataSet.
  const buf = Buffer.alloc(16);
  const fd = openSync(path, 'r');
  readSync(fd, buf, 0, 16, 0x140);
  closeSync(fd);
  const fileType = buf.readUInt32LE(0);
  const blockSize = buf.readUInt32LE(4);
  const fileSize = buf.readUInt32LE(8);
  const dataSet = buf.readUInt32LE(12);
  if (fileType !== 0x5442) return `bad FileType 0x${fileType.toString(16)}`;
  if (blockSize !== exp.blockSize) return `bad BlockSize ${blockSize}`;
  if (fileSize !== exp.size) return `header FileSize ${fileSize} != ${exp.size}`;
  if (dataSet !== exp.dataSet) return `bad DataSet ${dataSet}`;
  return null; // valid
}

const missing = EXPECTED.filter((e) => {
  const problem = validate(join(DAT_DIR, e.name), e);
  if (problem) console.log(`[fetch-eor-dats] ${e.name}: ${problem}`);
  else console.log(`[fetch-eor-dats] ${e.name}: ok`);
  return problem !== null;
});

if (missing.length === 0) {
  console.log('[fetch-eor-dats] all DATs present and valid — nothing to do');
  ensureHighRes();
  process.exit(0);
}

// Chunked cache on the reference-bundle branch first — Mega is the fallback.
if (restoreFromBundle(missing.map((e) => e.name))) {
  ensureHighRes();
  process.exit(0);
}

console.log(`[fetch-eor-dats] fetching EoR package from Mega (~507MB)…`);
const { File } = await import('megajs');
const file = File.fromURL(MEGA_URL);
await file.loadAttributes();
console.log(`[fetch-eor-dats] remote: ${file.name} (${file.size} bytes)`);

const zipPath = join(tmpdir(), 'ac-eor-dats.zip');
await new Promise((resolve, reject) => {
  const stream = file.download();
  let done = 0;
  let lastPct = -1;
  stream.on('data', (c) => {
    done += c.length;
    const pct = Math.floor((done / file.size) * 100);
    if (pct !== lastPct && pct % 10 === 0) {
      console.log(`[fetch-eor-dats] ${pct}%`);
      lastPct = pct;
    }
  });
  stream.on('error', reject);
  const out = createWriteStream(zipPath);
  out.on('error', reject);
  out.on('finish', resolve);
  stream.pipe(out);
});

mkdirSync(DAT_DIR, { recursive: true });
execFileSync('unzip', ['-o', zipPath, '-d', DAT_DIR, ...missing.map((e) => e.name)], { stdio: 'inherit' });

let failed = false;
for (const e of EXPECTED) {
  const problem = validate(join(DAT_DIR, e.name), e);
  if (problem) {
    console.error(`[fetch-eor-dats] FAILED validation after extract — ${e.name}: ${problem}`);
    failed = true;
  } else {
    console.log(`[fetch-eor-dats] ${e.name}: valid`);
  }
}
// Cache the validated zip for every future container BEFORE deleting it —
// winning a Mega quota window is rare (see header), so never waste one.
if (!failed) publishToBundle(zipPath);
unlinkSync(zipPath);
ensureHighRes();
process.exit(failed ? 1 : 0);
