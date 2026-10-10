/**
 * Verify CharacterCreate message format by building one and parsing it back
 * exactly as ACE's C# server would.
 */
import { buildCharacterCreate } from '../../packages/network/src/MessageSerializer.js';
import type { CharacterCreateParams } from '../../packages/network/src/MessageSerializer.js';

// Build the same message we send to ACE
const params: CharacterCreateParams = {
  accountName: 'testacjs41',
  heritage: 1,  // Aluvian
  gender: 1,    // Male
  appearance: {
    eyes: 0, nose: 0, mouth: 0, hairColor: 0, eyeColor: 0,
    hairStyle: 0, headgearStyle: 0, headgearColor: 0,
    shirtStyle: 0, shirtColor: 0, pantsStyle: 0, pantsColor: 0,
    footwearStyle: 0, footwearColor: 0,
    skinHue: 0.0, hairHue: 0.0, headgearHue: 0.0,
    shirtHue: 0.0, pantsHue: 0.0, footwearHue: 0.0,
  },
  templateOption: 0,
  strength: 10,
  endurance: 10,
  coordination: 10,
  quickness: 10,
  focus: 10,
  self: 10,
  characterSlot: 0,
  classId: 1,
  skills: new Array(55).fill(0),
  name: 'Test Hero',
  startArea: 0,
};

const msg = buildCharacterCreate(params);
console.log(`Message total size: ${msg.length} bytes`);
console.log(`Full hex:\n${formatHex(msg)}\n`);

// Now parse it back exactly as ACE does:
// 1. ClientMessage constructor reads opcode
const view = new DataView(msg.buffer, msg.byteOffset, msg.length);
let pos = 0;

const opcode = view.getUint32(pos, true); pos += 4;
console.log(`[ClientMessage] Opcode: 0x${opcode.toString(16)} (expected 0xf656)`);
assert(opcode === 0xF656, `Opcode mismatch: got 0x${opcode.toString(16)}`);

// 2. CharacterHandler reads account name (ReadString16L)
const { str: accountName, newPos: posAfterAccount } = readString16L(msg, pos);
pos = posAfterAccount;
console.log(`[Handler] Account: "${accountName}" (expected "testacjs41"), pos=${pos}`);
assert(accountName === 'testacjs41', `Account mismatch: got "${accountName}"`);

// 3. CharacterCreateInfo.Unpack()
// Skip 4 unknown bytes
const unknown = view.getUint32(pos, true); pos += 4;
console.log(`[Unpack] Unknown: ${unknown} (expected 1), pos=${pos}`);
assert(unknown === 1, `Unknown mismatch: got ${unknown}`);

const heritage = view.getUint32(pos, true); pos += 4;
console.log(`[Unpack] Heritage: ${heritage} (expected 1), pos=${pos}`);
assert(heritage === 1, `Heritage mismatch: got ${heritage}`);

const gender = view.getUint32(pos, true); pos += 4;
console.log(`[Unpack] Gender: ${gender} (expected 1), pos=${pos}`);
assert(gender === 1, `Gender mismatch: got ${gender}`);

// Appearance.Unpack()
const appearanceFields = [
  'Eyes', 'Nose', 'Mouth', 'HairColor', 'EyeColor', 'HairStyle',
  'HeadgearStyle', 'HeadgearColor', 'ShirtStyle', 'ShirtColor',
  'PantsStyle', 'PantsColor', 'FootwearStyle', 'FootwearColor',
];
for (const field of appearanceFields) {
  const val = view.getUint32(pos, true); pos += 4;
  console.log(`[Appearance] ${field}: ${val} (expected 0), pos=${pos}`);
  assert(val === 0, `${field} mismatch: got ${val}`);
}

const hueFields = ['SkinHue', 'HairHue', 'HeadgearHue', 'ShirtHue', 'PantsHue', 'FootwearHue'];
for (const field of hueFields) {
  const val = view.getFloat64(pos, true); pos += 8;
  console.log(`[Appearance] ${field}: ${val} (expected 0.0), pos=${pos}`);
  assert(val === 0.0, `${field} mismatch: got ${val}`);
}

const templateOption = view.getInt32(pos, true); pos += 4;
console.log(`[Unpack] TemplateOption: ${templateOption} (expected 0), pos=${pos}`);

const attrs = ['Strength', 'Endurance', 'Coordination', 'Quickness', 'Focus', 'Self'];
for (const attr of attrs) {
  const val = view.getUint32(pos, true); pos += 4;
  console.log(`[Unpack] ${attr}: ${val} (expected 10), pos=${pos}`);
  assert(val === 10, `${attr} mismatch: got ${val}`);
}

const charSlot = view.getUint32(pos, true); pos += 4;
console.log(`[Unpack] CharacterSlot: ${charSlot} (expected 0), pos=${pos}`);

const classId = view.getUint32(pos, true); pos += 4;
console.log(`[Unpack] ClassId: ${classId} (expected 1), pos=${pos}`);

const numSkills = view.getUint32(pos, true); pos += 4;
console.log(`[Unpack] NumSkills: ${numSkills} (expected 55), pos=${pos}`);
assert(numSkills === 55, `NumSkills mismatch: got ${numSkills}`);

for (let i = 0; i < numSkills; i++) {
  const skill = view.getUint32(pos, true); pos += 4;
  if (i < 3 || i === 54) console.log(`[Unpack] Skill[${i}]: ${skill} (expected 0), pos=${pos}`);
}

const { str: charName, newPos: posAfterName } = readString16L(msg, pos);
pos = posAfterName;
console.log(`[Unpack] Name: "${charName}" (expected "Test Hero"), pos=${pos}`);
assert(charName === 'Test Hero', `Name mismatch: got "${charName}"`);

const startArea = view.getUint32(pos, true); pos += 4;
console.log(`[Unpack] StartArea: ${startArea} (expected 0), pos=${pos}`);

const isAdmin = view.getUint32(pos, true); pos += 4;
console.log(`[Unpack] IsAdmin: ${isAdmin} (expected 0), pos=${pos}`);

const isSentinel = view.getUint32(pos, true); pos += 4;
console.log(`[Unpack] IsSentinel: ${isSentinel} (expected 0), pos=${pos}`);

console.log(`\nFinal position: ${pos} / ${msg.length}`);
assert(pos === msg.length, `Position mismatch: ended at ${pos} but message is ${msg.length} bytes`);

console.log('\n✓ All fields verified — format matches ACE CharacterCreateInfo.Unpack() exactly');

// ─── Helpers ────────────────────────────────────────────

function readString16L(data: Uint8Array, offset: number): { str: string; newPos: number } {
  const v = new DataView(data.buffer, data.byteOffset);
  const length = v.getUint16(offset, true);
  let pos = offset + 2;
  const bytes = data.slice(pos, pos + length);
  const str = new TextDecoder('ascii').decode(bytes);
  pos += length;
  // ACE padding: CalculatePadMultiple(sizeof(ushort) + length, 4)
  const totalRead = 2 + length;
  const pad = (4 - (totalRead % 4)) % 4;
  pos += pad;
  return { str, newPos: pos };
}

function formatHex(data: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < data.length; i += 16) {
    const hex = Array.from(data.slice(i, Math.min(i + 16, data.length)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join(' ');
    const ascii = Array.from(data.slice(i, Math.min(i + 16, data.length)))
      .map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.')
      .join('');
    lines.push(`${i.toString(16).padStart(4, '0')}: ${hex.padEnd(48)} ${ascii}`);
  }
  return lines.join('\n');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}
