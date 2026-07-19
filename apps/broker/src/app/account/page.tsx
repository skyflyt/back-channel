"use client";

/**
 * The logged-in dashboard.
 *
 * Layout/IA (2026-07 redesign — see docs/logged-in-redesign.md for the prototype
 * verdict): Mission-Control shell (top tab nav + Overview landing), a split-pane
 * reading view for Inbox threads, and a ⌘K command palette. Tabs:
 *   Overview  — greeting, metrics, approvals, conversations, agent fleet
 *   Inbox     — thread list + reading pane (turn state, in-browser decryption)
 *   Friends   — people cards + per-friend page (?friend=)
 *   Toolkit   — saved tools, shared-with-you, discoverable in circle
 *   Agents    — registered agents + connect-a-new-agent flows (MCP primary)
 *   Settings  — notifications/cadence, browser access, API key, activity
 *
 * Data + auth are unchanged from before the redesign: everything loads client-side
 * from /api/* with the bc_session cookie. In non-production builds an unauthenticated
 * visit falls back to a demo fixture (src/lib/demo-data.ts) so the UI can be
 * reviewed without a local Postgres; production shows the signed-out card.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { KeyMirrorConversation, BrowserAccessSettings } from "./keymirror-panel";
import { ArtifactEditor, ArtifactInspector, type EditorArtifact, LINK_HUMAN_WARNING, LINK_BADGE_TEXT } from "./library-editor";
import { LINK_HUMAN_WARNING_LEAD, LINK_HUMAN_WARNING_REST } from "@/lib/link-warnings";
import { Composer, type ComposerPrefill } from "./composer";
import { FriendPage } from "./friend-page";
import { AppShell, type ShellTab } from "@/components/ui/shell";
import { type PaletteItem } from "@/components/ui/command-palette";
import { Chip, EmptyState, HealthDot, MetricCard, PersonAvatar, SkeletonRows, agoShort, shortHandle, initialsOf } from "@/components/ui/primitives";
import { DEMO_ACCOUNT } from "@/lib/demo-data";

interface Me {
  id: string; handle: string; email: string; display_name: string | null; created_at: string;
  email_verified: boolean; api_key_masked: string | null; api_key_last_used_at: string | null;
  notify_idle_frames: boolean; favor_per_peer_daily?: number; favor_global_tokens_daily?: number;
  live_mode_default_minutes?: number; key_mirror_enrolled?: boolean;
  summary: { active_sessions: number };
}
interface Sess {
  session_id: string; role: string; peer_handle: string; goal: string | null;
  started_at: string; ended_at: string | null; end_reason: string | null;
  duration_min: number | null; expires_at: string;
  unread_count?: number; live?: boolean; live_until?: string | null;
  peer_present?: boolean; peer_ever_connected?: boolean; last_frame_at?: string | null;
}
interface SharedSkill { id: string; owner_handle: string; name: string; description: string | null; kind: string; type?: string; manifest?: Record<string, unknown> | null; }
interface AgentRow { id: string; name: string; runtime_type: string; created_at: string; last_used_at: string | null; revoked_at: string | null; }
const RUNTIME_LABEL: Record<string, string> = { cowork: "Cowork", codex: "Codex", claude_code: "Claude Code", chatgpt: "ChatGPT", other: "Other" };

// Derive a health badge from when BC last heard from an agent. This reflects ONLY
// what BC knows (last time this agent's bc_ token hit our API) — it can't see a
// runtime's own host-auth (Codex/ChatGPT login) dying. See FAQ + checkAgent copy.
type AgentHealth = { key: "active" | "idle" | "sleeping" | "stale" | "new"; label: string; color: string };
function agentHealth(lastUsedAt: string | null): AgentHealth {
  if (!lastUsedAt) return { key: "new", label: "Never used", color: "#94a3b8" };
  const mins = (Date.now() - new Date(lastUsedAt).getTime()) / 60000;
  if (mins < 15) return { key: "active", label: "Active", color: "#10b981" };
  if (mins < 120) return { key: "idle", label: "Idle", color: "#eab308" };
  if (mins < 1440) return { key: "sleeping", label: "Sleeping", color: "#f97316" };
  return { key: "stale", label: "Stale", color: "#ef4444" };
}

// "Whose turn is it" on an open thread, derived from existing session metadata.
type TurnState = { key: "yours" | "theirs" | "connecting"; label: string; next: string };
function threadTurn(x: { unread_count?: number; peer_handle: string; peer_ever_connected?: boolean; peer_present?: boolean }): TurnState {
  const peer = shortHandle(x.peer_handle || "they");
  if ((x.unread_count ?? 0) > 0) {
    return { key: "yours", label: "Your turn",
      next: "They replied — respond now, or your agent will pick it up on its next check (~10 min)." };
  }
  if (x.peer_ever_connected === false) {
    return { key: "connecting", label: `Waiting for ${peer}'s agent`,
      next: `${peer}'s agent hasn't come online yet — they'll get an email nudge to wake it.` };
  }
  return { key: "theirs", label: `${peer}'s agent will pick this up`,
    next: x.peer_present ? `${peer}'s agent is online — a reply should come through shortly.` : "Their agent will surface your message on its next inbox check (~10 min)." };
}

type NavKey = "overview" | "agents" | "friends" | "skills" | "messages" | "settings";
const NAV: { key: NavKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "messages", label: "Inbox" },
  { key: "friends", label: "Friends" },
  { key: "skills", label: "Toolkit" },
  { key: "agents", label: "Agents" },
  { key: "settings", label: "Settings" },
];
const NAV_KEYS = new Set(NAV.map((n) => n.key));
// "account" was a tab pre-redesign; old deep links map onto the new IA.
const LEGACY_TAB: Record<string, NavKey> = { account: "overview" };
const toNavKey = (v: string | null): NavKey | null =>
  v && NAV_KEYS.has(v as NavKey) ? (v as NavKey) : v && LEGACY_TAB[v] ? LEGACY_TAB[v] : null;
// Deep-link anchors used by in-app scroll targets map onto a nav section.
const ANCHOR_NAV: Record<string, NavKey> = { "connect-agent": "agents", "friends-section": "friends", "skills-section": "skills", compose: "messages" };

const RUNTIME_OPTIONS = [["other", "Other / not sure"], ["cowork", "Cowork (Claude desktop)"], ["claude_code", "Claude Code (CLI)"], ["codex", "Codex (CLI)"], ["chatgpt", "ChatGPT (web)"], ["claude_web", "Claude.ai web (chat tab)"]] as const;
// Runtimes that can read a URL but can't POST — they can install read-only artifacts
// but cannot connect an account. Honest dead-end instead of a silent failure.
const CHAT_TAB_RUNTIMES = ["chatgpt", "claude_web"];
interface TrustPeer { handle: string; last_session_at: string | null; trusted: boolean; mutual: boolean; established_at: string | null; }
interface InboxReq { id: string; requester_handle: string; scopes: string[]; message: string | null; created_at: string; expires_at: string; }
interface AuditEvent { type: string; label: string; at: string; detail: Record<string, unknown>; }
interface Skill { id: string; name: string; description: string | null; kind: string; shared_with: string[]; discoverable: boolean; type?: string; manifest?: Record<string, unknown> | null; body?: string; version?: number; signed?: boolean; public_token?: string | null; public_expires_at?: string | null; }
interface DiscoverSkill { id: string; owner_handle: string; name: string; description: string | null; kind: string; type?: string; manifest?: Record<string, unknown> | null; }

/** Read the non-httpOnly bc_csrf cookie to echo in the x-bc-csrf header. */
const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");

const SCOPE_LABELS: Record<string, string> = {
  "config.read": "read relevant settings",
  "config.suggest": "suggest changes for you to approve",
};
const plainScope = (scope: string) => SCOPE_LABELS[scope] ?? scope.replace(/[._]/g, " ");

const plainKind = (kind: string) => kind === "template" ? "Copyable" : kind === "rpc" ? "Runs with friend" : kind.replace(/[._]/g, " ");
const cleanDomain = (raw: string) => { try { return new URL(raw).hostname.replace(/^www\./, ""); } catch { return raw; } };
const LINK_SOURCE_LABEL: Record<string, string> = { github: "GitHub", backchannel: "Back Channel", web: "Web" };

// Friend-grade relative time ("2 hours ago") for thread/session rows — falls back to a
// plain date once "N days ago" stops being useful at a glance.
function when(iso: string): string {
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

/** What the Inbox reading pane is showing. */
type InboxSel =
  | { kind: "thread"; id: string }
  | { kind: "recent"; id: string }
  | { kind: "req"; id: string }
  | { kind: "compose" }
  | null;

export default function AccountPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "unauth" | "error">("loading");
  const [active, setActive] = useState<Sess[]>([]);
  const [recent, setRecent] = useState<Sess[]>([]);
  const [trust, setTrust] = useState<TrustPeer[]>([]);
  const [inbox, setInbox] = useState<InboxReq[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [showAudit, setShowAudit] = useState(false);
  const [showDevKey, setShowDevKey] = useState(false); // collapse the raw API key
  const [skills, setSkills] = useState<Skill[]>([]);
  const [discover, setDiscover] = useState<DiscoverSkill[]>([]);
  const [sharedWithMe, setSharedWithMe] = useState<SharedSkill[]>([]);
  const [sentToAgent, setSentToAgent] = useState<Record<string, boolean>>({});
  const [installPrompt, setInstallPrompt] = useState<Record<string, string>>({}); // paste-now prompt per shared skill (P2.6)
  const [installCopiedId, setInstallCopiedId] = useState<string | null>(null);
  const [pubTtl, setPubTtl] = useState<Record<string, string>>({}); // per-row public-share TTL selection
  const [pubCopiedId, setPubCopiedId] = useState<string | null>(null); // "Copied ✓" flash on the public link
  // Library CRUD: editor (create/edit), read-only inspector, and a save flash.
  const [editor, setEditor] = useState<{ mode: "create" | "edit"; initial?: EditorArtifact } | null>(null);
  const [inspect, setInspect] = useState<EditorArtifact | null>(null);
  // Link lessons (WS-A): which card's install/share action is pending the full-warning
  // confirmation step. { id, action } - cleared once the user confirms or cancels.
  const [linkWarnFor, setLinkWarnFor] = useState<{ id: string; action: string } | null>(null);
  const [libFlash, setLibFlash] = useState<string>("");
  const [newKey, setNewKey] = useState<string | null>(null);
  // "Connect a new agent" — PRIMARY: MCP connector (browser mints the token, the
  // human wires it into their client's own settings — the agent never executes
  // anything to establish trust). agentFormOpen drives the MCP form.
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentFormOpen, setAgentFormOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [agentRuntime, setAgentRuntime] = useState("other");
  const [mcpToken, setMcpToken] = useState<string | null>(null); // raw bc_ key — shown once
  const [mcpClient, setMcpClient] = useState<"claude_desktop" | "claude_code" | "codex" | "other">("claude_desktop");
  const [mcpOs, setMcpOs] = useState<"windows" | "mac">("windows");
  const [mcpErr, setMcpErr] = useState("");
  const [mcpCopied, setMcpCopied] = useState("");
  // LEGACY: exchange-code flow, demoted behind a disclosure (kept fully working —
  // it's still the only path for runtimes without MCP support).
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [legacyFormOpen, setLegacyFormOpen] = useState(false);
  // Track B (Guided, default) vs Track A (Quick one-paste).
  const [connectTrack, setConnectTrack] = useState<"guided" | "quick">("guided");
  const [copiedStep, setCopiedStep] = useState<string>("");
  const [agentCheck, setAgentCheck] = useState<Record<string, string>>({}); // per-agent "Check status" verdict
  // Deep-link support: /account?tab=friends opens directly on that tab. Bare /account
  // lands on Overview (the redesign's home). Read once on mount — client-only.
  const [nav, setNav] = useState<NavKey>(() => {
    if (typeof window === "undefined") return "overview";
    return toNavKey(new URLSearchParams(window.location.search).get("tab")) ?? "overview";
  });
  const [kmOpen, setKmOpen] = useState<string | null>(null); // sessionId being read in-browser (key mirror)
  const [inboxSel, setInboxSel] = useState<InboxSel>(null);  // reading-pane selection
  const [exCode, setExCode] = useState<string | null>(null);
  const [exPrompt, setExPrompt] = useState<string>("");
  const [exExpiry, setExExpiry] = useState<number>(0);     // epoch ms
  const [exCopied, setExCopied] = useState(false);
  const [exErr, setExErr] = useState<string>("");          // surfaced connect-code error (429/403/409/…)
  // Power-user raw-key reveal (kept behind an explainer).
  const [bootstrap, setBootstrap] = useState<string | null>(null);
  const [bootstrapCopied, setBootstrapCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [wakePrompts, setWakePrompts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  // Composer (extracted to composer.tsx) — a prefill key forces a remount with
  // fresh state whenever askFriend() targets a new handle/topic/framing.
  const [composerPrefill, setComposerPrefill] = useState<(ComposerPrefill & { key: number }) | null>(null);
  // Per-friend agent page: /account?friend=<handle>, URL-synced like ?tab=.
  const [friendView, setFriendView] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("friend");
  });
  const [notify, setNotify] = useState(true);
  const [liveDefault, setLiveDefault] = useState(15);
  const [inboxEnabled, setInboxEnabled] = useState(true);
  const [inboxMinutes, setInboxMinutes] = useState(10);
  // Invite a friend (Phase 3)
  const [fiOpen, setFiOpen] = useState(false);
  const [fiEmail, setFiEmail] = useState("");
  const [fiNote, setFiNote] = useState("");
  const [fiSent, setFiSent] = useState(false);
  const [fiErr, setFiErr] = useState("");

  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch("/api/account/sessions", { credentials: "include" });
      if (r.ok) { const j = await r.json(); setActive(j.active ?? []); setRecent(j.recent ?? []); }
    } catch { /* leave as-is */ }
  }, []);

  const loadTrust = useCallback(async () => {
    try {
      const r = await fetch("/api/trust", { credentials: "include" });
      if (r.ok) setTrust((await r.json()).peers ?? []);
    } catch { /* leave as-is */ }
  }, []);

  const loadInbox = useCallback(async () => {
    try {
      const r = await fetch("/api/inbox", { credentials: "include" });
      if (r.ok) setInbox((await r.json()).requests ?? []);
    } catch { /* leave as-is */ }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const r = await fetch("/api/account/audit", { credentials: "include" });
      if (r.ok) setAudit((await r.json()).events ?? []);
    } catch { /* leave as-is */ }
  }, []);

  const loadSkills = useCallback(async () => {
    try {
      const r = await fetch("/api/skills", { credentials: "include" });
      if (r.ok) setSkills((await r.json()).skills ?? []);
      const d = await fetch("/api/skills/discover", { credentials: "include" });
      if (d.ok) setDiscover((await d.json()).skills ?? []);
      const sm = await fetch("/api/skills/shared-with-me", { credentials: "include" });
      if (sm.ok) setSharedWithMe((await sm.json()).skills ?? []);
    } catch { /* leave as-is */ }
  }, []);

  const loadAgents = useCallback(async () => {
    try {
      const r = await fetch("/api/account/agents", { credentials: "include" });
      if (r.ok) setAgents((await r.json()).agents ?? []);
    } catch { /* leave as-is */ }
  }, []);

  const toggleDiscoverable = async (skillId: string, on: boolean) => {
    setBusy(`disc:${skillId}`);
    await fetch(`/api/skills/${skillId}`, { method: "PATCH", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ discoverable: on }) }).catch(() => {});
    setBusy(""); loadSkills();
  };

  useEffect(() => {
    (async () => {
      try {
        // If we arrived from an email/sign-in link (?vt=…), consume it via POST
        // (scanner-safe — a pre-fetch GET of this page never consumes the token)
        // to set the bc_session cookie, then strip it from the URL.
        const url = new URL(window.location.href);
        const vt = url.searchParams.get("vt");
        if (vt) {
          await fetch("/api/auth/view-token-consume", {
            method: "POST", credentials: "include",
            headers: { "content-type": "application/json" }, body: JSON.stringify({ token: vt }),
          }).catch(() => {});
          url.searchParams.delete("vt");
          window.history.replaceState({}, "", url.pathname + url.search);
        }
        const r = await fetch("/api/account/me", { credentials: "include" });
        if (r.status === 401) { setState("unauth"); return; }
        if (!r.ok) { setState("error"); return; }
        const j = await r.json(); setMe(j); setNotify(j.notify_idle_frames); if (typeof j.live_mode_default_minutes === "number") setLiveDefault(j.live_mode_default_minutes); if (typeof j.inbox_check_enabled === "boolean") setInboxEnabled(j.inbox_check_enabled); if (typeof j.inbox_check_minutes === "number") setInboxMinutes(j.inbox_check_minutes); setState("ok");
        loadSessions();
        loadTrust();
        loadInbox();
        loadSkills();
        loadAgents();
      } catch { setState("error"); }
    })();
  }, [loadSessions, loadTrust, loadInbox, loadSkills, loadAgents]);

  // Keep ?tab= in sync with the active nav so the current view is always a shareable/
  // bookmarkable deep link. replaceState avoids polluting back-button history.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("tab") === nav) return;
    url.searchParams.set("tab", nav);
    window.history.replaceState({}, "", url.pathname + url.search);
  }, [nav]);

  // Per-friend agent page URL sync (?friend=<handle>) — same replaceState pattern.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const current = url.searchParams.get("friend");
    if (current === friendView) return;
    if (friendView) url.searchParams.set("friend", friendView);
    else url.searchParams.delete("friend");
    window.history.replaceState({}, "", url.pathname + url.search);
  }, [friendView]);

  const openFriend = (handle: string) => { setFriendView(handle); setNav("friends"); };

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    window.location.href = "/login";
  };

  const getWakePrompt = async (id: string) => {
    setBusy(`wp:${id}`);
    try {
      const r = await fetch(`/api/sessions/${id}/wake-prompt`, { credentials: "include" });
      if (r.ok) { const j = await r.json(); setWakePrompts((m) => ({ ...m, [id]: j.prompt })); }
    } catch { /* ignore */ }
    setBusy("");
  };

  const endSession = async (id: string, peer: string) => {
    if (!confirm(`End your session with ${peer}? Both agents will be disconnected immediately.`)) return;
    setBusy(id);
    await fetch(`/api/sessions/${id}/end`, { method: "POST", credentials: "include", headers: { "x-bc-csrf": csrf() } }).catch(() => {});
    setBusy(""); loadSessions();
  };

  const rotateKey = async () => {
    if (!confirm("Rotate your API key? Any agent still using the old key will stop working until you give it the new one.")) return;
    setBusy("key");
    try {
      const r = await fetch("/api/account/key/rotate", { method: "POST", credentials: "include", headers: { "x-bc-csrf": csrf() } });
      const j = await r.json();
      if (r.ok && j.api_key) setNewKey(j.api_key);
    } catch { /* ignore */ }
    setBusy("");
  };

  const revealBootstrap = async () => {
    setBusy("bootstrap");
    try {
      const r = await fetch("/api/account/bootstrap-prompt", { credentials: "include" });
      const j = await r.json();
      if (r.ok && j.prompt) setBootstrap(j.prompt);
    } catch { /* ignore */ }
    setBusy("");
  };

  // Auto-hide the revealed raw-key prompt after 30s (it contains the full key).
  useEffect(() => {
    if (!bootstrap) return;
    const t = setTimeout(() => { setBootstrap(null); setBootstrapCopied(false); }, 30000);
    return () => clearTimeout(t);
  }, [bootstrap]);

  // Clear an active exchange code once it truly expires (no surfaced countdown —
  // the 15-min TTL is calm by design; a ticking timer reads as pressure).
  useEffect(() => {
    if (!exCode || !exExpiry) return;
    const left = exExpiry - Date.now();
    if (left <= 0) { setExCode(null); setExPrompt(""); setExCopied(false); return; }
    const t = setTimeout(() => { setExCode(null); setExPrompt(""); setExCopied(false); }, left);
    return () => clearTimeout(t);
  }, [exCode, exExpiry]);

  // Map a failed exchange-code mint to a plain-language message.
  const exchangeErrorMessage = (status: number, j: { message?: string }) =>
    status === 429 ? "You've generated a lot of codes recently — wait a few minutes, or use one you already copied."
    : status === 403 ? "Your sign-in session expired. Refresh the page and try again."
    : status === 409 ? "Your email isn't verified yet — check your inbox for the sign-in link."
    : (j.message || `Couldn't generate a code (error ${status}). Try again in a moment.`);

  // MCP connector: mint a per-agent key straight from the dashboard.
  const MCP_CLIENT_RUNTIME: Record<string, string> = { claude_desktop: "cowork", claude_code: "claude_code", codex: "codex", other: "other" };
  const MCP_CLIENT_LABEL: Record<string, string> = { claude_desktop: "Claude Desktop", claude_code: "Claude Code", codex: "Codex CLI", other: "Other MCP client" };
  const mintMcpToken = async () => {
    setBusy("mcp-mint"); setMcpErr("");
    try {
      const r = await fetch("/api/account/agents", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json", "x-bc-csrf": csrf() },
        body: JSON.stringify({ agent_name: agentName.trim() || MCP_CLIENT_LABEL[mcpClient], runtime_type: MCP_CLIENT_RUNTIME[mcpClient] }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.api_key) { setMcpToken(j.api_key); setAgentFormOpen(false); setMcpCopied(""); loadAgents(); }
      else setMcpErr(exchangeErrorMessage(r.status, j));
    } catch { setMcpErr("Couldn't reach Back Channel. Check your connection and try again."); }
    setBusy("");
  };

  const connectNewAgent = async () => {
    setBusy("exchange"); setExErr("");
    try {
      const r = await fetch("/api/auth/exchange-code", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json", "x-bc-csrf": csrf() },
        body: JSON.stringify({ agent_name: agentName.trim() || "New agent", runtime_type: agentRuntime === "claude_web" ? "other" : agentRuntime }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.code) { setExCode(j.code); setExPrompt(j.paste_prompt); setExExpiry(new Date(j.expires_at).getTime()); setExCopied(false); setLegacyFormOpen(false); }
      else setExErr(exchangeErrorMessage(r.status, j));
    } catch { setExErr("Couldn't reach Back Channel. Check your connection and try again."); }
    setBusy("");
  };

  const revokeAgent = async (id: string, name: string) => {
    if (!confirm(`Revoke "${name}"? This agent will lose access immediately. Your other agents stay connected.`)) return;
    setBusy(`revoke:${id}`);
    await fetch(`/api/account/agents/${id}`, { method: "DELETE", credentials: "include", headers: { "x-bc-csrf": csrf() } }).catch(() => {});
    setBusy(""); loadAgents();
  };

  // Mint a fresh exchange code carrying this agent's name+runtime, so the user can
  // re-paste it to their agent and re-bind a new BC token (e.g. after host-auth died).
  const reconnectAgent = async (a: AgentRow) => {
    setBusy(`reconnect:${a.id}`); setExErr("");
    try {
      const r = await fetch("/api/auth/exchange-code", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json", "x-bc-csrf": csrf() },
        body: JSON.stringify({ agent_name: a.name, runtime_type: a.runtime_type }),
      });
      const j = await r.json().catch(() => ({}));
      // Reconnect rides the legacy exchange-code panel — make sure it's visible.
      setLegacyOpen(true);
      if (r.ok && j.code) {
        setExCode(j.code); setExPrompt(j.paste_prompt); setExExpiry(new Date(j.expires_at).getTime()); setExCopied(false); setLegacyFormOpen(false);
      } else {
        setExErr(exchangeErrorMessage(r.status, j));
      }
      setTimeout(() => document.querySelector("#connect-agent")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch { setExErr("Couldn't reach Back Channel. Check your connection and try again."); }
    setBusy("");
  };

  // "Check status": re-read this agent's last-poll freshness and render an honest
  // verdict. BC only knows when the agent last hit our API — not whether the
  // runtime's own login is alive — so the copy points the user at the real fix.
  const checkAgent = async (a: AgentRow) => {
    setBusy(`check:${a.id}`);
    try {
      const r = await fetch("/api/account/agents", { credentials: "include" });
      const j = await r.json().catch(() => ({}));
      const fresh: AgentRow | undefined = (j.agents ?? []).find((x: AgentRow) => x.id === a.id);
      const h = agentHealth(fresh?.last_used_at ?? null);
      let msg: string;
      if (h.key === "active") msg = `✓ Heard from this agent ${when(fresh!.last_used_at!)} — looks healthy.`;
      else if (h.key === "new") msg = "This agent has never checked in. Paste its exchange code to finish connecting.";
      else if (h.key === "stale") msg = `⚠ No contact in over a day (last ${when(fresh!.last_used_at!)}). If you expect it to be running, its runtime (Codex/ChatGPT/etc.) likely lost its OWN login — fix that first. If Back Channel itself is stuck, use Reconnect agent.`;
      else msg = `Last heard from ${when(fresh!.last_used_at!)}. It may just be between checks (agents poll every ~10 min). If you expect it live and it stays quiet, check your agent's runtime login.`;
      setAgentCheck((m) => ({ ...m, [a.id]: msg }));
      if (j.agents) setAgents(j.agents);
    } catch { setAgentCheck((m) => ({ ...m, [a.id]: "Couldn't check just now — try again." })); }
    setBusy("");
  };

  const renameAgent = async (id: string, current: string) => {
    const name = prompt("Rename this agent:", current);
    if (!name || name.trim() === current) return;
    setBusy(`rename:${id}`);
    await fetch(`/api/account/agents/${id}/rename`, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ name: name.trim() }) }).catch(() => {});
    setBusy(""); loadAgents();
  };

  const toggleNotify = async () => {
    const next = !notify; setNotify(next); setBusy("notify");
    await fetch("/api/account/settings", { method: "PATCH", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ notify_idle_frames: next }) }).catch(() => setNotify(!next));
    setBusy("");
  };

  const saveLiveDefault = async (minutes: number) => {
    setLiveDefault(minutes); setBusy("live");
    await fetch("/api/account/settings", { method: "PATCH", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ live_mode_default_minutes: minutes }) }).catch(() => {});
    setBusy("");
  };

  const inviteFriend = async () => {
    setFiErr("");
    if (!fiEmail.includes("@")) { setFiErr("Enter your friend's email."); return; }
    setBusy("friendinvite");
    try {
      const r = await fetch("/api/friends/invite", { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ email: fiEmail.trim(), note: fiNote.trim() || undefined }) });
      if (r.ok) { setFiSent(true); setFiOpen(false); setFiEmail(""); setFiNote(""); }
      else setFiErr("Couldn't send — check the email and try again.");
    } catch { setFiErr("Something went wrong — try again."); }
    setBusy("");
  };

  const toggleInboxCheck = async () => {
    const next = !inboxEnabled; setInboxEnabled(next); setBusy("inboxchk");
    await fetch("/api/account/settings", { method: "PATCH", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ inbox_check_enabled: next }) }).catch(() => setInboxEnabled(!next));
    setBusy("");
  };

  const saveInboxMinutes = async (minutes: number) => {
    setInboxMinutes(minutes); setBusy("inboxmin");
    await fetch("/api/account/settings", { method: "PATCH", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ inbox_check_minutes: minutes }) }).catch(() => {});
    setBusy("");
  };

  const sendToMyAgent = async (sk: SharedSkill) => {
    setBusy(`send:${sk.id}`);
    try {
      const r = await fetch(`/api/skills/${sk.id}/send-to-me`, { method: "POST", credentials: "include", headers: { "x-bc-csrf": csrf() } });
      if (r.ok) {
        setSentToAgent((m) => ({ ...m, [sk.id]: true }));
        // P2.6: also offer a paste-now prompt for impatient users. Idempotent install
        // (skip if already set up) — same pattern the skill's agent.payload handler uses.
        const owner = shortHandle(sk.owner_handle);
        setInstallPrompt((m) => ({ ...m, [sk.id]: `Using Back Channel: add the tool "${sk.name}" that ${owner} shared with me. It's already queued in my Back Channel Inbox, but set it up now instead of waiting. Fetch the shared copy from https://back-channel.app/api/skills/${sk.id}/copy, verify the author signature before trusting it, add it locally, then tell me in plain words what it does. If you've already added "${sk.name}" at this version, just skip it (no duplicate).` }));
      }
    } catch { /* ignore */ }
    setBusy("");
  };

  // Open the composer prefilled for this friend/topic — used by the discover/shared
  // cards' "Ask their agent" / "Ask to share" actions and the Friends tab's Message
  // button. Honest: it just opens a real message thread (no hidden RPC).
  const askFriend = (handle: string, topic: string) => {
    setFriendView(null); setNav("messages"); setInboxSel({ kind: "compose" });
    setComposerPrefill((prev) => ({ friend: handle, topic, key: (prev?.key ?? 0) + 1 }));
  };

  const acceptInbox = async (id: string, who: string) => {
    if (!confirm(`Approve ${who}'s request to collaborate? A session will open and your agent will run it (you still approve the work once inside).`)) return;
    setBusy(`inbox:${id}`);
    try {
      const r = await fetch(`/api/inbox/${id}/accept`, { method: "POST", credentials: "include", headers: { "x-bc-csrf": csrf() } });
      const j = await r.json();
      if (r.ok && j.session_id) { window.location.href = `/sessions/${j.session_id}`; return; }
    } catch { /* ignore */ }
    setBusy(""); loadInbox(); loadSessions();
  };

  const rejectInbox = async (id: string) => {
    setBusy(`inbox:${id}`);
    await fetch(`/api/inbox/${id}/reject`, { method: "POST", credentials: "include", headers: { "x-bc-csrf": csrf() } }).catch(() => {});
    setBusy(""); loadInbox();
  };

  const shareSkill = async (skillId: string, handle: string, on: boolean) => {
    setBusy(`skill:${skillId}:${handle}`);
    try {
      if (on) await fetch(`/api/skills/${skillId}/share`, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ peer_handle: handle }) });
      else await fetch(`/api/skills/${skillId}/share/${encodeURIComponent(handle)}`, { method: "DELETE", credentials: "include", headers: { "x-bc-csrf": csrf() } });
    } catch { /* ignore */ }
    setBusy(""); loadSkills();
  };

  const deleteSkill = async (skillId: string, name: string) => {
    if (!confirm(`Delete the skill "${name}"? Anyone you shared it with will lose access (template copies they already imported stay with them).`)) return;
    setBusy(`skilldel:${skillId}`);
    await fetch(`/api/skills/${skillId}`, { method: "DELETE", credentials: "include", headers: { "x-bc-csrf": csrf() } }).catch(() => {});
    setBusy(""); loadSkills();
  };

  // Public share (spec §3): mint / revoke a one-paste stranger link.
  const publicShare = async (id: string, ttl: string) => {
    setBusy(`pub:${id}`);
    try {
      const r = await fetch(`/api/artifacts/${id}/public-share`, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ ttl }) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); alert(e.message || `Couldn't create a public link (${e.error || r.status}).`); }
    } catch { /* ignore */ }
    setBusy(""); loadSkills();
  };
  const publicRevoke = async (id: string) => {
    if (!confirm("Revoke this public link? Anyone holding it loses access immediately. You can generate a new one later.")) return;
    setBusy(`pub:${id}`);
    await fetch(`/api/artifacts/${id}/public-share/revoke`, { method: "POST", credentials: "include", headers: { "x-bc-csrf": csrf() } }).catch(() => {});
    setBusy(""); loadSkills();
  };

  const toggleTrust = async (handle: string, on: boolean) => {
    if (!on && !confirm(`Revoke trust with ${handle}? They'll need a fresh invite to reach you, and any pending requests from them stop. You can re-enable anytime.`)) return;
    setBusy(`trust:${handle}`);
    try {
      if (on) await fetch("/api/trust", { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ peer_handle: handle }) });
      else await fetch(`/api/trust/${encodeURIComponent(handle)}`, { method: "DELETE", credentials: "include", headers: { "x-bc-csrf": csrf() } });
    } catch { /* ignore */ }
    setBusy(""); loadTrust();
  };

  /* ------------------------------------------------------------------ */
  /* View data: real when signed in; demo fixture in non-prod when not. */
  /* ------------------------------------------------------------------ */

  const demoMode = state !== "loading" && state !== "ok" && process.env.NODE_ENV !== "production";
  const vMe: Me | null = demoMode ? (DEMO_ACCOUNT.me as unknown as Me) : me;
  const vActive: Sess[] = demoMode ? (DEMO_ACCOUNT.active as unknown as Sess[]) : active;
  const vRecent: Sess[] = demoMode ? (DEMO_ACCOUNT.recent as unknown as Sess[]) : recent;
  const vTrust: TrustPeer[] = demoMode ? (DEMO_ACCOUNT.trust as unknown as TrustPeer[]) : trust;
  const vInbox: InboxReq[] = demoMode ? (DEMO_ACCOUNT.inbox as unknown as InboxReq[]) : inbox;
  const vSkills: Skill[] = demoMode ? (DEMO_ACCOUNT.skills as unknown as Skill[]) : skills;
  const vDiscover: DiscoverSkill[] = demoMode ? (DEMO_ACCOUNT.discover as unknown as DiscoverSkill[]) : discover;
  const vShared: SharedSkill[] = demoMode ? (DEMO_ACCOUNT.sharedWithMe as unknown as SharedSkill[]) : sharedWithMe;
  const vAgents: AgentRow[] = demoMode ? (DEMO_ACCOUNT.agents as unknown as AgentRow[]) : agents;

  const yoursThreads = vActive.filter((t) => threadTurn(t).key === "yours");
  const needsYou = vInbox.length + yoursThreads.length;
  const healthyAgents = vAgents.filter((a) => ["active", "idle"].includes(agentHealth(a.last_used_at).key)).length;
  const mutualFriends = vTrust.filter((f) => f.trusted && f.mutual);

  // Default reading-pane selection: first item that needs the user, else first thread.
  const effectiveSel: InboxSel = inboxSel ?? (vInbox[0] ? { kind: "req", id: vInbox[0].id } : vActive[0] ? { kind: "thread", id: vActive[0].session_id } : null);

  const shellTabs: ShellTab[] = NAV.map((n) => ({
    key: n.key, label: n.label,
    count: n.key === "messages" ? needsYou || undefined : undefined,
    onSelect: () => { setNav(n.key); if (n.key !== "friends") setFriendView(null); },
  }));

  const paletteItems: PaletteItem[] = useMemo(() => {
    const items: PaletteItem[] = [];
    for (const n of NAV) items.push({ id: `nav-${n.key}`, group: "Navigate", label: n.label, icon: "→", onSelect: () => { setNav(n.key); if (n.key !== "friends") setFriendView(null); } });
    items.push({ id: "act-compose", group: "Actions", label: "New message…", icon: "✎", onSelect: () => { setNav("messages"); setInboxSel({ kind: "compose" }); } });
    items.push({ id: "act-invite", group: "Actions", label: "Invite a friend…", icon: "＋", onSelect: () => { setNav("friends"); setFriendView(null); setFiErr(""); setFiOpen(true); } });
    items.push({ id: "act-connect", group: "Actions", label: "Connect a new agent…", icon: "⚡", onSelect: () => { setNav("agents"); setAgentName(""); setMcpClient("claude_desktop"); setAgentFormOpen(true); } });
    for (const t of vActive) items.push({ id: `t-${t.session_id}`, group: "Threads", label: shortHandle(t.peer_handle), meta: t.goal ?? undefined, icon: "💬", onSelect: () => { setNav("messages"); setInboxSel({ kind: "thread", id: t.session_id }); } });
    for (const f of vTrust) items.push({ id: `f-${f.handle}`, group: "Friends", label: shortHandle(f.handle), meta: f.mutual ? "mutual friend" : "invite pending", icon: "☺", onSelect: () => openFriend(f.handle) });
    for (const sk of vSkills) items.push({ id: `s-${sk.id}`, group: "Toolkit", label: sk.name, meta: sk.description ?? undefined, icon: "⚒", onSelect: () => { setNav("skills"); setFriendView(null); } });
    for (const sk of vShared) items.push({ id: `sw-${sk.id}`, group: "Toolkit", label: sk.name, meta: `shared by ${shortHandle(sk.owner_handle)}`, icon: "🎁", onSelect: () => { setNav("skills"); setFriendView(null); } });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vActive, vTrust, vSkills, vShared]);

  /* ---------------------------- shell states ---------------------------- */

  const shellProps = {
    tabs: shellTabs,
    activeTab: nav,
    userLabel: vMe ? initialsOf(vMe.display_name || vMe.handle) : "?",
    userTitle: vMe ? `${vMe.display_name || vMe.handle} — settings` : undefined,
    onAvatarClick: () => setNav("settings"),
    paletteItems,
    demoBanner: demoMode ? (
      <div className="ds-demo-banner">
        Previewing with <strong>demo data</strong> — sign in (needs a local DB) for your real account. Actions are disabled.
      </div>
    ) : undefined,
  };

  if (state === "loading") {
    return (
      <AppShell {...shellProps} demoBanner={undefined}>
        <div className="ds-wrap">
          <div className="ds-skel" style={{ width: 220, height: 26, marginBottom: 8 }} />
          <div className="ds-skel" style={{ width: 320, height: 14, marginBottom: 24 }} />
          <div className="ds-metrics">
            {[0, 1, 2, 3].map((i) => <div key={i} className="ds-card"><SkeletonRows rows={2} /></div>)}
          </div>
          <div className="ds-grid">
            <div className="ds-card"><SkeletonRows rows={6} /></div>
            <div className="ds-card"><SkeletonRows rows={4} /></div>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!demoMode && (state === "unauth" || state === "error" || !me)) {
    return (
      <AppShell tabs={[]} userLabel="?" >
        <div className="ds-wrap" style={{ maxWidth: 520 }}>
          <h1 className="ds-h1">Your account</h1>
          <div className="ds-card" style={{ marginTop: 14 }}>
            {state === "unauth"
              ? (<><p style={{ margin: "0 0 14px", lineHeight: 1.6 }}>You&apos;re signed out, or your sign-in link expired.</p><a className="ds-btn" style={{ textDecoration: "none", display: "inline-block" }} href="/login">Sign in</a></>)
              : <p className="ds-call danger" style={{ margin: 0 }}>Couldn&apos;t load your account. Please try again.</p>}
          </div>
        </div>
      </AppShell>
    );
  }

  const m = vMe!;
  const lastUsed = m.api_key_last_used_at ? new Date(m.api_key_last_used_at).toLocaleString() : "never";
  const hourNow = new Date().getHours();
  const greet = hourNow < 12 ? "morning" : hourNow < 18 ? "afternoon" : "evening";

  // First-run: no friends AND no sessions of any kind — Overview leads with the
  // getting-started card instead of metrics.
  const hasAgent = vAgents.length > 0;
  const hasFriend = vTrust.some((t) => t.trusted) || fiSent;
  const hasSkill = vSkills.length > 0 || Object.keys(sentToAgent).length > 0;
  const onboarded = hasAgent && hasFriend && hasSkill;
  const isFirstRun = !vTrust.length && !vActive.length && !vRecent.length;

  /* --------------------------- shared fragments --------------------------- */

  const turnChip = (t: Sess) => {
    const tu = threadTurn(t);
    return <Chip tone={tu.key === "yours" ? "acc" : tu.key === "connecting" ? "warn" : undefined}>{tu.label}</Chip>;
  };

  const approvalItem = (r: InboxReq) => (
    <div className="ds-item" key={r.id}>
      <PersonAvatar handle={r.requester_handle} />
      <div style={{ minWidth: 0 }}>
        <div className="ds-iname">{shortHandle(r.requester_handle)}</div>
        <div className="ds-igoal">{r.message ?? "wants to collaborate"}</div>
        <div className="ds-imeta">asks to: {r.scopes.map(plainScope).join(", ")} · {when(r.created_at)}</div>
      </div>
      <div className="ds-iright">
        <button className="ds-btn" disabled={busy === `inbox:${r.id}` || demoMode} onClick={() => acceptInbox(r.id, r.requester_handle)}>{busy === `inbox:${r.id}` ? "…" : "Approve"}</button>
        <button className="ds-btn ghost" disabled={busy === `inbox:${r.id}` || demoMode} onClick={() => rejectInbox(r.id)}>Decline</button>
      </div>
    </div>
  );

  const linkWarnBox = (onConfirm: () => void, confirmLabel: string) => (
    <div className="ds-call warn" style={{ marginTop: 8, flexBasis: "100%" }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>↗ {LINK_BADGE_TEXT}</div>
      <strong>{LINK_HUMAN_WARNING_LEAD}</strong>{LINK_HUMAN_WARNING_REST}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="ds-btn ghost" onClick={() => setLinkWarnFor(null)}>Cancel</button>
        <button className="ds-btn" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </div>
  );

  /* ------------------------------ overview ------------------------------ */

  const overview = (
    <>
      <h1 className="ds-h1">Good {greet}, {m.display_name || shortHandle(m.handle)}</h1>
      <p className="ds-sub">Here&apos;s what your agents have been up to.</p>

      {!onboarded && (
        <div className="ds-card" style={{ marginBottom: 22, borderColor: "var(--ds-acc-line)" }}>
          <h2 className="ds-cardh">👋 Get started — {[hasAgent, hasFriend, hasSkill].filter(Boolean).length}/3</h2>
          <p className="ds-cardsub">Three steps and your agent can start collaborating.</p>
          {[
            { done: hasAgent, label: "Connect an agent", action: () => { setNav("agents"); setAgentFormOpen(true); } },
            { done: hasFriend, label: "Add a friend", action: () => { setNav("friends"); setFiErr(""); setFiOpen(true); } },
            { done: hasSkill, label: "Try a tool from your circle, or save your first Toolkit item", action: () => setNav("skills") },
          ].map((step, i) => (
            <div className="ds-item" key={i} style={{ alignItems: "center" }}>
              <span aria-hidden style={{
                width: 20, height: 20, borderRadius: 6, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, fontWeight: 700, color: "#fff", background: step.done ? "var(--ds-ok)" : "var(--ds-line)",
              }}>{step.done ? "✓" : ""}</span>
              <span style={{ color: step.done ? "var(--ds-faint)" : "var(--ds-ink)", textDecoration: step.done ? "line-through" : "none", fontSize: 13.5 }}>{step.label}</span>
              {!step.done && <div className="ds-iright"><button className="ds-btn ghost" onClick={step.action}>Go</button></div>}
            </div>
          ))}
          {hasAgent && !onboarded && (
            <p className="ds-fine" style={{ marginTop: 10 }}>📬 Your agent has mail — ask it to check its Back Channel inbox, or <button className="ds-link" onClick={() => setNav("messages")}>open your Inbox</button>.</p>
          )}
        </div>
      )}

      <div className="ds-metrics">
        <MetricCard label="Needs you" value={needsYou} accent={needsYou > 0}
          note={`${vInbox.length} approval${vInbox.length === 1 ? "" : "s"} · ${yoursThreads.length} repl${yoursThreads.length === 1 ? "y" : "ies"}`} />
        <MetricCard label="Open threads" value={vActive.length} note={`${vRecent.length} finished recently`} />
        <MetricCard label="Agents healthy" value={<>{healthyAgents}<span style={{ color: "var(--ds-mut)", fontSize: 16 }}> / {vAgents.length}</span></>}>
          <div className="ds-hbar"><div style={{ width: `${vAgents.length ? (healthyAgents / vAgents.length) * 100 : 0}%` }} /></div>
        </MetricCard>
        <MetricCard label="Friends" value={mutualFriends.length}
          note={`${vTrust.filter((f) => f.trusted && !f.mutual).length} invite pending`} />
      </div>

      <div className="ds-grid">
        <div className="ds-col">
          {vInbox.length > 0 && (
            <div className="ds-card">
              <h2 className="ds-cardh">✅ Waiting for your approval</h2>
              <p className="ds-cardsub">Friends&apos; agents asking to work with yours. Approving opens a conversation; your agent still checks each action.</p>
              {vInbox.map(approvalItem)}
            </div>
          )}
          <div className="ds-card">
            <h2 className="ds-cardh">Conversations</h2>
            <p className="ds-cardsub">Agent-to-agent threads with your friends. New items wait here until you or your agent picks them up — nobody has to stay online.</p>
            {vActive.length === 0 && (
              <EmptyState icon="💬">Nothing yet — when a friend&apos;s agent messages yours, it lands here.{" "}
                <button className="ds-link" onClick={() => { setNav("messages"); setInboxSel({ kind: "compose" }); }}>Start one →</button>
              </EmptyState>
            )}
            {vActive.map((t) => (
              <div className="ds-item" key={t.session_id}>
                <PersonAvatar handle={t.peer_handle} />
                <div style={{ minWidth: 0 }}>
                  <div className="ds-iname">{shortHandle(t.peer_handle)} {turnChip(t)}{t.live && <> <Chip tone="ok">● live</Chip></>}</div>
                  {t.goal && <div className="ds-igoal">{t.goal}</div>}
                  <div className="ds-imeta">started {when(t.started_at)}</div>
                </div>
                <div className="ds-iright">
                  <button className={threadTurn(t).key === "yours" ? "ds-btn" : "ds-btn ghost"}
                    onClick={() => { setNav("messages"); setInboxSel({ kind: "thread", id: t.session_id }); }}>
                    {threadTurn(t).key === "yours" ? "Respond" : "Open"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="ds-col">
          <div className="ds-card">
            <h2 className="ds-cardh">Agent fleet</h2>
            <p className="ds-cardsub">Last time each agent checked in.</p>
            {vAgents.length === 0 && <EmptyState icon="🤖">No agents yet. <button className="ds-link" onClick={() => { setNav("agents"); setAgentFormOpen(true); }}>Connect one →</button></EmptyState>}
            {vAgents.map((a) => {
              const h = agentHealth(a.last_used_at);
              return (
                <div className="ds-item" key={a.id} style={{ alignItems: "center" }}>
                  <HealthDot color={h.color} label={h.label} />
                  <div style={{ minWidth: 0 }}>
                    <div className="ds-iname" style={{ fontSize: 13 }}>{a.name}</div>
                    <div className="ds-imeta">{h.label} · {a.last_used_at ? when(a.last_used_at) : "never used"}</div>
                  </div>
                </div>
              );
            })}
            {vAgents.length > 0 && <button className="ds-btn ghost" style={{ marginTop: 10, width: "100%" }} onClick={() => setNav("agents")}>Manage agents</button>}
          </div>
          <div className="ds-card">
            <h2 className="ds-cardh">Toolkit</h2>
            <p className="ds-cardsub">{vSkills.length} saved · {vShared.length} shared with you</p>
            {vSkills.slice(0, 3).map((sk) => (
              <div className="ds-item" key={sk.id} style={{ alignItems: "center" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="ds-iname" style={{ fontSize: 13 }}>{sk.name}</div>
                  <div className="ds-imeta">{plainKind(sk.kind).toLowerCase()}{sk.discoverable ? " · in your circle" : ""}</div>
                </div>
              </div>
            ))}
            <button className="ds-btn ghost" style={{ marginTop: 10, width: "100%" }} onClick={() => setNav("skills")}>View all</button>
          </div>
          <div className="ds-card ds-promo">
            <h2 className="ds-cardh">Grow your circle</h2>
            <p className="ds-cardsub">Back Channel gets better with every friend. Invite someone and your agents can collaborate.</p>
            <button className="ds-btn ghost" onClick={() => { setNav("friends"); setFiErr(""); setFiOpen(true); }}>Invite a friend</button>
          </div>
        </div>
      </div>
      {isFirstRun && <p className="ds-fine" style={{ marginTop: 16 }}>New here? The <button className="ds-link" onClick={() => setNav("messages")}>Inbox</button> is where conversations with friends&apos; agents happen once you&apos;re set up.</p>}
    </>
  );

  /* ------------------------- inbox (split-pane) ------------------------- */

  const selThread = effectiveSel?.kind === "thread" ? vActive.find((t) => t.session_id === effectiveSel.id) : undefined;
  const selRecent = effectiveSel?.kind === "recent" ? vRecent.find((t) => t.session_id === effectiveSel.id) : undefined;
  const selReq = effectiveSel?.kind === "req" ? vInbox.find((r) => r.id === effectiveSel.id) : undefined;

  const inboxPane = (
    <>
      <h1 className="ds-h1">Inbox</h1>
      <p className="ds-sub">Requests and replies from friends&apos; agents — async by default, so nobody has to stay online.</p>
      <div className="ds-split" id="compose">
        <div className="ds-split-list">
          <div className="ds-split-lhead">
            <button className="ds-btn" style={{ width: "100%" }} onClick={() => setInboxSel({ kind: "compose" })}>✎ New message</button>
          </div>
          <div className="ds-split-scroll">
            {vInbox.length > 0 && <div className="ds-lsec">Approvals</div>}
            {vInbox.map((r) => (
              <button key={r.id} className={`ds-litem${effectiveSel?.kind === "req" && effectiveSel.id === r.id ? " on" : ""}`} onClick={() => setInboxSel({ kind: "req", id: r.id })}>
                <PersonAvatar handle={r.requester_handle} size={34} />
                <span style={{ minWidth: 0 }}>
                  <span className="ds-lname">{shortHandle(r.requester_handle)} <Chip tone="warn">wants in</Chip></span>
                  <span className="ds-lsnip">{r.message ?? "Collaboration request"}</span>
                </span>
                <span className="ds-ltime">{agoShort(r.created_at)}</span>
              </button>
            ))}
            <div className="ds-lsec">Open threads{vActive.length ? ` (${vActive.length})` : ""}</div>
            {vActive.length === 0 && (
              <EmptyState icon="💬">Nothing yet. Start one above, or <button className="ds-link" onClick={() => setNav("friends")}>invite a friend →</button></EmptyState>
            )}
            {vActive.map((t) => {
              const tu = threadTurn(t);
              return (
                <button key={t.session_id} className={`ds-litem${effectiveSel?.kind === "thread" && effectiveSel.id === t.session_id ? " on" : ""}`} onClick={() => setInboxSel({ kind: "thread", id: t.session_id })}>
                  <PersonAvatar handle={t.peer_handle} size={34} />
                  <span style={{ minWidth: 0 }}>
                    <span className="ds-lname">{(t.unread_count ?? 0) > 0 && <span className="ds-dotu" />}{shortHandle(t.peer_handle)}{t.live && <Chip tone="ok">live</Chip>}</span>
                    <span className="ds-lsnip">{tu.key === "yours" ? "Replied — your turn. " : ""}{t.goal}</span>
                  </span>
                  <span className="ds-ltime">{agoShort(t.started_at)}</span>
                </button>
              );
            })}
            <div className="ds-lsec">Recent — 30 days</div>
            {vRecent.length === 0 && <p className="ds-fine" style={{ padding: "4px 10px" }}>Nothing in the last 30 days.</p>}
            {vRecent.map((t) => (
              <button key={t.session_id} className={`ds-litem${effectiveSel?.kind === "recent" && effectiveSel.id === t.session_id ? " on" : ""}`} style={{ opacity: 0.7 }} onClick={() => setInboxSel({ kind: "recent", id: t.session_id })}>
                <PersonAvatar handle={t.peer_handle} size={34} />
                <span style={{ minWidth: 0 }}>
                  <span className="ds-lname">{shortHandle(t.peer_handle)}</span>
                  <span className="ds-lsnip">{t.goal}</span>
                </span>
                <span className="ds-ltime">{t.ended_at ? agoShort(t.ended_at) : ""}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="ds-split-detail">
          {effectiveSel?.kind === "compose" && (
            <div className="ds-dbody" style={{ maxHeight: "none" }}>
              <Composer key={composerPrefill?.key ?? 0} prefill={composerPrefill} onSent={loadSessions} />
            </div>
          )}

          {selReq && (
            <>
              <div className="ds-dhead">
                <h2>{shortHandle(selReq.requester_handle)} wants to collaborate</h2>
                <div className="ds-dsub">{selReq.requester_handle} · {when(selReq.created_at)}</div>
              </div>
              <div className="ds-dbody">
                {selReq.message && <div className="ds-call" style={{ background: "#f8fafc", border: "1px solid var(--ds-line)", marginBottom: 14 }}>&ldquo;{selReq.message}&rdquo;</div>}
                <div className="ds-call acc" style={{ marginBottom: 16 }}>
                  <strong>They&apos;re asking to:</strong> {selReq.scopes.map(plainScope).join(", ")}. Approving opens a conversation in your Inbox — your agent still checks each requested action before doing real work.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="ds-btn" disabled={busy === `inbox:${selReq.id}` || demoMode} onClick={() => acceptInbox(selReq.id, selReq.requester_handle)}>{busy === `inbox:${selReq.id}` ? "…" : "Approve"}</button>
                  <button className="ds-btn ghost" disabled={busy === `inbox:${selReq.id}` || demoMode} onClick={() => rejectInbox(selReq.id)}>Decline</button>
                </div>
              </div>
            </>
          )}

          {selThread && (() => {
            const tu = threadTurn(selThread);
            return (
              <>
                <div className="ds-dhead">
                  <h2>{shortHandle(selThread.peer_handle)}</h2>
                  <div className="ds-dsub">{selThread.peer_handle} · via your agents · started {when(selThread.started_at)}{selThread.live && <> · <Chip tone="ok">● live</Chip></>}</div>
                </div>
                <div className="ds-dbody">
                  <div className={`ds-call ${tu.key === "yours" ? "acc" : tu.key === "connecting" ? "warn" : "ok"}`} style={{ marginBottom: 16 }}>
                    <strong>{tu.label}.</strong> {tu.next}
                  </div>
                  {selThread.goal && (
                    <div className="ds-call" style={{ background: "#f8fafc", border: "1px solid var(--ds-line)", marginBottom: 16 }}>
                      <span className="ds-imeta" style={{ display: "block", marginBottom: 3 }}>Topic</span>{selThread.goal}
                    </div>
                  )}

                  {kmOpen === selThread.session_id && !demoMode && me ? (
                    <KeyMirrorConversation
                      sessionId={selThread.session_id}
                      accountId={me.id}
                      peerHandle={selThread.peer_handle}
                      csrf={csrf()}
                      enrolled={!!me.key_mirror_enrolled}
                      displayName={me.display_name || me.handle}
                      onEnrolled={() => setMe((prev) => (prev ? { ...prev, key_mirror_enrolled: true } : prev))}
                    />
                  ) : (
                    <div className="ds-call" style={{ border: "1px dashed var(--ds-line)", background: "transparent", textAlign: "center", marginBottom: 16, color: "var(--ds-mut)" }}>
                      🔒 Messages are end-to-end encrypted — decrypt and read them right here in your browser.
                      <div style={{ marginTop: 10 }}>
                        <button className="ds-btn ghost" onClick={() => setKmOpen(kmOpen === selThread.session_id ? null : selThread.session_id)} disabled={demoMode}>
                          {demoMode ? "Unlock & read (sign in first)" : "Unlock & read"}
                        </button>
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                    {tu.key === "yours"
                      ? <button className="ds-btn" disabled={busy === `wp:${selThread.session_id}` || demoMode} onClick={() => getWakePrompt(selThread.session_id)}>{busy === `wp:${selThread.session_id}` ? "…" : "Respond via my agent"}</button>
                      : <button className="ds-btn ghost" disabled={busy === `wp:${selThread.session_id}` || demoMode} onClick={() => getWakePrompt(selThread.session_id)}>{busy === `wp:${selThread.session_id}` ? "…" : tu.key === "theirs" ? "🤝 Nudge" : "🤝 Wake my agent"}</button>}
                    <a className="ds-btn ghost" style={{ textDecoration: "none" }} href={`/sessions/${selThread.session_id}`}>Watch live</a>
                    <button className="ds-btn danger" disabled={busy === selThread.session_id || demoMode} onClick={() => endSession(selThread.session_id, selThread.peer_handle)}>{busy === selThread.session_id ? "…" : "End"}</button>
                  </div>
                  {wakePrompts[selThread.session_id] && (
                    <div className="ds-call acc" style={{ marginTop: 10 }}>
                      <p style={{ margin: "0 0 8px", fontWeight: 600 }}>📋 Paste this to your AI assistant to get it back into this session:</p>
                      <pre className="ds-pre">{wakePrompts[selThread.session_id]}</pre>
                      <button className="ds-btn" style={{ marginTop: 8 }} onClick={() => navigator.clipboard?.writeText(wakePrompts[selThread.session_id]).catch(() => {})}>Copy</button>
                    </div>
                  )}

                  <div style={{ marginTop: 20 }}>
                    <h3 className="ds-lsec" style={{ padding: "0 0 6px" }}>Context</h3>
                    <div className="ds-ctxrow"><span>Status</span><span>{tu.label}</span></div>
                    <div className="ds-ctxrow"><span>Friend since</span><span>{vTrust.find((f) => f.handle === selThread.peer_handle)?.mutual ? "mutual friends" : "not mutual yet"}</span></div>
                    <div className="ds-ctxrow"><span>Tools they share with you</span><span>{vShared.filter((t) => t.owner_handle === selThread.peer_handle).map((t) => t.name).join(", ") || "none"}</span></div>
                  </div>
                </div>
              </>
            );
          })()}

          {selRecent && (
            <>
              <div className="ds-dhead">
                <h2>{shortHandle(selRecent.peer_handle)}</h2>
                <div className="ds-dsub">{selRecent.peer_handle} · ended {selRecent.ended_at ? when(selRecent.ended_at) : ""} · {selRecent.duration_min ?? "?"} min · {selRecent.end_reason ?? "ended"}</div>
              </div>
              <div className="ds-dbody">
                {selRecent.goal && (
                  <div className="ds-call" style={{ background: "#f8fafc", border: "1px solid var(--ds-line)", marginBottom: 16 }}>
                    <span className="ds-imeta" style={{ display: "block", marginBottom: 3 }}>Topic</span>{selRecent.goal}
                  </div>
                )}
                <button className="ds-btn" onClick={() => askFriend(selRecent.peer_handle, "")} disabled={demoMode}>✎ Message {shortHandle(selRecent.peer_handle)} again</button>
              </div>
            </>
          )}

          {!effectiveSel && (
            <EmptyState icon="✉"><div style={{ paddingTop: 60 }}>Select a conversation to read it here.</div></EmptyState>
          )}
        </div>
      </div>
    </>
  );

  /* ------------------------------ friends ------------------------------ */

  const friendsPane = friendView ? (
    <FriendPage
      handle={friendView}
      trust={vTrust}
      active={vActive}
      recent={vRecent}
      discover={vDiscover}
      sharedWithMe={vShared}
      when={when}
      onBack={() => setFriendView(null)}
      onOpenThread={(sessionId) => { setFriendView(null); setNav("messages"); setInboxSel({ kind: "thread", id: sessionId }); setKmOpen(sessionId); }}
      onInviteToSomethingNew={() => { setFriendView(null); setFiErr(""); setFiOpen(true); }}
    />
  ) : (
    <>
      <h1 className="ds-h1">Friends</h1>
      <p className="ds-sub" title="Same as 'trusted peers' — friends are agents you've mutually trusted">
        People you&apos;ve worked with. Adding a friend lets their agent reach yours without a new invite code — you still approve each session.
      </p>

      <div id="friends-section" style={{ marginBottom: 14 }}>
        {fiSent ? (
          <div className="ds-call ok" style={{ marginBottom: 14 }}>
            <strong>✅ Invitation sent!</strong> We emailed them a link to set up Back Channel and connect with you. When they accept, you&apos;ll become friends automatically.{" "}
            <button className="ds-link" onClick={() => setFiSent(false)}>Invite another</button>
          </div>
        ) : fiOpen ? (
          <div className="ds-card" style={{ marginBottom: 14 }}>
            <h2 className="ds-cardh">Invite a friend</h2>
            <label className="ds-label">Your friend&apos;s email</label>
            <input className="ds-input" type="email" value={fiEmail} onChange={(e) => setFiEmail(e.target.value)} placeholder="friend@email.com" disabled={demoMode} />
            <label className="ds-label">A note (optional)</label>
            <input className="ds-input" value={fiNote} onChange={(e) => setFiNote(e.target.value)} placeholder="Let's connect our agents on Back Channel" disabled={demoMode} />
            {fiErr && <p className="ds-call danger" style={{ marginTop: 10 }}>{fiErr}</p>}
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button className="ds-btn" disabled={busy === "friendinvite" || demoMode} onClick={inviteFriend}>{busy === "friendinvite" ? "Sending…" : "Send invite"}</button>
              <button className="ds-btn ghost" onClick={() => { setFiOpen(false); setFiErr(""); }}>Cancel</button>
            </div>
          </div>
        ) : null}
      </div>

      {vTrust.length === 0 && !fiOpen && !fiSent ? (
        <div className="ds-card">
          <EmptyState icon="👋">
            No friends yet. Invite someone by email — when they accept, your agents can reach each other without invite codes (you still approve every session).
            <div style={{ marginTop: 12 }}><button className="ds-btn" onClick={() => { setFiErr(""); setFiOpen(true); }}>Invite a friend</button></div>
          </EmptyState>
        </div>
      ) : (
        <div className="ds-people">
          {vTrust.map((f) => (
            <div className="ds-card" key={f.handle} style={{ textAlign: "center" }}>
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}><PersonAvatar handle={f.handle} size={52} /></div>
              <button className="ds-iname" style={{ fontSize: 15, background: "none", border: "none", cursor: "pointer", padding: 0, font: "inherit", fontWeight: 600 }} title="Open this friend's agent page" onClick={() => openFriend(f.handle)}>
                {shortHandle(f.handle)}
              </button>
              <div style={{ margin: "6px 0 8px" }}>
                {f.trusted ? (f.mutual ? <Chip tone="ok">mutual</Chip> : <Chip tone="warn">waiting for them</Chip>) : <Chip>not trusted</Chip>}
              </div>
              <div className="ds-imeta" style={{ marginBottom: 12 }}>{f.last_session_at ? `last worked together ${when(f.last_session_at)}` : "no sessions yet"}</div>
              {f.trusted && f.mutual ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <button className="ds-btn" onClick={() => askFriend(f.handle, "")} disabled={demoMode}>💬 Message</button>
                  <button className="ds-btn ghost" onClick={() => openFriend(f.handle)}>View agent page</button>
                </div>
              ) : (
                <button className={f.trusted ? "ds-btn danger" : "ds-btn"} style={{ width: "100%" }} disabled={busy === `trust:${f.handle}` || demoMode} onClick={() => toggleTrust(f.handle, !f.trusted)}>
                  {busy === `trust:${f.handle}` ? "…" : f.trusted ? "Remove" : "Add as a friend"}
                </button>
              )}
              {f.trusted && f.mutual && (
                <button className="ds-link" style={{ marginTop: 8 }} disabled={busy === `trust:${f.handle}` || demoMode} onClick={() => toggleTrust(f.handle, false)}>Remove friend</button>
              )}
            </div>
          ))}
          <div className="ds-card" style={{ textAlign: "center", display: "flex", flexDirection: "column", justifyContent: "center", borderStyle: "dashed", minHeight: 180 }}>
            <div style={{ fontSize: 26, marginBottom: 8, color: "var(--ds-faint)" }}>＋</div>
            <button className="ds-btn ghost" onClick={() => { setFiErr(""); setFiOpen(true); }}>Invite a friend</button>
          </div>
        </div>
      )}
      <p className="ds-fine" style={{ marginTop: 14 }}>Requests from friends appear on <button className="ds-link" onClick={() => setNav("overview")}>Overview</button> and in your <button className="ds-link" onClick={() => setNav("messages")}>Inbox</button> as items needing approval. Mutual friends&apos; agents can also be reached by asking your assistant: &ldquo;use Back Channel to reach &lt;name&gt;&rdquo;.</p>
    </>
  );

  /* ------------------------------ toolkit ------------------------------ */

  const toolkitPane = (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 className="ds-h1">Toolkit</h1>
          <p className="ds-sub">The useful things your agent can reuse: tools it knows how to run, scheduled checks, and saved prompts. Share privately with a friend, make one visible to your circle, or create a link anyone can add to their own agent.</p>
        </div>
        <button className="ds-btn" onClick={() => setEditor({ mode: "create" })} disabled={demoMode}>＋ New toolkit item</button>
      </div>

      {libFlash && <div className="ds-call ok" style={{ marginBottom: 14 }}>✅ {libFlash}</div>}

      <div className="ds-card" id="skills-section" style={{ marginBottom: 14 }}>
        <h2 className="ds-cardh">Yours{vSkills.length ? ` (${vSkills.length})` : ""}</h2>
        {vSkills.length === 0 && (
          <EmptyState icon="📚">Nothing in your Toolkit yet. Your agent can save tools, scheduled checks, and prompts here — then share them with a friend, your circle, or anyone through a link.</EmptyState>
        )}
        {vSkills.map((sk) => {
          const trustedHandles = vTrust.filter((t) => t.trusted).map((t) => t.handle);
          const type = sk.type || "skill";
          const badge = type === "scheduled_task" ? { icon: "⏰", label: "Scheduled check" } : type === "prompt" ? { icon: "💬", label: "Saved prompt" } : type === "link" ? { icon: "↗", label: "Link" } : { icon: "📜", label: "Tool" };
          const linkManifest = type === "link" ? (sk.manifest ?? {}) as Record<string, unknown> : null;
          const linkUrl = linkManifest && typeof linkManifest.url === "string" ? linkManifest.url : "";
          const linkSource = linkManifest && typeof linkManifest.source === "string" ? linkManifest.source : "web";
          // public-share eligibility mirrors the server gates (spec §3) so the UI explains the block.
          const isRpc = type === "skill" && sk.kind === "rpc";
          const schedOptIn = type !== "scheduled_task" || sk.manifest?.public_share_allowed === true;
          const isSigned = sk.signed !== false; // older rows may omit the flag; don't over-block
          const canPublic = !isRpc && schedOptIn && isSigned;
          const blockReason = isRpc ? "This tool runs from your friend's agent during a conversation, so it can't be shared by public link." : !schedOptIn ? "This scheduled check isn't marked shareable yet. Your agent needs to save it as public-share allowed before you can make a public link." : !isSigned ? "This item needs your agent's signature before it can be shared publicly (your agent signs what it saves)." : "";
          const link = sk.public_token ? `https://back-channel.app/a/${sk.public_token}` : null;
          return (
            <div className="ds-item" key={sk.id}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="ds-iname">
                  {sk.name} <Chip>{badge.icon} {badge.label}</Chip>
                  {type === "skill" && <> <Chip>{plainKind(sk.kind)}</Chip></>}
                  {type === "link" && <> <span className="ds-imeta">{cleanDomain(linkUrl)} · {LINK_SOURCE_LABEL[linkSource] ?? "Web"}</span> <Chip tone="warn" title={LINK_HUMAN_WARNING}>↗ {LINK_BADGE_TEXT}</Chip></>}
                </div>
                {sk.description && <div className="ds-igoal">{sk.description}</div>}
                <div className="ds-imeta">{sk.shared_with.length ? <>shared with: {sk.shared_with.map(shortHandle).join(", ")}</> : "private"}</div>

                {trustedHandles.length > 0 && (
                  <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {trustedHandles.map((h) => {
                      const on = sk.shared_with.includes(h);
                      return (
                        <button key={h} className={on ? "ds-btn" : "ds-btn ghost"} style={{ fontSize: 12, padding: "4px 10px" }} disabled={busy === `skill:${sk.id}:${h}` || demoMode}
                          onClick={() => { if (type === "link" && !on) { setLinkWarnFor({ id: sk.id, action: `share:${h}` }); return; } shareSkill(sk.id, h, !on); }}>
                          {on ? `✓ ${shortHandle(h)}` : `share with ${shortHandle(h)}`}
                        </button>
                      );
                    })}
                    {type === "link" && linkWarnFor?.id === sk.id && linkWarnFor.action.startsWith("share:") &&
                      linkWarnBox(() => { const h = linkWarnFor.action.slice("share:".length); setLinkWarnFor(null); shareSkill(sk.id, h, true); }, "I understand, share it")}
                  </div>
                )}

                <label className="ds-imeta" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={sk.discoverable} disabled={busy === `disc:${sk.id}` || demoMode} onChange={() => toggleDiscoverable(sk.id, !sk.discoverable)} />
                  🌐 Let friends find this by name (they still need you to share it to use it)
                </label>

                {/* Inline public-share panel */}
                <div className="ds-call acc" style={{ marginTop: 10, padding: "10px 12px" }}>
                  {link ? (
                    <div>
                      <div className="ds-imeta" style={{ marginBottom: 6 }}>🔗 Public link active{sk.public_expires_at ? ` · expires ${new Date(sk.public_expires_at).toLocaleDateString()}` : " · never expires"}</div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <code className="ds-mono" style={{ flex: "1 1 240px", fontSize: 12, wordBreak: "break-all", background: "rgba(0,0,0,0.05)", padding: "4px 8px", borderRadius: 6 }}>{link}</code>
                        <button className="ds-btn" style={{ fontSize: 12, padding: "5px 10px" }} onClick={() => { if (type === "link" && linkWarnFor?.id !== sk.id) { setLinkWarnFor({ id: sk.id, action: "copy" }); return; } navigator.clipboard.writeText(`Add this to my agent: ${link}`); setPubCopiedId(sk.id); setLinkWarnFor(null); setTimeout(() => setPubCopiedId(null), 1500); }}>{pubCopiedId === sk.id ? "Copied ✓" : "Copy add-to-agent note"}</button>
                        <button className="ds-btn ghost" style={{ fontSize: 12, padding: "5px 10px" }} disabled={busy === `pub:${sk.id}` || demoMode} onClick={() => publicRevoke(sk.id)}>Revoke</button>
                      </div>
                      {type === "link" && linkWarnFor?.id === sk.id && linkWarnFor.action === "copy" &&
                        linkWarnBox(() => { navigator.clipboard.writeText(`Add this to my agent: ${link}`); setPubCopiedId(sk.id); setLinkWarnFor(null); setTimeout(() => setPubCopiedId(null), 1500); }, "I understand, copy it")}
                    </div>
                  ) : canPublic ? (
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span className="ds-imeta">🌍 Public link:</span>
                      <select className="ds-select" style={{ fontSize: 12.5, padding: "4px 8px" }} value={pubTtl[sk.id] ?? "7d"} onChange={(e) => setPubTtl((mp) => ({ ...mp, [sk.id]: e.target.value }))}>
                        <option value="24h">expires in 24h</option>
                        <option value="7d">expires in 7 days</option>
                        <option value="30d">expires in 30 days</option>
                        <option value="never">never expires</option>
                      </select>
                      <button className="ds-btn" style={{ fontSize: 12, padding: "5px 10px" }} disabled={busy === `pub:${sk.id}` || demoMode} onClick={() => { if (type === "link") { setLinkWarnFor({ id: sk.id, action: "public" }); return; } publicShare(sk.id, pubTtl[sk.id] ?? "7d"); }}>Generate public link</button>
                      {type === "link" && linkWarnFor?.id === sk.id && linkWarnFor.action === "public" &&
                        linkWarnBox(() => { setLinkWarnFor(null); publicShare(sk.id, pubTtl[sk.id] ?? "7d"); }, "I understand, make it public")}
                    </div>
                  ) : (
                    <div className="ds-imeta">🔒 {blockReason}</div>
                  )}
                </div>
              </div>
              <div className="ds-iright" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <button className="ds-btn ghost" style={{ fontSize: 12 }} onClick={() => setInspect({ id: sk.id, name: sk.name, description: sk.description, kind: sk.kind, type: sk.type, manifest: sk.manifest, body: sk.body })}>View</button>
                <button className="ds-btn ghost" style={{ fontSize: 12 }} disabled={demoMode} onClick={() => setEditor({ mode: "edit", initial: { id: sk.id, name: sk.name, description: sk.description, kind: sk.kind, type: sk.type, manifest: sk.manifest, body: sk.body } })}>Edit</button>
                <button className="ds-btn danger" style={{ fontSize: 12 }} disabled={busy === `skilldel:${sk.id}` || demoMode} onClick={() => deleteSkill(sk.id, sk.name)}>Delete</button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="ds-grid">
        {vShared.length > 0 && (
          <div className="ds-card">
            <h2 className="ds-cardh">🎁 Shared with you</h2>
            <p className="ds-cardsub">A <strong>copyable tool</strong> gets added to your own agent with &ldquo;Send to my agent.&rdquo; A <strong>friend-run tool</strong> stays on their side — &ldquo;Ask their agent&rdquo; starts an Inbox conversation to use it.</p>
            {vShared.map((sk) => {
              const isTemplate = sk.kind === "template";
              const isLink = (sk.type || "skill") === "link";
              return (
                <div key={sk.id}>
                  <div className="ds-item">
                    <span aria-hidden style={{ fontSize: 18, flexShrink: 0 }}>{isLink ? "↗" : isTemplate ? "🧩" : "⚡"}</span>
                    <div style={{ minWidth: 0 }}>
                      <div className="ds-iname">{sk.name}{isLink && <> <Chip tone="warn" title={LINK_HUMAN_WARNING}>↗ {LINK_BADGE_TEXT}</Chip></>}</div>
                      {sk.description && <div className="ds-igoal">{sk.description}</div>}
                      <div className="ds-imeta">Shared by <strong>{shortHandle(sk.owner_handle)}&rsquo;s agent</strong> ({sk.owner_handle})</div>
                    </div>
                    <div className="ds-iright">
                      {isTemplate
                        ? (sentToAgent[sk.id]
                            ? <Chip tone="ok">✓ sent to your agent</Chip>
                            : <button className="ds-btn" disabled={busy === `send:${sk.id}` || demoMode} onClick={() => { if (isLink && linkWarnFor?.id !== sk.id) { setLinkWarnFor({ id: sk.id, action: "send" }); return; } setLinkWarnFor(null); sendToMyAgent(sk); }}>{busy === `send:${sk.id}` ? "…" : "Send to my agent"}</button>)
                        : <button className="ds-btn ghost" disabled={demoMode} onClick={() => askFriend(sk.owner_handle, `use your “${sk.name}” tool: `)}>Ask their agent</button>}
                    </div>
                  </div>
                  {isLink && linkWarnFor?.id === sk.id && linkWarnFor.action === "send" &&
                    linkWarnBox(() => { setLinkWarnFor(null); sendToMyAgent(sk); }, "I understand, send it")}
                  {installPrompt[sk.id] && (
                    <div className="ds-call acc" style={{ marginBottom: 10 }}>
                      <p style={{ margin: "0 0 8px", fontWeight: 600 }}>✅ Queued in your Inbox — your agent picks this up on its next check (~10 min). Don&apos;t want to wait? Paste this into your agent to add it now:</p>
                      <pre className="ds-pre">{installPrompt[sk.id]}</pre>
                      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button className="ds-btn" onClick={() => { navigator.clipboard?.writeText(installPrompt[sk.id]).catch(() => {}); setInstallCopiedId(sk.id); setTimeout(() => setInstallCopiedId(null), 1500); }}>{installCopiedId === sk.id ? "✓ Copied" : "Copy prompt"}</button>
                        <button className="ds-btn ghost" onClick={() => setInstallPrompt((mp) => { const n = { ...mp }; delete n[sk.id]; return n; })}>Done</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {vDiscover.length > 0 && (
          <div className="ds-card">
            <h2 className="ds-cardh">✨ In your circle</h2>
            <p className="ds-cardsub">Useful things your friends&rsquo; agents can do. Ask a friend to share one and it shows up under &ldquo;Shared with you.&rdquo;</p>
            {Object.entries(vDiscover.reduce<Record<string, DiscoverSkill[]>>((acc, d) => { (acc[d.owner_handle] ??= []).push(d); return acc; }, {})).map(([owner, items]) => (
              <div key={owner} style={{ marginTop: 10 }}>
                <p className="ds-imeta" style={{ margin: "0 0 2px" }}><strong style={{ color: "var(--ds-ink)" }}>{shortHandle(owner)}&rsquo;s agent</strong> has {items.length} tool{items.length === 1 ? "" : "s"} you can use</p>
                {items.map((d) => {
                  const isTemplate = d.kind === "template";
                  const isLink = (d.type || "skill") === "link";
                  return (
                    <div key={d.id} className="ds-item">
                      <span aria-hidden style={{ fontSize: 16, flexShrink: 0 }}>{isLink ? "↗" : isTemplate ? "🧩" : "⚡"}</span>
                      <div style={{ minWidth: 0 }}>
                        <div className="ds-iname" style={{ fontSize: 13 }}>{d.name}{isLink && <> <Chip tone="warn" title={LINK_HUMAN_WARNING}>↗ {LINK_BADGE_TEXT}</Chip></>}</div>
                        {d.description && <div className="ds-igoal">{d.description}</div>}
                      </div>
                      <div className="ds-iright">
                        <button className="ds-btn ghost" style={{ fontSize: 12 }} disabled={demoMode} onClick={() => askFriend(d.owner_handle, isTemplate ? `share your “${d.name}” tool with me` : `use your “${d.name}” tool: `)}>{isTemplate ? "Ask to share" : "Ask their agent"}</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );

  /* ------------------------------- agents ------------------------------- */

  const agentsPane = (
    <>
      <h1 className="ds-h1">Agents</h1>
      <p className="ds-sub">Every assistant connected to your account has its own key — revoke any one without affecting the others.</p>

      <div className="ds-card" style={{ marginBottom: 14 }}>
        <h2 className="ds-cardh">Registered agents{vAgents.length ? ` (${vAgents.length})` : ""}</h2>
        {vAgents.length === 0 && (
          <EmptyState icon="🤖">No agents connected yet. Connect an AI assistant below and it gets its own key.</EmptyState>
        )}
        {vAgents.map((a) => {
          const h = agentHealth(a.last_used_at);
          const cold = h.key === "stale" || h.key === "sleeping";
          return (
            <div className="ds-item" key={a.id}>
              <HealthDot color={h.color} label={h.label} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="ds-iname">{a.name} <Chip tone={h.key === "active" ? "ok" : cold ? "warn" : undefined}>{h.label}</Chip> <Chip>{RUNTIME_LABEL[a.runtime_type] ?? a.runtime_type}</Chip></div>
                <div className="ds-imeta">added {when(a.created_at)} · {a.last_used_at ? `last heard from ${when(a.last_used_at)}` : "never used yet"}</div>
                {cold && <div className="ds-call warn" style={{ marginTop: 8, padding: "8px 12px", fontSize: 12.5 }}>This agent hasn&apos;t been heard from in a while. If you expect it running, its runtime may have lost its own login — see the FAQ.</div>}
                {agentCheck[a.id] && <div className="ds-call" style={{ marginTop: 8, padding: "8px 12px", fontSize: 12.5, background: "#f8fafc", border: "1px solid var(--ds-line)" }}>{agentCheck[a.id]}</div>}
              </div>
              <div className="ds-iright">
                <button className="ds-link" disabled={busy === `check:${a.id}` || demoMode} onClick={() => checkAgent(a)}>{busy === `check:${a.id}` ? "checking…" : "Check status"}</button>
                {cold && <button className="ds-link" disabled={busy === `reconnect:${a.id}` || demoMode} onClick={() => reconnectAgent(a)}>{busy === `reconnect:${a.id}` ? "…" : "Reconnect"}</button>}
                <button className="ds-link" disabled={busy === `rename:${a.id}` || demoMode} onClick={() => renameAgent(a.id, a.name)}>Rename</button>
                <button className="ds-btn danger" style={{ fontSize: 12, padding: "5px 10px" }} disabled={busy === `revoke:${a.id}` || demoMode} onClick={() => revokeAgent(a.id, a.name)}>{busy === `revoke:${a.id}` ? "…" : "Revoke"}</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Connect a new agent — PRIMARY: MCP connector. You set it up in your client's
          own settings; the agent is never asked to run anything to establish trust. */}
      <div className="ds-card" id="connect-agent">
        <h2 className="ds-cardh">Connect a new agent</h2>
        <p className="ds-cardsub">Back Channel is an <strong>MCP connector</strong>: generate a token, add it in your AI client&apos;s settings, done. Nothing gets pasted into a chat, and your agent never has to run install commands.</p>
        {mcpErr && <p className="ds-call danger" style={{ marginBottom: 12 }}>⚠ {mcpErr}</p>}
        {mcpToken ? (() => {
          const mcpUrl = `${typeof window !== "undefined" ? window.location.origin : "https://back-channel.app"}/api/mcp`;
          const copyBtn = (id: string, text: string, label = "Copy") => (
            <button className="ds-btn" style={{ fontSize: 12.5 }} onClick={() => { navigator.clipboard?.writeText(text).catch(() => {}); setMcpCopied(id); setTimeout(() => setMcpCopied(""), 1500); }}>{mcpCopied === id ? "✓ Copied" : label}</button>
          );
          const ccCmd = `claude mcp add --transport http back-channel ${mcpUrl} --header "Authorization: Bearer ${mcpToken}" --scope user`;
          const codexEnv = mcpOs === "windows" ? `setx BACKCHANNEL_TOKEN "${mcpToken}"` : `echo 'export BACKCHANNEL_TOKEN="${mcpToken}"' >> ~/.zshrc && source ~/.zshrc`;
          const codexToml = `[mcp_servers.back_channel]\nurl = "${mcpUrl}"\nbearer_token_env_var = "BACKCHANNEL_TOKEN"`;
          return (
            <div className="ds-call acc">
              <p style={{ margin: "0 0 8px", fontWeight: 600 }}>🔑 Your agent token — copy it now, it won&apos;t be shown again:</p>
              <pre className="ds-pre" style={{ marginBottom: 8 }}>{mcpToken}</pre>
              <div style={{ margin: "0 0 14px" }}>{copyBtn("tok", mcpToken)}</div>
              {mcpClient === "claude_desktop" && (
                <ol style={{ margin: "0 0 12px", paddingLeft: 20, fontSize: 13.5, lineHeight: 1.7 }}>
                  <li><a href="/back-channel.mcpb" download style={{ color: "var(--ds-acc)", fontWeight: 600 }}>Download the Back Channel extension</a> (.mcpb file).</li>
                  <li>Double-click the downloaded file — Claude Desktop opens an install dialog. Click <strong>Install</strong>.</li>
                  <li>Paste the token above into the <strong>Back Channel agent token</strong> field and save. (Setting up on another machine? Use the &ldquo;Legacy &amp; advanced&rdquo; connect code below instead — a <code>BCX-…</code> code works in that same field and the extension redeems it for you.)</li>
                </ol>
              )}
              {mcpClient === "claude_code" && (
                <div style={{ marginBottom: 12 }}>
                  <p className="ds-cardsub" style={{ marginBottom: 6 }}>Run this once in any terminal (connects Claude Code account-wide):</p>
                  <pre className="ds-pre">{ccCmd}</pre>
                  <div style={{ marginTop: 6 }}>{copyBtn("cc", ccCmd, "Copy command")}</div>
                </div>
              )}
              {mcpClient === "codex" && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <button className={mcpOs === "windows" ? "ds-btn" : "ds-btn ghost"} style={{ fontSize: 12 }} onClick={() => setMcpOs("windows")}>Windows</button>
                    <button className={mcpOs === "mac" ? "ds-btn" : "ds-btn ghost"} style={{ fontSize: 12 }} onClick={() => setMcpOs("mac")}>Mac / Linux</button>
                  </div>
                  <p className="ds-cardsub" style={{ marginBottom: 6 }}>1. Store the token in an environment variable{mcpOs === "windows" ? " (then open a NEW terminal)" : ""}:</p>
                  <pre className="ds-pre">{codexEnv}</pre>
                  <div style={{ margin: "6px 0 10px" }}>{copyBtn("cxe", codexEnv)}</div>
                  <p className="ds-cardsub" style={{ marginBottom: 6 }}>2. Add this to <code>~/.codex/config.toml</code> (token stays in the env var, never in the file):</p>
                  <pre className="ds-pre">{codexToml}</pre>
                  <div style={{ marginTop: 6 }}>{copyBtn("cxt", codexToml)}</div>
                </div>
              )}
              {mcpClient === "other" && (
                <div style={{ marginBottom: 12 }}>
                  <p className="ds-cardsub" style={{ marginBottom: 6 }}>Point any MCP client that supports <strong>remote HTTP servers with custom headers</strong> at:</p>
                  <pre className="ds-pre">{`URL:    ${mcpUrl}\nHeader: Authorization: Bearer ${mcpToken}`}</pre>
                  <div style={{ marginTop: 6 }}>{copyBtn("oth", `${mcpUrl}\nAuthorization: Bearer ${mcpToken}`)}</div>
                  <p className="ds-fine" style={{ marginTop: 8 }}>Note: claude.ai&apos;s built-in &ldquo;Connectors&rdquo; directory needs OAuth and won&apos;t take a bearer token — use Claude Desktop with our extension instead.</p>
                </div>
              )}
              <p className="ds-fine">✅ <strong>Verify:</strong> open a fresh chat and ask <em>&ldquo;What Back Channel tools do you have?&rdquo;</em> — you should see bc_check_inbox and friends.</p>
              <div style={{ marginTop: 10 }}>
                <button className="ds-btn ghost" onClick={() => { setMcpToken(null); setMcpCopied(""); }}>Done — hide token</button>
              </div>
            </div>
          );
        })() : agentFormOpen ? (
          <div>
            <label className="ds-label">Which client are you connecting?</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
              {(["claude_desktop", "claude_code", "codex", "other"] as const).map((c) => (
                <button key={c} className={mcpClient === c ? "ds-btn" : "ds-btn ghost"} style={{ fontSize: 12.5 }} onClick={() => setMcpClient(c)}>{MCP_CLIENT_LABEL[c]}</button>
              ))}
            </div>
            <label className="ds-label">Name it (so you can tell your agents apart later)</label>
            <input className="ds-input" value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder={`e.g. ${MCP_CLIENT_LABEL[mcpClient]} on my laptop`} />
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button className="ds-btn" disabled={busy === "mcp-mint" || demoMode} onClick={mintMcpToken}>{busy === "mcp-mint" ? "…" : "Generate token →"}</button>
              <button className="ds-btn ghost" onClick={() => setAgentFormOpen(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="ds-btn" onClick={() => { setAgentName(""); setMcpClient("claude_desktop"); setAgentFormOpen(true); }}>Connect a new agent</button>
        )}

        {/* LEGACY — exchange-code / paste-in flow, for runtimes without MCP. */}
        <div style={{ marginTop: 16, borderTop: "1px dashed var(--ds-line)", paddingTop: 12 }}>
          {!legacyOpen ? (
            <button className="ds-link" onClick={() => setLegacyOpen(true)}>Legacy &amp; advanced: connect with a paste-in code (agents without MCP) or the raw key</button>
          ) : (<>
            <p className="ds-cardsub"><strong>Legacy connect</strong> — paste a one-time code into any AI assistant and it connects itself. Use this only for runtimes that can&apos;t add an MCP server. <button className="ds-link" onClick={() => setLegacyOpen(false)}>Hide</button></p>
            {exErr && <p className="ds-call danger" style={{ marginBottom: 12 }}>⚠ {exErr}</p>}
            {exCode ? (
              connectTrack === "guided" ? (() => {
                // Track B — two low-stakes pastes. Step 1 is a pure read; Step 2 is one POST.
                const step1 = `Load the Back Channel skill from https://back-channel.app/skill so you know the protocol — it self-describes its provenance (source/author/license in the frontmatter) so you can verify what it is. Do NOT install any recurring job or take any action yet; I'll give you a connect code in a moment.`;
                const step2 = `Redeem Back Channel exchange code ${exCode}: POST it to https://back-channel.app/api/auth/exchange and store the returned key in your secret store as BC_AUTH_TOKEN. Don't install any scheduled inbox check — I'll opt in from the dashboard if I want it. Then tell me you're connected.`;
                const copyBlock = (id: string, label: string, text: string) => (
                  <div key={id} style={{ marginBottom: 14 }}>
                    <p style={{ margin: "0 0 6px", fontWeight: 600, fontSize: 13 }}>{label}</p>
                    <pre className="ds-pre">{text}</pre>
                    <button className="ds-btn" style={{ marginTop: 6, fontSize: 12.5 }} onClick={() => { navigator.clipboard?.writeText(text).catch(() => {}); setCopiedStep(id); setTimeout(() => setCopiedStep(""), 1500); }}>{copiedStep === id ? "✓ Copied" : "Copy"}</button>
                  </div>
                );
                return (
                  <div className="ds-call acc">
                    <p className="ds-cardsub" style={{ marginTop: 0 }}>Guided connect — paste these to your assistant one at a time. The code is <strong>good for 15 minutes</strong>.</p>
                    {copyBlock("s1", "Step 1 — paste this first (read-only, no commitments):", step1)}
                    {copyBlock("s2", "Step 2 — once it confirms it read the skill, paste this:", step2)}
                    <button className="ds-btn ghost" onClick={() => { setExCode(null); setExPrompt(""); }}>Done</button>
                  </div>
                );
              })() : (
                <div className="ds-call acc">
                  <p style={{ margin: "0 0 8px", fontWeight: 600 }}>📋 Paste this to your assistant — <strong>good for 15 minutes</strong>, get a fresh one anytime.</p>
                  <pre className="ds-pre">{exPrompt}</pre>
                  <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                    <button className="ds-btn" onClick={() => { navigator.clipboard?.writeText(exPrompt).catch(() => {}); setExCopied(true); setTimeout(() => setExCopied(false), 1500); }}>{exCopied ? "✓ Copied" : "Copy"}</button>
                    <button className="ds-btn ghost" onClick={() => { setExCode(null); setExPrompt(""); }}>Done</button>
                  </div>
                </div>
              )
            ) : legacyFormOpen ? (
              <div>
                <label className="ds-label">What&apos;s this agent? (so you can tell them apart later)</label>
                <input className="ds-input" value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="e.g. my laptop, Codex at work, ChatGPT on phone" />
                <label className="ds-label">Where does it run?</label>
                <select className="ds-select" value={agentRuntime} onChange={(e) => setAgentRuntime(e.target.value)}>
                  {RUNTIME_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                {CHAT_TAB_RUNTIMES.includes(agentRuntime) && (
                  <p className="ds-call warn" style={{ marginTop: 10 }}>
                    ⚠ A web/chat tab can <strong>read toolkit items</strong> but can&apos;t connect an account (it can&apos;t make the needed request). To connect, switch to <strong>Claude Code, Cowork, or Codex</strong> — then come back here.
                  </p>
                )}
                <label className="ds-label">How do you want to connect?</label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className={connectTrack === "guided" ? "ds-btn" : "ds-btn ghost"} style={{ fontSize: 12.5 }} onClick={() => setConnectTrack("guided")}>Guided (two pastes) — recommended</button>
                  <button className={connectTrack === "quick" ? "ds-btn" : "ds-btn ghost"} style={{ fontSize: 12.5 }} onClick={() => setConnectTrack("quick")}>Quick (one paste)</button>
                </div>
                <p className="ds-fine" style={{ marginTop: 6 }}>{connectTrack === "guided" ? "You walk your agent through it in two small steps — works with any assistant that can connect, and a cautious agent is happiest with it." : "Your agent does the whole setup from one paste. Best on local runtimes (Cowork, Codex, Claude Code)."}</p>
                <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                  <button className="ds-btn" disabled={busy === "exchange" || demoMode} onClick={connectNewAgent}>{busy === "exchange" ? "…" : "Get connect code →"}</button>
                  <button className="ds-btn ghost" onClick={() => setLegacyFormOpen(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="ds-btn ghost" onClick={() => { setAgentName(""); setAgentRuntime("other"); setConnectTrack("guided"); setLegacyFormOpen(true); }}>Connect with a code</button>
            )}
            {/* Power-user escape hatch: reveal the raw key for manual scripting. */}
            <div style={{ marginTop: 10 }}>
              {!showRaw ? (
                <button className="ds-link" onClick={() => setShowRaw(true)}>Why would I need my raw key?</button>
              ) : bootstrap ? (
                <div className="ds-call acc" style={{ marginTop: 8 }}>
                  <p style={{ margin: "0 0 8px", fontWeight: 600 }}>📋 Setup prompt with your full API key — hides in 30s. Prefer the code above; use this only to script the key by hand.</p>
                  <pre className="ds-pre">{bootstrap}</pre>
                  <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                    <button className="ds-btn" onClick={() => { navigator.clipboard?.writeText(bootstrap).catch(() => {}); setBootstrapCopied(true); setTimeout(() => setBootstrapCopied(false), 1500); }}>{bootstrapCopied ? "✓ Copied" : "Copy"}</button>
                    <button className="ds-btn ghost" onClick={() => { setBootstrap(null); setBootstrapCopied(false); }}>Hide</button>
                  </div>
                </div>
              ) : (
                <p className="ds-fine">The code above is the safe way to connect an agent — the key stays out of your chat. If you&apos;re scripting against the API by hand and want the raw key, <button className="ds-link" onClick={revealBootstrap} disabled={busy === "bootstrap" || demoMode}>{busy === "bootstrap" ? "loading…" : "reveal it"}</button> (shown briefly, then hidden).</p>
              )}
            </div>
          </>)}
        </div>
      </div>
    </>
  );

  /* ------------------------------ settings ------------------------------ */

  const settingsPane = (
    <>
      <h1 className="ds-h1">Settings</h1>
      <p className="ds-sub">Signed in as <strong>{m.handle}</strong> ({m.email}) · <button className="ds-link" onClick={signOut} disabled={demoMode}>Sign out</button></p>

      <div className="ds-card" style={{ marginBottom: 14 }}>
        <h2 className="ds-cardh">Notifications &amp; cadence</h2>
        <div className="ds-item" style={{ alignItems: "center" }}>
          <input type="checkbox" checked={notify} onChange={toggleNotify} disabled={busy === "notify" || demoMode} id="set-notify" />
          <label htmlFor="set-notify" style={{ fontSize: 13.5, cursor: "pointer" }}>Email me when something lands in my Inbox and my agent is asleep <span className="ds-fine">(text + browser notifications are coming later)</span></label>
        </div>
        <div className="ds-item" style={{ alignItems: "center" }}>
          <input type="checkbox" checked={inboxEnabled} onChange={toggleInboxCheck} disabled={busy === "inboxchk" || demoMode} id="set-inboxchk" />
          <label htmlFor="set-inboxchk" style={{ fontSize: 13.5, cursor: "pointer" }}>Let my agent auto-check my Back Channel Inbox</label>
        </div>
        <div className="ds-item">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="ds-iname">How often it checks</div>
            <div className="ds-igoal">Your agent looks for new Inbox items on this schedule (a light check that only does real work when something arrived). Less often = lower usage. Takes effect next time your agent checks in.</div>
          </div>
          <div className="ds-iright">
            <select className="ds-select" value={inboxMinutes} disabled={busy === "inboxmin" || !inboxEnabled || demoMode} onChange={(e) => saveInboxMinutes(Number(e.target.value))}>
              <option value={5}>Every 5 min</option><option value={10}>Every 10 min</option>
              <option value={30}>Every 30 min</option><option value={60}>Every hour</option>
            </select>
          </div>
        </div>
        <div className="ds-item">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="ds-iname">Live mode default</div>
            <div className="ds-igoal">Most threads run async (cheap — your agent checks every ~10 min). Turning on &ldquo;live&rdquo; for a thread makes both agents respond in near-real-time for a short window; it uses much more of your plan. This is how long a live window lasts by default.</div>
          </div>
          <div className="ds-iright">
            <select className="ds-select" value={liveDefault} disabled={busy === "live" || demoMode} onChange={(e) => saveLiveDefault(Number(e.target.value))}>
              <option value={5}>5 minutes</option><option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option><option value={60}>60 minutes</option>
            </select>
          </div>
        </div>
        {typeof m.favor_per_peer_daily === "number" && (
          <p className="ds-fine" style={{ marginTop: 10 }}>Favor limits: up to <strong>{m.favor_per_peer_daily}</strong> favors/day per friend, and <strong>{m.favor_global_tokens_daily?.toLocaleString()}</strong> tokens/day of your compute total. (Your agent enforces these when a friend asks it to do a task.)</p>
        )}
      </div>

      {/* Browser access (key mirror) — global enroll/devices entry point (QA H2) */}
      <div className="ds-card" style={{ marginBottom: 14 }}>
        <h2 className="ds-cardh">Browser access</h2>
        <p className="ds-cardsub">Read &amp; reply to your conversations from this site — decrypted locally in your browser, never on our servers.</p>
        {demoMode ? <p className="ds-fine">Sign in to manage browser access.</p> : me && (
          <BrowserAccessSettings
            accountId={me.id}
            csrf={csrf()}
            enrolled={!!me.key_mirror_enrolled}
            displayName={me.display_name || me.handle}
            onEnrolled={() => setMe((prev) => (prev ? { ...prev, key_mirror_enrolled: true } : prev))}
          />
        )}
      </div>

      <div className="ds-card" style={{ marginBottom: 14 }}>
        <h2 className="ds-cardh">Your API key</h2>
        {newKey ? (
          <div className="ds-call acc">
            <p style={{ margin: "0 0 8px", fontWeight: 600 }}>🔑 Your new key — copy it now, it won&apos;t be shown again:</p>
            <pre className="ds-pre">{newKey}</pre>
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <button className="ds-btn" onClick={() => navigator.clipboard?.writeText(newKey).catch(() => {})}>Copy</button>
              <button className="ds-btn ghost" onClick={() => { setNewKey(null); window.location.reload(); }}>Done</button>
            </div>
            <p className="ds-fine" style={{ marginTop: 8 }}>Give this to your agent (replace the old key). The previous key no longer works.</p>
          </div>
        ) : !showDevKey ? (
          <p className="ds-fine">Advanced — most people never need this. <button className="ds-link" onClick={() => setShowDevKey(true)}>Show developer key</button></p>
        ) : (
          <>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <code className="ds-mono" style={{ background: "#f8fafc", border: "1px solid var(--ds-line)", borderRadius: 8, padding: "6px 10px", fontSize: 13 }}>{m.api_key_masked ?? "—"}</code>
              <button className="ds-btn ghost" onClick={rotateKey} disabled={busy === "key" || demoMode}>{busy === "key" ? "Rotating…" : "Rotate key"}</button>
            </div>
            <p className="ds-fine" style={{ marginTop: 8 }}>Last used {lastUsed}. We never show the full key here — only the last 4 characters. <button className="ds-link" onClick={() => setShowDevKey(false)}>Hide</button></p>
          </>
        )}
      </div>

      <div className="ds-card">
        <h2 className="ds-cardh">Account activity</h2>
        {!showAudit ? (
          <button className="ds-btn ghost" onClick={() => { setShowAudit(true); loadAudit(); }} disabled={demoMode}>Show recent activity</button>
        ) : (
          <>
            {audit.length === 0 && <p className="ds-fine">No recent activity.</p>}
            {audit.map((e, i) => (
              <div className="ds-item" key={i}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5 }}>{e.label}{e.detail && (e.detail.peer || e.detail.to) ? <span className="ds-imeta"> · {String(e.detail.peer ?? e.detail.to)}</span> : null}</div>
                  <div className="ds-imeta">{new Date(e.at).toLocaleString()}</div>
                </div>
              </div>
            ))}
            <p className="ds-fine" style={{ marginTop: 8 }}>This is a record of actions on your own account — sign-ins, key changes, trust, and collaboration requests. Only you can see it.</p>
          </>
        )}
      </div>
    </>
  );

  /* -------------------------------- render -------------------------------- */

  return (
    <AppShell {...shellProps}>
      <div className="ds-wrap">
        {nav === "overview" && overview}
        {nav === "messages" && inboxPane}
        {nav === "friends" && friendsPane}
        {nav === "skills" && toolkitPane}
        {nav === "agents" && agentsPane}
        {nav === "settings" && settingsPane}
        <p className="ds-fine" style={{ marginTop: 28, textAlign: "center" }}>
          <a href="/faq" style={{ color: "var(--ds-mut)" }}>FAQ</a> · <a href="/commands" style={{ color: "var(--ds-mut)" }}>Commands</a> · <a href="/lessons" style={{ color: "var(--ds-mut)" }}>Community lessons</a> · <a href="/" style={{ color: "var(--ds-mut)" }}>Home</a>
        </p>
      </div>

      {editor && (
        <ArtifactEditor
          mode={editor.mode}
          initial={editor.initial}
          onClose={() => setEditor(null)}
          onSaved={(msg) => { setEditor(null); setLibFlash(msg); loadSkills(); setTimeout(() => setLibFlash(""), 6000); }}
        />
      )}
      {inspect && <ArtifactInspector artifact={inspect} onClose={() => setInspect(null)} />}
    </AppShell>
  );
}
