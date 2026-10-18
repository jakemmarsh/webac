/**
 * The bridge image builds from an allowlist (services/ws-tcp-bridge/
 * Dockerfile.dockerignore + the Dockerfile's COPY lines), so every repo file
 * the bridge's sources reach outside their own directory must be listed in
 * both, or the image build fails. 2026-10-06: Packet1999.ts began importing
 * ../Hash32.js, the allowlist didn't follow, and the bridge deploy FAILED.
 * The import graph comes from esbuild's resolver bundling the bridge's
 * entry points (the real module resolution, not a regex over the source).
 * 2026-10-10: the hand deploy then (Railway's, since deleted) uploaded a `git
 * archive` of named paths, which left out tools/ac-agent, so that build FAILED
 * too. The images are built by tools/build-push-images.sh from the same kind
 * of `git archive` of named paths, so the last test asks that script for its
 * list (--print-context-paths).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '..');
const BRIDGE_DIR = join(REPO, 'services/ws-tcp-bridge');
const BRIDGE_SRC = join(BRIDGE_DIR, 'src');

/** Every repo file outside the bridge's src that its sources reach, as esbuild resolves them. */
async function externalInputs(): Promise<string[]> {
  const entryPoints = readdirSync(BRIDGE_SRC).filter((f) => f.endsWith('.ts')).map((f) => join(BRIDGE_SRC, f));
  const r = await build({ entryPoints, bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', packages: 'external', outdir: join(REPO, '.esbuild-unused'), logLevel: 'silent' });
  return Object.keys(r.metafile!.inputs)
    .map((f) => relative(REPO, resolve(REPO, f)))
    .filter((f) => !resolve(REPO, f).startsWith(BRIDGE_SRC))
    .sort();
}

describe('bridge Docker build inputs', () => {
  let ignore = '';
  let dockerfile = '';
  let inputs: string[] = [];
  let archived: string[] = [];
  beforeAll(async () => {
    // The image build's context: the paths tools/build-push-images.sh `git archive`s.
    archived = execFileSync('bash', [join(REPO, 'tools/build-push-images.sh'), '--print-context-paths'], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    ignore = readFileSync(join(BRIDGE_DIR, 'Dockerfile.dockerignore'), 'utf8');
    dockerfile = readFileSync(join(BRIDGE_DIR, 'Dockerfile'), 'utf8');
    inputs = await externalInputs();
  });

  it('finds the workspace files the bridge imports (the 1999 packet layer)', () => {
    expect(inputs.some((f) => f.endsWith('era1999/Packet1999.ts'))).toBe(true);
  });

  it('allows and copies every one of them', () => {
    // A file, or a folder holding it (`!dir/**` and `COPY dir ./dir`), as for packages/shared/src/routines.
    const dirs = (f: string) => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'));
    for (const f of inputs) {
      const allowed = ignore.includes(`!${f}\n`) || dirs(f).some((d) => ignore.includes(`!${d}/**\n`));
      expect(allowed, `Dockerfile.dockerignore must allow ${f}`).toBe(true);
      const copied = dockerfile.includes(`COPY ${f} ./${f}`) || dirs(f).some((d) => dockerfile.includes(`COPY ${d} ./${d}\n`));
      expect(copied, `Dockerfile must COPY ${f}`).toBe(true);
    }
  });

  it('the build stage installs every bridge dependency at its package-lock version (the runtime image has no node_modules)', () => {
    // 2026-10-16: @aws-sdk/client-ec2 (the egress provider, src/egress.ts) joined ws; a dependency
    // missing here would bundle as an unresolved require and crash the bridge when first used.
    const deps = Object.keys(JSON.parse(readFileSync(join(BRIDGE_DIR, 'package.json'), 'utf8')).dependencies ?? {});
    const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')).packages as Record<string, { version?: string }>;
    const install = dockerfile.split('\n').find((l) => l.startsWith('RUN npm install'))!;
    expect(deps).toContain('@aws-sdk/client-ec2');
    for (const d of deps) {
      const version = lock[`node_modules/${d}`]?.version;
      expect(version, `package-lock.json has ${d}`).toBeTruthy();
      expect(install.split(/\s+/), `Dockerfile's npm install must pin ${d}@${version}`).toContain(`${d}@${version}`);
    }
  });

  it('the image build ships every one of them and the Dockerfile in its build context', () => {
    expect(archived).toContain('services');
    const shipped = (f: string) => archived.some((p) => f === p || f.startsWith(`${p}/`));
    for (const f of inputs) expect(shipped(f), `build-push-images.sh's git archive must include ${f}`).toBe(true);
  });
});
