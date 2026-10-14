/**
 * Mag-Tools in the game (docs/plugin-specs/magtools.md; the rules live in @ac/shared magtools/):
 * `/mt` over the agent API, so every action takes the client's own path, and the item info
 * line printed when you identify something. Rebuilt from Mag-Tools' behaviour (LGPL; facts only).
 *
 * Preview UI for now (GameUI.setPreviewFeatures; Jake, 2026-10-12): a player not on the preview
 * list gets neither `/mt` nor the ident lines, so retail's chat is unchanged for them.
 *
 * Ours, where the client differs: the vendor commands add to our vendor path, which buys or sells
 * at once (`/mt vendor addbuy` buys; `buy` / `clearbuy` have nothing left to do).
 */
import { MtCombatParser, MtCombatTracker, MtManaTracker, MtCommands, MtIdentWatcher, MtOptions, type MtCombatSnapshot, type MtManaReads, mtItemInfoLine, mtLootVerdict, mtPrintsItem, type LootRule, type MtHost, type MtItemData, type MtObject, type MtOptionStorage, type MtSpellInfo } from '@ac/shared';
import { MtAutopacker, MtAutoTradeAccept, MtAutoTradeAdd, MtChatFilter, MtLoginCommands, mtAutopackPlacement, mtAutopackRulePacks, mtEnabledFilters, mtHidesStatusText, mtIsAutopackTrigger, mtLogOutOnDeath, mtMinuteOfDay, mtOneTouchHeal, mtOpenMainPackOnLogin, mtTradeRuleVerdict, readMtTradeWhitelist, writeMtTradeWhitelist, type MtChatLine, type MtKeepPacks, type MtPackItem, type MtSenderClass, type MtTradeVerdict } from '@ac/shared';
import type { AgentApi } from '../AgentApi.ts';
import { lootRuleFor, needsExamination, type ItemProps } from '../RoutineEngine.ts';
import { decalObjectClass } from '../decalObjectClass.ts';
import { ChatMessageType, MtChatLogger, MtCommandLists, MtCorpseTracker, MtInventoryTracker, MtPlayerTracker, mtCopyInventoryInfo, mtIsIncantation, mtItemInfo, mtLine, type MtCommandScope, type MtInventoryExportItem, type MtInventoryToolItem, type MtTextStore } from '@ac/shared';
import type { VhsHotkey } from '../../ui/automation/vhsHotkeys.ts';

/** What `/mt` and the ident lines need beyond the agent API (main.ts). */
export interface MagToolsExtras {
  /** A chat line: Mag-Tools' general lines in chat colour 5 (System), item info in 14 (`ident`). */
  print(text: string, ident?: boolean): void;
  /** The open container (a chest, corpse or pack) and what it holds. */
  openContainer(): { guid: number; name: string; items: Array<{ guid: number; name: string }> } | null;
  /** A spell's name, family (Category) and difficulty (Power) from the era's SpellTable. */
  spell(id: number): { name: string; family: number; difficulty: number; offensive: boolean } | null;
  /** An object's ItemType and ObjectDescriptionFlags (for Decal's ObjectClass). */
  classOf(guid: number): { itemType: number; flags: number } | null;
  /** The loot rules in use (the running routine's, else the VirindiTank window's profile), or null when none is loaded. */
  lootRules(): LootRule[] | null;
  /** The selected object (any way it was selected: the world, a pack, the toolbar), or null. */
  selectedGuid(): number | null;
  /** Whether this account has preview UI (Mag-Tools is gated with the bar). */
  enabled(): boolean;
  /** Your character's name (the combat tracker's "me"), and the key the persistent stats are kept under. */
  me(): string;
  who(): string;
  /** Worn items and your enchantments for the mana tracker. */
  manaReads: MtManaReads;
  /** Ask quietly for the appraisals of worn items not yet appraised (Mag-Tools ids its worn items for the mana tracker). */
  appraiseWorn?(): void;
  /** Where the persistent combat stats live (per character). */
  combatStore?(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } | null;
  /** The account and server: the On Login / Periodic lists are kept per account + server + character (Tools → Character) and per server (Tools → Server). */
  account?(): string;
  server?(): string;
  /** The character entered (known at login, before the player's description names it). */
  character?(): string;
  /** A line sent as if typed in chat (the login and periodic commands that aren't `/mt`). */
  sendChat?(line: string): void;
  /** The loot sets of the routine document in use: Autopack's `<Character>.AutoPack` / `Default.AutoPack`, Auto Add To Trade's `<Partner>`. */
  lootSets?(): Record<string, LootRule[]> | null;
  /**
   * Re-check the stored routine document before an action of the player's reads the loot sets (it may have
   * changed in another tab, or by Claude through the connector): a promise to wait for, or null when there is
   * nothing to wait for. GameUI.automationRefreshStored.
   */
  freshenRoutines?(): Promise<unknown> | null;
  /** VirindiTank's tidy has a move out: Autopack waits so their moves never cross. */
  tidyBusy?(): boolean;
  /** An object in the world (the corpse and player trackers): its name, Decal ObjectClass, place (cell-local metres) and burden. */
  object?(guid: number): { name: string; objectClass: number; cell: number; x: number; y: number; z: number; burden?: number } | null;
  /** A carried item's icon, whole-stack value, stack size and wielded location (Inv. Items, Tools → Inventory). */
  itemDetails?(guid: number): { icon?: number; value?: number; stackSize?: number; wieldedLocation?: number } | null;
  /** An item's appraisal when one has arrived (Tools → Inventory's item-info strings). */
  appraisal?(guid: number): Omit<MtAppraisal, 'name'> | null;
  /** The era's spell power words (SpellComponentTable components' Text): the chat logger skips incantations. */
  spellWords?(): ReadonlySet<string>;
  /** Write the clipboard (Tools → Inventory's copy); rejects when the browser refuses. */
  writeClipboard?(text: string): Promise<void>;
}

export { mtOptionWired } from './mtWired.ts';

/** A speech line's sender as the chat filters see it, from Decal's ObjectClass of the sender (24 Player, 25 Vendor, 5 Monster, 37 Npc). */
export function mtSenderClass(objectClass: number | null): MtSenderClass | null {
  if (objectClass === null) return null;
  return objectClass === 24 ? 'player' : objectClass === 25 ? 'vendor' : objectClass === 5 ? 'monster' : objectClass === 37 ? 'npc' : 'other';
}

/** A loot set by name, any case, with or without `.utl`. */
function lootSetNamed(sets: Record<string, LootRule[]> | null | undefined, name: string): LootRule[] | null {
  if (!sets || !name) return null;
  const want = name.toLowerCase().replace(/\.utl$/, '');
  const k = Object.keys(sets).find((n) => n.toLowerCase().replace(/\.utl$/, '') === want);
  return k ? sets[k]! : null;
}

/** An appraisal as main.ts receives it (IdentifyResponseData's property maps). */
export interface MtAppraisal {
  guid: number;
  name: string;
  int: Record<number, number>;
  float: Record<number, number>;
  bool: Record<number, boolean>;
  string: Record<number, string>;
  did: Record<number, number>;
  spellIds: number[];
  activeSpellIds: number[];
}

const kindOf = (k: string): MtObject['kind'] => (k === 'npc' || k === 'vendor' || k === 'portal' || k === 'monster' || k === 'player' || k === 'item' ? k : 'other');

/** `/mt`'s game side over the agent API. */
export function createMtHost(api: AgentApi, x: MagToolsExtras): MtHost {
  const fire = (p: unknown) => { void Promise.resolve(p).catch(() => {}); };
  return {
    inventory: () => api.inventory().map((i) => ({ id: i.guid, name: i.name, kind: 'item', equipped: i.where === 'equipped' })),
    openContainer: () => {
      const c = x.openContainer();
      return c ? { id: c.guid, name: c.name, items: c.items.map((i) => ({ id: i.guid, name: i.name, kind: 'item' as const })) } : null;
    },
    landscape: () => api.nearby(300).map((o) => ({ id: o.guid, name: o.name, kind: kindOf(o.kind) })),
    spells: () => api.spells('', 100000).map((s) => ({ id: s.id, name: s.name })),
    select: (id) => { api.select(id); },
    use: (id) => fire(api.use(id)),
    useOn: (item, target) => { api.useOn(item, target); },
    give: (item, target) => fire(api.give(item, target, null)),
    drop: (item) => fire(api.drop(item)),
    cast: (id, target) => fire(api.cast(id, target)),
    combatState: (s) => { api.combatMode(s); },
    face: (deg) => { api.turn(deg); },
    logout: () => { api.logout(); },
    clickDialog: (b) => api.dialog(b === 'ok' ? 'OK' : b === 'yes' ? 'Yes' : 'No').ok,
    fellowship: ((action: string, arg?: string | number) => fire(api.fellowship(action, arg === undefined ? undefined : String(arg)))) as MtHost['fellowship'],
    trade: ((action: string, id?: number) => { api.trade(action === 'end' ? 'close' : action, id ?? null); }) as MtHost['trade'],
    vendor: () => { const v = api.vendorData(); return v ? { items: v.items.map((i) => ({ id: i.guid, name: i.name, kind: 'item' as const })) } : null; },
    vendorAddBuy: (id, count) => { api.buy(id, count); },
    vendorAddSell: (id) => fire(api.sell(id)),
    vendorAction: () => { /* our vendor path completes each add at once */ },
  };
}

/** Mag-Tools' settings in this browser (Mag-Tools keeps one global file). */
export function browserMtStorage(): MtOptionStorage {
  const KEY = 'acjs.magtools.options';
  // Parsed once per stored text: the chat filters read every Filters.* option for each chat line.
  let lastRaw: string | null | undefined;
  let lastParsed: Record<string, string> = {};
  const read = (): Record<string, string> => {
    let raw: string | null = null;
    try { raw = globalThis.localStorage?.getItem(KEY) ?? null; } catch { return {}; }
    if (raw !== lastRaw) { lastRaw = raw; try { lastParsed = JSON.parse(raw ?? '{}') as Record<string, string>; } catch { lastParsed = {}; } }
    return { ...lastParsed };
  };
  return {
    get: (k) => read()[k],
    set: (k, v) => { const all = read(); all[k] = v; try { globalThis.localStorage?.setItem(KEY, JSON.stringify(all)); } catch { /* storage blocked */ } },
  };
}

export class MagToolsRuntime {
  readonly options: MtOptions;
  readonly commands: MtCommands;
  private readonly ident = new MtIdentWatcher();
  /** The selection already stamped for the ident watcher. */
  private stamped: number | null = null;

  constructor(private readonly api: AgentApi, readonly x: MagToolsExtras, private readonly storage: MtOptionStorage = browserMtStorage(), private readonly now: () => number = () => performance.now(), private readonly clock: () => Date = () => new Date()) {
    this.options = new MtOptions(storage);
    this.commands = new MtCommands(createMtHost(api, x), this.options);
    this.mana = new MtManaTracker(x.manaReads);
    this.combat = { current: new MtCombatTracker(() => x.me(), () => Date.now()), persistent: new MtCombatTracker(() => x.me(), () => Date.now()) };
    this.parser = new MtCombatParser({ me: () => x.me() });
    this.filter = new MtChatFilter({ me: () => x.me() });
    const character = () => x.character?.() || x.me();
    this.loginCommands = new MtLoginCommands({
      characterScope: () => ({ account: x.account?.() ?? '', server: x.server?.() ?? '', character: character() }),
      serverScope: () => ({ server: x.server?.() ?? '' }),
      store: storage,
      runMt: (c) => { this.chat(c); },
      sendChat: (c) => x.sendChat?.(c),
    });
    this.autopacker = new MtAutopacker({
      items: () => this.packItems(),
      packs: () => api.packs().map((p) => ({ index: p.slot, id: p.guid >>> 0, capacity: p.capacity, count: p.count })),
      hasProfile: () => this.autopackRules() !== null,
      keepPacks: (i) => this.keepPacks(i),
      place: (id, to) => api.placeItem(id, 'pack' in to ? { packSlot: to.pack } : { onto: to.onto }).ok,
      appraise: (id) => { void api.appraise(id, { quiet: true }); },
      print: (t) => x.print(mtLine(t)),
      busy: () => x.tidyBusy?.() ?? false,
    }, now);
    this.tradeAdd = new MtAutoTradeAdd({
      inventory: () => api.inventory().map((i) => ({ id: i.guid >>> 0, name: i.name, equipped: i.where === 'equipped' })),
      profile: (partner) => {
        const rules = lootSetNamed(x.lootSets?.(), partner);
        return rules ? (item) => this.tradeVerdict(rules, item.id) : null;
      },
      add: (id) => { api.trade('add', id); },
      appraise: (id) => { void api.appraise(id, { quiet: true }); },
      print: (t) => x.print(mtLine(t)),
    }, now);
    this.tradeAccept = new MtAutoTradeAccept(now);
    this.corpses = new MtCorpseTracker({ me: () => x.me(), options: this.options, store: () => this.textStore('corpses'), fellows: () => api.fellowshipInfo()?.members ?? [] });
    this.players = new MtPlayerTracker({ me: () => x.me(), options: this.options, store: () => this.textStore('players') });
    this.inventoryTracker = new MtInventoryTracker();
    this.chatLogger = new MtChatLogger({
      settings: storage,
      persistent: () => this.options.bool('ChatLogger.Persistent'),
      store: () => this.textStore('chatlog'),
      isIncantation: (text) => { const w = x.spellWords?.(); return !!w && mtIsIncantation(text, w); },
    });
    this.commandLists = new MtCommandLists(storage);
  }

  // ─── Trackers, chat logger, Tools tab ───

  readonly corpses: MtCorpseTracker;
  readonly players: MtPlayerTracker;
  readonly inventoryTracker: MtInventoryTracker;
  readonly chatLogger: MtChatLogger;
  /** Tools → Character / Server's editors over the lists the login scheduler reads (the same mtCommandListKey keys). */
  readonly commandLists: MtCommandLists;
  private invSig = '';
  private invCheckedAt = -Infinity;

  /** A per server + character text store in browser storage (the trackers' and the chat log's persistent copies). */
  private textStore(kind: string): MtTextStore | null {
    const ls = this.x.combatStore?.();
    if (!ls) return null;
    const key = `acjs.magtools.${kind}.${this.x.who()}`;
    return { get: () => ls.getItem(key), set: (v) => ls.setItem(key, v), remove: () => ls.removeItem(key) };
  }

  /** A tracker row click: select that object. */
  selectObject(id: number): void { this.api.select(id >>> 0); }

  /** Tools → Character's scope (account + server + character), null before a character is in the world. */
  characterScope(): MtCommandScope | null {
    const c = this.x.character?.() || this.x.me();
    return c ? { account: this.x.account?.() ?? '', server: this.x.server?.() ?? '', character: c } : null;
  }
  /** Tools → Server's scope. */
  serverScope(): MtCommandScope | null {
    return this.characterScope() ? { server: this.x.server?.() ?? '' } : null;
  }

  /** An object was created or moved: corpses and players for the trackers. A heavy corpse is appraised quietly (my kill?). */
  objectSeen(guid: number): void {
    if (!this.x.enabled()) return;
    const o = this.x.object?.(guid >>> 0);
    if (!o) return;
    if (o.objectClass === 27) {
      if (this.corpses.seen({ id: guid >>> 0, name: o.name, cell: o.cell, x: o.x, y: o.y, z: o.z, ...(o.burden !== undefined ? { burden: o.burden } : {}), appraised: false }) === 'appraise') void this.api.appraise(guid >>> 0, { quiet: true });
    } else if (o.objectClass === 24) {
      this.players.seen({ id: guid >>> 0, name: o.name, cell: o.cell, x: o.x, y: o.y, z: o.z });
    }
  }

  /** Any appraisal arrived (quiet ones too): a corpse's LongDesc ("Killed by <name>.") for the corpse tracker. */
  objectAppraised(guid: number, longDesc: string | null): void {
    if (!this.x.enabled()) return;
    const o = this.x.object?.(guid >>> 0);
    if (!o || o.objectClass !== 27) return;
    this.corpses.seen({ id: guid >>> 0, name: o.name, cell: o.cell, x: o.x, y: o.y, z: o.z, ...(o.burden !== undefined ? { burden: o.burden } : {}), appraised: true, longDesc });
  }

  /** A container's contents arrived (you opened it): a tracked corpse is done with. */
  containerOpened(guid: number): void { if (this.x.enabled()) this.corpses.opened(guid >>> 0); }

  /** An object left your view or was destroyed, `distance` metres away (a corpse decaying within 10 m). */
  objectReleased(guid: number, distance: number): void { if (this.x.enabled()) this.corpses.released(guid >>> 0, distance); }

  /** Inv. Items: the whole inventory, when it has changed (checked once a second from the tick). */
  private trackInventory(): void {
    const t = this.now();
    if (t - this.invCheckedAt < 1000) return;
    this.invCheckedAt = t;
    const items = this.api.itemSlots().map((s) => {
      const cls = this.x.classOf(s.guid);
      const d = this.x.itemDetails?.(s.guid);
      return { id: s.guid >>> 0, name: s.name, objectClass: cls ? decalObjectClass(cls.itemType, cls.flags) : 0, stackSize: d?.stackSize ?? s.stack, ...(d?.icon !== undefined ? { icon: d.icon } : {}), ...(d?.value !== undefined ? { value: d.value } : {}) };
    });
    const sig = items.map((i) => `${i.id}:${i.stackSize}:${i.value ?? ''}`).join('|');
    if (sig === this.invSig) return;
    this.invSig = sig;
    this.inventoryTracker.update(items);
  }

  /** The chat log's export name (upstream's `<Character>.ChatLogger.txt`). */
  chatLogFileName(): string { return `${this.x.character?.() || this.x.me() || 'Character'}.ChatLogger.txt`; }

  private infoOf(guid: number, name: string): { info: string; appraised: boolean; objectClass: number } {
    const cls = this.x.classOf(guid);
    const objectClass = cls ? decalObjectClass(cls.itemType, cls.flags) : 0;
    const a = this.x.appraisal?.(guid);
    if (!a) return { info: name, appraised: false, objectClass };
    const info = mtItemInfo(this.itemData({ ...a, guid, name }, objectClass), { showBuffedValues: this.options.bool('ItemInfoOnIdent.ShowBuffedValues'), showValueAndBurden: this.options.bool('ItemInfoOnIdent.ShowValueAndBurden') });
    return { info, appraised: true, objectClass };
  }

  /** Tools → Inventory's list: everything you carry with its item-info string (as far as its appraisal allows). */
  inventoryToolItems(): MtInventoryToolItem[] {
    return this.api.inventory().map((i) => {
      const icon = this.x.itemDetails?.(i.guid)?.icon;
      return { id: i.guid >>> 0, name: i.name, ...(icon !== undefined ? { icon } : {}), info: this.infoOf(i.guid >>> 0, i.name).info };
    });
  }

  /** A Tools → Inventory row click: open the item's side pack when it's in one, and select it. */
  selectInventoryItem(id: number): void {
    const it = this.api.inventory().find((i) => (i.guid >>> 0) === (id >>> 0));
    if (it?.inside) void this.api.use(it.inside);
    this.api.select(id);
  }

  private exportItems(): MtInventoryExportItem[] {
    const slots = this.api.itemSlots();
    const perPack = new Map<number, number>();
    return slots.map((s) => {
      const slot = perPack.get(s.packSlot) ?? 0;
      perPack.set(s.packSlot, slot + 1);
      const { info, appraised, objectClass } = this.infoOf(s.guid >>> 0, s.name);
      const wl = this.x.itemDetails?.(s.guid)?.wieldedLocation;
      return { id: s.guid >>> 0, objectClass, info, appraised, equipped: s.equipped, ...(wl !== undefined ? { wieldedLocation: wl } : {}), pack: Math.max(0, s.packSlot), slot, container: s.isPack || objectClass === 38 };
    });
  }

  /** Clipboard Worn Equipment / Clipboard Inventory Info (mtCopyInventoryInfo): appraises first, then the clipboard, else a download. */
  copyInventory(which: 'worn' | 'inventory', download?: (name: string, text: string) => void): Promise<void> {
    return mtCopyInventoryInfo(which, {
      items: () => this.exportItems(),
      appraise: async (ids) => {
        for (const id of ids) void this.api.appraise(id, { quiet: true });
        const until = this.now() + 5000;
        while (this.now() < until && ids.some((id) => !this.x.appraisal?.(id))) await new Promise((r) => setTimeout(r, 200));
      },
      writeClipboard: (text) => (this.x.writeClipboard ? this.x.writeClipboard(text) : Promise.reject(new Error('no clipboard'))),
      print: (l) => this.x.print(l),
      ...(download ? { download } : {}),
    });
  }

  // ─── Background features (spec §9) ───

  private readonly filter: MtChatFilter;
  readonly loginCommands: MtLoginCommands;
  readonly autopacker: MtAutopacker;
  readonly tradeAdd: MtAutoTradeAdd;
  private readonly tradeAccept: MtAutoTradeAccept;
  /** Auto Trade Accept's whitelist (global, the regexes the accept path reads): Misc → Options' editor reads and writes it here. */
  tradeWhitelist(): string[] { return readMtTradeWhitelist(this.storage); }
  setTradeWhitelist(patterns: readonly string[]): void { writeMtTradeWhitelist(this.storage, patterns); }
  /** Set at login until the first Login Complete (later teleports send LoginComplete again; Mag-Tools' event is once per login). */
  private awaitingLoginComplete = false;
  private trading: { partner: string; partnerGuid: number } | null = null;
  /** The inventory as the agent API lists it, by guid (value, burden, type for the loot rules), refreshed with each item scan. */
  private invByGuid = new Map<number, { name: string; value?: number; burden?: number; type?: string }>();

  /**
   * A chat line is about to show (GameUI's chat paths): true hides it. A line that starts
   * Autopack (`<me> autopack` in a non-say line) starts it and is hidden; otherwise the enabled
   * Misc → Filters decide (MtChatFilter).
   */
  filterChat(line: MtChatLine): boolean {
    if (!this.x.enabled()) return false;
    // The chat logger sees every line, hidden or not (a player's speech, tells and channel lines).
    const sp = line.speech;
    const fromPlayer = sp ? sp.kind !== 'emote' && (sp.self === true || sp.senderClass === 'player' || sp.senderClass == null) : line.type === ChatMessageType.OutgoingTell;
    this.chatLogger.add({ text: line.text, type: line.type, fromPlayer });
    const isSay = line.speech ? line.speech.kind === 'say' : / says, "/.test(line.text) || line.text.startsWith('You say, ');
    if (mtIsAutopackTrigger(line.text, this.x.me(), isSay)) { this.startAutopack(); return true; }
    return this.filter.hides(line, mtEnabledFilters(this.options)) !== null;
  }

  /** A status-bar (spew box) text is about to show: true hides it (the Status Text filters). */
  statusTextHidden(text: string): boolean {
    return this.x.enabled() && mtHidesStatusText(text, mtEnabledFilters(this.options)) !== null;
  }

  /** The character logged in (PlayerCreate): queue the On Login commands. */
  loggedIn(): void {
    this.awaitingLoginComplete = true;
    if (!this.x.enabled()) return;
    this.loginCommands.login();
    // The trackers and the chat log read back this character's stored copies; Inv. Items starts over.
    this.corpses.load();
    this.players.load();
    this.chatLogger.load();
    this.inventoryTracker.reset();
    this.invSig = '';
    this.invCheckedAt = -Infinity;
  }

  /** LoginComplete went out (the world has loaded): the On Login Complete commands, the periodic timer, Open Main Pack On Login. Once per login. */
  loginComplete(): void {
    if (!this.awaitingLoginComplete) return;
    this.awaitingLoginComplete = false;
    if (!this.x.enabled()) return;
    this.loginCommands.loginComplete(this.now());
    const me = this.api.self();
    if (me && mtOpenMainPackOnLogin(this.options)) void this.api.use(me.guid);
  }

  /** Logged out: drop queued commands, stop the timer and the packer. */
  loggedOut(): void {
    this.awaitingLoginComplete = false;
    this.loginCommands.logout();
    this.players.flush();
    this.autopacker.stop();
    this.tradeAdd.ended();
    this.trading = null;
  }

  /** Your own character died: Log Out on Death. */
  died(): void {
    if (this.x.enabled() && mtLogOutOnDeath(this.options, true)) this.api.logout();
  }

  /** Every 100 ms (main.ts's agent tick): one queued login / periodic command, a periodic check, one Autopack step, one trade add. */
  tick(): void {
    if (!this.x.enabled()) { if (this.autopacker.running) this.autopacker.stop(); return; }
    this.loginCommands.tick(this.now(), mtMinuteOfDay(this.clock()));
    this.loginCommands.frame();
    if (this.autopacker.running) this.autopacker.step();
    if (this.tradeAdd.running) this.tradeAdd.step();
    this.trackInventory();
  }

  // Autopack (§9.1)

  /** `<Character>.AutoPack`, else `Default.AutoPack`, from the routine document's loot sets. */
  autopackRules(): LootRule[] | null {
    const sets = this.x.lootSets?.();
    return lootSetNamed(sets, `${this.x.character?.() || this.x.me()}.AutoPack`) ?? lootSetNamed(sets, 'Default.AutoPack');
  }

  /** `/mt autopack`, the Pack Inventory hotkey or a trigger line. Silent without a profile. True when it started, or starts once the stored routines are re-checked. */
  startAutopack(): boolean {
    if (!this.x.enabled()) return false;
    // The routines changed elsewhere since they loaded: start with the stored AutoPack profile, not the old copy.
    const fresh = this.x.freshenRoutines?.() ?? null;
    if (!fresh) return this.autopacker.start();
    void fresh.catch(() => {}).then(() => { if (this.x.enabled()) this.autopacker.start(); });
    return true;
  }

  private packItems(): MtPackItem[] {
    this.invByGuid = new Map(this.api.inventory().map((i) => [i.guid >>> 0, { name: i.name, ...(i.value !== undefined ? { value: i.value } : {}), ...(i.burden !== undefined ? { burden: i.burden } : {}), ...(i.type ? { type: i.type } : {}) }]));
    return this.api.itemSlots().map((s) => {
      const cls = this.x.classOf(s.guid);
      return { id: s.guid >>> 0, name: s.name, pack: s.packSlot, stack: s.stack, maxStack: s.maxStack, equipped: s.equipped, isContainer: s.isPack, isFocus: !!cls && decalObjectClass(cls.itemType, cls.flags) === 38 };
    });
  }

  /** One item's loot-rule match: 'appraise' while a rule needs its appraisal and none is in hand. */
  private ruleFor(rules: LootRule[], id: number): ReturnType<typeof lootRuleFor> | 'appraise' {
    const inv = this.invByGuid.get(id) ?? this.api.inventory().find((i) => (i.guid >>> 0) === id);
    if (!inv) return null;
    const props = this.api.itemData(id);
    if (!props && needsExamination(rules, { name: inv.name, type: inv.type ?? '' })) return 'appraise';
    return lootRuleFor(rules, { name: inv.name, ...(inv.value !== undefined ? { value: inv.value } : {}), ...(inv.burden !== undefined ? { burden: inv.burden } : {}), ...(inv.type ? { type: inv.type } : {}), ...(props ? { props } : {}) });
  }

  private keepPacks(item: MtPackItem): MtKeepPacks {
    const rules = this.autopackRules();
    if (!rules) return null;
    const r = this.ruleFor(rules, item.id);
    return r === 'appraise' ? 'appraise' : mtAutopackRulePacks(r);
  }

  /** What VirindiTank's tidy must respect (InventoryTidy.keepIn): every item a Keep # rule places, with its packs. Empty when Autopack has no profile. */
  autopackPlacement(): ReadonlyMap<number, readonly number[]> {
    if (!this.x.enabled() || !this.autopackRules()) return new Map();
    return mtAutopackPlacement(this.packItems(), (i) => this.keepPacks(i));
  }

  // Auto add to trade, auto trade accept (§9.2, §9.3)

  private tradeVerdict(rules: LootRule[], id: number): MtTradeVerdict {
    if (this.invByGuid.size === 0 || !this.invByGuid.has(id)) this.invByGuid = new Map(this.api.inventory().map((i) => [i.guid >>> 0, { name: i.name, ...(i.value !== undefined ? { value: i.value } : {}), ...(i.burden !== undefined ? { burden: i.burden } : {}), ...(i.type ? { type: i.type } : {}) }]));
    const r = this.ruleFor(rules, id);
    return r === 'appraise' ? 'appraise' : mtTradeRuleVerdict(r);
  }

  /** RegisterTrade: a trade window opened (Auto Add To Trade runs only when I initiated). */
  tradeOpened(e: { initiatorGuid: number; partnerGuid: number; partner: string }): void {
    const trading = { partner: e.partner, partnerGuid: e.partnerGuid >>> 0 };
    this.trading = trading;
    // The partner's loot set as stored now (it may have changed elsewhere since the routines loaded).
    const fresh = this.x.freshenRoutines?.() ?? null;
    if (fresh) { this.tradeAdd.ended(); void fresh.catch(() => {}).then(() => { if (this.trading === trading) this.tradeAddOpened(e); }); return; }
    this.tradeAddOpened(e);
  }

  private tradeAddOpened(e: { initiatorGuid: number; partner: string }): void {
    const me = this.api.self();
    this.tradeAdd.opened({ enabled: this.x.enabled() && this.options.bool('AutoTradeAdd.Enabled'), iInitiated: !!me && (e.initiatorGuid >>> 0) === (me.guid >>> 0), partner: e.partner });
  }

  /** AcceptTrade: someone pressed Accept. Accept too when it was a whitelisted partner (Auto Trade Accept). */
  tradeAcceptedBy(whoGuid: number): void {
    const t = this.trading;
    const me = this.api.self();
    if (!t || !me) return;
    const who = (whoGuid >>> 0) === (me.guid >>> 0) ? me.name : (whoGuid >>> 0) === t.partnerGuid ? t.partner : '';
    if (this.tradeAccept.accepted({ enabled: this.x.enabled() && this.options.bool('AutoTradeAccept.Enabled'), whoAccepted: who, me: me.name, partner: t.partner, whitelist: readMtTradeWhitelist(this.storage) })) this.api.trade('accept');
  }

  /** CloseTrade: the trade ended. */
  tradeClosed(): void { this.trading = null; this.tradeAdd.ended(); }

  // One-touch heal (§9.5)

  /** One press of One Touch Heal: a kit on yourself or healing food, by mtOneTouchHeal. Lines for chat (none on success). */
  oneTouchHeal(): string[] {
    if (!this.x.enabled()) return [];
    const me = this.api.self();
    if (!me) return [];
    const healing = this.api.skillList().find((s) => s.name.toLowerCase() === 'healing');
    const kits: Array<{ id: number; name: string; appraised: boolean; boost?: number; usesLeft?: number }> = [];
    const food: Array<{ id: number; name: string }> = [];
    for (const i of this.api.inventory()) {
      if (i.where === 'equipped') continue;
      const cls = this.x.classOf(i.guid);
      const oc = cls ? decalObjectClass(cls.itemType, cls.flags) : 0;
      if (oc === 29) {
        const a = this.api.itemData(i.guid);
        kits.push({ id: i.guid >>> 0, name: i.name, appraised: !!a, ...(a?.int[90] !== undefined ? { boost: a.int[90] } : {}), ...(a?.int[92] !== undefined ? { usesLeft: a.int[92] } : {}) });
      } else if (oc === 6) food.push({ id: i.guid >>> 0, name: i.name });
    }
    const d = mtOneTouchHeal({
      health: me.health.cur, maxHealth: me.health.max,
      healingTrained: !!healing && healing.training !== 'untrained', healingSkill: healing?.buffed ?? 0,
      inCombat: me.combatMode !== 'peace', kits, food,
    });
    if (d.kind === 'kit') {
      if (d.appraise) void this.api.appraise(d.id, { quiet: true });
      const r = this.api.useOn(d.id, me.guid);
      return r.ok ? [] : [r.message];
    }
    if (d.kind === 'food') { void this.api.use(d.id); return []; }
    return [];
  }

  /** Mag-Tools' VHS hotkeys (PluginCore.cs): Pack Inventory (Ctrl+P) and One Touch Heal (no default key). None without preview UI. */
  hotkeys(): VhsHotkey[] {
    if (!this.x.enabled()) return [];
    return [
      { id: 'Mag-Tools/Pack Inventory', plugin: 'Mag-Tools', name: 'Pack Inventory', description: 'Packs your inventory by the AutoPack loot profile.', defaultCode: 'Ctrl+KeyP', run: () => { this.startAutopack(); return []; } },
      { id: 'Mag-Tools/One Touch Heal', plugin: 'Mag-Tools', name: 'One Touch Heal', description: 'Heals you with a healing kit or healing food.', defaultCode: null, run: () => this.oneTouchHeal() },
    ];
  }

  readonly mana: MtManaTracker;
  /** The combat tracker: this session's, and the persistent one kept per character. */
  readonly combat: { current: MtCombatTracker; persistent: MtCombatTracker };
  private parser: MtCombatParser;
  private persistentWho = '';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Runs after the trackers change (the window redraws). */
  onChange: (() => void) | null = null;

  /** A chat line arrived: the combat tracker reads it (Mag-Tools' ChatBoxMessage handler). */
  chatLine(line: string): void {
    if (!this.x.enabled()) return;
    this.loadPersistent();
    const ev = this.parser.parse(line);
    if (!ev) return;
    this.combat.current.record(ev);
    this.combat.persistent.record(ev);
    this.savePersistentSoon();
    this.onChange?.();
  }

  private storeKey(): string { return `acjs.magtools.combat.${this.x.who()}`; }
  private loadPersistent(): void {
    const who = this.x.who();
    if (who === this.persistentWho) return;
    this.persistentWho = who;
    this.combat.persistent.clear();
    try { const raw = this.x.combatStore?.()?.getItem(this.storeKey()); if (raw) this.combat.persistent.restore(JSON.parse(raw) as MtCombatSnapshot); } catch { /* unreadable: start empty */ }
  }
  private savePersistentSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try { this.x.combatStore?.()?.setItem(this.storeKey(), JSON.stringify(this.combat.persistent.snapshot())); } catch { /* storage blocked */ }
    }, 2000);
  }
  /** Clear Persistent Stats: the tracker and its stored record. */
  clearPersistent(): void {
    this.loadPersistent();
    this.combat.persistent.clear();
    try { this.x.combatStore?.()?.removeItem(this.storeKey()); } catch { /* storage blocked */ }
    this.onChange?.();
  }

  /** A typed chat line: true when `/mt` took it (its lines printed). */
  chat(line: string): boolean {
    if (!this.x.enabled()) return false;
    // `/mt autopack` (spec §10.26): start the packer; silent without a profile.
    if (/^\s*\/mt\s+autopack\s*$/i.test(line)) { this.startAutopack(); return true; }
    const out = this.commands.command(line);
    if (!out) return false;
    for (const l of out) this.x.print(l);
    return true;
  }

  /** The player selected an object; true when Mag-Tools wants it appraised (Ident Items on Left Click). */
  selected(guid: number): boolean {
    if (!this.x.enabled() || !this.options.bool('ItemInfoOnIdent.Enabled')) return false;
    return this.ident.select(guid >>> 0, this.now(), this.options.bool('ItemInfoOnIdent.LeftClickIdent'));
  }

  leftClick(): void { this.ident.leftClick(this.now()); }

  /** An appraisal arrived: print Mag-Tools' line when it was an item the player identified. */
  appraised(a: MtAppraisal): void {
    if (!this.x.enabled() || !this.options.bool('ItemInfoOnIdent.Enabled')) return;
    // The player's examine of the selected object counts as its selection (MtIdentWatcher: within 10 s, once), stamped
    // once per selection: the open examine window asks again about a second later, and Mag-Tools printed one line.
    const sel = this.x.selectedGuid();
    if (sel !== this.stamped) this.stamped = null;
    if (sel === (a.guid >>> 0) && this.stamped !== sel) { this.ident.select(sel, this.now(), false); this.stamped = sel; }
    const cls = this.x.classOf(a.guid);
    const objectClass = cls ? decalObjectClass(cls.itemType, cls.flags) : 0;
    if (!this.ident.appraised(a.guid >>> 0, objectClass, this.now())) return;
    const item = this.itemData(a, objectClass);
    const rules = this.x.lootRules();
    // The same loot test /vt testitem makes (RoutineEngine.lootRuleFor): Value 19, EncumbranceVal 5, the appraised properties.
    const matcher = rules ? (it: MtItemData) => {
      const props: ItemProps = { int: { ...it.int }, float: { ...it.float }, string: { ...(it.string ?? {}) }, bool: { ...(it.bool ?? {}) }, did: { ...(it.did ?? {}) }, spells: it.spells.map((s) => s.name) };
      return mtLootVerdict(lootRuleFor(rules, { name: it.name, ...(it.int[19] !== undefined ? { value: it.int[19] } : {}), ...(it.int[5] !== undefined ? { burden: it.int[5] } : {}), props }));
    } : null;
    const line = mtItemInfoLine(item, { showBuffedValues: this.options.bool('ItemInfoOnIdent.ShowBuffedValues'), showValueAndBurden: this.options.bool('ItemInfoOnIdent.ShowValueAndBurden') }, matcher);
    if (!mtPrintsItem(matcher ? matcher(item) : null, { containerScan: false })) return;
    this.x.print(line.text, true);
  }

  private itemData(a: MtAppraisal, objectClass: number): MtItemData {
    const spells: MtSpellInfo[] = [];
    for (const id of a.spellIds) {
      const s = this.x.spell(id);
      if (s) spells.push({ id, name: s.name, family: s.family, difficulty: s.difficulty, offensive: s.offensive });
    }
    return { id: a.guid, name: a.name, objectClass, int: a.int, float: a.float, bool: a.bool, string: a.string, did: a.did, spells, activeSpellIds: a.activeSpellIds };
  }
}
