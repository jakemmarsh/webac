/**
 * ac-agent CLI — the same tools as the MCP server, for any shell (a Claude
 * Code session that hasn't loaded the MCP server, a cloud session, a human).
 *
 *   npx tsx tools/ac-agent/cli.ts start [character="Claude Ann"] [headless=true]
 *   npx tsx tools/ac-agent/cli.ts observe [filter=monster]
 *   npx tsx tools/ac-agent/cli.ts walk_to target="42.1N, 33.6E"
 *   npx tsx tools/ac-agent/cli.ts attack target=#80001234
 *   npx tsx tools/ac-agent/cli.ts wait types=target-died timeout_s=30
 *   npx tsx tools/ac-agent/cli.ts screenshot          (writes a .jpg, prints its path)
 *   npx tsx tools/ac-agent/cli.ts help
 *
 * Subcommand = tool name without the "ac_" prefix; args are key=value
 * (a bare first value fills the first required arg: `say "hello"`).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './state.ts';
import { TOOLS, TOOL_BY_NAME, type AgentTool, type ToolOutput } from './tools.ts';

export function parseCliArgs(tool: AgentTool, rest: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const tok of rest) {
    const eq = tok.indexOf('=');
    let key: string;
    let raw: string;
    if (eq > 0 && /^[a-z_]+$/.test(tok.slice(0, eq))) {
      key = tok.slice(0, eq);
      raw = tok.slice(eq + 1);
    } else {
      const firstFree = (tool.required ?? Object.keys(tool.props).filter((k) => k !== 'profile')).find((k) => !(k in out));
      if (!firstFree) throw new Error(`unexpected argument: ${tok}`);
      key = firstFree;
      raw = tok;
    }
    const type = tool.props[key]?.type;
    if (!type) throw new Error(`${tool.name}: unknown argument "${key}" (have: ${Object.keys(tool.props).join(', ')})`);
    out[key] = type === 'number' ? Number(raw) : type === 'boolean' ? /^(1|true|yes)$/i.test(raw) : raw;
  }
  return out;
}

/**
 * What the CLI prints for a tool's output: a screenshot is saved (`save` returns its path) and the path printed,
 * then the text beside it. ac_look's observation was dropped and only the path printed (2026-10-11).
 */
export function cliOutput(out: ToolOutput, save: (jpegBase64: string) => string): string {
  if (!out.jpegBase64) return out.text;
  const path = save(out.jpegBase64);
  return out.text && out.text !== 'screenshot' ? `${path}\n${out.text}` : path;
}

function help(): string {
  return TOOLS.map((t) => {
    const args = Object.entries(t.props).filter(([k]) => k !== 'profile')
      .map(([k]) => ((t.required ?? []).includes(k) ? `${k}=…` : `[${k}=…]`)).join(' ');
    return `${t.name.replace(/^ac_/, '').padEnd(14)} ${args}\n${' '.repeat(15)}${t.description}`;
  }).join('\n');
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(help());
    return;
  }
  const tool = TOOL_BY_NAME.get(`ac_${cmd}`) ?? TOOL_BY_NAME.get(cmd);
  if (!tool) throw new Error(`unknown command "${cmd}" (try help)`);
  const out = await tool.run(parseCliArgs(tool, rest));
  console.log(cliOutput(out, (b64) => {
    const f = join(STATE_DIR, `screenshot-${Date.now()}.jpg`);
    writeFileSync(f, Buffer.from(b64, 'base64'));
    return f;
  }));
  if (out.isError) process.exitCode = 1;
}

if (process.argv[1] && /cli\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`error: ${(e as Error)?.message ?? e}`);
    process.exit(1);
  });
}
