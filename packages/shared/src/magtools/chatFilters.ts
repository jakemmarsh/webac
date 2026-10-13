/**
 * Mag-Tools' chat filters (docs/plugin-specs/magtools.md §3.2, §9.8; Misc → Filters): whether
 * an enabled filter hides a chat line or a status-bar text. Rebuilt from the spec's patterns
 * (clean room; no upstream code). Every filter defaults off.
 *
 * - Text filters apply only to lines that are not speech (a player's or NPC's say, tell or chat
 *   channel). Emotes are not speech. The speech filters (spell words, trade/buff bot spam, the NPC
 *   filters, Master Arbitrator) are the noted exceptions.
 * - The host says what a line is (its ChatMessageType and, for speech, who sent it and how): our
 *   chat knows that from the packet, so nothing here re-parses "X says, ..." except as a fallback.
 */
import { ChatMessageType } from '../enums/ChatMessageType.js';
import { MtCombatParser } from './combatTracker.js';
import type { MtOptions } from './options.js';

/** Who sent a speech line, resolved from its sender guid (Decal's ObjectClass of that object). */
export type MtSenderClass = 'player' | 'npc' | 'vendor' | 'monster' | 'other';

export interface MtChatSpeech {
  /** say = local speech (HearSpeech / HearRangedSpeech), tell = a tell to me, channel = a chat channel, emote = an emote (not speech for the filters). */
  kind: 'say' | 'tell' | 'channel' | 'emote';
  /** The sender's name; your own name for your own lines. */
  sender: string;
  /** The words alone (without `X says, "…"`). */
  message: string;
  /** What the sender is, when the object is known. */
  senderClass?: MtSenderClass | null;
  /** True for your own speech. */
  self?: boolean;
}

/** One chat line as our chat window would show it. */
export interface MtChatLine {
  /** The line as shown (`Bob says, "hi"`, `You evaded the Drudge Skulker!`). */
  text: string;
  /** Its ChatMessageType (`@ac/shared` ChatMessageType). */
  type: number;
  /** Set for speech, tells, channels and emotes. */
  speech?: MtChatSpeech | null;
}

/** The Filters.* settings, by field name (`Filters.<field>`). */
export const MT_FILTER_FIELDS = [
  'AttackEvades', 'DefenseEvades', 'AttackResists', 'DefenseResists', 'NPKFails', 'DirtyFighting', 'MonsterDeaths',
  'SpellCastingMine', 'SpellCastingOthers', 'SpellCastFizzles', 'CompUsage', 'SpellExpires', 'HealingKitSuccess',
  'HealingKitFail', 'Salvaging', 'SalvagingFails', 'AuraOfCraftman', 'ManaStoneUsage', 'TradeBuffBotSpam', 'FailedAssess',
  'KillTaskComplete', 'VendorTells', 'MonsterTell', 'NpcChatter', 'MasterArbitratorSpam', 'AllMasterArbitratorChat',
  'StatusTextYoureTooBusy', 'StatusTextCasting', 'StatusTextAll',
] as const;
export type MtFilterField = typeof MT_FILTER_FIELDS[number];

/** Which filters are on. */
export type MtFilterSet = ReadonlySet<MtFilterField>;

/** The enabled filters from the options. */
export function mtEnabledFilters(options: MtOptions): Set<MtFilterField> {
  return new Set(MT_FILTER_FIELDS.filter((f) => options.bool(`Filters.${f}`)));
}

export interface MtChatFilterContext {
  /** Your character's name (Monster Deaths needs the killer to be you). */
  me: () => string;
  /**
   * Whether words are a spell incantation. Default: the line's type is Spellcasting (0x11), which
   * is how the server sends power words (ACE Player_Magic DoSpellWords). A server that sends them
   * as plain speech can be covered by testing the words against the spell component table.
   */
  isSpellWords?: (line: MtChatLine) => boolean;
}

/** Text-shaped speech, for a host that has no packet info: `X says, "…"`, `X tells you, "…"`, `You say, …`, `You tell …`. */
function looksLikeSpeech(text: string): boolean {
  return text.startsWith('You say, ') || text.includes(' says, "') || text.includes(' tells you, ') || text.startsWith('You tell ');
}

const MA = 'Master Arbitrator';
const MA_TELL_SPAM = ['"You shall be known', '"Take this knowledge', '"Use the the key'];
const MA_SAY_SPAM = ['"Your fellowship', '"Use one of the', '"Don\'t forget'];
const RARE_BUFFS = ['Brilliance', 'Prodigal', 'Spectral'];

/** A tell / say from the Master Arbitrator, by sender or (no packet info) by the line's own start. */
function fromMasterArbitrator(line: MtChatLine): 'tell' | 'say' | null {
  const s = line.speech;
  if (s) return s.sender === MA && s.kind !== 'emote' ? (s.kind === 'tell' ? 'tell' : 'say') : null;
  if (line.text.startsWith(`${MA} tells you, `)) return 'tell';
  if (line.text.startsWith(`${MA} says, `)) return 'say';
  return null;
}

/**
 * Mag-Tools' chat filters: the first enabled filter that hides `line`, or null when it shows.
 * Exact patterns from spec §9.8.
 */
export class MtChatFilter {
  private readonly parser: MtCombatParser;
  constructor(private readonly ctx: MtChatFilterContext) {
    this.parser = new MtCombatParser({ me: ctx.me });
  }

  /** The filter that hides this line, or null. */
  hides(line: MtChatLine, on: MtFilterSet): MtFilterField | null {
    if (on.size === 0) return null;
    const t = line.text.replace(/\r?\n$/, '');
    const sp = line.speech ?? null;
    const isSpeech = sp ? sp.kind !== 'emote' : looksLikeSpeech(t);
    const has = (f: MtFilterField) => on.has(f);

    // ─── Speech filters (the noted exceptions) ───
    const spellWords = this.ctx.isSpellWords ? this.ctx.isSpellWords(line) : line.type === ChatMessageType.Spellcasting;
    if (spellWords && sp && sp.kind === 'say') {
      const mine = sp.self === true || sp.sender === this.ctx.me();
      if (mine && has('SpellCastingMine')) return 'SpellCastingMine';
      if (!mine && has('SpellCastingOthers') && (sp.senderClass == null || sp.senderClass === 'player')) return 'SpellCastingOthers';
    }
    if (has('TradeBuffBotSpam') && sp) {
      if (sp.kind === 'say' && (sp.senderClass == null || sp.senderClass === 'player') && !sp.self && /-[tb]-"$/.test(t)) return 'TradeBuffBotSpam';
      if (sp.kind === 'emote' && /-[tb]-$/.test(t)) return 'TradeBuffBotSpam';
    }
    const ma = fromMasterArbitrator(line);
    if (ma) {
      if (has('AllMasterArbitratorChat')) return 'AllMasterArbitratorChat';
      if (has('MasterArbitratorSpam') && (ma === 'tell' ? MA_TELL_SPAM : MA_SAY_SPAM).some((p) => t.includes(p))) return 'MasterArbitratorSpam';
    }
    if (sp && sp.senderClass && sp.senderClass !== 'player') {
      if (sp.kind === 'tell' && sp.senderClass === 'vendor' && has('VendorTells')) return 'VendorTells';
      if (sp.kind === 'tell' && sp.senderClass === 'monster' && has('MonsterTell')) return 'MonsterTell';
      if (sp.kind === 'say' && sp.senderClass === 'npc' && has('NpcChatter')) return 'NpcChatter';
    }
    if (isSpeech) return null;

    // ─── Text filters (non-speech lines only) ───
    if (has('AllMasterArbitratorChat') && t.startsWith('Your fellowship is now locked.') && t.includes('you have 15 minutes to be recruited')) return 'AllMasterArbitratorChat';
    if (has('AttackEvades') && t.includes(' evaded your attack.')) return 'AttackEvades';
    if (has('DefenseEvades') && t.startsWith('You evaded ')) return 'DefenseEvades';
    if (has('AttackResists') && t.includes(' resists your spell')) return 'AttackResists';
    if (has('DefenseResists') && (
      t.startsWith('You resist the spell cast by ')
      || (t.startsWith('You have no appropriate target') && t.includes('spell'))
      || t.startsWith('You are an invalid target for the spell')
      || t.includes('tried to cast a spell on you, but was too far away!'))) return 'DefenseResists';
    if (has('NPKFails') && (
      (t.startsWith('You fail to affect ') && t.includes(' you are not a player killer!'))
      || (t.includes('fails to affect you') && t.includes(' is not a player killer!')))) return 'NPKFails';
    if (has('DirtyFighting') && t.startsWith('Dirty Fighting! ') && t.includes(' delivers a ')) return 'DirtyFighting';
    if (has('MonsterDeaths')) {
      const ev = this.parser.parse(t);
      if (ev && ev.kind === 'attack' && ev.killingBlow && ev.source === this.ctx.me()) return 'MonsterDeaths';
    }
    if (has('SpellCastFizzles') && t.startsWith('Your spell fizzled.')) return 'SpellCastFizzles';
    if (has('CompUsage') && t.startsWith('The spell consumed the following components')) return 'CompUsage';
    if (has('SpellExpires') && (t.includes('has expired.') || t.includes('have expired.')) && !RARE_BUFFS.some((w) => t.includes(w))) return 'SpellExpires';
    if (has('HealingKitSuccess') && t.startsWith('You ') && t.includes(' heal yourself for ')) return 'HealingKitSuccess';
    if (has('HealingKitFail') && t.startsWith('You fail to heal yourself. ')) return 'HealingKitFail';
    if (has('Salvaging') && t.startsWith('You obtain ') && t.includes(' using your knowledge of ')) return 'Salvaging';
    if (has('SalvagingFails') && (t.startsWith('Salvaging Failed!') || t.includes('The following were not suitable for salvaging: '))) return 'SalvagingFails';
    if (has('AuraOfCraftman') && t.startsWith('Your Aura of the Craftman augmentation increased your skill by 5!')) return 'AuraOfCraftman';
    if (has('ManaStoneUsage') && (
      t.startsWith('The Mana Stone gives ')
      || /^You need .+ more mana to fully charge your items\./.test(t)
      || t.startsWith('The Mana Stone drains ')
      || /^The .+ is destroyed\.$/.test(t))) return 'ManaStoneUsage';
    if (has('FailedAssess') && t.endsWith('tried and failed to assess you!')) return 'FailedAssess';
    if (has('KillTaskComplete') && t.startsWith('You have killed ') && t.endsWith('Your task is complete!')) return 'KillTaskComplete';
    return null;
  }

  /** Whether the line shows (no enabled filter hides it). */
  shows(line: MtChatLine, on: MtFilterSet): boolean { return this.hides(line, on) === null; }
}

/** Whether a status-bar text (the spew box over the 3D view) is hidden, and by which filter. */
export function mtHidesStatusText(text: string, on: MtFilterSet): MtFilterField | null {
  if (on.has('StatusTextAll')) return 'StatusTextAll';
  if (on.has('StatusTextYoureTooBusy') && text === "You're too busy!") return 'StatusTextYoureTooBusy';
  if (on.has('StatusTextCasting') && text.startsWith('Casting ')) return 'StatusTextCasting';
  return null;
}
