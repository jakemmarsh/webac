/**
 * RECON.chat-entry-maxchars (was FAITHFUL.355) — the chat entry caps at its
 * DAT desc's p30.
 *
 * Retail: UIElement_Text::OnSetAttribute @ 0046a640 case 0x1e (p30) sets
 * GlyphList::m_nMaxCharacters, whose default is 0xffff
 * (GlyphList::GlyphList @ 004734a0), and GlyphList::AddText @ 00473190
 * deletes whatever an insert pushes past it. Every EoL chat entry
 * (0x2100006f / 0x21000006 / floaty template 0x2100005b, element
 * 0x10000016) carries p30 = 255. FAITHFUL.355's 200 cited an "Edit2
 * maxchars=200" that is not in the DAT, and the chat send path
 * (ChatInterface::HandleEnterKey / ProcessCommand) adds no other cap.
 *
 * Behavioural: drives the real GameUI.renderHUD() in happy-dom and inspects
 * the #chat-input it injects, then reads the real layouts from the DAT.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes, type ElementDesc } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import {
  chatEntryMaxChars, TEXT_DEFAULT_MAX_CHARACTERS, TEXT_MAX_CHARACTERS_ATTR,
} from '../packages/renderer/src/ui/FloatyChatModel.js';

/** Minimal LayoutRenderer stub: every element id the panel code asks for
 *  resolves to a real div, so the real GameUI render paths run to completion. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubLayoutRenderer(H: GameUIFixture, entryDesc?: unknown): any {
  const doc = H.win.document;
  const makeHandle = (parent: HTMLElement) => {
    const root = doc.createElement('div');
    parent.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const get = elements.get.bind(elements);
    elements.get = (id: number) => {
      let el = get(id);
      if (!el) { el = doc.createElement('div'); root.appendChild(el!); elements.set(id, el!); }
      return el;
    };
    const noop = () => {};
    return {
      root, layout: { elements: [] }, elements, descs: new Map(entryDesc ? [[0x10000016, entryDesc]] : []),
      setText: noop, setFill: noop, setVisible: noop, setState: noop, setPalette: noop, setInteractive: noop,
      setScrollable: () => ({ contentEl: doc.createElement('div'), setPosition: noop, scrollToBottom: noop, appendContent: noop }),
      setDraggable: noop, setDropTarget: noop, setTexture: noop, onClick: noop,
      destroy: () => root.remove(), moveTo: noop, close: () => root.remove(), bringToFront: noop,
    };
  };
  const lr = {
    render: (_id: number, parent: HTMLElement) => makeHandle(parent),
    renderPanel: (_id: number, parent: HTMLElement) => makeHandle(parent),
    getTextureDataURLWithAlpha: () => null,
  };
  H.ui.layoutRenderer = lr;
  return lr;
}

const p30 = (v: number) => ({ properties: new Map([[TEXT_MAX_CHARACTERS_ATTR, { valueInt: v }]]) });

async function renderedChatInput(entryDesc?: unknown): Promise<{ H: GameUIFixture; input: HTMLInputElement }> {
  const H = await mountGameUI();
  stubLayoutRenderer(H, entryDesc);
  H.ui.renderHUD();
  return { H, input: H.win.document.getElementById('chat-input') };
}

describe('Chat input caps at the entry desc p30 (RECON.chat-entry-maxchars)', () => {
  const mounted: GameUIFixture[] = [];
  afterAll(() => { for (const H of mounted) H.teardown(); });

  it('the EoL p30 = 255 becomes the #chat-input maxLength (not the old 200)', async () => {
    const { H, input } = await renderedChatInput(p30(255));
    mounted.push(H);
    expect(input).toBeTruthy();
    expect(input.tagName.toLowerCase()).toBe('input');
    expect(input.maxLength).toBe(255);
  }, 60_000);

  it('follows whatever the era DAT carries (no hardcoded cap)', async () => {
    const { H, input } = await renderedChatInput(p30(120));
    mounted.push(H);
    expect(input.maxLength).toBe(120);
  }, 60_000);

  it('a desc without p30 keeps GlyphList default 0xffff', async () => {
    const { H, input } = await renderedChatInput(undefined);
    mounted.push(H);
    expect(input.maxLength).toBe(TEXT_DEFAULT_MAX_CHARACTERS);
    expect(TEXT_DEFAULT_MAX_CHARACTERS).toBe(0xffff);
  }, 60_000);
});

describe('chatEntryMaxChars', () => {
  it('reads p30 (attribute 0x1e) and falls back to 0xffff', () => {
    expect(TEXT_MAX_CHARACTERS_ATTR).toBe(0x1e);
    expect(chatEntryMaxChars(p30(255))).toBe(255);
    expect(chatEntryMaxChars({ properties: new Map() })).toBe(0xffff);
    expect(chatEntryMaxChars(null)).toBe(0xffff);
    expect(chatEntryMaxChars(p30(0))).toBe(0xffff);
  });
});

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasDats)('EoL DAT chat entries carry p30 = 255', () => {
  let entry: (layout: number) => ElementDesc | undefined;
  beforeAll(() => {
    setMasterPropertyTypes(parseMasterProperty(openDat(DAT_PATHS.portal).getReader(0x39000001)));
    const local = openDat(DAT_PATHS.local);
    entry = (layout) => {
      const find = (m: Map<number, ElementDesc>): ElementDesc | undefined => {
        for (const e of m.values()) {
          if (e.elementId === 0x10000016) return e;
          const hit = find(e.children);
          if (hit) return hit;
        }
        return undefined;
      };
      return find(parseLayoutDesc(local.getReader(layout)).elements);
    };
  });

  it.each([
    ['main chat 0x2100006f', 0x2100006f],
    ['classic chat 0x21000006', 0x21000006],
    ['floaty template 0x2100005b', 0x2100005b],
  ])('%s entry 0x10000016 caps at 255', (_name, layout) => {
    const desc = entry(layout);
    expect(desc).toBeTruthy();
    expect(chatEntryMaxChars(desc)).toBe(255);
  });
});
