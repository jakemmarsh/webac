/**
 * GAP.89 — Every GameMessage direct opcode either handled or explicitly
 * silently-consumed with an ACE source cite.
 *
 * FAITHFUL.53 already audits the inbound GameEvent space (events wrapped
 * inside opcode 0xF7B0). This closes the analogous gap for the "direct"
 * opcode space: 19 GameMessageOpcode enum values had no `case` in
 * ServerMessageHandler.handleDirectMessage and fell through to the
 * anonymous `default: this.logUnhandled('direct', msg.opcode)` branch —
 * logged, but not documented as an intentional no-op.
 *
 * Research against reference/ACE/Source (see the fix's case-block
 * comments for full citations) classified the 19 into:
 *   - Motion / GameEvent / GameAction (3): structurally excluded before
 *     reaching this switch (alias / dispatched via a separate type), no
 *     case possible or needed — already covered by FAITHFUL.581's tests.
 *   - 9 client→server-only opcodes: ACE.Server handles them via a
 *     `[GameMessage(...)]`-attributed inbound handler, so a compliant
 *     server never sends them to us.
 *   - 7 opcodes with zero implementation anywhere in ACE.Server (ported
 *     from the original retail protocol table but never wired up server-
 *     side): ACE never emits them.
 *
 * All 16 real gaps now get an explicit tolerant case instead of falling to
 * the anonymous default. This test drives the actual dispatcher with
 * synthetic wire bytes and asserts the *behavioral* difference: the
 * `[ServerMsg] Unhandled direct: ...` diagnostic (emitted only by the
 * default branch) must NOT fire for any of them, while it MUST fire for a
 * genuinely-unknown opcode — proving the assertion isn't vacuous.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameMessageOpcode } from '@ac/network';

// The 9 confirmed client→server-only opcodes (ACE.Server [GameMessage(...)]
// inbound handlers — never sent to the client by a compliant server).
const CLIENT_TO_SERVER_ONLY = [
  'CharacterCreate',
  'CharacterEnterWorld',
  'CharacterEnterWorldRequest',
  'CharacterRestore',
  'ForceObjectDescSend',
  'GetServerVersion',
  'FriendsOld',
  'DDD_RequestDataMessage',
  'DDD_InterrogationResponse',
] as const;

// The 7 confirmed dead-in-ACE opcodes (enum-only, zero ACE.Server usage).
const ACE_NEVER_SENDS = [
  'PublicUpdateSkill',
  'PrivateUpdateSkillLevel',
  'PublicUpdateSkillLevel',
  'PublicUpdateAttribute',
  'PositionAndMovement',
  'DDD_BeginPullDDD',
  'DDD_IterationData',
] as const;

const ALL_GAP_89_OPCODES = [...CLIENT_TO_SERVER_ONLY, ...ACE_NEVER_SENDS];

describe('GAP.89 — direct-opcode coverage: real gaps no longer fall to the anonymous default', () => {
  let handler: ServerMessageHandler;
  let logSpy: import('vitest').MockInstance;

  beforeEach(() => {
    handler = new ServerMessageHandler();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('sanity: all 16 names resolve to distinct numeric opcodes in the enum', () => {
    const values = ALL_GAP_89_OPCODES.map(
      (name) => (GameMessageOpcode as unknown as Record<string, number>)[name],
    );
    for (const v of values) expect(typeof v).toBe('number');
    expect(new Set(values).size).toBe(values.length);
  });

  for (const name of ALL_GAP_89_OPCODES) {
    it(`${name} does not throw and does not emit the "Unhandled direct" diagnostic`, () => {
      const opcode = (GameMessageOpcode as unknown as Record<string, number>)[name];
      expect(() => {
        handler.handleMessage({
          type: 'direct',
          opcode,
          payload: new Uint8Array(0),
        } as any);
      }).not.toThrow();

      const unhandledCalls = logSpy.mock.calls.filter((args) =>
        String(args[0]).includes('[ServerMsg] Unhandled direct'),
      );
      expect(unhandledCalls).toHaveLength(0);
    });
  }

  it('negative control: a genuinely-unknown opcode DOES hit the anonymous default (proves the spy is discriminating, not vacuous)', () => {
    const FAKE_OPCODE = 0x9999; // not present in GameMessageOpcode
    handler.handleMessage({
      type: 'direct',
      opcode: FAKE_OPCODE,
      payload: new Uint8Array(0),
    } as any);

    const unhandledCalls = logSpy.mock.calls.filter((args) =>
      String(args[0]).includes('[ServerMsg] Unhandled direct'),
    );
    expect(unhandledCalls).toHaveLength(1);
    expect(unhandledCalls[0][0]).toContain('0x9999');
  });
});
