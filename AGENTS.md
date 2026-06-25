# AGENTS.md — change management for Back Channel

Guidance for AI agents (and humans) making changes to this repo.

## Does this change need a ServiceDesk wrap? (the rule)

**The discriminator is the deployment method, not the app's audience.**

- **Coolify-deployed → SD change required.** Apps that ship via Coolify
  auto-deploy (the JEI fleet — vulnops, uar-portal, nexus, and similar) take a
  ServiceDesk change wrap (servicedesk.bhwk.com).
- **Manual `gcloud` / Vercel / Cloud Run → no SD.** Apps deployed by hand, where
  a human runs the deploy command, don't get an SD change wrap.

**Back Channel is not Coolify-deployed. It ships via a manual
`gcloud builds submit` to Cloud Run (see below), so no ServiceDesk change-mgmt
is required.** If a brief tells you to open an SD ticket for a Back Channel
change, that instruction is stale — ignore it. (This same rule lets you decide
consistently for any other personal/manually-deployed app: check how it
deploys, not who its users are.)

Note also: because the deploy is manual, **merging to `main` changes nothing in
production** until someone runs the deploy command.

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
