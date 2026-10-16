/**
 * ac-agent MCP server (stdio) — exposes tools.ts to any MCP client, e.g.
 * every Claude Code session opened in this repo (.mcp.json registers it as
 * "ac"). The protocol is newline-delimited JSON-RPC 2.0; it is small enough
 * to speak directly, so there is no SDK dependency.
 *
 *   npx tsx tools/ac-agent/mcp-server.ts
 */
import { HOSTED_GUIDE } from './hostedGuide.ts';
import { createInterface } from 'node:readline';
import { LOCAL_ONLY_TOOLS, TOOLS, TOOL_BY_NAME, inputSchema, missingRequired, type ToolOutput } from './tools.ts';

const SERVER_INFO = { name: 'acjs-agent', version: '0.1.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

export interface RpcRequest { jsonrpc: '2.0'; id?: number | string | null; method: string; params?: any }

export function toolContent(out: ToolOutput): { content: unknown[]; isError?: boolean } {
  const content: unknown[] = [];
  if (out.jpegBase64) content.push({ type: 'image', data: out.jpegBase64, mimeType: 'image/jpeg' });
  if (out.text) content.push({ type: 'text', text: out.text });
  return out.isError ? { content, isError: true } : { content };
}

/** Handle one request; null for notifications (no reply). */
/**
 * With AC_AGENT_ATTACH set (the Claude Desktop setup), ac_start plays the human's OWN character on the live
 * servers by default; without it, the local test server on the profile's own account (Claude Code / probes).
 */
export function serverInstructions(attach: string | undefined): string {
  const loop = 'then loop: ac_observe → decide → act (ac_walk_to / ac_use / ac_attack / ac_cast / ac_say …) → ac_wait. Guide: docs/agent-play.md.';
  return attach
    ? `Play Asheron's Call as the human's own character on a live server (playwebac.com). Call ac_start with no arguments: it opens (or reuses) a Chrome window where the human logs in and enters the world themselves; tell them to, and wait. Do not pass era/base/profile (those are the local test server). This is their real character: play as a normal player, as they ask, and answer people who talk to you. Then ${loop}`
    : `Play Asheron's Call in this repo's browser client. Start with ac_start, ${loop}`;
}

/** The hosted connector's instructions: the play guide for the player's own open tab (hostedGuide.ts). */
export const HOSTED_INSTRUCTIONS = HOSTED_GUIDE;

/** The hosted connector's routing argument: which linked tab (multiboxing) a tool acts in. */
export const HOSTED_ACCOUNT_PROP = { type: 'string' as const, description: 'Which tab to act in, when this connection plays several accounts (ac_status lists them): the account, or the character in the world there. Leave it out when there is one.' };

/** Hosted tools take `account` (a linked tab) where local ones take `profile` (a local session). */
export function hostedInputSchema(t: Parameters<typeof inputSchema>[0]): Record<string, unknown> {
  const { profile: _p, server: _s, ...rest } = t.props as Record<string, unknown>;
  return inputSchema({ ...t, props: { ...rest, account: HOSTED_ACCOUNT_PROP } as typeof t.props });
}

/** A hosted call's arguments with `account` routed the way the tools read a session (`profile`). */
export function hostedArgs(a: Record<string, unknown>): Record<string, unknown> {
  const pick = a.account ?? a.profile;
  return pick === undefined || pick === null || pick === '' ? { ...a, profile: undefined } : { ...a, profile: String(pick) };
}

export async function handle(req: RpcRequest, opts: { hosted?: boolean } = {}): Promise<unknown | null> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: req.id, error: { code, message } });
  if (req.id === undefined || req.id === null) return null;
  switch (req.method) {
    case 'initialize':
      return reply({
        protocolVersion: req.params?.protocolVersion ?? DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: opts.hosted ? HOSTED_INSTRUCTIONS : serverInstructions(process.env.AC_AGENT_ATTACH),
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.filter((t) => !opts.hosted || !LOCAL_ONLY_TOOLS.has(t.name)).map((t) => ({ name: t.name, description: t.description, inputSchema: opts.hosted ? hostedInputSchema(t) : inputSchema(t) })) });
    case 'tools/call': {
      const tool = TOOL_BY_NAME.get(req.params?.name);
      if (!tool || (opts.hosted && LOCAL_ONLY_TOOLS.has(tool.name))) return fail(-32602, `unknown tool: ${req.params?.name}`);
      try {
        const args = opts.hosted ? hostedArgs(req.params?.arguments ?? {}) : req.params?.arguments ?? {};
        const missing = missingRequired(tool, args);
        if (missing) return reply(toolContent({ text: missing, isError: true }));
        return reply(toolContent(await tool.run(args)));
      } catch (e) {
        return reply(toolContent({ text: `error: ${(e as Error)?.message ?? e}`, isError: true }));
      }
    }
    default:
      return fail(-32601, `method not found: ${req.method}`);
  }
}

function main(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let req: RpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    // Requests run concurrently: an ac_wait must not block an ac_observe from another turn.
    void handle(req).then((r) => { if (r) process.stdout.write(JSON.stringify(r) + '\n'); });
  });
}

if (process.argv[1] && /mcp-server\.ts$/.test(process.argv[1])) main();
