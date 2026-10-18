/**
 * The off-host image flow (docs/aws-hosting.md, "Images"; 2026-10-17: building on the
 * 2 GB EC2 host swapped it for minutes and dropped a live player).
 *
 * tools/image-source.sh decides which commit an image is built for: the newest commit at
 * or before the deployed one that changed a file in the service's railway.json
 * watchPatterns. Later commits that changed nothing the service is built from get the
 * same image (a new tag, no build), so the host switches only when the digest changes.
 *
 * tools/lib/deploy-gate.sh is the local test gate: tools/ci-local.sh stamps the exact
 * commit it passed, and tools/deploy-aws.sh / tools/build-push-images.sh refuse a commit
 * without a stamp unless --skip-gate (loud). Stamps live in the git common dir, so every
 * worktree of a clone sees them.
 *
 * Both run here as the real scripts against throwaway git repos.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '..');
const IMAGE_SOURCE = join(REPO, 'tools/image-source.sh');
const GATE = join(REPO, 'tools/lib/deploy-gate.sh');

const WEB_WATCH = ['packages/**', 'services/**', 'deploy/web/**', 'package.json'];
const BRIDGE_WATCH = ['services/ws-tcp-bridge/**', 'packages/network/src/Hash32.ts'];

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim();
}

function commit(dir: string, files: Record<string, string>, msg: string): string {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

const source = (dir: string, svc: string, sha: string) =>
  execFileSync('bash', [IMAGE_SOURCE, dir, svc, sha], { encoding: 'utf8' }).trim();

describe('tools/image-source.sh: the commit each image is built for', () => {
  let dir = '';
  const c: Record<string, string> = {};
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'acjs-image-source-'));
    git(dir, 'init', '-q');
    c.base = commit(dir, {
      'deploy/web/railway.json': JSON.stringify({ build: { watchPatterns: WEB_WATCH } }),
      'services/ws-tcp-bridge/railway.json': JSON.stringify({ build: { watchPatterns: BRIDGE_WATCH } }),
      'packages/renderer/src/a.ts': 'a',
    }, 'base');
    c.docs = commit(dir, { 'docs/notes.md': 'notes' }, 'docs only');
    c.client = commit(dir, { 'packages/renderer/src/a.ts': 'a2' }, 'client change');
    c.bridge = commit(dir, { 'services/ws-tcp-bridge/src/bridge.ts': 'b' }, 'bridge change');
    c.hash = commit(dir, { 'packages/network/src/Hash32.ts': 'h' }, 'a file both watch');
    c.nested = commit(dir, { 'packages/network/src/era1999/Hash32.ts': 'x' }, 'a lookalike path only web watches');
    c.tail = commit(dir, { 'progress.md': 'p' }, 'log only');
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('a commit that changed nothing a service is built from maps to the last one that did', () => {
    expect(source(dir, 'web', c.docs)).toBe(c.base);
    expect(source(dir, 'bridge', c.docs)).toBe(c.base);
    expect(source(dir, 'bridge', c.client)).toBe(c.base);
    expect(source(dir, 'web', c.tail)).toBe(c.nested);
    expect(source(dir, 'bridge', c.tail)).toBe(c.hash);
  });

  it('a commit that changed a watched file is its own source', () => {
    expect(source(dir, 'web', c.client)).toBe(c.client);
    expect(source(dir, 'web', c.bridge)).toBe(c.bridge); // web watches services/**
    expect(source(dir, 'bridge', c.bridge)).toBe(c.bridge);
    expect(source(dir, 'bridge', c.hash)).toBe(c.hash);
  });

  it('`*`/`**` follow Railway: an exact path does not match the same name elsewhere', () => {
    expect(source(dir, 'bridge', c.nested)).toBe(c.hash);
    expect(source(dir, 'web', c.nested)).toBe(c.nested);
  });

  it('refuses an unknown service', () => {
    expect(spawnSync('bash', [IMAGE_SOURCE, dir, 'db', c.tail]).status).toBe(2);
  });
});

describe('tools/lib/deploy-gate.sh: the local gate stamp', () => {
  let dir = '';
  let wt = '';
  let sha = '';
  const gate = (fn: string, env: Record<string, string> = {}) =>
    spawnSync('bash', ['-c', `set -euo pipefail; . "${GATE}"; ${fn}`], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: '', ...env },
    });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'acjs-gate-'));
    git(dir, 'init', '-q');
    commit(dir, { 'a.txt': 'a' }, 'one');
    sha = commit(dir, { 'a.txt': 'b' }, 'two');
    wt = `${dir}-wt`;
    git(dir, 'worktree', 'add', '-q', '--detach', wt, 'HEAD~1');
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (wt) rmSync(wt, { recursive: true, force: true });
  });

  it('refuses an unstamped commit and prints the exact command', () => {
    const r = gate(`gate_check "${dir}" ${sha} 0`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`bash ${dir}/tools/ci-local.sh`);
    expect(r.stderr).toContain('--skip-gate');
  });

  it('names a worktree recipe for a commit that is not HEAD', () => {
    const older = git(dir, 'rev-parse', 'HEAD~1');
    const r = gate(`gate_check "${dir}" ${older} 0`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`worktree add --detach /tmp/acjs-gate-${older.slice(0, 12)} ${older}`);
    expect(r.stderr).toContain('ci-local.sh --ci-shape');
  });

  it('--skip-gate passes with a loud warning; CI passes on its own test job', () => {
    const skipped = gate(`gate_check "${dir}" ${sha} 1`);
    expect(skipped.status).toBe(0);
    expect(skipped.stderr).toContain('WARNING: --skip-gate');
    expect(gate(`gate_check "${dir}" ${sha} 0`, { GITHUB_ACTIONS: 'true' }).status).toBe(0);
  });

  it('a stamp passes that exact commit, from any worktree of the clone, and no other', () => {
    expect(gate(`gate_stamp "${wt}" ${sha} full`).status).toBe(0);
    const r = gate(`gate_check "${dir}" ${sha} 0`);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/passed tools\/ci-local\.sh at \d{4}-\d\d-\d\dT/);
    expect(gate(`gate_check "${dir}" ${git(dir, 'rev-parse', 'HEAD~1')} 0`).status).toBe(1);
  });
});
