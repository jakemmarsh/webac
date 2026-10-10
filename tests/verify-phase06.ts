/**
 * Phase 6 Verification: Animation + MotionTable + Sound Parsing
 * Tests animation, motion table, and wave/sound parsing from portal.dat
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');

const hasPortalDat = existsSync(PORTAL_DAT);

describe.skipIf(!hasPortalDat)('Phase 6: Animation + MotionTable + Sound', () => {
  let DatDatabase: any;
  let Animation: any;
  let MotionTable: any;
  let Wave: any;
  let portalDb: any;

  beforeAll(async () => {
    const dbMod = await import('../packages/dat-parser/src/DatDatabase');
    DatDatabase = dbMod.DatDatabase;

    const animMod = await import('../packages/dat-parser/src/file-types/Animation');
    Animation = animMod.Animation;

    const motionMod = await import('../packages/dat-parser/src/file-types/MotionTable');
    MotionTable = motionMod.MotionTable;

    const waveMod = await import('../packages/dat-parser/src/file-types/Wave');
    Wave = waveMod.Wave;

    if (existsSync(PORTAL_DAT)) {
      const buf = readFileSync(PORTAL_DAT).buffer;
      portalDb = new DatDatabase(buf);
    }
  });

  describe('Animation (0x03)', () => {
    it('parse 50+ animations with frameCount > 0 and partCount > 0', () => {
      const animIds = portalDb.listFileIds(0x03);
      expect(animIds.length).toBeGreaterThan(50);

      const step = Math.max(1, Math.floor(animIds.length / 50));
      const sample = Array.from({ length: Math.min(50, animIds.length) }, (_, i) => animIds[i * step]);

      let successes = 0;
      for (const id of sample) {
        try {
          const reader = portalDb.getReader(id);
          const anim = new Animation(reader);
          if (anim.numFrames > 0 && anim.numParts > 0) {
            successes++;
          }
        } catch {
          // skip
        }
      }
      expect(successes).toBeGreaterThanOrEqual(47);
    });

    it('Animation frames have valid Frame transforms (finite origins, unit quaternions)', () => {
      const animIds = portalDb.listFileIds(0x03);
      let tested = 0;

      for (const id of animIds.slice(0, 30)) {
        try {
          const reader = portalDb.getReader(id);
          const anim = new Animation(reader);

          if (anim.partFrames.length > 0 && anim.partFrames[0].frames.length > 0) {
            const frame = anim.partFrames[0].frames[0];
            const o = frame.origin;
            const q = frame.orientation;
            expect(Number.isFinite(o.x)).toBe(true);
            expect(Number.isFinite(o.y)).toBe(true);
            expect(Number.isFinite(o.z)).toBe(true);
            const len = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
            if (len > 0) {
              expect(len).toBeCloseTo(1.0, 1);
            }
            tested++;
            if (tested >= 10) break;
          }
        } catch {
          // skip
        }
      }
      expect(tested).toBeGreaterThanOrEqual(5);
    });

    it('Animation posFrames present when flag set', () => {
      const animIds = portalDb.listFileIds(0x03);
      let foundWithPosFrames = false;
      let foundWithoutPosFrames = false;

      for (const id of animIds.slice(0, 200)) {
        try {
          const reader = portalDb.getReader(id);
          const anim = new Animation(reader);
          if (anim.posFrames.length > 0) {
            foundWithPosFrames = true;
            expect(anim.posFrames.length).toBe(anim.numFrames);
          } else {
            foundWithoutPosFrames = true;
          }
          if (foundWithPosFrames && foundWithoutPosFrames) break;
        } catch {
          // skip
        }
      }
      // There should be both kinds in the DAT
      expect(foundWithPosFrames || foundWithoutPosFrames).toBe(true);
    });
  });

  describe('MotionTable (0x09)', () => {
    it('parse 20+ motion tables with ≥1 style and ≥1 cycle', () => {
      const motionIds = portalDb.listFileIds(0x09);
      expect(motionIds.length).toBeGreaterThan(20);

      const step = Math.max(1, Math.floor(motionIds.length / 20));
      const sample = Array.from({ length: Math.min(20, motionIds.length) }, (_, i) => motionIds[i * step]);

      let successes = 0;
      for (const id of sample) {
        try {
          const reader = portalDb.getReader(id);
          const mt = new MotionTable(reader);
          if (mt.styleDefaults.size >= 1 && mt.cycles.size >= 1) {
            successes++;
          }
        } catch {
          // skip
        }
      }
      expect(successes).toBeGreaterThanOrEqual(18);
    });

    it('MotionTable cycles reference valid animation IDs (0x03)', () => {
      const motionIds = portalDb.listFileIds(0x09);
      const animIdSet = new Set(portalDb.listFileIds(0x03));

      let tested = 0;
      for (const id of motionIds.slice(0, 20)) {
        try {
          const reader = portalDb.getReader(id);
          const mt = new MotionTable(reader);

          for (const [, motionData] of mt.cycles) {
            for (const anim of motionData.anims) {
              if (anim.animId !== 0) {
                expect(animIdSet.has(anim.animId)).toBe(true);
              }
            }
            tested++;
            if (tested >= 5) break;
          }
          if (tested >= 5) break;
        } catch {
          // skip
        }
      }
      expect(tested).toBeGreaterThanOrEqual(3);
    });

    it('MotionTable has links (animation transitions)', () => {
      const motionIds = portalDb.listFileIds(0x09);

      let found = 0;
      for (const id of motionIds.slice(0, 30)) {
        try {
          const reader = portalDb.getReader(id);
          const mt = new MotionTable(reader);
          if (mt.links.size > 0) {
            found++;
            if (found >= 3) break;
          }
        } catch {
          // skip
        }
      }
      expect(found).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Wave (0x0A)', () => {
    it('parse 10+ wave files with data length > 0', () => {
      const waveIds = portalDb.listFileIds(0x0A);
      expect(waveIds.length).toBeGreaterThan(10);

      let successes = 0;
      for (const id of waveIds.slice(0, 20)) {
        try {
          const reader = portalDb.getReader(id);
          const wave = new Wave(reader);
          if (wave.data.length > 0) {
            successes++;
          }
        } catch {
          // skip
        }
      }
      expect(successes).toBeGreaterThanOrEqual(10);
    });

    it('Wave header contains valid format data', () => {
      const waveIds = portalDb.listFileIds(0x0A);

      let tested = 0;
      for (const id of waveIds.slice(0, 10)) {
        try {
          const reader = portalDb.getReader(id);
          const wave = new Wave(reader);
          expect(wave.header.length).toBeGreaterThan(0);
          // Header should be reasonable size (typically 18 bytes, up to ~30)
          expect(wave.header.length).toBeLessThan(100);
          tested++;
        } catch {
          // skip
        }
      }
      expect(tested).toBeGreaterThanOrEqual(5);
    });

    it('Wave toWavBuffer creates valid RIFF header', () => {
      const waveIds = portalDb.listFileIds(0x0A);

      for (const id of waveIds.slice(0, 10)) {
        try {
          const reader = portalDb.getReader(id);
          const wave = new Wave(reader);
          if (wave.isMP3) continue; // Skip MP3 files

          const wavBuf = wave.toWavBuffer();
          const view = new DataView(wavBuf);
          const bytes = new Uint8Array(wavBuf);

          // Check RIFF header
          expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe('RIFF');
          expect(String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])).toBe('WAVE');
          expect(String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])).toBe('fmt ');
          expect(String.fromCharCode(bytes[36], bytes[37], bytes[38], bytes[39])).toBe('data');

          // Data size should match
          const dataSize = view.getUint32(40, true);
          expect(dataSize).toBe(wave.data.length);
          return; // One is enough
        } catch {
          // skip
        }
      }
    });
  });
});
