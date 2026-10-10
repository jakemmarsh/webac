/**
 * CORE.17.h.c — compose the side-by-side evidence sheet from the live captures.
 * Run from repo root: npx tsx tools/compose-core17hc.ts
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/home/user/acjs';
const SRC = join(ROOT, 'verification', 'screens', 'core17hc');
const OUT = join(ROOT, 'verification', 'core17hc');
const REF = join(ROOT, 'reference', 'images', 'hud');
mkdirSync(OUT, { recursive: true });

function dataUri(p: string): string {
  const b = readFileSync(p);
  const mime = p.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${b.toString('base64')}`;
}
// The options panel occupies the right dock: crop x 1268..1568, y 138..675 of the 1568x775 frame.
const PANEL = { x: 1266, y: 138, w: 302, h: 540 };
function panelCrop(p: string, caption: string): string {
  return `<figure><div class="crop" style="width:${PANEL.w}px;height:${PANEL.h}px"><img src="${dataUri(p)}" style="margin-left:-${PANEL.x}px;margin-top:-${PANEL.y}px"></div><figcaption>${caption}</figcaption></figure>`;
}
function full(p: string, caption: string): string {
  return `<figure><img src="${dataUri(p)}" style="width:784px"><figcaption>${caption}</figcaption></figure>`;
}

const shots = {
  s2: join(SRC, '2-config-edited.png'),
  s3: join(SRC, '3-config-after-defaults.png'),
  s4: join(SRC, '4-chat-after-config-defaults.png'),
  s5: join(SRC, '5-chat-after-chat-defaults.png'),
  s6: join(SRC, '6-character-after-reset.png'),
  s1: join(SRC, '1-chat-edited.png'),
};
const scene = join(ROOT, 'verification', 'screens', 'scenes', 'hud-options-chat.png');

const css = `body{background:#111;color:#ddd;font:13px sans-serif;margin:0;padding:12px}
h2{font-size:15px;margin:10px 0 6px}.row{display:flex;gap:10px;flex-wrap:nowrap}figure{margin:0}
.crop{overflow:hidden;border:1px solid #444}.crop img{display:block;max-width:none}
figcaption{max-width:302px;font-size:11px;color:#bbb;margin-top:4px;line-height:1.3}`;

const html = `<style>${css}</style>
<h2>CORE.17.h.c — Reset/Defaults scope to the visible options page (retail OptionPage::RestoreDefaultValues @ 004f2cb0 walks only that page's m_UIOptionArray)</h2>
<div class="row">
<figure><img src="${dataUri(join(REF, 'options-config.jpg'))}" style="height:${PANEL.h}px"><figcaption>RETAIL options-config.jpg</figcaption></figure>
${panelCrop(shots.s2, 'OURS 2: Config tab — Brightness dragged to 90, Camera Stiffness to 9 (Chat tab already edited: Inactive Opacity 20, General Channel off; Character: Show Helm off)')}
${panelCrop(shots.s3, 'OURS 3: after DEFAULTS on Config — Brightness/Stiffness back to 50/50')}
${panelCrop(shots.s4, 'OURS 4: Chat tab afterwards — Inactive Opacity still 20, General Channel still off (untouched by the Config-page Defaults)')}
</div>
<div class="row" style="margin-top:12px">
<figure><img src="${dataUri(join(REF, 'chat-options.jpg'))}" style="height:${PANEL.h}px"><figcaption>RETAIL chat-options.jpg</figcaption></figure>
${panelCrop(shots.s1, 'OURS 1: Chat tab edited (Inactive 20 / General off)')}
${panelCrop(shots.s5, 'OURS 5: DEFAULTS on Chat — Inactive 50 / General on; Character + Config edits survive (settings-log.json)')}
${panelCrop(shots.s6, 'OURS 6: Character tab after RESET — Show Helm back on; chat/config untouched')}
</div>
<h2>Whole screens</h2>
<div class="row">${full(shots.s3, 'OURS: Config after Defaults (1568x775, SwiftShader)')}${full(shots.s4, 'OURS: Chat after the Config-page Defaults')}</div>
${existsSync(scene) ? `<div class="row" style="margin-top:12px">${full(scene, 'capture-ui-screens.ts --scenes hud-options-chat (canonical whole-screen scene)')}</div>` : ''}
`;

async function main(): Promise<void> {
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({ ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.setContent(html);
  await page.screenshot({ path: join(OUT, 'core17hc-options-footer-scope-sidebyside.png'), fullPage: true });
  await browser.close();
  copyFileSync(join(SRC, 'settings-log.json'), join(OUT, 'settings-log.json'));
  console.log('wrote', join(OUT, 'core17hc-options-footer-scope-sidebyside.png'));
}
main().catch((e) => { console.error(e); process.exit(1); });
