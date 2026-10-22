# Epic: Secrets — an agent uses a secret without ever seeing it (design, not yet built)

**Status:** design only, 2026-10-17; **§9 ruled by Skylar 2026-10-20**. The local broker this builds on runs
on all three of Skylar's machines (private repo `skyflyt/secret-broker`, Python, 111 tests, two adversarial
review passes); nothing in this repo knows about it yet. **It stays private and separate** (§9.1–9.2): this
public repo gets the approval protocol, the dashboard and the worker side; the broker enrols as a client.
Sequenced after Remote app sessions Phase A and the passkey step-up, which it reuses.

---

## 1. Why

Skylar:

> *"we run into things a lot where a password or secret needs to be typed in and you rightly deny typing
> them clear text. what I'm wondering is how do we do this securely?"*

and, once the broker worked:

> *"this should probably be part of back channel."*

Back Channel already answers "may this agent act?" for a PC (Remote app sessions), for a peer (Favors,
Skill sharing) and for a list (Lists). It does not answer "may this agent use *this credential*, and
how?". Today an agent that needs a token either reads a plaintext file (so every agent on the machine can),
gets it pasted into a chat (so it lands in a transcript), or is refused. The broker closes that: the agent
names a secret, the broker uses it on the agent's behalf under a policy the person wrote, and the value
never reaches the agent, its transcript, or the wire.

Making it a Back Channel component gives it the three things a single-machine tool cannot have on its own:
an **approval surface the person already carries** (the dashboard and a passkey, on any device), a place
for the **readiness and audit view** across every PC, and a way for a **dispatched agent on a PC** to use
secrets under the same rails as everything else it does there.

## 2. What the broker is (as built)

One local service per machine, running as its own OS principal (`NT SERVICE\LobySecretBroker`, a
LaunchDaemon on macOS), loopback only, code in an admin-only folder, state under ACLs no agent can read.

- **Names, not values.** `secret://<prefix>/<path>`. The prefix picks a backend: `home/*` and `work/*` are
  two Bitwarden Secrets Manager projects read by one machine account per machine. Each prefix can be cut
  off on its own (delete its project or its backend line) and the other keeps working.
- **Modes.** A policy entry says how a name may be used, never "give me the value":
  - `inject`: run a command with the value in an environment variable; the child's output is redacted
    (raw, base64, hex, URL and JSON/HTML-escaped forms) before the agent sees it.
  - `proxy:http`: the broker makes the HTTP call (host allow-list, header allow-list, no redirects, no
    environment proxy, optional cert pin and basic-auth user) and returns the response.
  - `proxy:oauth`: the broker owns a rotating refresh token and returns access-token-backed calls.
  - `proxy:kvm-type`: types the value into a *different* machine through a NanoKVM (pinned cert), for the
    one case where a value genuinely must be typed somewhere.
- **Tiers.** 0: unattended (routines, publishers). 1: a human approves each use, with a time-boxed grant
  keyed on (name, mode, target, session). 2: approve each use, no grant. 3: never served to an agent
  (Z-Wave keys, recovery codes).
- **Approvals are cryptographic.** The broker shows a request (first and last line: a short request code),
  computes a digest over the bound fields, and only a signature over that digest from an enrolled
  hardware-backed key (Windows Hello `KeyCredentialManager`, Secure Enclave on macOS) approves it. Single-use
  nonce. Policy changes go through the same path, with every field diff listed and bound to the current
  policy hash. Lockdown blocks everything, including admin operations, until a signed unlock.
- **Audit.** Hash-chained `audit.jsonl`, values scrubbed before encoding, one row per decision.
- **`ask`.** A one-time masked prompt on the machine for things nobody wants stored (PINs, MFA codes, a
  pairing code): the person types it, the broker delivers it (`type-local` via SendInput, `kvm-type`,
  `stdin`, `inject`) and forgets it.
- **Install trust root.** Installs only from an admin-only clone of a pinned commit; hash-pinned
  dependencies; the service never loads code an agent could write.

Everything above stays local. The broker works with no network beyond its backends and needs nothing from
Back Channel to serve tier 0. That is a constraint of this epic, not an accident (§8).

## 3. What Back Channel adds

### 3.1 Approve from anywhere, with the passkey you already have (Phase 1)

Today a tier 1–2 request is approved on the machine that raised it (Hello or Touch ID). A request raised on
the desktop while the person is at the laptop, or away, stalls or times out. Back Channel already has the
pieces: an account-wide inbox with a doorbell, a passkey step-up that an agent cannot complete, and a phone
in the person's pocket that holds the passkey.

- The broker **enrols a Back Channel approver** next to its local one: a second public key the broker
  trusts. That key is the account's passkey, used as a WebAuthn assertion key over the broker's challenge
  digest. The broker verifies the assertion locally against the public key it stored at enrolment. **Back
  Channel never holds a key that can approve anything** and never sees a secret: it carries a challenge out
  and a signature back.
- Flow: broker raises a request → the machine's worker posts `{ machine, name, mode, target, tier,
  request_code, digest }` to `POST /api/secret-broker/requests` (its own key) → the inbox rings (doorbell kind
  `secret`) → the dashboard card shows the request in the broker's own display text, request code first and
  last → the person taps Approve → WebAuthn step-up with `action = approve_secret`, `rpId` back-channel.app,
  **challenge = the broker's digest** → the assertion goes back to the worker → the worker hands it to the
  broker → the broker checks the signature, the nonce and the digest, exactly as it would a local one.
- The dashboard shows the request code in large type and the person is told, once at enrolment and on
  every card, to compare it with what the requesting agent said. A request the person did not expect is a
  Deny, which is one click and never gated.
- Deny and **Lockdown** from the card are one click each (Lockdown goes down as a signed admin op from the
  phone, same path). Unlock needs a step-up.
- Expiry: the broker's request timeout governs; a request the broker has already closed is shown as such
  and the card's Approve is gone (the broker rejects a late assertion by nonce anyway).

What this does *not* change: tier 0 never asks anyone; tier 3 is never raised; `proxy:kvm-type` stays
tier 2 and may **not** be approved remotely in v1 (the person should be looking at the machine being typed
into); policy changes may be approved remotely only when the diff fits on the card uncut (≤ 10 field
changes), otherwise local only.

### 3.2 A dispatched agent uses secrets under the broker (Phase 2)

A Dispatch run on a PC (`remote-app`, `remote-support`, `lists` profiles) gets a second MCP server,
`bc_secrets`, built on the worker's existing private bridge (`packages/worker/src/mcp-bridge.mjs`): the CLI
process holds no key, each call crosses the nonce-guarded pipe to the worker, and the worker talks to the
broker over loopback with the broker's PID check.

Tools, all of which return only what the broker's modes already return (never a value):
- `bc_secret_names` — names this run may use, with tier and modes (the broker's `names`, filtered).
- `bc_secret_http` — `proxy:http` / `proxy:oauth` call by name.
- `bc_secret_run` — `inject` with redacted output.
- `bc_secret_ask` — raise an `ask` for the person at that PC (one-time value; the run gets only `done`).

The broker learns the **run identity**: `session = <dispatch task id>` and the driving agent's handle, so
grants are keyed per run and the audit row names the task. A run's secret use shows up in the task's progress
("used `home/homeassistant/token` (proxy:http) ×3") the way steps do in a remote-app session, counts only, no
targets with query strings.

Policy gets one new field per entry, `runs = ["remote-app", "lists"]`: which Dispatch profiles may use the
name at all. Default: none. A name with no `runs` is invisible to dispatched agents, so adopting Phase 2 on a
machine changes nothing until the person opts a name in, under a signed policy change.

### 3.3 Readiness and the audit view (Phase 1, small)

- The readiness card (`apps/broker/src/app/account/remote/agents-readiness.tsx`) gains a line per PC: *secret broker:
  installed 0.3.1 at commit `abc1234`, service running, 14 names, lockdown off, last approval 2 h ago* or
  *not installed*. The worker reads `secret-broker status --json` for it; nothing else is sent.
- The account audit gains event types `secret.requested`, `secret.approved`, `secret.denied`,
  `secret.lockdown`, `secret.unlock`, metadata only: machine, name, mode, tier, request code, who approved
  and how (local / passkey). Never the target URL's query, never a value, never the redacted output. The
  broker's own hash-chained log stays the record; this is the person's cross-machine view of it.

### 3.4 Install and set up from the readiness card (Phase 1)

When a PC's broker line says *not installed* or *out of date*, the card offers **Install** or **Update**. The
worker on that PC does what it can unattended; the person does the three steps that must happen at the
machine on purpose. Setting up a machine today is a dozen hand-typed commands across two shells, which is
exactly the hand-off the broker exists to remove.

1. **Ask.** The person clicks Install on that PC's card → `POST /api/secret-broker/install/{machine}` (person,
   step-up) records an install intent for the commit the card shows. The worker picks it up on its next
   poll (`GET /api/agents/self/secret-install`, worker key).
2. **Fetch and launch.** The worker fetches the broker at that commit with the machine's own GitHub login,
   checks the fetched tree against the pin (below), and launches the broker's own bootstrap elevated
   (Windows: `Start-Process -Verb RunAs`; macOS: the system administrator-password dialog). **The UAC or
   macOS prompt on the machine is the gate.** The worker itself never runs elevated, and it passes nothing
   to the bootstrap except the commit and the backend project ids, which are not secrets.
3. **Checklist.** The card ticks each step from what the worker can observe without touching a secret
   (`secret-broker status --json` and `doctor --json`, exit codes):
   - installer started, then finished (exit code)
   - service running at the expected commit
   - local approver enrolled: **Hello / Touch ID gesture at the machine**
   - backend machine token stored: **typed into the broker's type-once box on that machine**, never into the
     dashboard (rule 1)
   - doctor healthy (canary reachable)
   - optional: phone approvals enrolled (§3.1): a step-up here plus a signed admin op on the broker
4. **Update** is the same flow with the broker's update-only mode; the card shows *from → to* commit and the
   checklist shrinks to installer, service, doctor.

Constraints:
- **Only for the owner of the broker repo.** The broker is private (§9.1), so the fetch uses that machine's
  GitHub login. A machine without access shows *cannot fetch the broker* and a link to set up `gh` there.
- **Back Channel cannot choose the code.** The broker repo publishes its current release pin (commit and tree
  hash) on its main branch; the dashboard shows it and the worker refuses any fetched tree that does not
  match it. A compromised Back Channel account can at most offer the release the broker repo already pins,
  and the person still has to accept the UAC prompt at the machine.
- **No secret crosses Back Channel.** The checklist is booleans and commit ids. The machine token, the Hello
  enrolment and the UAC consent all stay on the machine.

### 3.6 One tap on the phone: the nudge, the long-poll and the checklist (Phase 1b, built 2026-10-22)

Phase 1 answered requests in the BC Remote app, but the app only looked while its Secrets screen was open, or every
10 s while an alerts service ran for a paired PC. A request raised with the phone in a pocket was missed. Phase 1b:

- **The phones' channel.** Back Channel keeps, per account, a version that moves whenever a secret request is
  raised, approved, denied, closed or expires (`fireSecretsChanged`, `src/lib/inbox-bus.mjs`; its own waiters, never
  the inbox's). `GET /api/appbridge/v1/devices/self/secret-broker?wait=25&since=<version>` holds until the version
  passes `since` or 25 s are up, then answers the list and the new version. The app's screen needs no timer.
- **The push nudge.** The app hands over its Firebase Cloud Messaging token (`PUT /devices/self/push`); on every
  change Back Channel sends each of the account's phones one high-priority data message, five minutes to live,
  carrying `{ kind: "secrets" }` and nothing else (`src/lib/push.ts`, on with `FCM_PUSH=on`, signed with the
  service's own default credentials). The phone then reads the list with its credential and shows one notification
  per request, with Approve and Deny on it; a request answered elsewhere withdraws it. Google learns that a phone
  was nudged at a time, never a code, a PC or a name. Where push is off or Play services is missing, the app falls
  back to the long-poll from its own foreground service. The token is cleared when the device is revoked or unregisters.
- **The checklist** (the app's first run): is this phone connected to Back Channel; does a PC have the broker
  (`machines` on the device view: installed, healthy, and which of the account's passkeys it trusts); can this
  phone approve for it (**Trust this phone**: the secret_broker_admin ceremony answered by the phone's own passkey,
  `machines/{agentId}/enrol-options` and `enrol-verify`; the passkey that answered is the one the worker's enrol job
  asks the broker to trust, and the broker's Hello card at the PC still decides); and **Try it**
  (`machines/{agentId}/test { ref }`: a `test` job, no step-up, in which the worker runs the broker's own
  `secret-broker run --ref <name>` around a throwaway command that exits at once, so the broker raises an ordinary
  request the person answers from the phone; the worker reports only approved, denied or failed). Rule 1 holds: the
  value goes into that child's environment on the PC and nowhere else, and the name should be a fixture made for this.

### 3.5 Later, maybe: `ask` answered from the phone (Phase 3, undecided)

An MFA code typed on the phone instead of walking to the machine. It is tempting and it is the one place
this design would move a secret value through Back Channel. It would have to be sealed on the phone to the
broker's public key (the broker never had one; it would need one) so the broker's row stays ciphertext, and
even then a phone's browser is a worse place to type a code than the machine's masked prompt. Not in v1;
listed so nobody builds it by accident.

## 4. Rules (the short list a reviewer should check)

1. **Back Channel never holds, relays or caches a secret value**, in any phase. Not sealed, not hashed. A
   PR that adds a column, a frame field or a log line that could hold one is wrong by construction.
2. **Back Channel never holds a key that can approve a secret use.** The passkey's private key is in the
   authenticator; the broker holds the public key; the step-up endpoint verifies for *its own* purposes
   and forwards the assertion, it does not mint a grant the broker trusts.
3. **The broker decides; Back Channel displays.** Every check (tier, grant, nonce, digest, policy hash,
   lockdown) happens in the broker. A compromised broker-side Back Channel account can deny you service
   (spam requests, hide cards), not use a secret.
4. **An agent can't approve its own request** here any more than it can approve a remote-app session: the
   step-up is a credential prompt, off-limits to a dispatched agent; a local agent cannot make the Hello
   gesture; the request code is shown on the card for the human to compare.
5. **Offline is normal.** No tier-0 path and no local approval path depends on back-channel.app. If the
   worker cannot reach the broker service, the broker is unreachable, not insecure; if it cannot reach
   Back Channel, approvals fall back to local only.
6. **Public protocol, private broker, private policy** (ruled 2026-10-20). This repo holds the approval
   protocol (`SecretRequest`, the routes, the `approve_secret` step-up), the dashboard and the worker's
   bridge, and documents the broker's loopback interface it talks to. The broker's code stays in the private
   sibling repo. The names, tiers, hosts, pins and the inventory of what exists stay in the person's own
   config and vault. Nothing in this repo may need the broker's source to build or test: worker tests run
   against a fake broker that speaks the documented interface.

## 5. Threat model additions (over `docs/threat-model.md`)

| Threat | Where it is stopped |
|---|---|
| Agent on the PC reads the secret store | Broker runs as another principal; state ACL'd; code admin-only (as built) |
| Agent forges an approval | Approval = signature over digest from a hardware key; single-use nonce; agent can't make the gesture or complete a step-up |
| Agent approves from the PC's signed-in dashboard | Step-up is a credential prompt (off-limits list); passkey on phone needs the phone |
| Confused person approves the wrong request | Request code first/last on the card and from the agent; Deny is one click; one request per card |
| Back Channel account compromised | Can raise fake cards and deny service; cannot sign (no key), cannot read values (never had them); fake cards carry no valid broker digest, and the broker only accepts assertions over digests *it* issued |
| Broker's Back Channel enrolment stolen | It is a public key; nothing to steal that approves |
| Dispatched run exfiltrates via a proxy call | Host and header allow-lists per name; `runs` opt-in per name; redaction on `inject`; counts-only reporting |
| Value lands in a transcript | Tool replies carry responses and `[REDACTED]`, never values; `ask` returns `done` |
| Replay of an old assertion | Nonce single-use; digest binds name, mode, target, session, policy hash, time window |
| Back Channel account used to push bad code through Install (§3.4) | The worker installs only the commit and tree hash the broker repo pins; the fetch needs the machine's own GitHub access; the UAC or macOS admin prompt at the machine is the final gate |
| Install flow used to capture the machine token | The token is typed into the broker's type-once box on the machine; the dashboard has no field for it and the checklist carries booleans only |

## 6. Data (broker side of Back Channel)

```
SecretRequest   id, accountId, agentId (the worker), machine, name, mode, tier, target (host+method+path, no query),
                requestCode, digest, status (open|approved|denied|expired|closed_by_broker), raisedAt, expiresAt,
                decidedAt, decidedBy (passkey credential id | 'local' | null)
SecretEnrolment accountId, machine, credentialId, publicKey (COSE), enrolledAt, revokedAt
SecretInstall   id, accountId, agentId (the worker), machine, kind (install|update), commit, treeHash,
                state (requested|fetching|awaiting_elevation|running|done|failed), steps (booleans per §3.4),
                requestedAt, finishedAt, failure (short code, no free text from the machine)
AccountAudit    + secret.requested / approved / denied / lockdown / unlock / enrolled / revoked
```
No value column exists. `target` is stored without query or fragment and truncated at 200 characters.

## 7. Endpoints and tools

- `POST /api/secret-broker/requests` (worker key) — raise; `GET /api/secret-broker/requests?open=1` (person) — list.
- `POST /api/secret-broker/requests/{id}/approve` — needs `x-bc-step-up` grant for `approve_secret` + this id,
  whose WebAuthn challenge **was the broker's digest**; returns the assertion for the worker to collect at
  `GET /api/secret-broker/requests/{id}` (worker key, once).
- `POST /api/secret-broker/requests/{id}/deny`, `POST /api/secret-broker/lockdown/{machine}` — one click, not gated.
- `POST /api/secret-broker/enrol` (worker key, with a step-up by the person) — register the passkey public key for
  a machine; the broker itself completes enrolment locally under a signed admin op.
- `POST /api/secret-broker/install/{machine}` (person, step-up) — ask that PC's worker to install or update the
  pinned broker release (§3.4); `GET /api/agents/self/secret-install` (worker key) — pick up the intent;
  `POST /api/agents/self/secret-install/{id}/progress` (worker key) — tick checklist steps.
- MCP (full-scope keys): `bc_secret_requests`, `bc_secret_deny`, `bc_secret_lockdown`. **No approve tool**:
  approving needs the step-up a tool can't do. **No install tool either**: an install starts from the
  dashboard with a step-up, never from an agent.
- Worker: `bc_secrets` MCP server for runs (§3.2), readiness line (§3.3).

## 8. Non-goals

- Replacing Bitwarden / Devolutions. The broker is a policy and approval layer over vaults, not a vault.
- A hosted secret store "for convenience". See rule 1.
- Peer use: a friend's agent asking to use *your* secret. A favor (`favors-epic.md`) runs on your side with
  your agent, which may use your secrets under your policy; the requester never names one.
- Agents approving for other agents.

## 9. Decisions (ruled by Skylar, 2026-10-20)

1. **Public?** **Back Channel stays public; the broker stays private.** Back Channel's install story rests
   on its source being public (the skill tells other people's agents to check it). The broker's history
   carries operational detail of one person's estate (an acceptance log naming machines, hosts and audit
   rows; a policy example with home IPs and cert pins), so publishing it would need a cleaned fresh repo
   first. Not doing that now.
2. **Where it lives.** **The private sibling repo `skyflyt/secret-broker`**, not a package here. Back
   Channel publishes the generic parts (the phone-approval API and the passkey step-up for a caller-supplied
   challenge), which any local approver could use, and the broker enrols with it as a client (§3.1). The
   broker's installer keeps its "admin-only clone of a pinned commit" trust root against its own repo.
3. **Remote approval of tier 2.** **Allowed from the phone**, except `proxy:kvm-type` and policy diffs over
   10 field changes, which stay local only (as §3.1).
4. **Phase order.** **3.1 + 3.3 first** (approvals and readiness; no new agent capability), 3.2 after.

## 10. Phases

- **Phase 0** (this doc; the private broker as shipped).
- **Phase 1** — broker (in `skyflyt/secret-broker`, private): second approver kind `webauthn` (verify an
  assertion over the digest against a stored COSE key; enrolment op); `status --json` / `doctor --json`;
  a published release pin (commit + tree hash). Back Channel (here, public): `SecretRequest`, the routes, the
  inbox card, `approve_secret` step-up action with caller-supplied challenge, readiness line, audit events,
  and Install / Update from the readiness card (§3.4: `SecretInstall`, the worker's fetch-verify-elevate step,
  the checklist). Tests: rules pure under `node --test`; a route test that proves an approve without a
  step-up is `403`, that a step-up for another request's id does not spend, that no response body anywhere
  carries a field named like a value, that an install without a step-up is `403`, and a worker test that a
  fetched tree not matching the pin is refused before anything is launched.
- **Phase 2** — worker `bc_secrets` bridge and `runs` policy field; broker learns run identity.
- **Phase 3** — undecided (§3.5).
