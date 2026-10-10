/**
 * BUG.playscript-queued-for-missing-object — retail SmartBox::HandlePlayScriptType
 * @ 00452070 parks a script for an object the client does not have yet
 * (CObjectMaint::QueueBlobForObject @ 005092d0 → queue_netblob on a null
 * placeholder) and replays it when the object is created; the placeholder is
 * destroyed NONVISIBLE_OBJECT_DESTRUCTION_TIME (25 s) later
 * (AddObjectToBeDestroyed @ 00508f70), dropping the queue. Before, ours
 * dropped the script outright.
 */
import { describe, it, expect } from 'vitest';
import {
  PendingPlayScripts, playScriptType, NONVISIBLE_OBJECT_DESTRUCTION_TIME_MS, type PlayScriptSink,
} from '../packages/renderer/src/effects/PlayScriptResolve.js';
import type { PhysicsScript, PhysicsScriptTable } from '@ac/dat-parser';

const SCRIPT = { id: 0x33000097, scripts: [] } as unknown as PhysicsScript;
const TABLE = {
  id: 0x34000004,
  scripts: new Map([[0x1f, [{ mod: 1, scriptId: 0x33000097 }]]]),
} as unknown as PhysicsScriptTable;

function sink(present: Set<number>, played: number[]): PlayScriptSink<string> {
  return {
    target: (g) => (present.has(g) ? { anchor: `obj${g}`, peTableId: 0x34000004, setupId: 0 } : null),
    loadTable: () => TABLE,
    setupScriptTable: () => 0,
    loadScript: (id) => (id === 0x33000097 ? SCRIPT : null),
    play: (_s, anchor) => { played.push(Number(anchor.slice(3))); },
  };
}

describe('BUG.playscript-queued-for-missing-object — PlayEffect for a not-yet-created object replays on creation', () => {
  it('a script for a missing object is parked, then plays once the object exists', () => {
    const present = new Set<number>(); const played: number[] = [];
    const s = sink(present, played); const q = new PendingPlayScripts();
    const r = playScriptType(s, 7, 0x1f, 1);
    expect(r).toEqual({ played: false, reason: 'no-object' });
    expect(q.park(r, 7, () => playScriptType(s, 7, 0x1f, 1), 0)).toBe(true);
    q.pump(100, (g) => present.has(g));
    expect(played).toEqual([]);
    present.add(7);
    q.pump(200, (g) => present.has(g));
    expect(played).toEqual([7]);
    expect(q.size).toBe(0);
    q.pump(300, (g) => present.has(g));
    expect(played).toEqual([7]); // replayed exactly once
  });

  it('entries expire after 25 s (the placeholder is destroyed)', () => {
    const present = new Set<number>(); const played: number[] = [];
    const s = sink(present, played); const q = new PendingPlayScripts();
    q.park(playScriptType(s, 9, 0x1f, 1), 9, () => playScriptType(s, 9, 0x1f, 1), 0);
    q.pump(NONVISIBLE_OBJECT_DESTRUCTION_TIME_MS + 1, (g) => present.has(g));
    expect(q.size).toBe(0);
    present.add(9);
    q.pump(NONVISIBLE_OBJECT_DESTRUCTION_TIME_MS + 2, (g) => present.has(g));
    expect(played).toEqual([]);
  });

  it('only a missing object queues — a missing table entry is not retried', () => {
    const present = new Set<number>([5]); const played: number[] = [];
    const s = sink(present, played); const q = new PendingPlayScripts();
    const r = playScriptType(s, 5, 0x99, 1);
    expect(r).toEqual({ played: false, reason: 'no-table-entry' });
    expect(q.park(r, 5, () => playScriptType(s, 5, 0x99, 1), 0)).toBe(false);
    expect(q.size).toBe(0);
  });
});
