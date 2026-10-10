/**
 * Regression: every `(id >> 24) & 0xff` portal-file-type dispatch site must
 * compare against a symbolic PortalFileType.X member, never a bare 0x0N
 * literal. Bare-number dispatch is the same drift hazard FAITHFUL.116 closed
 * (and FAITHFUL.118 closed a missed batch in main.ts building-collision
 * loops + TextureManager.getIcon{RGBA,RGBAAsync}).
 *
 * Concretely: scan all .ts files under packages/renderer/src and
 * packages/dat-parser/src for the pattern `>> 24) & 0xff`. For each such
 * site, the enclosing function (next ~30 lines) must reference at least one
 * `PortalFileType.X` symbol — never a bare `=== 0x0N` comparison.
 *
 * Reference: packages/dat-parser/src/DatFileType.ts and DatFile.cs
 * GetFileType() in ACE.DatLoader.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO = resolve(__dirname, '..');
const SCAN_DIRS = [
  resolve(REPO, 'packages/renderer/src'),
  resolve(REPO, 'packages/dat-parser/src'),
];

function* walkTs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walkTs(full);
    else if (full.endsWith('.ts')) yield full;
  }
}

describe('Portal-file-type dispatch sites (FAITHFUL.116 + FAITHFUL.118)', () => {
  it('every `(id >> 24) & 0xff` dispatch must use symbolic PortalFileType.X comparisons', () => {
    const violations: string[] = [];

    for (const dir of SCAN_DIRS) {
      for (const file of walkTs(dir)) {
        const src = readFileSync(file, 'utf8');
        const lines = src.split('\n');

        for (let i = 0; i < lines.length; i++) {
          // High-byte extraction: `(x >> 24) & 0xff` (case-insensitive on 0xFF)
          if (!/>>\s*24\)\s*&\s*0x[fF]{2}\b/.test(lines[i])) continue;

          // Determine the variable name being assigned the high byte, if any.
          // e.g. `const bHighByte = (building.modelId >> 24) & 0xff;`
          const assignMatch = lines[i].match(/\b(\w+)\s*=\s*\(.*?>>\s*24\)\s*&\s*0x[fF]{2}\b/);

          // Look ahead up to ~35 lines for the dispatch.
          const window = lines.slice(i, Math.min(lines.length, i + 35)).join('\n');

          // If a variable name was extracted, look for `varName === 0xNN` (bad)
          // OR `varName === PortalFileType.X` (good).
          if (assignMatch) {
            const v = assignMatch[1];
            const bareNumPattern = new RegExp(
              `\\b${v}\\s*===\\s*0x[0-9a-fA-F]+\\b(?!\\s*\\/\\/)`
            );
            if (bareNumPattern.test(window)) {
              violations.push(
                `${file}:${i + 1} — bare-number dispatch on '${v}' (use PortalFileType.X)`
              );
            }
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        'Bare-number portal-file-type dispatch sites detected — replace with PortalFileType.X:\n' +
        violations.map((v) => '  ' + v).join('\n')
      );
    }
    expect(violations).toEqual([]);
  });

  it('PortalFileType enum is referenced at every fix site', () => {
    // Spot-check that the FAITHFUL.118 fix targets actually import + use
    // PortalFileType symbolically.
    // main.ts's dungeon-entry dispatch (Setup parts vs a lone GfxObj) moved
    // to world/DungeonCollisionBuild.ts and is covered behaviourally there
    // (tests/verify-stream-dungeon-retries.ts, "dispatches …").
    const sites = [
      'packages/renderer/src/models/TextureManager.ts',
      'packages/renderer/src/world/EnvCellRenderer.ts',
    ];
    for (const rel of sites) {
      const src = readFileSync(resolve(REPO, rel), 'utf8');
      expect(src).toMatch(/import\s*\{[^}]*PortalFileType[^}]*\}\s*from/);
      expect(src).toMatch(/PortalFileType\.(Setup|GraphicsObject|Texture|SurfaceTexture)/);
    }
  });
});
