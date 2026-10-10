/**
 * WebSocket↔UDP bridge — CLI entry. The browser can't send UDP, so:
 *   Browser → WebSocket → this bridge → UDP → ACE / GDLE server, and back.
 * The bridge itself lives in server.ts (createBridgeServer); this file reads
 * the config, starts it, and handles SIGTERM/SIGINT. Every env var is
 * documented in services/ws-tcp-bridge/README.md.
 *
 * Local dev (unchanged): npx tsx services/ws-tcp-bridge/src/bridge.ts
 *   → ws://127.0.0.1:9090 bridging to udp://127.0.0.1:9000 (+9001 world).
 * Positional args: [wsPort] [serverHost] [basePort] [worldPort=basePort+1]
 *   (or BRIDGE_TARGET=host:port). Either pins ONE target and ignores ?server.
 * Public multi-server bridge: BRIDGE_MODE=multi — clients connect with
 *   wss://<bridge>/connect?server=<id>, resolved against Servers.xml + overlay.
 *
 * Network impairment (HARNESS.bridge-network-impairment; off by default):
 * BRIDGE_LATENCY_MS, BRIDGE_JITTER_MS, BRIDGE_LOSS_PCT, BRIDGE_IMPAIR_SEED. Run
 * an impaired bridge on a second port so the normal one stays clean:
 * BRIDGE_LATENCY_MS=75 BRIDGE_JITTER_MS=15 BRIDGE_LOSS_PCT=2 npx tsx services/ws-tcp-bridge/src/bridge.ts 9091
 */
import * as fs from 'fs';
import { resolveBridgeConfig } from './bridgeUtil.js';
import { makeLogger } from './log.js';
import { ServerRegistry, ac1999Overlay, mergeOverlays, parseOverlay, type ServerOverlay } from './serverList.js';
import { createBridgeServer } from './server.js';
import { ServerDirectory } from './serverDirectory.js';
import { EraDetector } from './eraDetect.js';
import { udpProbeLogin } from './loginProbe.js';
import { resolveTarget } from './targets.js';
import { defaultFetchText } from './serverList.js';
import { isAc1999Era } from './protocol.js';

async function main(): Promise<void> {
  const config = resolveBridgeConfig(process.argv.slice(2), process.env);
  const log = makeLogger(config.debug);

  let registry: ServerRegistry | undefined;
  let directory: ServerDirectory | undefined;
  // The bridge's open sessions per server; set once the bridge exists.
  if (config.mode === 'multi') {
    const overlays: ServerOverlay[] = [];
    if (config.serverList.overlayPath) overlays.push(parseOverlay(fs.readFileSync(config.serverList.overlayPath, 'utf8')));
    if (config.serverList.overlayJson) overlays.push(parseOverlay(config.serverList.overlayJson));
    // The AC1999 worlds (not in Servers.xml), after the operator's so its entries win.
    overlays.push(ac1999Overlay(process.env));
    registry = new ServerRegistry({
      url: config.serverList.url,
      refreshMs: config.serverList.refreshMs,
      cachePath: config.serverList.cachePath,
      overlay: mergeOverlays(...overlays),
      log,
    });
    // Load the cache + first fetch before accepting connections; never throws.
    await registry.start();
    // The launcher's world list (GET /servers): TreeStats status + player
    // counts merged over the allowlist, refreshed in the background.
    const reg = registry;
    // Each ACE server's era from the login version it accepts (eraDetect.ts).
    // BRIDGE_ERA_PROBE=off disables it (no probe logins leave the bridge).
    const detector = process.env.BRIDGE_ERA_PROBE === 'off' ? undefined : new EraDetector({
      probe: udpProbeLogin(),
      resolve: async (host) => {
        const r = await resolveTarget(host, { allowPrivate: config.allowPrivateTargets });
        return r.ok ? r.address : null;
      },
      log,
    });
    directory = new ServerDirectory({
      servers: () => reg.all(),
      statusUrl: process.env.BRIDGE_STATUS_URL === 'none' ? null : process.env.BRIDGE_STATUS_URL || undefined,
      countsUrl: process.env.BRIDGE_COUNTS_URL === 'none' ? null : process.env.BRIDGE_COUNTS_URL || undefined,
      fetchText: defaultFetchText,
      log,
      detector,
    });
    directory.start();
    if (config.allowPrivateTargets) {
      log(config.production ? 'error' : 'warn', 'private_targets_allowed', {
        note: 'BRIDGE_ALLOW_PRIVATE_TARGETS is on: servers resolving to private/loopback addresses are reachable. Local development only.',
      });
    }
  }

  const bridge = createBridgeServer(config, { registry, directory, log });
  const port = await bridge.listen();
  log('info', 'bridge_listening', {
    url: `ws://${config.wsHost}:${port}`,
    mode: config.mode,
    target: config.mode !== 'pinned' ? 'allowlist (?server=<id>)'
      : isAc1999Era(config.era) ? `udp://${config.aceHost}:${config.aceAuthPort} (AC1999: one port)`
      : `udp://${config.aceHost}:${config.aceAuthPort} (world ${config.aceWorldPort})`,
    servers: registry?.status().servers,
    maxConnections: config.maxConnections,
    limits: config.limits,
    trustProxyHops: config.trustProxyHops,
    impairment: config.impairment,
    perPacketLogging: config.debug,
  });

  // BRIDGE_DRAIN_SECONDS (default 0 = shut down at once, as before): on
  // SIGTERM (a deploy), refuse new connections and let open sessions play on
  // until they end or this long passes; the platform's own grace period
  // (Railway RAILWAY_DEPLOYMENT_DRAINING_SECONDS) must be at least as long.
  // SIGINT, or a second SIGTERM during the drain, shuts down at once.
  const drainMs = Math.max(0, Number(process.env.BRIDGE_DRAIN_SECONDS ?? 0) || 0) * 1000;
  let stopping = false;
  let draining = false;
  const stop = (signal: string) => {
    if (stopping) return;
    if (signal === 'SIGTERM' && drainMs > 0 && !draining) {
      draining = true;
      void bridge.drain(drainMs).then((how) => {
        log('info', 'bridge_drained', { how, sessions: bridge.snapshot().sessions });
        stop('drained');
      });
      return;
    }
    stopping = true;
    log('info', 'bridge_shutdown', { signal, sessions: bridge.snapshot().sessions });
    bridge.shutdown().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGTERM', () => stop(draining ? 'SIGTERM-again' : 'SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', event: 'bridge_start_failed', error: (err as Error).message }));
  process.exit(1);
});
