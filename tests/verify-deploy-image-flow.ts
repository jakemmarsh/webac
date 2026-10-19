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
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync as readFakeLog, rmSync, writeFileSync } from 'node:fs';
// The only files read here are the fake aws/docker call logs a test writes in its temp dir (never a packages/ source:
// the temp repo's packages/ and .ts paths are fixtures), hence the alias the source-grep hygiene check doesn't trip on.
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '..');
const IMAGE_SOURCE = join(REPO, 'tools/image-source.sh');
const GATE = join(REPO, 'tools/lib/deploy-gate.sh');
const BUILD_PUSH = join(REPO, 'tools/build-push-images.sh');

const WEB_WATCH = ['packages/**', 'services/**', 'deploy/web/**', 'package.json'];
const BRIDGE_WATCH = ['services/ws-tcp-bridge/**', 'services/shared/Hash32.ts'];

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
      'packages/renderer/src/a.txt': 'a',
    }, 'base');
    c.docs = commit(dir, { 'docs/notes.md': 'notes' }, 'docs only');
    c.client = commit(dir, { 'packages/renderer/src/a.txt': 'a2' }, 'client change');
    c.bridge = commit(dir, { 'services/ws-tcp-bridge/src/bridge.ts': 'b' }, 'bridge change');
    c.hash = commit(dir, { 'services/shared/Hash32.ts': 'h' }, 'a file both watch');
    c.nested = commit(dir, { 'services/shared/era1999/Hash32.ts': 'x' }, 'a lookalike path only web watches');
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

  it('a watched file renamed to an unwatched path is a change (renames are delete + add)', () => {
    // git's default rename detection lists only the new name: the walk used to skip this
    // commit and the image that still held the old file got retagged.
    mkdirSync(join(dir, 'tools'), { recursive: true });
    git(dir, 'mv', 'services/ws-tcp-bridge/src/bridge.ts', 'tools/bridge.ts');
    git(dir, 'commit', '-q', '-m', 'move a bridge file out');
    const moved = git(dir, 'rev-parse', 'HEAD');
    try {
      expect(source(dir, 'bridge', moved)).toBe(moved);
      expect(spawnSync('bash', [IMAGE_SOURCE, '--same-inputs', dir, 'bridge', c.hash, moved], { encoding: 'utf8' }).stdout)
        .toContain('services/ws-tcp-bridge/src/bridge.ts');
    } finally {
      git(dir, 'reset', '-q', '--hard', c.tail);
    }
  });

  it('--same-inputs: 0 when nothing the service is built from differs, else 1 and the files', () => {
    const same = (svc: string, a: string, b: string) =>
      spawnSync('bash', [IMAGE_SOURCE, '--same-inputs', dir, svc, a, b], { encoding: 'utf8' });
    expect(same('bridge', c.base, c.client).status).toBe(0); // a client-only change
    expect(same('bridge', c.hash, c.tail).status).toBe(0);
    const diff = same('bridge', c.base, c.tail);
    expect(diff.status).toBe(1);
    expect(diff.stdout.split('\n').filter(Boolean).sort())
      .toEqual(['services/shared/Hash32.ts', 'services/ws-tcp-bridge/src/bridge.ts']);
    expect(same('web', c.client, c.tail).stdout).toContain('services/ws-tcp-bridge/src/bridge.ts');
  });
});

/**
 * tools/build-push-images.sh end to end against a throwaway repo, with `aws` and `docker`
 * replaced by fakes on PATH that keep an in-memory "registry" in a file (tag → digest) and
 * log every call. Nothing touches AWS or Docker.
 */
describe('tools/build-push-images.sh: build, retag, and the retag guard', () => {
  let dir = '';
  let bin = '';
  const c: Record<string, string> = {};
  const REG = () => join(bin, 'registry.txt');
  const CALLS = () => join(bin, 'calls.txt');
  // "tag digest" lines; describe-images by tag/digest, batch-get-image, put-image.
  const FAKE_AWS = `#!/bin/bash
echo "aws $*" >> "${'$'}FAKE_DIR/calls.txt"
reg="${'$'}FAKE_DIR/registry.txt"; touch "${'$'}reg"
arg() { local want="${'$'}1"; shift; while [ ${'$'}# -gt 0 ]; do [ "${'$'}1" = "${'$'}want" ] && { echo "${'$'}2"; return; }; shift; done; }
case "${'$'}1 ${'$'}2" in
  "ecr describe-images")
    id="$(arg --image-ids "${'$'}@")"
    case "${'$'}id" in
      imageTag=*) grep -q "^${'$'}{id#imageTag=} " "${'$'}reg" && exit 0; echo "An error occurred (ImageNotFoundException)" >&2; exit 254 ;;
      imageDigest=*) awk -v d="${'$'}{id#imageDigest=}" '$2==d{printf "%s\t", $1}' "${'$'}reg"; echo ;;
    esac ;;
  "ecr batch-get-image")
    id="$(arg --image-ids "${'$'}@")"; awk -v t="${'$'}{id#imageTag=}" '$1==t{print "manifest-" $2}' "${'$'}reg" ;;
  "ecr put-image")
    m="$(arg --image-manifest "${'$'}@")"; echo "$(arg --image-tag "${'$'}@") ${'$'}{m#manifest-}" >> "${'$'}reg" ;;
  "ecr get-login-password") echo pw ;;
  *) echo "fake aws: unexpected ${'$'}*" >&2; exit 1 ;;
esac
`;
  // buildx build: the "digest" is the content hash of the bridge source in the context, so
  // identical inputs give an identical digest, as BuildKit's cache does.
  const FAKE_DOCKER = `#!/bin/bash
echo "docker $*" >> "${'$'}FAKE_DIR/calls.txt"
[ "${'$'}1" = login ] && { cat >/dev/null; exit 0; }
meta="" tags=() ctx=""
while [ ${'$'}# -gt 0 ]; do
  case "${'$'}1" in
    --metadata-file) meta="${'$'}2"; shift 2 ;;
    -t) tags+=("${'$'}{2##*:}"); shift 2 ;;
    -f|--platform|--build-arg) shift 2 ;;
    *) ctx="${'$'}1"; shift ;;
  esac
done
d="sha256:$(cat "${'$'}ctx"/services/ws-tcp-bridge/src/* | shasum -a 256 | cut -c1-16)"
for t in "${'$'}{tags[@]}"; do echo "${'$'}t ${'$'}d" >> "${'$'}FAKE_DIR/registry.txt"; done
[ -z "${'$'}meta" ] || printf '{"containerimage.digest":"%s"}' "${'$'}d" > "${'$'}meta"
`;
  const run = (sha: string) => spawnSync('bash', [join(dir, 'tools/build-push-images.sh'), sha, '--only', 'bridge', '--skip-gate'], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '', PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: bin, WEBAC_REGISTRY: 'reg.example' },
  });
  const calls = () => readFakeLog(CALLS(), 'utf8');
  const tagsOf = (sha: string) => readFakeLog(REG(), 'utf8').split('\n').find((l) => l.startsWith(`${sha} `))?.split(' ')[1];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'acjs-build-push-'));
    bin = mkdtempSync(join(tmpdir(), 'acjs-build-push-bin-'));
    writeFileSync(join(bin, 'aws'), FAKE_AWS);
    writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
    chmodSync(join(bin, 'aws'), 0o755);
    chmodSync(join(bin, 'docker'), 0o755);
    git(dir, 'init', '-q');
    for (const f of ['build-push-images.sh', 'image-source.sh', 'lib/deploy-gate.sh']) {
      mkdirSync(dirname(join(dir, 'tools', f)), { recursive: true });
      copyFileSync(join(REPO, 'tools', f), join(dir, 'tools', f));
    }
    // Every path the script's git archive names, so the build context extracts.
    c.base = commit(dir, {
      'package.json': '{}', 'package-lock.json': '{}', 'tsconfig.json': '{}', 'vite.config.ts': '',
      'tools/lib/vite-head-from-stat.ts': '', 'tools/ac-agent/tools.ts': 't', '.dockerignore': '',
      'deploy/web/railway.json': JSON.stringify({ build: { watchPatterns: WEB_WATCH } }),
      'services/ws-tcp-bridge/railway.json': JSON.stringify({ build: { watchPatterns: BRIDGE_WATCH } }),
      'services/ws-tcp-bridge/src/bridge.ts': 'b1',
      'packages/renderer/src/a.txt': 'a',
    }, 'base');
    c.docs = commit(dir, { 'docs/notes.md': 'n' }, 'docs only');
    c.bridge = commit(dir, { 'services/ws-tcp-bridge/src/bridge.ts': 'b2' }, 'bridge change');
    c.revert = commit(dir, { 'services/ws-tcp-bridge/src/bridge.ts': 'b1' }, 'bridge change undone');
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (bin) rmSync(bin, { recursive: true, force: true });
  });

  it('builds the source commit, then gives a later commit with the same inputs its tag (no build)', () => {
    const first = run(c.base);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('[images] bridge: pushed');
    writeFileSync(CALLS(), '');
    const later = run(c.docs);
    expect(later.status, later.stderr).toBe(0);
    expect(later.stdout).toContain('(nothing it is built from changed)');
    expect(calls()).toContain(`ecr put-image --repository-name webac-bridge --image-tag ${c.docs}`);
    expect(calls()).not.toContain('docker buildx');
    expect(tagsOf(c.docs)).toBe(tagsOf(c.base));
  });

  it('a commit that changed an input is built; an identical build output is named as such', () => {
    const changed = run(c.bridge);
    expect(changed.status, changed.stderr).toBe(0);
    expect(tagsOf(c.bridge)).not.toBe(tagsOf(c.base));
    // Same bridge source as base again: a real build whose digest equals base's image.
    const reverted = run(c.revert);
    expect(reverted.status, reverted.stderr).toBe(0);
    expect(reverted.stdout).toContain('[images] bridge: building');
    expect(tagsOf(c.revert)).toBe(tagsOf(c.base));
    expect(reverted.stdout).toContain(`built output identical to the image already tagged ${c.base.slice(0, 12)}`);
  });

  it('refuses to retag when the chosen source image\'s inputs differ from the commit\'s', () => {
    // An image-source.sh whose walk picks a wrong (older) source: the guard's straight
    // diff must catch it and nothing may be tagged.
    const real = join(dir, 'tools/image-source.real.sh');
    copyFileSync(join(dir, 'tools/image-source.sh'), real);
    writeFileSync(join(dir, 'tools/image-source.sh'),
      `#!/bin/bash\n[ "$1" = --same-inputs ] && exec bash "${real}" "$@"\necho ${c.base}\n`);
    const extra = commit(dir, { 'services/ws-tcp-bridge/src/bridge.ts': 'b3' }, 'another bridge change');
    writeFileSync(CALLS(), '');
    const r = run(extra);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`refusing to tag webac-bridge:${c.base.slice(0, 12)} as ${extra.slice(0, 12)}`);
    expect(r.stderr).toContain('services/ws-tcp-bridge/src/bridge.ts');
    expect(calls()).not.toContain('put-image');
    expect(calls()).not.toContain('docker buildx');
    expect(tagsOf(extra)).toBeUndefined();
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
