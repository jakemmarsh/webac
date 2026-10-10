/**
 * The DAT PhysicsScript a PlayScript (PlayEffect 0xF755) plays on its target — retail's
 * CPhysicsObj::play_script: the target's PhysicsScriptTable (the wire PeTable,
 * PhysicsDescriptionFlag 0x1000, else its Setup's DefaultScriptTable) maps the
 * PlayScript enum to intensity-thresholded entries, and
 * PhysicsScriptTableData::GetScript @ 00521a20 picks the first whose mod is
 * ≥ the wire intensity. Every PlayScript resolves this way — a melee hit's
 * Splatter*, a fizzle, a level-up — and a target whose table has no entry
 * plays nothing at all.
 */
import { selectPhysicsScriptByIntensity, type PhysicsScript, type PhysicsScriptTable } from '@ac/dat-parser';

export interface PlayScriptTarget {
  /** The object's PeTable DID (0 when its CreateObject had none). */
  peTableId: number;
  /** The object's Setup DID (0 when unknown). */
  setupId: number;
}

export interface PlayScriptResolution {
  tableId: number;
  scriptId: number;
}

/** The PhysicsScript DID to play, or null when the target's table has no entry. */
export function resolvePlayScript(
  target: PlayScriptTarget,
  scriptEnum: number,
  intensity: number,
  loadTable: (tableId: number) => PhysicsScriptTable | null,
  setupScriptTable: (setupId: number) => number,
): PlayScriptResolution | null {
  let tableId = target.peTableId;
  if (!tableId && target.setupId) tableId = setupScriptTable(target.setupId);
  if (!tableId) return null;
  const entries = loadTable(tableId)?.scripts.get(scriptEnum >>> 0);
  if (!entries?.length) return null;
  const scriptId = selectPhysicsScriptByIntensity(entries, intensity);
  return scriptId ? { tableId, scriptId } : null;
}

/**
 * Where a server PlayScript lands: the object (with the anchor its script
 * plays on), the DAT loaders and the script player. Generic over the anchor
 * so the dispatch runs without a renderer.
 */
export interface PlayScriptSink<A> {
  /** The target object, or null when it is not in the world (yet). */
  target(guid: number): (PlayScriptTarget & { anchor: A }) | null;
  loadTable(tableId: number): PhysicsScriptTable | null;
  setupScriptTable(setupId: number): number;
  loadScript(scriptId: number): PhysicsScript | null;
  play(script: PhysicsScript, anchor: A): void;
}

export type PlayScriptOutcome =
  | { played: true; scriptId: number; tableId?: number }
  | { played: false; reason: 'no-object' | 'no-table-entry' | 'no-script' };

/**
 * PlayEffect (0xF755, ACE GameMessageScript: guid + PScriptType + intensity)
 * → SmartBox::HandlePlayScriptType @ 00452070 → CPhysicsObj::play_script
 * (PScriptType, float) @ 00513260: with no physics_script_table the call
 * returns 0 and NOTHING is drawn; otherwise PhysicsScriptTable::GetScript
 * picks the script by intensity and play_script_internal @ 00510cd0 adds it
 * to the object's ScriptManager. There is no client-side substitute effect
 * for a missing entry (BUG.playscript-fallback-invented-art).
 */
export function playScriptType<A>(
  sink: PlayScriptSink<A>, guid: number, scriptType: number, intensity: number,
): PlayScriptOutcome {
  const target = sink.target(guid);
  if (!target) return { played: false, reason: 'no-object' };
  const resolved = resolvePlayScript(target, scriptType, intensity,
    (id) => sink.loadTable(id), (id) => sink.setupScriptTable(id));
  if (!resolved) return { played: false, reason: 'no-table-entry' };
  const script = sink.loadScript(resolved.scriptId);
  if (!script) return { played: false, reason: 'no-script' };
  sink.play(script, target.anchor);
  return { played: true, scriptId: resolved.scriptId, tableId: resolved.tableId };
}

/**
 * PlayScriptId (0xF754: guid + a 0x33 PhysicsScript DID) →
 * SmartBox::HandlePlayScriptID @ 00452020 → CPhysicsObj::play_script(DID)
 * @ 00510d30 → play_script_internal: the DID plays directly, no table.
 * (ACE never sends this opcode; retail servers did.)
 */
export function playScriptDid<A>(sink: PlayScriptSink<A>, guid: number, scriptDid: number): PlayScriptOutcome {
  const target = sink.target(guid);
  if (!target) return { played: false, reason: 'no-object' };
  const script = scriptDid ? sink.loadScript(scriptDid >>> 0) : null;
  if (!script) return { played: false, reason: 'no-script' };
  sink.play(script, target.anchor);
  return { played: true, scriptId: scriptDid >>> 0 };
}

/**
 * BUG.spell-projectile-physics — the scripts an object's own defaults play.
 *
 *  - On creation only the SETUP's DefaultScript runs (a DID).
 *  - The PhysicsDesc DefaultScript (a PlayScript enum + intensity — ACE
 *    PhysicsDesc.cs:31) is only STORED by CPhysicsObj::set_description
 *    (decomp :267624) and played by CPhysicsObj::play_default_script, whose
 *    callers are the DefaultScript[Part]Hook animation hooks and
 *    ACCWeenieObject::DoCollision (a ScriptedCollision missile's contact) —
 *    resolved like any PlayScript through the object's table by intensity.
 *    Playing it at creation fired each spell projectile's
 *    ProjectileCollision burst at the caster on launch.
 */
export function creationScriptId(setupDefaultScript: number | undefined): number | undefined {
  return setupDefaultScript || undefined;
}

/**
 * CPhysicsObj::InitDefaults @ 005139d0 → play_script_internal: a new
 * object plays its Setup's DefaultScript on `anchor`, whatever else is
 * running (BUG.default-script-80-cap — there is no limit; ours used to skip
 * it past 80 active scripts, so a portal neither swirled nor hummed).
 * Returns the script DID it started, or undefined.
 */
export function playCreationDefaultScript<A>(
  anchor: A,
  setupDefaultScript: number | undefined,
  loadScript: (scriptId: number) => PhysicsScript | null,
  play: (script: PhysicsScript, anchor: A) => void,
): number | undefined {
  const scriptId = creationScriptId(setupDefaultScript);
  if (!scriptId) return undefined;
  const script = loadScript(scriptId);
  if (!script) return undefined;
  play(script, anchor);
  return scriptId;
}

export interface DefaultScriptTarget extends PlayScriptTarget {
  /** PhysicsDesc DefaultScript (PlayScript enum); 0 = none. */
  defaultScriptOverride?: number;
  defaultScriptIntensity?: number;
}

/** The PhysicsScript DID `play_default_script` plays for this object, or undefined. */
export function physicsDescDefaultScriptId(
  target: DefaultScriptTarget,
  loadTable: (tableId: number) => PhysicsScriptTable | null,
  setupScriptTable: (setupId: number) => number,
): number | undefined {
  if (!target.defaultScriptOverride) return undefined;
  // CPhysicsDesc::UnPack (:277285): an absent DefaultScriptIntensity is 0.0.
  return resolvePlayScript(target, target.defaultScriptOverride, target.defaultScriptIntensity ?? 0,
    loadTable, setupScriptTable)?.scriptId;
}

/**
 * BUG.playscript-queued-for-missing-object — SmartBox::HandlePlayScriptType
 * @ 00452070 (and HandlePlayScriptID) do not drop a script for an object the
 * client doesn't have yet: CObjectMaint::QueueBlobForObject @ 005092d0 parks
 * the message on a null placeholder object (GetNullObject) and
 * CPhysicsObj::queue_netblob replays it once the object is created. The
 * placeholder is scheduled for destruction NONVISIBLE_OBJECT_DESTRUCTION_TIME
 * (25 s) later (AddObjectToBeDestroyed @ 00508f70), which discards the queue
 * if the object never arrives.
 *
 * Here: a no-object outcome is parked with its retry; `pump` (every frame)
 * replays entries whose object now exists, in arrival order per object, and
 * drops entries older than 25 s.
 */
export const NONVISIBLE_OBJECT_DESTRUCTION_TIME_MS = 25_000;

/**
 * Any queued message's outcome: `played`, or why not — only 'no-object' is
 * parked. The same queue carries Sound messages (SmartBox::HandleSoundEvent
 * @ 00451fc0 queues through QueueBlobForObject too — BUG.server-sound-not-
 * positional), so one object's blobs replay in arrival order.
 */
export type QueuedBlobOutcome = { played: true } | { played: false; reason: string };

export class PendingPlayScripts {
  private readonly byGuid = new Map<number, Array<{ at: number; retry: () => unknown; ready?: () => boolean }>>();

  /** Park a play that found no object; returns true when it was queued. */
  park(outcome: QueuedBlobOutcome, guid: number, retry: () => unknown, now: number): boolean {
    if (outcome.played || outcome.reason !== 'no-object') return false;
    this.queue(guid, retry, now);
    return true;
  }

  /**
   * Queue any message for `guid` (CObjectMaint::QueueBlobForObject). `ready`
   * gates the replay beyond "the object exists": a message for a NEWER
   * instance than the record we hold waits for that instance's CreateObject
   * (the SmartBox handlers queue on `update_times[INSTANCE_TS]` being older).
   */
  queue(guid: number, retry: () => unknown, now: number, ready?: () => boolean): void {
    const e = { at: now, retry, ready };
    const list = this.byGuid.get(guid);
    if (list) list.push(e);
    else this.byGuid.set(guid, [e]);
  }

  /** True while `guid` has queued messages (a later one must queue behind them). */
  has(guid: number): boolean {
    return this.byGuid.has(guid);
  }

  /**
   * SmartBox::ProcessObjectNetBlobs @ 00454b20 — the object was just
   * created: replay its queue now, in arrival order, up to the first entry
   * that is still not ready (that one and the rest stay queued). Expired
   * entries are dropped.
   */
  replayFor(guid: number, now: number): void {
    const list = this.byGuid.get(guid);
    if (!list) return;
    this.byGuid.delete(guid);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (now - e.at > NONVISIBLE_OBJECT_DESTRUCTION_TIME_MS) continue;
      if (e.ready && !e.ready()) {
        const rest = list.slice(i);
        const queuedMeanwhile = this.byGuid.get(guid);
        this.byGuid.set(guid, queuedMeanwhile ? rest.concat(queuedMeanwhile) : rest);
        return;
      }
      e.retry();
    }
  }

  /** Replay what can play now; expire the rest after 25 s. */
  pump(now: number, exists: (guid: number) => boolean): void {
    for (const [guid, list] of [...this.byGuid]) {
      const live = list.filter((e) => now - e.at <= NONVISIBLE_OBJECT_DESTRUCTION_TIME_MS);
      if (live.length === 0) { this.byGuid.delete(guid); continue; }
      if (live.length !== list.length) this.byGuid.set(guid, live);
      if (exists(guid)) this.replayFor(guid, now);
    }
  }

  get size(): number {
    let n = 0;
    for (const l of this.byGuid.values()) n += l.length;
    return n;
  }
}
