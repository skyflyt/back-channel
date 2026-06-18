# networked-demo

Two-process demo where the host and visitor run in separate Node processes and communicate over a real WebSocket connection.

What this adds beyond the localhost-demo:
- WebSocket transport (one process listens, the other connects)
- ECDH handshake to derive a session key
- AES-256-GCM encrypted message envelopes
- Real CLI approval prompt on the host side

## Run it

**Terminal 1 (host):**
```bash
npm install
npm run demo:net:host
```

**Terminal 2 (visitor):**
```bash
npm run demo:net:visitor
```

You'll see the visitor connect, do the handshake, discover capabilities, read the config, and propose a change. The host terminal will prompt you to approve the change — type `y` or `n`.

## What this doesn't do (yet)

- No Broker — the visitor connects directly to the host. In Phase 3 both agents connect to back-channel.app and the Broker relays.
- No auth — anyone who can reach the WS port can attempt a handshake. Phase 3 adds JWT session tokens + asymmetric agent identity verified by the Broker.
- The public keys exchanged in the handshake aren't authenticated, so an active MITM on the network could substitute keys. Acceptable for a single-machine demo, NOT for the open internet. Phase 3 has the Broker check pubkeys against registered values.

All of that lands in Phase 3 when the Broker comes online.

