/**
 * GAP.81 — death/respawn is fully automatic in retail, no full-screen
 * "You have died!" modal or clickable "Respawn at Lifestone" button.
 *
 * Research (decompiled EoL client + ACE C# source):
 *   - ClientCombatSystem::HandlePlayerDeathEvent only calls
 *     ClientSystem::AddTextToScroll (a chat-log line) — no UI panel class.
 *   - gmVitaeUI (reference/client-eol demangled.txt) is an in-panel
 *     UIElement_Field readout (PostInit/Update), not a full-screen overlay.
 *   - `@lifestone` is a typed chat command (DoLifestone ->
 *     CM_Character::Event_TeleToLifestone), same pattern as `@marketplace`
 *     — recall is never a UI button click.
 *   - ACE Player_Death.cs Die()/ThreadSafeTeleportOnDeath(): respawn is a
 *     scripted, fully automatic sequence — death anim, `animLength + 1.0f`
 *     delay, CreateCorpse + teleport "through portal space" to the bound
 *     lifestone, then a further exact `3.0f` second delay before vitals
 *     are restored to 75%. No player action anywhere in that chain.
 *
 * So the invented full-screen red overlay + click-through respawn button
 * (deathRed/vitaeText AC_COLORS, GameUI.showDeathScreen/hideDeathScreen/
 * setOnRespawn) was never faithful — it only ever fired on the solo-mode
 * (no-server, `aceCharGuid === null`) fallback path (ACE mode already
 * skipped it per FAITHFUL.264). Dropped entirely.
 *
 * A follow-up cycle then traced that solo-mode fallback's own call graph
 * and found it can never run either: `checkPlayerDeath()` only executes
 * once `gameStarted` is true, and `gameStarted` only ever flips true from
 * the `objectCreate` handler's `aceCharGuid !== null` branch — so by the
 * time the death check runs, ACE mode is guaranteed. Confirmed live
 * (forced `gameLoop.start()` with no ACE connection: the death check
 * never ticked). The whole fallback branch (plus the now-unreferenced
 * `respawnPlayer()` helper and the `DEATH_PRE_TELEPORT_DELAY_SECONDS` /
 * `DEATH_TELEPORT_REVIVE_DELAY_SECONDS` constants it alone consumed) was
 * removed as unreachable dead code — no product goal (GOAL.md explicitly
 * only calls out solo mode as something NOT to test against) called for a
 * bespoke no-server entry path to keep it alive.
 *
 * This introspects the real shipped GameUI class (not a source-text regex
 * pin).
 */
import { describe, it, expect } from 'vitest';
import { GameUI, AC_COLORS } from '../packages/renderer/src/ui/GameUI';

describe('GAP.81 — invented full-screen death modal removed from GameUI', () => {
  it('showDeathScreen/hideDeathScreen/setOnRespawn no longer exist on the shipped class', () => {
    expect('showDeathScreen' in GameUI.prototype).toBe(false);
    expect('hideDeathScreen' in GameUI.prototype).toBe(false);
    expect('setOnRespawn' in GameUI.prototype).toBe(false);
  });

  it('the undocumented deathRed/vitaeText AC_COLORS entries are gone (dead code, matches the hpFrac* precedent)', () => {
    expect(AC_COLORS).not.toHaveProperty('deathRed');
    expect(AC_COLORS).not.toHaveProperty('vitaeText');
  });

  it('portal space overlay controls remain available (used by real portal/recall travel, not death)', () => {
    expect('showPortalSpace' in GameUI.prototype).toBe(true);
    expect('hidePortalSpace' in GameUI.prototype).toBe(true);
  });
});
