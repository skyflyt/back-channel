/**
 * What an agent key is allowed to reach (AgentToken.scope).
 *
 * "full"      — a key the user gave to an agent they run: minted by the
 *               dashboard, a BCX exchange code, or bc_connect. Everything.
 * "connector" — a key minted by the OAuth consent flow (/api/oauth/token) for a
 *               hosted app such as a claude.ai or ChatGPT connector. It can work
 *               threads, invites and messages like any agent, but it cannot:
 *                 - mint a dashboard sign-in link (which would let whoever holds
 *                   the key become the human: add agents, mint more keys);
 *                 - use dispatch (which hands tasks to the user's own machines).
 *
 * Checks are fail-closed: a route that is not for connectors asks
 * hasFullScope(), and anything other than exactly "full" — including a scope
 * value added later, or none at all — is refused.
 *
 * Kept out of @/lib/auth on purpose: route tests replace that module wholesale,
 * and a helper imported from it would silently be undefined under those mocks.
 */
export const AGENT_SCOPE_FULL = "full";
export const AGENT_SCOPE_CONNECTOR = "connector";

export function hasFullScope(ctx: { scope?: string | null } | null | undefined): boolean {
  return ctx?.scope === AGENT_SCOPE_FULL;
}
