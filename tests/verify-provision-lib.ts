/**
 * tools/provision-lib.sh needs_rebuild (OPS.screen-regression-thresholds):
 * provision-remote-env.sh regenerates symbols/globals.tsv and the annotated
 * decomp when they are missing OR older than any input (the tools that build
 * them, the pdb/exe, the plain decomp) — they used to be built only when absent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LIB = resolve(__dirname, '..', 'tools', 'provision-lib.sh');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'provision-lib-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (name: string, body: string, mtimeSec: number) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  utimesSync(p, mtimeSec, mtimeSec);
  return p;
};
const needsRebuild = (out: string, ...inputs: string[]) =>
  spawnSync('bash', ['-c', `source "${LIB}"; needs_rebuild "$@"`, 'x', out, ...inputs]).status === 0;

describe('needs_rebuild', () => {
  it('rebuilds a missing or empty output', () => {
    const tool = file('annotate.ts', 'x', 1000);
    expect(needsRebuild(join(dir, 'nope.c'), tool)).toBe(true);
    expect(needsRebuild(file('empty.c', '', 2000), tool)).toBe(true);
  });
  it('rebuilds when any input is newer than the output (a fixed annotator, a re-exported decomp)', () => {
    const out = file('annotated.c', 'old', 2000);
    const tool = file('annotate.ts', 'x', 1000);
    const decomp = file('decomp.c', 'x', 1500);
    expect(needsRebuild(out, tool, decomp)).toBe(false);
    utimesSync(tool, 3000, 3000);
    expect(needsRebuild(out, tool, decomp)).toBe(true);
  });
  it('ignores inputs that do not exist', () => {
    const out = file('globals.tsv', 'x', 2000);
    expect(needsRebuild(out, join(dir, 'acclient.exe'), file('pdb', 'x', 1000))).toBe(false);
  });
});
