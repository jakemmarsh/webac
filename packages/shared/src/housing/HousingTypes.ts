/**
 * HousingTypes — the house type enum + its display names.
 *
 * Ported from ACE.Entity/Enum/HouseType.cs. Housing rules (rent, hooks,
 * permissions) are server-authoritative (ACE House.cs, Player_House.cs).
 */

// ─── Enums ──────────────────────────────────────────────────

export enum HouseType {
  Undef = 0,
  Cottage = 1,
  Villa = 2,
  Mansion = 3,
  Apartment = 4,
}

/**
 * Display name for a HouseType enum value — the canonical retail labels
 * used throughout the housing UI ("Cottage", "Villa", "Mansion",
 * "Apartment"). Returns an empty string for the Undef sentinel (0) —
 * matches the pre-fix inline arrays' behavior where the first slot was
 * an empty string used only as positional padding.
 *
 * FAITHFUL.289 — promotes 3 separate inline duplications of
 * `['', 'Cottage', 'Villa', 'Mansion', 'Apartment']` in main.ts (at the
 * HouseProfile / HouseData / HouseAvailableHouses event handlers) to
 * one canonical source-of-truth helper. Same pattern as `magicSchoolName`
 * (FAITHFUL.288), `itemTypeLabel` (FAITHFUL.283), etc.
 */
export function houseTypeName(type: number): string {
  switch (type) {
    case HouseType.Cottage:   return 'Cottage';
    case HouseType.Villa:     return 'Villa';
    case HouseType.Mansion:   return 'Mansion';
    case HouseType.Apartment: return 'Apartment';
    case HouseType.Undef:
    default:
      return '';
  }
}
