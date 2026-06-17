# localhost-demo

A two-agent demo that runs in a single process to show off the Phase 1 building blocks:

- Scope-filtered capability discovery
- Read-tier invocations (no approval)
- Suggest-tier invocations (host human approves)
- Out-of-scope denial
- Transcript logging on both sides

## Run it

```bash
npm install
npm run demo
```

You'll see the host and visitor sides of a session, with both transcripts interleaved by emoji.

## What it doesn't do (yet)

- No real network — both agents are in-process.
- No auth — the visitor and host blindly trust the session invite.
- No encryption — transport just passes messages by reference.
- No Broker — it's just two libraries holding hands.

All of that lands in Phase 2+.
