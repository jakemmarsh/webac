/**
 * GAP.83 — Wave.isMP3 / SoundPlayer.decodeWave MP3 branch coverage.
 *
 * Ground truth (ACE ACE.DatLoader/FileTypes/Wave.cs; verified 2026-07-22
 * against the real client_portal.dat): MP3-flagged Wave entries store a
 * bare MPEG-1 Layer III elementary stream as `Data` (WAVEFORMATEX
 * wFormatTag == 0x0055 == WAVE_FORMAT_MPEGLAYER3, so Header[0] === 0x55).
 * Browsers' decodeAudioData decodes a raw MP3 stream directly — wrapping
 * it in a RIFF/WAVE/fmt container that still claims format tag 0x55 (what
 * the old code effectively built via toWavBuffer(), before being
 * short-circuited to `return null`) is not a format browsers recognize.
 * SoundPlayer.decodeWave now feeds `wave.data.buffer` straight to
 * decodeAudioData for MP3 waves, and only wraps PCM waves via
 * toWavBuffer(). Previously this branch had zero test coverage anywhere
 * in tests/ (even the old "return null" behavior was unverified).
 *
 * A scan of the real DAT (786 total Wave entries) found exactly one
 * MP3-flagged entry: 0x0A000393 (30-byte header, 5120 bytes of MP3 data,
 * mono, 11025Hz) — the same ID the ACE C# source comments call out.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Wave } from '../packages/dat-parser/src/file-types/Wave.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { SoundPlayer } from '../packages/renderer/src/audio/SoundPlayer.js';
import { openDat } from './_harness/dat.js';

/** Build raw Wave (0x0Axxxxxx) bytes: id, headerSize, dataSize, header, data. */
function buildWaveBytes(id: number, header: number[], data: number[]): ArrayBuffer {
  const total = 12 + header.length + data.length;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setInt32(0, id, true);
  view.setInt32(4, header.length, true);
  view.setInt32(8, data.length, true);
  const bytes = new Uint8Array(buf);
  bytes.set(header, 12);
  bytes.set(data, 12 + header.length);
  return buf;
}

const PCM_HEADER = [1, 0, 1, 0, 0x11, 0x2b, 0, 0, 0x22, 0x56, 0, 0, 2, 0, 16, 0]; // fmt=1 (PCM)
const MP3_HEADER = [0x55, 0, 1, 0, 0x11, 0x2b, 0, 0, 0x11, 0x2b, 0, 0, 1, 0, 0, 0]; // fmt=0x55 (MP3)

describe('GAP.83: Wave.isMP3', () => {
  it('is true when header byte 0 is 0x55 (WAVE_FORMAT_MPEGLAYER3)', () => {
    const wave = new Wave(new DatReader(buildWaveBytes(1, MP3_HEADER, [0xff, 0xfb, 1, 2])));
    expect(wave.isMP3).toBe(true);
  });

  it('is false for PCM (format tag 1)', () => {
    const wave = new Wave(new DatReader(buildWaveBytes(1, PCM_HEADER, [0, 0, 0, 0])));
    expect(wave.isMP3).toBe(false);
  });
});

describe('GAP.83: SoundPlayer.decodeWave MP3 vs PCM encoding', () => {
  function makeFakePortalDb(waveBytes: ArrayBuffer) {
    return { getFileData: () => waveBytes } as unknown as DatDatabase;
  }

  it('feeds the raw MP3 elementary stream directly (no RIFF wrapper)', async () => {
    const mp3Data = [0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4];
    const waveBytes = buildWaveBytes(0x0a000393, MP3_HEADER, mp3Data);
    const decodeWavData = vi.fn(async (buf: ArrayBuffer) => ({ duration: 0.2, byteLength: buf.byteLength } as never));
    const player = new SoundPlayer(makeFakePortalDb(waveBytes), { decodeWavData } as never);

    const result = await player.decodeWave(0x0a000393);

    expect(result).not.toBeNull();
    expect(decodeWavData).toHaveBeenCalledTimes(1);
    const passed = new Uint8Array(decodeWavData.mock.calls[0][0] as ArrayBuffer);
    expect([...passed]).toEqual(mp3Data); // raw stream, not RIFF-wrapped
  });

  it('still wraps PCM waves in a RIFF/WAVE container', async () => {
    const pcmData = [10, 20, 30, 40];
    const waveBytes = buildWaveBytes(0x0a000560, PCM_HEADER, pcmData);
    const decodeWavData = vi.fn(async (buf: ArrayBuffer) => ({ duration: 0.1, byteLength: buf.byteLength } as never));
    const player = new SoundPlayer(makeFakePortalDb(waveBytes), { decodeWavData } as never);

    const result = await player.decodeWave(0x0a000560);

    expect(result).not.toBeNull();
    const passed = new Uint8Array(decodeWavData.mock.calls[0][0] as ArrayBuffer);
    const magic = String.fromCharCode(passed[0], passed[1], passed[2], passed[3]);
    expect(magic).toBe('RIFF');
  });
});

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const hasPortalDat = existsSync(PORTAL_DAT);

describe.skipIf(!hasPortalDat)('GAP.83: real DAT MP3 wave 0x0A000393', () => {
  let wave: Wave | null;

  beforeAll(() => {
    const buf = readFileSync(PORTAL_DAT).buffer;
    const portalDb = new DatDatabase(buf as ArrayBuffer);
    const data = portalDb.getFileData(0x0a000393);
    wave = data ? new Wave(new DatReader(data)) : null;
  });

  it('exists and is MP3-flagged', () => {
    expect(wave).not.toBeNull();
    expect(wave!.isMP3).toBe(true);
  });

  it('decodeWave feeds its raw data (not a RIFF wrapper) to the decoder', async () => {
    const waveBytesData = wave!.data;
    const decodeWavData = vi.fn(async (buf: ArrayBuffer) => ({ duration: 0.2, byteLength: buf.byteLength } as never));
    const realPortalDb = openDat(PORTAL_DAT);
    const player = new SoundPlayer(realPortalDb, { decodeWavData } as never);

    await player.decodeWave(0x0a000393);

    expect(decodeWavData).toHaveBeenCalledTimes(1);
    const passed = new Uint8Array(decodeWavData.mock.calls[0][0] as ArrayBuffer);
    expect(passed.length).toBe(waveBytesData.length);
    expect([...passed]).toEqual([...waveBytesData]);
  });
});
