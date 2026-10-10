# Security and takedown requests

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
private vulnerability reporting on this repository (Security → Report a
vulnerability). We aim to reply within a week.

In scope: the browser client, the WebSocket-to-UDP bridge
(`services/ws-tcp-bridge`) and the hosted site. Of most interest: anything
that lets the bridge reach hosts outside the server list, bypass its rate
limits, or read another player's session; and anything that leaks a player's
password.

Out of scope: bugs in the game servers themselves (report those to ACE or
GDLE) and denial-of-service by volume.

## Rights holders

If you hold rights in material the project uses or hosts and want it removed,
open a private report the same way, or contact the maintainer listed on the
repository's profile. We act on takedown requests promptly.
