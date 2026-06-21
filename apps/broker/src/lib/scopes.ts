/**
 * Back Channel Broker — Scope validation at the API boundary.
 *
 * We re-implement the validation here (not importing from ../src/scopes.ts
 * which is the library) so the broker can ship as a standalone container
 * without the library as a workspace dep. The lists must stay in sync.
 *
 * TODO Phase 3.1: extract scope lists to a shared package consumed by both.
 */

export const ALL_SCOPES = [
  "config.read",
  "logs.read",
  "automation.read",
  "memory.metadata",
  "config.suggest",
  "automation.suggest",
  "tool.execute",
  "config.apply",
  "automation.apply",
] as const;

export const BLOCKED_SCOPES = [
  "memory.read",
  "email.read",
  "messages.read",
  "contacts.read",
  "calendar.read",
  "files.read",
] as const;

// Human-readable catalog for GET /api/scopes + the skill scope table (M2).
// Keep the strings EXACTLY as agents must send them.
export const SCOPE_CATALOG: { scope: string; grants: string; writes: boolean }[] = [
  { scope: "config.read", grants: "Read (sanitized) configuration", writes: false },
  { scope: "logs.read", grants: "Read recent (sanitized) log lines", writes: false },
  { scope: "automation.read", grants: "List automations / scheduled tasks", writes: false },
  { scope: "memory.metadata", grants: "See that memory exists + counts — NOT contents", writes: false },
  { scope: "config.suggest", grants: "Propose config changes (host approves each)", writes: true },
  { scope: "automation.suggest", grants: "Propose automation edits (host approves each)", writes: true },
  { scope: "tool.execute", grants: "Run a scoped tool (explicit trust)", writes: true },
  { scope: "config.apply", grants: "Apply config changes directly (auto-apply — explicit trust)", writes: true },
  { scope: "automation.apply", grants: "Apply automation edits directly (auto-apply — explicit trust)", writes: true },
];

export function validateScopes(scopes: string[]): { ok: true } | { ok: false; error: string } {
  for (const s of scopes) {
    if ((BLOCKED_SCOPES as readonly string[]).includes(s)) {
      return { ok: false, error: `Scope "${s}" is hard-blocked` };
    }
    if (!(ALL_SCOPES as readonly string[]).includes(s)) {
      return { ok: false, error: `Unknown scope: "${s}"` };
    }
  }
  return { ok: true };
}
