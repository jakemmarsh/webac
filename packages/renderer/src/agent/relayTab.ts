/**
 * AGENT.hosted-mcp-connector — the tab's side of the relay
 * (docs/hosted-agent-connector.md §4.2): a call the bridge sends down the game
 * WebSocket runs on this tab's agent API surface (the same table the local
 * daemon drives through window.__acAgent) and its answer goes back up.
 *
 * - Only while the tab has opted in (`on`); otherwise every call is refused.
 * - One call at a time, in arrival order.
 * - A call past its deadline stops what it set moving and answers an error.
 */
export interface RelayCall { id: number; method: string; args: unknown[]; deadlineMs: number }
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
    this.chain = this.chain.then(() => this.run(call)).catch(() => {});
    return this.chain;
  }

  private reply(id: number, ok: boolean, body: unknown): void {
    let text: string;
    try { text = JSON.stringify({ agentResult: ok ? { id, ok: true, result: body } : { id, ok: false, error: String(body) } }); }
    catch { text = JSON.stringify({ agentResult: { id, ok: false, error: 'the answer could not be sent (not serialisable)' } }); }
    this.send(text);
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
        // A motor task past its deadline is stopped (the player's character shouldn't run on unattended).
        try { (api.stopMoving as (() => unknown) | undefined)?.(); } catch { /* nothing moving */ }
        this.reply(call.id, false, `${call.method} took longer than ${Math.round(call.deadlineMs / 1000)} s and was stopped`);
        return;
      }
      ok = true;
      this.reply(call.id, true, out === undefined ? null : out);
    } catch (e) {
      this.reply(call.id, false, (e as Error)?.message ?? String(e));
    } finally { if (timer) clearTimeout(timer); this.control?.done(call.method, ok, Math.round(this.now() - start)); }
  }
}
