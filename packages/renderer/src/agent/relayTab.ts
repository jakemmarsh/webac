/**
 * AGENT.hosted-mcp-connector — the tab's side of the relay
 * (docs/hosted-agent-connector.md §4.2): a call the bridge sends down the game
 * WebSocket runs on this tab's agent API surface (the same table the local
 * daemon drives through window.__acAgent) and its answer goes back up.
 *
 * - Only while the tab has opted in (`on`); otherwise every call is refused.
 * - Acting calls one at a time, in arrival order; reading calls (READ_METHODS)
 *   answer at once, so an observe never waits behind a long walk (Claude
 *   sends calls in parallel, and a queued one timed out on Claude's side).
 * - An acting call past its deadline keeps going in the game and answers
 *   "still in progress" (ok): the hosted connector keeps every call under
 *   Claude's tool timeout, and the task's own task-done event (ac_wait)
 *   reports the end. Stopping it there made a 30 m walk to a vendor a
 *   failure (Jake, 2026-10-10: Claude gave up after "use" failed at 60 s).
 */
import { READ_METHODS } from './claudeControl.js';

export interface RelayCall { id: number; method: string; args: unknown[]; deadlineMs: number }

/**
 * The bridge caps one WebSocket message at 64 KB (BRIDGE_MAX_PAYLOAD), sized for game packets; a
 * screenshot answer is bigger, and one past the cap made the bridge close the game's connection
 * (2026-10-10). Answers longer than this go up as {"agentResultPart":{id,i,n,data}} slices of the
 * same JSON text, which the bridge joins back (relay.ts).
 */
export const RESULT_PART_CHARS = 48_000;
type Surface = Record<string, unknown>;

export class TabRelay {
  on = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly send: (text: string) => void,
    private readonly surface: () => Surface | null,
    /** The player-and-Claude rules (agent/claudeControl.ts): a refusal before a call, the history after. */
    private readonly control: { gate(method: string): string | null; done(method: string, ok: boolean, ms: number): void } | null = null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The tab's relay state, for the bridge (sent on login, on change and every few seconds). */
  sendState(character: string | null, screen: string | null, revokedBefore = 0): void {
    this.send(JSON.stringify({ agentState: { relay: this.on ? 'on' : 'off', character, screen, ...(revokedBefore ? { revokedBefore } : {}) } }));
  }

  handle(call: RelayCall): Promise<void> {
    if (READ_METHODS.has(call.method)) return this.run(call).catch(() => {});
    this.chain = this.chain.then(() => this.run(call)).catch(() => {});
    return this.chain;
  }

  private reply(id: number, ok: boolean, body: unknown): void {
    let text: string;
    try { text = JSON.stringify({ agentResult: ok ? { id, ok: true, result: body } : { id, ok: false, error: String(body) } }); }
    catch { text = JSON.stringify({ agentResult: { id, ok: false, error: 'the answer could not be sent (not serialisable)' } }); }
    if (text.length <= RESULT_PART_CHARS) { this.send(text); return; }
    const n = Math.ceil(text.length / RESULT_PART_CHARS);
    for (let i = 0; i < n; i++) this.send(JSON.stringify({ agentResultPart: { id, i, n, data: text.slice(i * RESULT_PART_CHARS, (i + 1) * RESULT_PART_CHARS) } }));
  }

  private async run(call: RelayCall): Promise<void> {
    const api = this.surface();
    if (!this.on || !api) { this.reply(call.id, false, 'Claude is switched off in this tab'); return; }
    const fn = api[call.method];
    if (typeof fn !== 'function' || call.method.startsWith('_')) { this.reply(call.id, false, `unknown method ${call.method}`); return; }
    const refused = this.control?.gate(call.method) ?? null;
    if (refused) { this.control?.done(call.method, false, 0); this.reply(call.id, false, refused); return; }
    const start = this.now();
    let ok = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<'deadline'>((ok) => { timer = setTimeout(() => ok('deadline'), Math.max(1000, call.deadlineMs)); });
    try {
      const out = await Promise.race([Promise.resolve((fn as (...a: unknown[]) => unknown)(...call.args)), deadline]);
      if (out === 'deadline') {
        const s = Math.round(call.deadlineMs / 1000);
        if (READ_METHODS.has(call.method)) { this.reply(call.id, false, `${call.method} took longer than ${s} s`); return; }
        // Still walking / using: it keeps going (the player can always take over); its task-done event says when it ends.
        ok = true;
        this.reply(call.id, true, { ok: true, message: `${call.method} is still in progress after ${s} s and keeps going: ac_wait types=task-done to hear when it finishes, or ac_observe to see where you are` });
        return;
      }
      ok = true;
      this.reply(call.id, true, out === undefined ? null : out);
    } catch (e) {
      this.reply(call.id, false, (e as Error)?.message ?? String(e));
    } finally { if (timer) clearTimeout(timer); this.control?.done(call.method, ok, Math.round(this.now() - start)); }
  }
}
