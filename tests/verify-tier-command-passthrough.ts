/**
 * GAP.80 — Sentinel/Advocate/Envoy command tiers.
 *
 * Gap-reconciliation (docs/gap-reconciliation-2026-06-12.md:607-610) flagged
 * this "partial": AdvocateLevel/IsAdvocate are tracked in PlayerState and
 * behaviorally tested (verify-property-int-dispatch.ts / verify-property-
 * bool-dispatch.ts), but "no client-side per-tier command gating exists...
 * No test exercises tier command logic."
 *
 * Research confirms that's the CORRECT architecture, not a missing feature:
 * per reference/ACE/Source/ACE.Entity/Enum/AccessLevel.cs (Player=0,
 * Advocate=1, Sentinel=2, Envoy=3, Developer=4, Admin=5), tier membership is
 * an account-level fact the client is never told directly. Enforcement lives
 * entirely on the server in CommandManager.cs:265/298-302
 * (`commandInfo.Attribute.Access <= session.AccessLevel`, checked again per-
 * tier for isAdvocate/isSentinel/isEnvoy/isArch/isAdmin). The retail client
 * has no local command-tier table (confirmed: no AccessLevel/Sentinel/Envoy
 * references outside string literals in reference/client-eol/symbols/
 * demangled.txt) — every `/cmd` or `@cmd` the player types is forwarded to
 * the server as GameActionTalk verbatim, and CommandHandlerResponse.
 * InvalidCommand / an access-denied SystemChat comes back if the tier check
 * fails. Gating locally would require the client to duplicate the server's
 * ACL, which retail never did and which our ACE server session doesn't hand
 * out.
 *
 * These tests pin that invariant through the retail command system
 * (chat/commands — DoCommand @ 0057e2e0: a name with no table entry and no
 * channel alias goes to the server as Event_Talk of the WHOLE line, '/'
 * already turned into '@' by OnChatCommand). The context the dispatcher is
 * built from has no access-level member, so there is nothing for a local
 * gate to consult.
 */
import { describe, it, expect } from 'vitest';
import { BinaryWriter, BinaryReader, GameActionType } from '@ac/network';
import { RetailCommandSystem, type RetailCommandContext } from '../packages/renderer/src/chat/commands/index.js';

/** Every Talk the dispatcher sends, decoded; any context read other than send is a no-op. */
function system() {
  const talk: string[] = [];
  const other: number[] = [];
  const ctx = new Proxy({} as RetailCommandContext, {
    get: (_t, k) => (k === 'send'
      ? (type: number, write?: (w: BinaryWriter) => void) => {
        const w = new BinaryWriter(64); write?.(w);
        if (type === GameActionType.Talk) talk.push(new BinaryReader(w.toBuffer()).readString16());
        else other.push(type);
        return true;
      }
      : () => undefined),
  });
  const sys = new RetailCommandSystem(ctx);
  sys.startTurbineChat();
  return { sys, talk, other };
}

// One representative command per named tier, sourced from the
// [CommandHandler(...)] attributes in reference/ACE/Source/ACE.Server/
// Command/Handlers/:
//   AdminStatCommands.cs:28   [CommandHandler("allstats", AccessLevel.Advocate, ...)]
//   AdminCommands.cs:148      [CommandHandler("finger", AccessLevel.Sentinel, ...)]
//   AdminCommands.cs:700      [CommandHandler("smite", AccessLevel.Envoy, ...)]
const TIER_COMMANDS = [
  { tier: 'Advocate', input: '/allstats', name: 'allstats', args: '' },
  { tier: 'Sentinel', input: '/finger Bob', name: 'finger', args: 'Bob' },
  { tier: 'Envoy', input: '/smite all', name: 'smite', args: 'all' },
] as const;

describe('GAP.80 — Sentinel/Advocate/Envoy commands forward tier-agnostically', () => {
  for (const { tier, input, name } of TIER_COMMANDS) {
    it(`${tier}-tier "/${name}" goes to the server as @-prefixed Talk (no client-side tier check)`, () => {
      const { sys, talk, other } = system();
      expect(sys.lookup(name)).toBeUndefined();
      sys.onChatCommand(input, 1);
      expect(talk).toEqual(['@' + input.slice(1)]);
      expect(other).toEqual([]);
    });

    it(`${tier}-tier "@${name}" (already admin-prefixed) passes through unchanged`, () => {
      const { sys, talk } = system();
      const atInput = '@' + input.slice(1);
      sys.onChatCommand(atInput, 1);
      expect(talk).toEqual([atInput]);
    });
  }

  it('the command context declares no access-level member for a local gate to read', () => {
    const read = new Set<string | symbol>();
    const ctx = new Proxy({} as RetailCommandContext, {
      get: (_t, k) => { read.add(k); return k === 'send' ? () => true : () => undefined; },
    });
    const sys = new RetailCommandSystem(ctx);
    for (const { input } of TIER_COMMANDS) sys.onChatCommand(input, 1);
    expect([...read].filter((k) => /access|tier|admin|advocate|sentinel|envoy/i.test(String(k)))).toEqual([]);
  });
});
