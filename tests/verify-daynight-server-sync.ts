/**
 * BUG.daynight-phase-not-server-synced — the day/night cycle must follow the
 * server's game clock, not a free-running clock seeded from a hardcoded 0.35.
 *
 * Ground truth:
 *  - ACE NetworkSession.cs (~965-971) sends the TimeSync optional header
 *    (PacketHeaderFlags.TimeSync = 0x01000000) every 20s, carrying
 *    Timers.PortalYearTicks as a float64 — seconds on the Derethian calendar
 *    (ACE.Common/DerethDateTime.cs: dayTicks = 7620 per day).
 *  - Retail ClientNet::HandleTimeSynch (00543d30) feeds the value into
 *    Timer::set_time (0040f840), which only ever moves the clock FORWARD —
 *    a server value behind the current estimate is ignored.
 *  - Retail GameTime::CalcDayBegin (005a6400) + GameTime::UseTime (005a66f0)
 *    derive the sky phase: ((clock + zero_time_of_year) mod day_length) /
 *    day_length. EoL portal.dat GameTime: dayLength=7620, zeroTimeOfYear=3600,
 *    daysPerYear=360.
 *
 * Under test (behavioral — real ClientConnection bytes, real SkyboxRenderer):
 *  1. A packet with the TimeSync header emits a 'timeSync' event carrying the
 *     exact float64 tick value.
 *  2. SkyboxRenderer.syncGameClock + update() derive the phase per the retail
 *     formula, including the zeroTimeOfYear offset.
 *  3. The clock never moves backward on a stale sync (retail Timer::set_time).
 *  4. Without a sync (solo mode) the phase free-runs exactly as before.
 *  5. Crossing the day boundary through the synced path moves to the next
 *     absolute day's hashed group (CORE.17.r — SkyDesc::CalcPresentDayGroup;
 *     the first synced frame adopts the server day, never a wrap roll).
 *  6. The real portal.dat GameTime carries the constants above (DAT anchor).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import {
  ClientConnection, ConnectionEvent,
  PacketHeaderFlags, PacketHeaderData,
  PACKET_HEADER_SIZE,
  writePacketHeader,
} from '@ac/network';
import { SkyboxRenderer, retailDayGroupIndex, absoluteDayFromClock } from '../packages/renderer/src/effects/SkyboxRenderer.js';
import type { GameTime } from '../packages/dat-parser/src/file-types/RegionDesc.js';
import { openDat } from './_harness/dat.js';

beforeAll(() => {
  if (typeof (globalThis as any).WebSocket === 'undefined') {
    (globalThis as any).WebSocket = class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
    };
  }
});

function buildServerPacket(seq: number, flags: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
  const header: PacketHeaderData = {
    sequence: seq, flags, checksum: 0, id: 0x42, time: 0,
    size: payload.length, iteration: 1,
  };
  writePacketHeader(header, buf, 0);
  buf.set(payload, PACKET_HEADER_SIZE);
  return buf;
}

function makeConn() {
  const conn = new ClientConnection('ws://test-not-connected');
  const events: ConnectionEvent[] = [];
  conn.on(e => events.push(e));
  (conn as any).ws = { readyState: 1, send: () => {}, close: () => {} };
  return { conn, events };
}

describe('ClientConnection — TimeSync header emits the server game clock', () => {
  it("emits 'timeSync' with the exact float64 PortalYearTicks value", () => {
    const { conn, events } = makeConn();
    const ticks = 850_337_942.625; // representative PortalYearTicks magnitude
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setFloat64(0, ticks, true);
    (conn as any).handlePacket(buildServerPacket(2, PacketHeaderFlags.TimeSync, payload));

    const ts = events.filter(e => e.type === 'timeSync');
    expect(ts).toHaveLength(1);
    expect(ts[0].data).toBe(ticks);
  });

  it('a TimeSync alongside AckSequence reads the double at the right offset', () => {
    const { conn, events } = makeConn();
    const ticks = 12_345.5;
    const payload = new Uint8Array(12);
    const view = new DataView(payload.buffer);
    view.setUint32(0, 1, true); // AckSequence: acked seq
    view.setFloat64(4, ticks, true);
    (conn as any).handlePacket(buildServerPacket(2, PacketHeaderFlags.AckSequence | PacketHeaderFlags.TimeSync, payload));

    const ts = events.filter(e => e.type === 'timeSync');
    expect(ts).toHaveLength(1);
    expect(ts[0].data).toBe(ticks);
  });
});

// EoL portal.dat values (asserted against the real DAT below).
const EOL_GAME_TIME: GameTime = {
  zeroTimeOfYear: 3600, zeroYear: 10, dayLength: 7620, daysPerYear: 360,
  yearSpec: 'P.Y.', timesOfDay: [], daysOfTheWeek: [], seasons: [],
};

function timeEntry(begin: number) {
  return {
    begin, dirBright: 1, dirHeading: 0, dirPitch: 45, dirColor: 0xffffffff,
    ambBright: 0.5, ambColor: 0xffffffff, minWorldFog: 0, maxWorldFog: 1000,
    worldFogColor: 0xffffffff, worldFog: 0, skyObjReplace: [],
  };
}

function makeSkyDesc(names: string[]) {
  return {
    tickSize: 30, lightTickSize: 30,
    dayGroups: names.map((dayName) => ({
      chanceOfOccur: 5, dayName,
      skyObjects: [],
      skyTime: [timeEntry(0), timeEntry(0.5)],
    })),
  } as never;
}

describe('SkyboxRenderer — server-synced game clock drives the phase', () => {
  it('derives phase = ((ticks + zeroTimeOfYear) mod dayLength) / dayLength', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(['Sunny']), EOL_GAME_TIME);
    // ticks chosen so (ticks + 3600) mod 7620 = 1905 → phase 0.25 (Dawnsong)
    const ticks = 7620 * 1000 + 1905 - 3600;
    sky.syncGameClock(ticks);
    sky.update(0);
    expect(sky.currentTimeOfDay).toBeCloseTo(0.25, 10);
  });

  it('advances the synced clock locally between syncs', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(['Sunny']), EOL_GAME_TIME);
    const ticks = 7620 * 50 - 3600; // phase 0 exactly
    sky.syncGameClock(ticks);
    sky.update(0);
    expect(sky.currentTimeOfDay).toBeCloseTo(0, 10);
    sky.update(762); // +10% of a day
    expect(sky.currentTimeOfDay).toBeCloseTo(0.1, 10);
    expect(sky.gameClock).toBeCloseTo(ticks + 762, 10);
  });

  it('never moves the clock backward on a stale sync (retail Timer::set_time)', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(['Sunny']), EOL_GAME_TIME);
    sky.syncGameClock(10_000);
    sky.syncGameClock(5_000); // stale — must be ignored
    expect(sky.gameClock).toBe(10_000);
    sky.syncGameClock(20_000); // forward — accepted
    expect(sky.gameClock).toBe(20_000);
  });

  it('ignores non-finite and negative sync values', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(['Sunny']), EOL_GAME_TIME);
    sky.syncGameClock(NaN);
    sky.syncGameClock(-5);
    sky.syncGameClock(Infinity);
    expect(sky.gameClock).toBeNull();
  });

  it('free-runs the phase when no server sync has arrived (solo mode)', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(['Sunny']), EOL_GAME_TIME);
    sky.updateTimeOfDay(0.35);
    sky.update(762); // dt/dayLength = 0.1
    expect(sky.currentTimeOfDay).toBeCloseTo(0.45, 10);
    expect(sky.gameClock).toBeNull();
  });

  it('the first synced frame adopts the server day\'s group outright — no wrap-driven roll (CORE.17.r)', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(['Sunny', 'Rainy']), EOL_GAME_TIME);
    sky.updateTimeOfDay(0.35); // pre-sync fallback, like main.ts
    let rolls = 0;
    sky.onDayGroupChange = () => { rolls++; };
    const ticks = 7620 * 3 - 3600 + 76.2; // server phase 0.01 < 0.35, day 3 of year 10
    sky.syncGameClock(ticks);
    sky.update(0);
    expect(sky.currentTimeOfDay).toBeCloseTo(0.01, 10);
    const day = absoluteDayFromClock(ticks, EOL_GAME_TIME);
    expect(sky.currentAbsoluteDay).toBe(day);
    expect(sky.dayGroupName).toBe(['Sunny', 'Rainy'][retailDayGroupIndex(day, 2)]);
    // at most one change (the construction pick was today's wall-clock day)
    expect(rolls).toBeLessThanOrEqual(1);
    // and a second synced frame on the same day changes nothing
    sky.update(1);
    expect(rolls).toBeLessThanOrEqual(1);
  });

  it('crossing the day boundary through the synced clock takes the next day\'s hashed group', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(['Sunny', 'Rainy']), EOL_GAME_TIME);
    // the first day >= 7 whose hash differs from the day after it
    let k = 7;
    while (retailDayGroupIndex(k, 2) === retailDayGroupIndex(k + 1, 2)) k++;
    const ticks = 7620 * k - 3600 - 10; // 10s before the boundary into day k... (day k−1 → k)
    sky.syncGameClock(ticks);
    sky.update(0);
    const before = sky.currentAbsoluteDay;
    let rolls = 0;
    sky.onDayGroupChange = () => { rolls++; };
    sky.update(5);
    expect(rolls).toBe(0);
    sky.update(15); // crosses the boundary
    expect(sky.currentAbsoluteDay).toBe(before + 1);
    expect(sky.currentTimeOfDay).toBeCloseTo(10 / 7620, 6);
    expect(sky.dayGroupName).toBe(['Sunny', 'Rainy'][retailDayGroupIndex(before + 1, 2)]);
    // whether the listener fired is exactly whether the hash changed
    expect(rolls).toBe(retailDayGroupIndex(before, 2) === retailDayGroupIndex(before + 1, 2) ? 0 : 1);
  });
});

const hasDat = fs.existsSync('dat/client_portal.dat');
let datGameTime: GameTime;

describe.skipIf(!hasDat)('EoL portal.dat GameTime anchor', () => {
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { RegionDesc } = await import('../packages/dat-parser/src/file-types/RegionDesc.js');
    const db = openDat('dat/client_portal.dat');
    datGameTime = new RegionDesc(new DatReader(db.getFileData(0x13000000)!)).gameTime;
  });

  it('carries the retail day/calendar constants the sync formula relies on', () => {
    expect(datGameTime.dayLength).toBe(7620); // = ACE DerethDateTime dayTicks
    expect(datGameTime.zeroTimeOfYear).toBe(3600);
    expect(datGameTime.daysPerYear).toBe(360);
    expect(datGameTime.zeroYear).toBe(10);
  });
});
