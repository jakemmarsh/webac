/**
 * The scripted movement scenarios of the retail-vs-ours movement A/B
 * (tools/retail-movement-ab.ts, docs/movement-ab.md): the same key events,
 * with the same timing, go into the retail client (tools/retail-drive-mac.swift)
 * and into ours (Playwright), and the golden-trace tests
 * (tests/verify-retail-movement-golden.ts) drive our movement code with them
 * in simulated time. Times are ms from the first key; codes are
 * KeyboardEvent.code values (retail default keymap: X backpedal, Z / C strafe,
 * A / D turn, Shift walk, Space jump).
 */
export type Ev = [number, 'down' | 'up', string];
export interface Scenario {
  name: string; events: Ev[]; magic?: boolean; cast?: boolean; tail?: number; frames?: boolean;
  /** The mover: the wand mover (default), the Long Sword one (melee) or the Shortbow one (bow). */
  group?: 'melee' | 'bow';
  /** A melee / missile combat stance to enter first (Backquote with the weapon wielded). */
  stance?: 'melee' | 'missile';
  /** The observer (the PK target) at this lane-local spot instead of its usual one. */
  obs?: [number, number];
}
const hold = (code: string | string[], from: number, to: number): Ev[] => {
  const cs = Array.isArray(code) ? code : [code];
  return [...cs.map((c, i): Ev => [from + i * 40, 'down', c]), ...[...cs].reverse().map((c, i): Ev => [to + i * 40, 'up', c])];
};
const tap = (code: string, at: number, ms = 120): Ev[] => [[at, 'down', code], [at + ms, 'up', code]];
const sortEv = (e: Ev[]) => e.sort((a, b) => a[0] - b[0]);

export const SCENARIOS: Scenario[] = [
  { name: 'walk', events: hold(['ShiftLeft', 'KeyW'], 0, 3000) },
  { name: 'run', events: hold('KeyW', 0, 3000) },
  { name: 'backpedal', events: hold('KeyX', 0, 2500) },
  { name: 'backpedal-walk', events: hold(['ShiftLeft', 'KeyX'], 0, 2500) },
  { name: 'strafe-run', events: sortEv([...hold('KeyC', 0, 2000), ...hold('KeyZ', 2400, 4400)]) },
  { name: 'strafe-walk', events: hold(['ShiftLeft', 'KeyC'], 0, 2000) },
  { name: 'run-strafe', events: sortEv([...hold('KeyW', 0, 2900), ...hold('KeyC', 700, 2200)]) },
  { name: 'walk-strafe', events: sortEv([...hold(['ShiftLeft', 'KeyW'], 0, 2700), ...hold('KeyC', 700, 2700)]) },
  { name: 'run-turn', events: sortEv([...hold('KeyW', 0, 2700), ...hold('KeyD', 600, 2100)]) },
  { name: 'turn-in-place', events: sortEv([...hold('KeyD', 0, 1500), ...hold('KeyA', 1800, 3300)]) },
  { name: 'stop-start', events: sortEv(Array.from({ length: 4 }, (_, i) => hold('KeyW', i * 900, i * 900 + 500)).flat()) },
  { name: 'shift-toggle', events: sortEv([...hold('KeyW', 0, 4400), ...hold('ShiftLeft', 1200, 2400), ...hold('ShiftLeft', 3200, 4300)]) },
  { name: 'jump-run', frames: true, events: sortEv([...hold('KeyW', 0, 3000), ...tap('Space', 1000, 150)]), tail: 3000 },
  { name: 'jump-stand', frames: true, events: tap('Space', 0, 400), tail: 3000 },
  { name: 'cast-stand', magic: true, cast: true, frames: true, events: tap('Digit1', 0), tail: 5000 },
  { name: 'cast-run', magic: true, cast: true, frames: true, events: sortEv([...hold('KeyW', 0, 4800), ...tap('Digit1', 800)]), tail: 3000 },
  { name: 'cast-strafe', magic: true, cast: true, frames: true, events: sortEv([...hold('KeyC', 0, 4800), ...tap('Digit1', 800)]), tail: 3000 },
  { name: 'cast-run-strafe', magic: true, cast: true, frames: true, events: sortEv([...hold(['KeyW', 'KeyC'], 0, 4800), ...tap('Digit1', 800)]), tail: 3000 },
];


/**
 * The full movement sweep (MOVE.combination-sweep, docs/movement-ab.md
 * "Combination sweep"): every input of the retail movement keymap
 * (KeyMap 0x14000000: W forward, X back, Z / C strafe, A / D turn, Q autorun,
 * S stop, Shift walk, Alt turns a turn key into a strafe, Space jump), alone
 * and in every cross-axis pair and triple, both release orders, opposing keys
 * on one axis, Shift / autorun / stop / Alt changes mid-movement, re-presses
 * inside the stop link, and jumps from every movement state. A core subset
 * repeats in magic stance (magic walks at 1.2 m/s against peace's 2.6). Names
 * are `sweep-<family>-…`; the earlier hand-written SCENARIOS keep their
 * recordings and golden fixture.
 */
const KEY_NAME: Record<string, string> = { KeyW: 'W', KeyX: 'X', KeyZ: 'Z', KeyC: 'C', KeyA: 'A', KeyD: 'D' };
const AXES: string[][] = [['KeyW', 'KeyX'], ['KeyZ', 'KeyC'], ['KeyA', 'KeyD']];
const nm = (codes: string[]) => codes.map((c) => KEY_NAME[c]).join('');
/** Shift held around the whole sequence = walk (Toggle Run/Walk is a hold key). */
const walkWrap = (ev: Ev[], from: number, to: number): Ev[] => sortEv([[from, 'down', 'ShiftLeft'], ...ev.map(([t, d, c]): Ev => [t + 60, d, c]), [to + 60, 'up', 'ShiftLeft']]);

function sweep(): Scenario[] {
  const out: Scenario[] = [];
  const add = (name: string, events: Ev[], extra: Partial<Scenario> = {}) => out.push({ name: `sweep-${name}`, events: sortEv(events), ...extra });

  // 1. Each key alone, run and walk.
  for (const k of AXES.flat()) {
    add(`one-${nm([k])}-run`, hold(k, 0, 2500));
    add(`one-${nm([k])}-walk`, walkWrap(hold(k, 0, 2500), 0, 2560));
  }
  // 2. Cross-axis pairs: second key 700 ms later; release in press order (fifo) or reverse (lifo).
  const pairs: string[][] = [];
  for (let i = 0; i < AXES.length; i++) for (let j = i + 1; j < AXES.length; j++) for (const a of AXES[i]) for (const b of AXES[j]) pairs.push([a, b]);
  for (const [a, b] of pairs) for (const order of ['fifo', 'lifo'] as const) {
    const ev = order === 'fifo' ? [...hold(a, 0, 2000), ...hold(b, 700, 2800)] : [...hold(a, 0, 2800), ...hold(b, 700, 2000)];
    add(`pair-${nm([a, b])}-${order}-run`, ev);
    add(`pair-${nm([a, b])}-${order}-walk`, walkWrap(ev, 0, 2860));
  }
  // 2b. Turn first, then strafe: with TurnRight the substate, a later sidestep
  // fails is_allowed (both cycles carry bitfield 0x2) and becomes a modifier on
  // the turn (GetObjectSequence @ 00522860) — the press order decides.
  for (const t of AXES[2]) for (const sd of AXES[1]) {
    const ev = [...hold(t, 0, 2000), ...hold(sd, 700, 2800)];
    add(`pairrev-${nm([t, sd])}-run`, ev);
    add(`pairrev-${nm([t, sd])}-walk`, walkWrap(ev, 0, 2860));
  }
  // 3. Triples: forward/back, then strafe, then turn; released in press order.
  for (const f of AXES[0]) for (const s of AXES[1]) for (const t of AXES[2]) {
    const ev = [...hold(f, 0, 2400), ...hold(s, 500, 2900), ...hold(t, 1000, 3400)];
    add(`triple-${nm([f, s, t])}-run`, ev);
    if (f === 'KeyW' && s === 'KeyC') add(`triple-${nm([f, s, t])}-walk`, walkWrap(ev, 0, 3460));
  }
  // 4. Opposing keys on one axis: b pressed while a is held; release the later
  // one first (does a resume?) or the earlier one first (does b keep going?).
  for (const [x, y] of AXES) for (const [a, b] of [[x, y], [y, x]]) {
    add(`oppose-${nm([a, b])}-laterfirst`, [...hold(a, 0, 2800), ...hold(b, 900, 1900)]);
    add(`oppose-${nm([a, b])}-earlierfirst`, [...hold(a, 0, 1900), ...hold(b, 900, 2800)]);
  }
  // 5. Shift pressed and released mid-movement; Shift held first and let go mid-run.
  for (const ks of [['KeyX'], ['KeyC'], ['KeyW', 'KeyC'], ['KeyX', 'KeyZ'], ['KeyW', 'KeyD']]) {
    add(`shiftmid-${nm(ks)}`, [...hold(ks, 0, 3000), ...hold('ShiftLeft', 1000, 2000)]);
  }
  add('shiftfirst-W', [...hold('ShiftLeft', 0, 1500), ...hold('KeyW', 300, 3000)]);
  // 6. Autorun (Q toggles it) and what each other input does to it.
  add('auto-QQ', [...tap('KeyQ', 0), ...tap('KeyQ', 2000)]);
  add('auto-C', [...tap('KeyQ', 0), ...hold('KeyC', 800, 1800), ...tap('KeyQ', 2600)]);
  add('auto-X', [...tap('KeyQ', 0), ...tap('KeyX', 1200, 300)], { tail: 3500 });
  add('auto-W', [...tap('KeyQ', 0), ...tap('KeyW', 1200, 300)], { tail: 3500 });
  add('auto-S', [...tap('KeyQ', 0), ...tap('KeyS', 1200)], { tail: 3500 });
  add('auto-shift', [...tap('KeyQ', 0), ...hold('ShiftLeft', 900, 1900), ...tap('KeyQ', 2800)]);
  add('auto-D', [...tap('KeyQ', 0), ...hold('KeyD', 800, 1800), ...tap('KeyQ', 2600)]);
  // 7. Stop Moving (S) with movement keys still held.
  add('stop-W', [...hold('KeyW', 0, 2800), ...tap('KeyS', 1200)]);
  add('stop-WC', [...hold(['KeyW', 'KeyC'], 0, 2800), ...tap('KeyS', 1200)]);
  // 8. Alt turns the turn keys into strafes (Strafe Right = Alt+D, Strafe Left = Alt+A).
  add('alt-D', [...hold('AltLeft', 0, 2600), ...hold('KeyD', 200, 2400)]);
  add('alt-mid-D', [...hold('KeyD', 0, 2800), ...hold('AltLeft', 900, 1900)]);
  add('alt-release-D', [...hold('AltLeft', 0, 1300), ...hold('KeyD', 200, 2600)]);
  add('alt-W-A', [...hold('KeyW', 0, 2800), ...hold('AltLeft', 500, 2300), ...hold('KeyA', 700, 2100)]);
  // 9. Re-presses and swaps inside the start / stop links.
  add('retap-W', [...hold('KeyW', 0, 1200), ...hold('KeyW', 1350, 2600)]);
  add('tap-W', tap('KeyW', 0, 300));
  add('swap-WX', [...hold('KeyW', 0, 1500), ...hold('KeyX', 1500, 2800)]);
  add('swap-ZC', [...hold('KeyZ', 0, 1500), ...hold('KeyC', 1500, 2800)]);
  add('tap-C', tap('KeyC', 0, 200));
  add('tap-A', tap('KeyA', 0, 100));
  // 10. Jumps from every movement state, and keys changed in the air.
  const J = { tail: 3500 };
  add('jump-C', [...hold('KeyC', 0, 2600), ...tap('Space', 900, 150)], J);
  add('jump-X', [...hold('KeyX', 0, 2600), ...tap('Space', 900, 150)], J);
  add('jump-WC', [...hold(['KeyW', 'KeyC'], 0, 2600), ...tap('Space', 900, 150)], J);
  add('jump-WD', [...hold(['KeyW', 'KeyD'], 0, 2600), ...tap('Space', 900, 150)], J);
  add('jump-walkW', walkWrap([...hold('KeyW', 0, 2600), ...tap('Space', 900, 150)], 0, 2660), J);
  add('jump-stand-pressC', [...tap('Space', 0, 300), ...hold('KeyC', 450, 1800)], J);
  add('jump-W-releaseair', [...hold('KeyW', 0, 1100), ...tap('Space', 800, 150)], J);
  add('jump-stand-pressW', [...tap('Space', 0, 300), ...hold('KeyW', 450, 2200)], J);
  add('jump-W-longcharge', [...hold('KeyW', 0, 3000), ...tap('Space', 700, 900)], J);
  add('jump-charge-pressW', [...hold('Space', 0, 800), ...hold('KeyW', 300, 2600)], J);
  // 11. The core set again in magic stance.
  for (const k of AXES.flat()) {
    add(`magic-one-${nm([k])}-run`, hold(k, 0, 2500), { magic: true });
    add(`magic-one-${nm([k])}-walk`, walkWrap(hold(k, 0, 2500), 0, 2560), { magic: true });
  }
  for (const ks of [['KeyW', 'KeyC'], ['KeyW', 'KeyZ'], ['KeyX', 'KeyC'], ['KeyW', 'KeyD']]) {
    add(`magic-pair-${nm(ks)}-fifo-run`, [...hold(ks[0], 0, 2000), ...hold(ks[1], 700, 2800)], { magic: true });
  }
  // 12. Casting (Heal Self VI on the spell bar, Digit1) against movement, PK mover in
  // magic stance (docs/movement-ab.md "Interrupt rules"). The retail client stops the
  // player at the cast (MaybeStopCompletely); every non-autonomous server motion then
  // takes control (LoseControlToServer), and a key press takes it back
  // (TakeControlFromServer). ACE fizzles a PK's cast that ends > 6 m from its start.
  const C = { magic: true, cast: true, tail: 4500 };
  add('cast-W', [...hold('KeyW', 0, 3800), ...tap('Digit1', 800)], C);
  add('cast-walkW', walkWrap([...hold('KeyW', 0, 3800), ...tap('Digit1', 800)], 0, 3860), C);
  add('cast-X', [...hold('KeyX', 0, 3800), ...tap('Digit1', 800)], C);
  add('cast-A', [...hold('KeyA', 0, 3800), ...tap('Digit1', 800)], C);
  add('cast-WCD', [...hold(['KeyW', 'KeyC', 'KeyD'], 0, 3800), ...tap('Digit1', 800)], C);
  add('cast-coast', [...hold('KeyW', 0, 1000), ...tap('Digit1', 1150)], C);
  add('cast-then-W-long', [...tap('Digit1', 0), ...hold('KeyW', 300, 3300)], C);
  add('cast-then-W-short', [...tap('Digit1', 0), ...hold('KeyW', 300, 900)], C);
  add('cast-then-C', [...tap('Digit1', 0), ...hold('KeyC', 300, 1800)], C);
  add('cast-then-A', [...tap('Digit1', 0), ...hold('KeyA', 300, 1300)], C);
  add('cast-then-W-taps', [...tap('Digit1', 0), ...[400, 900, 1400, 1900].flatMap((t) => tap('KeyW', t, 250))], C);
  add('cast-W-release-repress', [...hold('KeyW', 0, 1300), ...tap('Digit1', 800), ...hold('KeyW', 1600, 3000)], C);
  add('cast-then-jump', [...tap('Digit1', 0), ...tap('Space', 400, 150)], C);
  add('jump-then-cast', [...tap('Space', 0, 150), ...tap('Digit1', 350)], C);
  add('auto-cast', [...tap('KeyQ', 0), ...tap('Digit1', 900)], C);
  add('cast-cast', [...tap('Digit1', 0), ...tap('Digit1', 4500)], { ...C, tail: 5000 });
  add('cast-escape', [...tap('Digit1', 0), ...tap('Escape', 500)], C);
  // 13. Melee against movement (PvP: the PK observer is the target, selected
  // with Select Closest Player, Slash). ClientCombatSystem: StartAttackRequest
  // ends a jump charge and stops the player; melee keeps building while moving;
  // every movement key event aborts an automatic attack (CancelAttack); a key
  // during the server's approach takes control back.
  const AHEAD: [number, number] = [85, 22.6];
  const FAR: [number, number] = [85, 32];
  const M = { group: 'melee' as const, stance: 'melee' as const, tail: 4000 };
  add('melee-stand', [...tap('Slash', 0), ...hold('End', 300, 1300)], { ...M, obs: AHEAD });
  add('melee-charge-W', [...tap('Slash', 0), ...hold('End', 300, 1300), ...hold('KeyW', 800, 2300)], { ...M, obs: AHEAD });
  add('melee-charge-C', [...tap('Slash', 0), ...hold('End', 300, 1300), ...hold('KeyC', 800, 2300)], { ...M, obs: AHEAD });
  add('melee-run-attack', [...tap('Slash', 0), ...hold('KeyW', 200, 2700), ...hold('End', 800, 1400)], { ...M, obs: FAR });
  add('melee-repeat-W', [...tap('Slash', 0), ...hold('End', 300, 1300), ...tap('KeyW', 2600, 200)], { ...M, obs: AHEAD });
  add('melee-repeat-D', [...tap('Slash', 0), ...hold('End', 300, 1300), ...tap('KeyD', 2600, 200)], { ...M, obs: AHEAD });
  add('melee-approach-C', [...tap('Slash', 0), ...hold('End', 300, 800), ...tap('KeyC', 1600, 300)], { ...M, obs: FAR });
  add('melee-approach-W', [...tap('Slash', 0), ...hold('End', 300, 800), ...tap('KeyW', 1600, 300)], { ...M, obs: FAR });
  add('melee-jumpcharge-attack', [...tap('Slash', 0), ...hold('Space', 300, 900), ...hold('End', 600, 1500)], { ...M, obs: AHEAD });
  // 14. Missile: a build is ready only while the forward command is Ready.
  const B = { group: 'bow' as const, stance: 'missile' as const, tail: 4000, obs: [85, 30] as [number, number] };
  add('bow-stand', [...tap('Slash', 0), ...hold('End', 300, 1300)], B);
  add('bow-charge-W', [...tap('Slash', 0), ...hold('End', 300, 1300), ...hold('KeyW', 600, 1600)], B);
  add('bow-charge-C', [...tap('Slash', 0), ...hold('End', 300, 1300), ...hold('KeyC', 600, 1600)], B);
  add('bow-run-attack', [...tap('Slash', 0), ...hold('KeyW', 200, 2700), ...hold('End', 800, 1400)], B);
  // 15. A targeted cast at the PK observer behind the mover (Heal Other VI, spell
  // bar slot 2): the server turns the mover; a turn key during it takes control.
  add('cast-target-behind', [...tap('Slash', 0), ...tap('Digit2', 300)], { magic: true, cast: true, tail: 5000, obs: [85, 17.5] });
  add('cast-target-behind-A', [...tap('Slash', 0), ...tap('Digit2', 300), ...hold('KeyA', 700, 1700)], { magic: true, cast: true, tail: 5000, obs: [85, 17.5] });
  return out;
}
export const SWEEP: Scenario[] = sweep();
