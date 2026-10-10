/**
 * Export the weenieClassId → setupId map to a JSON file the browser can fetch.
 *
 * Reads from `dat/world.sqlite` (produced by `tools/world-db-convert.ts`)
 * and writes `public/dat/weenie-setups.json`. Used by the renderer to look
 * up the SetupModel for a wielded item when ParentEvent fires (UI.46–58
 * chain) — the appraisal flow doesn't carry Setup, and inventory items
 * never get a CreateObject, so this lookup is the only way to get the
 * mesh DID for an inventory item without server-side changes.
 *
 * Run: `npx tsx tools/export-weenie-setups.ts`
 *
 * PropertyDataId.Setup = 1 — anchored to ACE PropertyDataId.cs:11.
 */
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

const ROOT = resolve(import.meta.dirname, '..');
const DB_PATH = resolve(ROOT, 'dat/world.sqlite');
// Vite's publicDir is `dat/` (see vite.config.ts), so files there are
// served as `/<name>` from the browser. Output to `dat/` directly.
const SETUP_OUT_PATH = resolve(ROOT, 'dat/weenie-setups.json');
const COMBAT_OUT_PATH = resolve(ROOT, 'dat/weenie-combat-styles.json');

const db = new Database(DB_PATH, { readonly: true });

// PropertyDataId.Setup = 1
const setupRows = db.prepare(
  'SELECT object_Id AS wcid, value AS setupId FROM weenie_properties_d_i_d WHERE type = 1'
).all() as { wcid: number; setupId: number }[];

const setupMap: Record<number, number> = {};
for (const { wcid, setupId } of setupRows) {
  setupMap[wcid] = setupId;
}

mkdirSync(dirname(SETUP_OUT_PATH), { recursive: true });
writeFileSync(SETUP_OUT_PATH, JSON.stringify(setupMap));
console.log(`Exported ${setupRows.length} weenie → setupId entries to ${SETUP_OUT_PATH}`);
console.log(`  Size: ${(JSON.stringify(setupMap).length / 1024).toFixed(1)} KB`);

// PropertyInt.DefaultCombatStyle = 46. Only export non-zero entries —
// most weenies aren't weapons (~3k of 30k) so the file stays tiny.
// Used by the equipped-item viz path to route Bow/Crossbow → LeftHand
// per ACE Creature_Equipment.cs:84-95.
const combatRows = db.prepare(
  'SELECT object_Id AS wcid, value AS combatStyle FROM weenie_properties_int WHERE type = 46 AND value > 0'
).all() as { wcid: number; combatStyle: number }[];

const combatMap: Record<number, number> = {};
for (const { wcid, combatStyle } of combatRows) {
  combatMap[wcid] = combatStyle;
}

writeFileSync(COMBAT_OUT_PATH, JSON.stringify(combatMap));
console.log(`Exported ${combatRows.length} weenie → combatStyle entries to ${COMBAT_OUT_PATH}`);
console.log(`  Size: ${(JSON.stringify(combatMap).length / 1024).toFixed(1)} KB`);

// PropertyInt.AttackType = 47 (W_AttackType flags). GAP.9 — needed by the
// client-side swing-animation selection (shared/combat/SwingAnimation.ts,
// port of ACE WorldObject_Weapon.GetAttackType) so the equipped weapon can
// pick Thrust vs Slash (and multi-strike) motions from the
// CombatManeuverTable exactly like the server does.
const ATTACK_OUT_PATH = resolve(ROOT, 'dat/weenie-attack-types.json');
const attackRows = db.prepare(
  'SELECT object_Id AS wcid, value AS attackType FROM weenie_properties_int WHERE type = 47 AND value > 0'
).all() as { wcid: number; attackType: number }[];

const attackMap: Record<number, number> = {};
for (const { wcid, attackType } of attackRows) {
  attackMap[wcid] = attackType;
}

writeFileSync(ATTACK_OUT_PATH, JSON.stringify(attackMap));
console.log(`Exported ${attackRows.length} weenie → attackType entries to ${ATTACK_OUT_PATH}`);
console.log(`  Size: ${(JSON.stringify(attackMap).length / 1024).toFixed(1)} KB`);

// PropertyFloat.MaximumVelocity = 26. GAP.10 — drives the client-side
// max-missile-range gate (shared/combat/MissileRange.ts, port of ACE
// Creature_Missile.cs:406 GetMaxMissileRange).
const MAXVEL_OUT_PATH = resolve(ROOT, 'dat/weenie-max-velocity.json');
const maxVelRows = db.prepare(
  'SELECT object_Id AS wcid, value AS maxVelocity FROM weenie_properties_float WHERE type = 26 AND value > 0'
).all() as { wcid: number; maxVelocity: number }[];

const maxVelMap: Record<number, number> = {};
for (const { wcid, maxVelocity } of maxVelRows) {
  maxVelMap[wcid] = maxVelocity;
}

writeFileSync(MAXVEL_OUT_PATH, JSON.stringify(maxVelMap));
console.log(`Exported ${maxVelRows.length} weenie → maxVelocity entries to ${MAXVEL_OUT_PATH}`);

// PropertyInt.WeaponTime = 49. BUG.melee-swing-speed-ignores-quickness-weapon —
// drives the client-side melee swing animation speed (shared/combat/AnimSpeed.ts,
// port of ACE Creature_Combat.cs:510 GetAnimSpeed).
const WEAPONTIME_OUT_PATH = resolve(ROOT, 'dat/weenie-weapon-time.json');
const weaponTimeRows = db.prepare(
  'SELECT object_Id AS wcid, value AS weaponTime FROM weenie_properties_int WHERE type = 49'
).all() as { wcid: number; weaponTime: number }[];

const weaponTimeMap: Record<number, number> = {};
for (const { wcid, weaponTime } of weaponTimeRows) {
  weaponTimeMap[wcid] = weaponTime;
}

writeFileSync(WEAPONTIME_OUT_PATH, JSON.stringify(weaponTimeMap));
console.log(`Exported ${weaponTimeRows.length} weenie → weaponTime entries to ${WEAPONTIME_OUT_PATH}`);

db.close();
