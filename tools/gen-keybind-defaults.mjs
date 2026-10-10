// CORE.17.k.b.b.a.g.f — bake the retail default key bindings from the portal
// KeyMap DAT (0x14000000 gmDefaultMap + 0x14000002 DefaultMap) and the
// ActionMap (0x26000000) into packages/renderer/src/input/KeybindDefaults.generated.ts.
//
//   npx tsx tools/gen-keybind-defaults.mjs
//
// The conversion itself lives in packages/renderer/src/input/KeyMapDefaults.ts
// (pure, unit-tested against the real DAT when present); this script only
// does the DAT I/O and the TypeScript emit.
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { DatDatabase, DatReader, ActionMap, KeyMap, KEYMAP_GAME_DEFAULT_ID, KEYMAP_ENGINE_DEFAULT_ID } =
  await import(resolve(REPO, 'packages/dat-parser/src/index.ts'));
const { KEYBIND_ACTIONS } = await import(resolve(REPO, 'packages/renderer/src/input/KeybindActions.generated.ts'));
const { keyMapsToDefaults } = await import(resolve(REPO, 'packages/renderer/src/input/KeyMapDefaults.ts'));

async function openDat(path) {
  const buf = fs.readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new DatDatabase(ab);
}

const portal = await openDat(resolve(REPO, 'dat/client_portal.dat'));
const actionMap = ActionMap.read(new DatReader(portal.getFileData(0x26000000)));
const maps = [KEYMAP_GAME_DEFAULT_ID, KEYMAP_ENGINE_DEFAULT_ID].map((id) => KeyMap.read(new DatReader(portal.getFileData(id))));
const named = new Set(KEYBIND_ACTIONS.map((a) => a.id));
const byId = new Map(KEYBIND_ACTIONS.map((a) => [a.id, a]));
const r = keyMapsToDefaults(maps, actionMap, named);

const hex = (n) => '0x' + (n >>> 0).toString(16);
let out = `// AUTO-GENERATED from portal.dat KeyMap ${hex(maps[0].id)} "${maps[0].name}" + ${hex(maps[1].id)} "${maps[1].name}"\n`;
out += `// and ActionMap 0x26000000 — do not hand-edit. Regenerate: npx tsx tools/gen-keybind-defaults.mjs\n`;
out += `// (CORE.17.k.b.b.a.g.f — the conversion is packages/renderer/src/input/KeyMapDefaults.ts).\n\n`;
out += `/** The two retail KeyMap files, in the client's merge order. */\n`;
out += `export const RETAIL_KEYMAP_FILES: ReadonlyArray<{ id: number; name: string }> = [\n`;
for (const m of maps) out += `  { id: ${hex(m.id)}, name: ${JSON.stringify(m.name)} },\n`;
out += `];\n\n`;
out += `/** actionId → canonical KeybindRegistry codes, in DAT order (Mapping 1 / 2 / 3). Keyboard + mouse devices. */\n`;
out += `export const RETAIL_DEFAULT_KEYBINDS: Record<number, string[]> = {\n`;
const ids = Object.keys(r.defaults).map(Number).sort((a, b) => a - b);
for (const id of ids) {
  const a = byId.get(id);
  out += `  [${hex(id)}]: ${JSON.stringify(r.defaults[id])}, // ${a ? a.name : '?'}\n`;
}
out += `};\n\n`;
out += `/** actionId → the ActionMap input map (KeyMap section) that owns it. */\n`;
out += `export const ACTION_INPUT_MAP: Record<number, number> = {\n`;
for (const id of Object.keys(r.actionInputMap).map(Number).sort((a, b) => a - b)) {
  if (!named.has(id)) continue;
  out += `  [${hex(id)}]: ${hex(r.actionInputMap[id])},\n`;
}
out += `};\n\n`;
out += `/** inputMapId → the input maps the ActionMap declares co-active with it (InputMapConflicts). */\n`;
out += `export const INPUT_MAP_COACTIVE: Record<number, number[]> = {\n`;
for (const id of Object.keys(r.coactive).map(Number).sort((a, b) => a - b)) {
  out += `  [${hex(id)}]: [${r.coactive[id].map(hex).join(', ')}],\n`;
}
out += `};\n\n`;
out += `/**\n * CORE.17.k.b.b.a.g.f.a — inputMapId → actionId → codes of every (section, action)\n`;
out += ` * pair in the two KeyMaps (the dialog's row for an action under a map it does\n`;
out += ` * not own — the alternate-camera map 0x6 — reads its keys here).\n */\n`;
out += `export const RETAIL_SECTION_KEYBINDS: Record<number, Record<number, string[]>> = {\n`;
for (const mapId of Object.keys(r.sectionDefaults).map(Number).sort((a, b) => a - b)) {
  const section = r.sectionDefaults[mapId];
  const actionIds = Object.keys(section).map(Number).sort((a, b) => a - b);
  out += `  [${hex(mapId)}]: {\n`;
  for (const id of actionIds) out += `    [${hex(id)}]: ${JSON.stringify(section[id])}, // ${byId.get(id)?.name ?? '?'}\n`;
  out += `  },\n`;
}
out += `};\n`;

const target = resolve(REPO, 'packages/renderer/src/input/KeybindDefaults.generated.ts');
fs.writeFileSync(target, out);
console.error(`wrote ${target}: ${ids.length} actions bound, ${r.skipped.length} bindings skipped`);
for (const s of r.skipped) console.error(`  skipped map ${hex(s.inputMapId)} action ${hex(s.actionId)} (${byId.get(s.actionId)?.name}) raw ${hex(s.raw)} meta ${hex(s.metaMode)}: ${s.reason}`);
