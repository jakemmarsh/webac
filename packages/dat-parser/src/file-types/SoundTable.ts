import { DatReader } from '../DatReader.js';

/**
 * SoundTableData — a single sound variant entry.
 * Reference: ACE.DatLoader/Entity/SoundTableData.cs
 */
export interface SoundTableData {
  soundId: number;       // Wave file ID (0x0Axxxxxx)
  priority: number;      // Playback priority
  probability: number;   // Probability of playing (0.0-1.0)
  volume: number;        // Volume level
}

/**
 * SoundData — a set of sound variants for a single Sound enum key.
 * Reference: ACE.DatLoader/Entity/SoundData.cs
 */
export interface SoundData {
  data: SoundTableData[];
  unknown: number;
}

/**
 * SoundTable — maps Sound enum values to Wave file IDs (0x20xxxxxx).
 * Each object type has a SoundTable that defines which sounds to play for events.
 * Reference: ACE.DatLoader/FileTypes/SoundTable.cs
 */
export class SoundTable {
  id: number = 0;
  unknown: number = 0;
  soundHash: SoundTableData[] = [];
  data: Map<number, SoundData> = new Map(); // key = Sound enum value

  static read(reader: DatReader): SoundTable {
    const st = new SoundTable();
    st.id = reader.readUInt32();
    st.unknown = reader.readUInt32();

    // SoundHash: List<SoundTableData> — uint32 count prefix
    const hashCount = reader.readUInt32();
    for (let i = 0; i < hashCount; i++) {
      st.soundHash.push(readSoundTableData(reader));
    }

    // Data: PackedHashTable<uint, SoundData> — uint16 count, uint16 bucketSize
    const dataCount = reader.readUInt16();
    reader.readUInt16(); // bucketSize (unused)
    for (let i = 0; i < dataCount; i++) {
      const key = reader.readUInt32();
      const soundData = readSoundData(reader);
      st.data.set(key, soundData);
    }

    return st;
  }

  /**
   * The wave this table plays for `soundEnum`, the retail way, or null
   * (no entry, an empty variant, or the probability roll failed) — see
   * {@link retailGetSound}. BUG.server-sound-not-positional: this used to
   * pick a variant weighted by probability and always play it.
   */
  resolveSound(soundEnum: number, rng: () => number = Math.random): { waveId: number; volume: number } | null {
    return retailGetSound(this.data, soundEnum, rng);
  }
}

/**
 * `SoundManager::GetSound` @ 00550680 + `PlayProbability` @ 005500e0
 * (decompiled acclient, build ac1_sep13): the variant is picked UNIFORMLY
 * (`Random::RollDice(0,1) × num_stdatas`), a variant with no wave plays
 * nothing, and the pick plays only when `rand() / RAND_MAX < probability`
 * — 687 of the EoL portal's 4184 entries have a probability below 1, so
 * those sounds are sometimes silent. `volume` is the variant's own level
 * (what `PlaySoundA(type, obj)` / `PlaySoundFromCenter(type, table)` play
 * at; the server-volume and ambient callers pass their own).
 */
export function retailGetSound(
  data: ReadonlyMap<number, SoundData>,
  soundEnum: number,
  rng: () => number = Math.random,
): { waveId: number; volume: number } | null {
  const entry = data.get(soundEnum >>> 0);
  if (!entry || entry.data.length === 0) return null;
  const idx = Math.min(entry.data.length - 1, Math.floor(rng() * entry.data.length));
  const d = entry.data[idx];
  if (!d.soundId) return null;
  if (!(rng() < d.probability)) return null;
  return { waveId: d.soundId, volume: d.volume };
}

function readSoundTableData(reader: DatReader): SoundTableData {
  return {
    soundId: reader.readUInt32(),
    priority: reader.readFloat32(),
    probability: reader.readFloat32(),
    volume: reader.readFloat32(),
  };
}

function readSoundData(reader: DatReader): SoundData {
  const count = reader.readUInt32();
  const data: SoundTableData[] = [];
  for (let i = 0; i < count; i++) {
    data.push(readSoundTableData(reader));
  }
  const unknown = reader.readUInt32();
  return { data, unknown };
}
