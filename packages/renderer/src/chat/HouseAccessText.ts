/**
 * RECON.house-command-syntax — what retail prints when a house's access
 * list (UpdateHAR, 0x0257) arrives: ClientHousingSystem::
 * Handle_House__Recv_UpdateHAR @ 00585b80 runs HAR::Dump(har, &s, false)
 * and AddTextToScroll(s, 0, true, 0) — so `@house guest list` (which only
 * asks the server for the list) shows it in the main chat.
 *
 * HAR::Dump @ 005af640 (roommates off — the call passes false):
 *   "Guests:\n", then GuestInfo::Dump @ 005af520 per guest
 *   ("  " + name + (" *" when it may use storage) + "\n"), or "  None\n";
 *   bitmask & 6 → "Allegiance Permissions: " + "guest access" (bit 2) +
 *   "storage access" (bit 4) + "\n" — retail appends the two with no
 *   separator, kept; bitmask & 1 → "[ open house ]\n".
 */
export interface HarDumpInput {
  bitmask: number;
  guests: ReadonlyArray<{ name: string; storageAccess: boolean }>;
}

export function harDumpText(har: HarDumpInput): string {
  let s = 'Guests:\n';
  if (har.guests.length === 0) s += '  None\n';
  for (const g of har.guests) s += `  ${g.name}${g.storageAccess ? ' *' : ''}\n`;
  if ((har.bitmask & 6) !== 0) {
    s += 'Allegiance Permissions: ';
    if (har.bitmask & 2) s += 'guest access';
    if (har.bitmask & 4) s += 'storage access';
    s += '\n';
  }
  if (har.bitmask & 1) s += '[ open house ]\n';
  return s;
}
