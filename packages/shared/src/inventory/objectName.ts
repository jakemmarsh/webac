/**
 * CORE.10.e — retail stack-name selection, mirroring
 * ACCWeenieObject::GetObjectName @ 0058e6e0 (NAME_APPROPRIATE branch):
 * a stack of >= 2 promotes the request to NAME_PLURAL, which
 *   1. uses pwd._plural_name when the server sent one
 *      (WeenieHeaderFlag.PluralName = 0x1, ACE WorldObject_Networking.cs:87 —
 *      ACE sends it only when the weenie defines PropertyString.PluralName,
 *      e.g. the irregular "Vials of Berimphur Dye"), and otherwise
 *   2. pluralizes the singular name CLIENT-SIDE in the NAME_PLURAL
 *      fallthrough: append "es" when the name ends in 's', else "s"
 *      (the decomp's `if (pcVar9[-1] == 's')` → "es" / "s" appends right
 *      after the singular copy — this is how retail shows "Pyreals" even
 *      though weenie 273 defines no PluralName).
 * A stack of 0/1 always uses the singular name. (The separate qualities
 * path, CACQualities::InqPluralNameString @ 0058f850, additionally treats
 * a trailing 'x' as "es"; GetObjectName's label path checks only 's'.)
 */
export function getAppropriateName(
  name: string,
  pluralName: string | undefined,
  stackSize: number | undefined,
): string {
  if ((stackSize ?? 0) < 2) return name;
  return getPluralName(name, pluralName);
}

/**
 * GetObjectName(NAME_PLURAL = 1) @ 0058e6e0 — the plural form regardless of
 * the stack size: pwd._plural_name when the server sent a non-empty one (the
 * decomp's `m_len != 1` check on the ref buffer), else the singular name with
 * "es" appended after a trailing 's' and "s" otherwise. ServerSaysAttemptFailed
 * @ 0058eae0 names the object this way for the merge / split verb lines
 * (CORE.17.k.c.a).
 */
export function getPluralName(name: string, pluralName: string | undefined): string {
  if (pluralName) return pluralName;
  if (!name) return name;
  return name.endsWith('s') ? `${name}es` : `${name}s`;
}
