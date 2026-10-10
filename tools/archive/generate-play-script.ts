/**
 * Regenerate packages/shared/src/enums/PlayScript.ts from ACE C# source.
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/PlayScript.cs   (174 entries, 0x00..0xAD)
 *
 * PlayScript values are sent by the server in GameMessageScript and
 * PlayScriptId events to drive client-side visual effects (spell launch/
 * impact, fizzle, attribute up/down sparkles, splatter/spark hit fx, etc.).
 *
 * Mirrors tools/generate-motion-commands.ts pattern.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dirname, '..');
const SRC = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/PlayScript.cs');
const OUT = resolve(REPO, 'packages/shared/src/enums/PlayScript.ts');

interface Entry { name: string; value: number; }

function parseEnum(source: string, enumName: string): Entry[] {
  const lines = source.split('\n');
  const out: Entry[] = [];
  let inside = false;
  const open = new RegExp(`enum\\s+${enumName}\\b`);
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(0x[0-9A-Fa-f]+|-?\d+)\s*,?\s*(\/\/.*)?$/;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inside) { if (open.test(line)) inside = true; continue; }
    if (/^\s*}/.test(line)) break;
    const m = re.exec(line);
    if (m) {
      const value = m[2].startsWith('0x') ? parseInt(m[2], 16) : parseInt(m[2], 10);
      out.push({ name: m[1], value });
    }
  }
  return out;
}

function emitEnum(entries: Entry[]): string {
  const longest = entries.reduce((a, e) => Math.max(a, e.name.length), 0);
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * PlayScript — server-driven visual effect IDs.');
  lines.push(' *');
  lines.push(' * Reference: reference/ACE/Source/ACE.Entity/Enum/PlayScript.cs');
  lines.push(' *');
  lines.push(' * Sent via GameMessageScript (0xF755) and GameEventPlayScriptId.');
  lines.push(' * Drives client-side visual fx: spell launch/impact, fizzle,');
  lines.push(' * attribute/skill/health up/down sparkles, splatter/spark hit fx,');
  lines.push(' * portal entry/exit, level-up, special states, etc.');
  lines.push(' */');
  lines.push('export enum PlayScript {');
  for (const e of entries) {
    const pad = ' '.repeat(longest - e.name.length);
    const hex = '0x' + e.value.toString(16).toUpperCase().padStart(2, '0');
    lines.push(`  ${e.name}${pad} = ${hex},`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function main(): void {
  const entries = parseEnum(readFileSync(SRC, 'utf8'), 'PlayScript');
  if (entries.length < 170) {
    console.error(`PlayScript parse failed: only ${entries.length} entries.`);
    process.exit(1);
  }
  // Anchors against ACE source
  const byName = new Map(entries.map((e) => [e.name, e.value]));
  const anchors: Array<[string, number]> = [
    ['Invalid', 0x00],
    ['Launch', 0x04],
    ['Explode', 0x05],
    ['Fizzle', 0x51],
    ['PortalEntry', 0x52],
    ['PortalExit', 0x53],
    ['LevelUp', 0x8A],
    ['BaelZharonSmite', 0x96],
    ['DirtyFightingDamageOverTime', 0xAD],
  ];
  for (const [n, v] of anchors) {
    const got = byName.get(n);
    if (got !== v) {
      console.error(`PlayScript anchor mismatch: ${n} expected 0x${v.toString(16)}, got 0x${got?.toString(16)}`);
      process.exit(1);
    }
  }
  writeFileSync(OUT, emitEnum(entries));
  console.log(`Wrote ${OUT}`);
  console.log(`  PlayScript: ${entries.length} entries`);
}

main();
