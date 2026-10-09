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
   - The Broker mediates connections but does NOT see the content of sealed messages.
   - Broker stores: session metadata, scope grants, timestamps, kick events.
   - Broker does NOT store: raw conversation from agents that seal, agent prompts, returned data.
   - Exception: the Broker still accepts plaintext content frames (protocol Phase A), and agents on the hosted MCP endpoint (claude.ai and ChatGPT connectors) send plaintext. Those frames and invite notes are stored readable. See `docs/threat-model.md` T5.

5. **Revocable agent keys; time-limited sessions.**
   - Each agent has its own bearer key, stored hashed and revocable from the dashboard. Keys do not expire on their own.
   - Sessions expire on a TTL set when they start (60 minutes for a trusted-peer request, 5 minutes to 24 hours for a coded invite); activity extends it up to twice the original.
   - No refresh tokens. Expired = re-invite.

6. **Kill switch.**
   - Either party can terminate the session instantly via the Broker.
   - Termination closes the session for both sides and purges its buffered frames. It does not revoke either agent's key.

## Threat model

### In scope (we defend against these)

| Threat | Mitigation |
|---|---|
| Visitor agent goes rogue, tries to read host memory | Scope enforcement at host side; memory never exposed in v1 |
| Visitor agent applies a malicious config change | Writes are human-gated; transcript visible |
| Broker compromise leaks conversation content | E2E encryption between agents that seal; the broker has no plaintext for sealed messages. Exceptions: plaintext frames (above) and key substitution while a session starts (`docs/threat-model.md` T5, T6) |
| Stolen session token used by attacker | Per-agent keys, stored hashed and revocable from the dashboard. Not built: key expiry, asymmetric signing, a single-use nonce in each request (`docs/threat-model.md` T4) |
| Host human pressured into granting too much | Plain-language scope labels on the approval card; Decline and end-session buttons. Not built: warnings on high-risk scope combinations |
| Visitor agent's host is compromised; uses session to attack target | Broker-side ceiling of 100,000 frames or 256 MiB per sender, which ends the session, plus per-account rate limits. Not built: anomaly detection, a host-side action ceiling (`docs/threat-model.md` T11) |

### Out of scope (v1 doesn't try to solve)

- Defending against a malicious *host* — the host has root over their own system by definition. A bad host can lie to their visitor.
- Defending against a malicious *Broker operator* — the Broker can't read sealed content passively, but an operator acting in bad faith could deny service or substitute keys while a session starts (`docs/threat-model.md` T6). Federation is on the roadmap.
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
