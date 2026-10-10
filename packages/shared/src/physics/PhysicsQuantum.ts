/**
 * PhysicsQuantum — the bounds on how much simulated time a single physics
 * integration step may advance, as the RETAIL CLIENT applies them.
 *
 * Reference: acclient CPhysicsObj::update_object (acclient-decompiled.c
 * ~268278-268305) + its dynamic initializers (globals.tsv):
 *   MIN_QUANTUM  = 1 / MAX_FRAMERATE = 1/30  ($E114; MAX_FRAMERATE = 30)
 *   MAX_QUANTUM  = 1 / MIN_FRAMERATE = 1/5   ($E116; MIN_FRAMERATE = 5)
 *   HUGE_QUANTUM = 2.0
 *
 *   if (dt < F_EPSILON || dt > HUGE_QUANTUM) { update_time = now; return; } // consume, don't simulate
 *   if (dt > MAX_QUANTUM) { do { UpdateObjectInternal(MAX_QUANTUM); dt -= MAX_QUANTUM; } while (dt > MAX_QUANTUM);
 *                           if (dt <= MIN_QUANTUM) goto carry; }
 *   UpdateObjectInternal(dt);
 *
 * BUG.max-quantum-server-value — ACE's server (ACE.Server/Physics/
 * PhysicsGlobals.cs:38-43, PhysicsObj.cs:4169-4186) has the same shape but
 * MaxQuantum = 0.1; that is the SERVER's integration step. Client-side
 * integration is client behaviour, so the retail 0.2 applies here. Only
 * frames longer than 0.1s (hitches) see the difference; per-call collision
 * is further swept in body-sphere-radius steps (player/OutdoorMovement
 * transitionNumSteps, retail CTransition::calc_num_steps), so the larger
 * quantum does not widen the collision stride.
 *
 * Two rules matter for a browser client, where a frame delta is whatever the
 * last hitch, GC pause, DAT decode, or backgrounded tab happened to cost:
 *
 *  - A delta above HugeQuantum simulates NOTHING. The stall's time is consumed
 *    rather than integrated, so a paused client resumes where it stood instead
 *    of leaping forward by the length of the pause.
 *  - A delta above MaxQuantum is integrated as repeated MaxQuantum chunks, so
 *    the same total distance is covered but the physics tick runs every 0.2s
 *    of simulated travel instead of once across the whole leap. A player
 *    running 6.2 m/s through a 700ms hitch moves 4.3m — far enough to pass
 *    clean through a wall in a single unchecked step.
 *
 * DELIBERATE DEVIATION: the MIN_QUANTUM rule is NOT applied here. Retail
 * gates every physics object on it: CPhysics::UseTime @ 00509950 runs
 * update_object for all of them only once MIN_QUANTUM (1/30 s) has passed
 * since its last run, so the player moves in updates of 1/30 s or more (the
 * god-speed run-turn A/B shows 48 ms updates on the Mac). Applying it would
 * quantize a 60fps client's motion to 30Hz against a 60Hz render, so frames
 * at or below MaxQuantum integrate as a single unmodified step.
 *
 * Over a free run the distance is the same either way, but not in contact
 * or in a turn: a run-turn's step follows the heading its update began with
 * (Frame::combine), so a longer update makes a wider arc, and a longer step
 * reaches a wall or a round obstacle at a different place
 * (MOVE.slide-speed-around-sphere, docs/movement-ab.md finding 12). Near a
 * head-on hit on a sphere that difference decides how long the slide round
 * it takes.
 */

/** Retail MAX_FRAMERATE (globals.tsv .rdata 0x7929e8 = 30). */
export const MAX_FRAMERATE = 30.0;
/** Retail MIN_FRAMERATE (globals.tsv .rdata 0x7929e0 = 5). */
export const MIN_FRAMERATE = 5.0;
/** Retail MIN_QUANTUM = 1 / MAX_FRAMERATE ($E114) — 30fps. Exported for reference/tests. */
export const MIN_QUANTUM = 1.0 / MAX_FRAMERATE;
/** Retail MAX_QUANTUM = 1 / MIN_FRAMERATE ($E116) = 0.2s — the largest single integration step (ACE's server uses 0.1). */
export const MAX_QUANTUM = 1.0 / MIN_FRAMERATE;
/** Retail/ACE HUGE_QUANTUM — above this the frame simulates nothing. */
export const HUGE_QUANTUM = 2.0;

/**
 * Split a real frame delta into the physics substeps retail would integrate.
 *
 * @param deltaTime elapsed seconds since the previous frame
 * @returns the substeps to integrate, in order. Empty when the frame is
 *   dropped (delta above HugeQuantum, or non-positive/non-finite); a single
 *   element for a normal frame; MaxQuantum chunks plus a remainder otherwise.
 */
export function physicsQuantumSteps(deltaTime: number): number[] {
  if (!Number.isFinite(deltaTime) || deltaTime <= 0) return [];
  if (deltaTime > HUGE_QUANTUM) return [];
  if (deltaTime <= MAX_QUANTUM) return [deltaTime];

  const steps: number[] = [];
  let remaining = deltaTime;
  while (remaining > MAX_QUANTUM) {
    steps.push(MAX_QUANTUM);
    remaining -= MAX_QUANTUM;
  }
  // Floating-point subtraction can leave a negligible tail; only integrate a
  // remainder that is actually positive.
  if (remaining > 0) steps.push(remaining);
  return steps;
}

/**
 * Total simulated time a frame delta contributes — the sum of its substeps,
 * and 0 for a dropped frame. Use this wherever a per-frame integration needs
 * the quantum-bounded delta rather than the raw wall-clock one.
 */
export function physicsQuantumDelta(deltaTime: number): number {
  let total = 0;
  for (const s of physicsQuantumSteps(deltaTime)) total += s;
  return total;
}

/**
 * The substeps the player's own physics integrates this frame, under the
 * retail CellManager gate. SmartBox::UseTime @ 00455410 runs
 * CPhysics::UseTime only while `blocking_for_cells` is false; while the
 * portal-space gate holds for a destination's cells nothing in the physics
 * world moves, the player included (no fall, slide, run or turn at the spot
 * the teleport left). Once the hold ends (the arrival position applied, the
 * cells resident) physics runs again, through the rest of the tunnel:
 * SmartBox::Hide only stops SmartBox::Draw, so the player falls or slides
 * through TAS_TUNNEL_CONTINUE / TAS_TUNNEL_FADE_OUT as retail did.
 *
 * A held frame's time is consumed. Retail's update_object would integrate a
 * hold shorter than HUGE_QUANTUM on release (update_time is not advanced
 * while UseTime is skipped); the teleport resets the position at that moment
 * anyway, so the catch-up is not reproduced.
 */
export function smartBoxPhysicsSteps(deltaTime: number, blockingForCells: boolean): number[] {
  return blockingForCells ? [] : physicsQuantumSteps(deltaTime);
}
