/**
 * probe-press-sounds-combat-text-sky-fog — live check for three retail
 * fidelity fixes (2026-09-28):
 *
 *  1. BUG.ui-buttonpress-on-every-button — a mouse-down on a UI element plays
 *     its own layout Sound media on the state the press enters (retail
 *     MediaMachine::Update_Sound), nothing else. Surveys every visible
 *     `data-element-id` node (HUD, then with the inventory / character /
 *     options panels open): which resolve to a sounding press, which to a
 *     silent Pressed state; then REAL mouse presses on a few of each and on
 *     an untagged HTML button, recording SoundPlayer.playGameSound.
 *  2. BUG.floating-damage-numbers-invented — melee on an @create'd drudge:
 *     no #floating-text layer, no world-anchored text; the combat lines are
 *     in chat.
 *  3. BUG.sky-emitters-fog-on-environs — the sky cell's emitters are
 *     unfogged, fogged under `@setlbenviron RedFog`, unfogged after the clear.
 *
 *   AC_ACCOUNT=fxprobe3 AC_PASSWORD=fxprobe3 AC_BASE=http://localhost:3217/ \
 *     npx tsx tools/probe-press-sounds-combat-text-sky-fog.ts [--gpu]
 *
 * Output: verification/press-sounds-combat-text-sky-fog/ (report.json + jpg).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { openSession, gameUrl, waitForWorld, waitForCharSelect, adminCommand, sessionArgs, REPO } from './lib/game-session.js';

const argv = process.argv.slice(2);
const OUT = `${REPO}/verification/press-sounds-combat-text-sky-fog`;

const HOOK = `(() => {
  const rec = window.__pp = { ui: [], chat: [] };
  const gu = window.__ac.gameUI;
  const origMsg = gu.addSystemMessage.bind(gu);
  gu.addSystemMessage = (text, ...rest) => { rec.chat.push(String(text)); return origMsg(text, ...rest); };
  const sp = window.__ac.soundPlayer;
  const orig = sp.playGameSound.bind(sp);
  sp.playGameSound = (table, sound, cat, vol) => { rec.ui.push({ table: '0x' + (table >>> 0).toString(16), sound, t: Math.round(performance.now()) }); return orig(table, sound, cat, vol); };
  return 'hooked';
})()`;

// Every visible, hittable layout element: what a press on it would play.
// (playPressSounds also plays it — the survey's sounds are discarded.)
const SURVEY = `(() => {
  const gu = window.__ac.gameUI;
  const out = [];
  for (const el of document.querySelectorAll('[data-element-id]')) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(hit === el || el.contains(hit))) continue;
    const layout = el.closest('[data-layout-id]');
    const sounds = gu.playPressSounds(hit);
    out.push({ id: el.dataset.elementId, layout: layout ? layout.dataset.layoutId : null, state: el.dataset.acState || null,
      inGameUI: !!el.closest('#game-hud, #screen-container') || gu.hudContainer?.contains?.(el) || false,
      x: Math.round(cx), y: Math.round(cy), sounds: sounds.map((s) => s.sound) });
  }
  window.__pp.ui.length = 0;
  return out;
})()`;

// Clickable things (cursor: pointer, hittable) a press resolves to NO layout
// element — hand-built DOM; each is either an invention or needs a tag.
const UNTAGGED = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('div, button, span, canvas, img')) {
    if (getComputedStyle(el).cursor !== 'pointer') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(hit === el || el.contains(hit))) continue;
    let tagged = false;
    for (let n = hit; n; n = n.parentElement) { if (n.dataset && n.dataset.layoutId) { tagged = true; break; } }
    if (tagged) continue;
    let panel = '';
    for (let n = el; n; n = n.parentElement) { if (n.id) { panel = n.id; break; } }
    out.push({ panel, tag: el.tagName, cls: String(el.className || '').slice(0, 30), title: el.title || '', text: (el.textContent || '').trim().slice(0, 24), x: Math.round(cx), y: Math.round(cy) });
  }
  return out;
})()`;

interface Hit { id: string; layout: string | null; state: string | null; x: number; y: number; sounds: number[] }

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await openSession(sessionArgs(argv));
  const page = s.page;
  const chat: string[] = [];
  page.on('console', (m) => { const x = m.text(); if (/damage|evade|evades/i.test(x)) chat.push(x.slice(0, 160)); });
  const report: Record<string, unknown> = {};

  // ── 0. pre-world: character select + chargen (hand-built buttons tagged
  //    with their 0x21000004 / 0x21000046 / 0x2100003a elements) ────────
  const preUrl = gameUrl({ cb: 'probe-press-fog-pre', autoenter: false });
  await page.goto(preUrl, { waitUntil: 'domcontentloaded' });
  if (await waitForCharSelect(page, { url: preUrl })) {
    await page.waitForTimeout(2000);
    const hasUi = await page.evaluate('!!(window.__ac && window.__ac.gameUI)');
    const pre: Array<{ what: string; sounds: unknown }> = [];
    // playPressSounds is exactly what the document mousedown listener runs.
    const pressAt = async (sel: string): Promise<void> => {
      const r = await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
        const b = e.getBoundingClientRect(); const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        const gu = window.__ac && window.__ac.gameUI; return { tag: e.dataset.acPress || null, state: e.dataset.acState || null,
          sounds: gu ? gu.playPressSounds(h).map((x) => x.sound) : 'no __ac' }; })()`);
      pre.push({ what: sel, sounds: r });
    };
    for (const sel of ['#btn-create-character', '#charsel-inner button:nth-of-type(2)', '#charsel-inner button:nth-of-type(3)']) await pressAt(sel);
    await page.screenshot({ path: `${OUT}/charselect.jpg` });
    await page.evaluate(`document.getElementById('btn-create-character')?.click()`);
    await page.waitForTimeout(4000);
    for (const sel of ['.heritage-btn', '#btn-back', '#btn-next']) await pressAt(sel);
    await page.screenshot({ path: `${OUT}/chargen.jpg` });
    for (const p of pre) console.log(`preworld press ${p.what}: ${JSON.stringify(p.sounds)}`);
    report.preworld = { hasUi, presses: pre };
  } else {
    console.log('preworld: never reached character select');
  }

  const url = gameUrl({ cb: 'probe-press-fog' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!(await waitForWorld(page, { url }))) throw new Error('never entered the world');
  await page.waitForTimeout(4000);
  await page.mouse.click(780, 120); // user gesture → AudioContext
  await page.waitForTimeout(500);
  console.log(await page.evaluate(HOOK));

  // ── 1. press sounds ──────────────────────────────────────────────
  const surveys: Record<string, Hit[]> = {};
  surveys.hud = await page.evaluate(SURVEY) as Hit[];
  await page.evaluate('window.__ac.gameUI.toggleInventory()');
  await page.waitForTimeout(1500);
  surveys.inventory = await page.evaluate(SURVEY) as Hit[];
  const summarize = (hs: Hit[]) => ({
    visible: hs.length,
    sounding: hs.filter((h) => h.sounds.length > 0).map((h) => `${h.layout}:${h.id}`),
    silent: hs.filter((h) => h.sounds.length === 0).length,
  });
  for (const [k, v] of Object.entries(surveys)) console.log(`survey ${k}:`, JSON.stringify(summarize(v)));
  // Untagged clickables, per panel.
  const untagged: Record<string, unknown[]> = {};
  untagged.hudAndInventory = await page.evaluate(UNTAGGED) as unknown[];
  await page.evaluate('window.__ac.gameUI.toggleInventory()');
  for (const panel of ['toggleCharPanel', 'toggleMagicPanel', 'toggleSocialPanel', 'toggleMapPanel', 'toggleOptionsPanel']) {
    await page.evaluate(`window.__ac.gameUI.${panel}()`);
    await page.waitForTimeout(1200);
    const hs = await page.evaluate(SURVEY) as Hit[];
    surveys[panel] = hs;
    untagged[panel] = await page.evaluate(UNTAGGED) as unknown[];
    console.log(`survey ${panel}:`, JSON.stringify(summarize(hs)));
    await page.evaluate(`window.__ac.gameUI.${panel}()`);
    await page.waitForTimeout(500);
  }
  for (const [k, v] of Object.entries(untagged)) console.log(`untagged ${k}: ${JSON.stringify(v)}`);
  report.untagged = untagged;
  await page.evaluate('window.__ac.gameUI.toggleInventory()');
  await page.waitForTimeout(800);

  // Real presses: up to 4 sounding elements, up to 4 silent ones.
  const all = [...surveys.hud, ...surveys.inventory];
  const uniq = (hs: Hit[]) => [...new Map(hs.map((h) => [`${h.layout}:${h.id}`, h])).values()];
  // The chat window's number buttons + a few others; the chat entry bar
  // (0x1000046f, focuses the input) last.
  const sounding = uniq(all.filter((h) => h.sounds.length > 0 && !/^0x21000016/.test(h.layout ?? '')))
    .sort((a, b) => (a.id === '0x1000046f' ? 1 : 0) - (b.id === '0x1000046f' ? 1 : 0)).slice(-6);
  const silent = uniq(all.filter((h) => h.sounds.length === 0)).slice(0, 4);
  const presses: Array<{ what: string; expect: number; got: Array<{ table: string; sound: number }>; stale?: boolean }> = [];
  const press = async (h: Hit, what: string): Promise<void> => {
    await page.evaluate('window.__pp.ui.length = 0');
    await page.mouse.move(h.x, h.y);
    // What is under the cursor NOW (a previous press may have moved things).
    const under = await page.evaluate(`(() => { const e = document.elementFromPoint(${h.x}, ${h.y}); const c = [];
      for (let n = e; n; n = n.parentElement) { if (n.dataset && (n.dataset.elementId || n.dataset.layoutId)) c.push((n.dataset.layoutId ? 'L' + n.dataset.layoutId : '') + (n.dataset.elementId || '') + (n.dataset.acState ? '/s' + n.dataset.acState : '')); }
      return (e ? e.tagName + '#' + (e.id || '') : 'none') + ' ' + c.join(' < '); })()`);
    await page.mouse.down();
    await page.waitForTimeout(150);
    const got = await page.evaluate('window.__pp.ui.slice()') as Array<{ table: string; sound: number }>;
    await page.mouse.up();
    await page.waitForTimeout(400);
    // Undo whatever the click toggled (panels) so later presses see the same screen.
    // A surveyed element that a previous press covered / closed is stale.
    const stale = h.layout !== null && !String(under).includes(h.id);
    presses.push({ what: `${what} ${h.layout}:${h.id} @${h.x},${h.y} [${under}]`, expect: h.sounds.length, got, stale });
  };
  // Silent first: a press that opens a panel could cover the rest.
  for (const h of silent) await press(h, 'silent');
  for (const h of sounding) await press(h, 'sounding');
  // The hand-built classic toolbar, tagged 0x21000016: Char opens (state 1 →
  // 3: sound), Char again closes (state 6 → 8: silent).
  const tb = async (id: string): Promise<Hit | null> => page.evaluate(`(() => { const e = document.getElementById('${id}'); if (!e) return null; const r = e.getBoundingClientRect();
    return { id: '${id}', layout: e.dataset.acPress || null, state: e.dataset.acState || null, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), sounds: [] }; })()`) as Promise<Hit | null>;
  for (const id of ['tb-char', 'tb-char', 'tb-inv', 'tb-inv', 'tb-examine']) {
    const h = await tb(id);
    if (h) await press({ ...h, sounds: h.state === '6' ? [] : [114] }, `toolbar(${h.state})`);
  }
  // An untagged HTML button (no layout element) is silent.
  await page.evaluate(`(() => { const b = document.createElement('button'); b.id = 'probe-plain-button'; b.textContent = 'plain';
    Object.assign(b.style, { position: 'fixed', left: '10px', top: '200px', zIndex: 99999 }); document.body.appendChild(b); })()`);
  const pb = await page.evaluate(`(() => { const r = document.getElementById('probe-plain-button').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`) as { x: number; y: number };
  await press({ id: 'plain-button', layout: null, state: null, x: pb.x, y: pb.y, sounds: [] }, 'untagged');
  for (const p of presses) console.log(`press ${p.what}: expect ${p.expect ? 'ButtonPress' : 'silence'}, got ${JSON.stringify(p.got)}${p.stale ? ' (stale — element no longer under the cursor)' : ''}`);
  report.surveys = Object.fromEntries(Object.entries(surveys).map(([k, v]) => [k, { ...summarize(v), all: v }]));
  report.presses = presses;
  report.pressMismatches = presses.filter((p) => !p.stale && (p.expect > 0) !== (p.got.length > 0)).map((p) => p.what);
  console.log('press mismatches (non-stale):', JSON.stringify(report.pressMismatches));

  // ── 3. sky emitters under Environs fog ──────────────────────────
  await page.keyboard.press('Escape');
  await adminCommand(page, '@god');
  await page.waitForTimeout(1500);
  await adminCommand(page, '@telepoi holtburg');
  await page.waitForTimeout(25_000);
  await page.mouse.move(700, 300);
  const skyFog = `(() => { const p = window.__ac.physicsScriptPlayer; const out = [];
    for (const s of p.skyEmitters) { const f = []; s.object3D.traverse((o) => { if (o.isMesh) f.push(o.material.fog); });
      out.push({ name: s.object3D.name, fogEnabled: s.fogEnabled, additive: s.draws.map((d) => d.surface.additive), materialFog: f }); }
    const sm = { fogged: 0, unfogged: 0 }; const g = window.__ac.skybox && window.__ac.skybox.skyObjectsGroup; if (g) g.traverse((o) => { if (o.isMesh) { if (o.material.fog) sm.fogged++; else sm.unfogged++; } });
    return { override: p.skyFogOverrideActive, sceneFog: !!window.__ac.sceneManager.scene.fog, envFog: window.__ac.sceneManager.hasEnvironFog, skyObjectMeshes: sm, emitters: out }; })()`;
  const fogBefore = await page.evaluate(skyFog);
  await page.screenshot({ path: `${OUT}/sky-before.jpg` });
  await adminCommand(page, '@setlbenviron RedFog');
  await page.waitForTimeout(4000);
  const fogOn = await page.evaluate(skyFog);
  await page.screenshot({ path: `${OUT}/sky-redfog.jpg` });
  await adminCommand(page, '@setlbenviron');
  await page.waitForTimeout(4000);
  const fogCleared = await page.evaluate(skyFog);
  await page.screenshot({ path: `${OUT}/sky-cleared.jpg` });
  console.log('sky fog before:', JSON.stringify(fogBefore));
  console.log('sky fog RedFog:', JSON.stringify(fogOn));
  console.log('sky fog cleared:', JSON.stringify(fogCleared));
  report.skyFog = { before: fogBefore, redFog: fogOn, cleared: fogCleared };

  // ── 2. no floating combat text ───────────────────────────────────
  await adminCommand(page, '@create 7089');
  await page.waitForTimeout(4000);
  const drudge = await page.evaluate(`(() => { const me = window.__ac.playerModel.position;
    const o = [...window.__ac.serverObjectManager.objects.values()].filter((o) => /drudge/i.test(o.name || ''))
      .sort((a, b) => Math.hypot(a.worldX - me.x, a.worldZ - me.z) - Math.hypot(b.worldX - me.x, b.worldZ - me.z))[0];
    return o ? { guid: o.guid, name: o.name, d: Math.hypot(o.worldX - me.x, o.worldZ - me.z) } : null; })()`) as { guid: number; name: string; d: number } | null;
  console.log('drudge', JSON.stringify(drudge));
  const shots: string[] = [];
  if (drudge) {
    await page.evaluate(`window.acDebug.select(${drudge.guid})`);
    await page.waitForTimeout(500);
    for (let i = 0; i < 8; i++) {
      await page.evaluate(`window.acDebug.attack(${drudge.guid})`);
      await page.waitForTimeout(2500);
      if (i === 1 || i === 4) { const f = `${OUT}/combat-${i}.jpg`; await page.screenshot({ path: f, type: 'jpeg', quality: 70 }); shots.push(f.slice(REPO.length + 1)); }
    }
  }
  const chatLines = await page.evaluate(`window.__pp.chat.filter((t) => /damage|evade|points/i.test(t)).slice(-12)`) as string[];
  const floating = await page.evaluate(`({ layer: !!document.getElementById('floating-text'),
    worldText: [...document.body.querySelectorAll('div')].filter((d) => /^-?\\+?\\d+( XP)?$|^(Evade|Resist|Protected)!$/.test((d.textContent || '').trim()) && getComputedStyle(d).position === 'absolute' && d.closest('#game-hud') === null).length })`);
  console.log('floating text:', JSON.stringify(floating), 'combat chat lines:', chatLines.length);
  report.combat = { drudge, floating, chatLines, consoleDamageLines: chat.slice(-12), shots };

  await adminCommand(page, '@ungod');
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await s.browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
