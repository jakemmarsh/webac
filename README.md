# webAC: an Asheron's Call client for the browser

webAC is a free, open-source game client that plays Asheron's Call in a web
browser. It connects to the community's emulator servers ([ACE](https://github.com/ACEmulator/ACE)
and GDLE) and aims to look and behave exactly like the end-of-retail client
of January 2017: same screens, same panels, same controls, same defaults.
The only deliberate differences are browser conventions such as a resizable
window and wheel zoom.

**Play:** https://playwebac.com (open beta). Pick a world, type an account
name and password, and press ENTER. On most ACE worlds your account is created
the first time you log in. Some worlds ask you to register on their website
first; the launcher says which.

> webAC is a fan project. It is not affiliated with, endorsed by or sponsored
> by Warner Bros. Games, Turbine or Daybreak. "Asheron's Call" is a trademark
> of its owner and is used here only to say what the client is compatible
> with. See [NOTICE.md](NOTICE.md).

## What you need

- A desktop browser with WebGL2: current Chrome, Edge, Firefox or Safari.
  Phones and tablets are not supported.
- A computer with 8 GB of RAM or more. In Chrome the whole browser uses about
  2.4 GB with the game in the world (measured 2026-10-12 on playwebac.com).
- The game data streams on demand, about 50 MB to reach the starting town.
  Nothing is installed.

When the client hits an error it sends a short crash report (the error
text, the browser's user-agent and which screen you were on) to the same
bridge it plays through. Reports never include your account, password,
chat or the page's address details.

## How it works

```
browser (TypeScript + Three.js) ──wss──▶ bridge ──udp──▶ ACE / GDLE server
```

Browsers cannot send UDP, so a small WebSocket-to-UDP bridge
([services/ws-tcp-bridge](services/ws-tcp-bridge/README.md)) relays each
player's session. The game data (the retail DAT files) is parsed in the
browser and streamed from a CDN in small content-addressed pieces
([docs/dat-streaming.md](docs/dat-streaming.md)).

| Package | What |
|---|---|
| `packages/shared` | Types, enums and constants shared by every package |
| `packages/dat-parser` | Reader for every DAT file type the client uses |
| `packages/network` | The AC network protocol: packets, ISAAC, fragments, messages |
| `packages/renderer` | The client: rendering, UI, input, game systems |
| `services/ws-tcp-bridge` | The WebSocket-to-UDP bridge |

## Running it locally

You need Node 20+, Docker (for a local ACE server) and your own copy of the
end-of-retail DAT files (`client_portal.dat`, `client_cell_1.dat`,
`client_local_English.dat`, `client_highres.dat`). The DATs are not in this
repository and never will be.

```bash
npm install
cp /path/to/your/ac/*.dat dat/          # the four DAT files
# start an ACE server (see https://github.com/ACEmulator/ACE) on 127.0.0.1:9000
npx tsx services/ws-tcp-bridge/src/bridge.ts   # ws://localhost:9090 → 127.0.0.1:9000
npm run dev                                   # http://localhost:3000
npm test                                      # the test suite
```

## Server operators

Players reach your world through a shared bridge, so many of them can share
one IP address. If your server limits sessions per IP, read
[docs/operators.md](docs/operators.md) for the two ways to let browser players
in, and for running your own bridge.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md); this repository is a mirror synced
from the development repository, and pull requests are welcome here. Fidelity rules come first: every
value comes from the game data or a reference implementation, never a guess.
Report security problems privately ([SECURITY.md](SECURITY.md)).

## License

GNU Affero General Public License v3.0 or later ([LICENSE](LICENSE)). Parts
of the protocol and data handling are ported from ACE (AGPL-3.0) and ACViewer
(GPL-3.0); see [NOTICE.md](NOTICE.md) for credits. If you run a modified copy
for other people, the AGPL asks you to offer them its source.
