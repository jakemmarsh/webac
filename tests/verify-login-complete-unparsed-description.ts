import { describe, it, expect } from 'vitest';
import { LoginCompleteNotifier } from '../packages/renderer/src/network/LoginCompleteNotifier.js';

// playwebac.com 2026-10-04: a character stayed in ACE's Hidden purple bubble
// after login. ACE un-hides only on LoginComplete, so the description must be
// recorded even when our parser can't read it, before anything else can fail.
describe('LoginComplete after an unparsed PlayerDescription', () => {
  it('a null (unparsed) description still lets LoginComplete go out when the animation finishes', () => {
    let sent = 0;
    const n = new LoginCompleteNotifier({ send: () => { sent++; } });
    n.notePlayerCreated();
    n.notePlayerDescriptionFrom(null);
    n.sendLoginCompleteNotification();
    expect(sent).toBe(1);
  });

  it('a pending send (player not created yet) fires once the player and an unparsed description arrive', () => {
    let sent = 0;
    const n = new LoginCompleteNotifier({ send: () => { sent++; } });
    n.sendLoginCompleteNotification(); // animation done before our CreateObject: pending
    expect(sent).toBe(0);
    n.notePlayerCreated();
    n.notePlayerDescriptionFrom(null);
    expect(sent).toBe(1);
  });

  it('a parsed description still waits for its contained objects', () => {
    let sent = 0;
    const n = new LoginCompleteNotifier({ send: () => { sent++; } });
    n.notePlayerCreated();
    n.notePlayerDescriptionFrom({ inventoryPlacement: [{ guid: 0x80000001 }, { guid: 0x80000002 }] });
    n.sendLoginCompleteNotification();
    expect(sent).toBe(0);
    n.noteObjectCreated(0x80000001);
    n.noteObjectCreated(0x80000002);
    expect(sent).toBe(1);
  });

  it('safety valve: a send stuck on an item that never arrives goes out and reports the missing guid', () => {
    let sent = 0;
    const n = new LoginCompleteNotifier({ send: () => { sent++; } });
    n.notePlayerCreated();
    n.notePlayerDescriptionFrom({ inventoryPlacement: [{ guid: 0x80000001 }, { guid: 0x80000002 }] });
    n.noteObjectCreated(0x80000001);
    n.sendLoginCompleteNotification();
    expect(sent).toBe(0);
    expect(n.isPending).toBe(true);
    expect(n.forceSendIfPending()).toEqual([0x80000002]);
    expect(sent).toBe(1);
    expect(n.isPending).toBe(false);
    expect(n.forceSendIfPending()).toBeNull(); // nothing pending: no second send
    expect(sent).toBe(1);
  });
});

describe('hasPlayerDescription (CPlayerSystem::player_desc_received)', () => {
  it('is false until a description arrives (parsed or not), and again after a session reset', () => {
    const n = new LoginCompleteNotifier({ send: () => {} });
    expect(n.hasPlayerDescription).toBe(false); // the 1999 server's description comes after the login hold
    n.notePlayerDescriptionFrom(null);
    expect(n.hasPlayerDescription).toBe(true);
    n.reset();
    expect(n.hasPlayerDescription).toBe(false);
    n.notePlayerDescriptionFrom({ inventoryPlacement: [] });
    expect(n.hasPlayerDescription).toBe(true);
  });
});
