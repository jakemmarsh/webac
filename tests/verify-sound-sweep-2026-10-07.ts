/**
 * The 2026-10-07 sound sweep (SOUND.* tasks + CHARGEN.appearance-gear-olthoi),
 * driven through the shipped modules.
 *
 *  - A disabled category starts nothing (no voice slot).
 *  - Logout flushes the ambient tables (Ambient::FlushSoundTables).
 *  - The three sound enables persist (UserPreferences) and gate.
 *  - The chargen Face page per heritage (gmCGAppearancePage::Update).
 *  - Tables' and sound hooks' waves are requested as they load (CreateSound).
 *  - ClientUISystem::GetUISoundTable = GetByEnum(0x10000003, 7).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { AudioManager } from '../packages/renderer/src/audio/AudioManager.js';
import { SoundPlayer } from '../packages/renderer/src/audio/SoundPlayer.js';
import { AmbientSoundManager } from '../packages/renderer/src/audio/AmbientSoundManager.js';
import { WavePrefetch } from '../packages/renderer/src/audio/WavePrefetch.js';
import { resolveUiSoundTable, EOR_UI_SOUND_TABLE } from '../packages/renderer/src/audio/RetailLocalSounds.js';
import {
  appearanceHeritageRules, appearanceUpdateRandomize, APPEARANCE_ROWS, APPEARANCE_SKIN_ROW_LIMITED_Y,
} from '../packages/renderer/src/ui/ChargenAppearanceHeritage.js';
import { AnimationHookType } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

// ── a Web Audio graph that records the voice chain ──
interface Node { kind: string; gain?: { value: number }; outs: Array<{ to: Node; out?: number; in?: number }>; connect(to: Node, out?: number, inp?: number): void }
let made: Node[] = [];
const node = (kind: string, extra: Partial<Node> = {}): Node => {
  const n: Node = { kind, outs: [], connect(to, out, inp) { this.outs.push({ to, out, in: inp }); }, ...extra };
  made.push(n);
  return n;
};
class FakeAudioContext {
  destination = node('destination');
  state = 'running';
  createGain() { return node('gain', { gain: { value: 1 } }); }
  createChannelMerger() { return node('merger'); }
  createChannelSplitter() { return node('splitter'); }
  createBufferSource() {
    return Object.assign(node('source'), { buffer: null as unknown, start() {}, stop() {}, addEventListener() {} });
  }
  async decodeAudioData(): Promise<unknown> { return {}; }
  close(): Promise<void> { return Promise.resolve(); }
}
beforeEach(() => { made = []; (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext; });
afterEach(() => { delete (globalThis as { AudioContext?: unknown }).AudioContext; });

function makePlayer(channels = 1) {
  const am = new AudioManager();
  expect(am.init()).toBe(true);
  const sp = new SoundPlayer({ getFileData: () => null } as never, am);
  (sp as unknown as { bufferCache: Map<number, unknown> }).bufferCache.set(0x0a000001, { numberOfChannels: channels });
  return { am, sp };
}

describe('a disabled category takes no voice (SOUND.enable-checkboxes-persist)', () => {
  it('muted effects: nothing starts and the 16-voice table stays empty; ambient still plays', async () => {
    const { am, sp } = makePlayer();
    am.setCategoryMuted('effects', true);
    expect(await sp.playSound(0x0a000001, 'effects', 1)).toBeNull();
    expect(sp.voices.playingCount).toBe(0);
    expect(await sp.playSound(0x0a000001, 'ambient', 1)).not.toBeNull();
    expect(sp.voices.playingCount).toBe(1);
  });
  it('a mute set before the audio context exists holds once it is created', () => {
    const am = new AudioManager();
    am.setCategoryMuted('ambient', true);
    am.init();
    expect(am.getCategoryGain('ambient')!.gain.value).toBe(0);
  });
});

describe('logout flushes the ambient tables (SOUND.ambient-logout-flush)', () => {
  function ambient() {
    const am = new AudioManager();
    am.init();
    const sp = new SoundPlayer({ getFileData: () => null } as never, am);
    const m = new AmbientSoundManager(sp, am, () => 0.5);
    // One constant sound (base_chance 0) in STB 0.
    m.loadFromSoundDesc({ stbDesc: [{ stbId: 0x20000099, ambientSounds: [{ sType: 1, volume: 0.5, baseChance: 0, minRate: 5, maxRate: 5 }] }] } as never);
    return m;
  }
  const near = [{ stbIndex: 0, dx: 1, dy: 1, dz: 0 }];
  it('flush (logout) drops the counts and the queue and bumps flushCount so the next login re-gathers', () => {
    const m = ambient();
    m.applyNeighbourhood(near as never);
    expect(m.getSoundStates().some((s) => s.onQueue)).toBe(true);
    const before = m.flushCount;
    m.flush();
    expect(m.flushCount).toBe(before + 1);
    expect(m.getTotalSoundCount()).toBe(0);
    expect(m.getSoundStates().some((s) => s.onQueue)).toBe(false);
  });
});

describe('waves are requested as their tables and hooks load (SOUND.wave-precache)', () => {
  it('every variant of a table and every Sound / SoundTweaked hook, once each; other ids ignored', () => {
    const asked: number[] = [];
    const p = new WavePrefetch((id) => asked.push(id));
    p.table(new Map([
      [1, { data: [{ soundId: 0x0a000010, priority: 0, probability: 1, volume: 1 }, { soundId: 0x0a000011, priority: 0, probability: 1, volume: 1 }], unknown: 0 }],
      [2, { data: [{ soundId: 0x0a000010, priority: 0, probability: 1, volume: 1 }], unknown: 0 }],
    ]));
    p.hooks([
      { hooks: [{ hookType: AnimationHookType.SoundTweaked, direction: 0, soundId: 0x0a000012, priority: 1, probability: 1, volume: 1 } as never] },
      { hooks: [{ hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0a000011 } as never, { hookType: AnimationHookType.SoundTable, direction: 0, soundType: 3 } as never] },
    ]);
    p.wave(0x06000001);
    expect(asked).toEqual([0x0a000010, 0x0a000011, 0x0a000012]);
    expect(p.requested).toBe(3);
  });
  it('with whole DATs (no fetcher) it does nothing', () => {
    const p = new WavePrefetch(null);
    p.wave(0x0a000001);
    expect(p.requested).toBe(0);
  });
});

describe('the UI sound table comes from the enum maps (SOUND.ui-sound-table-enum)', () => {
  it('an unreadable DAT falls back to the end-of-retail table', () => {
    expect(resolveUiSoundTable(null)).toBe(EOR_UI_SOUND_TABLE);
    expect(resolveUiSoundTable({ getFileData: () => null })).toBe(EOR_UI_SOUND_TABLE);
  });
});

describe.skipIf(!fs.existsSync(DAT_PATHS.portal))('real DAT: GetByEnum(0x10000003, 7) → UISoundTable', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  beforeAll(() => { db = openDat(DAT_PATHS.portal); });
  it('master map 0x25000000[7] = UIASSET 0x25000010, whose 0x10000003 = 0x2000004B', () => {
    expect(resolveUiSoundTable(db)).toBe(0x2000004b);
  });
});

describe('the three sound enables persist and gate (SOUND.enable-checkboxes-persist)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());

  it('defaults on; a stored false comes back after a reload; applySoundCategories mutes that category', () => {
    const GameUICtor = H.ui.constructor as unknown as { OPTIONS_DEFAULTS: Record<string, unknown>; readPersistedOptionsSettings(): Record<string, unknown> };
    expect(GameUICtor.OPTIONS_DEFAULTS.soundEffectsEnabled).toBe(true);
    expect(GameUICtor.OPTIONS_DEFAULTS.ambientSoundsEnabled).toBe(true);
    expect(GameUICtor.OPTIONS_DEFAULTS.interfaceSoundsEnabled).toBe(true);
    expect(GameUICtor.OPTIONS_DEFAULTS).not.toHaveProperty('musicVolume');
    expect(GameUICtor.OPTIONS_DEFAULTS).not.toHaveProperty('masterVolume');
    H.win.localStorage.setItem('ac_options_settings_v1', JSON.stringify({ ambientSoundsEnabled: false }));
    expect(GameUICtor.readPersistedOptionsSettings().ambientSoundsEnabled).toBe(false);
    H.win.localStorage.removeItem('ac_options_settings_v1');

    (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
    const am = new AudioManager();
    am.init();
    const ui = H.ui as unknown as { audioManager: AudioManager | null; optionsSettings: Record<string, unknown>; applySoundCategories(): void };
    ui.audioManager = am;
    ui.optionsSettings.ambientSoundsEnabled = false;
    ui.optionsSettings.interfaceSoundsEnabled = true;
    ui.applySoundCategories();
    expect(am.isCategoryMuted('ambient')).toBe(true);
    expect(am.isCategoryMuted('ui')).toBe(false);
    expect(am.isCategoryMuted('effects')).toBe(false);
    ui.optionsSettings.ambientSoundsEnabled = true;
    ui.applySoundCategories();
    expect(am.isCategoryMuted('ambient')).toBe(false);
  });
});

describe('the Face page per heritage (CHARGEN.appearance-gear-olthoi, gmCGAppearancePage::Update)', () => {
  it('Gearknight / Olthoi: Nose, Mouth, Clothes hidden, Eyes arrows off, Skin at 0x5a, Gear/Olthoi labels', () => {
    const g = appearanceHeritageRules(6);
    expect(g.limited).toBe(true);
    expect([...g.hiddenRows]).toEqual([APPEARANCE_ROWS.nose, APPEARANCE_ROWS.mouth]);
    expect(g.clothesHidden).toBe(true);
    expect(g.eyesArrowsDisabled).toBe(true);
    expect(g.skinRowY).toBe(APPEARANCE_SKIN_ROW_LIMITED_Y);
    expect(APPEARANCE_SKIN_ROW_LIMITED_Y).toBe(0x5a);
    expect(g.labels).toEqual({ hair: 'ID_CharGen_GearText_HairButton', eyes: 'ID_CharGen_GearText_EyesButton', skin: 'ID_CharGen_GearText_SkinButton' });
    for (const h of [12, 13]) expect(appearanceHeritageRules(h).labels?.eyes).toBe('ID_CharGen_OlthoiText_EyesButton');
  });
  it('every other heritage keeps the ordinary page', () => {
    for (const h of [1, 2, 3, 4, 5, 7, 8, 9, 10, 11]) {
      const r = appearanceHeritageRules(h);
      expect(r.limited).toBe(false);
      expect(r.hiddenRows.size).toBe(0);
      expect(r.labels).toBeNull();
      expect(r.skinRowY).toBeNull();
    }
  });
  it('m_LastHeritageGroup: into or out of Gearknight randomizes; Olthoi and same-heritage do not', () => {
    expect(appearanceUpdateRandomize(1, 6)).toEqual({ randomize: true, last: 6 });
    expect(appearanceUpdateRandomize(6, 6)).toEqual({ randomize: false, last: 6 });
    expect(appearanceUpdateRandomize(6, 1)).toEqual({ randomize: true, last: 1 });
    expect(appearanceUpdateRandomize(1, 2)).toEqual({ randomize: false, last: 2 });
    expect(appearanceUpdateRandomize(6, 12)).toEqual({ randomize: false, last: 12 });
    expect(appearanceUpdateRandomize(12, 1)).toEqual({ randomize: false, last: 1 });
  });
});
