/**
 * An AC1999 server's login DAT push, prepared ahead (BUG.ac1999-slow-login-ddd-push).
 *
 * The AC1999 server pushes every record of its patched DATs that differs from what a client at
 * the pristine iterations (102 / 67) holds before that client's character list (reference/ac1999
 * Server Client.cpp UpdateLoginScreen → PlanDatSync; the rule is TurbineData.cpp GetSyncPlan).
 * A browser's first visit waits 10-14 s for it. A seed is that push, built here and published
 * beside the 1999 world set (publish-dats-r2.ts --server-seed / --seed-only): the client applies
 * it where nothing is stored (era/Ac1999World.ts), so a first visit reports the server's
 * iteration and is sent nothing. Format: packages/dat-parser/src/era1999/ServerPatchSeed.ts.
 *
 *   npx tsx tools/ac1999-dat-seed.ts build --server-dats <dir> [--pristine <dir>] [--out <file>]
 *       Plan the push from server-level DATs (portal.dat + cell.dat): the server's own patched
 *       files (the AC1999 repo's `DatInspector/patching/dat_patch.py build` output), or a retail
 *       client's DATs that server synced. --check-manifests <dir> first checks our reading of the
 *       pristine DATs against the server's manifests for them (portal-102.manifest, cell-67.manifest).
 *   npx tsx tools/ac1999-dat-seed.ts build --capture <capture.json> [--server-key <k>] [--seed <file>] [--out <file>]
 *       The same from a real push a browser stored (CAPTURE_SNIPPET's download).
 *   npx tsx tools/ac1999-dat-seed.ts compare <a> <b> [--pristine <dir>] [--server-key <k>] [--seed <file>]
 *       Byte-for-byte: each of <a>, <b> is a seed file, a capture (.json) or a directory of
 *       server-level DATs. Exit 0 when identical, 1 when not.
 *   npx tsx tools/ac1999-dat-seed.ts verify <source> --server-manifests <dir>
 *       Check a seed (any source) against the server's own manifests for its iterations
 *       (ServerModes/<Mode>/Data/manifests on the server): exactly the records it pushes, each
 *       with the size and crc32 it recorded. Needs none of the server's DATs.
 *   npx tsx tools/ac1999-dat-seed.ts snippet      the DevTools snippet that downloads a capture
 *   npx tsx tools/ac1999-dat-seed.ts show <seed>  a seed's iterations and records
 *
 * --pristine defaults to dat-sets/ac1999-retail (the DATs the world set is built from).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeServerPatchSeed, type ServerPatchSeed } from '../packages/dat-parser/src/era1999/ServerPatchSeed.js';
import {
  CAPTURE_SNIPPET, DAT_FILES, checkPristineAgainstManifests, compareSeeds, datIteration, hex8, parseCapture, planSeedFromDats,
  readSeedFile, seedFromCapture, seedHash, verifyAgainstServerManifests,
} from './lib/ac1999-seed.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (f: string, d: string | null = null) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--')));
const pristineDir = resolve(opt('--pristine', join(REPO, 'dat-sets/ac1999-retail'))!);
const serverKey = opt('--server-key') ?? undefined;

function baseIterations() {
  return { portal: datIteration(join(pristineDir, DAT_FILES.portal)), cell: datIteration(join(pristineDir, DAT_FILES.cell)) };
}

function overSeed(): { id: string; seed: ServerPatchSeed } | undefined {
  const p = opt('--seed');
  return p ? readSeedFile(new Uint8Array(readFileSync(resolve(p)))) : undefined;
}

/** A seed from any source: a directory of server-level DATs, a capture (.json), or a seed file. */
function load(source: string): { label: string; seed: ServerPatchSeed } {
  const path = resolve(source);
  if (statSync(path).isDirectory()) {
    const { seed, plans } = planSeedFromDats(pristineDir, path);
    for (const dat of ['portal', 'cell'] as const) {
      const p = plans[dat];
      console.log(`[seed] ${dat}: ${seed.base[dat]} → ${seed.iterations[dat]}: ${p.files.length} record(s), ${p.rawBytes} raw bytes${p.unremovable ? `, ${p.unremovable} the client keeps (DDD has no delete)` : ''}`);
    }
    return { label: 'dats', seed };
  }
  if (path.endsWith('.json')) {
    const capture = parseCapture(JSON.parse(readFileSync(path, 'utf8')), serverKey);
    console.log(`[seed] capture ${capture.serverKey}: iterations ${capture.iterations.portal} / ${capture.iterations.cell}, ${capture.records.length} record(s)${capture.seedId ? `, stored over seed ${capture.seedId}` : ''}`);
    return { label: 'capture', seed: seedFromCapture(capture, baseIterations(), overSeed()) };
  }
  const { id, seed } = readSeedFile(new Uint8Array(readFileSync(path)));
  console.log(`[seed] seed ${id}: ${seed.base.portal} / ${seed.base.cell} → ${seed.iterations.portal} / ${seed.iterations.cell}, ${seed.records.length} record(s)`);
  return { label: 'seed', seed };
}

function describe(seed: ServerPatchSeed, id: string): void {
  console.log(`seed ${id}: base ${seed.base.portal} / ${seed.base.cell} → server ${seed.iterations.portal} / ${seed.iterations.cell}`);
  for (const dat of ['portal', 'cell'] as const) {
    const rs = seed.records.filter((r) => r.dat === dat);
    // portal: by file type (id >> 24); cell: terrain (xxxxFFFF), landblock info (xxxxFFFE), env cells.
    const kindOf = (id: number) => dat === 'portal' ? `0x${(id >>> 24).toString(16).padStart(2, '0')}`
      : (id & 0xffff) === 0xffff ? 'terrain' : (id & 0xffff) === 0xfffe ? 'info' : 'envcell';
    const byKind = new Map<string, number>();
    for (const r of rs) byKind.set(kindOf(r.id), (byKind.get(kindOf(r.id)) ?? 0) + 1);
    const classes = [...byKind].sort((a, b) => a[0].localeCompare(b[0])).map(([c, n]) => `${c}×${n}`).join(' ');
    console.log(`  ${dat}: ${rs.length} record(s), ${rs.reduce((s, r) => s + r.bytes.length, 0)} bytes${classes ? `  (${classes})` : ''}`);
  }
  if (argv.includes('--list')) for (const r of seed.records) console.log(`    ${r.dat} ${hex8(r.id)} ${r.bytes.length}`);
}

function main(): number {
  if (cmd === 'snippet') { console.log(CAPTURE_SNIPPET); return 0; }
  if (cmd === 'show') {
    const bytes = new Uint8Array(readFileSync(resolve(positional[0])));
    describe(readSeedFile(bytes).seed, seedHash(bytes));
    return 0;
  }
  if (cmd === 'build') {
    const serverDats = opt('--server-dats');
    const capture = opt('--capture');
    if (!serverDats === !capture) throw new Error('build: give --server-dats <dir> or --capture <file>');
    const manifests = opt('--check-manifests');
    if (manifests) {
      const problems = checkPristineAgainstManifests(pristineDir, resolve(manifests));
      if (problems.length) { console.error(`[seed] our reading of ${pristineDir} disagrees with the server's manifests:\n  ${problems.slice(0, 20).join('\n  ')}`); return 1; }
      console.log(`[seed] ${pristineDir}: every record matches the server's manifests in ${manifests}`);
    }
    const { seed } = load(serverDats ?? capture!);
    if (seed.iterations.portal === seed.base.portal && seed.iterations.cell === seed.base.cell) throw new Error('the server is at the pristine iterations: there is nothing to seed');
    const payload = encodeServerPatchSeed(seed);
    const out = resolve(opt('--out', join(REPO, `dat-sets/ac1999-seeds/seed-p${seed.iterations.portal}-c${seed.iterations.cell}.acss`))!);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, payload);
    describe(seed, seedHash(payload));
    console.log(`wrote ${out} (${payload.length} bytes)`);
    return 0;
  }
  if (cmd === 'verify') {
    const dir = opt('--server-manifests');
    if (positional.length !== 1 || !dir) throw new Error('verify: one source and --server-manifests <dir>');
    const problems = verifyAgainstServerManifests(load(positional[0]).seed, pristineDir, resolve(dir));
    for (const p of problems.slice(0, 50)) console.log(p);
    console.log(problems.length ? `NOT the server's push (${problems.length} problem(s))` : 'MATCHES the server\'s manifests');
    return problems.length ? 1 : 0;
  }
  if (cmd === 'compare') {
    if (positional.length !== 2) throw new Error('compare: two sources (seed file, capture .json, or a directory of server-level DATs)');
    const a = load(positional[0]);
    const b = load(positional[1]);
    if (a.label === b.label) { a.label += '#1'; b.label += '#2'; }
    const r = compareSeeds(a, b);
    for (const l of r.lines) console.log(l);
    return r.identical ? 0 : 1;
  }
  console.error('usage: npx tsx tools/ac1999-dat-seed.ts build|compare|snippet|show … (see the header comment)');
  return 2;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`[seed] ${(err as Error).message}`);
  process.exitCode = 2;
}
