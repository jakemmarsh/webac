// The vertical Short (≈ 28 s, loops): hook on a spell, then link → server → character → world.
// Takes: vcombat3 (vertical gameplay), prodload (playwebac.com cold load + world list), login (chargen).
const V = [18, 64, 1044, 1856]; // drop the vitals bar (the capture account was in admin god mode)
const L = [53, 60, 1813, 1020]; // the same for a 1920x1080 take
const LAUNCHER = [240, 0, 1440, 1080]; // the 4:3 pre-world area of a 1920x1080 take
const HERITAGE = [270, 110, 920, 840]; // chargen: the heritage list and the model
const SUMMARY = [800, 140, 880, 940]; // chargen summary: the name box, the model and FINISH
export default {
  width: 1080, height: 1920,
  clips: [
    { take: 'vcombat3.mp4', from: 1.2, to: 3.8, crop: V, caption: { text: "Asheron's Call shut down in *2017*" } },
    { take: 'vcombat3.mp4', from: 5.0, to: 6.8, crop: V, caption: { text: 'You can still play it. *In a browser tab.*' } },
    { take: 'prodload.mp4', from: 1.3, to: 3.4, crop: LAUNCHER, fit: 'box', caption: { text: 'Open *playwebac.com*' } },
    { take: 'prodload.mp4', from: 23, to: 32, speed: 3, crop: LAUNCHER, fit: 'box', caption: { text: 'Pick a live server', sub: 'Dozens of community worlds' } },
    { take: 'login.mp4', from: 29, to: 41, speed: 3, crop: HERITAGE, fit: 'box', caption: { text: 'Make your character', sub: 'All 13 heritages' } },
    { take: 'login.mp4', from: 108.5, to: 111, speed: 1.5, crop: SUMMARY, fit: 'box' },
    { take: 'explore.mp4', from: 9.3, to: 11.6, crop: L, caption: { text: '*No* download.\n*No* install.' } },
    { take: 'vcombat3.mp4', from: 36, to: 39, crop: V, caption: { text: "You're in Dereth." } },
    { take: 'vcombat3.mp4', from: 26, to: 29, crop: V, caption: { text: 'Mac · Windows · Linux\n*Chromebook too*' } },
    { take: 'vcombat3.mp4', from: 0, to: 1.2, speed: 0.5, crop: V, caption: { text: '*playwebac.com*', sub: 'Free · plays in any modern browser', at: 'middle' } },
  ],
};
