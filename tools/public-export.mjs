/**
 * RELEASE.open-source-repo — export the public mirror of a ref.
 *
 *   node tools/public-export.mjs --check [--ref <ref>]
 *       Print the report only. Exit 1 when the scan fails.
 *   node tools/public-export.mjs --out <dir> [--ref <ref>]
 *       Write the public tree of <ref> (default HEAD) into <dir> (must not
 *       exist or be empty) and print the report. Exit 1 when the scan fails.
 *   node tools/public-export.mjs --publish <clone> [--ref <ref>] [--push [--branch main]]
 *       Replace <clone>'s working tree (a clone of the public repository) with
 *       the export, commit "Sync to <sha>" when anything changed, and push
 *       with --push. Nothing is written when the scan fails.
 *
 * Rules and scanners: tools/public-export-lib.mjs. Process: docs/open-source-release.md.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { classifyFile, isPublicPath, looksBinary, namesPrivateFile, privateExecutables, publicPathFor } from './public-export-lib.mjs';

const REPO = resolve(dirname(new URL(import.meta.url).pathname), '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const git = (args, opts = {}) => execFileSync('git', ['-C', REPO, ...args], { maxBuffer: 1 << 30, ...opts });

/** Every file at `ref`: [{ mode, sha, path }]. */
function listTree(ref) {
  const out = git(['ls-tree', '-r', '-z', ref]).toString('utf8');
  return out.split('\0').filter(Boolean).map((row) => {
    const [meta, path] = row.split('\t');
    const [mode, , sha] = meta.split(' ');
    return { mode, sha, path };
  });
}

/** Blob contents by sha, one `git cat-file --batch` call. */
function readBlobs(shas) {
  const out = git(['cat-file', '--batch'], { input: shas.join('\n') + '\n' });
  const blobs = new Map();
  let pos = 0;
  for (const sha of shas) {
    const nl = out.indexOf(10, pos);
    const size = Number(out.subarray(pos, nl).toString().split(' ')[2]);
    blobs.set(sha, out.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return blobs;
}

/** Export `ref`: { sha, files: [{ path, mode, data }], dropped, failures }. */
export function buildExport(ref) {
  const sha = git(['rev-parse', ref]).toString().trim();
  const tree = listTree(sha);
  const privatePaths = privateExecutables(tree.map((e) => e.path));
  const entries = tree.filter((e) => isPublicPath(e.path) && e.mode !== '160000');
  const blobs = readBlobs([...new Set(entries.map((e) => e.sha))]);
  const files = [];
  const dropped = [];
  const failures = [];
  for (const e of entries) {
    const data = blobs.get(e.sha);
    const text = looksBinary(data) ? null : data.toString('utf8');
    let verdict = classifyFile(e.path, text);
    if (verdict.action === 'keep' && text !== null && e.path.startsWith('tests/') && !e.path.startsWith('tests/_harness/')) {
      const named = namesPrivateFile(text, privatePaths);
      if (named) verdict = { action: 'drop', reason: `exercises private ${named}` };
    }
    if (verdict.action === 'keep') files.push({ path: publicPathFor(e.path), mode: e.mode, data });
    else (verdict.action === 'drop' ? dropped : failures).push({ path: e.path, reason: verdict.reason, hits: verdict.hits });
  }
  return { sha, files, dropped, failures };
}

function writeTree(dir, files) {
  for (const f of files) {
    const p = join(dir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    if (f.mode === '120000') symlinkSync(f.data.toString('utf8'), p);
    else {
      writeFileSync(p, f.data);
      if (f.mode === '100755') chmodSync(p, 0o755);
    }
  }
}

function printReport(r) {
  console.log(`[public-export] ${r.sha.slice(0, 12)}: ${r.files.length} files kept, ${r.dropped.length} tests dropped, ${r.failures.length} failures`);
  for (const d of r.dropped) console.log(`  dropped ${d.path} (${d.reason}, ${d.hits?.length ?? 0} lines)`);
  for (const f of r.failures) {
    console.log(`  FAIL ${f.path}: ${f.reason}`);
    for (const h of (f.hits ?? []).slice(0, 5)) console.log(`      :${h.line} ${h.text}`);
  }
}

function main() {
  const ref = arg('--ref') ?? 'HEAD';
  const out = arg('--out');
  const clone = arg('--publish');
  const check = process.argv.includes('--check');
  if ([check, !!out, !!clone].filter(Boolean).length !== 1) {
    console.error('usage: public-export.mjs (--check | --out <dir> | --publish <clone> [--push [--branch main]]) [--ref <ref>]');
    process.exit(2);
  }
  const r = buildExport(ref);
  printReport(r);
  if (r.failures.length) {
    console.error('[public-export] scan failed; nothing written');
    process.exit(1);
  }
  if (check) return;
  if (out) {
    if (existsSync(out) && readdirSync(out).length) { console.error(`[public-export] ${out} is not empty`); process.exit(2); }
    writeTree(out, r.files);
    console.log(`[public-export] wrote ${out}`);
    return;
  }
  if (!existsSync(join(clone, '.git'))) { console.error(`[public-export] ${clone} is not a git clone`); process.exit(2); }
  for (const name of readdirSync(clone)) if (name !== '.git') rmSync(join(clone, name), { recursive: true, force: true });
  writeTree(clone, r.files);
  const cg = (args) => execFileSync('git', ['-C', clone, ...args], { stdio: 'pipe' }).toString();
  cg(['add', '-A']);
  if (!cg(['status', '--porcelain']).trim()) { console.log('[public-export] public tree already matches'); return; }
  cg(['commit', '-q', '-m', `Sync to ${r.sha.slice(0, 12)}`]);
  console.log(`[public-export] committed sync to ${r.sha.slice(0, 12)}`);
  if (process.argv.includes('--push')) {
    const branch = arg('--branch') ?? 'main';
    execFileSync('git', ['-C', clone, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { stdio: 'inherit' });
    console.log('[public-export] pushed');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
