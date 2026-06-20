# Epic: Fast Channel — a faster agent-to-agent protocol (design, deep-future)

**Status:** design only. **Do not build.** A deep-future exploration to revisit once the active build pipeline (Account Dashboard → Skill Sharing) is well along and the base protocol has stabilized under real fresh-on-fresh load. Everything here layers *on top of* today's protocol and must degrade gracefully to it.

---

## 0. The problem

Today two agents converse in **English-ish JSON frames** (`meta.dialog`, `invoke.request`, `invoke.response`) sealed as `{type:"enc",…}` AES-256-GCM envelopes, relayed over HTTP poll or WebSocket. That's flexible and human-auditable, but for **turn-based pairs** — the realistic non-developer case we keep hitting — it's slow and chatty:

- **Each logical step is a round trip.** "Ask a question → wait a turn → get the answer → wait a turn → act" can be 4+ poll cycles (tens of seconds each when an agent only wakes per user turn). The survivability batch (TTL auto-extend, `peer_status`, wake-prompt) keeps the session *alive* across those gaps; it doesn't *remove* the gaps.
- **Prose is big and ambiguous.** Free-text `args` are larger on the wire than they need to be and force the receiver to re-parse intent every frame.

Skylar's framing: *"a better/faster/more efficient way for agents to talk than English… predicting possible questions/turns and pre-sending responses so the other agent doesn't need to wait a whole cycle — like a choose-your-own-adventure but fancy AI stuff."*

This epic catalogs seven technique families to attack three latency sources — **wire size**, **round-trip count**, and **turn-wait** — without giving up the two non-negotiables.

## 1. Design goals & invariants

1. **Smaller / less ambiguous wire** than free-form English `args`.
2. **Fewer round trips** via speculative pre-sending of likely next turns.
3. **Lower turn-wait latency** specifically for turn-based agents.
4. **Invariant — same e2e crypto + privacy.** Everything still rides inside the sealed `{type:"enc",…}` envelope; the broker stays **content-blind** (routes on `type` only). No technique may require the broker to read payloads.
5. **Invariant — human auditability.** The `/sessions/:id` transcript must stay meaningful to a watching human, OR a technique must define an explicit, accepted **degradation mode** (and surface that it's degraded).

A cross-cutting rule: **every technique is opt-in and capability-negotiated at session start, with graceful fallback to today's text protocol.** An agent that doesn't advertise support never receives the new frame shapes.

---

## 2. Capability negotiation (the substrate every technique needs)

Before any of the below, the two agents must agree on what they both speak. Proposed: a new plaintext-control frame exchanged right after the handshake:

```jsonc
{ "type": "caps.hello", "fast_channel": {
    "version": 1,
    "features": ["schema-frames", "reaction-codes", "pipelined", "branching", "plans@1"],
    "schemas": { /* see §3.1 */ }
} }
```
- Each side sends its `caps.hello`; the **intersection** of `features` is the active feature set for the session. Empty intersection ⇒ pure text protocol (today).
- `caps.hello` is plaintext-control (broker routes it) but carries **no content** — just feature flags + schema *shapes* (which are not user data). If even schema shapes are deemed sensitive, move them into a sealed `caps.hello.enc`.
- Versioned (`version`, `plans@1`) so the protocol can evolve without breaking older agents.

Everything below assumes this negotiation gate.

---

## 3. Technique families

### 3.1 Schema-typed frames  ★ (low risk, high value)

**Idea.** Replace free-form `args` prose with **negotiated typed schemas**. At session start each side declares the parameter schema for each capability; subsequent `invoke.request`/`response` frames carry **field values only**, positionally or by short key.

**Wire shape.** Negotiation (in `caps.hello.schemas`):
```jsonc
"schemas": { "config.suggest": { "id": "cfg.suggest@1",
  "fields": ["path", "find", "replace"] } }
```
A call then becomes (sealed):
```jsonc
{ "type": "enc", ... }  // decrypts to:
{ "t": "inv", "s": "cfg.suggest@1", "v": ["automations.yaml", "from:", "from: alerts@"] }
```
vs today's verbose `{type:"invoke.request", capability:"config.suggest", args:{path:…, find:…, replace:…}}` plus a prose `summary`.

**Interop / fallback.** If a capability's schema isn't mutually negotiated, fall back to today's `invoke.request` with `args`. Mixed sessions are fine — schema frames only for schema'd capabilities.

**Privacy.** Unchanged — values are sealed; broker sees `enc`. Schema *shapes* in negotiation reveal field *names* (e.g. "path/find/replace"), not values; move to `caps.hello.enc` if even names matter.

**Auditability.** Mild degradation: the transcript shows a sealed `enc` frame (as today) — the *watching human* never saw plaintext anyway. The **agent-side** activity log (which holds the key) can still render "proposed edit to automations.yaml" from the typed fields — arguably *better* than parsing prose. Recommend the agent-side log map known schemas → friendly lines.

**Complexity.** Days–low weeks. Mostly a schema registry + a field-codec; reuses the Skill-Sharing `paramSchema` concept (`docs/skill-sharing-epic.md`).

**Win / not.** Win for any repeated, structured capability call (config edits, file ops, scaffolds). Not worth it for genuinely free-form dialogue.

**Malicious use.** Low. A lying schema just produces garbage the receiver validates + rejects. Validate values against declared types; reject on mismatch.

---

### 3.2 Speculative branching  ★★ (medium risk, high value — Skylar's "choose-your-own-adventure")

**Idea.** The sender ships **one frame containing a primary action plus N alternative actions**, each gated on a **peer-side condition** the sender can't evaluate. The receiver evaluates locally and runs exactly one branch — no extra round trip.

**Wire shape** (sealed):
```jsonc
{ "t": "branch", "id": "b1", "select": "first-match", "branches": [
    { "when": { "file_exists": "automations.yaml" }, "do": { "t": "inv", "s": "cfg.read@1", "v": ["automations.yaml"] } },
    { "when": { "file_exists": "config.yml" },        "do": { "t": "inv", "s": "cfg.read@1", "v": ["config.yml"] } },
    { "when": "else", "do": { "t": "ask", "s": "where-is-config@1" } }
] }
```
- `when` predicates come from a **small, sandboxed, side-effect-free predicate language** (file_exists, value comparisons, capability availability) — NOT arbitrary code.
- Receiver evaluates predicates against its own state, runs the first match, and returns `{ "t": "branch.took", "id": "b1", "branch": 0, "result": {…} }`.

**Interop / fallback.** Gated on `branching` capability. If unsupported, sender must fall back to sending just the primary action and waiting.

**Privacy.** Broker-blind preserved — the whole branch set is inside one `enc` envelope. **But note the asymmetry:** the sender learns which branch ran only from `branch.took`. That's fine functionally; see auditability + covert-channel risk.

**Auditability.** This is the thorny one. The transcript sees one big `enc` frame in, one `enc` frame out — it can't show *which* branch ran (broker is blind). Degradation mode: the **agent that holds the key** must log the taken branch to its activity log + ideally emit a tiny plaintext-control breadcrumb like `{type:"branch.took",id:"b1",branch:0}` (no payload) so the transcript shows *"took branch 0 of proposal b1"* — structural, not content. **Policy decision needed (open question).**

**Complexity.** Weeks. Needs the predicate language, a safe evaluator, and branch-selection semantics (`first-match` / `all-eligible` / `best-score`).

**Win / not.** Big win when the next turn is *predictable but conditional on peer state* ("depends on which config file you have"). Not worth it when branches are low-confidence (wire cost of N branches wasted).

**Malicious use.** Real concern: a branch set is a **covert channel / decision-tree the sender can't see resolve**. A malicious sender could encode probing logic ("if file X exists, do something observable") to infer peer state without asking. Mitigations: cap branch count + predicate complexity; the **receiver's human approval still gates the whole branch set up front** (one-yes-per-session covers the *goal*, but a branch set that probes beyond scope must be rejected); log taken branch for post-hoc review.

---

### 3.3 Pipelined sends  ★ (low-medium risk, medium value)

**Idea.** After the first frame, the sender **immediately pipelines N likely follow-up frames** (sequence numbers reserved), betting on the most probable continuation. The receiver processes the first, and **discards the pipelined frames that no longer apply** once the first response disambiguates.

**Wire shape.** Ordinary sealed frames with a `pipeline` hint:
```jsonc
{ "t":"inv", "s":"cfg.read@1", "v":["automations.yaml"], "pipe": { "group":"g1", "idx":0, "of":3, "speculative": true } }
```
Frames `idx:1,2` are `speculative:true` follow-ups (e.g., the likely fix + the verify). Receiver runs `idx:0`, and only honors `idx:1+` if its precondition (encoded like a branch `when`) still holds; else drops them and tells the sender `{ "t":"pipe.dropped","group":"g1","kept":[0] }`.

**Interop / fallback.** Gated on `pipelined`. Unsupported peer ignores `pipe` and just sees normal frames in order (they'd execute all — so DON'T send speculative pipelines to a non-supporting peer; fall back to one-at-a-time).

**Privacy.** Unchanged (sealed). Higher wire volume (you send work that may be discarded).

**Auditability.** Transcript shows several `enc` frames; agent-side log notes which were kept/dropped. Mild degradation, similar to branching but less opaque (each pipelined frame is a normal action).

**Complexity.** Low-medium weeks. Mostly sender-side prediction + receiver-side drop logic + the `pipe.dropped` ack.

**Win / not.** Win when prediction confidence is high and bandwidth is cheap relative to latency (turn-based agents — exactly our case). Not worth it on metered/slow links or low-confidence predictions (wasted sends).

**Malicious use.** Low-moderate: a flood of speculative frames is a bandwidth-amplification vector. Reuse existing per-session frame caps + rate limits; count speculative frames against the budget.

---

### 3.4 Compiled action plans  ★★ (medium complexity, high value for known recipes)

**Idea.** Express a **whole recurring workflow** ("scaffold a second-brain vault," "review a config file and propose fixes") as a **tiny DSL program** in one frame. The receiver interprets it locally — one frame replaces an entire conversation tree.

**Wire shape** (sealed): a versioned plan reference + params, or an inline plan:
```jsonc
{ "t":"plan", "ref":"scaffold.vault@2", "params": { "role":"finance", "root":"Documents/MyBrain" } }
```
The plan `scaffold.vault@2` is a named, **signed** recipe both sides obtained out-of-band (or via Skill-Sharing). Inline plans (a small AST of typed steps with branch/loop) are also possible for one-offs.

**Interop / fallback.** Gated on `plans@<v>` + the specific plan ref being known to the receiver. Unknown plan ⇒ `{t:"plan.unknown",ref:…}` ⇒ sender falls back to driving the steps as individual frames.

**Privacy.** Sealed; broker-blind. If the plan ref leaks intent via its name, that's only visible to the peer, not the broker.

**Auditability.** Strong, actually — the transcript can show `[plan: scaffold.vault@2]` (a *named, known* operation) which is *more* meaningful to a human than 30 opaque frames. The receiver's human still approves the plan once (one-yes-per-session), seeing a rendered summary of what `scaffold.vault@2` does.

**Complexity.** Weeks–months: needs a DSL spec, a safe interpreter (no arbitrary code; typed steps only), a plan registry + signing, and versioning. Heavily overlaps Skill-Sharing Tier 2 (`docs/skill-sharing-epic.md`) — a "compiled action plan" is essentially a shared capability invoked in one shot. **Build them together.**

**Win / not.** Win for well-known, high-frequency recipes. Not worth it for novel/bespoke tasks (the DSL can't express everything; trades generality for speed).

**Malicious use.** Same as Skill-Sharing templates: a plan is executable intent → prompt-injection / over-reach vector. Require **signed** plans, validate steps against scope, and keep the one-yes human approval. Inline plans need the same sandbox as branch predicates.

---

### 3.5 Reaction codes  ★ (lowest risk, easy win)

**Idea.** Replace the most common full-sentence responses with **tiny enumerated codes**: `OK`, `REJECT`, `RETRY`, `MORE_INFO`, `BUSY`, `DONE`. These dominate real sessions ("yes I approve", "that didn't work, try again").

**Wire shape** (sealed, tiny):
```jsonc
{ "t":"rc", "re":"b1", "code":"OK" }          // optional: "code":"MORE_INFO","need":["timezone"]
```
`re` references the frame being reacted to.

**Interop / fallback.** Gated on `reaction-codes`; trivially fall back to a `meta.dialog` "yes"/"no". A receiver can always *upgrade* its understanding of a text "yes" but senders only emit `rc` when negotiated.

**Privacy.** Sealed. (Even though codes are a tiny enum, keep them inside `enc` so the broker can't infer approve/reject rates — that metadata could itself be sensitive.)

**Auditability.** Good. Agent-side log renders `OK → "approved"`. Transcript shows a small `enc` frame; if we want the human to see "approved" on the transcript, emit a parallel plaintext-control breadcrumb — but that leaks approve/reject to the broker (tradeoff; default keep it sealed).

**Complexity.** Days. A small enum + codec. Pairs naturally with schema-typed frames.

**Win / not.** Win everywhere these high-frequency responses occur. Negligible downside. The clearest "just do it" candidate alongside §3.1.

**Malicious use.** Negligible.

---

### 3.6 Embeddings as messages  ✗ (cover for completeness; do not recommend)

**Idea.** Skip language entirely — send **vector embeddings**; the receiver decodes meaning via its own model.

**Wire shape.** A sealed blob of floats (`{t:"emb","dim":1024,"q":"<base64 quantized vector>"}`).

**Interop / fallback.** Poor. Requires both agents to share a **compatible embedding space** — which they generally don't (different models/versions). No clean fallback; effectively a private side-protocol for identical twins.

**Privacy.** Sealed, so broker-blind — *but* embeddings can leak more than intended (they're lossy-but-rich; inversion attacks can partially reconstruct content). For a privacy-first product this is a step backwards even inside encryption.

**Auditability.** Effectively zero — a human (and even the broker operator) sees an opaque vector; the agent-side log can only show a model-decoded *guess*. Fails the auditability invariant unless paired with a plaintext gloss (which defeats the wire savings).

**Complexity.** High + brittle: model drift silently corrupts meaning; no versioning story that survives model upgrades.

**Win / not.** Almost never for this product. **Recommendation: skip** unless a specific, measured demand appears (e.g. two instances of a *pinned identical* model exchanging high-volume structured state).

**Malicious use.** High and hard to police: an opaque vector channel is an ideal covert channel and is essentially un-auditable.

---

### 3.7 Predictive prefetch  ★ (no wire change, pure runtime win — safe)

**Idea.** After receiving a frame, the receiver **predicts likely next requests and pre-fetches local context** (reads the file the sender will probably ask about, warms a cache) **without acting**. When the predicted request arrives, the response is immediate.

**Wire shape.** None — this is a **receiver-side runtime optimization**. No protocol change at all.

**Interop / fallback.** Perfect — invisible to the peer and the broker. Always safe to do unilaterally.

**Privacy.** Unchanged. (Caveat: prefetch reads must still respect the granted scope — don't prefetch out-of-scope data "just in case.")

**Auditability.** Unchanged (no new frames). The agent-side log may note "pre-read automations.yaml in anticipation."

**Complexity.** Low, but **per-runtime** — depends on each agent's ability to do background work, which is exactly what turn-based runtimes struggle with (this helps most where it's hardest to do). Best paired with the keep-warm job.

**Win / not.** Free latency win when prediction is good and prefetch is in-scope + cheap. Wasted work when prediction is poor. No downside to the protocol.

**Malicious use.** Self-inflicted only (wasted local work). The scope guard prevents over-reading.

---

## 4. How they compose

- **Schema frames + reaction codes** are the shared substrate — adopt first; everything else rides on typed frames.
- **Pipelined sends** and **speculative branching** both attack turn-wait; branching is "receiver picks one of N I sent," pipelining is "I send N in order, you drop the misses." Branching is better when the choice depends on *peer state the sender can't see*; pipelining when the sender has *high-confidence ordering*.
- **Compiled action plans** subsume many multi-turn exchanges entirely and **share machinery with Skill-Sharing** — build the DSL/interpreter once.
- **Predictive prefetch** is orthogonal and free; turn it on whenever the runtime allows.

---

## 5. Recommendation — phased adoption

**Phase A — Structured wire (low risk, high value, do first):**
1. **Capability negotiation** (`caps.hello`) — the gate everything needs.
2. **Schema-typed frames** (§3.1).
3. **Reaction codes** (§3.5).
4. **Predictive prefetch** (§3.7) — no protocol change; ship as a skill/runtime guidance note in parallel.

→ Expect meaningful wire-size + parse-clarity wins with negligible risk and easy fallback. This is the "just do it" tranche.

**Phase B — Speculative latency cuts (once the protocol is stable + measured):**
5. **Pipelined sends** (§3.3).
6. **Speculative branching** (§3.2) — only after the auditability/covert-channel policy (open questions) is decided.

**Phase C — Recipes (build with Skill-Sharing):**
7. **Compiled action plans** (§3.4) — co-developed with Skill-Sharing Tier 2 (shared capabilities ≈ named plans). Signed, scope-validated, one-yes-approved.

**Skip:** **Embeddings-as-messages** (§3.6) unless a specific, measured demand appears.

Sequencing rationale: Phase A is pure upside and de-risks the wire; Phase B trades bandwidth + complexity for latency and needs the audit policy nailed down; Phase C is the biggest lift and is naturally a sibling of work already on the roadmap.

---

## 6. Open questions (decide before any build)

1. **Versioning & upgrade.** How do `fast_channel.version` and per-feature versions (`plans@2`) evolve without breaking older agents mid-session? Hard-pin per session at `caps.hello`, or allow mid-session re-negotiation?
2. **Negotiation trust.** `caps.hello` advertises features/schemas — is it plaintext-control (broker sees feature flags + schema field-names) or sealed? What's the privacy cost of the broker knowing two agents speak "branching"?
3. **Fallback semantics.** Exact rules when capabilities only partially overlap, or when a peer advertises a feature but sends a malformed typed frame — fall back to text for *that frame*, the *capability*, or the *session*? Define precisely to avoid silent drops.
4. **Transcript degradation policy.** Branching + reaction codes can make the human transcript less meaningful. Do we emit content-free *structural breadcrumbs* (`branch.took`, `rc`) as plaintext-control so the human sees "took branch 0 / approved" — accepting that the broker then learns that metadata? Or keep everything sealed and rely solely on the agent-side activity log? **This is the central product/privacy tradeoff of the epic.**
5. **Malicious-use vectors.** Speculative branches + embeddings are potential covert channels / peer-state probes. What caps (branch count, predicate complexity, speculative-frame budget), validation, and post-hoc logging do we require? Does one-yes-per-session adequately gate a branch set, or do branch sets need their own approval surface?
6. **Performance measurement.** How do we *prove* a win? Define metrics before building — round-trips per task, wall-clock to completion for turn-based pairs, wire bytes per session, % speculative frames wasted — and instrument the broker (frame counts/sizes are already content-blind metadata) so each technique can be A/B'd against the text baseline.
7. **Predicate/DSL safety.** The branch predicate language and the action-plan DSL must be side-effect-free + sandboxed. What exact operations are allowed, and who audits a plan/predicate before a non-technical user approves it?
8. **Interaction with one-yes-per-session.** Speculative branches and compiled plans pre-encode multiple actions. Does the host's single approval still cleanly cover "any branch within scope," and how is a branch/plan that would exceed scope detected *before* it runs?

---

## 7. Relationship to existing work
- **Layers on** the current handshake + sealed `enc` frame model (SKILL.md *Encryption*); the broker stays content-blind throughout — no technique asks it to read payloads.
- **Shares machinery with Skill-Sharing** (`docs/skill-sharing-epic.md`): schema-typed frames ≈ `paramSchema`; compiled action plans ≈ signed shared capabilities. Build the schema/DSL/signing layer once.
- **Complements survivability** (shipped): TTL auto-extend + `peer_status` + wake-prompt keep turn-based sessions *alive* across gaps; Fast Channel *reduces the number and length of those gaps*.
- **Auditability tension** is with the `/sessions/:id` transcript (broker content-blind by design) — open question 4 is where this epic must make an explicit call.
