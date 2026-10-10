/**
 * AGENT.hosted-mcp-connector, step 3 — the HTTP side of pairing (oauth.ts):
 * metadata, registration, the pairing page and its status / decision calls,
 * token and revoke. The page is plain HTML with a little script: it shows the
 * pairing code, polls until the game has sent it, then asks for approval.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OAuthServer } from './oauth.ts';

const MAX_BODY = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) throw new Error('too large'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}
function fields(req: IncomingMessage, body: string): Record<string, string> {
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    try { const j = JSON.parse(body) as Record<string, unknown>; return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)])); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(body));
}
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function pairingPage(reqId: string, code: string, client: string): string {
  const shown = `${code.slice(0, 3)}-${code.slice(3)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Claude</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem}.cmd{display:inline-block;font:1.25rem/1.4 ui-monospace,Menlo,monospace;padding:.5rem .8rem;border:1px solid;border-radius:6px;white-space:nowrap}.cmd b{letter-spacing:.08em}.note{opacity:.75;font-size:.9rem}button{font:inherit;padding:.4rem 1rem;margin-right:.5rem}</style></head>
<body><h1>Let ${esc(client)} play your character</h1>
<div id="wait"><p>Log in to the game with the character Claude should play, then type this in chat:</p><p><span class="cmd">/automation pair <b>${esc(shown)}</b></span></p><p class="note">The code works once and lasts 10 minutes. No password is asked for or stored: the game you are logged in to confirms it is you. Type <code>/automation unpair</code> in the game to disconnect Claude at any time.</p></div>
<div id="ask" hidden><p id="who"></p><label id="onlyrow"><input type="checkbox" id="only" checked> Only this character</label><p><button id="yes">Approve</button><button id="no">Deny</button></p></div>
<p id="msg"></p>
<script>
const req=${JSON.stringify(reqId)};
const $=(id)=>document.getElementById(id);
let character=null;
async function poll(){const r=await fetch('/oauth/authorize/status?req='+encodeURIComponent(req));const s=await r.json();
 if(s.state==='expired'){$('msg').textContent='This pairing expired. Start again from Claude.';return;}
 if(s.state==='paired'){character=s.character;$('wait').hidden=true;$('ask').hidden=false;$('who').textContent='Let '+s.client+' play on the account '+s.account.slice(s.account.lastIndexOf(':')+1)+(s.character?' ('+s.character+' is in the world now)':'')+'?';if(!s.character)$('onlyrow').hidden=true;return;}
 setTimeout(poll,1500);}
async function decide(approve){const r=await fetch('/oauth/authorize/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({req,approve,only:!!(character&&$('only').checked)})});const j=await r.json();if(j.redirect)location.href=j.redirect;else $('msg').textContent=j.error||'Something went wrong.';}
$('yes').onclick=()=>decide(true);$('no').onclick=()=>decide(false);poll();
</script></body></html>`;
}

/** Handle an OAuth route; false when the path isn't one. */
/** The connect page for a pending request: `page` + ?connect=<reqId> (BRIDGE_CONNECT_PAGE, e.g. https://playwebac.com/). */
export function connectPageUrl(page: string, reqId: string): string {
  const u = new URL(page);
  u.searchParams.set('connect', reqId);
  return u.toString();
}

/**
 * Handle an OAuth route; false when the path isn't one. With `connectPage`
 * set, the authorize step sends the browser to the game's own connect screen
 * (launcher/ConnectScreen.ts, drawn from the DAT like the launcher); without
 * it (local setups), this file's plain page.
 */
export async function handleOAuth(req: IncomingMessage, res: ServerResponse, oauth: OAuthServer, connectPage: string | null = null): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://bridge.local');
  const p = url.pathname;
  const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
  if (req.method === 'OPTIONS' && (p.startsWith('/.well-known/') || p.startsWith('/oauth/'))) {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, authorization' });
    res.end();
    return true;
  }
  if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp') { json(200, oauth.protectedResourceMetadata()); return true; }
  if (p === '/.well-known/oauth-authorization-server') { json(200, oauth.authServerMetadata()); return true; }
  if (p === '/oauth/register' && req.method === 'POST') {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { json(400, { error: 'invalid_client_metadata' }); return true; }
    const r = oauth.register(body);
    json(r.status, r.body);
    return true;
  }
  if (p === '/oauth/authorize' && req.method === 'GET') {
    const r = await oauth.authorize(url.searchParams);
    if (!r.ok) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end(`Can't connect: ${r.error}`); return true; }
    if (connectPage) { res.writeHead(302, { location: connectPageUrl(connectPage, r.pending.reqId), 'cache-control': 'no-store' }); res.end(); return true; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'" });
    res.end(pairingPage(r.pending.reqId, r.pending.code, r.pending.clientName));
    return true;
  }
  if (p === '/oauth/authorize/status' && req.method === 'GET') { json(200, oauth.status(url.searchParams.get('req') ?? '')); return true; }
  if (p === '/oauth/authorize/decision' && req.method === 'POST') {
    let f: Record<string, unknown> = {};
    try { f = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    json(200, oauth.decide(String(f.req ?? ''), f.approve === true, f.only === true));
    return true;
  }
  if (p === '/oauth/token' && req.method === 'POST') {
    const r = await oauth.tokenRequest(fields(req, await readBody(req)));
    json(r.status, r.body);
    return true;
  }
  if (p === '/oauth/revoke' && req.method === 'POST') {
    const f = fields(req, await readBody(req));
    if (f.token) oauth.revoke(f.token);
    json(200, {});
    return true;
  }
  return false;
}
