/**
 * BUG.object-blobs-dropped-before-create — the SmartBox object-message
 * handlers queue a message they cannot apply yet instead of dropping it.
 *
 * Retail (reference/client-eol, decomp): HandleDeleteObject @ 00451ea0,
 * HandleObjDescEvent @ 00453340, HandleSetState @ 004533e0,
 * HandleVectorUpdate @ 00453480, HandlePickupEvent @ 00453530,
 * HandleParentEvent @ 004535d0 and UnpackPositionEvent @ 004542c0 each look
 * the object up and compare the message's instance stamp with the object's
 * update_times[INSTANCE_TS]. No object, or an object OLDER than the message
 * (its new CreateObject is still on the way), and the message goes to
 * CObjectMaint::QueueBlobForObject @ 005092d0 (returning NETBLOB_QUEUED);
 * SmartBox::ProcessObjectNetBlobs @ 00454b20 replays the queue when the
 * object is created, and the null placeholder holding it is destroyed after
 * NONVISIBLE_OBJECT_DESTRUCTION_TIME if it never is. HandleParentEvent
 * checks the holder against the stamp (it is the holder's instance) and
 * queues on whichever of the holder and the item is missing.
 *
 * Pre-fix every one of these returned early for an unknown guid: e.g. ACE
 * sends a wielded item's ParentEvent before its CreateObject
 * (BUG.wielded-item-left-behind-on-teleport), and a DeleteObject racing a
 * CreateObject was lost, leaving the object in the world.
 */
import type { ServerMessageHandlers } from '../network/ServerMessageHandler.js';

/** The handlers whose message targets one object and carries its instance stamp. */
export const OBJECT_BLOB_HANDLERS = [
  'onObjectDelete', 'onUpdatePosition', 'onMovementEvent', 'onSetState',
  'onObjDescEvent', 'onPickupEvent', 'onVectorUpdate',
] as const satisfies ReadonlyArray<keyof ServerMessageHandlers>;

export interface ObjectBlobGate {
  /**
   * Queue `replay` for `guid` and return true when the message cannot be
   * applied now (no object, an older instance than `instanceSequence`, or
   * earlier messages for it still queued); false = apply it now.
   */
  defer(guid: number, instanceSequence: number | undefined, replay: () => void): boolean;
  /**
   * HandleCreateObject @ 00454c80's first test: a CreateObject whose
   * PhysicsDesc parent is not known yet is queued ON THE PARENT, whole, and
   * replayed when the parent is created. True = queued.
   */
  deferUntilKnown(guid: number, replay: () => void): boolean;
}

/**
 * Wrap the object-message handlers so each first asks `gate` whether to
 * defer; a deferred message re-enters the wrapped handler on replay (and is
 * asked again, so a still-missing holder re-queues a ParentEvent).
 */
export function gateObjectHandlers(handlers: ServerMessageHandlers, gate: ObjectBlobGate): ServerMessageHandlers {
  const out: ServerMessageHandlers = { ...handlers };
  for (const key of OBJECT_BLOB_HANDLERS) {
    const inner = handlers[key] as ((d: { guid: number; instanceSequence?: number }) => void) | undefined;
    if (!inner) continue;
    const wrapped = (d: { guid: number; instanceSequence?: number }): void => {
      if (gate.defer(d.guid, d.instanceSequence, () => wrapped(d))) return;
      inner(d);
    };
    (out as Record<string, unknown>)[key] = wrapped;
  }
  const parent = handlers.onParentEvent;
  if (parent) {
    const wrappedParent: NonNullable<ServerMessageHandlers['onParentEvent']> = (d) => {
      // HandleParentEvent: the stamp is the HOLDER's instance (ACE
      // GameMessageParentEvent writes creature.Sequences ObjectInstance), so
      // the holder is checked with it; then the item need only exist.
      if (gate.defer(d.creatureGuid, d.instanceSequence, () => wrappedParent(d))) return;
      if (gate.defer(d.wieldedGuid, undefined, () => wrappedParent(d))) return;
      parent(d);
    };
    out.onParentEvent = wrappedParent;
  }
  return out;
}

/** What the gate needs to know about the client's objects. */
export interface ObjectBlobGateDeps {
  /** The queue (PendingPlayScripts — one per client, so an object's messages keep their order). */
  queue: {
    queue(guid: number, replay: () => void, now: number, ready?: () => boolean): void;
    has(guid: number): boolean;
  };
  /** The world record's instance stamp: a number, undefined when it has none, null when there is no world record. */
  worldInstance(guid: number): number | undefined | null;
  /** True for an object the client knows without a world record (ourselves, our pack, an open chest's contents). */
  knownWithoutWorldRecord(guid: number): boolean;
  isNewer(a: number, b: number): boolean;
  now(): number;
}

/** The SmartBox handlers' queue-or-apply decision (see the header). */
export function createObjectBlobGate(deps: ObjectBlobGateDeps): ObjectBlobGate {
  return {
    deferUntilKnown: (guid, replay) => {
      if (deps.worldInstance(guid) !== null || deps.knownWithoutWorldRecord(guid)) return false;
      deps.queue.queue(guid, replay, deps.now());
      return true;
    },
    defer: (guid, instanceSequence, replay) => {
      const instance = deps.worldInstance(guid);
      if (instance === null) {
        if (deps.knownWithoutWorldRecord(guid)) return false;
        deps.queue.queue(guid, replay, deps.now());
        return true;
      }
      // Earlier messages for this object are still waiting: keep the order.
      if (deps.queue.has(guid)) {
        deps.queue.queue(guid, replay, deps.now());
        return true;
      }
      // A message for a NEWER instance waits for that instance's CreateObject.
      if (instanceSequence !== undefined && instance !== undefined && deps.isNewer(instanceSequence, instance)) {
        deps.queue.queue(guid, replay, deps.now(), () => {
          const cur = deps.worldInstance(guid);
          return cur !== null && (cur === undefined || !deps.isNewer(instanceSequence, cur));
        });
        return true;
      }
      return false;
    },
  };
}
