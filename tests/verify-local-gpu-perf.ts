/**
 * tools/local-gpu-perf.sh (OPS.gpu-perf-job-safety): the nightly real-GPU job
 * must not boot a live testacjs session (ACE account_login_boots_in_use
 * defaults TRUE, PropertyManager.cs:501), and must only commit a run whose
 * measure-perf exit was 0. Drives the real script + its sourced lib with
 * stubbed `lsof` / `git` on PATH.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const LIB = join(ROOT, 'tools', 'local-gpu-perf-lib.sh');
const SCRIPT = join(ROOT, 'tools', 'local-gpu-perf.sh');

let dir: string, bin: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gpu-perf-'));
  bin = join(dir, 'bin');
  mkdirSync(bin);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stub(name: string, body: string) {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
}
/** `lsof ... -sTCP:ESTABLISHED -Fn` stub: prints `established` lines, exits 1 when empty (like lsof). */
function stubLsof(established: string[]) {
  const out = established.map((n, i) => `p${100 + i}\nf${10 + i}\nn${n}`).join('\n');
  stub('lsof', `case "$*" in *ESTABLISHED*) ${out ? `printf '%s\\n' '${out.replace(/\n/g, "' '")}'; exit 0` : 'exit 1'} ;; esac; exit 1`);
}
function lib(expr: string) {
  const r = spawnSync('bash', ['-c', `source "${LIB}"; ${expr}`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  return r.stdout.trim();
}

describe('local-gpu-perf-lib: live-session probe (bridge :9090)', () => {
  it('counts established sockets on the bridge port (both ends of a local browser connection)', () => {
    stubLsof(['127.0.0.1:9090->127.0.0.1:55012', '127.0.0.1:55012->127.0.0.1:9090']);
    expect(lib('gpu_perf_bridge_sessions 9090')).toBe('2');
  });
  it('reports 0 when lsof finds nothing (exit 1, no output)', () => {
    stubLsof([]);
    expect(lib('gpu_perf_bridge_sessions 9090')).toBe('0');
  });
});

describe('local-gpu-perf-lib: only a clean run is committed', () => {
  it('maps measure-perf exit codes: 0 commit, 2 regression, 3 no-gpu, anything else failure', () => {
    expect(lib('for rc in 0 1 2 3 130; do gpu_perf_disposition $rc; done').split('\n'))
      .toEqual(['commit', 'failure', 'regression', 'no-gpu', 'failure']);
  });
});

describe('local-gpu-perf.sh end to end: skips while a client is connected', () => {
  it('exits 0 with a SKIP log line and never touches git when the bridge has a live connection', () => {
    stubLsof(['127.0.0.1:9090->127.0.0.1:55012']);
    const marker = join(dir, 'git-ran');
    stub('git', `touch "${marker}"; exit 0`);
    const home = join(dir, 'home');
    mkdirSync(home);
    const r = spawnSync('bash', [SCRIPT], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const log = readFileSync(join(home, 'Library', 'Logs', 'acjs', 'gpu-perf.log'), 'utf8');
    expect(log).toMatch(/SKIP \(before start\): 1 established connection\(s\) on the bridge port :9090/);
    expect(log).toMatch(/account_login_boots_in_use/);
    expect(existsSync(marker)).toBe(false);
  });
});
