/**
 * UX.chargen-resume — keep a character-creation draft across a dropped
 * connection, and throw it away whenever it could surprise the player.
 *
 * Jake (2026-10-29): "store character creation progress. make sure we clear
 * it when necessary so users don't see weird sticky selections."
 *
 * A drop in chargen (socket closed, a hidden tab, a network blip) runs the
 * in-world reconnect's quiet resume (SessionLifecycle.RESUME_DELAYS_MS behind
 * the connecting screen, same credentials) and reopens chargen on the same
 * step with every choice (ui/ChargenDraft.ts). If FINISH had sent a
 * CharacterCreate, the reconnect's character list is checked first
 * (pendingCreateSlot): a character that now exists is not created again.
 * When every attempt fails the Disconnected screen shows as before, and the
 * draft waits CHARGEN_DRAFT_TTL_MS for a manual login to the same world and
 * account, which offers it back.
 *
 * The draft is discarded (ChargenDraftStore.clear / take / peek):
 *   - when a character is created (chargen_ok), or the reconnect finds the pending one created;
 *   - on chargen's Exit, a logout, leaving for the launcher, entering the world with a character;
 *   - on a login to another world, account or era (peek's owner check);
 *   - once older than CHARGEN_DRAFT_TTL_MS;
 *   - when it no longer validates against the CharGen data loaded (restoreWizard);
 *   - on a fresh "Create Character" from character select;
 *   - once taken: a restored draft is consumed, so it can never reach a later chargen.
 *
 * Kept in memory for the page and mirrored in sessionStorage (this tab only,
 * so a reload inside the window still offers it), keyed by world + account +
 * era; no password is ever part of it, and every storage call is guarded.
 */
import { isWizardSnapshotShaped, type ChargenWizardSnapshot } from '../ui/ChargenDraft.js';

/** How long a draft waits for the player after a drop the resume could not cover. */
export const CHARGEN_DRAFT_TTL_MS = 15 * 60_000;
/** sessionStorage key of the mirrored draft. */
export const CHARGEN_DRAFT_STORAGE_KEY = 'acjs.chargen.draft.v1';

/** Whose draft it is: the world (chargenWorldKey), the login account and the era (EraProfile id). */
export interface ChargenDraftOwner {
  world: string;
  account: string;
  era: string;
}

export interface ChargenDraft {
  owner: ChargenDraftOwner;
  savedAt: number;
  wizard: ChargenWizardSnapshot;
  /** FINISH had sent a CharacterCreate with no reply yet, or the reply was OK and the enter was under way. */
  pending: boolean;
  /** The new character's guid when the server had already said OK (its enter was under way). */
  createdGuid: number | null;
  /** The account's characters before the drop: a pending name found among these is not the new one. */
  knownGuids: number[];
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const norm = (o: ChargenDraftOwner): ChargenDraftOwner => ({ world: o.world, account: o.account.trim().toLowerCase(), era: o.era });

export function sameOwner(a: ChargenDraftOwner, b: ChargenDraftOwner): boolean {
  const x = norm(a); const y = norm(b);
  return x.world === y.world && x.account === y.account && x.era === y.era;
}

function isDraftShaped(d: unknown): d is ChargenDraft {
  if (!d || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  const owner = o.owner as Record<string, unknown> | null;
  if (!owner || typeof owner.world !== 'string' || typeof owner.account !== 'string' || typeof owner.era !== 'string') return false;
  if (typeof o.savedAt !== 'number' || typeof o.pending !== 'boolean') return false;
  if (o.createdGuid !== null && typeof o.createdGuid !== 'number') return false;
  if (!Array.isArray(o.knownGuids) || !o.knownGuids.every((g) => typeof g === 'number')) return false;
  return isWizardSnapshotShaped(o.wizard);
}

export class ChargenDraftStore {
  private draft: ChargenDraft | null = null;

  constructor(private readonly storage: StorageLike | null, private readonly now: () => number = Date.now) {
    try {
      const raw = storage?.getItem(CHARGEN_DRAFT_STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isDraftShaped(parsed)) this.draft = parsed;
        else storage?.removeItem(CHARGEN_DRAFT_STORAGE_KEY);
      }
    } catch { /* blocked or corrupt storage: no draft */ }
  }

  /** Keep `draft` (replacing any other). */
  save(draft: ChargenDraft): void {
    this.draft = draft;
    try { this.storage?.setItem(CHARGEN_DRAFT_STORAGE_KEY, JSON.stringify(draft)); } catch { /* memory copy stands */ }
  }

  /** Throw the draft away. */
  clear(): void {
    this.draft = null;
    try { this.storage?.removeItem(CHARGEN_DRAFT_STORAGE_KEY); } catch { /* nothing to do */ }
  }

  /** Whether any draft is held (tests / probes). */
  get held(): boolean {
    return this.draft !== null;
  }

  /**
   * The draft for `owner`, or null. A draft of another world, account or era,
   * or one older than CHARGEN_DRAFT_TTL_MS, is thrown away here.
   */
  peek(owner: ChargenDraftOwner): ChargenDraft | null {
    const d = this.draft;
    if (!d) return null;
    const age = this.now() - d.savedAt;
    if (!sameOwner(d.owner, owner) || age < 0 || age > CHARGEN_DRAFT_TTL_MS) {
      this.clear();
      return null;
    }
    return d;
  }

  /** peek, and the draft is consumed: it is never handed out twice. */
  take(owner: ChargenDraftOwner): ChargenDraft | null {
    const d = this.peek(owner);
    if (d) this.clear();
    return d;
  }
}

/** A slot of the reconnect's character list (CharacterSlot's shape). */
export interface DraftSlotLike {
  id: string;
  name: string;
  deleteTime?: number;
}

/**
 * The character a pending FINISH created, if the reconnect's list has it:
 * the guid the server's OK named, else a new slot (not among the account's
 * characters before the drop) with the typed name (the server keeps the
 * name; case and the "[] " FINISH trims are ignored). Null when FINISH had
 * not sent, or the server never made it.
 */
export function pendingCreateSlot<T extends DraftSlotLike>(draft: ChargenDraft, slots: readonly T[]): T | null {
  if (!draft.pending) return null;
  if (draft.createdGuid !== null) {
    const byGuid = slots.find((s) => parseInt(s.id, 10) === draft.createdGuid);
    if (byGuid) return byGuid;
  }
  const want = draft.wizard.name.replace(/^[[\] ]+|[[\] ]+$/g, '').toLowerCase();
  if (!want) return null;
  const known = new Set(draft.knownGuids);
  return slots.find((s) => !known.has(parseInt(s.id, 10)) && s.name.trim().toLowerCase() === want && (s.deleteTime ?? 0) === 0) ?? null;
}

/** What the reconnect's character list does with a draft (decideChargenDraft). */
export type ChargenDraftAction =
  /** The pending CharacterCreate made the character: no second create; the draft goes. */
  | { kind: 'created'; slotId: string }
  /** The automatic resume: chargen again with the draft (on the summary when FINISH was pending). */
  | { kind: 'restore'; wizard: ChargenWizardSnapshot }
  /** A manual login after the resume gave up: ask the player whether to continue it. */
  | { kind: 'offer'; wizard: ChargenWizardSnapshot }
  /** Nothing to do. */
  | { kind: 'none' };

/**
 * Decide what a character list does with the draft for `owner`. Consumes the
 * draft for 'created' and 'restore'; leaves it for 'offer' (the answer takes
 * or clears it); a draft of another owner or past its time is dropped.
 */
export function decideChargenDraft<T extends DraftSlotLike>(
  store: ChargenDraftStore, owner: ChargenDraftOwner, slots: readonly T[], resuming: boolean,
): ChargenDraftAction {
  const d = store.peek(owner);
  if (!d) return { kind: 'none' };
  const created = pendingCreateSlot(d, slots);
  if (created) {
    store.clear();
    return { kind: 'created', slotId: created.id };
  }
  // FINISH was sent but the character isn't there: back on the summary to press it again.
  const wizard = d.pending ? { ...d.wizard, step: 5 } : d.wizard;
  if (resuming) {
    store.clear();
    return { kind: 'restore', wizard };
  }
  if (d.pending) store.save({ ...d, wizard, pending: false, createdGuid: null });
  return { kind: 'offer', wizard };
}

/**
 * The resume_ended tokens a chargen resume reports (PreworldReporter.resumeEnded;
 * the bridge's token pattern takes them as they are, no bridge change).
 */
export const CHARGEN_RESUME_TOKENS = ['chargen_restored', 'chargen_created', 'chargen_invalid', 'chargen_offered', 'chargen_offer_yes', 'chargen_offer_no'] as const;
export type ChargenResumeToken = typeof CHARGEN_RESUME_TOKENS[number];

/** The text of the offer after a manual login (no retail string: retail had no draft). */
export const CHARGEN_DRAFT_OFFER_TEXT = 'The connection was lost while you were creating a character.\n\nDo you want to continue where you left off?';
