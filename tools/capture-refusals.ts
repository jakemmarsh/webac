/**
 * Every refusal / error a player can meet on the way into the game, captured
 * as it really renders, for a side-by-side consistency review.
 *
 * Drives a running live-drive server (tools/live-drive.ts serve --gpu) pointed
 * at a DEV Vite (window.__ac and /src module imports are dev-only) with the
 * local ACE bridge:
 *
 *   npx tsx tools/live-drive.ts serve --url 'http://localhost:<vite>/?bridge=ws://localhost:9090' --gpu --out <dir>
 *   npx tsx tools/capture-refusals.ts --base http://localhost:<vite>/ --out <dir> [--account testacjs3 --password testacjs3]
 *
 * Real conditions where they are cheap (launcher validation, a wrong password
 * against local ACE, blocked DAT downloads, a bogus pairing id, chargen
 * FINISH); every other text goes through the client's own builders
 * (ConnectionNotices / worldDirectory / AccountBoot / ChargenRefusal …) and the
 * client's own surfaces (GameUI.showMessageDialog / showCharacterErrorDialog /
 * showDisconnectedScreen, boot/Capability.showCapabilityScreen), so what is
 * captured is exactly what a player would read. Writes <out>/refusals.json
 * (one row per capture: id, surface, trigger, text, file).
 *
 * Coordinates are for live-drive's DEFAULT_VIEWPORT (the 800x600 UI letterboxed
 * at 1568x775) and the end-of-retail pre-world layout.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? dflt : dflt; };
const BASE = opt('base', 'http://localhost:3425/').replace(/\/?$/, '/');
const OUT = opt('out', '.');
const PORT = Number(opt('port', process.env.LIVE_DRIVE_PORT ?? '9477'));
const ACCOUNT = opt('account', 'testacjs3');
const PASSWORD = opt('password', 'testacjs3');
const BRIDGE = opt('bridge', 'ws://localhost:9090');

interface Row { id: string; surface: string; trigger: string; text: string; file: string }

async function op(name: string, ...a: Array<string | number>): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${PORT}/`, { method: 'POST', body: JSON.stringify({ op: name, args: a.map(String) }) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${name} ${a.join(' ').slice(0, 120)}: ${t}`);
  return t;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const evalJs = (js: string) => op('eval', js);

async function waitFor(js: string, ms = 90_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await evalJs(`(()=>{try{return !!(${js})}catch{return false}})()`)) === 'true') return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${js}`);
}

/** The text the player sees on the topmost refusal surface right now. */
const visibleText = () => evalJs(`(()=>{
  const pick=(s)=>{const e=document.querySelector(s);return e&&e.offsetParent!==null?e:null};
  const e=pick('#ac-message-dialog')||pick('#disconnected-text')||pick('#capability-screen')||pick('.connect-screen')||pick('#load-text-left');
  if(!e)return '';
  const t=[...e.querySelectorAll('[data-ac-text]')].map(x=>x.getAttribute('data-ac-text')).filter(Boolean).join('\\n');
  return t||e.innerText||'';
})()`);

async function shot(id: string, surface: string, trigger: string, text?: string): Promise<void> {
  await sleep(700);
  const file = (await op('shot', id)).trim();
  rows.push({ id, surface, trigger, text: text ?? (await visibleText()), file });
  console.log(`${id}: ${file}`);
}

/** Module imports through the dev server: the same instances the app uses (string tables loaded). */
const mod = (path: string) => `(await import('/src/${path}'))`;

async function inPage(js: string): Promise<string> {
  return evalJs(`(async()=>{${js}})()`);
}

async function dialog(id: string, trigger: string, textJs: string): Promise<void> {
  const text = await inPage(`const g=window.__ac.gameUI; g.hideDisconnectedScreen?.(); g.hideMessageDialog(); const t=await (async()=>{${textJs}})(); g.showMessageDialog(t); return t;`);
  await shot(id, 'A: retail OK dialog', trigger, text);
  await inPage(`window.__ac.gameUI.hideMessageDialog()`);
}

async function charError(id: string, code: number, name: string): Promise<void> {
  const text = await inPage(`const g=window.__ac.gameUI; g.hideMessageDialog(); const t=${mod('ui/ConnectionNotices.ts')}.characterErrorNotice(${code}).text; g.showCharacterErrorDialog(t); return t;`);
  await shot(id, 'C: OK dialog over character select', `CharacterError ${name} (0x${code.toString(16)})`, text);
  await inPage(`window.__ac.gameUI.hideMessageDialog()`);
}

async function disconnected(id: string, trigger: string, textJs: string): Promise<void> {
  const text = await inPage(`const g=window.__ac.gameUI; g.hideMessageDialog(); g.hideDisconnectedScreen?.(); const t=await (async()=>{${textJs}})(); g.showDisconnectedScreen(t, ()=>{}); return t;`);
  await shot(id, 'B: retail Disconnected screen', trigger, text);
  await inPage(`window.__ac.gameUI.hideDisconnectedScreen()`);
}

const LOGIN_URL = (password: string, extra = '') => `${BASE}?ace&bridge=${encodeURIComponent(BRIDGE)}&account=${ACCOUNT}&password=${password}&autoenter=false${extra}`;
const charSelectUp = `window.__ac.gameUI.uiManager?.currentScreen === 'character-select'`;
/** --from charselect: skip the launcher / boot stages (resume a partial run). */
const FROM = opt('from', '');
const rows: Row[] = FROM && existsSync(join(OUT, 'refusals.json')) ? JSON.parse(readFileSync(join(OUT, 'refusals.json'), 'utf8')) : [];

async function main(): Promise<void> {
  if (FROM !== 'charselect') await preWorld();
  await charSelect();
  writeFileSync(join(OUT, 'refusals.json'), JSON.stringify(rows, null, 1) + '\n');
  console.log(`${rows.length} captures → ${join(OUT, 'refusals.json')}`);
}

async function preWorld(): Promise<void> {
  // ── 1. Launcher, real clicks ────────────────────────────────────────────
  await op('goto', `${BASE}?bridge=${encodeURIComponent(BRIDGE)}`);
  await waitFor(`document.querySelector('.launcher-login')`);
  await sleep(3000);
  // The launcher remembers the last account name: clear both fields first.
  for (const [x, y] of [[418, 92], [418, 160]]) { await op('click', x, y); await op('key', 'Meta+a'); await op('key', 'Backspace'); }
  await op('click', 711, 508);                      // ENTER, both fields empty
  await shot('launcher-no-account', 'A: retail OK dialog (launcher)', 'ENTER with no account name');
  await op('key', 'Enter');
  await op('click', 418, 92); await op('key', 'Meta+a'); await op('key', 'Backspace'); await op('type', ACCOUNT);
  await op('click', 711, 508);
  await shot('launcher-no-password', 'A: retail OK dialog (launcher)', 'ENTER with no password');
  await op('key', 'Enter');
  await op('click', 418, 160); await op('key', 'Meta+a'); await op('key', 'Backspace'); await op('type', 'not-the-password');
  await op('click', 711, 508);                      // ACE boots a wrong password (AccountBoot 0xF7DC)
  await waitFor(`document.querySelector('#ac-message-dialog')`, 60_000);
  await shot('launcher-wrong-password', 'A: retail OK dialog (launcher)', 'Wrong password, ACE (AccountBoot, launcher login)');
  await op('key', 'Enter');
  await sleep(2000);
  await op('click', 423, 738);                      // CUSTOM…
  await sleep(1500);
  await shot('launcher-custom', 'launcher', 'CUSTOM… box (for reference)', '');
  await op('key', 'Escape');

  // ── 2. World list unavailable (a bridge that never answers) ─────────────
  await op('goto', `${BASE}?bridge=${encodeURIComponent('ws://localhost:9')}`);
  await waitFor(`document.querySelector('.launcher-login')`);
  await sleep(8000);
  await shot('launcher-world-list-down', 'F: launcher inline text', 'World list fails to load', '');

  // ── 3. Wrong password through a URL login → Disconnected screen ─────────
  await op('goto', LOGIN_URL('not-the-password'));
  await waitFor(`document.querySelector('#ac-message-dialog') || document.querySelector('#disconnected-text')`, 90_000);
  await shot('url-wrong-password', 'A: retail OK dialog', 'Wrong password, ACE (AccountBoot, URL login)');

  // ── 4. Claude pairing with a bogus id ──────────────────────────────────
  await op('goto', `${BASE}?connect=00000000000000000000000000000000&bridge=${encodeURIComponent(BRIDGE)}`);
  await sleep(10_000);
  await shot('connect-pairing-failed', 'F: launcher-styled plate', 'Claude pairing id unknown / expired', '');

  // ── 5. DAT download failure → splash label ─────────────────────────────
  await op('goto', `${BASE}?ace&bridge=${encodeURIComponent(BRIDGE)}&datSet=${encodeURIComponent('http://127.0.0.1:9/v1/sets/missing.json')}`);
  await sleep(20_000);
  await shot('patch-failure', 'H: splash label', 'Game data unavailable (DAT fetch fails)', '');

}

async function charSelect(): Promise<void> {
  // ── 6. Character select (logged in): everything rendered through the client's own builders ──
  await op('goto', LOGIN_URL(PASSWORD));
  await waitFor(`window.__ac?.gameUI && (${charSelectUp})`, 150_000);
  await sleep(3000);
  const CN = mod('ui/ConnectionNotices.ts');
  const WD = mod('launcher/worldDirectory.ts');
  const AB = mod('session/AccountBoot.ts');
  const notice = (tok: string) => `${CN}.netErrorNotice('${tok}')`;
  const world = `{name:'Coldeve',registration:null,registrationUrl:null,kind:'listed',bridgeUrl:'wss://bridge.playwebac.com'}`;
  const perIp = `{name:'Levistras',registration:null,registrationUrl:null,kind:'listed',perIpLimits:{accounts:2,sessions:2}}`;
  const regWorld = `{name:'Seedsow',registration:'website',registrationUrl:'https://example.invalid/register'}`;

  await dialog('net-cant-socket', 'Bridge never answers (ID_NetError_CantSocket)', `return ${WD}.loginFailureText(${notice('ID_NetError_CantSocket')}, ${world}, false)`);
  await dialog('net-custom-unanswered', 'Custom… bridge never answers', `return ${WD}.loginFailureText(${notice('ID_NetError_CantSocket')}, {name:'my-server',kind:'custom',bridgeUrl:'wss://my-bridge.example'}, false)`);
  await dialog('net-timed-out', 'Login timed out (ClientTimedOutServer)', `return ${WD}.loginFailureText(${notice('ID_ConnectionError_ClientTimedOutServer')}, ${world}, false)`);
  await dialog('net-timed-out-register', 'Login timed out on a register-first world', `return ${WD}.loginFailureText(${notice('ID_ConnectionError_ClientTimedOutServer')}, ${regWorld}, false)`);
  await dialog('net-logon-failed', 'GDLE / AC1999 wrong password (STR_LOGIN_FAILED)', `return ${WD}.loginFailureText(${notice('ID_ConnectionError_ClientLogOnFailed')}, ${world}, false)`);
  await dialog('net-logon-failed-per-ip', 'STR_LOGIN_FAILED on a per-IP-capped world', `return ${WD}.loginFailureText(${notice('ID_ConnectionError_ClientLogOnFailed')}, ${perIp}, false)`);
  await dialog('net-server-full', 'Server full (STR_LOGIN_SERVER_FULL)', `return ${WD}.loginFailureText(${notice('ID_ConnectionError_ServerFull')}, ${world}, false)`);
  await dialog('net-server-full-per-ip', 'Server full on a per-IP-capped world', `return ${WD}.loginFailureText(${notice('ID_ConnectionError_ServerFull')}, ${perIp}, false)`);
  await dialog('net-version-mismatch', 'Client version refused (NetVersionMismatch)', `return ${WD}.loginFailureText(${notice('ID_ConnectionError_NetVersionMismatch')}, ${world}, false)`);
  await dialog('net-server-closed', 'AC1999 server goes silent after granting (ServerClosedConnection)', `return ${WD}.loginFailureText(${notice('ID_ConnectionError_ServerClosedConnection')}, ${world}, false)`);
  for (const r of ['ip_cap', 'world_full', 'new_account_cap', 'new_account_unavailable']) {
    await dialog(`bridge-${r}`, `Bridge refusal ${r}`, `return ${CN}.bridgeRefusalNotice('${r}').text`);
  }
  await dialog('era-unavailable', 'Era DATs unreachable on a cross-era enter', `return ${mod('era/EraBoot.ts')}.eraUnavailableText('Snowreap')`);
  await dialog('world-offline', 'ENTER on an offline world', `return ${WD}.worldEnterBlock({name:'Frostfell',online:false,compat:'ok',era:'eor',kind:'listed'})`);
  await dialog('world-incompatible', 'ENTER on a world the bridge marks incompatible', `return ${WD}.worldEnterBlock({name:'Darktide',compat:'incompatible',compatReason:'This server blocks connections from hosting providers.',kind:'listed'})`);
  await dialog('update-urgent', 'Urgent client update', `return ${mod('update/UpdateWatcher.ts')}.updateNoticeText(true)`);
  await dialog('chargen-olthoi', 'Chargen refusal code 2 for an Olthoi (ACE olthoi_play_disabled)', `return ${mod('ui/ChargenRefusal.ts')}.chargenRefusalText('The server cannot create your new character at this time. Please try again later.', 2, 12)`);

  // Character-select dialogs (retail switch → mode 0x1000000a + OK dialog)
  const dialogCodes: Array<[number, string]> = [[0x5, 'Logoff'], [0x6, 'Delete'], [0xB, 'EnterGameGeneric'], [0xC, 'EnterGameStressAccount'], [0xD, 'EnterGameCharacterInWorld'], [0xF, 'EnterGameCharacterNotOwned'], [0x10, 'EnterGameCharacterInWorldServer'], [0x11, 'EnterGameOldCharacter'], [0x12, 'EnterGameCorruptCharacter'], [0x13, 'EnterGameStartServerDown'], [0x14, 'EnterGameCouldntPlaceCharacter'], [0x17, 'EnterGameCharacterLocked']];
  for (const [code, name] of dialogCodes) await charError(`char-error-${name}`, code, name);

  // Restore refused (0xF643, code 3 / 5 / 6): the OK dialog over character select with retail's restore text
  for (const [code, name] of [[3, 'NameInUse'], [5, 'Corrupt'], [6, 'DatabaseDown']] as const) {
    const text = await inPage(`const g=window.__ac.gameUI; const t=${mod('session/CharacterRestore.ts')}.characterRestoreRefusalText(${code}); g.showRefusalDialog(t); return t;`);
    await shot(`restore-refused-${name}`, 'C: OK dialog over character select', `Character restore refused (0xF643 code ${code})`, text);
    await inPage(`window.__ac.gameUI.hideMessageDialog()`);
  }
  // Unknown CharacterError before the world, and the stale-session wait line on the connecting screen
  await dialog('char-error-unknown', 'CharacterError code retail\'s switch does not list, before the world', `return ${mod('session/RefusalRoute.ts')}.genericEnterRefusalText()`);
  {
    const text = await inPage(`const g=window.__ac.gameUI; g.showConnectingScreen(); const t=${mod('session/RefusalRoute.ts')}.staleSessionWaitText(3, 40); g.setConnectingStatus(t); return t;`);
    await shot('connecting-stale-session', 'Connecting screen status', 'ACE stale-session login retry (try 3 of 40)', text);
    await op('goto', LOGIN_URL(PASSWORD));
    await waitFor(`window.__ac?.gameUI && (${charSelectUp})`, 150_000);
    await sleep(3000);
  }

  // ── 7. Chargen FINISH, real clicks ─────────────────────────────────────
  await op('click', 709, 311);                      // Create Character
  await sleep(4000);
  await op('click', 1175, 40);                      // Summary
  await sleep(2000);
  await op('click', 1195, 735);                     // FINISH, no name
  await shot('chargen-no-name', 'A: retail OK dialog (chargen)', 'FINISH with no name');
  await op('key', 'Enter');
  await op('click', 730, 132); await op('key', 'Meta+a'); await op('key', 'Backspace'); await op('type', 'Asheron');
  await op('click', 1195, 735);
  await shot('chargen-name-refused', 'A: retail OK dialog (chargen)', 'FINISH with a name the client refuses');
  await op('key', 'Enter');
  await op('key', 'Escape');
  // Disconnected-screen texts last: hiding the screen leaves nothing drawn behind it.
  const discCodes: Array<[number, string]> = [[0x1, 'Logon'], [0x3, 'AccountLogin'], [0x4, 'ServerCrash1'], [0x9, 'AccountInvalid'], [0xA, 'AccountDoesntExist'], [0xE, 'EnterGamePlayerAccountMissing'], [0x15, 'LogonServerFull']];
  for (const [code, name] of discCodes) await disconnected(`disc-${name}`, `CharacterError ${name} (0x${code.toString(16)})`, `return ${CN}.characterErrorNotice(${code}).text`);
  await disconnected('disc-connection-lost', 'Connection lost in the world (after resume attempts fail)', `return ${CN}.connectionLostText()`);
  await disconnected('disc-booted', 'AccountBoot in the world (admin boot, no reason)', `return ${AB}.accountBootedText(null)`);
  await disconnected('disc-banned', 'AccountBanned (1 day, with reason)', `return ${AB}.accountBannedText(86400, 'Testing', Date.now())`);
  await disconnected('disc-long-text', 'A long server boot reason (scrolls in the fixed text box)', `return ${AB}.accountBootedText(' - You were removed by an administrator after several reports about your conduct in the Holtburg marketplace. Please review the server rules on the forum before you log in again; a second removal within thirty days becomes a seven-day ban, and a third becomes permanent.')`);

  // ── 8. Boot capability screens (before the game starts; rendered on a fresh page) ──
  for (const [id, trigger, env] of [
    ['capability-webgl2', 'No WebGL2 (GPU blocklisted, Chrome on Windows)', `{webgl2:false,webgl2Failure:{cause:'blocklisted',status:null},platform:{os:'windows',browser:'chrome'},websocket:true,deviceMemoryGb:8,finePointer:true}`],
    ['capability-soft', 'Low memory + touch-only device (soft warnings)', `{webgl2:true,websocket:true,deviceMemoryGb:2,finePointer:false}`],
  ] as const) {
    await op('goto', `${BASE}?bridge=${encodeURIComponent(BRIDGE)}`);
    await waitFor(`document.querySelector('.launcher-login')`);
    const text = await inPage(`const m=${mod('boot/Capability.ts')}; const p=m.capabilityProblems(${env}); void m.showCapabilityScreen(document,p); return p.map(x=>x.text).join('\\n\\n');`);
    await shot(id, 'G: custom HTML capability screen', trigger, text);
  }

}

main().catch(async (e) => {
  writeFileSync(join(OUT, 'refusals.json'), JSON.stringify(rows, null, 1) + '\n');
  console.error(e);
  process.exit(1);
});
