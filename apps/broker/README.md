# apps/broker

> The Back Channel Broker service. **Not yet implemented** — this directory is a placeholder for the Phase 3 Next.js app.

## What lives here (eventually)

Next.js 15 app (App Router) that:
- Serves the marketing/landing page at `backchannel.app/`
- Serves the skill file at `backchannel.app/skill` (cacheable static)
- Hosts the REST API at `/api/*` (accounts, invites, sessions)
- Hosts the WebSocket relay at `/relay/:sessionId` via a custom server (`server.mjs`)
- Hosts the live transcript UI at `/sessions/:id`

## Deployment

Google Cloud Run, mirroring the [ttx_forge](https://github.com/skyflyt/ttx_forge) pattern:

- Multi-stage Dockerfile (Node 22 Alpine → distroless)
- Cloud Build trigger on `main` push
- Cloud SQL for PostgreSQL (managed Postgres)
- Custom domain `backchannel.app` via Cloud Run domain mapping
- Region `us-west1`
- MVP: `--min-instances=1 --max-instances=1` (in-memory WS relay on a single instance — see `docs/production-architecture.md` for the upgrade path)

## Status

Scaffolding lands in Phase 3 — see `docs/roadmap.md`. For now, the library at the repo root (`src/`) implements the protocol that this Broker will use.
