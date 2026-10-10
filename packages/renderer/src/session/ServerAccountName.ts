/**
 * The account name the character messages must carry.
 *
 * ACE's CharacterCreate / CharacterEnterWorld / CharacterDelete handlers drop
 * the message without a reply unless its account string equals
 * session.Account (CharacterHandler.cs:31 / :211 / :291), and ACE stores
 * account names lowercased (auto-create lowercases them). The CharacterList
 * carries that stored name, which is the one retail sends back; the login
 * string as typed ("Aerfalle") silently failed to create, enter or delete
 * characters (2026-10-04).
 *
 * It is also the name a player's spell formula is personalized with
 * (getPlayerFormula's account): retail hashes the char-list account
 * (EoL ClientMagicSystem::GetAppropriateSpellFormula @ 00567d50 reads
 * CPlayerSystem::account_; the 1999 client hashes the char-list tail it
 * parked, CSpellBase @ 0x540140), and the server keys its copy the same way
 * (ACE SpellFormula.cs:226 Session.Account; AC1999 ReserveSpellComponents
 * GetCharListAccountName). Hashing the name as typed ("Aerfalle") drew
 * different tapers than the server's, so the cast pre-check asked for
 * components the server would not burn.
 */
export function characterMessageAccount(serverAccountName: string | null | undefined, typedAccount: string): string {
  return serverAccountName && serverAccountName.length > 0 ? serverAccountName : typedAccount.toLowerCase();
}
