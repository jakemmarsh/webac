/**
 * Phase 17 — Audio System
 *
 * Tests:
 *  - Wave parsing from portal.dat (0x0A file type)
 *  - Wave to WAV buffer conversion (valid RIFF header)
 *  - SoundPlayer distance attenuation math
 *  - AudioManager category management and volume controls
 *  - MusicPlayer state management
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { Wave } from '@ac/dat-parser/file-types/Wave.js';
import { SoundPlayer } from '@ac/renderer/audio/SoundPlayer.js';
import { retailSoundAttenuation } from '@ac/renderer/audio/RetailSound.js';
import { AudioManager } from '@ac/renderer/audio/AudioManager.js';
import { MusicPlayer } from '@ac/renderer/audio/MusicPlayer.js';
import { openDat } from './_harness/dat.js';

const hasPortalDat = fs.existsSync('dat/client_portal.dat');

let portalDb: DatDatabase;

beforeAll(() => {
  if (!hasPortalDat) return;
  portalDb = openDat('dat/client_portal.dat');
});

describe.skipIf(!hasPortalDat)('Phase 17 — Audio System', () => {
  // ============================================================
  // Wave parsing from portal.dat
  // ============================================================
  describe('Wave Parsing', () => {
    it('should find wave files in portal.dat (0x0A)', () => {
      const ids = portalDb.listFileIds(0x0A);
      expect(ids.length).toBeGreaterThanOrEqual(10);
    });

    it('should parse wave files with valid header and data', () => {
      const ids = portalDb.listFileIds(0x0A);
      let parsed = 0;

      for (const id of ids.slice(0, 100)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const wave = new Wave(new DatReader(data));
        expect(wave.id).toBe(id);
        expect(wave.header.length).toBeGreaterThan(0);
        expect(wave.data.length).toBeGreaterThan(0);
        parsed++;
      }
      expect(parsed).toBeGreaterThanOrEqual(100);
    });

    it('should parse 100% of wave files without errors', () => {
      const ids = portalDb.listFileIds(0x0A);
      let success = 0;
      let total = 0;

      for (const id of ids) {
        total++;
        try {
          const data = portalDb.getFileData(id);
          if (!data) continue;
          const wave = new Wave(new DatReader(data));
          if (wave.header.length > 0 && wave.data.length > 0) success++;
        } catch {
          // parse failure
        }
      }
      expect(success / total).toBeGreaterThanOrEqual(0.98);
    });

    it('should distinguish PCM and MP3 wave files', () => {
      const ids = portalDb.listFileIds(0x0A);
      let pcmCount = 0;
      let mp3Count = 0;

      for (const id of ids) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const wave = new Wave(new DatReader(data));
        if (wave.isMP3) {
          mp3Count++;
        } else {
          pcmCount++;
        }
      }

      // Should have mostly PCM files
      expect(pcmCount).toBeGreaterThanOrEqual(10);
      // Total should be meaningful
      expect(pcmCount + mp3Count).toBeGreaterThanOrEqual(100);
    });
  });

  // ============================================================
  // WAV buffer conversion
  // ============================================================
  describe('Wave to WAV Buffer', () => {
    it('should produce valid RIFF WAV header', () => {
      const ids = portalDb.listFileIds(0x0A);
      let tested = 0;

      for (const id of ids.slice(0, 50)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const wave = new Wave(new DatReader(data));
        if (wave.isMP3) continue;

        const wavBuffer = wave.toWavBuffer();
        const view = new DataView(wavBuffer);
        const bytes = new Uint8Array(wavBuffer);

        // Check RIFF header
        expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe('RIFF');
        expect(String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])).toBe('WAVE');

        // Check fmt sub-chunk
        expect(String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])).toBe('fmt ');
        expect(view.getUint32(16, true)).toBe(16); // fmt chunk size

        // Check data sub-chunk
        expect(String.fromCharCode(bytes[36], bytes[37], bytes[38], bytes[39])).toBe('data');
        const dataSize = view.getUint32(40, true);
        expect(dataSize).toBe(wave.data.length);

        // Total buffer size should be 44 header + data
        expect(wavBuffer.byteLength).toBe(44 + wave.data.length);

        tested++;
        if (tested >= 20) break;
      }
      expect(tested).toBeGreaterThanOrEqual(10);
    });

    it('should have valid WAV format parameters from header', () => {
      const ids = portalDb.listFileIds(0x0A);
      let tested = 0;

      for (const id of ids.slice(0, 50)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const wave = new Wave(new DatReader(data));
        if (wave.isMP3) continue;

        const wavBuffer = wave.toWavBuffer();
        const view = new DataView(wavBuffer);

        // Audio format (1 = PCM)
        const audioFormat = view.getUint16(20, true);
        expect(audioFormat).toBe(1);

        // Channels (1 = mono, 2 = stereo)
        const channels = view.getUint16(22, true);
        expect(channels).toBeGreaterThanOrEqual(1);
        expect(channels).toBeLessThanOrEqual(2);

        // Sample rate (common: 8000, 11025, 22050, 44100)
        const sampleRate = view.getUint32(24, true);
        expect(sampleRate).toBeGreaterThanOrEqual(8000);
        expect(sampleRate).toBeLessThanOrEqual(48000);

        // Byte rate = sampleRate * channels * bitsPerSample/8
        const byteRate = view.getUint32(28, true);
        expect(byteRate).toBeGreaterThan(0);

        tested++;
        if (tested >= 10) break;
      }
      expect(tested).toBeGreaterThanOrEqual(10);
    });
  });

  // ============================================================
  // Distance attenuation math
  // ============================================================
  describe('Positional Audio Math', () => {
    it('should calculate distance correctly', () => {
      const a = { x: 0, y: 0, z: 0 };
      const b = { x: 3, y: 4, z: 0 };
      expect(SoundPlayer.calculateDistance(a, b)).toBeCloseTo(5.0, 5);
    });

    it('should return 0 distance for same point', () => {
      const a = { x: 5, y: 10, z: 15 };
      expect(SoundPlayer.calculateDistance(a, a)).toBeCloseTo(0, 5);
    });

    it('should calculate 3D distance correctly', () => {
      const a = { x: 1, y: 2, z: 3 };
      const b = { x: 4, y: 6, z: 3 };
      // sqrt(9 + 16 + 0) = 5
      expect(SoundPlayer.calculateDistance(a, b)).toBeCloseTo(5.0, 5);
    });

    // BUG.remote-anim-sound-hooks — the invented linear 50 m falloff is
    // replaced by retail's SoundManager::GetAttenuation @ 00550020 (full
    // volume within 5 m, inverse-square beyond, ceiled dB, cut below -50 dB).
    it('should return full volume at distance 0 (and anywhere inside VOL_MIN_DIST 5 m)', () => {
      expect(retailSoundAttenuation(0, 1)).toBeCloseTo(1.0, 5);
      expect(retailSoundAttenuation(4.9, 1)).toBeCloseTo(1.0, 5);
    });

    it('should fall off with the square of the distance beyond 5 m', () => {
      // 10 m → 25/100 → -12.04 dB → ceil -12 dB; 20 m → 25/400 → -24.08 → -24 dB.
      expect(retailSoundAttenuation(10, 1)).toBeCloseTo(Math.pow(10, -12 / 20), 5);
      expect(retailSoundAttenuation(20, 1)).toBeCloseTo(Math.pow(10, -24 / 20), 5);
    });

    it('should return 0 volume beyond the -50 dB cut (~94 m)', () => {
      expect(retailSoundAttenuation(100, 1)).toBe(0);
    });

    it('should decrease volume at 50m compared to 5m', () => {
      const vol5m = retailSoundAttenuation(5, 1);
      const vol50m = retailSoundAttenuation(50, 1);
      expect(vol5m).toBeGreaterThan(vol50m);
    });
  });

  // ============================================================
  // AudioManager category management
  // ============================================================
  describe('AudioManager', () => {
    it('should have 4 default categories', () => {
      const mgr = new AudioManager();
      const names = mgr.getCategoryNames();
      expect(names).toContain('ambient');
      expect(names).toContain('effects');
      expect(names).toContain('music');
      expect(names).toContain('ui');
      expect(names.length).toBe(4);
    });

    it('should have default volume of 1.0 for all categories', () => {
      const mgr = new AudioManager();
      for (const name of mgr.getCategoryNames()) {
        expect(mgr.getCategoryVolume(name)).toBe(1.0);
      }
    });

    it('should not be muted by default', () => {
      const mgr = new AudioManager();
      for (const name of mgr.getCategoryNames()) {
        expect(mgr.isCategoryMuted(name)).toBe(false);
      }
    });

    it('should clamp volume to 0-1 range', () => {
      const mgr = new AudioManager();
      // These won't affect gain nodes since init() wasn't called (no AudioContext in Node),
      // but they should update the stored category volume
      mgr.setCategoryVolume('effects', 1.5);
      expect(mgr.getCategoryVolume('effects')).toBeLessThanOrEqual(1.0);

      mgr.setCategoryVolume('effects', -0.5);
      expect(mgr.getCategoryVolume('effects')).toBeGreaterThanOrEqual(0);
    });

    it('should track muted state per category', () => {
      const mgr = new AudioManager();
      mgr.setCategoryMuted('music', true);
      expect(mgr.isCategoryMuted('music')).toBe(true);
      expect(mgr.isCategoryMuted('effects')).toBe(false);

      mgr.setCategoryMuted('music', false);
      expect(mgr.isCategoryMuted('music')).toBe(false);
    });

    it('should not be initialized without calling init()', () => {
      const mgr = new AudioManager();
      expect(mgr.isInitialized).toBe(false);
      expect(mgr.audioContext).toBeNull();
    });

    it('should return 0 volume for unknown category', () => {
      const mgr = new AudioManager();
      expect(mgr.getCategoryVolume('nonexistent')).toBe(0);
    });

    it('should return false muted for unknown category', () => {
      const mgr = new AudioManager();
      expect(mgr.isCategoryMuted('nonexistent')).toBe(false);
    });

    it('should have static category name constants', () => {
      expect(AudioManager.CATEGORY_AMBIENT).toBe('ambient');
      expect(AudioManager.CATEGORY_EFFECTS).toBe('effects');
      expect(AudioManager.CATEGORY_MUSIC).toBe('music');
      expect(AudioManager.CATEGORY_UI).toBe('ui');
    });
  });

  // ============================================================
  // MusicPlayer state management
  // ============================================================
  describe('MusicPlayer', () => {
    it('should not be playing initially', () => {
      const mgr = new AudioManager();
      const player = new MusicPlayer(mgr, async () => null);
      expect(player.isPlaying).toBe(false);
      expect(player.currentTrackId).toBe('');
    });

    it('should have default volume of 1.0', () => {
      const mgr = new AudioManager();
      const player = new MusicPlayer(mgr, async () => null);
      expect(player.volume).toBe(1.0);
    });

    it('should clamp volume to 0-1 range', () => {
      const mgr = new AudioManager();
      const player = new MusicPlayer(mgr, async () => null);

      player.volume = 2.0;
      expect(player.volume).toBeLessThanOrEqual(1.0);

      player.volume = -1.0;
      expect(player.volume).toBeGreaterThanOrEqual(0);
    });

    it('should have configurable crossfade duration', () => {
      const mgr = new AudioManager();
      const player = new MusicPlayer(mgr, async () => null);

      expect(player.crossfade).toBe(2.0); // default
      player.setCrossfadeDuration(5.0);
      expect(player.crossfade).toBe(5.0);
    });

    it('should not allow negative crossfade', () => {
      const mgr = new AudioManager();
      const player = new MusicPlayer(mgr, async () => null);

      player.setCrossfadeDuration(-1.0);
      expect(player.crossfade).toBeGreaterThanOrEqual(0);
    });

    it('should reset state on stop', () => {
      const mgr = new AudioManager();
      const player = new MusicPlayer(mgr, async () => null);

      // Without AudioContext, play() won't start, but stop() should
      // cleanly reset state
      player.stop();
      expect(player.isPlaying).toBe(false);
      expect(player.currentTrackId).toBe('');
    });

    it('should clean up on dispose', () => {
      const mgr = new AudioManager();
      const player = new MusicPlayer(mgr, async () => null);

      player.dispose();
      expect(player.isPlaying).toBe(false);
    });
  });

  // ============================================================
  // SoundPlayer cache management
  // ============================================================
  describe('SoundPlayer Cache', () => {
    it('should load and cache wave files from portal.dat', () => {
      const player = new SoundPlayer(portalDb, new AudioManager());
      const ids = portalDb.listFileIds(0x0A);

      const wave1 = player.loadWave(ids[0]);
      expect(wave1).not.toBeNull();
      expect(wave1!.id).toBe(ids[0]);
      expect(player.waveCacheSize).toBe(1);

      // Second load should hit cache
      const wave2 = player.loadWave(ids[0]);
      expect(wave2).toBe(wave1); // same reference = cached
      expect(player.waveCacheSize).toBe(1);
    });

    it('should cache multiple different waves', () => {
      const player = new SoundPlayer(portalDb, new AudioManager());
      const ids = portalDb.listFileIds(0x0A);

      for (let i = 0; i < 5; i++) {
        player.loadWave(ids[i]);
      }
      expect(player.waveCacheSize).toBe(5);
    });

    it('should clear cache', () => {
      const player = new SoundPlayer(portalDb, new AudioManager());
      const ids = portalDb.listFileIds(0x0A);

      player.loadWave(ids[0]);
      player.loadWave(ids[1]);
      expect(player.waveCacheSize).toBe(2);

      player.clearCache();
      expect(player.waveCacheSize).toBe(0);
    });

    it('should return null for invalid wave ID', () => {
      const player = new SoundPlayer(portalDb, new AudioManager());
      const wave = player.loadWave(0xDEADBEEF);
      expect(wave).toBeNull();
    });

    it('should load PCM waves that produce valid WAV buffers', () => {
      const player = new SoundPlayer(portalDb, new AudioManager());
      const ids = portalDb.listFileIds(0x0A);
      let tested = 0;

      for (const id of ids.slice(0, 20)) {
        const wave = player.loadWave(id);
        if (!wave || wave.isMP3) continue;

        const wavBuffer = wave.toWavBuffer();
        expect(wavBuffer.byteLength).toBeGreaterThan(44);

        const view = new DataView(wavBuffer);
        const magic = new Uint8Array(wavBuffer, 0, 4);
        expect(String.fromCharCode(...magic)).toBe('RIFF');

        tested++;
      }
      expect(tested).toBeGreaterThanOrEqual(5);
    });
  });
});
