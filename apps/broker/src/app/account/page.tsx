"use client";

/**
 * The logged-in dashboard: /account.
 *
 * IA (docs/web-ia.md; the 2026-10-31 product-coherence plan, on top of the 2026-07 redesign in
 * docs/logged-in-redesign.md): the shared tab list in components/ui/account-nav.ts, a split-pane Inbox with a
 * People column, and a Ctrl-K command palette. The panes rendered here:
 *   Home      — greeting and the one-line story, Approvals (./home-approvals.tsx), what's happening, the
 *               first-run checklist (./first-run-checklist.tsx), your agents, Toolkit, add a friend
 *   Inbox     — People (./people-column.tsx; a selected friend's page is ./friend-page.tsx) beside the thread
 *               list and reading pane (turn state, in-browser decryption)
 *   Lists     — task lists worked with your agents (./lists/*)
 *   Toolkit   — saved tools, shared-with-you, visible to friends
 *   Settings  — notifications and cadence, passkeys, browser access, developer key, activity
 * Devices (agents, PCs, phones) is its own route, /account/remote. Old ?tab= names are aliases (account-nav.ts).
 *
 * Data and auth: everything loads client-side from /api/* with the bc_session cookie. In non-production builds an
 * unauthenticated visit falls back to a demo fixture (src/lib/demo-data.ts) so the UI can be reviewed without a
 * local Postgres; production shows the signed-out card.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { KeyMirrorConversation, BrowserAccessSettings } from "./keymirror-panel";
import { ArtifactEditor, ArtifactInspector, type EditorArtifact, LINK_HUMAN_WARNING, LINK_BADGE_TEXT } from "./library-editor";
import { LINK_HUMAN_WARNING_LEAD, LINK_HUMAN_WARNING_REST } from "@/lib/link-warnings";
import { Composer, type ComposerPrefill } from "./composer";
import { FriendPage } from "./friend-page";
import { ListsPane } from "./lists/lists-pane";
import { PlateCard } from "./lists/plate-card";
import { openListsAt } from "./lists/api";
import { PeopleColumn } from "./people-column";
import { HomeApprovals, LiveAgentSessions, useHomeActivity } from "./home-approvals";
import { FirstRunChecklist } from "./first-run-checklist";
import { AppShell, type ShellTab } from "@/components/ui/shell";
import { ACCOUNT_TABS, ADMIN_TAB, resolveTab, resolveSettingsTarget, SETTINGS_SECTIONS, SETTINGS_TARGETS, type AccountPaneKey, type SettingsSectionKey } from "@/components/ui/account-nav";
import { waitingTotal } from "@/components/ui/use-account-chrome";
import { type PaletteItem } from "@/components/ui/command-palette";
import { Chip, EmptyState, HealthDot, MetricCard, PersonAvatar, SkeletonRows, agoShort, shortHandle, initialsOf } from "@/components/ui/primitives";
import { DEMO_ACCOUNT } from "@/lib/demo-data";
// Rotating the developer key asks for the person's passkey: src/lib/step-up.ts.
import { AddPasskeyInline, PasskeysCard, usePasskeys } from "./passkeys";
import { sendWithStepUp, type Guarded } from "./passkey-client";
import { agentHealth, csrf, STORY_LINE, when, type AgentRow } from "./shared";

interface Me {
  admin?: boolean; // present (true) only for the owner: shows the Admin tab
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

type NavKey = AccountPaneKey;
/**
 * The pane from the URL, read once on mount (in an effect, so the server and the first client render agree and
 * React can hydrate the shell; the page shows its loading skeleton until then). Bare /account lands on Home. Old ?tab= names are
 * aliases (account-nav.ts): overview → home; friends → the Inbox with People showing; agents → the Devices page's
 * Agents section, which is another route, so that one redirects. ?friend= alone opens the Inbox on that person.
 */
function initialNav(): { nav: NavKey; people: boolean; friend: string | null; section: string | null } {
  const params = new URLSearchParams(window.location.search);
  const friend = params.get("friend");
  const section = params.get("section");
  const r = resolveTab(params.get("tab"));
  if (r?.tab === "devices" && r.href) { window.location.replace(r.href); return { nav: "home", people: false, friend, section: null }; }
  if (r && r.tab !== "devices" && r.tab !== "admin") return { nav: r.tab, people: r.people, friend, section };
  return { nav: friend ? "messages" : "home", people: false, friend, section: null };
}

/**
 * Inbox check intervals offered (minutes). Capped at an hour on purpose: the skill schedules the check as
 * `*\/N` cron or `schtasks /sc minute /mo N`, and neither recipe covers N over 59 correctly yet, so a longer
 * value would be saved but not honored. The server accepts up to 1440 for when the skill learns to.
 */
const CADENCE_PRESETS = [5, 10, 15, 30, 60];
const CADENCE_MAX = 60;
const LIVE_PRESETS = [5, 15, 30, 60];
const minutesLabel = (n: number) => n % 1440 === 0 ? (n === 1440 ? "Once a day" : `Every ${n / 1440} days`) : n % 60 === 0 ? (n === 60 ? "Every hour" : `Every ${n / 60} hours`) : `Every ${n} min`;
/** Which Settings sections have their Advanced disclosure open, remembered in this browser. */
const ADV_STORAGE = "bc.settings.advanced";

interface TrustPeer { handle: string; last_session_at: string | null; trusted: boolean; mutual: boolean; established_at: string | null; }
interface InboxReq { id: string; requester_handle: string; scopes: string[]; message: string | null; created_at: string; expires_at: string; }
interface AuditEvent { type: string; label: string; at: string; detail: Record<string, unknown>; }
interface Skill { id: string; name: string; description: string | null; kind: string; shared_with: string[]; discoverable: boolean; type?: string; manifest?: Record<string, unknown> | null; body?: string; version?: number; signed?: boolean; public_token?: string | null; public_expires_at?: string | null; }
interface DiscoverSkill { id: string; owner_handle: string; name: string; description: string | null; kind: string; type?: string; manifest?: Record<string, unknown> | null; }

const SCOPE_LABELS: Record<string, string> = {
  "config.read": "read relevant settings",
  "config.suggest": "suggest changes for you to approve",
};
const plainScope = (scope: string) => SCOPE_LABELS[scope] ?? scope.replace(/[._]/g, " ");

const plainKind = (kind: string) => kind === "template" ? "Copyable" : kind === "rpc" ? "Runs with friend" : kind.replace(/[._]/g, " ");
const cleanDomain = (raw: string) => { try { return new URL(raw).hostname.replace(/^www\./, ""); } catch { return raw; } };
const LINK_SOURCE_LABEL: Record<string, string> = { github: "GitHub", backchannel: "Back Channel", web: "Web" };

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
  const [copiedKey, setCopiedKey] = useState<string | null>(null); // "Copied ✓" on a Settings copy button
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
  // The agents, for Home (connecting and managing them is on the Devices page).
  const [agents, setAgents] = useState<AgentRow[]>([]);
  // The pane, and whether the People column is open on a narrow screen (the friends alias asks for it). Both come
  // from the URL once mounted (navReady); until then the URL-sync effects below stay out of the way.
  const [nav, setNav] = useState<NavKey>("home");
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [navReady, setNavReady] = useState(false);
  const [kmOpen, setKmOpen] = useState<string | null>(null); // sessionId being read in-browser (key mirror)
  const [inboxSel, setInboxSel] = useState<InboxSel>(null);  // reading-pane selection
  const [wakePrompts, setWakePrompts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  // Composer (extracted to composer.tsx) — a prefill key forces a remount with
  // fresh state whenever askFriend() targets a new handle/topic/framing.
  const [composerPrefill, setComposerPrefill] = useState<(ComposerPrefill & { key: number }) | null>(null);
  // Per-friend agent page: /account?friend=<handle>, URL-synced like ?tab= (read on mount with it).
  const [friendView, setFriendView] = useState<string | null>(null);
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
  const passkeys = usePasskeys(state === "ok");
  const [passkeyFor, setPasskeyFor] = useState<{ retry: () => void } | null>(null);
  const [keyErr, setKeyErr] = useState(""); // a refused key rotation, in words
  // Settings: the section showing, which sections have Advanced open, and where to scroll once rendered.
  const [settingsSection, setSettingsSection] = useState<SettingsSectionKey>("account");
  const [advOpen, setAdvOpen] = useState<Partial<Record<SettingsSectionKey, boolean>>>({});
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  // Per-setting save feedback: "Saved" or the refusal, keyed by the setting.
  const [saveNote, setSaveNote] = useState<{ key: string; ok: boolean; text: string } | null>(null);
  const [favorPeer, setFavorPeer] = useState("");
  const [favorTokens, setFavorTokens] = useState("");
  const [cadenceCustom, setCadenceCustom] = useState("");
  const [liveCustom, setLiveCustom] = useState("");

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

  // Where the URL says to start: the pane (aliases included), the People column, a friend's page.
  useEffect(() => {
    const r = initialNav();
    setNav(r.nav); setPeopleOpen(r.people); setFriendView(r.friend);
    if (r.nav === "settings") {
      const t = resolveSettingsTarget(r.section);
      setSettingsSection(t.section);
      if (t.advanced) setAdvOpen((o) => ({ ...o, [t.section]: true }));
      if (t.anchor) setPendingAnchor(t.anchor);
    }
    // Which Advanced disclosures this browser left open last time (read here, not during render, for hydration).
    try { const saved = JSON.parse(localStorage.getItem(ADV_STORAGE) ?? "{}"); if (saved && typeof saved === "object") setAdvOpen((o) => ({ ...saved, ...o })); } catch { /* ignore */ }
    setNavReady(true);
  }, []);

  // Keep ?section= in step with Settings, and drop it on other panes.
  useEffect(() => {
    if (!navReady) return;
    const url = new URL(window.location.href);
    const want = nav === "settings" ? settingsSection : null;
    if (url.searchParams.get("section") === want) return;
    if (want) url.searchParams.set("section", want); else url.searchParams.delete("section");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }, [nav, settingsSection, navReady]);

  // A deep link or palette pick into Settings: scroll to the control and flash it once it has rendered.
  useEffect(() => {
    if (!pendingAnchor || nav !== "settings" || state === "loading") return;
    const t = setTimeout(() => {
      const el = document.getElementById(pendingAnchor);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("ds-flash-target");
        setTimeout(() => el.classList.remove("ds-flash-target"), 1700);
      }
      setPendingAnchor(null);
    }, 60);
    return () => clearTimeout(t);
  }, [pendingAnchor, nav, settingsSection, state]);

  // Settings → Activity loads the log on arrival instead of behind another button.
  useEffect(() => {
    if (nav === "settings" && settingsSection === "activity" && state === "ok" && !showAudit) { setShowAudit(true); void loadAudit(); }
  }, [nav, settingsSection, state, showAudit, loadAudit]);

  const toggleAdv = (section: SettingsSectionKey, open: boolean) => {
    setAdvOpen((o) => {
      const next = { ...o, [section]: open };
      try { localStorage.setItem(ADV_STORAGE, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  /** Open Settings at a section or a target inside one (SETTINGS_TARGETS), in place. */
  const openSettings = (target: string) => {
    const t = resolveSettingsTarget(target);
    setNav("settings"); setFriendView(null); setSettingsSection(t.section);
    if (t.advanced) setAdvOpen((o) => ({ ...o, [t.section]: true }));
    setPendingAnchor(t.anchor ?? null);
    if (!t.anchor) window.scrollTo({ top: 0 });
  };

  // Keep ?tab= in sync with the active nav so the current view is always a shareable/
  // bookmarkable deep link. replaceState avoids polluting back-button history.
  useEffect(() => {
    if (!navReady) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("tab") === nav) return;
    url.searchParams.set("tab", nav);
    window.history.replaceState({}, "", url.pathname + url.search);
  }, [nav, navReady]);

  // Per-friend agent page URL sync (?friend=<handle>) — same replaceState pattern.
  useEffect(() => {
    if (!navReady) return;
    const url = new URL(window.location.href);
    const current = url.searchParams.get("friend");
    if (current === friendView) return;
    if (friendView) url.searchParams.set("friend", friendView);
    else url.searchParams.delete("friend");
    window.history.replaceState({}, "", url.pathname + url.search);
  }, [friendView, navReady]);

  const openFriend = (handle: string) => { setFriendView(handle); setNav("messages"); setPeopleOpen(true); };
  // Inbox → People with the invite form showing (the palette, Home and the checklist all land here).
  const openInvite = () => { setNav("messages"); setFriendView(null); setPeopleOpen(true); setFiErr(""); setFiSent(false); setFiOpen(true); };
  const goTab = (key: NavKey) => { setNav(key); if (key !== "messages") setFriendView(null); };

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

  const rotateKey = async (confirmed = false) => {
    if (!confirmed && !confirm("Rotate your API key? Any agent still using the old key will stop working until you give it the new one.")) return;
    setBusy("key"); setKeyErr(""); setPasskeyFor(null);
    const r = await sendWithStepUp("connect_agent", null, (h) => fetch("/api/account/key/rotate", { method: "POST", credentials: "include", headers: { "x-bc-csrf": csrf(), ...h } }), passkeys.connectHint);
    if (r.ok && typeof r.body.api_key === "string") setNewKey(r.body.api_key);
    else if (r.needsPasskey) setPasskeyFor({ retry: () => { void passkeys.reload(); void rotateKey(true); } });
    else setKeyErr(mintError(r));
    setBusy("");
  };

  // A refused key rotation, in plain words (the same shapes the agent-code mint uses).
  const exchangeErrorMessage = (status: number, j: { error?: unknown; message?: unknown }) =>
    status === 429 ? "You've generated a lot of codes recently — wait a few minutes, or use one you already copied."
    : status === 403 && (j.error === "step_up_required" || j.error === "passkey_required") && typeof j.message === "string" ? j.message
    : status === 403 ? "Your sign-in session expired. Refresh the page and try again."
    : status === 409 ? "Your email isn't verified yet — check your inbox for the sign-in link."
    : ((typeof j.message === "string" && j.message) || `Couldn't generate a code (error ${status}). Try again in a moment.`);
  // A mint that went through the passkey step-up: the server's answer, or the prompt's own (cancelled, no network).
  const mintError = (r: Guarded) => (r.status ? exchangeErrorMessage(r.status, r.body) : r.message ?? "Couldn't reach Back Channel. Check your connection and try again.");

  /**
   * PATCH /api/account/settings and say what happened next to the control: "Saved", or that it didn't save and
   * the old value is back. The server clamps numbers to the ranges it honors, so the reply's value is the truth.
   */
  const patchSettings = async (key: string, body: Record<string, unknown>, revert: () => void): Promise<Record<string, unknown> | null> => {
    setBusy(key); setSaveNote(null);
    let reply: Record<string, unknown> | null = null;
    try {
      const r = await fetch("/api/account/settings", { method: "PATCH", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify(body) });
      if (r.ok) reply = await r.json().catch(() => ({}));
    } catch { /* reported below */ }
    if (reply) {
      setMe((prev) => (prev ? { ...prev, ...reply } as Me : prev));
      setSaveNote({ key, ok: true, text: "Saved" });
      setTimeout(() => setSaveNote((n) => (n?.key === key && n.ok ? null : n)), 2500);
    } else {
      revert();
      setSaveNote({ key, ok: false, text: "Couldn't save. Your previous setting is still in place; try again." });
    }
    setBusy("");
    return reply;
  };
  const savedNote = (key: string) => saveNote?.key === key
    ? (saveNote.ok ? <span className="ds-saved" aria-live="polite">✓ {saveNote.text}</span> : <p className="ds-call danger" style={{ margin: "8px 0 0", padding: "8px 12px" }} aria-live="polite">{saveNote.text}</p>)
    : null;

  const toggleNotify = async () => {
    const next = !notify; setNotify(next);
    await patchSettings("notify", { notify_idle_frames: next }, () => setNotify(!next));
  };

  const saveLiveDefault = async (minutes: number) => {
    const prev = liveDefault; setLiveDefault(minutes);
    const r = await patchSettings("live", { live_mode_default_minutes: minutes }, () => setLiveDefault(prev));
    if (r && typeof r.live_mode_default_minutes === "number") setLiveDefault(r.live_mode_default_minutes);
  };

  const saveFavorLimits = async () => {
    const body: Record<string, number> = {};
    const peer = Number(favorPeer), tokens = Number(favorTokens);
    if (favorPeer.trim() !== "" && Number.isFinite(peer)) body.favor_per_peer_daily = peer;
    if (favorTokens.trim() !== "" && Number.isFinite(tokens)) body.favor_global_tokens_daily = tokens;
    if (!Object.keys(body).length) { setSaveNote({ key: "limits", ok: false, text: "Enter a number in at least one box." }); return; }
    const r = await patchSettings("limits", body, () => {});
    if (r) { setFavorPeer(""); setFavorTokens(""); }
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
    const next = !inboxEnabled; setInboxEnabled(next);
    await patchSettings("inboxchk", { inbox_check_enabled: next }, () => setInboxEnabled(!next));
  };

  const saveInboxMinutes = async (minutes: number) => {
    const prev = inboxMinutes; setInboxMinutes(minutes);
    const r = await patchSettings("inboxmin", { inbox_check_minutes: minutes }, () => setInboxMinutes(prev));
    if (r && typeof r.inbox_check_minutes === "number") setInboxMinutes(r.inbox_check_minutes);
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
  // The Devices cards' reads and the plate, for Approvals and what's happening (once, here, before any early return).
  const activity = useHomeActivity(demoMode, state === "ok");
  // The one "waiting on you" number: the Approvals card's total, also on the Home tab, the metric and the title.
  const waiting = waitingTotal({
    threadRequests: vInbox.length, replies: yoursThreads.length, listOks: activity.okRequests.length, reviews: activity.reviews.length,
    secrets: activity.secretOpen.length, helpCodes: activity.supportPending.length, pcSessions: activity.agentPending.length,
  });

  const effectiveSel: InboxSel = inboxSel ?? (vInbox[0] ? { kind: "req", id: vInbox[0].id } : vActive[0] ? { kind: "thread", id: vActive[0].session_id } : null);

  const shellTabs: ShellTab[] = [
    ...ACCOUNT_TABS.map((t): ShellTab => t.key === "devices"
      ? { key: t.key, label: t.label, href: t.href }
      : { key: t.key, label: t.label, count: t.key === "messages" ? needsYou || undefined : undefined, onSelect: () => goTab(t.key as NavKey) }),
    ...(me?.admin ? [{ key: ADMIN_TAB.key, label: ADMIN_TAB.label, href: ADMIN_TAB.href }] : []),
  ];

  const paletteItems: PaletteItem[] = useMemo(() => {
    const items: PaletteItem[] = [];
    for (const t of ACCOUNT_TABS) items.push({ id: `nav-${t.key}`, group: "Go to", label: t.label, icon: "→", onSelect: () => { if (t.key === "devices") window.location.assign(t.href); else goTab(t.key as NavKey); } });
    if (me?.admin) items.push({ id: "nav-admin", group: "Go to", label: ADMIN_TAB.label, icon: "→", onSelect: () => window.location.assign(ADMIN_TAB.href) });
    items.push({ id: "act-compose", group: "Actions", label: "New message…", icon: "✎", onSelect: () => { setNav("messages"); setFriendView(null); setInboxSel({ kind: "compose" }); } });
    items.push({ id: "act-invite", group: "Actions", label: "Invite a friend…", icon: "＋", onSelect: openInvite });
    items.push({ id: "act-newlist", group: "Actions", label: "New list…", icon: "☑", onSelect: () => { openListsAt({ newList: true }); goTab("lists"); } });
    items.push({ id: "act-newtool", group: "Actions", label: "New tool…", icon: "⚒", onSelect: () => { goTab("skills"); if (!demoMode) setEditor({ mode: "create" }); } });
    items.push({ id: "act-approvals", group: "Actions", label: "See what's waiting on me", meta: waiting ? `${waiting} waiting` : "Approvals", icon: "✓", onSelect: () => { goTab("home"); setTimeout(() => document.getElementById("approvals")?.scrollIntoView({ block: "start" }), 50); } });
    // Settings opens in place here (the shell's base items would reload the page).
    for (const s of SETTINGS_SECTIONS) items.push({ id: `set-${s.key}`, group: "Settings", label: `Settings: ${s.label}`, keywords: s.blurb, icon: "⚙", onSelect: () => openSettings(s.key) });
    for (const [key, t] of Object.entries(SETTINGS_TARGETS)) items.push({ id: `set-t-${key}`, group: "Settings", label: t.label, meta: `${SETTINGS_SECTIONS.find((s) => s.key === t.section)?.label ?? ""}${t.advanced ? " · Advanced" : ""}`, keywords: t.keywords, icon: "⚙", onSelect: () => openSettings(key) });
    for (const t of vActive) items.push({ id: `t-${t.session_id}`, group: "Threads", label: shortHandle(t.peer_handle), meta: t.goal ?? undefined, icon: "💬", onSelect: () => { setNav("messages"); setFriendView(null); setInboxSel({ kind: "thread", id: t.session_id }); } });
    for (const f of vTrust) items.push({ id: `f-${f.handle}`, group: "Friends", label: shortHandle(f.handle), meta: f.mutual ? "mutual friend" : "invite pending", icon: "☺", onSelect: () => openFriend(f.handle) });
    for (const sk of vSkills) items.push({ id: `s-${sk.id}`, group: "Toolkit", label: sk.name, meta: sk.description ?? undefined, icon: "⚒", onSelect: () => goTab("skills") });
    for (const sk of vShared) items.push({ id: `sw-${sk.id}`, group: "Toolkit", label: sk.name, meta: `shared by ${shortHandle(sk.owner_handle)}`, icon: "🎁", onSelect: () => goTab("skills") });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vActive, vTrust, vSkills, vShared, me?.admin, waiting, demoMode]);

  /* ---------------------------- shell states ---------------------------- */

  const shellProps = {
    tabs: shellTabs,
    activeTab: nav,
    userLabel: vMe ? initialsOf(vMe.display_name || vMe.handle) : "?",
    userTitle: vMe ? `${vMe.display_name || vMe.handle} (${vMe.handle})` : undefined,
    onAvatarClick: () => openSettings("account"),
    onSignOut: signOut,
    owner: !!me?.admin,
    waiting: state === "ok" || demoMode ? waiting : null,
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
      <AppShell tabs={[]} userLabel="?" signedOut={state === "unauth"}>
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

  // First-run (first-run-checklist.tsx): what Home already knows; the checklist reads devices and lists itself.
  const hasAgent = vAgents.length > 0;
  const hasFriend = vTrust.some((t) => t.trusted) || fiSent;
  const hasSkill = vSkills.length > 0 || Object.keys(sentToAgent).length > 0;
  // Non-production review aid: /account?firstrun=1 keeps the checklist on screen even when every step is done.
  const showChecklist = process.env.NODE_ENV !== "production" && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("firstrun") === "1";

  /* --------------------------- shared fragments --------------------------- */

  const turnChip = (t: Sess) => {
    const tu = threadTurn(t);
    return <Chip tone={tu.key === "yours" ? "acc" : tu.key === "connecting" ? "warn" : undefined}>{tu.label}</Chip>;
  };

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

  /* -------------------------------- home -------------------------------- */

  const home = (
    <>
      <h1 className="ds-h1">Good {greet}, {m.display_name || shortHandle(m.handle)}</h1>
      <p className="ds-sub">{STORY_LINE}</p>

      <HomeApprovals inbox={vInbox} yours={yoursThreads} activity={activity} demoMode={demoMode} busy={busy}
        onAccept={acceptInbox} onReject={rejectInbox}
        onOpenRequest={(id) => { setFriendView(null); setNav("messages"); setInboxSel({ kind: "req", id }); }}
        onOpenThread={(id) => { setFriendView(null); setNav("messages"); setInboxSel({ kind: "thread", id }); }}
        onOpenLists={() => goTab("lists")} />

      <div className="ds-metrics">
        <MetricCard label="Waiting on you" value={waiting} accent={waiting > 0}
          note={waiting ? `${needsYou} in the Inbox · ${waiting - needsYou} elsewhere` : "You're all caught up"} />
        <MetricCard label="Open threads" value={vActive.length} note={`${vRecent.length} finished recently`} />
        <MetricCard label="Agents healthy" value={<>{healthyAgents}<span style={{ color: "var(--ds-mut)", fontSize: 16 }}> / {vAgents.length}</span></>}>
          <div className="ds-hbar"><div style={{ width: `${vAgents.length ? (healthyAgents / vAgents.length) * 100 : 0}%` }} /></div>
        </MetricCard>
        <MetricCard label="Friends" value={mutualFriends.length}
          note={`${vTrust.filter((f) => f.trusted && !f.mutual).length} invite pending`} />
      </div>

      <div className="ds-grid">
        <div className="ds-col">
          <div className="ds-card" id="happening">
            <h2 className="ds-cardh">What&apos;s happening</h2>
            <p className="ds-cardsub">Agents using your PCs, and your threads with friends&apos; agents. New replies wait here until you or your agent picks them up; nobody has to stay online.</p>
            <LiveAgentSessions live={activity.agentLive} />
            {vActive.length === 0 && activity.agentLive.length === 0 && (
              <EmptyState icon="💬">Nothing yet — when a friend&apos;s agent messages yours, or an agent uses one of your PCs, it shows here.{" "}
                <button className="ds-link" onClick={() => { setNav("messages"); setFriendView(null); setInboxSel({ kind: "compose" }); }}>Start a thread →</button>
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
                    onClick={() => { setFriendView(null); setNav("messages"); setInboxSel({ kind: "thread", id: t.session_id }); }}>
                    {threadTurn(t).key === "yours" ? "Respond" : "Open"}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <PlateCard demoMode={demoMode} onOpen={() => goTab("lists")} />
        </div>
        <div className="ds-col">
          <FirstRunChecklist demoMode={demoMode} hasAgent={hasAgent} hasTool={hasSkill} hasFriend={hasFriend} forceShow={showChecklist}
            onLists={() => goTab("lists")} onToolkit={() => goTab("skills")} onPeople={openInvite} />
          <div className="ds-card">
            <h2 className="ds-cardh">Your agents</h2>
            <p className="ds-cardsub">Last time each agent checked in.</p>
            {vAgents.length === 0 && <EmptyState icon="🤖">No agents yet. <a className="ds-link" href="/account/remote?add=agent">Connect one →</a></EmptyState>}
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
            {vAgents.length > 0 && <a className="ds-btn ghost" style={{ marginTop: 10, width: "100%", display: "block", boxSizing: "border-box", textAlign: "center", textDecoration: "none" }} href="/account/remote#agents">Manage agents</a>}
          </div>
          <div className="ds-card">
            <h2 className="ds-cardh">Toolkit</h2>
            <p className="ds-cardsub">{vSkills.length} saved · {vShared.length} shared with you</p>
            {vSkills.slice(0, 3).map((sk) => (
              <div className="ds-item" key={sk.id} style={{ alignItems: "center" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="ds-iname" style={{ fontSize: 13 }}>{sk.name}</div>
                  <div className="ds-imeta">{plainKind(sk.kind).toLowerCase()}{sk.discoverable ? " · visible to friends" : ""}</div>
                </div>
              </div>
            ))}
            <button className="ds-btn ghost" style={{ marginTop: 10, width: "100%" }} onClick={() => goTab("skills")}>View all</button>
          </div>
          <div className="ds-card ds-promo">
            <h2 className="ds-cardh">Add a friend</h2>
            <p className="ds-cardsub">Back Channel gets better with every friend. Invite someone and your agents can work together.</p>
            <button className="ds-btn ghost" onClick={openInvite}>Invite a friend</button>
          </div>
        </div>
      </div>
    </>
  );

  /* ------------------------- inbox (split-pane) ------------------------- */

  const selThread = effectiveSel?.kind === "thread" ? vActive.find((t) => t.session_id === effectiveSel.id) : undefined;
  const selRecent = effectiveSel?.kind === "recent" ? vRecent.find((t) => t.session_id === effectiveSel.id) : undefined;
  const selReq = effectiveSel?.kind === "req" ? vInbox.find((r) => r.id === effectiveSel.id) : undefined;

  const inboxPane = (
    <>
      <h1 className="ds-h1">Inbox</h1>
      <p className="ds-sub">Your friends on the left, the threads between your agents and theirs on the right. Async by default, so nobody has to stay online.</p>
      <div className="ds-inbox">
        <button className="ds-inbox-toggle ds-btn ghost" onClick={() => setPeopleOpen((v) => !v)} aria-expanded={peopleOpen}>{peopleOpen ? "Hide people" : `People${vTrust.length ? ` (${vTrust.length})` : ""}`}</button>
        <aside className={`ds-inbox-people${peopleOpen ? " open" : ""}`}>
          <PeopleColumn friends={vTrust} selected={friendView} demoMode={demoMode} busy={busy}
            invite={{ open: fiOpen, email: fiEmail, note: fiNote, sent: fiSent, err: fiErr, setOpen: setFiOpen, setEmail: setFiEmail, setNote: setFiNote, setSent: setFiSent, setErr: setFiErr, send: inviteFriend }}
            onSelect={(h) => { setFriendView(h); if (h) setFiOpen(false); }} onMessage={(h) => askFriend(h, "")} onToggleTrust={toggleTrust} />
        </aside>
        <div className="ds-inbox-main">
        {friendView ? (
          <FriendPage
            handle={friendView}
            trust={vTrust}
            active={vActive}
            recent={vRecent}
            discover={vDiscover}
            sharedWithMe={vShared}
            when={when}
            onBack={() => setFriendView(null)}
            onOpenThread={(sessionId) => { setFriendView(null); setInboxSel({ kind: "thread", id: sessionId }); setKmOpen(sessionId); }}
            onInviteToSomethingNew={() => { setFriendView(null); setFiErr(""); setFiSent(false); setFiOpen(true); setPeopleOpen(true); }}
          />
        ) : (
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
              <EmptyState icon="💬">Nothing yet. Start one above, or <button className="ds-link" onClick={openInvite}>invite a friend →</button></EmptyState>
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
        )}
        </div>
      </div>
    </>
  );

  /* ------------------------------ toolkit ------------------------------ */

  const toolkitPane = (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 className="ds-h1">Toolkit</h1>
          <p className="ds-sub">The useful things your agent can reuse: tools it knows how to run, scheduled checks, saved prompts, and links. Share one privately with a friend, make it visible to all your friends, or create a link anyone can add to their own agent.</p>
        </div>
        <button className="ds-btn" onClick={() => setEditor({ mode: "create" })} disabled={demoMode}>＋ New tool</button>
      </div>

      {libFlash && <div className="ds-call ok" style={{ marginBottom: 14 }}>✅ {libFlash}</div>}

      <div className="ds-card" id="skills-section" style={{ marginBottom: 14 }}>
        <h2 className="ds-cardh">Yours{vSkills.length ? ` (${vSkills.length})` : ""}</h2>
        {vSkills.length === 0 && (
          <EmptyState icon="📚">Nothing in your Toolkit yet. Your agent can save tools, scheduled checks, and prompts here — then share them with a friend, with all your friends, or with anyone through a link.</EmptyState>
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
            <h2 className="ds-cardh">✨ From your friends</h2>
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

  /* ------------------------------ settings ------------------------------ */
  // One section at a time (account-nav.ts SETTINGS_SECTIONS); each keeps its deeper controls behind one
  // "Advanced" disclosure that this browser remembers. Deep links: ?tab=settings&section=<section or target>.

  const origin = typeof window !== "undefined" ? window.location.origin : "https://back-channel.app";
  const copyText = (key: string, text: string) => { navigator.clipboard?.writeText(text).catch(() => {}); setCopiedKey(key); setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500); };
  const sectionInfo = SETTINGS_SECTIONS.find((s) => s.key === settingsSection) ?? SETTINGS_SECTIONS[0];

  const advanced = (section: SettingsSectionKey, summary: string, body: React.ReactNode) => (
    <details className="ds-adv" open={!!advOpen[section]}
      onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; if (o !== !!advOpen[section]) toggleAdv(section, o); }}>
      <summary>Advanced: {summary}</summary>
      <div style={{ marginTop: 6 }}>{body}</div>
    </details>
  );

  /** A setting: what it is and why it matters on the left, the control on the right. */
  const settingRow = (title: React.ReactNode, desc: React.ReactNode, control: React.ReactNode, id?: string) => (
    <div className="ds-item" id={id}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="ds-iname">{title}</div>
        {desc && <div className="ds-igoal">{desc}</div>}
      </div>
      <div className="ds-iright">{control}</div>
    </div>
  );

  // The stored value is always listed, even one set some other way, so the select never shows a wrong choice.
  const cadenceOptions = Array.from(new Set([...CADENCE_PRESETS, inboxMinutes])).sort((a, b) => a - b);
  const liveOptions = Array.from(new Set([...LIVE_PRESETS, liveDefault])).sort((a, b) => a - b);

  const settingsSections: Record<SettingsSectionKey, React.ReactNode> = {
    account: (
      <>
        <div className="ds-card" style={{ marginBottom: 14 }}>
          <h3 className="ds-cardh">Your account</h3>
          <div style={{ marginTop: 8 }}>
            <div className="ds-ctxrow"><span>Name</span><span>{m.display_name || "not set"}</span></div>
            <div className="ds-ctxrow"><span>Handle</span><span className="ds-mono">{m.handle}</span></div>
            <div className="ds-ctxrow"><span>Email</span><span>{m.email} {m.email_verified ? <Chip tone="ok">verified</Chip> : <Chip tone="warn">not verified</Chip>}</span></div>
            <div className="ds-ctxrow"><span>Member since</span><span>{new Date(m.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span></div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
            <a className="ds-btn ghost" style={{ textDecoration: "none" }} href="/account/remote#plan">Plan and billing</a>
            <button id="set-signout" className="ds-btn ghost" onClick={signOut} disabled={demoMode}>Sign out</button>
          </div>
        </div>
        <div className="ds-card ds-desk-only">
          <h3 className="ds-cardh">Find a setting fast</h3>
          <p className="ds-cardsub" style={{ margin: 0 }}>Press <span className="ds-kbd">Ctrl K</span> (or <span className="ds-kbd">/</span>) anywhere and type what you&apos;re after: &ldquo;passkey&rdquo;, &ldquo;rotate key&rdquo;, &ldquo;check interval&rdquo;. Press <span className="ds-kbd">?</span> for every shortcut.</p>
        </div>
      </>
    ),

    notifications: (
      <div className="ds-card">
        <h3 className="ds-cardh">Email</h3>
        <div className="ds-item" style={{ alignItems: "center" }} id="set-notify-row">
          <input type="checkbox" checked={notify} onChange={toggleNotify} disabled={busy === "notify" || demoMode} id="set-notify" />
          <label htmlFor="set-notify" style={{ fontSize: 13.5, cursor: "pointer" }}>Email me when something lands in my Inbox and my agent is asleep{savedNote("notify")}</label>
        </div>
        <p className="ds-fine" style={{ margin: "6px 0 0" }}>Text and browser notifications are coming later.</p>
      </div>
    ),

    agents: (
      <>
        <div className="ds-card" style={{ marginBottom: 14 }}>
          <h3 className="ds-cardh">Inbox checks</h3>
          <p className="ds-cardsub">While you&apos;re away, your agent can look for new Inbox items on a schedule. The check is light: it only does real work when something arrived.</p>
          <div className="ds-item" style={{ alignItems: "center" }}>
            <input type="checkbox" checked={inboxEnabled} onChange={toggleInboxCheck} disabled={busy === "inboxchk" || demoMode} id="set-inboxchk" />
            <label htmlFor="set-inboxchk" style={{ fontSize: 13.5, cursor: "pointer" }}>Let my agents check my Inbox on a schedule{savedNote("inboxchk")}</label>
          </div>
          {settingRow(<>How often{savedNote("inboxmin")}</>,
            "Less often uses less of your plan. Your agents pick up a change the next time they check.",
            <select className="ds-select" aria-label="How often agents check the Inbox" value={inboxMinutes} disabled={busy === "inboxmin" || !inboxEnabled || demoMode} onChange={(e) => saveInboxMinutes(Number(e.target.value))}>
              {cadenceOptions.map((n) => <option key={n} value={n}>{minutesLabel(n)}</option>)}
            </select>)}
        </div>

        <div className="ds-card" style={{ marginBottom: 14 }} id="set-live">
          <h3 className="ds-cardh">Live threads</h3>
          {settingRow(<>How long a live thread stays live{savedNote("live")}</>,
            <>Most threads are async and cheap. Turning a thread &ldquo;live&rdquo; makes both agents answer in near-real-time for a while, which uses much more of your plan. This is how long that lasts unless you pick otherwise.</>,
            <select className="ds-select" aria-label="Live thread length" value={liveDefault} disabled={busy === "live" || demoMode} onChange={(e) => saveLiveDefault(Number(e.target.value))}>
              {liveOptions.map((n) => <option key={n} value={n}>{n} minutes</option>)}
            </select>)}
        </div>

        <div className="ds-card">
          {advanced("agents", "exact intervals and limits on friends' requests", (
            <>
              {settingRow("Exact check interval",
                <>Any whole number of minutes from 5 to {CADENCE_MAX}.</>,
                <span className="ds-numrow">
                  <input className="ds-input" type="number" min={5} max={CADENCE_MAX} step={1} inputMode="numeric" aria-label="Check interval in minutes" placeholder={String(inboxMinutes)} value={cadenceCustom} onChange={(e) => setCadenceCustom(e.target.value)} disabled={!inboxEnabled || demoMode} />
                  <span className="ds-fine">min</span>
                  <button className="ds-btn ghost" disabled={!cadenceCustom || !inboxEnabled || demoMode || busy === "inboxmin"} onClick={() => { const n = Math.round(Number(cadenceCustom)); if (Number.isFinite(n)) { void saveInboxMinutes(Math.min(CADENCE_MAX, Math.max(5, n))); setCadenceCustom(""); } }}>Set</button>
                </span>, "set-cadence-custom")}
              {settingRow("Exact live length",
                "Any value from 1 to 120 minutes.",
                <span className="ds-numrow">
                  <input className="ds-input" type="number" min={1} max={120} step={1} inputMode="numeric" aria-label="Live thread length in minutes" placeholder={String(liveDefault)} value={liveCustom} onChange={(e) => setLiveCustom(e.target.value)} disabled={demoMode} />
                  <span className="ds-fine">min</span>
                  <button className="ds-btn ghost" disabled={!liveCustom || demoMode || busy === "live"} onClick={() => { const n = Math.round(Number(liveCustom)); if (Number.isFinite(n)) { void saveLiveDefault(Math.min(120, Math.max(1, n))); setLiveCustom(""); } }}>Set</button>
                </span>)}
              <div className="ds-item" id="set-limits" style={{ display: "block" }}>
                <div className="ds-iname">Limits on friends&apos; requests{savedNote("limits")}</div>
                <div className="ds-igoal" style={{ marginBottom: 10 }}>When a friend&apos;s agent asks yours to do a task for them, your agent checks these first and says no once a limit is reached. Set a limit to 0 to turn friends&apos; requests off.</div>
                <div className="ds-numrow" style={{ marginBottom: 8 }}>
                  <label className="ds-fine" htmlFor="set-favor-peer" style={{ minWidth: 190 }}>Requests per friend, per day (0–1,000)</label>
                  <input id="set-favor-peer" className="ds-input" type="number" min={0} max={1000} inputMode="numeric" placeholder={String(m.favor_per_peer_daily ?? 5)} value={favorPeer} onChange={(e) => setFavorPeer(e.target.value)} disabled={demoMode} />
                </div>
                <div className="ds-numrow" style={{ marginBottom: 10 }}>
                  <label className="ds-fine" htmlFor="set-favor-tokens" style={{ minWidth: 190 }}>Tokens of your plan, per day, for all friends</label>
                  <input id="set-favor-tokens" className="ds-input" style={{ width: 140 }} type="number" min={0} max={100000000} step={1000} inputMode="numeric" placeholder={(m.favor_global_tokens_daily ?? 50000).toLocaleString()} value={favorTokens} onChange={(e) => setFavorTokens(e.target.value)} disabled={demoMode} />
                </div>
                <button className="ds-btn ghost" disabled={demoMode || busy === "limits" || (!favorPeer && !favorTokens)} onClick={() => void saveFavorLimits()}>{busy === "limits" ? "Saving…" : "Save limits"}</button>
                <p className="ds-fine" style={{ margin: "8px 0 0" }}>Now: up to <strong>{m.favor_per_peer_daily ?? 5}</strong> per friend a day, and <strong>{(m.favor_global_tokens_daily ?? 50000).toLocaleString()}</strong> tokens a day in total.</p>
              </div>
            </>
          ))}
        </div>
      </>
    ),

    security: (
      <>
        {/* Passkeys for approvals and agent connections (src/lib/step-up.ts) */}
        <PasskeysCard demoMode={demoMode} />
        {/* Browser access (key mirror) — global enroll/devices entry point (QA H2) */}
        <div className="ds-card" id="set-browser">
          <h3 className="ds-cardh">Read threads in this browser</h3>
          <p className="ds-cardsub">Read and reply to your threads on this site. They are decrypted here in your browser, never on our servers.</p>
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
      </>
    ),

    developer: (
      <>
        <div className="ds-card" style={{ marginBottom: 14 }} id="set-endpoints">
          <h3 className="ds-cardh">Endpoints for agents</h3>
          <p className="ds-cardsub">For wiring an agent up by hand. The easy way is <a className="ds-link" href="/account/remote?add=agent">Devices → Add → An agent</a>, which gives each agent its own key.</p>
          {([
            ["mcp", "MCP endpoint", `${origin}/api/mcp`],
            ["skill", "Skill (what agents read first)", `${origin}/skill`],
            ["reference", "Skill reference", `${origin}/skill/reference`],
          ] as const).map(([key, label, url]) => (
            <div className="ds-item" key={key} style={{ alignItems: "center" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="ds-iname" style={{ fontSize: 13 }}>{label}</div>
                <code className="ds-mono" style={{ fontSize: 12, color: "var(--ds-mut)", overflowWrap: "anywhere" }}>{url}</code>
              </div>
              <div className="ds-iright"><button className="ds-btn ghost" style={{ fontSize: 12 }} onClick={() => copyText(key, url)}>{copiedKey === key ? "Copied ✓" : "Copy"}</button></div>
            </div>
          ))}
          <p className="ds-fine" style={{ margin: "10px 0 0" }}>Every command an agent can use: <a className="ds-link" href="/commands">Commands</a>.</p>
        </div>

        <div className="ds-card">
          <h3 className="ds-cardh">Developer key</h3>
          <p className="ds-cardsub" style={{ margin: 0 }}>One long-lived key for scripts you write yourself. Most people never need it: each agent you connect gets its own key.</p>
          {newKey ? (
            <div className="ds-call acc" style={{ marginTop: 12 }}>
              <p style={{ margin: "0 0 8px", fontWeight: 600 }}>🔑 Your new key. Copy it now; it won&apos;t be shown again:</p>
              <pre className="ds-pre">{newKey}</pre>
              <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                <button className="ds-btn" onClick={() => copyText("newkey", newKey)}>{copiedKey === "newkey" ? "Copied ✓" : "Copy"}</button>
                <button className="ds-btn ghost" onClick={() => { setNewKey(null); window.location.reload(); }}>Done</button>
              </div>
              <p className="ds-fine" style={{ marginTop: 8 }}>Give this to whatever used the old key. The previous key no longer works.</p>
            </div>
          ) : advanced("developer", "show and rotate the developer key", (
            <div id="set-devkey">
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <code className="ds-mono" style={{ background: "#f8fafc", border: "1px solid var(--ds-line)", borderRadius: 8, padding: "6px 10px", fontSize: 13 }}>{m.api_key_masked ?? "—"}</code>
                <button className="ds-btn ghost" onClick={() => rotateKey()} disabled={busy === "key" || demoMode}>{busy === "key" ? "Rotating…" : "Rotate key"}</button>
              </div>
              <p className="ds-fine" style={{ marginTop: 8 }}>Last used {lastUsed}. Only the last 4 characters are ever shown here.{passkeys.state?.connectStepUp === "on" ? " Rotating asks for your passkey." : ""}</p>
              {keyErr && <p className="ds-call danger" style={{ marginTop: 8 }}>⚠ {keyErr}</p>}
              {passkeyFor && (
                <AddPasskeyInline action="Rotating your key" onCancel={() => setPasskeyFor(null)} onAdded={() => { const retry = passkeyFor.retry; setPasskeyFor(null); retry(); }} />
              )}
            </div>
          ))}
        </div>
      </>
    ),

    activity: (
      <div className="ds-card" id="set-activity">
        <h3 className="ds-cardh">Account activity</h3>
        <p className="ds-cardsub">Sign-ins, key changes, trust, and collaboration requests on your own account. Only you can see it.</p>
        {demoMode && <p className="ds-fine">Sign in to see your account&apos;s activity.</p>}
        {!demoMode && !showAudit && <button className="ds-btn ghost" onClick={() => { setShowAudit(true); loadAudit(); }}>Show recent activity</button>}
        {!demoMode && showAudit && audit.length === 0 && <p className="ds-fine">No recent activity.</p>}
        {!demoMode && showAudit && audit.map((e, i) => (
          <div className="ds-item" key={i}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5 }}>{e.label}{e.detail && (e.detail.peer || e.detail.to) ? <span className="ds-imeta"> · {String(e.detail.peer ?? e.detail.to)}</span> : null}</div>
              <div className="ds-imeta">{new Date(e.at).toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>
    ),
  };

  const settingsPane = (
    <>
      <h1 className="ds-h1">Settings</h1>
      <p className="ds-sub">Signed in as <strong>{m.handle}</strong>. The usual settings are up front; the deeper ones sit under &ldquo;Advanced&rdquo; in each section.</p>
      <div className="ds-settings">
        <nav className="ds-snav" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map((s) => (
            <button key={s.key} className={settingsSection === s.key ? "on" : ""} aria-current={settingsSection === s.key ? "page" : undefined}
              onClick={() => { setSettingsSection(s.key); setSaveNote(null); }}>{s.label}</button>
          ))}
        </nav>
        <section aria-labelledby="settings-h">
          <div className="ds-shead">
            <h2 id="settings-h">{sectionInfo.label}</h2>
            <p className="ds-fine" style={{ margin: 0 }}>{sectionInfo.blurb}</p>
          </div>
          {settingsSections[settingsSection]}
        </section>
      </div>
    </>
  );

  /* -------------------------------- render -------------------------------- */

  return (
    <AppShell {...shellProps}>
      <div className="ds-wrap">
        {nav === "home" && home}
        {nav === "messages" && inboxPane}
        {nav === "lists" && <ListsPane demoMode={demoMode} />}
        {nav === "skills" && toolkitPane}
        {nav === "settings" && settingsPane}
        <p className="ds-fine" style={{ marginTop: 28, textAlign: "center" }}>
          <a href="/faq" style={{ color: "var(--ds-mut)" }}>FAQ</a> · <a href="/commands" style={{ color: "var(--ds-mut)" }}>Commands</a> · <a href="/lessons" style={{ color: "var(--ds-mut)" }}>Community tools</a> · <a href="/" style={{ color: "var(--ds-mut)" }}>Home</a>
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
