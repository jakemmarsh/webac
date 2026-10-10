/**
 * dump-motion-table-keys.ts
 *
 * Loads portal.dat, finds the human male MotionTable, and dumps
 * the composite key format used by cycles, modifiers, and links.
 *
 * Usage: npx tsx tools/dump-motion-table-keys.ts
 */

import * as fs from 'fs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { SetupModel } from '../../packages/dat-parser/src/file-types/SetupModel.js';
import { MotionTable } from '../../packages/dat-parser/src/file-types/MotionTable.js';

// ── Known MotionStance values (from ACE MotionStance.cs) ──
const STANCES: Record<number, string> = {
  0x8000003c: 'HandCombat',
  0x8000003d: 'NonCombat',
  0x8000003e: 'SwordCombat',
  0x8000003f: 'BowCombat',
  0x80000040: 'SwordShieldCombat',
  0x80000041: 'CrossbowCombat',
  0x80000042: 'UnusedCombat',
  0x80000043: 'SlingCombat',
  0x80000044: 'TwoHandedSwordCombat',
  0x80000045: 'TwoHandedStaffCombat',
  0x80000046: 'DualWieldCombat',
  0x80000047: 'ThrownWeaponCombat',
  0x80000048: 'Graze',
  0x80000049: 'Magic',
  0x800000e8: 'BowNoAmmo',
  0x800000e9: 'CrossBowNoAmmo',
  0x8000013b: 'AtlatlCombat',
  0x8000013c: 'ThrownShieldCombat',
};

// ── Some MotionCommand values for reference ──
const MOTIONS: Record<number, string> = {
  0x00000000: 'Invalid',
  0x41000003: 'Ready',
  0x40000004: 'Stop',
  0x45000005: 'WalkForward',
  0x45000006: 'WalkBackwards',
  0x44000007: 'RunForward',
  0x40000008: 'Fallen',
  0x40000011: 'Dead',
  0x41000012: 'Crouch',
  0x41000013: 'Sitting',
  0x41000014: 'Sleeping',
  0x40000015: 'Falling',
  0x6500000d: 'TurnRight',
  0x6500000e: 'TurnLeft',
  0x6500000f: 'SideStepRight',
  0x65000010: 'SideStepLeft',
  0x2500003b: 'Jump',
  0x10000058: 'ThrustMed',
  0x10000059: 'ThrustLow',
  0x1000005a: 'ThrustHigh',
  0x1000005b: 'SlashHigh',
  0x1000005c: 'SlashMed',
  0x1000005d: 'SlashLow',
  0x1000004a: 'Hop',
  0x1000004b: 'Jumpup',
  0x1300004c: 'Cheer',
  0x10000051: 'Twitch1',
  0x10000052: 'Twitch2',
  0x10000053: 'Twitch3',
  0x10000054: 'Twitch4',
  0x10000055: 'StaggerBackward',
  0x10000056: 'StaggerForward',
  0x10000057: 'Sanctuary',
};

function hex(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

function stanceName(id: number): string {
  return STANCES[id] ?? `UnknownStance(${hex(id)})`;
}

function motionName(id: number): string {
  return MOTIONS[id] ?? `Motion(${hex(id)})`;
}

/**
 * Try to decompose a cycle/modifier/link key into stance + motion parts.
 * ACE uses: key = (uint)stance << 16 | (uint)motion & 0xFFFFF
 * But stances are 0x8000003c+ so shifting left 16 bits gives huge values.
 * Let's just show the raw key and also try to extract the two halves.
 */
function decomposeKey(key: number): string {
  // The key format from ACE: (stance << 16) | (motion & 0xFFFFF)
  // stance values like 0x8000003d → shifted becomes 0x003d0000 (only low 16 bits of stance survive in upper half)
  // Actually wait — let's look at this more carefully.
  // stance = 0x8000003d, stance << 16 = 0x003d0000 (because it's truncated to uint32)
  // No wait: 0x8000003d << 16 in C# uint = 0x003d0000 (only keeps lower 32 bits)
  // Actually in C# with uint: 0x8000003d << 16 overflows. Let me think...
  // 0x8000003d = 2147483709 in decimal
  // << 16 = 2147483709 * 65536 = way too big for uint32
  // In C# unchecked uint arithmetic: (0x8000003d << 16) = 0x003d0000
  // Because the shift keeps only lower 32 bits: (0x8000003d << 16) & 0xFFFFFFFF
  // 0x8000003d * 0x10000 = 0x80000_003d0000 → low 32 = 0x003d0000

  // So the upper 16 bits of key = low 16 bits of stance
  // The lower 20 bits of key = low 20 bits of motion

  const stanceLow16 = (key >>> 16) & 0xFFFF;
  const motionLow20 = key & 0xFFFFF;

  // Try to reconstruct the full stance value (0x8000xxxx)
  const fullStance = 0x80000000 | stanceLow16;
  const stanceStr = STANCES[fullStance >>> 0] ?? `Stance(${hex(fullStance >>> 0)})`;

  // The motion low 20 bits — to get the full motion we'd need to know the upper bits
  // But we can look for it in our table
  let motionStr = `motion_low20=${hex(motionLow20)}`;
  for (const [id, name] of Object.entries(MOTIONS)) {
    if ((Number(id) & 0xFFFFF) === motionLow20) {
      motionStr = name;
      break;
    }
  }

  return `stance=${stanceStr} motion=${motionStr}`;
}

// ── Main ──

const portalPath = 'dat/client_portal.dat';
console.log('Loading portal DAT...');
const portalBuf = fs.readFileSync(portalPath);
const portal = new DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
console.log(`Portal DAT loaded: ${portal.fileCount} files`);

// Try to load SetupModel 0x02000001 (human male)
const setupIds = [0x02000001, 0x02000002, 0x02000003, 0x02000004, 0x02000005];
let motionTableId = 0x09000001; // Default guess

for (const setupId of setupIds) {
  if (portal.hasFile(setupId)) {
    const reader = portal.getReader(setupId);
    const setup = new SetupModel(reader);
    console.log(`\nSetupModel ${hex(setupId)}: ${setup.parts.length} parts, motionTable=${hex(setup.defaultMotionTable)}`);
    if (setup.defaultMotionTable !== 0) {
      motionTableId = setup.defaultMotionTable;
      break;
    }
  }
}

console.log(`\nUsing MotionTable: ${hex(motionTableId)}`);

if (!portal.hasFile(motionTableId)) {
  console.error(`MotionTable ${hex(motionTableId)} not found!`);
  // List first few 0x09 files
  const mtIds = portal.listFileIds(0x09).sort();
  console.log(`Available 0x09 files (first 10): ${mtIds.slice(0, 10).map(hex).join(', ')}`);
  process.exit(1);
}

const mtReader = portal.getReader(motionTableId);
const mt = new MotionTable(mtReader);

console.log(`\nMotionTable ID: ${hex(mt.id)}`);
console.log(`defaultStyle: ${hex(mt.defaultStyle)} = ${stanceName(mt.defaultStyle)}`);

// ── StyleDefaults ──
console.log(`\n=== StyleDefaults (${mt.styleDefaults.size} entries) ===`);
for (const [key, value] of mt.styleDefaults) {
  console.log(`  ${hex(key)} (${stanceName(key)}) → ${hex(value)} (${motionName(value)})`);
}

// ── Cycles ──
console.log(`\n=== Cycles (${mt.cycles.size} total, showing first 30) ===`);
let cycleCount = 0;
for (const [key, data] of mt.cycles) {
  if (cycleCount >= 30) break;
  const animIds = data.anims.map(a => hex(a.animId)).join(', ');
  console.log(`  key=${hex(key)} [${decomposeKey(key)}] → anims=[${animIds}] bitfield=${data.bitfield} flags=${data.flags}`);
  cycleCount++;
}
if (mt.cycles.size > 30) {
  console.log(`  ... and ${mt.cycles.size - 30} more`);
}

// ── Modifiers ──
console.log(`\n=== Modifiers (${mt.modifiers.size} total, showing first 10) ===`);
let modCount = 0;
for (const [key, data] of mt.modifiers) {
  if (modCount >= 10) break;
  const animIds = data.anims.map(a => hex(a.animId)).join(', ');
  console.log(`  key=${hex(key)} [${decomposeKey(key)}] → anims=[${animIds}] bitfield=${data.bitfield} flags=${data.flags}`);
  if (data.velocity) console.log(`    velocity: ${JSON.stringify(data.velocity)}`);
  if (data.omega) console.log(`    omega: ${JSON.stringify(data.omega)}`);
  modCount++;
}
if (mt.modifiers.size > 10) {
  console.log(`  ... and ${mt.modifiers.size - 10} more`);
}

// ── Links ──
console.log(`\n=== Links (${mt.links.size} outer keys, showing first 5) ===`);
let linkCount = 0;
for (const [outerKey, innerMap] of mt.links) {
  if (linkCount >= 5) break;
  console.log(`  outerKey=${hex(outerKey)} [${decomposeKey(outerKey)}] → ${innerMap.size} inner entries`);
  let innerCount = 0;
  for (const [innerKey, data] of innerMap) {
    if (innerCount >= 5) break;
    const animIds = data.anims.map(a => hex(a.animId)).join(', ');
    console.log(`    innerKey=${hex(innerKey)} (${motionName(innerKey)}) → anims=[${animIds}]`);
    innerCount++;
  }
  if (innerMap.size > 5) {
    console.log(`    ... and ${innerMap.size - 5} more inner entries`);
  }
  linkCount++;
}
if (mt.links.size > 5) {
  console.log(`  ... and ${mt.links.size - 5} more outer entries`);
}

// ── Key format analysis ──
console.log('\n=== Key Format Analysis ===');
console.log('\nACE key construction (from MotionTable.cs):');
console.log('  Cycle key:    (uint)stance << 16 | (uint)motion & 0xFFFFF');
console.log('  Modifier key: (uint)stance << 16 | (uint)motion & 0xFFFFF');
console.log('  Link outer:   (uint)stance << 16 | (uint)currentMotion & 0xFFFFF');
console.log('  Link inner:   raw (uint)motion');

// Analyze the key bit patterns
console.log('\nKey bit pattern analysis:');
console.log('  Sample cycle keys:');
let sampleCount = 0;
for (const key of mt.cycles.keys()) {
  if (sampleCount >= 5) break;
  const upper16 = (key >>> 16) & 0xFFFF;
  const lower16 = key & 0xFFFF;
  const lower20 = key & 0xFFFFF;
  console.log(`    ${hex(key)} → upper16=${hex(upper16)} lower16=${hex(lower16)} lower20=${hex(lower20)}`);
  sampleCount++;
}

console.log('  Sample link inner keys:');
sampleCount = 0;
for (const [, innerMap] of mt.links) {
  for (const innerKey of innerMap.keys()) {
    if (sampleCount >= 5) break;
    console.log(`    ${hex(innerKey)}`);
    sampleCount++;
  }
  break; // just first outer entry
}

console.log('\nDone.');

// ── Extended link analysis ──
console.log('\n=== Extended Link Analysis ===');
console.log('All link outer keys with stance+motion decomposition:');
let linkIdx = 0;
for (const [outerKey, innerMap] of mt.links) {
  if (linkIdx >= 20) break;
  const upper16 = (outerKey >>> 16) & 0xFFFF;
  const lower16 = outerKey & 0xFFFF;
  const lower20 = outerKey & 0xFFFFF;
  const fullStance = (0x80000000 | upper16) >>> 0;
  const stanceLabel = STANCES[fullStance] ?? `??(${hex(fullStance)})`;

  // For inner keys, show first 3
  const innerEntries: string[] = [];
  let ic = 0;
  for (const [ik, id] of innerMap) {
    if (ic >= 3) break;
    innerEntries.push(`${hex(ik)} (${motionName(ik)})`);
    ic++;
  }

  console.log(`  outer=${hex(outerKey)} stance=${stanceLabel}(upper16=0x${upper16.toString(16)}) motion_low20=0x${lower20.toString(16)} → inner: ${innerEntries.join(', ')}`);
  linkIdx++;
}

// Unique upper16 values across all cycle keys
const cycleUpper = new Set<number>();
for (const key of mt.cycles.keys()) cycleUpper.add((key >>> 16) & 0xFFFF);
console.log(`\nUnique stance values in cycle keys (upper 16 bits): ${[...cycleUpper].map(v => '0x' + v.toString(16)).sort().join(', ')}`);

// Unique lower16/lower20 motion parts across all cycle keys for NonCombat stance (0x3d)
const ncMotions = new Set<number>();
for (const key of mt.cycles.keys()) {
  if (((key >>> 16) & 0xFFFF) === 0x3d) {
    ncMotions.add(key & 0xFFFF);
  }
}
console.log(`\nNonCombat cycle motion values (lower 16 bits): ${[...ncMotions].map(v => '0x' + v.toString(16).padStart(4, '0')).sort().join(', ')}`);

// Check: are lower 16 bits always enough or do we need lower 20?
let needsLower20 = false;
for (const key of mt.cycles.keys()) {
  const lower16 = key & 0xFFFF;
  const lower20 = key & 0xFFFFF;
  if (lower16 !== lower20) {
    needsLower20 = true;
    console.log(`\nKey ${hex(key)} needs lower 20 bits: lower16=${hex(lower16)} lower20=${hex(lower20)}`);
    break;
  }
}
if (!needsLower20) {
  console.log('\nAll cycle keys fit in 16+16 format (no key needs bits 16-19 for motion)');
}
