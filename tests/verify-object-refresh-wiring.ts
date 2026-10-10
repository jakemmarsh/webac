/**
 * FAITHFUL.197 — Object refresh + motion-state handler wiring.
 *
 * FAITHFUL.161/162 added dispatcher cases for ObjectUpdate (0xF7DB),
 * PickupEvent, VectorUpdate, PlayerCreate, AutonomousPosition,
 * PrivateUpdatePosition, TransientString, and StartBarber (now covered
 * behaviourally by tests/verify-barber-panel.ts). The network
 * layer fires those handler callbacks correctly, but main.ts never
 * registered consumers — so 8 server-driven events vanished silently.
 *
 * This test pins the wiring drift: every handler registered here must
 * stay registered.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { addTextToScroll, transientStringLine } from '../packages/renderer/src/ui/ServerMessageText.js';

const REPO = resolve(__dirname, '..');
const MAIN_SRC = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('FAITHFUL.197 — object/motion handlers', () => {
  it('onObjectUpdate shares the ObjectCreate ownership routing', () => {
    // Light wiring-registration pin only (this file's original purpose —
    // catching a handler silently going unregistered). The routing +
    // inventory-refresh behavior is covered behaviorally in
    // tests/verify-updateobject-own-inventory-routing.ts
    // (BUG.updateobject-own-inventory-routed-to-world: retail
    // SmartBox::HandleUpdateObject @ 00455580 tail-calls the create
    // handler, so 0xF7DB must NOT be world-routed unconditionally).
    expect(MAIN_SRC).toContain('onObjectUpdate:');
    const idx = MAIN_SRC.indexOf('onObjectUpdate:');
    const block = MAIN_SRC.slice(idx, idx + 600);
    expect(block).toContain('handleObjectCreateOrUpdate(data, true)');
  });

  it('onPlayerCreate registered', () => {
    expect(MAIN_SRC).toContain('onPlayerCreate:');
  });

  it('onPickupEvent registered', () => {
    expect(MAIN_SRC).toContain('onPickupEvent:');
  });

  it('onVectorUpdate registered', () => {
    expect(MAIN_SRC).toContain('onVectorUpdate:');
  });

  it('onAutonomousPosition is registered and skips the local player', () => {
    // This is a light wiring-registration pin only (this file's original
    // purpose — catching a handler silently going unregistered). The actual
    // parse + landblock-reconstruction behavior it routes to is covered
    // behaviorally in tests/verify-autonomous-position-wire-format.ts
    // (BUG.autonomous-position-wrong-wire-format).
    expect(MAIN_SRC).toContain('onAutonomousPosition:');
    const idx = MAIN_SRC.indexOf('onAutonomousPosition:');
    const block = MAIN_SRC.slice(idx, idx + 600);
    expect(block).toContain('serverObjectManager.updateAutonomousPosition(');
    // Should skip the local player to avoid feedback loops
    expect(block).toContain('aceCharGuid');
  });

  it('onPrivateUpdatePosition registered', () => {
    expect(MAIN_SRC).toContain('onPrivateUpdatePosition:');
  });

  it('a TransientString is the 0x1a spew-box notice, not a chat line (DECOMP.transient-string-notice)', () => {
    // Handle_Communication__TransientString @ 0057d460: AddTextToScroll(text, 0x1a).
    const calls: string[] = [];
    addTextToScroll({
      displayErrorText: (t) => calls.push(`spew:${t}`),
      addSystemMessage: (t) => calls.push(`chat:${t}`),
    }, transientStringLine('You are out of ammunition!'));
    expect(calls).toEqual(['spew:You are out of ammunition!']);
  });

});
