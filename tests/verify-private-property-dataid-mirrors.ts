/**
 * FAITHFUL.381 — PrivateUpdatePropertyDataID mirrors Setup (1),
 *  MotionTable (2), SoundTable (3), Icon (8) onto playerState so
 *  downstream consumers see server-current values.
 *
 * Pre-fix the handler was diagnostic-only. ACE emits
 * PrivateUpdatePropertyDataID on the self-side path for polymorph
 * spells (Setup), mount/dismount (MotionTable), weapon swap
 * (SoundTable), and item-condition icon swaps (Icon). Any consumer
 * reading playerState.{setup,motionTable,soundTable,icon}Id saw the
 * CreateObject-time values frozen indefinitely.
 *
 * ACE refs:
 *   reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyDataId.cs:6-8 →
 *     Setup=1, MotionTable=2, SoundTable=3
 *   reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyDataId.cs:14 →
 *     Icon=8
 *   reference/ACE/Source/ACE.Server/WorldObjects/Player_Properties.cs:1158-1168
 *     — both private + public broadcast paths share the underlying
 *     GameMessagePublicUpdatePropertyDataID wire format.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
const PSTATE = readFileSync(resolve(REPO, 'packages/renderer/src/player/PlayerState.ts'), 'utf8');

describe('PlayerState carries the DID mirrors (FAITHFUL.381)', () => {
  const required = ['setupId', 'motionTableId', 'soundTableId', 'iconId'];
  for (const field of required) {
    it(`declares ${field} = 0`, () => {
      expect(PSTATE).toMatch(new RegExp(`\\b${field}\\s*=\\s*0;`));
    });
  }

  it('cites FAITHFUL.381 in the field docblock', () => {
    expect(PSTATE).toMatch(/FAITHFUL\.381/);
  });
});

describe('PrivateUpdatePropertyDataID mirrors all four DIDs (FAITHFUL.381)', () => {
  const block = MAIN.match(/onPrivateUpdatePropertyDataID:[\s\S]+?\n      \},/)?.[0] ?? '';
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const cases: Array<[string, RegExp]> = [
    ['Setup → playerState.setupId', /case 1[\s\S]+?playerState\.setupId\s*=\s*val/],
    ['MotionTable → playerState.motionTableId', /case 2[\s\S]+?playerState\.motionTableId\s*=\s*val/],
    ['SoundTable → playerState.soundTableId', /case 3[\s\S]+?playerState\.soundTableId\s*=\s*val/],
    ['Icon → playerState.iconId', /case 8[\s\S]+?playerState\.iconId\s*=\s*val/],
  ];

  it.each(cases)('handles %s', (_name, pattern) => {
    expect(code).toMatch(pattern);
  });

  it('guards against non-finite + non-positive values', () => {
    expect(code).toMatch(/Number\.isFinite\(val\)/);
    expect(code).toMatch(/val\s*>\s*0/);
  });

  it('cites FAITHFUL.381 in the handler docblock', () => {
    expect(MAIN).toMatch(/FAITHFUL\.381/);
  });
});
