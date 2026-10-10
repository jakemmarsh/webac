/**
 * AGENT.hosted-mcp-connector — the bridge's MCP endpoint (Streamable HTTP:
 * JSON-RPC over POST /mcp, JSON answers; docs/hosted-agent-connector.md §3).
 * Step 1 of its build plan: a bearer token from the bridge's config names the
 * account it plays (BRIDGE_MCP_DEV_TOKENS); OAuth pairing comes later. The
 * same tool table as the local ac-agent MCP server, less the tools that need
 * the local daemon, each call relayed to the account's own open tab.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handle, type RpcRequest } from '../../../tools/ac-agent/mcp-server.js';
import { TOOL_CALLER, type ToolCaller } from '../../../tools/ac-agent/tools.js';
import type { AgentRelay } from './relay.ts';

/** "token=server:account,token2=server:account2" → token → account key. */
export function parseMcpTokens(spec: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const token = part.slice(0, i).trim();
    const key = part.slice(i + 1).trim();
    const j = key.lastIndexOf(':');
    if (token.length < 16 || j < 1) continue;
    out.set(token, `${key.slice(0, j)}:${key.slice(j + 1).toLowerCase()}`);
  }
  return out;
}

const MAX_BODY = 1 << 20;
export const HOSTED_MAX_WAIT_MS = 25_000;

/**
 * A grant for some characters plays only those: refused while another is in
 * the world, and ac_enter_world may only name one of them. With nobody in the
 * world (character select) the reading tools still answer.
 */
export function scopeRefusal(scope: 'any' | string[], inWorld: string | null, method: string, args: unknown[]): string | null {
  if (scope === 'any') return null;
  const ok = (n: string) => scope.some((c) => c.toLowerCase() === n.trim().toLowerCase());
  if (method === 'enterWorld') return ok(String(args[0] ?? '')) ? null : `this connection plays only ${scope.join(', ')}`;
  if (inWorld && !ok(inWorld)) return `this connection plays only ${scope.join(', ')}; ${inWorld} is in the world`;
  return null;
}

/** Who a bearer token plays: its account key and, for a paired grant, its character scope. */
export type McpAuth = (token: string) => { key: string; scope: 'any' | string[]; createdAt?: number } | null;

export async function handleMcp(req: IncomingMessage, res: ServerResponse, auth0: McpAuth, relay: AgentRelay, resourceMetadata: string | null = null): Promise<void> {
  const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  const who = auth ? auth0(auth[1]) : null;
  if (!who) { send(401, { error: 'unauthorized' }, { 'www-authenticate': resourceMetadata ? `Bearer resource_metadata="${resourceMetadata}"` : 'Bearer' }); return; }
  const key = who.key;
  if (req.method !== 'POST') { send(405, { error: 'POST JSON-RPC to /mcp' }, { allow: 'POST' }); return; }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) { send(413, { error: 'too large' }); return; } chunks.push(c as Buffer); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
  const caller: ToolCaller = {
    notice: null,
    // Below claude.ai's per-call tool timeout (undocumented; docs/hosted-agent-connector.md §3).
    maxWaitMs: HOSTED_MAX_WAIT_MS,
    connection: () => {
      const e = relay.entry(key);
      return { account: key.slice(key.lastIndexOf(':') + 1), characters: who.scope, tab: !e ? 'none' : e.relayOn ? 'on' : 'off', character: e?.character ?? null, screen: e?.screen ?? null };
    },
    call: <T>(method: string, args?: unknown[], timeoutMs?: number) => {
      const e = relay.entry(key);
      // The tab unpaired after this grant was made (it remembers across bridge restarts).
      if (who.createdAt !== undefined && e && who.createdAt < e.revokedBefore) return Promise.reject(new Error('this connection was disconnected in the game (/automation unpair); connect Claude again'));
      const why = scopeRefusal(who.scope, e?.character ?? null, method, args ?? []);
      if (why) return Promise.reject(new Error(why));
      return relay.call(key, method, args ?? [], timeoutMs ?? 30_000) as Promise<T>;
    },
  };
  const one = (r: unknown) => TOOL_CALLER.run(caller, () => handle(r as RpcRequest, { hosted: true }));
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(one))).filter((x) => x !== null);
    if (!out.length) send(202); else send(200, out);
    return;
  }
  const r = await one(body);
  if (r === null) send(202); else send(200, r);
}
