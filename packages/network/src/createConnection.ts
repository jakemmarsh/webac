/**
 * The one place a session connection is constructed (the page's in-thread
 * path in main.ts and the network Worker's hostClientConnection both call it),
 * so the profile alone decides the wire protocol: ClientConnection for end of
 * retail and every classic server (the default, unchanged), Connection1999 for
 * a 1999-protocol server (LoginProfile.protocol === 'ac1999';
 * docs/ac1999-support-scope.md Phase 1).
 */
import { ClientConnection } from './ClientConnection.js';
import { Connection1999 } from './era1999/Connection1999.js';
import type { LoginProfile } from './LoginProfile.js';
import type { NetConnection } from './NetWorker.js';

export function createConnection(url: string, opts: { loginProfile?: LoginProfile } = {}): NetConnection {
  if (opts.loginProfile?.protocol === 'ac1999') return new Connection1999(url, opts);
  return new ClientConnection(url, opts);
}
