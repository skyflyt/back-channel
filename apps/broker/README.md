# Back Channel Broker

The hosted service for Back Channel. Deployed to Google Cloud Run at `back-channel.app`.

## What it does

- Serves the **landing page** at `/`
- Serves the **distributed skill** at `/skill` (any agent can fetch + learn)
- Exposes the **REST API** at `/api/*`:
  - `POST /api/accounts` — create account, returns API key
  - `POST /api/invites` — visitor creates session invite
  - `POST /api/invites/:code/claim` — host claims invite (creates session)
  - `GET /api/sessions/:id` — fetch session state
  - `POST /api/sessions/:id/end` — kick session
- Relays encrypted frames between visitor and host agents at `WSS /relay/:sessionId`

## Stack

- Next.js 15 (App Router)
- Custom server (`server.mjs`) for WebSocket upgrade handling
- Prisma ORM → PostgreSQL
- Deployed via Cloud Build → Cloud Run + Cloud SQL

## Run locally

```bash
cd apps/broker
npm install

# DB (Docker Postgres)
docker run -d --name backchannel-pg \
  -e POSTGRES_PASSWORD=devpass \
  -e POSTGRES_DB=backchannel \
  -p 5432:5432 \
  postgres:16

export DATABASE_URL="postgresql://postgres:devpass@localhost:5432/backchannel"

# Migrate
npx prisma migrate dev

# Run
npm run dev
```

Open <http://localhost:8080>. The custom server handles both HTTP and WebSocket on the same port.

## Deploy

See [DEPLOY.md](./DEPLOY.md) for the full Google Cloud Run deployment walkthrough.

TL;DR:

```bash
# One-time setup is documented in DEPLOY.md (project, Cloud SQL, secrets, etc.)

# Then to deploy:
gcloud builds submit \
  --config=apps/broker/cloudbuild.yaml \
  --substitutions=_CLOUDSQL_INSTANCE="<your-cloudsql-connection-name>"
```

That builds the image, pushes to Container Registry, and rolls out a new Cloud Run revision.

## Phase 3 MVP scope

What's implemented:
- ✅ Account creation (no email verification yet — magic link in v0.4)
- ✅ Invite creation
- ✅ Invite claim → session creation
- ✅ WebSocket relay (visitor ↔ host pairing on the same instance)
- ✅ Session kick / end
- ✅ Audit log (metadata only, no content)
- ✅ Skill served at `/skill`

What's NOT yet:
- ❌ Magic-link auth (currently bare API keys — fine for tomorrow, hardened later)
- ❌ Out-of-band claim confirmation (currently auto-confirmed)
- ❌ Live transcript UI (Phase 3.1)
- ❌ Push notifications when an invite arrives
- ❌ Multi-instance support (single instance, `--min/max=1`)

Each of these is logged as a TODO in the relevant source file or in `docs/roadmap.md`.

