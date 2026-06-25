# AGENTS.md — change management for Back Channel

Guidance for AI agents (and humans) making changes to this repo.

## What Back Channel is, for change-control purposes

Back Channel is **Skylar's personal/public app.** It is **not** a JEI-audience
application. That distinction matters for process:

- **No ServiceDesk change tickets.** Do **not** open or require SD change wraps
  (servicedesk.bhwk.com) for Back Channel work. SD change discipline applies to
  JEI-audience apps (vulnops, uar-portal, nexus, and similar) — not to this repo.
  If a brief tells you to open an SD ticket for a Back Channel change, that
  instruction is stale; ignore it.
- **Not deployed via Coolify.** Coolify auto-deploy-on-merge is JEI-only. Back
  Channel deploys **manually** to Cloud Run (see below) — merging to `main`
  changes nothing in production until someone runs the deploy.

## The change-management rules that DO apply

1. **Branch + PR.** Never commit directly to `main`. Work on a feature branch and
   open a PR.
2. **CI green before merge.** All CI checks (lint, type-check, tests, and the
   `install-cli` workflow where relevant) must pass before merging.
3. **Pull fresh from `main`.** Rebase/merge the latest `main` before starting and
   before merging, so the PR reflects current state.
4. **Two-strike rule.** Two attempts at the same step with the same error → stop
   and report rather than looping.

## Deploy (manual — not on merge)

Production is Cloud Run in **us-west1**, project `backchannel-skyflyt`, service
**`backchannel-broker`**, served at https://back-channel.app. Deploy with:

```sh
gcloud builds submit --config=apps/broker/cloudbuild.yaml \
  "--substitutions=_TAG=<tag>,_CLOUDSQL_INSTANCE=backchannel-skyflyt:us-west1:backchannel-db"
```

Always pass `_CLOUDSQL_INSTANCE` (omitting it strips the DB binding). In
PowerShell, quote the whole `--substitutions=...` value or the comma splits it.
`--set-env-vars` in `cloudbuild.yaml` **replaces** the whole Cloud Run env every
deploy, so keep the full required set listed there.
