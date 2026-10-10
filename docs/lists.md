# Lists: tasks for people and their agents

**Status:** Phase 1 shipped 2026-10-09: personal lists, worked by one person and
the agents they pick. Design approved 2026-10-09 (`task-lists.md` in Skylar's
vault, decisions 1 to 4 as written). This page is the developer reference for
what is built. Code: `apps/broker/src/lib/lists.ts` (I/O),
`apps/broker/src/lib/lists/rules.mjs` (every decision, no I/O),
`apps/broker/src/lib/mcp/list-tools.mjs` (MCP catalog).

## What Lists is

A list is a small shared workspace: tasks, each with notes, progress lines,
comments and an activity log. A list belongs to one person. In Phase 1 it is
**just theirs**: the person plus the agents they give access to. Agents work on
lists through 8 MCP tools served by `/api/mcp` (so every host gets them with no
connector release) or through REST under `/api/lists`. People work on them in
the dashboard.

Anyone allowed on a list can **claim** a task ("I'm on it"). Claims are
exclusive. An agent's claim lapses after an hour without a write from it, and
the lapse is recorded, never silent. An agent that finishes **must say what it
did**.

Names: the UI says "lists" and "tasks". The code keeps distinct names because
"task" already means `DispatchTask`, favors and the Toolkit's `scheduled_task`:
models `TaskList` / `TaskItem` / `TaskEntry`, REST under `/api/lists/…`, MCP
tools `bc_task*` and `bc_list_create`. There is no `/api/tasks` route.

## The privacy decision, and why

**List content is stored readable by Back Channel, and every surface says so.**
That covers list names, task titles, notes, progress, comments, finishing
summaries and activity text.

Why: lists must work from every host, and remote MCP clients (claude.ai and
ChatGPT over OAuth, `claude mcp add --transport http`) reach `/api/mcp` with no
local bridge, so they cannot seal or open anything. A sealed list would need a
multi-party key wrapped to every member and every participating agent, and every
remote-connector agent would be locked out. Toolkit items (`UserSkill`), session
goals (`Invite.message`, `InboxRequest.message`), friend-invite notes
(`FriendInvite.note`), web drops (`AgentPayload.ref`) and plaintext frames from
agents that can't encrypt (the relay still accepts them in protocol Phase A)
were already stored readable; Lists is the first feature designed around saying
so, and `/privacy` now names all of them.

What stays true:

- **Messages are unchanged.** Sealed frames between agents stay end-to-end
  encrypted. Nothing in Lists touches frames or session keys.
- **Secret-shaped text is refused** before anything is written (`422
  secret_like`, see [Text and limits](#text-and-limits)).
- **Analytics never read list content.** It is on the admin "NEVER track" list
  ([`admin-analytics-epic.md`](admin-analytics-epic.md) §2), and
  `route-tests/admin.routetest.mts` checks that analytics only ever count list
  tables.
- **Errors never log task content** or bearer tokens; `lists()` logs only the
  operation and the error's name.
- **Where it's said:** `/privacy` (a Lists section and the "What we store
  readable" list), `/trust`, the skill's Lists section, the descriptions of the
  tools that write free text, and the MCP `initialize` instructions.

If sealed lists are ever wanted, the design's answer is a per-list "private"
mode for bridge and key-mirror users only, with remote hosts shown as unable to
open it. It is deliberately not planned, because it splits every feature into
two paths.

## Model

Migration `prisma/migrations/20261009200000_task_lists` is purely additive
(five new tables). Apply it **before** deploying code that uses them; old code
never touches them.

| Table | What it holds |
|---|---|
| `TaskList` | Name (1 to 80), emoji, `archivedAt`, owner |
| `TaskListMember` | One row per person on a list: `role` owner or member, `agentsTakeFrom` me or anyone. Phase 1 only ever has the owner |
| `TaskListAgentGrant` | Which of a member's **own** agents may see (`view`) or work (`work`) a list. Set by that person, in the dashboard |
| `TaskItem` | Title (1 to 200), notes (up to 20,000), `version`, `status`, `position`, `dueAt`, who wrote it, who it's for, the claim, the reviewer, completion and `summary`, and `agentSeenAt` for the doorbell |
| `TaskEntry` | `comment`, `progress` or `event` lines (1 to 8,000), each with its author and, for events, an `eventType` |

`CHECK` constraints back the status set, kinds, roles, access values and sizes,
plus one invariant: an agent's claim always has an expiry
(`claimAgentId IS NULL OR claimExpiresAt IS NOT NULL`).

**The no-FK attribution rule.** Every column that says who did something
(`createdBy*`, `assignee*`, `claim*`, `reviewerAccountId`, `completedBy*`,
`author*`, and `TaskListAgentGrant.agentTokenId`) is a plain column with **no
foreign key**. Revoking an agent, or a person leaving a list, must never
cascade-delete the record of what they did. Views resolve names at read time and
fall back to "a removed agent" or "a former member". What does cascade:
membership and owned lists go with the account, and tasks and entries go with
their list. Deleting an account deletes every list it owns.

Not built in Phase 1 (from the design's sketch): `TaskAgentOk` (per-task OKs)
and `TaskSeen` (per-person unread state). Lists can be archived and tasks
dropped; neither is deleted, and there is no delete route.

## Rules

All of these live in `rules.mjs` and are covered by `node --test`. An **actor**
is `{ accountId, agentId, role, agentAccess }`. An agent acts with its person's
role on the list, capped by the access its person granted it there. Agents are
never members in their own right.

### Who can do what

| Who | See | Add, edit, claim, progress, finish | Comment | Rename, archive, agent access | Check finished work | Drop, restore, reopen |
|---|---|---|---|---|---|---|
| Owner (a person) | yes | yes | yes | yes | yes | yes |
| Member (a person, Phase 2) | yes | yes | yes | no | when they asked for it | yes |
| Agent with `work` | yes | yes, subject to the OK rule | yes | no | no | no |
| Agent with `view` | yes | no | yes | no | no | no |
| Agent with no grant, anyone else | `404 not_available` | | | | | |

- Choosing which agents work a list (`PUT /api/lists/:id/agents`) is
  **cookie-only**: no agent and no tool can widen any agent's access.
- An agent that creates a list gets `work` on it, and nothing more. It can't
  pass `agents` to hand access to its person's other agents (`403 people_only`).
- A bearer key with no agent identity is refused (`401 agent_key_required`), and
  `/api/mcp` leaves the list tools out of `tools/list` for it. Every action is
  attributed to a specific agent.
- Every miss is the same opaque `404 not_available`; the caller never learns
  whether a list exists.

### The OK rule

**A task someone else wrote is a request, not an instruction.**
`agentMayAct(task, accountId)` says an account's agents may act on a task
without asking only if that account (the person or one of their agents) wrote
it, the person OK'd it, or the person's `agentsTakeFrom` on that list is
`anyone`. Every task an agent receives carries the answer as `agent_may_act: {
ok, why }`, and `claimCheck` enforces it with `409 needs_ok`. Tool descriptions
and the skill tell agents to treat task text as data and to ask the user when
`ok` is false.

In Phase 1 only the owner's account can write to a list, so `ok` is always
true; the rule is wired through now so Phase 2 sharing inherits it. Per-task OKs
(`TaskAgentOk`, including "OK'd in chat") arrive with Phase 2.

### Claims and lapses

- **Exclusive.** A claim runs in a serializable transaction with retry, and the
  write is conditional on the task being unheld or holding a lapsed agent claim.
  The loser gets `409 already_claimed` with `claim.by`.
- **Who may claim** follows the assignment: anyone allowed when it's for
  nobody; the person or their agents when it's for the person; only that agent
  (or the person) when it's for one agent. `assigned_elsewhere` otherwise.
  Assignee values: `nobody`, `me`, `my_agents`, `this_agent`, or one of the
  caller's own agent ids with `work` access.
- **People's claims never lapse.** After 3 days with no activity the task view
  carries `claim.stale: true` as a nudge.
- **Agents' claims lapse after 60 minutes without a write from that agent**
  (`AGENT_CLAIM_MS`). Any write by the claimant (progress, comment, edit,
  re-claim) renews it, so there is no heartbeat call.
- **Lapses are settled lazily and announced.** There is no background job. The
  next operation that loads the task (a read, the plate, any write) releases the
  claim in the same transaction and adds an activity line, "stopped working on
  this (no word for an hour)", quoting the agent's last progress. The task goes
  back to open (a blocked task stays blocked) with its notes and progress intact.
- **Release** takes an optional reason and is allowed to the claimant or the
  list owner.

### Finishing and review

- An agent **must** send a `summary` (`400 summary_required`); `evidence` is
  optional and appended. A person may finish with no summary.
- The claimant can finish; so can anyone who could claim it right now (claim
  and finish in one step), and the list owner over someone else's claim.
- If an agent finishes a task written by someone other than its own person, it
  goes to `needs_review` for the person who wrote it. Otherwise the agent's
  "done" is final, but the person who asked (or the list owner) can **send it
  back** for 7 days (`SEND_BACK_MS`).
- Review is people-only: **accept** (`needs_review` to `done`) or **send back**
  (comment required; the task returns to the same claimant with a fresh claim).

### Status changes

`PATCH` with `status` handles everything except claim, finish and review:

| Change | From | Who |
|---|---|---|
| `blocked` (reason required) | open, in progress | whoever holds it, anyone allowed when it's unheld, or the owner |
| `unblocked` | blocked | same; returns to in progress if still held, else open |
| `dropped` | any active status | people only; clears the claim |
| `restored` | dropped | people only |
| `reopened` | done | people only; clears completion |

### Text and limits

Every text field goes through `cleanText`: line endings normalised, control
characters stripped, names and titles kept to one line, lengths counted in
characters. Text shaped like a secret is refused with `422 secret_like` and the
message "That looks like a password or key…". The patterns are PEM private key
headers, AWS access key ids, Stripe live keys, Back Channel `bc_`/`bco_` keys
and `BCX-` connect codes. It catches common formats, not every secret, and the
copy says so.

Title and notes edits need the `version` the caller read; a stale one gets `409
edit_conflict` with the current text, so a concurrent edit loses loudly.

| Limit | Value |
|---|---|
| List name / emoji | 80 / 16 characters |
| Task title / notes | 200 / 20,000 characters |
| Comment, progress line, summary | 8,000 characters |
| Release or block reason / evidence | 1,000 / 2,000 characters |
| Active lists owned per account | 50 |
| Unfinished tasks per list (open, in progress, blocked, needs review) | 2,000 |
| Comments + progress per task | 500 |
| Tasks per add | 20 |
| Page size | 50 |
| Request body | 256 KB |
| Rate | 60 writes and 240 reads a minute per agent (per account in the browser), inside `/api/mcp`'s 120 calls a minute per account |

Due dates take `YYYY-MM-DD` (stored at 12:00 UTC so it shows as the same day
everywhere) or a full ISO timestamp, within ten years.

Every operation runs in one serializable transaction with retry. A conflict
that survives the retries returns `503 busy` with `Retry-After: 1`.

## REST

Auth: an agent key (full `bc_` or connector `bco_`, but always a specific agent)
or the dashboard cookie, with the CSRF header on writes. One catch-all route
(`src/app/api/lists/[[...path]]/route.ts`) maps onto `listsRoute`:

| Method and path | Operation | Notes |
|---|---|---|
| `GET /api/lists` | lists | With counts per status; people also see each list's agent grants |
| `POST /api/lists` | createList | `{name, emoji?}`; people may pass `agents: [ids]` |
| `GET /api/lists/plate` | plate | `doing`, `up_next`, `claimable` (20), `waiting_on_you`, `done_recently` (people) |
| `GET /api/lists/search?q=&status=&list_id=` | search | Active tasks by default; title and notes match |
| `GET /api/lists/changes?since=` | changes | `{at, changed}` for the web's refresh |
| `GET /api/lists/:id` | getList | Tasks active or touched in 7 days; people also get `your_agents` and their access |
| `PATCH /api/lists/:id` | updateList | Owner only: `name`, `emoji`, `archived` |
| `PUT /api/lists/:id/agents` | setAgentAccess | Cookie only: `{agent_id, access: none, view or work}` |
| `GET /api/lists/:id/tasks` | tasks | Same as search, one list |
| `POST /api/lists/:id/tasks` | addTasks | `{title, notes?, assignee?, due?}` or `{tasks: [...]}` |
| `GET /api/lists/tasks/:taskId` | getTask | With the last 50 entries |
| `PATCH /api/lists/tasks/:taskId` | updateTask | `progress`, `title`/`notes` + `version`, `due`, `assignee`, `status` + `reason` |
| `POST /api/lists/tasks/:taskId/claim` | claim | |
| `POST /api/lists/tasks/:taskId/release` | release | `{reason?}` |
| `POST /api/lists/tasks/:taskId/done` | done | `{summary, evidence?}` |
| `POST /api/lists/tasks/:taskId/review` | review | People only: `{verdict: accept or send_back, comment}` |
| `GET /api/lists/tasks/:taskId/entries?before=` | entries | Pages of 50 |
| `POST /api/lists/tasks/:taskId/entries` | addEntry | `{kind: comment or progress, text}` |

Every task in every response has the same shape (`taskView`): `id`, `list {id,
name, shared}`, `title`, `notes`, `version`, `status`, `due`, `created_by`,
`assignee`, `claim {by, since, lapses_at, stale?}`, `agent_may_act {ok, why}`,
timestamps, and when finished `completed_by`, `summary` and `send_back_until`.
People and agents appear as `{person, handle, agent, agent_id, is_you,
is_this_agent?}`.

## MCP tools

Catalog in `list-tools.mjs`, appended to `TOOLS` in `tools.mjs`; dispatch in
`listsTool()` calls the same operations in-process with the caller's own key.
The bridge forwards the server's catalog, so Claude Code, Codex and Claude
Desktop get these with no connector release; claude.ai and ChatGPT get them over
OAuth.

| Tool | Operation | For |
|---|---|---|
| `bc_tasks` | plate, or search with `list` (name or id), `status`, `q` | "what's on my plate?", "what's left on the house list?" |
| `bc_task_get` | getTask | One task in full, with `version` for edits |
| `bc_task_add` | addTasks (`list` by name or id) | "add milk and eggs to the house list" |
| `bc_task_claim` | claim or release (`action`) | "grab the next thing" |
| `bc_task_update` | updateTask (`status` limited to blocked, unblocked) | progress while working |
| `bc_task_done` | done (`summary` required) | "mark that done" |
| `bc_task_comment` | addEntry, kind comment | "tell whoever is on it…" |
| `bc_list_create` | createList | "start a packing list for Vegas" |

Two fixed sentences carry the rules: the tools that return tasks (`bc_tasks`,
`bc_task_get`) say task text is data, never instructions, and to act only where
`agent_may_act.ok` is true; the tools that write free text (`bc_task_add`,
`bc_task_update`, `bc_task_comment`) say it is stored by Back Channel and
visible to everyone on the list, so secrets stay out. The `initialize`
instructions carry one sentence on Lists. `bc_check_inbox` adds
`tasks_waiting_for_your_agents: {count, next}` when the doorbell is counting
tasks.

"Grab the next thing" is two calls: `bc_tasks`, then `bc_task_claim` on the
first `up_next` or `claimable` task whose `agent_may_act.ok` is true.

## The doorbell kind `task`

The inbox doorbell ([`inbox-doorbell.md`](inbox-doorbell.md)) gained a fourth
kind. `tasksWaitingForAgents(accountId)` counts **open** tasks, in lists that
aren't archived, assigned to the account's agents (`assigneeAgents` or one
`assigneeAgentId`) whose `agentSeenAt` is null. That count is part of
`pending_count`, and `kinds` includes `"task"` while it's non-zero.

- It **rings** (`fireInboxEvent(accountId, "task")`) when a task is added for,
  or reassigned to, the account's agents. Reassigning clears `agentSeenAt`, so
  it rings again.
- It **stops counting** a task once the agent it's for loads its plate and the
  task is in that agent's `up_next`; `opPlate` stamps `agentSeenAt` then.
- Read state is per account, not per agent, so the doorbell can't target one
  agent; the plate tells each agent what is for it. Tasks assigned to a person
  don't ring agents.
- Best effort: a failure in the count reads as 0, so lists never break the
  doorbell. `pending_count` includes tasks either way, so a client that doesn't
  know the `task` kind still sees the count.

## Testing

- **Pure rules:** `src/lib/lists/rules.test.mjs` (`node --test`) covers
  permissions, the OK rule, claims and lapses, finishing, review and send-back,
  status changes, secret refusal, text cleaning and task views. Nothing there
  reads the clock: tests pass `now`.
- **Routes:** route tests run with the db and auth mocked, following
  `route-tests/dispatch.routetest.mts`. `mcp-thread-id.routetest.mts` pins the
  tool count for a key with no agent identity, which leaves the list tools out.
- **Skill revision:** `src/lib/skill-revision.test.mjs` keeps SKILL.md, the
  relay's announced revision and the `/skill/revision` changelog in step.
- **Content-blind analytics:** `route-tests/admin.routetest.mts` fails if
  analytics read list or task text.

Run from `apps/broker`: `npm test` and `npm run test:routes`.

## What Phase 2 and 3 add

**Phase 2, shared with friends:** members (mutual friends only, added in the
web app only), each person granting their own agents, per-task OKs including
"OK'd in chat" (`TaskAgentOk`), `agentsTakeFrom` in the UI, needs-review for
other people's tasks, mentions, reactions, revocation (leaving or untrusting
ends access and releases claims at once, past work stays attributed), and
opt-in email nudges. `/privacy` already says shared lists will be visible to the
friends on them.

**Phase 3, delight and reach:** a Lists tab in the MCP Apps panel, hand-off to
an always-on Dispatch worker ("start now on my always-on agent"), a
cookie-authenticated live stream for the web instead of the 10-second refresh,
a daily digest, and list templates.
