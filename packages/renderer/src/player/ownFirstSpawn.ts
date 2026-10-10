/**
 * SWEEP1006B.message-reactions.login-our-own-createobject-resets — what the
 * own player's first-spawn CreateObject changes in player state.
 *
 * Retail SmartBox::HandleCreateObject @ 00454c80 (own-player branch, decomp
 * :87922) only sets up physics and position (init_player, store_position,
 * enter_world, PlayerPositionUpdated). It never writes Attribute2nd: the
 * vitals bars read the PlayerDescription's current values (gmVitalsUI::Update
 * @ 004bfe30 via RecvNotice_PlayerDescReceived). ACE sends the PD before the
 * CreateObject (Player_Networking.cs SendSelf), so the PD stays the only login
 * source of current Health/Stamina/Mana. We used to reset every vital to max
 * here, which showed a hurt character full until the next vital update.
 */
export interface OwnFirstSpawnState {
  name: string;
}

export function applyOwnFirstSpawn(state: OwnFirstSpawnState, name: string): void {
  state.name = name;
}
