/**
 * BUG.death-doesnt-clear-pending-casts — the (server-driven, ACE-mode)
 * death path clears the client's pendingCasts queue.
 *
 * ACE's Player_Death.cs Die() calls FailCast(false) when the player dies
 * mid-cast (CombatMode.Magic && MagicState.IsCasting), which unconditionally
 * sends GameEventUseDone(None) and ends MagicState's busy/cast state
 * server-side (Player_Magic.cs FailCast → SendUseDoneEvent + OnCastDone).
 *
 * Pre-fix, checkPlayerDeath()'s ACE-mode death branch already cleared
 * target/autoAttack/melee-chain state (the FAITHFUL.460 stale-state-on-death
 * pattern) but never touched pendingCasts, and the generic onUseDone handler
 * (shared across every Use action — lockpicking, mana stones, tinkering,
 * crafting, not cast-specific) doesn't drain it either. A cast in flight at
 * the moment of death lingered in pendingCasts until its 8s TTL prune,
 * keeping the HUD busy/cast ("Status") indicator lit after death.
 *
 * The FIFO itself used to be a bare array + free functions inlined in
 * main.ts's ~14k-line monolithic closure (no independently-testable unit
 * existed). Extracted to PendingCastQueue so this test can drive the real
 * shipped class instead of regex-matching main.ts source text (main.ts has
 * no import/boot harness anywhere in this suite — see the ratchet in
 * verify-test-suite-hygiene.ts). main.ts's checkPlayerDeath ACE-mode death
 * branch calls the module-scope `pendingCastHooks.__clearPendingCasts`
 * (no longer a window global: RELEASE.remove-test-defaults), which
 * delegates to this class's `clear()`.
 */
import { describe, it, expect } from 'vitest';
import { PendingCastQueue } from '../packages/renderer/src/magic/PendingCastQueue';

describe('BUG.death-doesnt-clear-pending-casts — PendingCastQueue.clear()', () => {
  it('empties a queue holding one or more pending casts', () => {
    const q = new PendingCastQueue();
    q.push(64, 0x12345678, 1000);
    q.push(65, null, 1001);
    expect(q.length).toBe(2);
    q.clear();
    expect(q.length).toBe(0);
    expect(q.consumeNext(1002)).toBeNull();
  });

  it('is a no-op on an already-empty queue', () => {
    const q = new PendingCastQueue();
    expect(q.length).toBe(0);
    q.clear();
    expect(q.length).toBe(0);
  });

  it('a cleared queue does not resurrect the cleared cast on prune/consume', () => {
    const q = new PendingCastQueue(8000);
    q.push(64, null, 1000);
    q.clear();
    // Advance well past the TTL — prune() must not throw or misbehave on
    // an empty backing array, and no stale entry should reappear.
    q.prune(50000);
    expect(q.consumeNext(50000)).toBeNull();
  });

  it('push/consumeNext still round-trips normally after a clear (queue is reusable)', () => {
    const q = new PendingCastQueue();
    q.push(64, 0xAAAA, 1000);
    q.clear();
    q.push(65, 0xBBBB, 2000);
    const cast = q.consumeNext(2001);
    expect(cast).toEqual({ spellId: 65, targetGuid: 0xBBBB, sentAt: 2000 });
  });
});
