/**
 * FAITHFUL.60 — runtime outbound-GameAction coverage audit.
 *
 * Mirrors tests/verify-ace-event-coverage.ts (FAITHFUL.53 inbound audit) on
 * the outbound side. Walks every reference/ACE/Source/.../Actions/*.cs file,
 * extracts each handler's `[GameAction(GameActionType.X)]` attribute, then
 * asserts every X is referenced somewhere in our network/renderer source
 * (whether via the generic `sendGameAction(GameActionType.X, ...)` helper, a
 * direct `serializeGameAction(seq, GameActionType.X, ...)` call, or a typed
 * wrapper helper like sendTalk/sendCastSpell/sendMeleeAttack that includes
 * the type name as a literal).
 *
 * This converts FAITHFUL.52's one-shot "149/149" claim into a CI-enforced
 * invariant — any future ACE rebase that adds a new GameAction without a
 * client serializer reference will fail this test.
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { GameActionType } from '@ac/network';

const REPO_ROOT = join(import.meta.dirname, '..');
const ACE_ACTIONS_DIR = join(REPO_ROOT, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions');
const NETWORK_DIR = join(REPO_ROOT, 'packages/network/src');
const RENDERER_DIR = join(REPO_ROOT, 'packages/renderer/src');

const aceDirExists = aceReferenceExists(ACE_ACTIONS_DIR);

function collectActionTypeRefs(): Set<string> {
  // Walk our source tree and harvest every `GameActionType.X` reference.
  const refs = new Set<string>();
  const re = /GameActionType\.([A-Za-z][A-Za-z0-9_]*)/g;
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        const src = readFileSync(full, 'utf8');
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) refs.add(m[1]);
      }
    }
  }
  walk(NETWORK_DIR);
  walk(RENDERER_DIR);
  return refs;
}

const aceActionAttrs: Array<{ file: string; actionTypeName: string }> = [];
if (aceDirExists) {
  for (const file of readdirSync(ACE_ACTIONS_DIR).filter(f => f.endsWith('.cs'))) {
    const src = readFileSync(join(ACE_ACTIONS_DIR, file), 'utf8');
    const m = src.match(/\[GameAction\(GameActionType\.([A-Za-z][A-Za-z0-9_]*)\)\]/);
    if (m) aceActionAttrs.push({ file, actionTypeName: m[1] });
  }
}

describe.skipIf(!aceDirExists)('FAITHFUL.60 — outbound GameAction coverage audit', () => {
  it('found ACE GameAction handler files (sanity, expect exactly 149)', () => {
    expect(aceActionAttrs.length).toBe(149);
  });

  const acjsRefs = collectActionTypeRefs();

  it('found GameActionType references in acjs source (sanity, expect >100)', () => {
    expect(acjsRefs.size).toBeGreaterThan(100);
  });

  for (const { file, actionTypeName } of aceActionAttrs) {
    it(`ACE ${file} (GameActionType.${actionTypeName}) has a client-side reference`, () => {
      expect(Object.keys(GameActionType)).toContain(actionTypeName);
      expect(acjsRefs.has(actionTypeName), `GameActionType.${actionTypeName} has no reference in network/ or renderer/ source — outbound serializer missing`).toBe(true);
    });
  }
});
