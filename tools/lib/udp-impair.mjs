// udp-impair.mjs — simulated network conditions for tools/retail-client-udp-relay.mjs
// (HARNESS.retail-under-impairment), so the REAL retail client can be run
// through the same remote-player path as ours on the impaired bridge
// (tools/probe-impaired-network.sh, :9091).
//
// Same environment variables, same semantics and the same PRNG as the
// bridge's makeImpairedLink (services/ws-tcp-bridge/src/bridgeUtil.ts): every
// value is ONE-WAY per direction, jitter is drawn per datagram (so it
// reorders), and a seed repeats the same drops and delays. The relay is plain
// Node (no tsx), so this is a JS copy; tests/verify-retail-relay-impairment.ts
// holds it datagram-for-datagram equal to the bridge's.
//
//   BRIDGE_LATENCY_MS  base one-way delay
//   BRIDGE_JITTER_MS   ± uniform spread on the delay
//   BRIDGE_LOSS_PCT    chance (0–100) each datagram is dropped
//   BRIDGE_IMPAIR_SEED PRNG seed (default 1); the upstream direction uses
//                      seed, the downstream seed + 1, as the bridge does

/** @returns {{latencyMs:number, jitterMs:number, lossPct:number, seed:number} | null} */
export function resolveImpairment(env) {
  const num = (v) => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const latencyMs = num(env.BRIDGE_LATENCY_MS);
  const jitterMs = num(env.BRIDGE_JITTER_MS);
  const lossPct = Math.min(100, num(env.BRIDGE_LOSS_PCT));
  if (latencyMs === 0 && jitterMs === 0 && lossPct === 0) return null;
  const seed = Math.trunc(num(env.BRIDGE_IMPAIR_SEED)) || 1;
  return { latencyMs, jitterMs, lossPct, seed };
}

/** mulberry32, as bridgeUtil.seededRandom. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One direction: send(deliver) → 'dropped' | 'delayed' | 'sent'. */
export function makeImpairedLink(config, schedule = setTimeout, cancel = clearTimeout) {
  if (!config) return { send: (deliver) => { deliver(); return 'sent'; }, close: () => {} };
  const rand = seededRandom(config.seed);
  const pending = new Set();
  let closed = false;
  return {
    send(deliver) {
      if (closed) return 'dropped';
      if (config.lossPct > 0 && rand() * 100 < config.lossPct) return 'dropped';
      const delay = Math.max(0, config.latencyMs + (rand() * 2 - 1) * config.jitterMs);
      const handle = schedule(() => { pending.delete(handle); if (!closed) deliver(); }, delay);
      pending.add(handle);
      return 'delayed';
    },
    close() {
      closed = true;
      for (const h of pending) cancel(h);
      pending.clear();
    },
  };
}

/** The relay's two links for one client endpoint: up (client → server) and
 *  down (server → client), seeded as the bridge seeds its pair. */
export function makeLinkPair(config, schedule, cancel) {
  return {
    up: makeImpairedLink(config, schedule, cancel),
    down: makeImpairedLink(config && { ...config, seed: config.seed + 1 }, schedule, cancel),
  };
}
