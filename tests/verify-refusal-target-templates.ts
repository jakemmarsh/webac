/**
 * OBS.refusal-target-templates (2026-11-25, production trace 99a0e959553ab107) — the use-on-target
 * refusals (input/TargetCompatible.ts, from each era's EraClientRules.useWithTargetText) were in no
 * client template list, so each item pair made its own refusal text and code ("Cannot use the _ with
 * the _s", c:583ea42c beside c:385916d7) and item words leaked ("Cannot use the Healing _ with the
 * Pyreals"). Driven through the real TargetCompatible gate, the era tables and the shipped reporter;
 * the sweep's other %s spew refusals (placement, auto-wield, shortcut bar) are checked the same way,
 * and the inverse: no added template takes over another message.
 */
import { describe, it, expect } from 'vitest';
import { RefusalReporter, refusalHash, type RefusalEvent } from '../packages/renderer/src/telemetry/RefusalReporter';
import {
  matchClientTemplate, matchTemplates, nameSafeText, CLIENT_LINE_TEMPLATES, CLIENT_REFUSAL_LINE_TEMPLATES,
  CLIENT_PREFIX_LINE_TEMPLATES,
} from '../packages/renderer/src/telemetry/RefusalTemplates';
import { targetCompatibleWithObject, type TargetCompatSource, type TargetCompatTarget } from '../packages/renderer/src/input/TargetCompatible';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures';
import { eraProfile, ERA_PROFILES } from '../packages/renderer/src/era/EraProfiles';
import {
  AC1999_CONTAINER_LEGAL_STRINGS, AC1999_PLACEMENT_TEXT, CONTAINER_LEGAL_STRINGS, EOR_PLACEMENT_TEXT, ITEM_LIST_DROP_STRINGS,
} from '../packages/renderer/src/inventory/ItemHolderPlacement';
import { PLACE_IN_3D_STRINGS } from '../packages/renderer/src/inventory/AttemptPlaceIn3D';
import { shortcutDuplicateText, shortcutIneligibleText } from '../packages/renderer/src/network/itemShortcutRestore';
import { alreadyPlacingText } from '../packages/renderer/src/ui/GameUI';
import { inscriptionPressRefusal } from '../packages/renderer/src/ui/examine/ExaminationWindow';
import {
  BOOK_CANNOT_CHANGE_TEXT, BOOK_NOTICE_TEMPLATES, bookAlreadyBlankText, bookOnlyAuthorText,
} from '../packages/renderer/src/ui/BookModel';
import {
  AUTOWIELD_CANNOT_WIELD_MORE, SERVER_REFUSAL_TEMPLATES, autoWieldMovingLine, weenieErrorText,
} from '../packages/shared/src/index';

const fill = (t: string, ...names: string[]): string => { let i = 0; return t.replace(/%[hl]?s/g, () => names[i++] ?? 'X'); };
const under = (t: string): string => t.replace(/%[hl]?s/g, '_');

function rig() {
  const events: RefusalEvent[] = [];
  const r = new RefusalReporter({
    endpoint: 'http://x/client-preworld', build: 'b1', trace: 'feedc0de12345678',
    era: () => 'eor', server: () => 'bb791cc4', now: () => 1000,
    send: (_url, body) => { events.push(JSON.parse(body) as RefusalEvent); },
  });
  return { r, events };
}

const PLAYER = 0x50000001;
const eor = eraClientRules(eraProfile('eor')).useWithTargetText;
const dm = eraClientRules(eraProfile('classic-dereth')).useWithTargetText;
const y1999 = eraClientRules(eraProfile('ac1999-retail')).useWithTargetText;
const src = (name: string, over: Partial<TargetCompatSource> = {}): TargetCompatSource =>
  ({ name, useability: 0x00080008, targetType: 0x10, ownedByPlayer: true, ...over });
const tgt = (name: string, over: Partial<TargetCompatTarget> = {}): TargetCompatTarget =>
  ({ guid: 0x7000_0001, name, itemType: 0x80, ownedByPlayer: true, isPlayer: false, ...over });

describe('OBS.refusal-target-templates — the use-on-target refusals key by their template', () => {
  it('production\'s three item pairs are one template, one code, no item words (every era)', () => {
    for (const text of [eor, dm, y1999]) {
      const lines = [
        targetCompatibleWithObject(src('Key'), tgt('Doors'), PLAYER, text).line!,
        targetCompatibleWithObject(src('Healing Kit'), tgt('Pyreals'), PLAYER, text).line!,
        targetCompatibleWithObject(src('Mana Stone'), tgt('Bundles of Arrowheads'), PLAYER, text).line!,
      ];
      expect(lines).toEqual(['Cannot use the Key with the Doors', 'Cannot use the Healing Kit with the Pyreals',
        'Cannot use the Mana Stone with the Bundles of Arrowheads']);
      for (const l of lines) expect(matchClientTemplate(l)).toBe('Cannot use the _ with the _');
    }
    const g = rig();
    for (const [a, b] of [['Key', 'Doors'], ['Healing Kit', 'Pyreals'], ['Mana Stone', 'Bundles of Arrowheads']]) {
      g.r.clientSpew(targetCompatibleWithObject(src(a), tgt(b), PLAYER, eor).line!);
    }
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ text: 'Cannot use the _ with the _', code: `c:${refusalHash('Cannot use the _ with the _')}` });
  });

  it('the self line and the ownership lines (1999 with its full stop) map to their own templates', () => {
    const self = targetCompatibleWithObject(src('Healing Kit', { useability: 0x00080008 }), tgt('Bob', { guid: PLAYER, isPlayer: true, itemType: 0x10 }), PLAYER, eor).line!;
    expect(self).toBe('Cannot use the Healing Kit on yourself');
    expect(matchClientTemplate(self)).toBe('Cannot use the _ on yourself');
    const notOwned = (text: typeof eor) =>
      targetCompatibleWithObject(src('Lockpick of Ease', { useability: 0x00080008 }), tgt('Chest', { ownedByPlayer: false }), PLAYER, text).line!;
    expect(matchClientTemplate(notOwned(eor))).toBe("You can't use the _ on what you don't own");
    expect(matchClientTemplate(notOwned(y1999))).toBe("You can't use the _ on what you don't own.");
    const mustOwn = (text: typeof eor) =>
      targetCompatibleWithObject(src('Mana Stone', { ownedByPlayer: false }), tgt('Sword'), PLAYER, text).line!;
    expect(matchClientTemplate(mustOwn(eor))).toBe('You must own the _ to use it');
    expect(matchClientTemplate(mustOwn(y1999))).toBe('You must own the _ to use it.');
    const trading = targetCompatibleWithObject(src('Mana Stone'), tgt('Sword', { beingTraded: true }), PLAYER, eor).line!;
    expect(matchClientTemplate(trading)).toBe("You can't use the _ on an item you are trading");
  });

  it('overlaps: "with the" vs "on yourself" vs "Cannot use the %s"-shaped and "The %s cannot be used" lines each keep their own', () => {
    expect(matchClientTemplate('Cannot use the Kit on yourself')).toBe('Cannot use the _ on yourself');
    expect(matchClientTemplate('Cannot use the Kit with the Gem')).toBe('Cannot use the _ with the _');
    // A name holding the other template's words still keys by the template that built the line.
    expect(matchClientTemplate('Cannot use the Kit with the Ring of the Sun')).toBe('Cannot use the _ with the _');
    expect(matchClientTemplate('The Statue cannot be used')).toBe('The _ cannot be used');
    // The paperdoll's "Cannot be used with %s" is a different line.
    expect(matchClientTemplate('Cannot be used with Arrows')).toBe('Cannot be used with _');
  });

  it('the success line stays a notice, not a refusal', () => {
    const g = rig();
    const ok = targetCompatibleWithObject(src('Healing Kit'), tgt('Bob', { isPlayer: true, itemType: 0x10 }), PLAYER, eor);
    expect(ok).toEqual({ ok: true, line: 'Using the Healing Kit on Bob' });
    g.r.clientSpew(ok.line!);
    expect(g.events).toEqual([]);
  });

  it('a line no template covers still goes through the vocabulary scrub as before', () => {
    const line = 'Cannot use that Zorbulator here';
    expect(matchClientTemplate(line)).toBe(line);
    const g = rig();
    g.r.clientSpew(line);
    expect(g.events).toHaveLength(1);
    expect(g.events[0].text).toBe(nameSafeText(line).text);
    expect(g.events[0].text).not.toContain('Zorbulator');
  });
});

describe('OBS.refusal-target-templates sweep — the other %s spew refusals', () => {
  it('every era\'s use-with and placement table is in the list (minus the two 1999 look-alikes)', () => {
    for (const p of Object.values(ERA_PROFILES)) {
      const r = eraClientRules(p);
      for (const t of [...Object.values(r.useWithTargetText), ...Object.values(r.placementText)]) {
        if (typeof t !== 'string' || !/%s/.test(t)) continue;
        if (t === AC1999_PLACEMENT_TEXT.playerItems || t === AC1999_PLACEMENT_TEXT.items) {
          expect(CLIENT_REFUSAL_LINE_TEMPLATES).not.toContain(t);
          continue;
        }
        expect(CLIENT_LINE_TEMPLATES, `${p.id}: ${t}`).toContain(t);
      }
    }
  });

  it('each built line keys by its template, whatever the name', () => {
    const cases: Array<[string, string]> = [
      [fill(EOR_PLACEMENT_TEXT.items, 'Small Belt Pouch'), 'The _ is completely full!'],
      [fill(EOR_PLACEMENT_TEXT.playerContainers, 'Ming Masun'), '_ can carry no more containers!'],
      [fill(AC1999_PLACEMENT_TEXT.containers, 'Large Pack'), 'The _ can fit no more containers'],
      [fill(CONTAINER_LEGAL_STRINGS.locked, 'Locked Chest'), 'The _ is locked'],
      [fill(CONTAINER_LEGAL_STRINGS.traded, 'Iron Chest'), 'The _ is being traded'],
      [fill(AC1999_CONTAINER_LEGAL_STRINGS.withinItself, 'Pack'), "Can't place _ within itself"],
      [fill(AC1999_CONTAINER_LEGAL_STRINGS.containerInvalid, 'Healing Kit'), 'The container in which to place the _ is not valid'],
      [fill(ITEM_LIST_DROP_STRINGS.cannotAcceptItems, 'Sack'), 'The _ cannot accept items'],
      [alreadyPlacingText('Bundle of Arrowheads'), 'Already attempting to place _ here'],
      [fill(PLACE_IN_3D_STRINGS.cannotGive, 'Mana Stone', 'Drudge Sneak'), 'Cannot give _ to _'],
      [fill(PLACE_IN_3D_STRINGS.mustOpenFirst, 'Chest'), 'You must open the _ first'],
      [fill(PLACE_IN_3D_STRINGS.tradingCannotDrop, 'Pyreals'), 'You are trading the _, it cannot be dropped'],
      [fill(AUTOWIELD_CANNOT_WIELD_MORE, 'Arrows'), 'You cannot wield more _'],
      [autoWieldMovingLine('Leather Gauntlets', false), 'Moving _ to your backpack - cannot unwield the _'],
      [shortcutIneligibleText('Pyreal'), 'You cannot make a shortcut to the _'],
      [shortcutDuplicateText('Healing Kit'), 'There is already a shortcut to the _'],
      [inscriptionPressRefusal({ inscribable: true, owned: true, scribe: 'Ming Masun', playerName: 'Bob' })!, 'Only _ can change the inscription'],
    ];
    for (const [line, want] of cases) expect(matchClientTemplate(line), line).toBe(want);
  });

  it('the refactored builders print exactly what they printed before', () => {
    expect(autoWieldMovingLine('Tunic', true)).toBe('Moving Tunic to your backpack');
    expect(autoWieldMovingLine('Tunic', false)).toBe('Moving Tunic to your backpack - cannot unwield the Tunic');
    expect(autoWieldMovingLine('$& Odd', false)).toBe('Moving $& Odd to your backpack - cannot unwield the $& Odd');
    expect(alreadyPlacingText('Pack')).toBe('Already attempting to place Pack here');
    expect(alreadyPlacingText('$1')).toBe('Already attempting to place $1 here');
    // The auto-wield's success form is still a notice.
    const g = rig();
    g.r.clientSpew(autoWieldMovingLine('Tunic', true));
    expect(g.events).toEqual([]);
    g.r.clientSpew(autoWieldMovingLine('Tunic', false));
    expect(g.events.map((e) => e.text)).toEqual(['Moving _ to your backpack - cannot unwield the _']);
  });
});

describe('OBS.refusal-target-templates inverse — no added template takes over another message', () => {
  it('no server refusal text keys differently than before the added templates', () => {
    // As prefixes, "The %s is locked" took ACE's "The fellowship is locked, you were not added to the fellowship.":
    // the added templates match whole lines only.
    expect(matchClientTemplate('The fellowship is locked, you were not added to the fellowship.'))
      .toBe('The fellowship is locked, you were not added to the fellowship.');
    const corpus = [
      ...SERVER_REFUSAL_TEMPLATES.map((s) => s.replace(/_/g, 'Zork Ulm')),
      // The two 1999 look-alikes left out: the server's FellowshipFull and GDLE / the AC1999 server's house lines.
      weenieErrorText(0x041e)!, 'The access list is full', 'The storage access list is full',
      'The door is locked!', 'The Zork Ulm is fully charged.',
    ];
    expect(corpus).toContain('Your Fellowship is full');
    for (const line of corpus) {
      const before = matchTemplates(line, CLIENT_PREFIX_LINE_TEMPLATES);
      const now = matchClientTemplate(line);
      // Unchanged, or now keyed by the server's own template form (a client template with the same words).
      if (now !== before) expect(now, line).toBe(SERVER_REFUSAL_TEMPLATES.find((s) => s.replace(/_/g, 'Zork Ulm') === line));
    }
  });

  it('every client template still maps its own line back to itself, and the old ones key as before', () => {
    for (const t of CLIENT_LINE_TEMPLATES) {
      const line = fill(t, 'Zork Ulm', 'Quix Arn');
      expect(matchClientTemplate(line), t).toBe(under(t));
    }
    for (const t of CLIENT_PREFIX_LINE_TEMPLATES) {
      for (const line of [fill(t, 'Zork Ulm', 'Quix Arn'), fill(t, 'Zork Ulm', 'Quix Arn') + " - you're too busy"]) {
        expect(matchClientTemplate(line), line).toBe(matchTemplates(line, CLIENT_PREFIX_LINE_TEMPLATES));
      }
    }
  });
});

describe('OBS.refusal-template-sweep-2 — the book\'s named notices key by their template', () => {
  const AUTHORS = ['Asheron', 'Lord Kresovus of Dereth', "Ma'at Al-Khaliq", 'X', 'Bob the Great'];
  const BOOK_KINDS = new Set(['Only _ can change this page', 'The _ is already open to a blank page']);

  it('production\'s "Only _ of _ can change this page" and every other author shape are one code', () => {
    const g = rig();
    for (const a of AUTHORS) {
      const line = bookOnlyAuthorText(a);
      expect(line).toBe(`Only ${a} can change this page`);
      expect(matchClientTemplate(line), line).toBe('Only _ can change this page');
      g.r.clientSpew(line);
    }
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ text: 'Only _ can change this page', code: `c:${refusalHash('Only _ can change this page')}` });
    // c:a143a3cb was the per-shape code production saw for "Only _ of _ can change this page".
    expect(g.events[0].code).not.toBe('c:a143a3cb');
    expect(CLIENT_REFUSAL_LINE_TEMPLATES).toContain(BOOK_NOTICE_TEMPLATES.onlyAuthor);
    expect(CLIENT_REFUSAL_LINE_TEMPLATES).toContain(BOOK_NOTICE_TEMPLATES.alreadyBlank);
  });

  it('"You cannot change this page" stays its own kind', () => {
    expect(matchClientTemplate(BOOK_CANNOT_CHANGE_TEXT)).toBe(BOOK_CANNOT_CHANGE_TEXT);
    const g = rig();
    g.r.clientSpew(bookOnlyAuthorText('Asheron'));
    g.r.clientSpew(BOOK_CANNOT_CHANGE_TEXT);
    expect(g.events.map((e) => e.text)).toEqual(['Only _ can change this page', 'You cannot change this page']);
    expect(new Set(g.events.map((e) => e.code)).size).toBe(2);
  });

  it('the blank-page notice keys by its template, whatever the book', () => {
    const g = rig();
    for (const b of ['Book', 'Journal of the Hopeslayer', "Asheron's Diary"]) {
      expect(matchClientTemplate(bookAlreadyBlankText(b))).toBe('The _ is already open to a blank page');
      g.r.clientSpew(bookAlreadyBlankText(b));
    }
    expect(g.events.map((e) => e.text)).toEqual(['The _ is already open to a blank page']);
  });

  it('the builders print what they printed before, "$" names literal', () => {
    expect(bookOnlyAuthorText('Asheron')).toBe('Only Asheron can change this page');
    expect(bookAlreadyBlankText('Book')).toBe('The Book is already open to a blank page');
    expect(bookOnlyAuthorText('$& Odd')).toBe('Only $& Odd can change this page');
    expect(bookAlreadyBlankText("$'")).toBe("The $' is already open to a blank page");
  });

  it('inverse: lines that only share words with the book templates are not swallowed', () => {
    for (const line of [
      'Nobody can change this page',
      'Only Asheron can change this page now',
      'You cannot change this page',
      'Only the fellowship leader can recruit',
      'Only Bob can change the inscription',
      'The Book is already open',
      'The Book is already open to a blank page, sadly',
    ]) {
      expect(BOOK_KINDS.has(matchClientTemplate(line)), line).toBe(false);
    }
    expect(matchClientTemplate('Only Bob can change the inscription')).toBe('Only _ can change the inscription');
    for (const s of SERVER_REFUSAL_TEMPLATES) {
      expect(BOOK_KINDS.has(matchClientTemplate(s.replace(/_/g, 'Zork Ulm'))), s).toBe(false);
    }
  });
});
