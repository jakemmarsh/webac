/**
 * CORE.17.k.c.a — the 0x00A0 InventoryServerSaveFailed event prints
 * ACCWeenieObject::ServerSaysAttemptFailed @ 0058eae0's own 0x1a line: a verb
 * by the client's ONE pending inventory request (prevRequest: "The %s can't be
 * merged / split / moved / picked up / put in the container / dropped /
 * wielded / given") on the object's name (NAME_PLURAL for merge / split,
 * NAME_APPROPRIATE otherwise) plus a per-code suffix (" - the container is
 * closed" 0x3ee, " - you're too busy" 0x1d, …), then the code's own
 * HandleFailureEvent sink unless it is one of the seven the dispatch excludes.
 *
 * Ground truth: the decompiled EoL client (ServerSaysAttemptFailed, the
 * UIAttempt* recorders @ 0058d590–0058d850, RecordRequest @ 0058c220,
 * RecordResponse @ 0058cab0, the 0x00A0 dispatch @ decomp :339948) and the
 * .rdata literals of acclient.exe (the jump table @ 0x58ee84, the templates
 * @ 0x7e4190–0x7e42f8, the suffixes @ 0x7e3ff8–0x7e4138), pinned below when
 * the reference is present. Real modules throughout; the GameUI block runs
 * in happy-dom.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadDomWindow } from './_harness/dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  InventoryRequest, InventoryRequestTracker, ATTEMPT_FAILED_VERB, ATTEMPT_FAILED_SUFFIX,
  attemptFailedObjectName, attemptFailedVerbLine, attemptFailedSuffix, attemptFailedText,
  getPluralName, getAppropriateName, WeenieError, weenieErrorText, weenieErrorTextType,
} from '@ac/shared';
import {
  GameActionType, buildPutItemInContainerPayload, buildGetAndWieldItemPayload, buildStackableMergePayload,
  buildStackableSplitToContainerPayload, buildStackableSplitTo3DPayload, buildStackableSplitToWieldPayload,
  buildGiveObjectRequestPayload, BinaryWriter,
} from '@ac/network';
import {
  classifyInventoryRequest, recordInventoryRequestFromAction, handleAttemptFailed,
  type InventoryObjectState,
} from '../packages/renderer/src/inventory/InventoryRequests.js';
import { deliverWeenieError, ATTEMPT_FAILED_NAME_TEMPLATED } from '../packages/renderer/src/ui/WeenieErrorNotices.js';

const REPO = resolve(__dirname, '..');
const EXE = resolve(REPO, 'reference/client-eol/acclient.exe');

const SWORD = { name: 'Sword', stackSize: 1 };
const ARROWS = { name: 'Arrow', stackSize: 20 };
const DYE = { name: 'Vial of Berimphur Dye', pluralName: 'Vials of Berimphur Dye', stackSize: 3 };

/* ── the enum: the jump table @ 0x58ee84 is indexed by prevRequest − 1 ──────── */

describe('CORE.17.k.c.a — InventoryRequest matches the retail jump-table order', () => {
  it('Merge 1 … Wield 7, ShopEvent 8 (no verb), Give 9', () => {
    expect(InventoryRequest.None).toBe(0);
    expect([InventoryRequest.Merge, InventoryRequest.Split, InventoryRequest.Move, InventoryRequest.PickUp,
      InventoryRequest.PutInContainer, InventoryRequest.Drop, InventoryRequest.Wield, InventoryRequest.ShopEvent,
      InventoryRequest.Give]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ATTEMPT_FAILED_VERB[InventoryRequest.ShopEvent]).toBeUndefined();
    expect(ATTEMPT_FAILED_VERB[InventoryRequest.None]).toBeUndefined();
    expect(Object.keys(ATTEMPT_FAILED_VERB)).toHaveLength(8);
  });
});

/* ── the verb line: template + name type per request ──────────────────────── */

describe('CORE.17.k.c.a — the verb line per pending request', () => {
  it('merge / split name the object NAME_PLURAL (1) — plural even for a single item', () => {
    expect(attemptFailedVerbLine(InventoryRequest.Merge, { name: 'Pyreal', stackSize: 1 })).toBe("The Pyreals can't be merged");
    expect(attemptFailedVerbLine(InventoryRequest.Split, SWORD)).toBe("The Swords can't be split");
    expect(attemptFailedVerbLine(InventoryRequest.Split, DYE)).toBe("The Vials of Berimphur Dye can't be split");
    expect(attemptFailedVerbLine(InventoryRequest.Merge, { name: 'Glass', stackSize: 1 })).toBe("The Glasses can't be merged");
  });

  it('move / pick up / put in the container / drop / wield / give name it NAME_APPROPRIATE (2) — plural only for a stack of 2+', () => {
    expect(attemptFailedVerbLine(InventoryRequest.Move, SWORD)).toBe("The Sword can't be moved");
    expect(attemptFailedVerbLine(InventoryRequest.PickUp, ARROWS)).toBe("The Arrows can't be picked up");
    expect(attemptFailedVerbLine(InventoryRequest.PutInContainer, SWORD)).toBe("The Sword can't be put in the container");
    expect(attemptFailedVerbLine(InventoryRequest.Drop, DYE)).toBe("The Vials of Berimphur Dye can't be dropped");
    expect(attemptFailedVerbLine(InventoryRequest.Wield, SWORD)).toBe("The Sword can't be wielded");
    expect(attemptFailedVerbLine(InventoryRequest.Give, { name: 'Arrow', stackSize: 1 })).toBe("The Arrow can't be given");
  });

  it('None and ShopEvent have no verb', () => {
    expect(attemptFailedVerbLine(InventoryRequest.None, SWORD)).toBe('');
    expect(attemptFailedVerbLine(InventoryRequest.ShopEvent, SWORD)).toBe('');
  });

  it('attemptFailedObjectName is GetObjectName(NAME_PLURAL) / (NAME_APPROPRIATE) — the shared helpers', () => {
    expect(attemptFailedObjectName(SWORD, 'plural')).toBe(getPluralName('Sword', undefined));
    expect(attemptFailedObjectName(ARROWS, 'appropriate')).toBe(getAppropriateName('Arrow', undefined, 20));
    expect(attemptFailedObjectName(SWORD, 'appropriate')).toBe('Sword');
    expect(getPluralName('Sword', '')).toBe('Swords'); // an EMPTY server plural falls through like retail's m_len == 1 check
    expect(getPluralName('', undefined)).toBe('');
  });
});

/* ── the suffix per code ──────────────────────────────────────────────────── */

describe('CORE.17.k.c.a — the per-code suffix', () => {
  it('the nine coded arms', () => {
    expect(attemptFailedSuffix(WeenieError.YoureTooBusy)).toBe(" - you're too busy");
    expect(attemptFailedSuffix(0x20)).toBe(' - you must control both objects');
    expect(attemptFailedSuffix(0x28)).toBe(" - the item is under someone else's control");
    expect(attemptFailedSuffix(WeenieError.YouAreTooEncumbered)).toBe(' - you are too encumbered');
    expect(attemptFailedSuffix(WeenieError.ActionCancelled)).toBe(' - action cancelled');
    for (const code of [0x37, 0x38, 0x39]) expect(attemptFailedSuffix(code), `0x${code.toString(16)}`).toBe(' - unable to move to object');
    expect(attemptFailedSuffix(WeenieError.TheContainerIsClosed)).toBe(' - the container is closed');
    expect(Object.keys(ATTEMPT_FAILED_SUFFIX)).toHaveLength(9);
  });

  it('every other code — None, AttunedItem, SkillTooLow, 0x36 ± 1 — has none', () => {
    for (const code of [0, 0x1c, 0x1e, 0x21, 0x29, 0x2b, 0x35, 0x3a, 0x3ed, 0x3ef, WeenieError.AttunedItem, WeenieError.SkillTooLow]) {
      expect(attemptFailedSuffix(code), `0x${code.toString(16)}`).toBe('');
    }
  });

  it('every suffix code also has its own 0x1a HandleFailureEvent arm — retail printed BOTH lines', () => {
    for (const code of Object.keys(ATTEMPT_FAILED_SUFFIX).map(Number)) {
      expect(weenieErrorTextType(code), `0x${code.toString(16)}`).toBe(0x1a);
      expect(weenieErrorText(code), `0x${code.toString(16)}`).toBeTruthy();
    }
  });
});

/* ── the composed text ────────────────────────────────────────────────────── */

describe('CORE.17.k.c.a — attemptFailedText = verb line + suffix', () => {
  it('a carried item put into a closed chest (ACE Player_Inventory.cs:883 TheContainerIsClosed)', () => {
    expect(attemptFailedText(InventoryRequest.PutInContainer, WeenieError.TheContainerIsClosed, SWORD))
      .toBe("The Sword can't be put in the container - the container is closed");
  });

  it('a wield the server refuses with a code that has no suffix (Player_Inventory.cs:1660 wieldError) is the bare verb line', () => {
    expect(attemptFailedText(InventoryRequest.Wield, WeenieError.SkillTooLow, SWORD)).toBe("The Sword can't be wielded");
    expect(attemptFailedText(InventoryRequest.Drop, WeenieError.AttunedItem, SWORD)).toBe("The Sword can't be dropped");
  });

  it('nothing pending + a suffix code is the bare suffix; nothing pending + no suffix is the empty line', () => {
    expect(attemptFailedText(InventoryRequest.None, WeenieError.YoureTooBusy, SWORD)).toBe(" - you're too busy");
    expect(attemptFailedText(InventoryRequest.None, WeenieError.None, { name: 'Sink Tester', stackSize: 0 })).toBe('');
    expect(attemptFailedText(InventoryRequest.ShopEvent, WeenieError.None, SWORD)).toBe('');
  });
});

/* ── the tracker: prevRequest / prevRequestObjectID ───────────────────────── */

describe('CORE.17.k.c.a — InventoryRequestTracker (RecordRequest / RecordResponse)', () => {
  it('records one pending request, overwriting the previous', () => {
    const t = new InventoryRequestTracker();
    expect(t.pending).toBeNull();
    expect(t.isIdle).toBe(true);
    t.record(0x80000001, InventoryRequest.Drop, 12.5);
    expect(t.pending).toEqual({ objectId: 0x80000001, request: InventoryRequest.Drop, time: 12.5 });
    expect(t.isIdle).toBe(false);
    t.record(0x80000002, InventoryRequest.Wield, 13);
    expect(t.pendingObjectId).toBe(0x80000002);
    expect(t.pendingRequest).toBe(InventoryRequest.Wield);
  });

  it('respond() clears only for the pending object', () => {
    const t = new InventoryRequestTracker();
    t.record(0x80000001, InventoryRequest.Merge);
    expect(t.respond(0x80000009)).toBe(false);
    expect(t.pendingObjectId).toBe(0x80000001);
    expect(t.respond(0x80000001)).toBe(true);
    expect(t.pending).toBeNull();
    expect(t.respond(0x80000001)).toBe(false); // nothing pending: id 0 never matches a real guid
  });

  it('failedObjectId() is the pending object when one is, else the message guid (the 0x00A0 dispatch)', () => {
    const t = new InventoryRequestTracker();
    expect(t.failedObjectId(0x80000005)).toBe(0x80000005);
    t.record(0x80000001, InventoryRequest.Give);
    expect(t.failedObjectId(0)).toBe(0x80000001); // ACE QuestManager.cs:571 sends itemGuid 0 — the pending gift names itself
    expect(t.failedObjectId(0x80000005)).toBe(0x80000001);
  });
});

/* ── which GameAction records which request ───────────────────────────────── */

describe('CORE.17.k.c.a — classifyInventoryRequest mirrors the UIAttempt* recorders', () => {
  const ITEM = 0x80001111, PACK = 0x80002222, TARGET = 0x50003333;
  const stateOf = (states: Record<number, InventoryObjectState>) => (g: number): InventoryObjectState => states[g] ?? 'unknown';
  const contained = stateOf({ [ITEM]: 'contained' });
  const in3D = stateOf({ [ITEM]: 'in3D' });

  it('StackableMerge → Merge on the source stack', () => {
    expect(classifyInventoryRequest(GameActionType.StackableMerge, buildStackableMergePayload(ITEM, PACK, 5), contained))
      .toEqual({ objectId: ITEM, request: InventoryRequest.Merge });
  });

  it('StackableSplitToContainer / StackableSplitTo3D → Split; StackableSplitToWield records NOTHING (UIAttemptWield\'s split branch)', () => {
    expect(classifyInventoryRequest(GameActionType.StackableSplitToContainer, buildStackableSplitToContainerPayload(ITEM, PACK, 0, 5), contained))
      .toEqual({ objectId: ITEM, request: InventoryRequest.Split });
    expect(classifyInventoryRequest(GameActionType.StackableSplitTo3D, buildStackableSplitTo3DPayload(ITEM, 5), contained))
      .toEqual({ objectId: ITEM, request: InventoryRequest.Split });
    expect(classifyInventoryRequest(GameActionType.StackableSplitToWield, buildStackableSplitToWieldPayload(ITEM, 0x100000, 1), contained)).toBeNull();
  });

  it('GetAndWieldItem → Wield', () => {
    expect(classifyInventoryRequest(GameActionType.GetAndWieldItem, buildGetAndWieldItemPayload(ITEM, 1), contained))
      .toEqual({ objectId: ITEM, request: InventoryRequest.Wield });
  });

  it('GiveObjectRequest → Give on the GIVEN object (the payload\'s second guid, not the target)', () => {
    expect(classifyInventoryRequest(GameActionType.GiveObjectRequest, buildGiveObjectRequestPayload(TARGET, ITEM, 1), contained))
      .toEqual({ objectId: ITEM, request: InventoryRequest.Give });
  });

  it('DropItem → Move for an object in the 3D view, Drop for a carried one, nothing otherwise (UIAttemptPutIn3D)', () => {
    const w = new BinaryWriter(4); w.writeUInt32(ITEM);
    expect(classifyInventoryRequest(GameActionType.DropItem, w.toBuffer(), in3D)).toEqual({ objectId: ITEM, request: InventoryRequest.Move });
    expect(classifyInventoryRequest(GameActionType.DropItem, w.toBuffer(), contained)).toEqual({ objectId: ITEM, request: InventoryRequest.Drop });
    expect(classifyInventoryRequest(GameActionType.DropItem, w.toBuffer(), () => 'unknown')).toBeNull();
  });

  it('PutItemInContainer → PickUp for an object in the 3D view, PutInContainer for a carried one (UIAttemptPutInContainer)', () => {
    const p = buildPutItemInContainerPayload(ITEM, PACK, 0);
    expect(classifyInventoryRequest(GameActionType.PutItemInContainer, p, in3D)).toEqual({ objectId: ITEM, request: InventoryRequest.PickUp });
    expect(classifyInventoryRequest(GameActionType.PutItemInContainer, p, contained)).toEqual({ objectId: ITEM, request: InventoryRequest.PutInContainer });
    expect(classifyInventoryRequest(GameActionType.PutItemInContainer, p, () => 'unknown')).toBeNull();
  });

  it('other actions record nothing; a short payload never throws', () => {
    expect(classifyInventoryRequest(GameActionType.Jump, new Uint8Array(0), contained)).toBeNull();
    expect(classifyInventoryRequest(GameActionType.Use, buildGetAndWieldItemPayload(ITEM, 0), contained)).toBeNull();
    expect(classifyInventoryRequest(GameActionType.GetAndWieldItem, new Uint8Array(2), contained)).toEqual({ objectId: 0, request: InventoryRequest.Wield });
  });

  it('recordInventoryRequestFromAction writes the tracker (and leaves it alone for a non-request)', () => {
    const t = new InventoryRequestTracker();
    expect(recordInventoryRequestFromAction(t, GameActionType.Jump, new Uint8Array(0), contained)).toBeNull();
    expect(t.pending).toBeNull();
    recordInventoryRequestFromAction(t, GameActionType.PutItemInContainer, buildPutItemInContainerPayload(ITEM, PACK, 0), contained, 7);
    expect(t.pending).toEqual({ objectId: ITEM, request: InventoryRequest.PutInContainer, time: 7 });
  });
});

/* ── the 0x00A0 dispatch + ServerSaysAttemptFailed ────────────────────────── */

describe('CORE.17.k.c.a — handleAttemptFailed (the dispatch @ :339948 + ServerSaysAttemptFailed)', () => {
  const ITEM = 0x80001111, OTHER = 0x80009999, PLAYER = 0x50000001;
  const objects: Record<number, { name: string; pluralName?: string; stackSize?: number }> = {
    [ITEM]: SWORD, [OTHER]: ARROWS, [PLAYER]: { name: 'Sink Tester', stackSize: 0 },
  };
  const resolve = (g: number) => objects[g];

  it('the pending object\'s line, displayed, and the pending request cleared', () => {
    const t = new InventoryRequestTracker();
    t.record(ITEM, InventoryRequest.PutInContainer);
    const shown: string[] = [];
    const out = handleAttemptFailed(t, ITEM, WeenieError.TheContainerIsClosed, resolve, (s) => shown.push(s));
    expect(out).toEqual({ objectId: ITEM, request: InventoryRequest.PutInContainer, text: "The Sword can't be put in the container - the container is closed", cleared: true });
    expect(shown).toEqual(["The Sword can't be put in the container - the container is closed"]);
    expect(t.pending).toBeNull();
  });

  it('a pending request wins over the message guid (prevRequestObjectID != 0 → that object)', () => {
    const t = new InventoryRequestTracker();
    t.record(ITEM, InventoryRequest.Give);
    const shown: string[] = [];
    const out = handleAttemptFailed(t, 0, WeenieError.YouHaveSolvedThisQuestTooRecently, resolve, (s) => shown.push(s));
    expect(out.objectId).toBe(ITEM);
    expect(shown).toEqual(["The Sword can't be given"]);
    expect(t.pending).toBeNull();
    t.record(ITEM, InventoryRequest.Wield);
    expect(handleAttemptFailed(t, OTHER, WeenieError.SkillTooLow, resolve, () => {}).text).toBe("The Sword can't be wielded");
  });

  it('nothing pending: the message guid names the line; a None code on the player is an empty line = nothing, and nothing to clear', () => {
    const t = new InventoryRequestTracker();
    const shown: string[] = [];
    let out = handleAttemptFailed(t, PLAYER, WeenieError.None, resolve, (s) => shown.push(s));
    expect(out).toEqual({ objectId: PLAYER, request: InventoryRequest.None, text: null, cleared: false });
    expect(shown).toEqual([]);
    out = handleAttemptFailed(t, ITEM, WeenieError.YoureTooBusy, resolve, (s) => shown.push(s));
    expect(out.text).toBe(" - you're too busy");
    expect(shown).toEqual([" - you're too busy"]);
  });

  it('an object the client cannot resolve: no line, and the pending request stays (retail skips the null weenie object)', () => {
    const t = new InventoryRequestTracker();
    t.record(0x80007777, InventoryRequest.Drop);
    const shown: string[] = [];
    const out = handleAttemptFailed(t, 0x80007777, WeenieError.ActionCancelled, resolve, (s) => shown.push(s));
    expect(out).toEqual({ objectId: 0, request: InventoryRequest.Drop, text: null, cleared: false });
    expect(shown).toEqual([]);
    expect(t.pendingObjectId).toBe(0x80007777);
  });

  it('the seven dispatch-excluded codes still get the verb line; their templated texts are the 0x028B message\'s, not this event\'s', () => {
    const t = new InventoryRequestTracker();
    for (const code of ATTEMPT_FAILED_NAME_TEMPLATED) {
      t.record(ITEM, InventoryRequest.Give);
      const out = handleAttemptFailed(t, ITEM, code, resolve, () => {});
      expect(out.text, `0x${code.toString(16)}`).toBe("The Sword can't be given");
      expect(attemptFailedSuffix(code)).toBe('');
    }
  });
});

/* ── acclient.exe: the literals and the jump table ────────────────────────── */

describe.skipIf(!existsSync(EXE))('CORE.17.k.c.a — the templates and suffixes are acclient.exe\'s .rdata literals', () => {
  let exe: Buffer;
  const RDATA_VA = 0x792000, RDATA_OFF = 0x392000, TEXT_VA = 0x401000, TEXT_OFF = 0x1000;
  const wstr = (va: number): string => {
    let o = va - RDATA_VA + RDATA_OFF; let s = '';
    for (;;) { const c = exe.readUInt16LE(o); if (c === 0) break; s += String.fromCharCode(c); o += 2; }
    return s;
  };
  beforeAll(() => { exe = readFileSync(EXE); });

  it('the eight sprintf templates, in jump-table order Merge … Wield, Give', () => {
    expect(wstr(0x7e42f8)).toBe(ATTEMPT_FAILED_VERB[InventoryRequest.Merge]!.template);
    expect(wstr(0x7e42cc)).toBe(ATTEMPT_FAILED_VERB[InventoryRequest.Split]!.template);
    expect(wstr(0x7e42a0)).toBe(ATTEMPT_FAILED_VERB[InventoryRequest.Move]!.template);
    expect(wstr(0x7e426c)).toBe(ATTEMPT_FAILED_VERB[InventoryRequest.PickUp]!.template);
    expect(wstr(0x7e4220)).toBe(ATTEMPT_FAILED_VERB[InventoryRequest.PutInContainer]!.template);
    expect(wstr(0x7e41ec)).toBe(ATTEMPT_FAILED_VERB[InventoryRequest.Drop]!.template);
    expect(wstr(0x7e41bc)).toBe(ATTEMPT_FAILED_VERB[InventoryRequest.Wield]!.template);
    expect(wstr(0x7e4190)).toBe(ATTEMPT_FAILED_VERB[InventoryRequest.Give]!.template);
  });

  it('the jump table @ 0x58ee84: 9 entries, index prevRequest − 1, entry 7 (ShopEvent) is the no-verb default', () => {
    const tbl = 0x58ee84 - TEXT_VA + TEXT_OFF;
    const targets = Array.from({ length: 9 }, (_, i) => exe.readUInt32LE(tbl + 4 * i));
    expect(targets[7]).toBe(0x58eca3); // switchD_0058eb4a_caseD_8
    expect(new Set(targets).size).toBe(9);
    // dec eax; cmp eax,8; ja default — the index is prevRequest − 1
    const at = 0x58eb40 - TEXT_VA + TEXT_OFF;
    expect(exe[at]).toBe(0x48); // dec eax
    expect([exe[at + 1], exe[at + 2], exe[at + 3]]).toEqual([0x83, 0xf8, 0x08]); // cmp eax,8
  });

  it('the suffix literals', () => {
    expect(wstr(0x7e40c4)).toBe(ATTEMPT_FAILED_SUFFIX[0x1d]);
    expect(wstr(0x7e40f0)).toBe(ATTEMPT_FAILED_SUFFIX[0x20]);
    expect(wstr(0x7e4138)).toBe(ATTEMPT_FAILED_SUFFIX[0x28]);
    expect(wstr(0x7e4090)).toBe(ATTEMPT_FAILED_SUFFIX[0x2a]);
    expect(wstr(0x7e4068)).toBe(ATTEMPT_FAILED_SUFFIX[0x36]);
    expect(wstr(0x7e4030)).toBe(ATTEMPT_FAILED_SUFFIX[0x37]);
    expect(wstr(0x7e3ff8)).toBe(ATTEMPT_FAILED_SUFFIX[0x3ee]);
  });

  it('the "one item at a time" gate text IsPlayerReadyToMakeInventoryRequest prints is in .rdata (ported by CORE.17.k.c.a.a — verify-core17kcaa-inventory-request-gate.ts)', () => {
    const hay = exe.subarray(RDATA_OFF, RDATA_OFF + 0x773a6).toString('utf16le');
    expect(hay).toContain('You can only move or use one item at a time');
  });
});

/* ── real GameUI in happy-dom: two spew rows for a closed chest, none for a vendor reject ── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('CORE.17.k.c.a — real GameUI: the attempt line and the code\'s own arm are two spew rows; a vendor reject draws nothing', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) g[key] = key === 'window' ? domWindow : domWindow[key];
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function stubLayoutRenderer(ui: any): void {
    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div') as HTMLElement;
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const getOrCreate = (id: number): HTMLElement => {
        let el = elements.get(id);
        if (!el) { el = domWindow.document.createElement('div') as HTMLElement; root.appendChild(el); elements.set(id, el); }
        return el;
      };
      return {
        root,
        elements: { get: (id: number) => getOrCreate(id), set: () => {} },
        setText: () => {}, setInteractive: () => {}, setState: () => {},
        setVisible: () => {}, setFill: () => {}, setPalette: () => {},
        setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
        close: () => { root.remove(); }, destroy: () => { root.remove(); },
      };
    };
    ui.getTexURL = () => null;
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      getTextureDataURLWithAlpha: () => null,
    };
  }

  function makeUI() {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    stubLayoutRenderer(ui);
    ui.showGame();
    const rows = () => [...container.querySelectorAll('#hud-spew-box .spew-item')].map((r) => (r as HTMLElement).textContent);
    const chat = () => (container.querySelector('#chat-messages') as HTMLElement).textContent ?? '';
    return { ui, rows, chat };
  }

  /** The onInventoryServerSaveFailed flow: the attempt line, then the code's sink unless excluded. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function dispatch(ui: any, t: InventoryRequestTracker, guid: number, code: number, resolve: (g: number) => { name: string; stackSize?: number } | undefined) {
    const attempt = handleAttemptFailed(t, guid, code, resolve, (s) => ui.displayErrorText(s));
    const delivery = ATTEMPT_FAILED_NAME_TEMPLATED.has(code) ? { sink: 'none' as const } : deliverWeenieError(ui, code, weenieErrorText(code));
    return { attempt, delivery };
  }

  it('a carried Sword put into a closed chest: "The Sword can\'t be put in the container - the container is closed" then "The container is closed!"', () => {
    const { ui, rows, chat } = makeUI();
    const t = new InventoryRequestTracker();
    t.record(0x80001111, InventoryRequest.PutInContainer);
    const { delivery } = dispatch(ui, t, 0x80001111, WeenieError.TheContainerIsClosed, (g) => (g === 0x80001111 ? SWORD : undefined));
    expect(delivery.sink).toBe('spew');
    expect(rows()).toEqual(["The container is closed!", "The Sword can't be put in the container - the container is closed"]);
    expect(chat()).not.toContain("can't be put");
    expect(t.pending).toBeNull();
  });

  it('a vendor buy the server rejects (the player\'s guid, code None, nothing pending): no row, no chat line', () => {
    const { ui, rows, chat } = makeUI();
    const t = new InventoryRequestTracker();
    const { attempt, delivery } = dispatch(ui, t, 0x50000001, WeenieError.None, (g) => (g === 0x50000001 ? { name: 'Sink Tester', stackSize: 0 } : undefined));
    expect(attempt.text).toBeNull();
    expect(delivery.sink).toBe('none');
    expect(rows()).toEqual([]);
    expect(chat()).not.toMatch(/vendor|transaction/i);
  });

  it('a refused wield (SkillTooLow, no arm): the bare verb line and nothing else', () => {
    const { ui, rows } = makeUI();
    const t = new InventoryRequestTracker();
    t.record(0x80001111, InventoryRequest.Wield);
    const { delivery } = dispatch(ui, t, 0x80001111, WeenieError.SkillTooLow, () => SWORD);
    expect(delivery.sink).toBe('none');
    expect(rows()).toEqual(["The Sword can't be wielded"]);
  });
});
