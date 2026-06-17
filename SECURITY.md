# Security Policy

Back Channel is, by design, a tool that connects two AI agents that each represent a real human. Privacy and security are core constraints, not afterthoughts.

## Core security principles

1. **No secrets in this repo. Ever.**
   - No API keys, passwords, tokens, or credentials of any kind.
   - All configuration uses environment variables or external secret stores.
   - PRs containing secrets will be rejected and rewritten (and the secret rotated).

2. **Least-privilege scopes.**
   - Visitor agents only see what the host explicitly grants.
   - The default scope set is read-only and metadata-only.
   - Memory contents are off-limits in v1 regardless of host preference.

3. **Human-gated writes.**
   - Any mutation to the host system requires explicit human approval at the host side.
   - "Approval" is not just a click — the human sees exactly what's about to change.

4. **End-to-end conversation encryption.**
   - The Broker mediates connections but does NOT see message content.
   - Broker stores: session metadata, scope grants, timestamps, kick events.
   - Broker does NOT store: raw conversation, agent prompts, returned data.

5. **Short-lived tokens.**
   - Session tokens default to 15 minutes, max 30.
   - No refresh tokens. Expired = re-invite.

6. **Kill switch.**
   - Either party can terminate the session instantly via the Broker.
   - Termination revokes the active token immediately.

## Threat model

### In scope (we defend against these)

| Threat | Mitigation |
|---|---|
| Visitor agent goes rogue, tries to read host memory | Scope enforcement at host side; memory never exposed in v1 |
| Visitor agent applies a malicious config change | Writes are human-gated; transcript visible |
| Broker compromise leaks conversation content | E2E encryption between agents; broker has no plaintext |
| Stolen session token used by attacker | Short TTL, asymmetric signing, single-use nonce in each request |
| Host human pressured into granting too much | UI warns on high-risk scope combinations; clear cancel button |
| Visitor agent's host is compromised; uses session to attack target | Behavior anomaly detection: per-session action ceiling; auto-kick on threshold |

### Out of scope (v1 doesn't try to solve)

- Defending against a malicious *host* — the host has root over their own system by definition. A bad host can lie to their visitor.
- Defending against a malicious *Broker operator* — the Broker can't see content, but can deny service. Federation is on the roadmap.
- Side-channel attacks on the host machine.
- Compromised agent runtime (e.g., the LLM API provider itself is malicious).

## Disclosing a vulnerability

If you find a security issue, please **do not file a public issue**. Instead:

- Email the maintainer (contact info on GitHub profile).
- Include: description, reproduction steps, impact assessment.
- Expect a response within 72 hours.
- We'll coordinate a fix and disclosure timeline.

Hall of fame: any security researcher who reports a real issue will be credited in `SECURITY-HALL-OF-FAME.md` (with their permission).

## Pre-MVP testing checklist

Before any version is labeled "MVP ready":

- [ ] Threat model walkthrough with at least one external reviewer
- [ ] Static analysis pass on broker code
- [ ] Pen test focused on token forgery and scope escalation
- [ ] Persona stripping tested against a real-world memory file (catch leaks of names, addresses, tokens)
- [ ] All dependencies audited (`npm audit` clean)
- [ ] Secrets scan on git history (gitleaks)

Until those check, the project remains in alpha / "not for production use" status.
