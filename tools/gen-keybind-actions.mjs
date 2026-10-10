// Bake the retail command list from the portal ActionMap (0x26000000) into
// packages/renderer/src/input/KeybindActions.generated.ts.
//
//   npx tsx tools/gen-keybind-actions.mjs
//
// KEYBIND_ACTIONS — one entry per named, user-bindable action id (class 1-7),
// sorted (class, id); the name + description resolve through StringTable
// 0x23000005 (ActionMap::GetDescripValues).
// KEYBIND_ACTION_ROWS — CORE.17.k.b.b.a.g.f.a: the (input map, action) pairs
// in DAT order, which is the order gmKeyboardUI::InitOptions @ 004dd8b0 walks
// them (every input map of the ActionMap, every user-bindable action in it,
// grouped per action class into the tab's list under one header row per
// input map — GetStringInfoFromInputMapID @ 004da980). An action listed in
// two maps (the camera commands in map 0x5 and the alternate-camera map 0x6)
// is two rows.
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { DatDatabase, DatReader, ActionMap, registerStringTable, getString, parseStringTable } =
  await import(resolve(REPO, 'packages/dat-parser/src/index.ts'));

function openDat(path) {
  const buf = fs.readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new DatDatabase(ab, 0);
}
const portal = openDat(resolve(REPO, 'dat/client_portal.dat'));
const ui = openDat(resolve(REPO, 'dat/client_local_English.dat'));
for (const db of [portal, ui]) for (const sid of [0x23000005, 0x23000001]) {
  const d = db.getFileData(sid); if (d) try { registerStringTable(parseStringTable(new DatReader(d))); } catch { /* absent */ }
}
const am = ActionMap.read(new DatReader(portal.getFileData(0x26000000)));

// class -> tab name
const CLASS = { 1: 'Movement', 2: 'Camera', 3: 'UI', 4: 'Combat', 5: 'Emotes', 7: 'CharacterSettings' };
// Collect named actions, dedup by action id (key), keep first category that names it.
const seen = new Map();
const rows = [];
for (const [cat, vals] of am.inputMaps) {
  for (const [keycode, v] of vals) {
    const cls = v.userBindingData.actionClass;
    if (!CLASS[cls]) continue; // skip class 0 (unnamed/reserved) and unknown
    const name = getString(v.userBindingData.actionNameHash);
    if (!name || name.startsWith('#')) continue;
    rows.push({ map: cat, id: keycode });
    if (seen.has(keycode)) continue;
    const desc = getString(v.userBindingData.descriptionHash);
    seen.set(keycode, { id: keycode, cls, name: name.trim(), desc: desc && !desc.startsWith('#') ? desc.trim() : '' });
  }
}
const actions = [...seen.values()].sort((a, b) => a.cls - b.cls || a.id - b.id);
const byClass = {};
for (const r of actions) (byClass[r.cls] ??= []).push(r);
for (const [c, n] of Object.entries(CLASS)) console.error(`${n} (class ${c}): ${(byClass[c] || []).length}`);
console.error('TOTAL named actions:', actions.length, '— dialog rows (map, action):', rows.length);

const hex = (n) => '0x' + (n >>> 0).toString(16);
// Emit TS
let out = `// AUTO-GENERATED from portal.dat ActionMap (0x26000000) — do not hand-edit.\n`;
out += `// Regenerate: npx tsx tools/gen-keybind-actions.mjs. Names, descriptions + classes\n`;
out += `// are the retail command strings resolved via StringTable 0x23000005.\n`;
out += `import { ActionClass } from './KeybindActionClass.js';\n\n`;
out += `export interface KeybindAction {\n  /** AC action id (ActionMap key). */ id: number; cls: ActionClass; name: string;\n`;
out += `  /** The ActionMap description (UserBindingValue.descriptionHash) — the dialog row's tooltip. */ desc: string;\n}\n\n`;
out += `export const KEYBIND_ACTIONS: KeybindAction[] = [\n`;
for (const r of actions) {
  out += `  { id: ${hex(r.id)}, cls: ActionClass.${CLASS[r.cls]}, name: ${JSON.stringify(r.name)}, desc: ${JSON.stringify(r.desc)} },\n`;
}
out += `];\n\n`;
out += `/**\n * The Keyboard Config dialog rows — (input map, action) in ActionMap DAT order\n`;
out += ` * (gmKeyboardUI::InitOptions @ 004dd8b0 walks every input map, then every\n`;
out += ` * user-bindable action in it). CORE.17.k.b.b.a.g.f.a.\n */\n`;
out += `export const KEYBIND_ACTION_ROWS: ReadonlyArray<{ map: number; id: number }> = [\n`;
for (const r of rows) out += `  { map: ${hex(r.map)}, id: ${hex(r.id)} },\n`;
out += `];\n`;
const target = resolve(REPO, 'packages/renderer/src/input/KeybindActions.generated.ts');
fs.writeFileSync(target, out);
console.error(`wrote ${target}`);
