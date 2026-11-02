/**
 * BUG.ac1999-slow-login-ddd-push — the AC1999 server's login DAT push.
 *
 * Prod (2026-10-29..11-01): an AC1999 login reached its character list in
 * 0.1-0.7 s or in 10.7-14.3 s, nothing between. The slow ones are a browser's
 * first login there (no stored patches, so it reports the streamed set's
 * 102 / 67): the server then pushes its whole patch set before the character
 * list (Client.cpp UpdateLoginScreen → PlanDatSync → SendDatFile), paced at
 * max_bytes_per_tick = 4000 bytes a 33 ms window (PacketController.cpp
 * FlushFragments): ~680 KB at ~55 KB/s. Later logins from the same browser
 * report the stored iteration and get nothing.
 *
 * Pinned here, against the shipped code:
 * - Connection1999 reports the push's progress (files and raw bytes, from the
 *   0xF7B8 begin and each 0xF7B7) once armed, and never for an up-to-date login;
 * - the connecting-screen line follows gmDataPatchUI's own strings;
 * - Ac1999World stores one push's files before a later login's manifest
 *   (a relog in the same page) can claim the server's iteration without them;
 * - the end-of-retail / Dark Majesty lane (ClientConnection) is unchanged: it
 *   answers the DDD interrogation with its iterations and emits no 1999 events.
 */
import { describe, expect, it } from 'vitest';
import { Connection1999 } from '../packages/network/src/era1999/Connection1999.js';
import { ClientConnection, GameMessageOpcode, buildDDDInterrogationResponse, GameMessageGroup, type ConnectionEvent } from '@ac/network';
import { Ac1999PatchProgress } from '../packages/renderer/src/era/Ac1999PatchProgress.js';
import { Ac1999World, ac1999PatchKey } from '../packages/renderer/src/era/Ac1999World.js';
import type { DatBlobStore, DatCacheMeta } from '../packages/renderer/src/dat/DatCache.js';
import type { DatDatabase } from '@ac/dat-parser';

function words(...v: number[]): Uint8Array {
  const b = new Uint8Array(v.length * 4);
  const dv = new DataView(b.buffer);
  v.forEach((x, i) => dv.setUint32(i * 4, x >>> 0, true));
  return b;
}

/** 0xF7B8 as Client.cpp writes it: portal it, portal files, cell it, cell files, portal raw bytes, cell raw bytes. */
function dddBegin(portalIt: number, portalFiles: number, cellIt: number, cellFiles: number, portalBytes: number, cellBytes: number): Uint8Array {
  return words(0xf7b8, portalIt, portalFiles, cellIt, cellFiles, portalBytes, cellBytes);
}

/** 0xF7B7 as SendDatFile writes it: id, dbType, compressed length, raw length, the zlib bytes. */
function dddFile(id: number, dbType: number, rawLength: number, compressedLength = 8): Uint8Array {
  const head = words(0xf7b7, id, dbType, compressedLength, rawLength);
  const out = new Uint8Array(head.length + compressedLength);
  out.set(head);
  return out;
}

type Ev = { type: string; files?: number; filesDone?: number; bytes?: number; bytesDone?: number; patches?: unknown[]; portalIteration?: number; cellIteration?: number };

function feed(conn: Connection1999, m: Uint8Array): void {
  (conn as unknown as { onMessage1999(m: Uint8Array, group: number): void }).onMessage1999(m, 7);
}

function collect(conn: Connection1999): Ev[] {
  const events: Ev[] = [];
  conn.on((e) => events.push(e as unknown as Ev));
  return events;
}

describe('Connection1999: the login DAT push reports its progress', () => {
  it('a push: one progress event for the (thrice-sent) begin, one per file with the raw bytes so far, then the patch event', () => {
    const conn = new Connection1999('ws://bridge');
    const events = collect(conn);
    const begin = dddBegin(10006, 2, 10006, 1, 3000, 1000);
    feed(conn, begin); feed(conn, begin); feed(conn, begin);
    expect(events).toEqual([{ type: 'datPatchProgress1999', files: 3, filesDone: 0, bytes: 4000, bytesDone: 0 }]);

    feed(conn, dddFile(0x0e00000e, 0x27, 2000));
    feed(conn, dddFile(0x01000330, 0x27, 1000));
    feed(conn, dddFile(0xda55ffff, 0, 1000));
    const progress = events.filter((e) => e.type === 'datPatchProgress1999');
    expect(progress.map((e) => [e.filesDone, e.bytesDone])).toEqual([[0, 0], [1, 2000], [2, 3000], [3, 4000]]);
    const done = events.filter((e) => e.type === 'datPatch1999');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ portalIteration: 10006, cellIteration: 10006 });
    expect(done[0].patches).toHaveLength(3);
    // The patch event comes after the last progress event.
    expect(events[events.length - 1].type).toBe('datPatch1999');
  });

  it('an up-to-date login (both file counts 0): no progress, just the empty patch event that stamps the iterations', () => {
    const conn = new Connection1999('ws://bridge');
    const events = collect(conn);
    const begin = dddBegin(10006, 0, 10006, 0, 0, 0);
    feed(conn, begin); feed(conn, begin); feed(conn, begin);
    expect(events.filter((e) => e.type === 'datPatchProgress1999')).toEqual([]);
    expect(events).toEqual([{ type: 'datPatch1999', patches: [], portalIteration: 10006, cellIteration: 10006 }]);
  });
});

describe('Ac1999PatchProgress: the connecting-screen line in gmDataPatchUI\'s words', () => {
  it('Patching data..., then "<n>% of <total>K complete...", then Patching Done!', () => {
    const p = new Ac1999PatchProgress();
    expect(p.onProgress({ files: 3, filesDone: 0, bytes: 700 * 1024, bytesDone: 0 })).toBe('Patching data...');
    expect(p.onProgress({ files: 3, filesDone: 1, bytes: 700 * 1024, bytesDone: 175 * 1024 })).toBe('25% of 700K complete...');
    expect(p.onProgress({ files: 3, filesDone: 3, bytes: 700 * 1024, bytesDone: 700 * 1024 })).toBe('100% of 700K complete...');
    expect(p.onFinished()).toBe('Patching Done!');
  });

  it('says nothing when the server had nothing to send, and starts over for a new session\'s push', () => {
    const p = new Ac1999PatchProgress();
    expect(p.onProgress({ files: 0, filesDone: 0, bytes: 0, bytesDone: 0 })).toBeNull();
    expect(p.onFinished()).toBeNull();
    p.onProgress({ files: 2, filesDone: 0, bytes: 2048, bytesDone: 0 });
    expect(p.onProgress({ files: 2, filesDone: 1, bytes: 2048, bytesDone: 1024 })).toBe('50% of 2K complete...');
    // A reconnect mid-push: the new session's begin starts from zero.
    expect(p.onProgress({ files: 2, filesDone: 0, bytes: 4096, bytesDone: 0 })).toBe('Patching data...');
    expect(p.onProgress({ files: 2, filesDone: 1, bytes: 4096, bytesDone: 1024 })).toBe('25% of 4K complete...');
  });
});

/** A DatBlobStore in memory whose writes take a few ms, as OPFS writes do. */
class SlowMemoryStore implements DatBlobStore {
  readonly available = true;
  readonly data = new Map<string, ArrayBuffer>();
  async getMeta(): Promise<DatCacheMeta | null> { return null; }
  async getData(key: string): Promise<ArrayBuffer | null> { return this.data.get(key) ?? null; }
  async put(key: string, data: ArrayBuffer): Promise<void> {
    await new Promise((r) => setTimeout(r, 3));
    this.data.set(key, data.slice(0));
  }
  async remove(key: string): Promise<void> { this.data.delete(key); }
  async clear(): Promise<void> { this.data.clear(); }
}

function fakeDb(): DatDatabase {
  return { setOverlay() { /* the overlay is held by Ac1999World */ }, totalIterations: 102 } as unknown as DatDatabase;
}

function manifest(store: SlowMemoryStore, serverKey: string): { portalIteration: number; cellIteration: number; files: Array<{ id: number }> } {
  const raw = store.data.get(`ac1999-patch__${serverKey}__manifest`);
  if (!raw) throw new Error('no manifest');
  return JSON.parse(new TextDecoder().decode(raw));
}

describe('Ac1999World.persist: a later login never stores the server\'s iteration ahead of the push\'s files', () => {
  it('a relog\'s empty persist waits for the push\'s files; the manifest it leaves lists them all', async () => {
    const world = new Ac1999World(fakeDb(), fakeDb());
    const store = new SlowMemoryStore();
    const key = 'bridge.example__server_ac1999';
    const files = [0x0e00000e, 0x01000330, 0x0e000002].map((id) => ({ dat: 'portal' as const, fileId: id, bytes: new Uint8Array([1, 2, 3]).buffer }));
    world.apply(files, { portal: 10006, cell: 10006 });
    const first = world.persist(store, key, files);
    // The relog in the same page: up to date, so its event carries no files.
    const second = world.persist(store, key, []);
    await second;
    const m = manifest(store, key);
    expect(m.portalIteration).toBe(10006);
    expect(m.files.map((f) => f.id).sort()).toEqual([0x0e00000e, 0x01000330, 0x0e000002].sort());
    for (const f of files) expect(store.data.has(ac1999PatchKey(key, f.fileId))).toBe(true);
    await first;

    // The next visit restores them and reports the server's iteration (so the server sends nothing).
    const next = new Ac1999World(fakeDb(), fakeDb());
    expect(await next.restore(store, key)).toBe(3);
    expect(next.portalOverlay.iteration).toBe(10006);
    expect(next.cellOverlay.iteration).toBe(10006);
  });
});

describe('the end-of-retail / Dark Majesty lane is unchanged', () => {
  it('ClientConnection answers DDD_Interrogation with its own iterations and emits no 1999 push events', () => {
    const conn = new ClientConnection('ws://bridge');
    conn.datIterations = { portal: 2072, cell: 982, language: 994 };
    const events: ConnectionEvent[] = [];
    conn.on((e) => events.push(e));
    const sent: Array<{ data: Uint8Array; group: number }> = [];
    (conn as unknown as { sendMessage(d: Uint8Array, g: number): void }).sendMessage = (data, group) => { sent.push({ data, group }); };
    (conn as unknown as { processMessage(d: Uint8Array): void }).processMessage(words(GameMessageOpcode.DDD_Interrogation, 0, 0));
    expect(sent).toHaveLength(1);
    expect(sent[0].group).toBe(GameMessageGroup.LoginQueue);
    expect([...sent[0].data]).toEqual([...buildDDDInterrogationResponse(2072, 982, 994)]);
    expect(events.some((e) => (e.type as string) === 'datPatchProgress1999' || (e.type as string) === 'datPatch1999')).toBe(false);
  });
});
