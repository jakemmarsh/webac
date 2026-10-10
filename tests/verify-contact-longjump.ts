/**
 * ContactLongJump enum audit (FAITHFUL.153).
 *
 * Single byte at the tail of the MoveToState (GameAction 0xF61C) and
 * AutonomousPosition payloads. Drift here would mean the server thinks
 * the player is airborne when standing, or in a long-jump windup when
 * walking — both break position prediction + grounded-state tracking.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ContactLongJump } from '@ac/network';

const REPO = resolve(__dirname, '..');
const ACE_MTS  = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Motion/MoveToState.cs');
const ACE_AP   = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionAutonomousPosition.cs');

describe.skipIf(!aceReferenceExists(ACE_MTS))('ACE MoveToState ContactLongJump coverage', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_MTS, 'utf8');
  });

  it('TS port matches ACE bit definitions 1:1', () => {
    // Pin both bit-test conditions from MoveToState.cs:44-47
    expect(src).toMatch(/ContactLongJump\s*&\s*0x1\)\s*!=\s*0\)\s*\n\s*Contact\s*=\s*true/);
    expect(src).toMatch(/ContactLongJump\s*&\s*0x2\)\s*!=\s*0\)\s*\n\s*StandingLongJump\s*=\s*true/);
    expect(ContactLongJump.None).toBe(0x0);
    expect(ContactLongJump.Contact).toBe(0x1);
    expect(ContactLongJump.StandingLongJump).toBe(0x2);
  });

  it('declares the field as a single byte (ReadByte)', () => {
    expect(src).toMatch(/ContactLongJump\s*=\s*reader\.ReadByte\(\)/);
  });

  it('aligns the reader to DWORD after the byte', () => {
    expect(src).toMatch(/ContactLongJump[\s\S]{0,400}reader\.Align\(\)/);
  });
});

describe.skipIf(!aceReferenceExists(ACE_AP))('ACE AutonomousPosition Contact byte coverage', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_AP, 'utf8');
  });

  it('reads contact as `byte != 0` (any non-zero satisfies grounded)', () => {
    expect(src).toMatch(/LastContact\s*=\s*message\.Payload\.ReadByte\(\)\s*!=\s*0/);
  });
});

describe('MovementSync contact byte — behavioral (GAP.7; replaces the FAITHFUL.153 source pin)', () => {
  // Drives the REAL MovementSync with a stub connection. GAP.7: the contact
  // byte must reflect the live airborne state — ACE only integrates
  // server-side fall physics (WeenieObject.cs:236 → HandleFallingDamage)
  // while the client reports NOT-in-contact; the old hardcoded Contact made
  // falling damage unreachable on ACE.
  // sendPositionNow emits TWO messages per call: an 80-byte MoveToState
  // followed by a 56-byte AutonomousPosition. BOTH carry a contact byte and
  // BOTH must flip (ACE reads MoveToState.ContactLongJump bit 0 AND
  // AutonomousPosition's LastContact byte).
  async function captureMessages(onGround: boolean | undefined): Promise<Uint8Array[]> {
    const { MovementSync } = await import('../packages/renderer/src/network/MovementSync.js');
    const sent: Uint8Array[] = [];
    const conn = { sendMessage: (bytes: Uint8Array) => { sent.push(bytes); } };
    let seq = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sync = new MovementSync(conn as any, () => ++seq);
    const state = { forward: true, backward: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, running: true };
    const pos = { worldX: 100, worldZ: 200, groundY: 10, playerYaw: 0, landblock: 0xa9b4ffff, localX: 100, localY: 8, localZ: 20, inDungeon: false, onGround };
    sync.sendPositionNow(state, pos);
    expect(sent.length).toBe(2); // MoveToState + AutonomousPosition
    return sent;
  }

  function diffBytes(a: Uint8Array, b: Uint8Array): Array<{ i: number; a: number; b: number }> {
    expect(a.length).toBe(b.length);
    const diffs: Array<{ i: number; a: number; b: number }> = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) diffs.push({ i, a: a[i], b: b[i] });
    }
    return diffs;
  }

  it('grounded vs airborne: EVERY emitted message differs in exactly one byte, 1 → 0', async () => {
    const grounded = await captureMessages(true);
    const airborne = await captureMessages(false);
    expect(airborne.length).toBe(grounded.length);
    for (let m = 0; m < grounded.length; m++) {
      const diffs = diffBytes(grounded[m], airborne[m]);
      expect(diffs.length, `message ${m} must flip its contact byte`).toBe(1);
      expect(diffs[0].a).toBe(ContactLongJump.Contact); // 0x1 grounded
      expect(diffs[0].b).toBe(ContactLongJump.None);    // 0x0 airborne
    }
  });

  it('airborne with no keys held still sends AutonomousPosition at the ~1s cadence', async () => {
    const { MovementSync } = await import('../packages/renderer/src/network/MovementSync.js');
    const sent: Uint8Array[] = [];
    const conn = { sendMessage: (bytes: Uint8Array) => { sent.push(bytes); } };
    let seq = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sync = new MovementSync(conn as any, () => ++seq);
    // running:true matches the constructor's prevState default so no
    // MoveToState state-change send muddies the count.
    const idle = { forward: false, backward: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, running: true };
    const posAt = (onGround: boolean, groundY = 30) => ({ worldX: 100, worldZ: 200, groundY, playerYaw: 0, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround });
    // The first frame reports the position (nothing sent yet).
    sync.update(idle, posAt(true), 0);
    expect(sent.length).toBe(1);
    // Grounded + idle + unmoved at t=1500: nothing (heartbeat is 20s).
    sync.update(idle, posAt(true), 1500);
    expect(sent.length).toBe(1);
    // Walked off a ledge, no keys: losing contact is a contact-plane change
    // inside the window, so it reports at once, contact byte clear.
    sync.update(idle, posAt(false, 29.5), 1600);
    expect(sent.length).toBe(2);
    expect(sent[1][sent[1].length - 4]).toBe(ContactLongJump.None);
    // The fall keeps reporting at the ~1 s cadence while the height changes…
    sync.update(idle, posAt(false, 25), 2000);
    expect(sent.length).toBe(2);
    sync.update(idle, posAt(false, 20), 2700);
    expect(sent.length).toBe(3);
    // …landing (contact regained) reports at once, contact byte set…
    sync.update(idle, posAt(true, 10), 2800);
    expect(sent.length).toBe(4);
    expect(sent[3][sent[3].length - 4]).toBe(ContactLongJump.Contact);
    // …and then stays quiet while standing still.
    sync.update(idle, posAt(true, 10), 5500);
    expect(sent.length).toBe(4);
  });

  it('omitted onGround defaults to grounded (back-compat for non-jump senders)', async () => {
    const dflt = await captureMessages(undefined);
    const grounded = await captureMessages(true);
    expect(dflt.length).toBe(grounded.length);
    for (let m = 0; m < grounded.length; m++) {
      expect(Array.from(dflt[m])).toEqual(Array.from(grounded[m]));
    }
  });
});
