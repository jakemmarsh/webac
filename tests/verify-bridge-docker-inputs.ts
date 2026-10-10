/**
 * The bridge image builds from an allowlist (services/ws-tcp-bridge/
 * Dockerfile.dockerignore + the Dockerfile's COPY lines), so every repo file
 * the bridge's sources reach outside their own directory must be listed in
 * both, or Railway's build fails. 2026-10-06: Packet1999.ts began importing
 * ../Hash32.js, the allowlist didn't follow, and the bridge deploy FAILED.
 * The import graph comes from esbuild's resolver bundling the bridge's
 * entry points (the real module resolution, not a regex over the source).
 */
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
  beforeAll(async () => {
    ignore = readFileSync(join(BRIDGE_DIR, 'Dockerfile.dockerignore'), 'utf8');
    dockerfile = readFileSync(join(BRIDGE_DIR, 'Dockerfile'), 'utf8');
    inputs = await externalInputs();
  });

  it('finds the workspace files the bridge imports (the 1999 packet layer)', () => {
    expect(inputs.some((f) => f.endsWith('era1999/Packet1999.ts'))).toBe(true);
  });

  it('allows and copies every one of them', () => {
    for (const f of inputs) {
      expect(ignore, `Dockerfile.dockerignore must allow ${f}`).toContain(`!${f}`);
      expect(dockerfile, `Dockerfile must COPY ${f}`).toContain(`COPY ${f} ./${f}`);
    }
  });
});
