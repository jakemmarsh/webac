/**
 * FAITHFUL.223 / BUG.login-position-restore-unreachable-positiontypes —
 * onPrivateUpdatePosition routes by PositionType.
 *
 * ACE sends PrivateUpdatePosition (opcode 0x02DB) with a positionType
 * discriminator, but per GameEventPlayerDescription.cs:202-212 (login) and
 * the sole `new GameMessagePrivateUpdatePosition` call site across
 * ACE.Server, Creature_Death.cs:559 (live), the ONLY PositionType ACE ever
 * ships this way is LastOutsideDeath (14) — PositionType.Location (1) is
 * handled defensively client-side in case a server/mod ever sends it, but
 * ACE itself never does either.
 *
 * Binding a lifestone/portal (WorldObject_Magic.cs Tie handlers) never
 * sends a position packet at all — only SetPosition (cache/Biota, no
 * network send) + a SendChatMessage confirmation. A prior version of this
 * test pinned main.ts case blocks for LinkedLifestone(15)/
 * LinkedPortalOne(8)/LinkedPortalTwo(16) driving lifestoneSystem/
 * recallSystem from THIS handler — that was the wrong premise (see the
 * BUG's tasks.json notes for the ACE source citations); those branches were
 * deleted, and the binds are now driven from the chat confirmation text in
 * onServerMessage (see verify-tie-bind-chat-confirmation.ts).
 *
 * The actual PositionType routing decision now lives in
 * resolveLoginPositionRestore() (packages/shared/src/systems
 * /LoginPositionRestore.ts, shared by both the login-snapshot path and this
 * live handler) and is covered behaviorally by
 * tests/verify-login-position-restore.ts. This file pins only what that
 * shared resolver can't cover: that onPrivateUpdatePosition actually
 * delegates to it, and that Location is handled as a forced correction
 * rather than falling through to the resolver.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN_TS = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('FAITHFUL.223 — PrivateUpdatePosition routes by PositionType', () => {
  it('handles PositionType.Location (1) as a forced correction before consulting the resolver', () => {
    expect(MAIN_TS).toMatch(/onPrivateUpdatePosition: \(data\) => \{[\s\S]{0,1500}POSTYPE_LOCATION = 1/);
    expect(MAIN_TS).toMatch(/POSTYPE_LOCATION[\s\S]{0,600}applyServerPositionCorrection/);
  });

  it('delegates every other PositionType to the shared resolveLoginPositionRestore()', () => {
    expect(MAIN_TS).toMatch(/onPrivateUpdatePosition: \(data\) => \{[\s\S]{0,3000}resolveLoginPositionRestore\(data\.positionType, data, wx, wy, wz\)/);
  });

  it('routes a resolved lastOutsideDeath action to lastOutsideDeathState', () => {
    expect(MAIN_TS).toMatch(/onPrivateUpdatePosition: \(data\) => \{[\s\S]{0,3500}action\?\.kind === 'lastOutsideDeath'[\s\S]{0,500}lastOutsideDeathState\.set/);
  });

  it('AC landblock → world conversion is inlined (uses landblockX/landblockY × 192)', () => {
    // The conversion has to apply landblock offset to local x/y, mapping
    // AC Z to Three.js Y. Pin the formula structure so a future refactor
    // doesn't silently drop the axis swap.
    expect(MAIN_TS).toMatch(/landblockX\(data\.landblockId\) \* 192 \+ data\.x/);
    expect(MAIN_TS).toMatch(/landblockY\(data\.landblockId\) \* 192 \+ data\.y/);
  });

  it('does NOT route LinkedLifestone/LinkedPortalOne/LinkedPortalTwo through this handler (BUG.login-position-restore-unreachable-positiontypes)', () => {
    const handlerBlock = MAIN_TS.match(/onPrivateUpdatePosition: \(data\) => \{[\s\S]+?\n      \},/)?.[0] ?? '';
    expect(handlerBlock).not.toMatch(/lifestoneSystem\.bind/);
    expect(handlerBlock).not.toMatch(/RecallType\.PrimaryPortal/);
    expect(handlerBlock).not.toMatch(/RecallType\.SecondaryPortal/);
  });
});
