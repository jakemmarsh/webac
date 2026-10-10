/**
 * SWEEP1006B.message-reactions.fellowship-chat-lines-create-join — the chat
 * lines retail's fellowship panel prints when the fellowship changes. Each
 * gmFellowshipUI notice prints through ClientSystem::AddTextToScroll(line, 0,
 * true, 0): text type 0, a default chat line. The acclient.exe literals end
 * in "\n", which AddTextToScroll @ 00563c50 trims, so they are omitted here.
 *
 * Every function is pure: it reads the panel's snapshot BEFORE the event
 * changes it (retail reads the name from its own copy before RemoveFellow /
 * DeleteFellowship) and returns the line, or null when retail prints nothing.
 */

export interface FellowshipChatFellow {
  guid: number;
  name: string;
}

export interface FellowshipChatSnapshot {
  fellowshipName: string;
  leaderGuid: number;
  fellows: ReadonlyArray<FellowshipChatFellow>;
}

function fellowName(snap: FellowshipChatSnapshot, guid: number): string | null {
  return snap.fellows.find((f) => f.guid === guid)?.name ?? null;
}

/**
 * gmFellowshipUI::RecvNotice_FellowshipUpdate @ 00490490: prints only when
 * the panel had no fellowship (or an empty one) before the update.
 * - leader is us: L"You have created the Fellowship of %hs.\n" (0x7a5658)
 * - otherwise: L"You have been recruited into the %hs fellowship, %hs
 *   fellowship led by %hs.\n" (0x7a5598). The middle argument is the wide
 *   literal L"an open" / L"a closed" fed to a narrow %hs in _vsnwprintf, so
 *   retail prints only its first character: "a" in both cases.
 */
export function fellowshipUpdateLine(
  prev: FellowshipChatSnapshot | null,
  next: FellowshipChatSnapshot,
  selfGuid: number | null | undefined,
): string | null {
  if (prev && prev.fellows.length > 0) return null;
  if (selfGuid != null && next.leaderGuid === selfGuid) {
    return `You have created the Fellowship of ${next.fellowshipName}.`;
  }
  const leader = fellowName(next, next.leaderGuid) ?? '';
  return `You have been recruited into the ${next.fellowshipName} fellowship, a fellowship led by ${leader}.`;
}

/**
 * ClientFellowshipSystem::Handle_Fellowship__UpdateFellow @ 005690c0 raises
 * FellowAdded only when the guid was not already a fellow;
 * gmFellowshipUI::FellowAdded @ 0048fc20 prints
 * L"%hs is now a member of your Fellowship.\n" (0x7a53e8).
 */
export function fellowAddedLine(prev: FellowshipChatSnapshot | null, fellow: FellowshipChatFellow): string | null {
  if (!prev) return null;
  if (prev.fellows.some((f) => f.guid === fellow.guid)) return null;
  return `${fellow.name} is now a member of your Fellowship.`;
}

/**
 * gmFellowshipUI::FellowQuit @ 0048fae0.
 * - we quit: L"You are no longer a member of the %hs Fellowship.\n" (0x7a5380)
 * - another fellow (only if IsFellow): L"%hs has left your Fellowship.\n" (0x7a5340)
 */
export function fellowQuitLine(
  snap: FellowshipChatSnapshot | null,
  guid: number,
  selfGuid: number | null | undefined,
): string | null {
  if (!snap) return null;
  if (selfGuid != null && guid === selfGuid) {
    return `You are no longer a member of the ${snap.fellowshipName} Fellowship.`;
  }
  const name = fellowName(snap, guid);
  return name === null ? null : `${name} has left your Fellowship.`;
}

/**
 * gmFellowshipUI::FellowDismissed @ 0048f970.
 * - we were dismissed: L"%hs has dismissed you from the Fellowship.\n"
 *   (0x7a52e8), filled with the leader's name
 * - another fellow (only if IsFellow), we lead:
 *   L"You dismiss %hs from your Fellowship.\n" (0x7a5298)
 * - another fellow, we don't lead:
 *   L"%hs has been dismissed from the Fellowship.\n" (0x7a5238)
 */
export function fellowDismissedLine(
  snap: FellowshipChatSnapshot | null,
  guid: number,
  selfGuid: number | null | undefined,
): string | null {
  if (!snap) return null;
  if (selfGuid != null && guid === selfGuid) {
    const leader = fellowName(snap, snap.leaderGuid) ?? '';
    return `${leader} has dismissed you from the Fellowship.`;
  }
  const name = fellowName(snap, guid);
  if (name === null) return null;
  if (selfGuid != null && snap.leaderGuid === selfGuid) return `You dismiss ${name} from your Fellowship.`;
  return `${name} has been dismissed from the Fellowship.`;
}

/**
 * gmFellowshipUI::FellowshipDisbanded @ 0048f8a0 (nothing when there is no
 * fellowship).
 * - we lead: "You have disbanded your Fellowship.\n"
 * - otherwise: L"%hs has disbanded your Fellowship.\n" (0x7a51c8), the leader's name
 */
export function fellowshipDisbandedLine(
  snap: FellowshipChatSnapshot | null,
  selfGuid: number | null | undefined,
): string | null {
  if (!snap) return null;
  if (selfGuid != null && snap.leaderGuid === selfGuid) return 'You have disbanded your Fellowship.';
  const leader = fellowName(snap, snap.leaderGuid) ?? '';
  return `${leader} has disbanded your Fellowship.`;
}
