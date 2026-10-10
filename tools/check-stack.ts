/**
 * ACE Stack Health Check — verifies all components needed for testing.
 *
 * Usage:
 *   npx tsx tools/check-stack.ts          # check only
 *   npx tsx tools/check-stack.ts --fix    # check + start missing components
 */

import { execSync, spawn } from 'child_process';
import { mkdirSync, openSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket } from 'ws';
import * as http from 'http';

const FIX = process.argv.includes('--fix');

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function log(result: CheckResult): void {
  const icon = result.ok ? '\x1b[32m[OK]\x1b[0m  ' : '\x1b[31m[FAIL]\x1b[0m';
  console.log(`  ${icon} ${result.name.padEnd(18)} ${result.detail}`);
  results.push(result);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Docker container check ─────────────────────────────

function checkDocker(containerName: string): CheckResult {
  try {
    const out = execSync(`docker ps --filter name=${containerName} --format "{{.Status}}"`, { encoding: 'utf8' }).trim();
    if (out) {
      return { name: containerName, ok: true, detail: `Running (${out})` };
    }
    // Container exists but stopped?
    const stopped = execSync(`docker ps -a --filter name=${containerName} --format "{{.Status}}"`, { encoding: 'utf8' }).trim();
    if (stopped) {
      if (FIX) {
        execSync(`docker start ${containerName}`);
        return { name: containerName, ok: true, detail: `Started (was: ${stopped})` };
      }
      return { name: containerName, ok: false, detail: `Stopped (${stopped}) — run with --fix to start` };
    }
    return { name: containerName, ok: false, detail: 'Container not found' };
  } catch {
    return { name: containerName, ok: false, detail: 'Docker not available or container not found' };
  }
}

// ─── Bridge health check (returns both bridge and ACE status) ────

interface BridgeHealth {
  bridge: CheckResult;
  ace: CheckResult;
}

function checkBridgeAndAce(): Promise<BridgeHealth> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({
        bridge: { name: 'ws-tcp-bridge', ok: false, detail: 'Not listening on port 9090' },
        ace: { name: 'ACE reachable', ok: false, detail: 'Skipped — bridge not available' },
      });
    }, 3000);

    try {
      const ws = new WebSocket('ws://127.0.0.1:9090');

      ws.on('open', () => {
        ws.send('health');
      });

      ws.on('message', (data) => {
        clearTimeout(timeout);
        try {
          const status = JSON.parse(data.toString());
          const bridgeResult: CheckResult = {
            name: 'ws-tcp-bridge',
            ok: true,
            detail: `Listening on port 9090 (${status.sessions} sessions)`,
          };
          let aceResult: CheckResult;
          if (status.ace === 'ok') {
            aceResult = { name: 'ACE reachable', ok: true, detail: 'Recent UDP response from port 9000' };
          } else {
            // "unknown" means no recent traffic — not necessarily down
            aceResult = { name: 'ACE reachable', ok: false, detail: `ACE status: ${status.ace} — check: docker ps | grep ace-server` };
          }
          resolve({ bridge: bridgeResult, ace: aceResult });
        } catch {
          resolve({
            bridge: { name: 'ws-tcp-bridge', ok: true, detail: 'Listening on port 9090' },
            ace: { name: 'ACE reachable', ok: false, detail: 'Invalid bridge health response' },
          });
        }
        ws.close();
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        resolve({
          bridge: { name: 'ws-tcp-bridge', ok: false, detail: 'Not listening — run: npx tsx services/ws-tcp-bridge/src/bridge.ts' },
          ace: { name: 'ACE reachable', ok: false, detail: 'Skipped — bridge not available' },
        });
      });
    } catch {
      clearTimeout(timeout);
      resolve({
        bridge: { name: 'ws-tcp-bridge', ok: false, detail: 'WebSocket connection failed' },
        ace: { name: 'ACE reachable', ok: false, detail: 'Skipped — bridge not available' },
      });
    }
  });
}

// ─── Vite dev server check ──────────────────────────────
// vite.config.ts sets port 3000, but Vite auto-increments if taken (3001, 3002...)
const VITE_PORTS = [3000, 3001, 3002];

function tryVitePort(port: number): Promise<CheckResult | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 1500);
    const req = http.get(`http://localhost:${port}/`, (res) => {
      clearTimeout(timeout);
      resolve({ name: 'Vite dev', ok: true, detail: `Running on port ${port} (HTTP ${res.statusCode})` });
      res.resume();
    });
    req.on('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

async function checkVite(): Promise<CheckResult> {
  for (const port of VITE_PORTS) {
    const result = await tryVitePort(port);
    if (result) return result;
  }
  return { name: 'Vite dev', ok: false, detail: 'Not running — run: npm run dev' };
}

// ─── Fix helpers ────────────────────────────────────────

/**
 * A detached child whose stdout/stderr are PIPES to this process dies as
 * soon as check-stack exits: the pipe closes and the child's next console
 * write raises EPIPE (2026-08-29: both the bridge and Vite "started and
 * verified" then vanished within seconds). Point the streams at log files so
 * the children genuinely outlive us.
 */
function detachedStdio(name: string): ['ignore', number, number] {
  const dir = join(tmpdir(), 'acjs-stack-logs');
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${name}.log`), 'a');
  return ['ignore', fd, fd];
}

async function fixBridge(): Promise<CheckResult> {
  const child = spawn('npx', ['tsx', 'services/ws-tcp-bridge/src/bridge.ts'], {
    detached: true,
    stdio: detachedStdio('ws-tcp-bridge'),
    cwd: process.cwd(),
  });
  child.unref();

  // Wait briefly and check if the process is still alive
  await sleep(2000);

  // Verify it's actually listening
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ name: 'ws-tcp-bridge', ok: false, detail: 'Spawned but not responding — check logs' });
    }, 3000);

    try {
      const ws = new WebSocket('ws://127.0.0.1:9090');
      ws.on('open', () => {
        clearTimeout(timeout);
        ws.close();
        resolve({ name: 'ws-tcp-bridge', ok: true, detail: 'Started and verified listening' });
      });
      ws.on('error', () => {
        clearTimeout(timeout);
        resolve({ name: 'ws-tcp-bridge', ok: false, detail: 'Spawned but not responding — check port conflicts' });
      });
    } catch {
      clearTimeout(timeout);
      resolve({ name: 'ws-tcp-bridge', ok: false, detail: 'Failed to verify after spawn' });
    }
  });
}

async function fixVite(): Promise<CheckResult> {
  const child = spawn('npm', ['run', 'dev'], {
    detached: true,
    stdio: detachedStdio('vite-dev'),
    cwd: process.cwd(),
  });
  child.unref();

  // Vite takes a moment to start
  await sleep(3000);

  // Verify it's responding on any of the expected ports
  return checkVite().then(result => {
    if (result.ok) return { ...result, detail: `Started and verified — ${result.detail}` };
    return { name: 'Vite dev', ok: false, detail: 'Spawned but not responding — check port conflicts' };
  });
}

// ─── Main ───────────────────────────────────────────────

async function main() {
  console.log(`\n[check-stack] ACE Stack Health Check${FIX ? ' (--fix mode)' : ''}\n`);

  // 1. Docker containers
  log(checkDocker('ace-db'));
  log(checkDocker('ace-server'));

  // 2. Bridge + ACE reachability (single connection)
  const aceDockerOk = results.find(r => r.name === 'ace-server')?.ok ?? false;
  let { bridge: bridgeResult, ace: aceResult } = await checkBridgeAndAce();

  if (!bridgeResult.ok && FIX) {
    bridgeResult = await fixBridge();
    if (bridgeResult.ok) {
      // Re-check ACE now that bridge is up
      const recheck = await checkBridgeAndAce();
      aceResult = recheck.ace;
    }
  }

  // If bridge reports "unknown" (no recent traffic) but Docker confirms ace-server
  // is healthy, trust Docker — bridge just hasn't seen any game clients yet.
  if (!aceResult.ok && aceResult.detail.includes('unknown') && aceDockerOk) {
    aceResult = { name: 'ACE reachable', ok: true, detail: 'Docker healthy (no recent bridge traffic to confirm UDP)' };
  }

  log(bridgeResult);
  log(aceResult);

  // 3. Vite dev server
  let viteResult = await checkVite();
  if (!viteResult.ok && FIX) {
    viteResult = await fixVite();
  }
  log(viteResult);

  // Summary
  const allOk = results.every(r => r.ok);
  console.log('');
  if (allOk) {
    const vitePort = viteResult.detail.match(/port (\d+)/)?.[1] ?? '3000';
    console.log('  All checks passed.');
    console.log(`  URL: http://localhost:${vitePort}/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs`);
  } else {
    const failed = results.filter(r => !r.ok).length;
    console.log(`  ${failed} check(s) failed.${!FIX ? ' Run with --fix to auto-start missing components.' : ''}`);
  }
  console.log('');

  process.exit(allOk ? 0 : 1);
}

main();
