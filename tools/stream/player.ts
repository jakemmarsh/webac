/**
 * Where a stream player's `claude -p` session runs: a small directory of its own (under the stream state dir), not the
 * repo. Run in the repo, every player turn carried the repo's CLAUDE.md (36 KB), the account's ~/.claude/CLAUDE.md
 * (9 KB) and the project's auto-memory index (15 KB): about 18k tokens of coding rules re-read on every one of a
 * segment's ~100–200 model calls (rehearsal 2026-10-13). Here there is no project CLAUDE.md, no git status, no project
 * skills, and the supervisor's env turns off CLAUDE.md loading and auto-memory (playerEnv).
 *
 * The directory holds two wrappers, the only commands a player runs (its permissions allow nothing else):
 *   ./ac <tool> key=val …         the agent CLI (tools/ac-agent/cli.ts) for this character's profile, always
 *   ./world-query "SELECT …"      the read-only world-DB query (tools/stream/world-query.ts)
 * They call the repo's own tsx and scripts by absolute path (no npx: from outside the repo it would look for tsx on
 * the network, and its npm config warnings cost two lines per call), and `./ac` refuses `start` / `stop` itself (the
 * supervisor starts and stops the daemons) and pins `profile=` to this character, so a call can't drive the partner.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface PlayerDir {
  dir: string;
  /** The command prefixes the brief and the permission rules use. */
  ac: string;
  worldQuery: string;
}

/** Quote for /bin/sh (single quotes; a ' inside closes, escapes and reopens). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The two wrapper scripts for `profile`, calling the repo at `repo` with its tsx. */
export function playerScripts(repo: string, profile: string): { ac: string; worldQuery: string } {
  if (!/^[a-z0-9_-]+$/i.test(profile)) throw new Error(`bad profile ${profile}`);
  const tsx = shQuote(join(repo, 'node_modules', '.bin', 'tsx'));
  const ac = [
    '#!/bin/sh',
    `# Written by the stream supervisor (tools/stream/player.ts): the agent CLI for profile ${profile}.`,
    'case "$1" in',
    '  start|stop) echo "error: the stream supervisor starts and stops your game session; never run start or stop" >&2; exit 2 ;;',
    'esac',
    // profile= last: parseCliArgs keeps the last value, so this character's profile always wins.
    `exec ${tsx} ${shQuote(join(repo, 'tools', 'ac-agent', 'cli.ts'))} "$@" profile=${profile}`,
    '',
  ].join('\n');
  const worldQuery = [
    '#!/bin/sh',
    '# Written by the stream supervisor (tools/stream/player.ts): read-only world-DB query.',
    `exec ${tsx} ${shQuote(join(repo, 'tools', 'stream', 'world-query.ts'))} "$@"`,
    '',
  ].join('\n');
  return { ac, worldQuery };
}

/** Make (or refresh) `<root>/<profile>/` with its wrappers; returns it. */
export function preparePlayerDir(root: string, repo: string, profile: string): PlayerDir {
  const dir = join(root, profile);
  mkdirSync(dir, { recursive: true });
  const s = playerScripts(repo, profile);
  for (const [name, text] of [['ac', s.ac], ['world-query', s.worldQuery]] as const) {
    const f = join(dir, name);
    if (!existsSync(f) || readFileSync(f, 'utf8') !== text) writeFileSync(f, text);
    chmodSync(f, 0o755);
  }
  return { dir, ac: './ac', worldQuery: './world-query' };
}
