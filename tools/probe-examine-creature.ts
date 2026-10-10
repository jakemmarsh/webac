/**
 * probe-examine-creature — the examine window's creature / character pages:
 * right-clicks a spawned drudge (wcid 19257) and the nearest NPC, logging
 * what the IdentifyResponse carried (success flag, creature profile) and
 * screenshotting each window to verification/examine-creature/.
 *
 * Usage: AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 npx tsx tools/probe-examine-creature.ts
 */
import { enterWorld, adminCommand, shot } from './lib/game-session.js';
const OUT = 'verification/examine-creature';

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'examine-creature', consoleFilter: /Examine 0x/ } as never);
  await s.page.waitForTimeout(4000);
  await adminCommand(s.page, '@teleloc 0xA9B40019 [85.0 20.5 94.0] 1 0 0 0');
  await s.page.waitForTimeout(7000);
  await adminCommand(s.page, '@create 19257');
  await s.page.waitForTimeout(4000);
  const targets = await s.page.evaluate(`(() => { const cs = window.acDebug.collisionState(); const out = [];
    for (const o of window.__ac.serverObjectManager.objects.values()) { if (!(o.itemType & 0x10) || !o.mesh || !o.mesh.visible || o.guid === window.__ac.charGuid) continue;
      const at = window.acDebug.screenPosOf(o.guid); if (!at || at.x < 20 || at.x > 1200 || at.y < 60 || at.y > 640) continue;
      out.push({ guid: o.guid, name: o.name, d: Math.hypot(o.worldX - cs.x, o.worldZ - cs.z), at }); }
    out.sort((a, b) => a.d - b.d);
    const drudge = out.find((o) => /drudge/i.test(o.name)); const npc = out.find((o) => !/drudge|forge/i.test(o.name));
    return [drudge, npc].filter(Boolean); })()`) as Array<{ guid: number; name: string; at: { x: number; y: number } }>;
  console.log('targets', JSON.stringify(targets.map((t) => t.name)));
  for (const [i, t] of targets.entries()) {
    await s.page.mouse.move(t.at.x, t.at.y);
    await s.page.mouse.down({ button: 'right' });
    await s.page.mouse.up({ button: 'right' });
    await s.page.waitForTimeout(3000);
    await shot(s.page, `${OUT}/${i + 1}-${t.name.replace(/\W+/g, '-')}.png`);
  }
  // A character page: select the nearest visible NPC (any heading) and press E.
  const npc = await s.page.evaluate(`(() => { const cs = window.acDebug.collisionState(); let best = null;
    for (const o of window.__ac.serverObjectManager.objects.values()) { if (!(o.itemType & 0x10) || !o.mesh || !o.mesh.visible || /drudge/i.test(o.name) || o.guid === window.__ac.charGuid || (o.objectDescFlags & 0x8)) continue;
      const d = Math.hypot(o.worldX - cs.x, o.worldZ - cs.z); if (!best || d < best.d) best = { guid: o.guid, name: o.name, d }; }
    return best; })()`) as { guid: number; name: string } | null;
  console.log('npc', JSON.stringify(npc));
  if (npc) {
    await s.page.evaluate(`window.acDebug.select(${npc.guid})`);
    await s.page.mouse.click(700, 150);
    await s.page.evaluate(`window.acDebug.select(${npc.guid})`);
    await s.page.keyboard.press('e');
    await s.page.waitForTimeout(3000);
    await shot(s.page, `${OUT}/3-npc-${npc.name.replace(/\W+/g, '-')}.png`);
  }
  await adminCommand(s.page, '@smite all');
  await s.page.waitForTimeout(1500);
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
