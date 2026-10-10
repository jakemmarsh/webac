/**
 * Live check: what one player sees of another over time (screenshots every
 * ~0.5 s into SHOTS). MODE=buff (default): A casts Armor Other I on B.
 * MODE=arrive: B teleports in 4 m in front of A (the portal-space Hide figure
 * must clear when B arrives). MODE=together: both teleport into a dungeon at
 * once. Accounts mveraeor / mveraobs2 on local ACE (admin).
 *
 *   SHOTS=<dir> AC_BASE=http://localhost:<vite>/ AC_BRIDGE=ws://localhost:<bridge> MODE=arrive \
 *     npx tsx tools/observer-effects-check.ts
 */
import { adminCommand, enterWorld, createCharacterIfNeeded } from './lib/game-session.ts';
const base = process.env.AC_BASE!, bridge = process.env.AC_BRIDGE!, shots = process.env.SHOTS!;
const log = (m: string) => console.log(`[buff] ${m}`);
// ERA=<era id> (tools/ac-agent/eras.ts) with that era's bridge; ACCT_A / ACCT_B name admin accounts there.
const era = process.env.ERA ? `&era=${process.env.ERA}` : '';
const template = process.env.ERA === 'ac1999-retail' ? 'Archer' : 'Bow Hunter';
const open = async (acct: string, name: string) => enterWorld({ url: `${base}?ace&agent&bridge=${bridge}&account=${acct}&password=${acct}${era}&cb=buff-${acct}${process.env.AC_EXTRA_QUERY ? '&' + process.env.AC_EXTRA_QUERY : ''}`, settleMs: 5000, gpu: true, onPoll: createCharacterIfNeeded(name, process.env.ERA ? { template } : {}) });
const settle = async (page: import('playwright').Page) => { await page.waitForTimeout(1500); for (let i = 0; i < 80 && !(await page.evaluate('window.acDebug.collisionState().loginComplete')); i++) await page.waitForTimeout(250); await page.waitForTimeout(3000); };
const A = await open(process.env.ACCT_A ?? 'mveraeor', 'Mvera Bow');
const B = await open(process.env.ACCT_B ?? 'mveraobs2', 'Mvera Two');
const bGuid = await B.page.evaluate('window.__ac.charGuid') as number;
A.page.on('console', (m) => { const t = m.text(); if ((/PScript|PlayEffect|Hidden|cast|Cast|spell|SetState|state/i.test(t) && t.includes(bGuid.toString(16))) || /PScript 0x7[56] /.test(t)) log(`A console: ${t.slice(0, 200)}`); });
try {
  await adminCommand(A.page, '@teleloc 0xA9B00025 [102 100 70] 1 0 0 0'); await settle(A.page);
  if (process.env.MODE === 'together') {
    // Both elsewhere, then both teleport into the dungeon at once (a fellowship through one portal).
    await adminCommand(A.page, '@teleloc 0xA9B40019 [84 7.1 94] 1 0 0 0'); await adminCommand(B.page, '@teleloc 0xA9B40019 [86 7.1 94] 1 0 0 0');
    await settle(A.page); await settle(B.page);
    await Promise.all([adminCommand(A.page, '@teleloc 0x01030375 [100 -214 0.005] 1 0 0 0'), adminCommand(B.page, '@teleloc 0x01030375 [100 -210 0.005] 0 0 0 1')]);
    await settle(A.page);
  } else if (process.env.MODE === 'lost-cell') {
    // A in the dungeon; B portals in while A's client holds B's cell "not loaded" (the window a
    // dungeon load opens) until B's UnHide has arrived: set_hidden's script must still land.
    // LOST_OUTDOORS=1: Holtburg instead of the dungeon (a world without dungeon 0x0103).
    const [destA, destB] = process.env.LOST_OUTDOORS
      ? ['@teleloc 0xA9B00025 [102 100 70] 1 0 0 0', '@teleloc 0xA9B00025 [102 104 70] 0 0 0 1']
      : ['@teleloc 0x01030375 [100 -214 0.005] 1 0 0 0', '@teleloc 0x01030375 [100 -210 0.005] 0 0 0 1'];
    await adminCommand(A.page, destA); await settle(A.page);
    await adminCommand(B.page, '@teleloc 0xA9B40019 [84 7.1 94] 1 0 0 0'); await settle(B.page);
    await A.page.evaluate(`(() => {
      const som = window.__ac.serverObjectManager; const orig = som.updateObjectMaint.bind(som);
      window.__held = { guid: ${bGuid}, phase: 'wait-hidden', unhiddenAt: 0 };
      som.updateObjectMaint = (isLoaded, now) => {
        const h = window.__held; const o = som.getObject(h.guid);
        if (o && h.phase === 'wait-hidden' && (o.physicsState & 0x4000)) h.phase = 'holding';
        if (o && h.phase === 'holding' && !(o.physicsState & 0x4000)) { h.phase = 'unhidden'; h.unhiddenAt = now; }
        if (h.phase === 'unhidden' && now - h.unhiddenAt > 1) h.phase = 'released';
        const hold = o && (h.phase === 'holding' || h.phase === 'unhidden') ? o.objCellId : -1;
        return orig((c) => c !== hold && isLoaded(c), now);
      };
    })()`);
    await adminCommand(B.page, destB);
    await settle(B.page);
    log(`hold phase: ${JSON.stringify(await A.page.evaluate('window.__held'))}`);
  } else if (process.env.MODE === 'portal') {
    // Both walk through one real portal (portalwhiteratnest 0x7A8B1000 → dungeon 0x01DD), B a beat after A.
    await adminCommand(A.page, '@teleloc 0xA8B10006 [4 137 56.6] 1 0 0 0'); await adminCommand(B.page, '@teleloc 0xA8B10006 [1 137 56.6] 1 0 0 0');
    await settle(A.page); await settle(B.page);
    // ORDER=b-first: the watched player B goes through first; GAP_MS between the two uses (0 = together).
    const [first, second] = process.env.ORDER === 'b-first' ? [B, A] : [A, B];
    const firstUse = first.page.evaluate('window.__acAgent.use(0x7A8B1000)');
    await A.page.waitForTimeout(Number(process.env.GAP_MS ?? 1500));
    await Promise.all([firstUse, second.page.evaluate('window.__acAgent.use(0x7A8B1000)')]);
    await settle(A.page); await settle(B.page);
  } else if (process.env.MODE === 'arrive') {
    // B far away, then B teleports in 4 m in front of A while A watches.
    await adminCommand(B.page, '@teleloc 0xA9B40019 [84 7.1 94] 1 0 0 0'); await settle(B.page);
    await adminCommand(B.page, '@teleloc 0xA9B00025 [102 104 70] 0 0 0 1');
  } else {
    await adminCommand(B.page, '@teleloc 0xA9B00025 [102 104 70] 0 0 0 1'); await settle(B.page);
    await adminCommand(A.page, '@addspell 23'); await A.page.waitForTimeout(1500); await A.page.evaluate('window.__acAgent.appraise(window.__ac.charGuid)'); await A.page.waitForTimeout(1500); await adminCommand(A.page, '@modifyskill LifeMagic 400'); await A.page.waitForTimeout(1500);
    await A.page.evaluate(`window.acDebug.combatMode('magic')`); await A.page.waitForTimeout(3500);
    await A.page.evaluate(`window.__castSpell(23, ${bGuid})`);
  }
  const t0 = Date.now();
  for (let i = 0; i < 24; i++) { await A.page.waitForTimeout(process.env.MODE === 'together' ? 900 : 450); await A.page.screenshot({ path: `${shots}/buff-${String(Date.now() - t0).padStart(5, '0')}.png`, clip: { x: 400, y: 100, width: 480, height: 420 } }); }
  log(`B state as A sees it: ${JSON.stringify(await A.page.evaluate(`(() => { const som = window.__ac.serverObjectManager; const o = som.getObject(${bGuid}); if (!o) return null; const root = som.drawnRoot(o); const kinds = {}; const ops = new Set(); root?.traverse((n) => { kinds[n.type] = (kinds[n.type] ?? 0) + 1; const ms = Array.isArray(n.material) ? n.material : n.material ? [n.material] : []; for (const m of ms) if (n.isMesh) ops.add(+m.opacity.toFixed(2)); }); return { state: (o.physicsState >>> 0).toString(16), inScene: !!root?.parent, kinds, meshOpacities: [...ops] }; })()`))}`);
  log(`B meshes at opacity < 1: ${JSON.stringify(await A.page.evaluate(`(() => { const som = window.__ac.serverObjectManager; const o = som.getObject(${bGuid}); const root = o && som.drawnRoot(o); const out = []; root?.traverse((n) => { if (!n.isMesh) return; const ms = Array.isArray(n.material) ? n.material : [n.material]; const op = Math.min(...ms.map((m) => m.opacity)); if (op < 1) { let p = n; const path = []; while (p && p !== root) { path.push(p.name || p.type); p = p.parent; } out.push(path.reverse().join('/') + ' op=' + op.toFixed(2) + ' vis=' + n.visible + ' tr=' + ms.map((m) => m.transparent).join()); } }); return { rootTr: root?.userData?.translucency, n: out.length, sample: out.slice(0, 12) }; })()`))}`);
  log(`B emitters as A sees them: ${JSON.stringify(await A.page.evaluate(`window.acDebug.emittersOn(${bGuid})`))}`);
  log(`chat ${JSON.stringify(await A.page.evaluate('[...document.querySelectorAll(\'#chat-messages [data-chat-text]\')].slice(-4).map((n) => n.dataset.chatText || n.textContent)'))}`);
} finally { await A.browser.close(); await B.browser.close(); }
