/**
 * BUG.login-hold-powerbar-before-hud — the login tunnel runs under the
 * gameplay UI, as retail's gmGamePlayUI comes up at BeginEnterWorld
 * (session/GameplayUiShow.ts): once the HUD art is ready while the arrival is
 * still held, once per session, never for a session that already ended.
 */
import { describe, expect, it } from 'vitest';
import { GameplayUiShow } from '../packages/renderer/src/session/GameplayUiShow.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('GameplayUiShow', () => {
  it('comes up when the HUD art is ready while the arrival is still held, and only once', async () => {
    let shows = 0;
    const ui = new GameplayUiShow(() => { shows++; });
    let ready!: () => void;
    ui.enterWhen(new Promise<void>((r) => { ready = r; }), () => true);
    await tick();
    expect(shows).toBe(0); // the art is not resident yet: bare tunnel for now
    ready();
    await tick();
    expect(shows).toBe(1);
    expect(ui.isShown).toBe(true);
    ui.enter(); // the game start after the hold
    expect(shows).toBe(1);
  });

  it('a hold that already released leaves it to the game start; a failed wait too', async () => {
    let shows = 0;
    const ui = new GameplayUiShow(() => { shows++; });
    ui.enterWhen(Promise.resolve(), () => false);
    ui.enterWhen(Promise.reject(new Error('art failed')), () => true);
    await tick();
    expect(shows).toBe(0);
    ui.enter();
    expect(shows).toBe(1);
  });

  it('after a reset (logout / disconnect during the hold) the next session shows it again, and an old wait never does', async () => {
    let shows = 0;
    const ui = new GameplayUiShow(() => { shows++; });
    let ready!: () => void;
    ui.enterWhen(new Promise<void>((r) => { ready = r; }), () => true);
    ui.reset(); // the session ended before the art landed
    ready();
    await tick();
    expect(shows).toBe(0);
    expect(ui.isShown).toBe(false);
    ui.enter();
    expect(shows).toBe(1);
    ui.reset();
    expect(ui.isShown).toBe(false);
    ui.enter();
    expect(shows).toBe(2);
  });
});
