/**
 * Railway rebuilds a service only when a pushed file matches its
 * railway.json watchPatterns. Every file its Dockerfile copies must match
 * one, or a change to it never deploys: the bridge copied tools/ac-agent/*
 * (the hosted connector's tool table and guide) and the agent's format.ts
 * without watching them, so their changes sat undeployed (2026-10-11).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const SERVICES = [
  { config: 'services/ws-tcp-bridge/railway.json' },
  { config: 'deploy/web/railway.json' },
];

/** A Railway watch glob as a matcher: `**` any depth, `*` within one path segment. */
export function globMatcher(patterns: string[]): (path: string) => boolean {
  const res = patterns.map((p) => new RegExp(`^${p.split('**').map((part) => part.split('*').map((t) => t.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`));
  return (path) => res.some((r) => r.test(path));
}

/** The repo paths a Dockerfile's COPY lines take from the build context (not --from stages). */
export function copiedSources(dockerfile: string): string[] {
  const out: string[] = [];
  for (const line of dockerfile.split('\n')) {
    const m = /^COPY\s+(.*)$/.exec(line.trim());
    if (!m || /--from=/.test(m[1])) continue;
    const args = m[1].split(/\s+/).filter((a) => !a.startsWith('--'));
    out.push(...args.slice(0, -1));
  }
  return out;
}

describe('Railway watch patterns cover what each image copies', () => {
  for (const { config } of SERVICES) {
    it(config, () => {
      const cfg = JSON.parse(readFileSync(resolve(REPO, config), 'utf8')) as { build: { dockerfilePath: string; watchPatterns: string[] } };
      const watched = globMatcher(cfg.build.watchPatterns);
      const sources = copiedSources(readFileSync(resolve(REPO, cfg.build.dockerfilePath), 'utf8'));
      expect(sources.length).toBeGreaterThan(0);
      // A copied directory is covered when a file inside it would match.
      const unwatched = sources.filter((s) => {
        const isDir = (() => { try { return statSync(resolve(REPO, s.replace(/\*.*$/, ''))).isDirectory(); } catch { return false; } })();
        return !watched(isDir ? `${s.replace(/\/$/, '')}/x.ts` : s);
      });
      expect(unwatched).toEqual([]);
    });
  }
  it('globs: ** spans directories, * stays in one segment', () => {
    const m = globMatcher(['tools/ac-agent/**', 'tsconfig*.json']);
    expect(m('tools/ac-agent/tools.ts')).toBe(true);
    expect(m('tools/ac-agent/sub/x.ts')).toBe(true);
    expect(m('tsconfig.base.json')).toBe(true);
    expect(m('tools/lib/x.ts')).toBe(false);
    expect(m('a/tsconfig.json')).toBe(false);
  });
  it('reads COPY sources, skipping --from stages and flags', () => {
    expect(copiedSources('COPY a.ts b/c.ts ./\nCOPY --chown=node:node d ./d\nCOPY --from=build /x ./x')).toEqual(['a.ts', 'b/c.ts', 'd']);
  });
});
