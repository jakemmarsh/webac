/**
 * Stand-in for the hosting edge when testing Simple Proxy Protocol locally
 * (docs/operators.md, "Seeing players' real IP addresses"): each listen port
 * forwards WebSockets to a bridge with a fixed X-Real-IP, so local players
 * look like players at different addresses. Run the bridge with
 * BRIDGE_TRUST_PROXY=1 BRIDGE_CLIENT_IP_HEADER=x-real-ip.
 *
 *   npx tsx tools/spp/real-ip-proxy.ts ws://127.0.0.1:9500 9601=203.0.113.1 9602=203.0.113.2
 *
 * Then point a game page (or tools/ac-agent `bridge=`) at ws://localhost:9601.
 */
import { WebSocket, WebSocketServer, type RawData } from 'ws';

const [target, ...maps] = process.argv.slice(2);
if (!target || maps.length === 0) {
  console.error('usage: real-ip-proxy.ts <bridge ws url> <port>=<ip> [...]');
  process.exit(2);
}

for (const m of maps) {
  const [port, ip] = m.split('=');
  const wss = new WebSocketServer({ port: Number(port), host: '127.0.0.1' });
  wss.on('connection', (client, req) => {
    const upstream = new WebSocket(`${target}${req.url ?? '/'}`, { headers: { 'x-real-ip': ip } });
    const queued: Array<[RawData, boolean]> = [];
    client.on('message', (d, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(d, { binary: isBinary });
      else queued.push([d, isBinary]);
    });
    upstream.on('open', () => { for (const [d, b] of queued.splice(0)) upstream.send(d, { binary: b }); });
    upstream.on('message', (d, isBinary) => { if (client.readyState === WebSocket.OPEN) client.send(d, { binary: isBinary }); });
    const close = () => { client.close(); upstream.close(); };
    client.on('close', close); upstream.on('close', close);
    client.on('error', close); upstream.on('error', close);
  });
  console.log(`ws://127.0.0.1:${port} → ${target} as ${ip}`);
}
