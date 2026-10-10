import { Sound } from '@ac/shared';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { readDidMapper } from '@ac/dat-parser/file-types/DidMapper.js';

/**
 * BUG.duplicate-local-sounds — the sounds the retail client plays BY ITSELF.
 *
 * Every other sound a retail player hears comes from the server's Sound
 * message (0xF750 → `SmartBox::HandleSoundEvent` @ 00451fc0 → the object's
 * own table, at the object) or from a DAT hook (animation frames, PhysicsScript
 * steps, ambient). The client's own `SoundManager::PlaySoundFromCenter`
 * (@ 00550950 / 005509e0) has exactly these callers in the EoL decomp:
 *
 *  - `gmSmartBoxUI::BeginTeleportAnimation` @ 004d6300 → Sound_UI_EnterPortal
 *    (every teleport / login tunnel start, and a logoff's world fade-out);
 *  - `gmSmartBoxUI::UseTime` @ 004d6e30 → Sound_UI_ExitPortal (the tunnel's
 *    fade-out ends);
 *  - `CPlayerSystem::Handle_Admin__Environs` @ 0055de20 → UI_Roar … UI_Thunder6
 *    (the server's AdminEnvirons sound change types);
 *  - `MediaMachine::Update_Sound` @ 004658b0 → a LayoutDesc state's Sound
 *    media. The EoL layouts carry exactly three, all UI_ButtonPress from the
 *    UI table 0x2000004B on state 3 (`tools/scan-layout-sounds.ts`:
 *    0x21000006 / 0x2100006f el 0x10000014, 0x21000040 el 0x1000047f),
 *    templates that 301 elements inherit; played on the press by
 *    `ui/LayoutPressSound.ts`, not through playUISound.
 *
 * All of them take `ClientUISystem::GetUISoundTable` @ 00563fb0 (enum
 * mapper 0x10000003 index 7 → 0x2000004B). Nothing else is played locally:
 * no wield / unwield / raise / spell-expire / lifestone chime (ACE sends
 * each as a Sound message on the player — Creature_Equipment.cs:360/436,
 * Player_Inventory.cs:306/405/1831, Player_Attributes.cs:48,
 * Player_Skills.cs:56, Player_Vitals.cs:59, EnchantmentManager.cs:331/348,
 * Lifestone.cs:58), no death sound (the human motion table's links into
 * Dead play animation 0x030000C6, whose frame-0 SoundTable hook is
 * Knockdown3 — nothing in the human table plays Death1), no spell-learn
 * chime (ACE plays the SkillUpPurple script, Player_Spells.cs:76), and no
 * container open-close / error / transient / tell / new-target / icon
 * pick-up-drop chime (no caller, no layout media; a chest's lid sounds are
 * its own motion's hooks).
 */
export const RETAIL_CLIENT_LOCAL_SOUNDS: ReadonlySet<Sound> = new Set<Sound>([
  Sound.UI_EnterPortal,
  Sound.UI_ExitPortal,
  Sound.UI_ButtonPress,
  Sound.UI_Roar, Sound.UI_Bell, Sound.UI_Chant1, Sound.UI_Chant2,
  Sound.UI_DarkWhispers1, Sound.UI_DarkWhispers2, Sound.UI_DarkLaugh, Sound.UI_DarkWind,
  Sound.UI_DarkSpeech, Sound.UI_Drums, Sound.UI_GhostSpeak, Sound.UI_Breathing,
  Sound.UI_Howl, Sound.UI_LostSouls, Sound.UI_Squeal,
  Sound.UI_Thunder1, Sound.UI_Thunder2, Sound.UI_Thunder3,
  Sound.UI_Thunder4, Sound.UI_Thunder5, Sound.UI_Thunder6,
]);

/** Whether the retail client ever plays `sound` from the UI table on its own. */
export function isRetailClientLocalSound(sound: number): boolean {
  return RETAIL_CLIENT_LOCAL_SOUNDS.has(sound as Sound);
}

/** DBCache::m_MasterMapID — the DidMapper of DidMappers. */
const MASTER_DID_MAPPER = 0x25000000;
/** Master-map enum 7 → UIASSET (GetByEnum's second argument). */
const UIASSET_MASTER_ENUM = 7;
/** UIASSET enum 0x10000003 → UISoundTable. */
export const UI_SOUND_TABLE_ENUM = 0x10000003;
/** Where the chain lands in the end-of-retail portal.dat (used when a mapper is unreadable). */
export const EOR_UI_SOUND_TABLE = 0x2000004b;

/**
 * SOUND.ui-sound-table-enum — `ClientUISystem::GetUISoundTable` @ 00563fb0:
 * `DBObj::GetByEnum(0x10000003, 7, 0x22)` — the master DidMapper's UIASSET
 * map (enum 7), then its UISoundTable entry. Read from the DAT the interface
 * runs on, so an era whose maps differ gets its own table.
 */
export function resolveUiSoundTable(db: { getFileData(id: number): ArrayBuffer | null | undefined } | null | undefined): number {
  try {
    const read = (id: number) => { const d = db?.getFileData(id); return d ? readDidMapper(new DatReader(d)) : null; };
    const uiAsset = read(MASTER_DID_MAPPER)?.client.enumToId.get(UIASSET_MASTER_ENUM);
    const table = uiAsset ? read(uiAsset)?.client.enumToId.get(UI_SOUND_TABLE_ENUM) : undefined;
    if (table) return table >>> 0;
  } catch { /* fall through */ }
  return EOR_UI_SOUND_TABLE;
}

