/**
 * Reconnect cleanup (2026-11-10): every reconnect / login-retry schedule moved into
 * session/RetryPolicy.ts with its value unchanged (docs/reconnect.md). This pins the values the
 * move carried over, and that the re-exported connection schedules are the connection's own.
 */
import { describe, it, expect } from 'vitest';
import { ClientConnection, WS_OPEN_TIMEOUT_MS as NET_WS_OPEN_TIMEOUT_MS } from '../packages/network/src/index.js';
import * as P from '../packages/renderer/src/session/RetryPolicy.js';

describe('RetryPolicy', () => {
  it('keeps every schedule at the value it had before the move', () => {
    expect(P.RESUME_DELAYS_MS).toEqual([2000, 5000, 10000]);
    expect(P.RESUME_UNREACHABLE_GRACE_MS).toBe(120_000);
    expect(P.RESUME_UNREACHABLE_GAPS_MS).toEqual([2000, 5000, 10000, 15000]);
    expect(P.RESUME_ONLINE_SETTLE_MS).toBe(1000);
    expect(P.RESUME_HEALTHY_MS).toBe(20_000);
    expect(P.RESUME_PAGE_CAP).toBe(9);
    expect(P.RESUME_PAGE_CAP_WINDOW_MS).toBe(600_000);
    expect(P.RESUME_SILENT_AGAIN_WINDOW_MS).toBe(600_000);
    expect(P.IN_WORLD_RETRY_DELAY_MS).toBe(3000);
    expect(P.IN_WORLD_RETRY_BUDGET).toBe(25);
    expect(P.JUST_CREATED_RETRY_DELAYS_MS).toEqual([500, 1000, 2000, 2000]);
    expect(P.JUST_CREATED_WINDOW_MS).toBe(10_000);
    expect(P.RESUME_IN_WORLD_RETRY_DELAYS_MS).toEqual(Array(10).fill(1000));
    expect(P.PROVEN_LOGIN_RETRY_DELAYS_MS).toEqual([3000, 6000]);
    expect(P.CASE_VERBATIM_RETRY_DELAY_MS).toBe(500);
    expect(P.LOGIN_HOLDER_RETRY_DELAYS_MS).toEqual([1000, 2000, 2000, 3000, 3000, 4000, 4000, 4000]);
    expect(P.HANDOVER_RETRY_MS).toEqual([5_000, 15_000, 30_000, 60_000, 120_000]);
    expect(P.WORLD_LIST_RETRY_DELAYS_MS).toEqual([2_000, 5_000]);
    expect(P.WORLD_LIST_BACKGROUND_RETRY_MS).toBe(30_000);
    expect(P.CONNECT_RETRY_MS).toBe(3000);
    expect(P.CONNECT_STATUS_MAX_FAILURES).toBe(5);
    expect(P.RELINK_DELAYS_MS).toEqual([2_000, 5_000, 10_000, 30_000]);
  });

  it('re-exports the connection\'s own schedules, not copies', () => {
    expect(P.WS_OPEN_TIMEOUT_MS).toBe(NET_WS_OPEN_TIMEOUT_MS);
    expect(P.LOGIN_REJECT_RETRY_MS).toBe(ClientConnection.LOGIN_REJECT_RETRY_MS);
    expect(P.MAX_LOGIN_REJECT_RETRIES).toBe(ClientConnection.MAX_LOGIN_REJECT_RETRIES);
  });
});
