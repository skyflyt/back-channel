# Back Channel — Scope Definitions

> Fine-grained permissions that the host grants to a visitor for a specific session.

## Design rules

- Scopes are **declarative** (a list of names), not procedural.
- Scopes are **additive** — granting `config.write` does NOT imply `config.read`. Each is independent.
- The default is **deny**: capabilities are hidden unless their required scope is granted.
- Some scopes are **dangerous combinations** — UI flags them but doesn't prevent (host can override).
- Some scopes are **out of v1 entirely** — listed for transparency.

## v1 scopes

### Read-only

| Scope | Description | Default | Risk |
|---|---|---|---|
| `config.read` | Read configuration files / settings. Secrets auto-redacted. | OFF | Low — redaction enforced |
| `logs.read` | Read recent log lines from the host system. Sanitized. | OFF | Low — sanitized |
| `automation.read` | List automations and their structure. | OFF | Low |
| `memory.metadata` | See metadata about memory items (count, kinds, dates). NOT contents. | OFF | Very low |

### Suggest / mutate (gated by human approval)

| Scope | Description | Default | Risk |
|---|---|---|---|
| `config.suggest` | Propose changes to config. Host approves before apply. | OFF | Medium — gated |
| `automation.suggest` | Propose new automations or edits. Host approves. | OFF | Medium — gated |
| `tool.execute` | Run a specific scoped tool. Each call requires approval. | OFF | High — case by case |

### Auto-apply (skip approval)

| Scope | Description | Default | Risk |
|---|---|---|---|
| `config.apply` | Apply config changes WITHOUT per-change approval. | OFF | HIGH — only for trusted visitors |
| `automation.apply` | Apply automation changes WITHOUT approval. | OFF | HIGH |

> **WARNING**: `*.apply` scopes are dangerous and the UI shows a red bar. Only grant to visitors you'd hand your laptop password to.

## Out of v1 entirely

These scopes are NOT available even if the host wants them. They represent data classes too sensitive for this iteration.

| Scope | Why it's blocked |
|---|---|
| `memory.read` | Memory contents often include private interpersonal facts, family info, sensitive context |
| `email.read` | Email is highly personal; redaction is hard |
| `messages.read` | Same — text messages, Slack DMs, etc. |
| `contacts.read` | Identifiable third-party data |
| `calendar.read` | Meeting titles often contain confidential info |
| `files.read` | Could include anything; too broad |

These may be revisited in a later version with stronger redaction layers and additional confirmation gates.

## Scope combinations the UI flags

The host-side UI shows warnings for these combinations:

| Combination | Why it's flagged |
|---|---|
| `*.read` + `*.apply` | The visitor can both read state AND change it without approval. Very high trust. |
| Any `*.apply` + duration > 15 min | Long sessions with auto-apply increase blast radius. |
| `tool.execute` without specifying allowed tools | Defaults to NO tools — host must explicitly list which. |

## Capability mapping examples

```
Scope: config.read
  Enables capabilities:
    - config.list-files
    - config.read-file (with redaction)
    - config.diff-against-baseline

Scope: automation.suggest
  Enables capabilities:
    - automation.list (already needs automation.read)
    - automation.propose-new
    - automation.propose-edit

Scope: tool.execute (with allowed_tools: ["restart_service"])
  Enables capabilities:
    - tool.list-allowed   -> returns ["restart_service"]
    - tool.invoke         -> only with name="restart_service"
```

## How a host picks scopes

Two flows:

### Quick presets

- **Diagnostic** = `config.read` + `logs.read` + `automation.read` + `memory.metadata`
- **Suggest fixes** = above + `config.suggest` + `automation.suggest`
- **Full collaborator** = above + `config.apply` + `automation.apply` (with red warning)

### Custom

Host can check individual boxes. UI surfaces warnings for risky combos.

## Scope enforcement

The host agent's scope-enforcement layer:

1. Receives the visitor's request
2. Checks the action against the scope-to-capability map
3. If not allowed: return `403 scope_denied` (visitor sees this, can ask host for more)
4. If allowed and read-only: execute, return result
5. If allowed and mutating with `*.suggest`: form proposal, present to human, wait for approval, then execute
6. If allowed and mutating with `*.apply`: execute, log to audit

Approval prompts time out after 2 minutes (configurable). Timeout = reject.
