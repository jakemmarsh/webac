# Packet-replay corpus fixtures

`ac-session-*.bin` files here are raw inbound (server→client) frames of a real
ACE session, in the `@ac/network` CaptureCodec format (u32-LE length prefix +
bytes per datagram). `tests/verify-session-replay-corpus.ts` replays each one
through the real ClientConnection → ServerMessageHandler and asserts no parse
errors + a stable opcode/event histogram (snapshot).

## Capturing one (requires a working local ACE)

    BRIDGE_CAPTURE=tests/fixtures/ac-session-001.bin \
      npx tsx services/ws-tcp-bridge/src/bridge.ts

Then log in and play for a bit (login → world → move / cast a few actions),
and stop the session. The replay suite picks the file up automatically; commit
the `.bin` plus the generated snapshot.

Keep captures small (a short session — tens of KB) so the fixture stays light.

## servers-list-sample.xml

A trimmed copy of acresources/serverslist `Servers.xml` (2026-10-04 shape)
plus deliberately broken items (bad port, bad host, empty id, duplicate id),
read by `tests/verify-bridge-hosting.ts` to exercise the bridge's allowlist
parser.
