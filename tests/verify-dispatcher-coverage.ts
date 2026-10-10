/**
 * FAITHFUL.168 — dispatcher coverage drift guard.
 *
 * The FAITHFUL.157-167 sweep closed 8 silently-dropped opcode handlers
 * (PublicUpdatePropertyInt64/Bool/Float/String/DataID, PublicUpdateInstanceId,
 * VectorUpdate, PickupEvent, UpdateObject). Each was found by manual audit
 * comparing the GameMessageOpcode enum against the dispatcher switch.
 *
 * This test makes that audit automatic — it walks the enum, the dispatcher
 * cases, and the set of ACE-server-emitted message types, and fails if any
 * ACE-emitted opcode lacks a dispatcher case.
 *
 * The list of "ACE actually emits this" is derived from grepping
 * `new GameMessageX(` references in the ACE.Server source tree.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { GameMessageOpcode } from '@ac/network';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';

const REPO = resolve(__dirname, '..');
const ACE_SERVER = resolve(REPO, 'reference/ACE/Source/ACE.Server');
const ACE_MSG_DIR = resolve(ACE_SERVER, 'Network/GameMessages/Messages');

const aceExists = aceReferenceExists(ACE_SERVER);

function listFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, suffix));
    else if (entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

function gatherACEEmittedMessageClasses(): Set<string> {
  // Find every `new GameMessageX(` reference across the ACE server tree
  // EXCLUDING the message class files themselves. The set of X's is the
  // collection of message classes ACE actually instantiates.
  const re = /new (GameMessage[A-Z][A-Za-z0-9]+)\s*\(/g;
  const out = new Set<string>();
  for (const file of listFiles(ACE_SERVER, '.cs')) {
    if (file.includes('/Messages/')) continue; // skip the class defs themselves
    const src = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.add(m[1]);
  }
  return out;
}

function gatherACEMessageOpcodeMap(): Map<string, GameMessageOpcode> {
  // Each GameMessageX.cs file declares `base(GameMessageOpcode.Y, ...)` — pull
  // (X, Y) pairs so we can map ACE class name to the canonical opcode.
  const re = /class (GameMessage[A-Z][A-Za-z0-9]+)[\s\S]+?base\(GameMessageOpcode\.([A-Z][A-Za-z0-9]+)/;
  const out = new Map<string, GameMessageOpcode>();
  for (const file of listFiles(ACE_MSG_DIR, '.cs')) {
    const src = readFileSync(file, 'utf8');
    const m = src.match(re);
    if (!m) continue;
    const opName = m[2] as keyof typeof GameMessageOpcode;
    const opValue = GameMessageOpcode[opName];
    if (typeof opValue === 'number') out.set(m[1], opValue);
  }
  return out;
}

/**
 * Behavioural: feed the REAL ServerMessageHandler.handleMessage one direct
 * message per GameMessageOpcode value (zero-filled payload) and record which
 * opcodes reach the switch's `default:` → logUnhandled. Every other opcode
 * has a dispatcher case (a parse error on the dummy payload still proves the
 * case exists).
 */
function gatherHandledOpcodes(): Set<number> {
  const h = new ServerMessageHandler();
  const unhandled = new Set<number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h as any).logUnhandled = (type: string, code: number) => { if (type === 'direct') unhandled.add(code); };
  const quiet = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {})];
  const out = new Set<number>();
  try {
    for (const v of Object.values(GameMessageOpcode)) {
      if (typeof v !== 'number' || v === GameMessageOpcode.GameEvent) continue;
      try {
        h.handleMessage({ type: 'direct', opcode: v, payload: new Uint8Array(512) });
      } catch { /* the case exists; the dummy payload just didn't parse */ }
      if (!unhandled.has(v)) out.add(v);
    }
  } finally {
    for (const q of quiet) q.mockRestore();
  }
  return out;
}

describe.skipIf(!aceExists)('Dispatcher coverage drift guard', () => {
  let emitted: Set<string>;
  let classToOpcode: Map<string, GameMessageOpcode>;
  let handled: Set<number>;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    emitted = gatherACEEmittedMessageClasses();
    classToOpcode = gatherACEMessageOpcodeMap();
    handled = gatherHandledOpcodes();
  });

  it('found a reasonable number of ACE-emitted message classes (>= 50)', () => {
    expect(emitted.size).toBeGreaterThanOrEqual(50);
  });

  it('every ACE-emitted GameMessage class has a dispatcher case in ServerMessageHandler', () => {
    // Some message classes don't have a unique opcode (they ARE the opcode, like
    // PrivateUpdate* fan-out). We allow:
    //   (a) class → opcode is found in ACE Messages dir AND
    //   (b) opcode is in our dispatcher
    const missing: string[] = [];
    for (const className of emitted) {
      const opcode = classToOpcode.get(className);
      if (opcode === undefined) continue; // class has no matching opcode in Messages dir (rare; subclass or alias)
      if (!handled.has(opcode)) {
        missing.push(`${className} (opcode 0x${opcode.toString(16).toUpperCase().padStart(4, '0')})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('FAITHFUL.160-162 newly-handled opcodes are covered', () => {
    expect(handled.has(GameMessageOpcode.PublicUpdateInstanceId)).toBe(true);
    expect(handled.has(GameMessageOpcode.VectorUpdate)).toBe(true);
    expect(handled.has(GameMessageOpcode.PickupEvent)).toBe(true);
    expect(handled.has(GameMessageOpcode.UpdateObject)).toBe(true);
  });
});

describe('Dispatcher coverage probe self-check (runs without reference/ACE)', () => {
  it('the probe distinguishes handled from unhandled opcodes', () => {
    const handled = gatherHandledOpcodes();
    expect(handled.has(GameMessageOpcode.ObjectCreate)).toBe(true);
    expect(handled.has(GameMessageOpcode.PublicUpdateInstanceId)).toBe(true);
    // An opcode value outside the enum always reaches default → logUnhandled.
    const h = new ServerMessageHandler();
    let logged = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h as any).logUnhandled = () => { logged = true; };
    h.handleMessage({ type: 'direct', opcode: 0xDEAD as GameMessageOpcode, payload: new Uint8Array(8) });
    expect(logged).toBe(true);
  });
});
