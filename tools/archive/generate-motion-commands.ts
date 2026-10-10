/**
 * Regenerate the MotionCommand + MotionStance const objects in
 * packages/renderer/src/animation/MotionCommands.ts from ACE C# source.
 *
 * Keeps the existing CommandMask, MotionSpeed, and ChatEmoteMap sections
 * untouched — they're separate concerns (bit-flag mask, animation speeds,
 * /emote name map).
 *
 * Source files:
 *   reference/ACE/Source/ACE.Entity/Enum/MotionCommand.cs   (409 entries)
 *   reference/ACE/Source/ACE.Entity/Enum/MotionStance.cs    (19 entries)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dirname, '..');
const MC_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/MotionCommand.cs');
const MS_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/MotionStance.cs');
const OUT_PATH = resolve(REPO, 'packages/renderer/src/animation/MotionCommands.ts');

interface Entry { name: string; value: number; }

function parseEnum(source: string, enumName: string): Entry[] {
  const lines = source.split('\n');
  const out: Entry[] = [];
  let inside = false;
  const open = new RegExp(`enum\\s+${enumName}\\b`);
  const re = /^\s*([A-Z][A-Za-z0-9_]*)\s*=\s*(0x[0-9A-Fa-f]+|-?\d+)\s*,?\s*(\/\/.*)?$/;
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

function emitConstObject(name: string, entries: Entry[]): string {
  const longest = entries.reduce((a, e) => Math.max(a, e.name.length), 0);
  const lines: string[] = [`export const ${name} = {`];
  for (const e of entries) {
    const pad = ' '.repeat(longest - e.name.length);
    const hex = '0x' + e.value.toString(16).padStart(8, '0');
    lines.push(`  ${e.name}:${pad} ${hex},`);
  }
  lines.push('} as const;');
  return lines.join('\n');
}

function main(): void {
  const motionCommand = parseEnum(readFileSync(MC_PATH, 'utf8'), 'MotionCommand');
  const motionStance = parseEnum(readFileSync(MS_PATH, 'utf8'), 'MotionStance');

  if (motionCommand.length < 400) {
    console.error(`MotionCommand parse failed: only ${motionCommand.length} entries.`);
    process.exit(1);
  }
  if (motionStance.length < 15) {
    console.error(`MotionStance parse failed: only ${motionStance.length} entries.`);
    process.exit(1);
  }

  // Sanity anchors
  const mcByName = new Map(motionCommand.map((e) => [e.name, e.value]));
  const anchors: Array<[string, number]> = [
    ['Invalid', 0x0],
    ['Ready', 0x41000003],
    ['Jump', 0x2500003b],
    ['CastSpell', 0x400000d3],
    ['LifestoneRecall', 0x10000153],
  ];
  for (const [n, v] of anchors) {
    const got = mcByName.get(n);
    if (got !== v) {
      console.error(`MotionCommand anchor mismatch: ${n} expected 0x${v.toString(16)}, got 0x${got?.toString(16)}`);
      process.exit(1);
    }
  }

  const existing = readFileSync(OUT_PATH, 'utf8');

  // Replace MotionCommand block
  const newMcBlock = emitConstObject('MotionCommand', motionCommand);
  const mcStart = existing.indexOf('export const MotionCommand = {');
  if (mcStart === -1) { console.error('Cannot locate MotionCommand block'); process.exit(1); }
  const mcEnd = existing.indexOf('} as const;', mcStart);
  if (mcEnd === -1) { console.error('Cannot locate end of MotionCommand block'); process.exit(1); }
  const mcAfter = existing.indexOf('\n', mcEnd);

  // Replace MotionStance block
  const newMsBlock = emitConstObject('MotionStance', motionStance);
  const msStart = existing.indexOf('export const MotionStance = {');
  const msEnd = existing.indexOf('} as const;', msStart);
  const msAfter = existing.indexOf('\n', msEnd);

  if (msStart === -1 || msEnd === -1) {
    console.error('Cannot locate MotionStance block');
    process.exit(1);
  }

  // Splice: keep header, replace MotionCommand, keep text between, replace MotionStance, keep tail.
  const result =
    existing.slice(0, mcStart) +
    newMcBlock +
    existing.slice(mcAfter, msStart) +
    newMsBlock +
    existing.slice(msAfter);

  writeFileSync(OUT_PATH, result);
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`  MotionCommand: ${motionCommand.length} entries`);
  console.log(`  MotionStance:  ${motionStance.length} entries`);
}

main();
