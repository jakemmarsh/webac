import { DatReader } from '../DatReader.js';
import { readAnimationHook, type AnimationHook } from './AnimationHook.js';

/**
 * PhysicsScript — portal.dat files starting with 0x33.
 *
 * A PhysicsScript is a time-ordered sequence of AnimationHooks that fire at
 * specific offsets (in seconds) from script start. ACE/AC uses these for:
 *  - Spell visual effects (cast / impact / fizzle particle sequences).
 *  - Item glow/imbue effects.
 *  - Container open/close cinematic effects.
 *  - Portal-receive / portal-send flashes.
 *  - Death decay sequences (fade + particle puff + sound).
 *  - Weather state changes.
 *
 * Each `ScriptData` entry has a double-precision `startTime` so multiple
 * hooks can fire at the same frame in an exact order. Reference:
 *   reference/ACE/Source/ACE.DatLoader/FileTypes/PhysicsScript.cs
 *   reference/ACE/Source/ACE.DatLoader/Entity/PhysicsScriptData.cs
 */
export interface PhysicsScriptStep {
  /** Seconds from script start when the hook fires. */
  startTime: number;
  /** The AnimationHook to fire (Sound / CreateParticle / Scale / Diffuse / …). */
  hook: AnimationHook | null;
}

export class PhysicsScript {
  id: number = 0;
  steps: PhysicsScriptStep[] = [];

  static read(reader: DatReader): PhysicsScript {
    const s = new PhysicsScript();
    s.id = reader.readUInt32();
    const count = reader.readUInt32();
    for (let i = 0; i < count; i++) {
      const startTime = reader.readFloat64();
      const hook = readAnimationHook(reader);
      s.steps.push({ startTime, hook });
    }
    return s;
  }
}

/**
 * One entry in a PhysicsScriptTable's per-key script list — pairs a scriptId
 * (0x33xxxxxx PhysicsScript ID) with a `mod` float.
 *
 * SWEEP.8 correction: `mod` is NOT a random-selection probability/weight —
 * that was an unverified guess (ACE.Server's own PhysicsScriptTable.GetScript
 * is a stub that always `return 0`, so ACE never implemented the real
 * semantics). The decompiled retail client
 * (PhysicsScriptTableData::GetScript @ 00521a20, reference/client-eol) shows
 * a deterministic threshold walk: `if (intensity <= entry.mod) return
 * entry.scriptId` over the array in stored order (Ghidra reconstructs the
 * x86 float compare as `(a<b) != (a==b)`, which is `a<=b` since the two
 * conditions are mutually exclusive). `mod` values are thresholds an
 * intensity must not exceed, and the array's first matching (i.e. lowest
 * qualifying) entry wins — see selectPhysicsScriptByIntensity below.
 */
export interface PhysicsScriptModEntry {
  /** Intensity threshold: this entry qualifies when intensity <= mod. */
  mod: number;
  /** PhysicsScript ID (0x33xxxxxx) to invoke if this entry is selected. */
  scriptId: number;
}

/**
 * PhysicsScriptTable — portal.dat files starting with 0x34.
 *
 * A nested dictionary keyed by trigger-type uint32 (a PlayScript enum value
 * for DefaultScript / GameMessageScript triggers). Each key maps to a list
 * of `ScriptAndModData` entries so a single trigger (e.g. "default script for
 * ItemType.Wand") can resolve to one of several PhysicsScripts, chosen by an
 * intensity threshold walk — see PhysicsScriptModEntry and
 * selectPhysicsScriptByIntensity.
 *
 * Reference:
 *   reference/ACE/Source/ACE.DatLoader/FileTypes/PhysicsScriptTable.cs
 *   reference/ACE/Source/ACE.DatLoader/Entity/PhysicsScriptTableData.cs
 *   reference/ACE/Source/ACE.DatLoader/Entity/ScriptAndModData.cs
 *   reference/ACE/Source/ACE.Server/Physics/PhysicsObj.cs:3058 (GetScript call site)
 */
export class PhysicsScriptTable {
  id: number = 0;
  /** Trigger-type uint32 key → list of weighted script entries. */
  scripts: Map<number, PhysicsScriptModEntry[]> = new Map();

  static read(reader: DatReader): PhysicsScriptTable {
    const t = new PhysicsScriptTable();
    t.id = reader.readUInt32();
    // PackableHashTable header: totalObjects (uint16) + bucketSize (uint16)
    const total = reader.readUInt16();
    reader.readUInt16(); // bucket size — unused for in-order iteration
    for (let i = 0; i < total; i++) {
      const key = reader.readUInt32();
      // PhysicsScriptTableData: List<ScriptAndModData>
      const count = reader.readUInt32();
      const list: PhysicsScriptModEntry[] = [];
      for (let j = 0; j < count; j++) {
        const mod = reader.readFloat32();
        const scriptId = reader.readUInt32();
        list.push({ mod, scriptId });
      }
      t.scripts.set(key, list);
    }
    return t;
  }
}

/**
 * Selects a PhysicsScript from a PhysicsScriptTable trigger-key's entry list
 * by intensity threshold, matching the decompiled retail client's
 * PhysicsScriptTableData::GetScript (@ 00521a20) and ACE server's
 * PhysicsScriptTable.GetScript(PlayScript?, float?) call convention
 * (reference/ACE/Source/ACE.Server/Physics/PhysicsObj.cs:3058) — the server
 * itself never implemented the lookup (stub `return 0`), so this is the only
 * faithful implementation available; see PhysicsScriptModEntry for the
 * decompilation citation.
 *
 * Walks entries in stored array order and returns the scriptId of the first
 * entry whose `mod` threshold is >= intensity. Returns 0 (no script) if no
 * entry qualifies, matching the retail client falling through to
 * ::INVALID_DID.
 */
export function selectPhysicsScriptByIntensity(entries: PhysicsScriptModEntry[] | undefined, intensity: number): number {
  if (!entries) return 0;
  for (const entry of entries) {
    if (intensity <= entry.mod) return entry.scriptId;
  }
  return 0;
}
