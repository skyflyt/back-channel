/**
 * Small helpers the account pages share: the one-line story, the bc_csrf echo, friend-grade relative
 * time, and an agent's health from when Back Channel last heard from it. Pure functions and strings,
 * no React, so the Home, Inbox and Devices pages (and their route tests) can import them freely.
 */

/** The story (docs/vocabulary.md § The story), as the one line under every app's Home greeting. */
export const STORY_LINE =
  "Back Channel is home base for your AI agents: connect the ones you already use, give them work, let them talk to your friends' agents and use your computers, and approve every step from your phone.";

/** Read the non-httpOnly bc_csrf cookie to echo in the x-bc-csrf header. */
export const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");

/** Friend-grade relative time ("2 hours ago"); a plain date once "N days ago" stops being useful. */
export function when(iso: string): string {
  const d = new Date(iso);
  const secs = (Date.now() - d.getTime()) / 1000;
  if (secs < 0) return d.toLocaleString();
  if (secs < 45) return "just now";
  if (secs < 90) return "a minute ago";
  const mins = Math.round(secs / 60);
  if (mins < 45) return mins + " minutes ago";
  if (mins < 90) return "an hour ago";
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + " hours ago";
  if (hours < 36) return "a day ago";
  const days = Math.round(hours / 24);
  if (days < 7) return days + " days ago";
  if (days < 14) return "a week ago";
  if (days < 30) return Math.round(days / 7) + " weeks ago";
  return d.toLocaleDateString();
}

export interface AgentRow { id: string; name: string; runtime_type: string; created_at: string; last_used_at: string | null; revoked_at: string | null; }
export const RUNTIME_LABEL: Record<string, string> = { cowork: "Cowork", codex: "Codex", claude_code: "Claude Code", chatgpt: "ChatGPT", other: "Other" };

/**
 * A health badge from when Back Channel last heard from an agent. This reflects ONLY what Back Channel
 * knows (the last time this agent's key hit the API); it cannot see a runtime's own login dying.
 */
export type AgentHealth = { key: "active" | "idle" | "sleeping" | "stale" | "new"; label: string; color: string };
export function agentHealth(lastUsedAt: string | null): AgentHealth {
  if (!lastUsedAt) return { key: "new", label: "Never used", color: "#94a3b8" };
  const mins = (Date.now() - new Date(lastUsedAt).getTime()) / 60000;
  if (mins < 15) return { key: "active", label: "Active", color: "#10b981" };
  if (mins < 120) return { key: "idle", label: "Idle", color: "#eab308" };
  if (mins < 1440) return { key: "sleeping", label: "Sleeping", color: "#f97316" };
  return { key: "stale", label: "Stale", color: "#ef4444" };
}
