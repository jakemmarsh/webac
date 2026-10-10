/**
 * Live check: the player's melee stance and swing animations with a given
 * weapon + shield, on any era's local server. The stance must be the style
 * of the server's movement (SwordShieldCombat 0x80000040 with a one-handed
 * weapon and a shield), and the server's swings must play as actions.
 *
 *   AC_BASE=http://localhost:<vite>/ AC_BRIDGE=ws://localhost:<bridge> \
 *     [ACCT=… ERA=… SPAWN='@ci ' WEAPON='Lugian Hammer' WCID=31764 SHIELD=44 NO_TELE=1 SHOT=…png] \
 *     npx tsx tools/melee-stance-check.ts
 *
 * The account needs admin (ACE: auto-created accounts are; AC1999:
 * SPAWN='@spawnwcidinv ' and access 6). Prints the style and the swing
 * animations seen (docs/movement-ab.md "Stance is the server's").
 */
import { adminCommand, enterWorld } from './lib/game-session.ts';
const base = process.env.AC_BASE!, bridge = process.env.AC_BRIDGE!;
const { browser, page } = await enterWorld({ url: `${base}?ace&bridge=${bridge}&account=${process.env.ACCT ?? 'mveraeor'}&password=${process.env.ACCT ?? 'mveraeor'}${process.env.ERA ? `&era=${process.env.ERA}` : ''}&cb=hammer`, settleMs: 6000 });
const ev = <T>(js: string) => page.evaluate(js) as Promise<T>;
const WEAPON = process.env.WEAPON ?? 'Lugian Hammer', WCID = process.env.WCID ?? '31764';
const log = (m: string) => console.log(`[hammer] ${m}`);
const settle = async () => { await page.waitForTimeout(1500); for (let i = 0; i < 80 && !(await ev<boolean>('window.acDebug.collisionState().loginComplete')); i++) await page.waitForTimeout(250); await page.waitForTimeout(2500); };
try {
  await page.mouse.click(640, 300);
  if (!process.env.NO_TELE) { await adminCommand(page, '@teleloc 0xA9B00025 [102.35 100.93 70] 1 0 0 0'); await settle(); }
  const inv = await ev<string[]>('window.__ac.playerState.inventory.getAll().map((i) => i.name)');
  if (!inv.includes(WEAPON)) { await adminCommand(page, (process.env.SPAWN ?? '@ci ') + WCID); await page.waitForTimeout(3000); }
  if (!inv.some((n) => /shield/i.test(n))) { await adminCommand(page, (process.env.SPAWN ?? '@ci ') + (process.env.SHIELD ?? '44')); await page.waitForTimeout(3000); }
  const inv2 = await ev<string[]>('window.__ac.playerState.inventory.getAll().map((i) => i.name)');
  const shield = inv2.find((n) => /shield/i.test(n));
  for (const n of [WEAPON, shield]) { log(`wield ${n}: ${await ev(`window.acDebug.wieldByName(${JSON.stringify(n)})`)}`); await page.waitForTimeout(3000); }
  const style = () => ev<string>('(() => { const a = window.__ac.serverObjectManager.animatedObjects.get(window.__ac.charGuid); return (a.motionManager.currentStyleId >>> 0).toString(16); })()');
  await ev(`window.acDebug.combatMode('melee')`); await page.waitForTimeout(4000);
  log(`melee style 0x${await style()} (SwordShieldCombat = 0x8000003e? HandCombat = 0x8000003c)`);
  await page.screenshot({ path: process.env.SHOT! });
  // Swing at the nearest attackable creature within 40 m: track isPlayingAction during the swing.
  const tgt = await ev<number>(`(() => { const me = window.__ac.charGuid, s = window.acDebug.collisionState(); let b = 0, bd = 40;
    for (const o of window.acDebug.getObjects()) { if (o.guid === me || !(o.type & 0x10) || !(o.objectDescFlags & 0x10) || (o.objectDescFlags & 0x208) || !o.pos) continue;
      const d = Math.hypot(o.pos.x - s.x, o.pos.z - s.z); if (d < bd) { bd = d; b = o.guid; } } return b; })()`);
  log(`target 0x${tgt.toString(16)}`);
  if (tgt) {
    const p = await ev<{ x: number; y: number; z: number; sx: number; sz: number; d: number }>(`(() => { const o = window.acDebug.getObjects().find((x) => x.guid === ${tgt}); const s = window.acDebug.collisionState(); return { x: o.pos.x, y: o.pos.y, z: o.pos.z, sx: s.x, sz: s.z, d: Math.hypot(o.pos.x - s.x, o.pos.z - s.z) }; })()`);
    if (p.d > 4) {
      const k = 2.5 / p.d, wx = p.x + (p.sx - p.x) * k, wy = p.z + (p.sz - p.z) * k;
      const lbx = Math.floor(wx / 192), lby = Math.floor(wy / 192), lx = wx - lbx * 192, ly = wy - lby * 192;
      const cell = ((lbx << 24) | (lby << 16) | (Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1)) >>> 0;
      await adminCommand(page, `@teleloc 0x${cell.toString(16).padStart(8, '0')} [${lx.toFixed(2)} ${ly.toFixed(2)} ${(p.y + 1).toFixed(2)}] 1 0 0 0`); await settle();
    }
    await ev(`(() => { const som = window.__ac.serverObjectManager, me = window.__ac.charGuid, o = som.applyParsedMotion.bind(som); window.__srv = [];
      som.applyParsedMotion = (g, an, p, ...r) => { if (g === me && !p.autonomous) window.__srv.push([(p.styleIndex >>> 0).toString(16), (p.forwardCommand >>> 0).toString(16), (p.actions || []).map((a) => (a.command >>> 0).toString(16))]); return o(g, an, p, ...r); }; })()`);
  }
  if (tgt) {
    await ev(`window.acDebug.select(${tgt})`); await page.waitForTimeout(500);
    await ev(`(() => { const a = window.__ac.serverObjectManager.animatedObjects.get(window.__ac.charGuid); window.__sw = { acts: 0, motions: new Set() }; const mm = a.motionManager;
      const f = () => { const ap = mm.animationPlayer, id = ap && ap.currentAnimation ? (ap.currentAnimation.id >>> 0).toString(16) : '-'; if (mm.isPlayingAction) window.__sw.acts++; window.__sw.motions.add(id); }; window.__swT = setInterval(f, 16); })()`);
    await page.keyboard.down('End'); await page.waitForTimeout(800); await page.keyboard.up('End');
    await page.waitForTimeout(6000);
    log(`server motions: ${await ev('JSON.stringify(window.__srv)')}`);
    log(`swing frames playing an action: ${await ev('window.__sw.acts')} animations ${await ev('JSON.stringify([...window.__sw.motions])')}`);
    log(`style after swings 0x${await style()}`);
  }
} finally { await browser.close(); }
