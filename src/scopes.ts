/**
 * Back Channel — Scope definitions.
 *
 * Scopes are declarative permission strings granted by the host at invite time.
 * Capabilities map 1:1 to a required scope; if the visitor doesn't have it, the
 * capability is hidden from discovery entirely.
 *
 * See docs/scopes.md for the design rationale.
 */

export const READ_ONLY_SCOPES = [
  "config.read",
  "logs.read",
  "automation.read",
  "memory.metadata",
] as const;

export const SUGGEST_SCOPES = [
  "config.suggest",
  "automation.suggest",
  "tool.execute",
] as const;

export const APPLY_SCOPES = [
  "config.apply",
  "automation.apply",
] as const;

/** All scopes available in v1. Order matters for UI display. */
export const ALL_SCOPES = [
  ...READ_ONLY_SCOPES,
  ...SUGGEST_SCOPES,
  ...APPLY_SCOPES,
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

/**
 * Scopes that are HARD-BLOCKED in v1 regardless of host preference.
 * These represent data classes too sensitive for the current redaction layer.
 */
export const BLOCKED_SCOPES = [
  "memory.read",
  "email.read",
  "messages.read",
  "contacts.read",
  "calendar.read",
  "files.read",
] as const;

export type BlockedScope = (typeof BLOCKED_SCOPES)[number];

/** Type guard — is the given string a v1 scope? */
export function isScope(s: string): s is Scope {
  return (ALL_SCOPES as readonly string[]).includes(s);
}

/** Type guard — is the given string a hard-blocked scope? */
export function isBlockedScope(s: string): s is BlockedScope {
  return (BLOCKED_SCOPES as readonly string[]).includes(s);
}

/** Validate a list of scopes. Throws if any are blocked or unknown. */
export function validateScopes(scopes: ReadonlyArray<string>): asserts scopes is ReadonlyArray<Scope> {
  for (const s of scopes) {
    if (isBlockedScope(s)) {
      throw new Error(`Scope "${s}" is hard-blocked in v1. See docs/scopes.md.`);
    }
    if (!isScope(s)) {
      throw new Error(`Unknown scope: "${s}"`);
    }
  }
}

/** Preset bundles for the host UI's "quick presets" feature. */
export const SCOPE_PRESETS = {
  diagnostic: [
    "config.read",
    "logs.read",
    "automation.read",
    "memory.metadata",
  ] as Scope[],
  suggest_fixes: [
    "config.read",
    "logs.read",
    "automation.read",
    "memory.metadata",
    "config.suggest",
    "automation.suggest",
  ] as Scope[],
  full_collaborator: [
    "config.read",
    "logs.read",
    "automation.read",
    "memory.metadata",
    "config.suggest",
    "automation.suggest",
    "config.apply",
    "automation.apply",
  ] as Scope[],
} as const;

/** Returns true if any of the given scopes is in the "apply" tier (high-trust). */
export function hasApplyScope(scopes: ReadonlyArray<Scope>): boolean {
  return scopes.some((s) => (APPLY_SCOPES as readonly string[]).includes(s));
}
