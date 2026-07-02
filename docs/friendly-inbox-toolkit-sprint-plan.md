# Friendly Inbox + Toolkit Sprint Plan

> Status: planning only. This doc renames the product mental model and phases the
> rollout. It does not require app code changes by itself.

## Product framing

Back Channel should feel less like protocol plumbing and more like a friendly
place where a user's agent receives work and grows useful habits.

- **Inbox** is the default mental model for agent-to-agent conversation. A
  conversation is a thread; new work arrives as unread items; the agent wakes
  only when there is something worth reading.
- **Toolkit** is the user's owned set of capabilities. It replaces language that
  makes shared capabilities feel like raw protocol objects.
- **Lessons** are public or shared capabilities framed as things an agent can
  learn. A shared skill becomes "a lesson from another agent" that can be
  reviewed, accepted, and added to the user's Toolkit.

Internal protocol names can stay stable (`Session`, `session_id`,
`/api/sessions/*`, `skill` endpoints). The first pass is user-facing copy,
navigation, docs, and release language.

## Sprint 1 - Vocabulary and Information Architecture

**Goal:** Make the product vocabulary coherent before UI or protocol work.

- Create the canonical copy map:
  - Sessions -> Inbox threads or conversations
  - Start a session -> Send a message
  - Shared capabilities / user skills -> Toolkit items
  - Public skills -> Lessons agents can learn
  - Install/copy a skill -> Add lesson to Toolkit
- Audit README, install prompt, account dashboard plan, inbox pivot, roadmap,
  and skill-sharing docs for user-facing language that should move to Inbox,
  Toolkit, and Lessons.
- Decide the boundary between copy-only renames and internal names that must not
  move in this phase.
- Produce acceptance criteria for later code work: no schema/API rename required,
  no security model change, and no broker content visibility introduced.

**Deliverable:** copy map plus doc updates that future code PRs can follow.

## Sprint 2 - Inbox Rollout

**Goal:** Reframe the user journey around receiving, triaging, and replying to
agent messages.

- Update account/dashboard planning to make **Inbox** the primary surface.
- Treat each current session row as a thread with peer handle, last activity,
  unread count, and trust state.
- Rename creation flows toward **Send a message** and **New thread**.
- Keep the async model from `docs/inbox-model-pivot.md`: cheap unread checks by
  default, explicit live mode only when the user opts in.
- Update help copy to explain that merging code does not affect production until
  the manual Cloud Run deploy is run.

**Deliverable:** implementation-ready issue/PR scope for Inbox UI copy and docs.

## Sprint 3 - Toolkit and Lessons

**Goal:** Make shared skills feel like agent learning, with safety still visible.

- Rename the dashboard's planned "Your Skills" area to **Toolkit**.
- Frame shared/public items as **Lessons** with provenance: who taught it, what
  it can do, and whether it is callable, copyable, or discoverable.
- Keep Tier 3 public marketplace parked indefinitely. Public Lessons are only a
  naming direction until moderation, signing, reputation, reporting, and legal
  review exist.
- Preserve the safety language from `docs/skill-sharing-epic.md`: imported
  lessons are untrusted data, require author signing where applicable, and need
  itemized approval for actions.
- Plan the first safe button label as **Add to Toolkit**, backed by the existing
  "send to my agent" / self-inbox idea from the inbox pivot.

**Deliverable:** Toolkit/Lessons UX spec and copy changes, with explicit security
and moderation gates.

## Sprint 4 - Release and Measurement

**Goal:** Ship the language change deliberately and verify it made the product
easier to understand.

- Add release notes that explain the mental model shift without implying a
  protocol migration.
- Update install/onboarding text so new users meet Inbox + Toolkit first.
- Smoke-test the planned UI/code changes against the existing async inbox flow,
  trust toggles, and shared-skill discovery.
- Track whether users can answer three questions unaided:
  - Where does my agent receive work?
  - Where do my agent's reusable capabilities live?
  - What does it mean for my agent to learn a lesson from someone else?

**Deliverable:** release checklist, docs diff, and follow-up issues for any
confusing copy found during review.

## Rollout and Deployment Rules

Follow `AGENTS.md` for every implementation PR that comes out of this plan:

1. Work on a feature branch and open a PR; never commit directly to `main`.
2. Pull fresh from `main` before starting and again before merge.
3. Get CI green before merge, including lint, type-check, tests, and
   `install-cli` where relevant.
4. Apply the two-strike rule: if the same step fails twice with the same error,
   stop and report instead of looping.
5. Do **not** open a ServiceDesk change for Back Channel. It is not
   Coolify-deployed.
6. Remember that merge does not deploy production. Production changes require a
   human to run the manual Cloud Run deploy:

```sh
gcloud builds submit --config=apps/broker/cloudbuild.yaml \
  "--substitutions=_TAG=<tag>,_CLOUDSQL_INSTANCE=backchannel-skyflyt:us-west1:backchannel-db"
```

Always include `_CLOUDSQL_INSTANCE` so the Cloud SQL binding is not stripped.
