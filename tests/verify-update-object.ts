/**
 * UpdateObject (0xF7DB) handler audit (FAITHFUL.162).
 *
 * Continuation of FAITHFUL.157/158/159/160/161 dispatcher audit.
 *
 * UpdateObject fires when ACE wants to refresh the FULL state of an existing
 * visible object — same wire format as ObjectCreate, different semantic intent.
 * Call sites in ACE:
 *   - Entity/Tailoring.cs:504, 563         — armor/clothing dye operations
 *   - Entity/Aetheria.cs:241                — aetheria coloration
 *   - Managers/RecipeManager.cs:397         — crafting result refresh
 *   - WorldObjects/Hook.cs:175, 214         — housing hook attach/detach
 *   - WorldObjects/WorldObject.cs:664       — generic object desc-changed
 *   - WorldObjects/Player.cs:1065           — admin-vision toggle
 *
 * Pre-FAITHFUL.162 the opcode dropped into default → logUnhandled, meaning:
 *   - dyed armor on visible peers never refreshed visually
 *   - aetheria coloration changes ignored
 *   - housing hook contents (item placed/removed) stale on the client
 *   - admin-vision toggle had no client-side effect
 *
 * Wire format proven equivalent to ObjectCreate per ACE
 * WorldObject_Networking.cs:28-32:
 *
 *   public virtual void SerializeUpdateObject(BinaryWriter writer, ...) {
 *       // content of these 2 is the same? TODO: Validate that?
 *       SerializeCreateObject(writer, false, adminvision, changenodraw);
 *   }
 *
 * (The ACE source's own TODO comment notes the equivalence — we lean on it.)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GameMessageOpcode, parseCreateObject } from '@ac/network';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';

const REPO = resolve(__dirname, '..');
const ACE_DIR = resolve(REPO, 'reference/ACE/Source');
const aceFile = (rel: string) => resolve(ACE_DIR, rel);

describe('Opcode numeric pinning', () => {
  it('UpdateObject opcode is 0xF7DB', () => {
    expect(GameMessageOpcode.UpdateObject).toBe(0xF7DB);
  });
});

describe.skipIf(!existsSync(aceFile('ACE.Server/Network/GameMessages/Messages/GameMessageUpdateObject.cs')))(
  'ACE GameMessageUpdateObject.cs wire format',
  () => {
    let src: string;
    // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
    beforeAll(() => {
      src = readFileSync(
      aceFile('ACE.Server/Network/GameMessages/Messages/GameMessageUpdateObject.cs'),
      'utf8'
    );
    });

    it('delegates to worldObject.SerializeUpdateObject (no inline writes)', () => {
      expect(src).toMatch(/worldObject\.SerializeUpdateObject\(Writer,\s*adminvision,\s*changenodraw\)/);
    });

    it('queue group is SmartboxQueue', () => {
      expect(src).toMatch(/GameMessageGroup\.SmartboxQueue/);
    });

    it('opcode is GameMessageOpcode.UpdateObject', () => {
      expect(src).toMatch(/GameMessageOpcode\.UpdateObject/);
    });
  }
);

describe.skipIf(!existsSync(aceFile('ACE.Server/WorldObjects/WorldObject_Networking.cs')))(
  'ACE WorldObject_Networking SerializeUpdateObject == SerializeCreateObject',
  () => {
    let src: string;
    // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
    beforeAll(() => {
      src = readFileSync(
      aceFile('ACE.Server/WorldObjects/WorldObject_Networking.cs'),
      'utf8'
    );
    });

    it('SerializeUpdateObject is a one-liner calling SerializeCreateObject', () => {
      // This is the source-of-truth invariant our handler depends on: if ACE
      // ever splits the two serializers, this test fails and we know to write
      // a dedicated parser.
      expect(src).toMatch(
        /public virtual void SerializeUpdateObject[\s\S]{0,400}SerializeCreateObject\(writer,\s*false,\s*adminvision,\s*changenodraw\);/
      );
    });
  }
);

describe('Call-site coverage (regressions if any disappear)', () => {
  it.skipIf(!existsSync(aceFile('ACE.Server')))('appears in ≥ 6 distinct call sites outside the message class itself', () => {
    // Sanity check: confirm UpdateObject is actually broadcast widely. If the
    // server stopped using it, FAITHFUL.162's premise would be wrong.
    const { execSync } = require('node:child_process');
    const out = execSync(
      `grep -rln "new GameMessageUpdateObject\\b" "${aceFile('ACE.Server')}" | grep -v "GameMessages/Messages" | wc -l`,
      { encoding: 'utf8' }
    ).trim();
    expect(Number(out)).toBeGreaterThanOrEqual(6);
  });
});

// DEBT.test-harness-hygiene: converted from ServerMessageHandler.ts source
// pins — the real dispatcher is fed a hand-built UpdateObject payload
// (ObjectCreate wire shape, verify-core12-default-combat-mode.ts writer).
function buildObjectPayload(guid: number, name: string): Uint8Array {
  const bytes: number[] = [];
  const u8 = (v: number) => { bytes.push(v & 0xff); };
  const u16 = (v: number) => { u8(v); u8(v >> 8); };
  const u32 = (v: number) => { u16(v & 0xffff); u16(v >>> 16); };
  const align = () => { while (bytes.length % 4) u8(0); };
  u32(guid);
  u8(0x11); u8(0); u8(0); u8(0); // modelByte, numSubPalettes, numTexChanges, numAnimParts
  align();
  u32(0); // physFlags
  u32(0); // physicsState
  for (let i = 0; i < 9; i++) u16(0); // 9 sequence timestamps
  align();
  u32(0); // weenieFlags
  u16(name.length); for (const c of name) u8(c.charCodeAt(0)); align(); // String16L
  u16(300); // weenieClassId (packed)
  u16(1); // iconId (packed)
  u32(0); // itemType
  u32(0); // objectDescFlags
  align();
  return new Uint8Array(bytes);
}

describe('Integration (FAITHFUL.162, behavioural)', () => {
  function dispatch(opcode: GameMessageOpcode, payload: Uint8Array) {
    const created: unknown[] = [];
    const updated: unknown[] = [];
    const h = new ServerMessageHandler();
    h.setHandlers({ onObjectCreate: (o) => { created.push(o); }, onObjectUpdate: (o) => { updated.push(o); } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.handleMessage({ type: 'direct', opcode, payload } as any);
    return { created, updated };
  }

  it('UpdateObject is dispatched to onObjectUpdate, parsed with parseCreateObject (shares the ObjectCreate wire format)', () => {
    const payload = buildObjectPayload(0x80001234, 'Sylvan Bow');
    const { updated } = dispatch(GameMessageOpcode.UpdateObject, payload);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toEqual(parseCreateObject(payload));
    expect((updated[0] as { guid: number; name: string }).guid).toBe(0x80001234);
    expect((updated[0] as { name: string }).name).toBe('Sylvan Bow');
  });

  it('UpdateObject does NOT call onObjectCreate (semantic separation)', () => {
    // We intentionally fire a distinct callback so consumers can opt-in to
    // incremental refresh logic without re-running their "new object" paths
    // (portal-effect spawn, side-pack discovery, etc.).
    const { created } = dispatch(GameMessageOpcode.UpdateObject, buildObjectPayload(0x80001234, 'Sylvan Bow'));
    expect(created).toHaveLength(0);
  });

  it('ObjectCreate with the same bytes still goes to onObjectCreate only', () => {
    const { created, updated } = dispatch(GameMessageOpcode.ObjectCreate, buildObjectPayload(0x80005678, 'Pack'));
    expect(created).toHaveLength(1);
    expect(updated).toHaveLength(0);
  });
});
