/**
 * probe-two-client-social — the multi-player social flows with two live
 * clients (HARNESS.two-client-social-flows; scorecard flow-social-multiplayer).
 *
 * A (fxprobe1 / Fxprobe) and B (fxprobe2 / Fxprobetwo) meet in Holtburg
 * (tools/lib/two-client.ts), then:
 *   1. presence — each client has the other as a world object
 *   2. tell     — A "/tell <B> …" reaches B; B "/r …" reaches A
 *   3. squelch  — B "/squelch <A>": A's next tell does not show on B;
 *                 B "/unsquelch <A>": the one after does
 *   4. fellowship — A creates one and recruits the selected B; B gets the
 *                 confirmation dialog and clicks Yes; both clients list both
 *                 fellows; A disbands
 *   5. allegiance — B swears to the selected A; A confirms; B's record has A
 *                 as parent and B's Patron talk focus is enabled; B breaks it
 *   6. trade    — A double-clicks B (retail's only way in); both trade
 *                 windows open
 * Each step records pass/fail with the evidence, a screenshot pair goes to
 * verification/two-client/<step>-{a,b}.png, and results.json collects all.
 * Exit 1 when any step fails.
 *
 * Usage: npx tsx tools/probe-two-client-social.ts   (env: see tools/lib/two-client.ts)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { shot } from './lib/game-session.ts';
import { answerDialog, chatLines, LINK_WAIT_MS, openTwoClients, say, sees, waitChat, waitDialog, type Client } from './lib/two-client.ts';

const OUT = 'verification/two-client';
interface Step { step: string; ok: boolean; detail: string }
const steps: Step[] = [];

function record(step: string, ok: boolean, detail: string): void {
  steps.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${detail}`);
}

async function shots(step: string, a: Client, b: Client): Promise<void> {
  await shot(a.page, `${OUT}/${step}-a.png`);
  await shot(b.page, `${OUT}/${step}-b.png`);
}

const fellowNames = (c: Client): Promise<string[]> =>
  c.page.evaluate('(window.__ac.gameUI.fellowship?.fellows ?? []).map((f) => f.name)') as Promise<string[]>;
const tradeOpen = (c: Client): Promise<boolean> =>
  c.page.evaluate('!!window.__ac.gameUI.tradePanel && window.__ac.gameUI.tradePanel.isConnected') as Promise<boolean>;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  // Unique per run so an old line in the chat log can never satisfy a check.
  const run = (process.env.AC_PROBE_RUN ?? String(process.pid)).slice(-5);
  const { a, b, close } = await openTwoClients('two-client');
  try {
    console.log(`A = ${a.name} (0x${a.guid.toString(16)}), B = ${b.name} (0x${b.guid.toString(16)})`);

    // 1. presence
    const aSeesB = await sees(a.page, b.guid), bSeesA = await sees(b.page, a.guid);
    record('presence', aSeesB && bSeesA, `A sees B: ${aSeesB}, B sees A: ${bSeesA}`);

    // 2. tell + reply
    const t1 = `hello-${run}`;
    await say(a.page, `/tell ${b.name}, ${t1}`);
    const gotTell = await waitChat(b.page, new RegExp(t1));
    const t2 = `reply-${run}`;
    await say(b.page, `/r ${t2}`);
    const gotReply = await waitChat(a.page, new RegExp(t2));
    record('tell', !!gotTell && !!gotReply, `B got ${JSON.stringify(gotTell)}; A got ${JSON.stringify(gotReply)}`);
    await shots('tell', a, b);

    // 3. squelch / unsquelch
    await say(b.page, `/squelch ${a.name}`);
    await b.page.waitForTimeout(2000);
    const t3 = `squelched-${run}`;
    await say(a.page, `/tell ${b.name}, ${t3}`);
    const leaked = await waitChat(b.page, new RegExp(t3), 5000);
    await say(b.page, `/unsquelch ${a.name}`);
    await b.page.waitForTimeout(2000);
    const t4 = `unsquelched-${run}`;
    await say(a.page, `/tell ${b.name}, ${t4}`);
    const after = await waitChat(b.page, new RegExp(t4));
    record('squelch', !leaked && !!after, `while squelched B saw ${JSON.stringify(leaked)}; after unsquelch ${JSON.stringify(after)}`);
    await shots('squelch', a, b);

    // 4. fellowship
    // Retail ships "Ignore Fellowship Requests" on; turn it off through the option's own path.
    await b.page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.optionsSettings.ignoreFellowshipRequests = false;
      ui.callbacks.onCharacterOptionToggle?.(0x02, false); })()`);
    await b.page.waitForTimeout(1500);
    await a.page.evaluate(`window.__ac.gameUI.callbacks.onCreateFellowship("Probers${run}")`); // the fellowship panel's Create
    await a.page.waitForTimeout(2500);
    await a.page.evaluate(`window.acDebug.select(${b.guid})`);
    await a.page.waitForTimeout(800);
    await a.page.evaluate('window.__ac.gameUI.callbacks.onFellowshipRecruitSelected()'); // the panel's Recruit
    const invite = await waitDialog(b.page);
    await shots('fellowship-invite', a, b);
    const clicked = invite !== null && await answerDialog(b.page, true);
    // Poll, don't sleep: on a slow link the FellowshipFullUpdate takes a round trip or more.
    const both = (l: string[]) => l.includes(a.name) && l.includes(b.name);
    let fa: string[] = [], fb: string[] = [];
    for (let t = 0; t <= LINK_WAIT_MS; t += 500) {
      fa = await fellowNames(a); fb = await fellowNames(b);
      if (both(fa) && both(fb)) break;
      await b.page.waitForTimeout(500);
    }
    record('fellowship', clicked && both(fa) && both(fb), `invite ${JSON.stringify(invite)}; A lists ${JSON.stringify(fa)}; B lists ${JSON.stringify(fb)}`);
    await shots('fellowship', a, b);
    await a.page.evaluate('window.__ac.gameUI.callbacks.onFellowshipSteps([{ kind: "quit", disband: true }])'); // the panel's Disband
    await a.page.waitForTimeout(2500);

    // 5. allegiance — B swears to the selected A; A gets the SwearAllegiance
    // confirmation and clicks Yes; B's panel shows A as patron; B breaks it.
    await b.page.evaluate(`window.acDebug.select(${a.guid})`);
    await b.page.waitForTimeout(800);
    // The panel's Swear action (RECON.allegiance-commands retired the
    // invented "/allegiance swear" chat command), as its confirm's Yes calls
    // it: with the patron selected when the dialog opened (GameUI swearBtn,
    // MakeSwearConfirmationDialog @ 004927b0). The dialog itself is unit-tested.
    await b.page.evaluate(`window.__ac.gameUI.callbacks.onAllegianceSwear(${a.guid})`);
    const swearAsk = await waitDialog(a.page);
    await shots('allegiance-ask', a, b);
    const swearYes = swearAsk !== null && await answerDialog(a.page, true);
    // B is a direct vassal of the monarch A: the panel shows A under MONARCH
    // (allegianceInfo.patron stays empty when patron == monarch, as retail's
    // UpdatePatronData hides the PATRON section), and the Patron talk focus
    // must be enabled (UpdatePatronData → SetTalkFocusEnabled(4, logged in)).
    let st = { parent: null as string | null, patronFocus: false };
    for (let t = 0; t <= LINK_WAIT_MS; t += 500) {
      st = await b.page.evaluate(`(() => { const ui = window.__ac.gameUI, a = ui.allegianceInfo;
        const self = a && a.members.find((m) => m.guid === a.selfGuid);
        const p = self && a.members.find((m) => m.guid === self.parentGuid);
        return { parent: p ? p.name : null, patronFocus: ui.talkFocusAllegianceState().patron }; })()`) as typeof st;
      if (st.parent === a.name && st.patronFocus) break;
      await b.page.waitForTimeout(500);
    }
    const bInfo = st.parent === a.name ? '' : `; B allegianceInfo ${await b.page.evaluate('JSON.stringify(window.__ac.gameUI.allegianceInfo)')}`;
    record('allegiance', swearYes && st.parent === a.name && st.patronFocus,
      `A asked ${JSON.stringify(swearAsk)}; B's patron record ${JSON.stringify(st.parent)}; Patron talk focus enabled ${st.patronFocus}${bInfo}`);
    await shots('allegiance', a, b);
    await b.page.evaluate(`window.__ac.gameUI.callbacks.onAllegianceBreak(${a.guid})`);
    await b.page.waitForTimeout(3000);

    // 6. trade by double-click. @teletome stood B on A's own spot, so from
    // A's camera B is inside or behind A and the click picks A. Step B aside
    // first, as a player would (retail's default Sidestep Right: C), and
    // check A's click selects B before the double-click.
    await b.page.evaluate('document.activeElement instanceof HTMLElement && document.activeElement.blur()');
    await b.page.keyboard.down('KeyC');
    await b.page.waitForTimeout(700);
    await b.page.keyboard.up('KeyC');
    let at: { x: number; y: number } | null = null, picked = 0;
    for (let t = 0; t <= LINK_WAIT_MS && picked !== b.guid; t += 1000) {
      await a.page.waitForTimeout(1000);
      at = await a.page.evaluate(`window.acDebug.screenPosOf(${b.guid})`) as { x: number; y: number } | null;
      if (!at) continue;
      await a.page.mouse.click(at.x, at.y);
      await a.page.waitForTimeout(300);
      picked = await a.page.evaluate('window.__ac.gameUI.hudState.target?.id ?? 0') as number;
    }
    let ta = false, tb = false;
    if (at && picked === b.guid) {
      await a.page.mouse.dblclick(at.x, at.y);
      // Poll: a lost Use waits for the server's NAK (LINK_WAIT_MS).
      for (let t = 0; t <= LINK_WAIT_MS && !(ta && tb); t += 500) {
        await a.page.waitForTimeout(500);
        ta = await tradeOpen(a); tb = await tradeOpen(b);
      }
    }
    record('trade', ta && tb, `B on A's screen at ${JSON.stringify(at)}, A's click picked ${picked === b.guid ? 'B' : `0x${picked.toString(16)}`}; trade open A: ${ta}, B: ${tb}`);
    await shots('trade', a, b);

    console.log('A chat tail:', JSON.stringify((await chatLines(a.page)).slice(-6)));
    console.log('B chat tail:', JSON.stringify((await chatLines(b.page)).slice(-6)));
  } finally {
    writeFileSync(`${OUT}/results.json`, `${JSON.stringify({ run, steps }, null, 1)}\n`);
    await close();
  }
  const failed = steps.filter((s) => !s.ok);
  console.log(`${steps.length - failed.length}/${steps.length} steps passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
