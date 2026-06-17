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
