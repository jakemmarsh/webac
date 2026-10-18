// The long-form video (≈ 2.5 min, 16:9, chapters): what it is, how to start, what you get.
// Takes: combat / explore (landscape gameplay), prodload (playwebac.com cold load + world list),
// login (sign in → character creation → first steps), sitepages (how-to-play, servers, eras pages).
const L = [53, 60, 1813, 1020]; // drop the vitals bar (the capture account was in admin god mode)
const card = (kicker, text, sub) => ({ style: 'card', kicker, text, sub });
export default {
  width: 1920, height: 1080,
  // Celtic Impulse ends at ~150 s; starting 3 s in lands its ending on the outro.
  music: { file: 'music/Celtic Impulse.mp3', from: 3, gain: -6, fadeOut: 2.5 },
  events: {
    'combat.mp4': [['launch-0', 3.12], ['launch-0', 7.42], ['launch-0', 11.38]],
    'explore.mp4': [['enterportal-0', 9.3], ['exitportal-0', 12.17], ['enterportal-0', 27.17], ['exitportal-0', 30.0],
      ['enterportal-0', 45.43], ['exitportal-0', 48.17], ['enterportal-0', 62.77], ['exitportal-0', 65.6]],
    'login.mp4': [['buttonpress-0', 110.95, 0], ['enterportal-0', 111.1], ['exitportal-0', 114.03]],
  },
  clips: [
    // Hook
    { chapter: "Asheron's Call in a browser tab", take: 'combat.mp4', from: 1.6, to: 4.2, crop: L, vo: 'long-00', voAt: 0.2,
      caption: { text: "Asheron's Call shut down in *2017*" } },
    { take: 'explore.mp4', from: 66, to: 70, crop: L, caption: { text: "Here it is in *a browser tab*" } },
    { take: 'explore.mp4', from: 9.3, to: 11.3, crop: L, vo: 'long-02', voAt: 0.1, caption: { text: 'No download · no install · no patcher' } },
    { take: 'combat.mp4', from: 5.6, to: 9.2, crop: L, caption: { text: 'Mac · Windows · Linux · *Chromebook*' } },
    // 1. Open the site
    { chapter: 'Open playwebac.com', take: 'prodload.mp4', from: 1.3, to: 4.3, vo: 'long-04', caption: card('Step 1', 'Open playwebac.com', 'Any modern browser') },
    { take: 'prodload.mp4', from: 1.3, to: 8.3, vo: 'long-05', voAt: 2.3, caption: { text: 'It loads in *seconds*', sub: 'The game streams in as you play', at: 'bottom', style: 'plain' } },
    { take: 'prodload.mp4', from: 22, to: 36, vo: 'long-06', voAt: 0.6, caption: { text: 'Pick a world', sub: 'Live community servers, with player counts', at: 'bottom', style: 'plain' } },
    // 2. Character
    { chapter: 'Make a character', take: 'login.mp4', from: 14, to: 17, vo: 'long-07', caption: card('Step 2', 'Make a character', 'Most worlds create your account the first time you log in') },
    { take: 'login.mp4', from: 17, to: 41, speed: 1.5, vo: 'long-08', voAt: 0.6, caption: { text: 'All 13 heritages', sub: "The original character creator, from the game's own data", at: 'bottom', style: 'plain' } },
    { take: 'login.mp4', from: 44, to: 62, speed: 2, vo: 'long-09', voAt: 0.4, caption: { text: 'Professions, skills, appearance, town', at: 'bottom', style: 'plain' } },
    { take: 'login.mp4', from: 108, to: 118, vo: 'long-10', voAt: 1.0, caption: { text: 'Then step through the portal', at: 'bottom', style: 'plain' } },
    // 3. Explore
    { chapter: 'Explore Dereth', take: 'explore.mp4', from: 0, to: 3, crop: L, vo: 'long-11', caption: card('Step 3', 'Explore Dereth') },
    { take: 'explore.mp4', from: 3, to: 9, crop: L, vo: 'long-12', voAt: 0.5, caption: { text: 'Holtburg, as you left it', at: 'bottom', style: 'plain' } },
    { take: 'explore.mp4', from: 11.3, to: 24, crop: L, vo: 'long-13', voAt: 1.2, caption: { text: 'Portals, towns, the whole map', at: 'bottom', style: 'plain' } },
    { take: 'explore.mp4', from: 36, to: 45, crop: L },
    { take: 'explore.mp4', from: 63, to: 75, crop: L, vo: 'long-15', voAt: 3.2, caption: { text: 'Drawn from the original game files', at: 'bottom', style: 'plain' } },
    // 4. Fight
    { chapter: 'Fight', take: 'combat.mp4', from: 0, to: 13, crop: L, vo: 'long-16', voAt: 0.3, caption: { text: 'Spells, melee and missiles', sub: 'The server runs the real rules', at: 'bottom', style: 'plain' } },
    // 5. Eras
    { chapter: 'Pick your era', take: 'prodload.mp4', from: 29, to: 31.5, vo: 'long-17', caption: card('Step 4', 'Pick your era', 'End of retail (2017) · Dark Majesty · AC1999') },
    { take: 'sitepages.mp4', from: 16, to: 23, vo: 'long-18', voAt: 0.2, caption: { text: 'Every era has its own servers', sub: 'playwebac.com/eras', at: 'bottom', style: 'plain' } },
    // Outro
    { chapter: 'Play now', take: 'explore.mp4', from: 66, to: 74, crop: L, vo: 'long-19', voAt: 0.8, caption: card('Free · no install', 'playwebac.com', 'Mac · Windows · Linux · Chromebook') },
  ],
};
