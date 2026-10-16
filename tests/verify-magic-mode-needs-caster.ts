/**
 * BUG.arcanist-magic-mode-no-caster (2026-10-16) — Claude Arcanist, with no
 * wand, staff or orb wielded, stood in magic stance with no spell bar and sent
 * ChangeCombatMode Magic before every buff. The end-of-retail client never asks
 * for that: ClientCombatSystem::SetCombatMode @ 0056be30 runs
 * CompatibleCombatMode @ 0056a580 on every client request, and magic needs a
 * Held caster (0x1000000). ACE answers a forced request with NonCombat
 * (Player_Combat.cs HandleActionChangeCombatMode_Inner, caster == null) and
 * then casts anyway in the magic stance (Player_Magic.cs, LastCombatMode).
 * The 1999 client.exe (UI::SetCombatMode @ 0x4d04c0) lets a bare-handed mage
 * into magic mode and refuses only melee / missile while a Held item is
 * wielded. The spell bar itself follows the HUD's combat mode, whatever route
 * set it (the server's CombatMode property included).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CombatMode, EquipMask } from '../packages/shared/src/index.js';
import { compatibleCombatMode, combatModeRefusalReason, incompatibleCombatModeRefusal } from '../packages/renderer/src/controllers/CombatModeChange.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost } from './_harness/agentFake.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { parseMasterProperty, setMasterPropertyTypes, parseStringTable, registerStringTable } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { openDat } from './_harness/dat.js';

const HELD = EquipMask.Held, MELEE = EquipMask.MeleeWeapon, MISSILE = EquipMask.MissileWeapon;

describe('CompatibleCombatMode by era', () => {
  it('end of retail (and the classic eras, same exe): magic only with a Held caster', () => {
    for (const id of ['eor', 'classicace-customdm', 'classic-dereth']) expect(eraClientRules(eraProfile(id)).combatModeCheck).toBe('eor');
    expect(compatibleCombatMode(CombatMode.Magic, 0, 'eor')).toBe(false);
    expect(compatibleCombatMode(CombatMode.Magic, EquipMask.Shield, 'eor')).toBe(false);
    expect(compatibleCombatMode(CombatMode.Magic, HELD, 'eor')).toBe(true);
    expect(incompatibleCombatModeRefusal(CombatMode.Magic, 0, null, 'eor')).toEqual({ text: null }); // silent: no ready weapon
    expect(incompatibleCombatModeRefusal(CombatMode.Magic, MELEE, 'Flaming Tachi', 'eor'))
      .toEqual({ text: "You can't enter magic mode while wielding the Flaming Tachi" });
  });

  it('1999: magic bare-handed is fine; melee / missile are refused only while a Held item is wielded', () => {
    expect(eraClientRules(eraProfile('ac1999-retail')).combatModeCheck).toBe('ac1999');
    expect(compatibleCombatMode(CombatMode.Magic, 0, 'ac1999')).toBe(true);
    expect(compatibleCombatMode(CombatMode.Magic, MELEE, 'ac1999')).toBe(true);
    expect(compatibleCombatMode(CombatMode.Melee, HELD, 'ac1999')).toBe(false);
    expect(compatibleCombatMode(CombatMode.Missile, HELD, 'ac1999')).toBe(false);
    expect(compatibleCombatMode(CombatMode.Missile, 0, 'ac1999')).toBe(true);
    expect(incompatibleCombatModeRefusal(CombatMode.Melee, HELD, 'Wand', 'ac1999'))
      .toEqual({ text: "You can't enter combat mode while wielding the Wand" });
  });

  it("the automation's reason names the missing caster", () => {
    expect(combatModeRefusalReason(CombatMode.Magic, 0, null, 'eor')).toMatch(/magic mode needs a wielded wand, staff or orb, and none is wielded.*wield one first/);
    expect(combatModeRefusalReason(CombatMode.Magic, HELD, 'Orb', 'eor')).toBeNull();
    expect(combatModeRefusalReason(CombatMode.Magic, 0, null, 'ac1999')).toBeNull();
    expect(combatModeRefusalReason(CombatMode.Missile, MELEE, 'Tachi', 'eor')).toBe("You can't enter missile mode while wielding the Tachi");
  });
});

describe('the agent never asks for a magic mode the client refuses', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // The real reason function over a bare-handed end-of-retail mage.
    (host as unknown as { combatModeRefusal: (m: string) => string | null }).combatModeRefusal = (m) =>
      m === 'magic' ? combatModeRefusalReason(CombatMode.Magic, 0, null, 'eor') : null;
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a buff with no caster wielded is refused with the reason, and neither a mode change nor a cast goes out', async () => {
    host.me.combatMode = 'peace';
    const r = await api.cast('Heal Self I', 'self');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Heal Self I not cast: magic mode needs a wielded wand, staff or orb/);
    expect(host.sent.filter((s) => s.startsWith('mode') || s.startsWith('cast'))).toEqual([]);
  });

  it('combat_mode magic says why; peace still goes', () => {
    const r = api.combatMode('magic');
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/^can't switch to magic mode: magic mode needs a wielded wand/);
    expect(api.combatMode('peace')).toMatchObject({ ok: true });
    expect(host.sent).toEqual(['mode peace']);
  });

  it('already in magic mode (a caster wielded), the cast goes out as before', async () => {
    host.me.combatMode = 'magic';
    const p = api.cast('Heal Self I', 'self');
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.sent).toContain('cast 6 self');
    api.pushChat('You cast Heal Self I and restore 12 points of your health.', 0x11);
    await vi.advanceTimersByTimeAsync(9000);
    await p;
  });
});

describe("observe's gear line names a missing caster where the era needs one", () => {
  const casterLine = (host: FakeHost): string | undefined => formatObservation(new AgentApi(host).observe()).split('\n').find((l) => /wand, staff or orb/.test(l));
  const mage = (needsCaster: boolean): FakeHost => {
    const host = new FakeHost();
    const h = host as unknown as Record<string, unknown>;
    h.skillList = () => [{ id: 34, name: 'War Magic', training: 'specialized', base: 220, buffed: 230 }];
    h.magicNeedsCaster = () => needsCaster;
    host.inv = [{ guid: 0x80000001, name: 'Cup', where: 'main pack', itemType: 0x800 }, { guid: 0x80000002, name: 'Flaming Tachi', where: 'main pack', itemType: 0x1 }];
    return host;
  };
  it('end of retail, none owned: "buy one"; with an Orb in the pack: "wield it"; wielded or 1999: nothing', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = mage(true);
    expect(casterLine(h)).toMatch(/^gear: no wand, staff or orb wielded: you can't enter magic mode or cast without one; you carry none: buy one/);
    h.inv.push({ guid: 0x80000003, name: 'Orb', where: 'main pack', itemType: 0x8000 });
    expect(casterLine(h)).toMatch(/Orb is in your pack: wield it \(ac_equip Orb\)$/);
    h.inv[2] = { ...h.inv[2]!, where: 'equipped', mask: 0x1000000 };
    expect(casterLine(h)).toBeUndefined();
    expect(casterLine(mage(false))).toBeUndefined();
    vi.restoreAllMocks();
  });
});

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const LANG_DAT = resolve(ROOT, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle'] as const;

describe.skipIf(!hasDats)('the spell bar follows the combat mode, whatever set it (real GameUI)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  beforeAll(async () => {
    const domWindow = await loadDomWindow();
    installDomGlobals(domWindow, DOM_GLOBALS as never, saved);
    const portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    for (const id of [0x23000001, 0x23000002, 0x23000003, 0x23000005, 0x2300000d]) registerStringTable(parseStringTable(langDb.getReader(id)));
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const layoutRenderer = new LayoutRenderer(langDb, new UITextureLoader(new TextureManager(portalDb)));
    layoutRenderer.getTextureDataURLWithAlpha = () => null;
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container, {}, portalDb, undefined, undefined, undefined, null, layoutRenderer);
    ui.showGame();
  });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS as never, saved); });

  it('the server\'s CombatMode (the HUD state main.ts sets from it) shows the bar in magic and hides it in peace, empty tabs included', () => {
    const bar = (): HTMLElement => ui.spellBarPanelEl as HTMLElement;
    ui.hudState.combatMode = CombatMode.NonCombat;
    ui.updateHUD();
    expect(bar().style.display).toBe('none');
    ui.hudState.combatMode = CombatMode.Magic; // no favourites: retail still shows the bar with its empty tabs
    ui.updateHUD();
    expect(bar().style.display).toBe('block');
    ui.hudState.combatMode = CombatMode.NonCombat;
    ui.updateHUD();
    expect(bar().style.display).toBe('none');
  });
});
