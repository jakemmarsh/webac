/**
 * BUG.server-text-spew-double-refusal — a server text line shown through the spew box is one
 * refusal record, the server's (`t:`), never also a client one (`c:`).
 *
 * Seen live 2026-11-16 on a GDLE classic server: "… does not have enough pack space to complete
 * this trade!" (ServerMessage 0xF7E0, type 0x1a) was logged twice, 9 ms apart, once source=client,
 * because main.ts showed it with addServerTextLine outside the reporter's `quietly` and
 * GameUI.displayErrorText's tap (RefusalReporter.clientSpew) recorded it too.
 *
 * Drives the real RefusalReporter, the real addServerTextLine / addTextToScroll /
 * transientStringLine, and showServerText (the function main.ts's ServerMessage and transient
 * handlers call), on a surface whose displayErrorText taps clientSpew as GameUI's does.
 */
import { describe, it, expect } from 'vitest';
import { RefusalReporter, showServerText, type RefusalEvent } from '../packages/renderer/src/telemetry/RefusalReporter';
import { addServerTextLine, addTextToScroll, transientStringLine, type ScrollSurface } from '../packages/renderer/src/ui/ServerMessageText';

const PACK_SPACE = 'Bob does not have enough pack space to complete this trade!';

function rig() {
  const events: RefusalEvent[] = [];
  const reporter = new RefusalReporter({
    endpoint: 'http://x/client-preworld', build: 'b1', trace: 'feedc0de12345678',
    era: () => 'dark-majesty', server: () => 'gdle', now: () => 1000,
    scrub: (t: string) => t.replace(/^Bob\b/, '_'),
    send: (_url, body) => { events.push(JSON.parse(body) as RefusalEvent); },
  });
  const spew: string[] = [];
  const chat: { text: string; type?: number }[] = [];
  // GameUI.displayErrorText: the refusal tap first, then the spew box.
  const ui: ScrollSurface = {
    displayErrorText: (text) => { reporter.clientSpew(text); spew.push(text); },
    addSystemMessage: (text, _color, type) => { chat.push({ text, type }); },
  };
  return { events, reporter, ui, spew, chat };
}

describe('BUG.server-text-spew-double-refusal', () => {
  it('a 0x1a server line in the spew is recorded once, as the server\'s (end of retail / classic)', () => {
    const { events, reporter, ui, spew } = rig();
    showServerText(reporter, 'server_text', PACK_SPACE, 0x1a, () => addServerTextLine(ui, null, PACK_SPACE, 0x1a));
    expect(spew).toEqual([PACK_SPACE]);
    expect(events.filter((e) => e.source === 'client')).toEqual([]);
    const server = events.filter((e) => e.source === 'server');
    expect(server).toHaveLength(1);
    expect(server[0]!.code).toMatch(/^t:[0-9a-f]{8}$/);
    expect(server[0]!.context).toBe('server_text');
    expect(server[0]!.sink).toBe('spew');
  });

  it('the old call shape (no quietly) is what double-recorded it', () => {
    const { events, reporter, ui } = rig();
    addServerTextLine(ui, null, PACK_SPACE, 0x1a);
    reporter.serverText('server_text', PACK_SPACE, 0x1a);
    expect(events.map((e) => e.source).sort()).toEqual(['client', 'server']);
  });

  it('a transient string in the spew is recorded once, as the server\'s', () => {
    const { events, reporter, ui, spew } = rig();
    const text = 'You are out of ammunition!';
    showServerText(reporter, 'transient', text, null, () => addTextToScroll(ui, transientStringLine(text)));
    expect(spew).toEqual([text]);
    expect(events.filter((e) => e.source === 'client')).toEqual([]);
    expect(events.filter((e) => e.source === 'server' && e.context === 'transient')).toHaveLength(1);
  });

  it('AC1999 slot table: the line is a chat line, still one server record', () => {
    const { events, reporter, ui, spew, chat } = rig();
    const slots = { colors: { 1: '#ffffff' }, fallback: '#00ff00' };
    showServerText(reporter, 'server_text', PACK_SPACE, 0x1a, () => addServerTextLine(ui, slots, PACK_SPACE, 0x1a));
    expect(spew).toEqual([]);
    expect(chat).toHaveLength(1);
    expect(events.map((e) => e.source)).toEqual(['server']);
  });

  it('the client\'s own spew refusals after it still record as source=client', () => {
    const { events, reporter, ui } = rig();
    showServerText(reporter, 'server_text', PACK_SPACE, 0x1a, () => addServerTextLine(ui, null, PACK_SPACE, 0x1a));
    ui.displayErrorText('You can only move or use one item at a time');
    const client = events.filter((e) => e.source === 'client');
    expect(client).toHaveLength(1);
    expect(client[0]!.code).toMatch(/^c:[0-9a-f]{8}$/);
  });

  it('a throwing display leaves the tap on and records nothing for it', () => {
    const { events, reporter, ui } = rig();
    expect(() => showServerText(reporter, 'server_text', PACK_SPACE, 0x1a, () => { throw new Error('boom'); })).toThrow('boom');
    ui.displayErrorText('You can only move or use one item at a time');
    expect(events.map((e) => e.source)).toEqual(['client']);
  });

  it('no reporter (telemetry off): the line still shows', () => {
    const { ui, spew } = rig();
    showServerText(null, 'server_text', PACK_SPACE, 0x1a, () => addServerTextLine(ui, null, PACK_SPACE, 0x1a));
    expect(spew).toEqual([PACK_SPACE]);
  });
});
