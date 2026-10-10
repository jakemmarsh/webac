/**
 * CORE.17.k.b.b.c.c.a — the text of the World panel's House page, as the
 * retail client composes it. Pure: takes the player's own HouseData (the
 * 0x225 GameEventHouseData) plus the PlayerDesc's HousePurchaseTimestamp
 * and returns the rows gmHouseUI adds to its listbox, each with its
 * HousePanelTextColor index into the row template's p27 colour table.
 *
 * Ground truth (decompiled EoL client, reference/client-eol/decomp/
 * acclient-decompiled.c — docs/retail-client-symbols.md "The House page"):
 *
 * - gmHouseUI::Update(HouseData) @ 004a33d0 / Update(ulong) @ 004a3460 /
 *   DisplayHouseData @ 004a3380: UIElement_ListBox::Flush, then
 *   DisplayBuyPayment, DisplayRentPayment, DisplayBuyTime, DisplayRentTimes,
 *   DisplayLocation, DisplayWarningText, DisplayPurchaseTimeText — in that
 *   order. Update(ulong) (RecvNotice_FailedHouseTransaction, the 0x226
 *   HouseStatus) drops m_pHouseData first: a player without a house sees
 *   the no-house rows.
 * - DisplayBuyPayment @ 004a2b30: "You do not currently own a house." when
 *   there is no HouseData, else "The purchase price for this dwelling is:\n"
 *   + HousePaymentList::ComposeText (SetTextWithFont(text, 0, 0) — colour
 *   entry 0). Every other writer goes through AddHousePanelText @ 004a2810
 *   (AddItemFromTemplateList(0) + SetAttribute_Bool(0x29 FitToText, true)
 *   + SetTextWithFont(text, 0, colour)) and needs HouseData.
 * - HousePayment::ComposeText @ 005baea0: "<num> <GetName>"; ComposeText2 @
 *   005baf60: "<paid>/<num> <GetName>"; HousePaymentList::ComposeText /
 *   ComposeText2 @ 005bb0b0 / 005bb140 join the entries with ", " and trim
 *   the trailing one. HousePayment::GetName @ 005bab50: the singular name
 *   when num == 1; else the plural name, or the name + "s" (+ "es" after a
 *   trailing 's' / 'x') when the list carries no plural.
 * - DisplayRentPayment @ 004a2c20: "Rent:\n" + ComposeText2(rent), Normal.
 * - DisplayBuyTime @ 004a2cc0: "Bought: " + HouseSystem::ConvertTime @
 *   005bb260 (strftime("%c") of the local time; "N/A" for 0), Normal.
 * - DisplayRentTimes @ 004a2d60: "This maintenance period ends: " +
 *   ConvertTime(rent_time + GetRentPeriod) and "Maintenance is next due: "
 *   + ConvertTime(...) — HouseSystem::GetRentPeriod @ 005bb1f0 is 7,776,000 s
 *   (90 days) for an Apartment (type 4), 2,592,000 s (30 days) otherwise.
 *   The decompiler dropped the FPU arithmetic of the second line; the two
 *   branches (maintenance_free == 0 && !IsPaidInFull vs. the rest) both add
 *   GetRentPeriod to a time, read here as the current deadline while unpaid
 *   and the following period's end once paid / free (see the doc section).
 * - DisplayLocation @ 004a2ee0: GetHouseLocation @ 004a27b0 — nothing for
 *   an Apartment or an invalid Position; else LandDefs::gid_to_lcoord of
 *   Position::get_outside_cell_id, and the exe's "Location: %.1f%s, %.1f%s"
 *   (string 73533) with "W" below landscape x 0x400 else "E" (the N / S
 *   letter and the magnitudes follow gmMapUI's landscape → map coordinate
 *   conversion, the only one the client has).
 * - DisplayWarningText @ 004a3020: not maintenance-free and not
 *   IsPaidInFull → HouseSystem::ConstructRentWarningMessage @ 005bb310
 *   ("Warning!  You have not paid your maintenance costs for the last <days>
 *   day maintenance period.  Please pay these costs by this deadline or you
 *   will lose your house, and all your items within it.") in RentNotPaid
 *   (entry 2, yellow); else "The maintenance has already been paid for this
 *   period. You may not prepay next period's maintenance." in RentPaid
 *   (entry 1, green). HousePaymentList::IsPaidInFull @ 005ba6a0: every
 *   entry's paid >= num.
 * - DisplayPurchaseTimeText @ 004a3110: PlayerDesc int 199
 *   (HousePurchaseTimestamp); HouseSystem::HasPurchaseWaitPeriodExpired @
 *   005bb1d0 is now − stamp > 0x278d00 (30 days). Not expired: "You may buy
 *   another landscape house at " + strftime("%c", stamp + 30 days) + ". This
 *   restriction does not apply to apartments."; expired with no HouseData:
 *   "You may buy another house immediately."; expired with a house: "You may
 *   buy another house immediately after you abandon this one." — always
 *   Normal, and shown even without a house (it reads the PlayerDesc).
 */
import { formatAcTime } from '../utils/formatAcTime.js';
import { getOutsideLcoord, landscapeCoordToMapCoord, positionIsValid, LANDSCAPE_ORIGIN_CELL, HOUSE_TYPE_APARTMENT, type CellPosition } from './MapMarkers.js';

/** HousePanelTextColor — the row template 0x100001e7's p27 entries [white, green, yellow]. */
export const HOUSE_PANEL_TEXT_COLOR = { normal: 0, rentPaid: 1, rentNotPaid: 2 } as const;
export type HousePanelTextColor = (typeof HOUSE_PANEL_TEXT_COLOR)[keyof typeof HOUSE_PANEL_TEXT_COLOR];

/** HouseSystem::GetRentPeriod @ 005bb1f0: 30 days, 90 for an Apartment. */
export const HOUSE_RENT_PERIOD_SECONDS = 2_592_000;
export const APARTMENT_RENT_PERIOD_SECONDS = 7_776_000;
/** HouseSystem::HasPurchaseWaitPeriodExpired @ 005bb1d0 / DisplayPurchaseTimeText: 0x278d00 s = 30 days. */
export const HOUSE_PURCHASE_WAIT_SECONDS = 0x278d00;

export const HOUSE_PANEL_STRINGS = {
  noHouse: 'You do not currently own a house.',
  purchasePrice: 'The purchase price for this dwelling is:\n',
  rent: 'Rent:\n',
  bought: 'Bought: ',
  periodEnds: 'This maintenance period ends: ',
  nextDue: 'Maintenance is next due: ',
  location: 'Location: ',
  rentPaid: "The maintenance has already been paid for this period. You may not prepay next period's maintenance.",
  warningHead: 'Warning!  You have not paid your maintenance costs for the last ',
  warningMid: ' day maintenance period.  Please pay these costs by this deadline',
  warningTail: ' or you will lose your house, and all your items within it.',
  buyAnotherAt: 'You may buy another landscape house at ',
  buyAnotherApartments: '. This restriction does not apply to apartments.',
  buyAnotherNow: 'You may buy another house immediately.',
  buyAnotherAfterAbandon: 'You may buy another house immediately after you abandon this one.',
  timeNA: 'N/A',
} as const;

export interface HousePaymentEntry {
  num: number;
  paid: number;
  name: string;
  pluralName: string;
  weenieId?: number;
}

/** The player's own HouseData (ACE HouseData.cs Write order, minus the unused fields). */
export interface HousePageData {
  houseType: number;
  maintenanceFree: boolean;
  /** Unix seconds; 0 = never (ConvertTime prints "N/A"). */
  buyTimeUnix: number;
  /** Unix seconds — when the current maintenance period began. */
  rentTimeUnix: number;
  buy: readonly HousePaymentEntry[];
  rent: readonly HousePaymentEntry[];
  position: CellPosition | null;
}

export interface HousePageLine {
  text: string;
  colorIndex: HousePanelTextColor;
}

/** HouseSystem::GetRentPeriod @ 005bb1f0. */
export function houseRentPeriodSeconds(houseType: number): number {
  return houseType === HOUSE_TYPE_APARTMENT ? APARTMENT_RENT_PERIOD_SECONDS : HOUSE_RENT_PERIOD_SECONDS;
}

/** HousePayment::GetName @ 005bab50. */
export function housePaymentName(p: Pick<HousePaymentEntry, 'num' | 'name' | 'pluralName'>): string {
  if (p.num === 1) return p.name;
  if (p.pluralName) return p.pluralName;
  const last = p.name.slice(-1);
  return p.name + (last === 's' || last === 'x' ? 'es' : 's');
}

/** HousePaymentList::ComposeText @ 005bb0b0: "<num> <name>, …". */
export function composeHousePaymentText(list: readonly HousePaymentEntry[]): string {
  return list.map((p) => `${p.num} ${housePaymentName(p)}`).join(', ');
}

/** HousePaymentList::ComposeText2 @ 005bb140: "<paid>/<num> <name>, …". */
export function composeHousePaymentText2(list: readonly HousePaymentEntry[]): string {
  return list.map((p) => `${p.paid}/${p.num} ${housePaymentName(p)}`).join(', ');
}

/** HousePaymentList::IsPaidInFull @ 005ba6a0 (an empty list is paid). */
export function isHousePaidInFull(list: readonly HousePaymentEntry[]): boolean {
  return list.every((p) => p.paid >= p.num);
}

/** HouseSystem::ConvertTime @ 005bb260: "N/A" for 0, else the local strftime("%c"). */
export function houseConvertTime(unixSeconds: number): string {
  return unixSeconds === 0 ? HOUSE_PANEL_STRINGS.timeNA : formatAcTime(unixSeconds);
}

/** HouseSystem::ConstructRentWarningMessage @ 005bb310 (the day count is ftol(period / 86400)). */
export function constructRentWarningMessage(houseType: number): string {
  const days = Math.trunc(houseRentPeriodSeconds(houseType) / 86_400);
  return HOUSE_PANEL_STRINGS.warningHead + String(days) + HOUSE_PANEL_STRINGS.warningMid + HOUSE_PANEL_STRINGS.warningTail;
}

/** HouseSystem::HasPurchaseWaitPeriodExpired @ 005bb1d0: now − stamp > 30 days. */
export function hasPurchaseWaitPeriodExpired(purchaseTimestamp: number, nowUnix: number): boolean {
  return nowUnix - purchaseTimestamp > HOUSE_PURCHASE_WAIT_SECONDS;
}

/**
 * gmHouseUI::GetHouseLocation @ 004a27b0 + DisplayLocation @ 004a2ee0: the
 * "Location: …" line, or null when the house is an Apartment or its
 * position is not a valid outdoor cell.
 */
export function houseLocationText(houseType: number, position: CellPosition | null | undefined): string | null {
  if (houseType === HOUSE_TYPE_APARTMENT) return null;
  if (!positionIsValid(position)) return null;
  const l = getOutsideLcoord(position!);
  if (!l) return null;
  const ew = Math.abs(landscapeCoordToMapCoord(l.x)).toFixed(1) + (l.x < LANDSCAPE_ORIGIN_CELL ? 'W' : 'E');
  const ns = Math.abs(landscapeCoordToMapCoord(l.y)).toFixed(1) + (l.y < LANDSCAPE_ORIGIN_CELL ? 'S' : 'N');
  return `${HOUSE_PANEL_STRINGS.location}${ns}, ${ew}`;
}

/** DisplayPurchaseTimeText @ 004a3110 — the last row; `purchaseTimestamp` is PlayerDesc int 199 (0 when unset). */
export function housePurchaseTimeText(purchaseTimestamp: number, hasHouse: boolean, nowUnix: number): string {
  if (!hasPurchaseWaitPeriodExpired(purchaseTimestamp, nowUnix)) {
    return HOUSE_PANEL_STRINGS.buyAnotherAt + formatAcTime(purchaseTimestamp + HOUSE_PURCHASE_WAIT_SECONDS) + HOUSE_PANEL_STRINGS.buyAnotherApartments;
  }
  return hasHouse ? HOUSE_PANEL_STRINGS.buyAnotherAfterAbandon : HOUSE_PANEL_STRINGS.buyAnotherNow;
}

/**
 * The rows of the House page in gmHouseUI::DisplayHouseData's order.
 * `data` null = no HouseData (Update(ulong) dropped it, or none arrived);
 * `purchaseTimestamp` null = no PlayerDesc yet (the last row is skipped, as
 * the retail QueryInterface failure branch does).
 */
export function housePageLines(data: HousePageData | null, purchaseTimestamp: number | null, nowUnix: number): HousePageLine[] {
  const N = HOUSE_PANEL_TEXT_COLOR.normal;
  const lines: HousePageLine[] = [];
  if (!data) {
    lines.push({ text: HOUSE_PANEL_STRINGS.noHouse, colorIndex: N });
  } else {
    lines.push({ text: HOUSE_PANEL_STRINGS.purchasePrice + composeHousePaymentText(data.buy), colorIndex: N });
    lines.push({ text: HOUSE_PANEL_STRINGS.rent + composeHousePaymentText2(data.rent), colorIndex: N });
    lines.push({ text: HOUSE_PANEL_STRINGS.bought + houseConvertTime(data.buyTimeUnix), colorIndex: N });
    const period = houseRentPeriodSeconds(data.houseType);
    const unpaid = !data.maintenanceFree && !isHousePaidInFull(data.rent);
    const periodEnd = data.rentTimeUnix + period;
    lines.push({ text: HOUSE_PANEL_STRINGS.periodEnds + houseConvertTime(periodEnd), colorIndex: N });
    lines.push({ text: HOUSE_PANEL_STRINGS.nextDue + houseConvertTime(unpaid ? periodEnd : periodEnd + period), colorIndex: N });
    const location = houseLocationText(data.houseType, data.position);
    if (location !== null) lines.push({ text: location, colorIndex: N });
    if (unpaid) lines.push({ text: constructRentWarningMessage(data.houseType), colorIndex: HOUSE_PANEL_TEXT_COLOR.rentNotPaid });
    else lines.push({ text: HOUSE_PANEL_STRINGS.rentPaid, colorIndex: HOUSE_PANEL_TEXT_COLOR.rentPaid });
  }
  if (purchaseTimestamp !== null) {
    lines.push({ text: housePurchaseTimeText(purchaseTimestamp, data !== null, nowUnix), colorIndex: N });
  }
  return lines;
}
