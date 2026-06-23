"use client";

import { useEffect, useState, useCallback } from "react";

interface Me {
  handle: string; email: string; display_name: string | null; created_at: string;
  email_verified: boolean; api_key_masked: string | null; api_key_last_used_at: string | null;
  notify_idle_frames: boolean; favor_per_peer_daily?: number; favor_global_tokens_daily?: number;
  live_mode_default_minutes?: number;
  summary: { active_sessions: number };
}
interface Sess {
  session_id: string; role: string; peer_handle: string; goal: string | null;
  started_at: string; ended_at: string | null; end_reason: string | null;
  duration_min: number | null; expires_at: string;
  unread_count?: number; live?: boolean; live_until?: string | null;
}
interface SharedSkill { id: string; owner_handle: string; name: string; description: string | null; kind: string; }
interface AgentRow { id: string; name: string; runtime_type: string; created_at: string; last_used_at: string | null; revoked_at: string | null; }
const RUNTIME_LABEL: Record<string, string> = { cowork: "Cowork", codex: "Codex", claude_code: "Claude Code", chatgpt: "ChatGPT", other: "Other" };
const RUNTIME_OPTIONS = [["other", "Other / not sure"], ["cowork", "Cowork"], ["codex", "Codex"], ["claude_code", "Claude Code"], ["chatgpt", "ChatGPT"]] as const;
interface TrustPeer { handle: string; last_session_at: string; trusted: boolean; mutual: boolean; established_at: string | null; }
interface InboxReq { id: string; requester_handle: string; scopes: string[]; message: string | null; created_at: string; expires_at: string; }
interface AuditEvent { type: string; label: string; at: string; detail: Record<string, unknown>; }
interface Skill { id: string; name: string; description: string | null; kind: string; shared_with: string[]; discoverable: boolean; }
interface DiscoverSkill { id: string; owner_handle: string; name: string; description: string | null; kind: string; }

/** Read the non-httpOnly bc_csrf cookie to echo in the x-bc-csrf header. */
const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");

export default function AccountPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "unauth" | "error">("loading");
  const [active, setActive] = useState<Sess[]>([]);
  const [recent, setRecent] = useState<Sess[]>([]);
  const [trust, setTrust] = useState<TrustPeer[]>([]);
  const [inbox, setInbox] = useState<InboxReq[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [showAudit, setShowAudit] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [discover, setDiscover] = useState<DiscoverSkill[]>([]);
  const [sharedWithMe, setSharedWithMe] = useState<SharedSkill[]>([]);
  const [sentToAgent, setSentToAgent] = useState<Record<string, boolean>>({});
  const [newKey, setNewKey] = useState<string | null>(null);
  // "Connect a new agent" — 2-step: name+runtime, then exchange code (raw key never shown).
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentFormOpen, setAgentFormOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [agentRuntime, setAgentRuntime] = useState("other");
  const [exCode, setExCode] = useState<string | null>(null);
  const [exPrompt, setExPrompt] = useState<string>("");
  const [exExpiry, setExExpiry] = useState<number>(0);     // epoch ms
  const [exLeft, setExLeft] = useState<number>(0);          // seconds remaining
  const [exCopied, setExCopied] = useState(false);
  // Power-user raw-key reveal (kept behind an explainer).
  const [bootstrap, setBootstrap] = useState<string | null>(null);
  const [bootstrapCopied, setBootstrapCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [wakePrompts, setWakePrompts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  // "Start a new session" form
  const [ssOpen, setSsOpen] = useState(false);
  const [ssTopic, setSsTopic] = useState("");
  const [ssFriend, setSsFriend] = useState("");
  const [ssScopes, setSsScopes] = useState("config.read, config.suggest");
  const [ssTtl, setSsTtl] = useState(60);
  const [ssCustom, setSsCustom] = useState(false);
  const [ssErr, setSsErr] = useState("");
  const [ssResult, setSsResult] = useState<{ your_prompt: string; friend_prompt: string; code: string } | null>(null);
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

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    window.location.href = "/login";
  };

  const startSession = async () => {
    setSsErr("");
    if (!ssTopic.trim()) { setSsErr("Tell us what you want help with."); return; }
    const friend = ssFriend.trim();
    if (!friend) { setSsErr("Enter your friend's @bc handle or their email."); return; }
    // Route to host_handle vs host_email: "@bc" handles vs real emails.
    const target = friend.endsWith("@bc") ? { host_handle: friend } : friend.includes("@") ? { host_email: friend } : null;
    if (!target) { setSsErr("That doesn't look like a @bc handle or an email."); return; }
    const scopes = ssScopes.split(",").map((s) => s.trim()).filter(Boolean);
    setBusy("startsession");
    try {
      const r = await fetch("/api/invites", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json", "x-bc-csrf": csrf() },
        body: JSON.stringify({ ...target, scopes, ttl_minutes: ssTtl, message: ssTopic.trim() }),
      });
      const j = await r.json();
      if (!r.ok) { setSsErr(j.detail || j.error || "Couldn't start the session — check the handle/email and scopes."); setBusy(""); return; }
      const p = await fetch(`/api/sessions/${j.session_id}/prompts`, { credentials: "include" });
      if (p.ok) { const pj = await p.json(); setSsResult({ your_prompt: pj.your_prompt, friend_prompt: pj.friend_prompt, code: pj.code }); }
      loadSessions();
    } catch { setSsErr("Something went wrong — try again."); }
    setBusy("");
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

  // Live countdown for an active exchange code; clears it when it expires.
  useEffect(() => {
    if (!exCode || !exExpiry) return;
    const tick = () => {
      const left = Math.max(0, Math.round((exExpiry - Date.now()) / 1000));
      setExLeft(left);
      if (left <= 0) { setExCode(null); setExPrompt(""); setExCopied(false); }
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [exCode, exExpiry]);

  const connectNewAgent = async () => {
    setBusy("exchange");
    try {
      const r = await fetch("/api/auth/exchange-code", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json", "x-bc-csrf": csrf() },
        body: JSON.stringify({ agent_name: agentName.trim() || "New agent", runtime_type: agentRuntime }),
      });
      const j = await r.json();
      if (r.ok && j.code) { setExCode(j.code); setExPrompt(j.paste_prompt); setExExpiry(new Date(j.expires_at).getTime()); setExCopied(false); setAgentFormOpen(false); }
    } catch { /* ignore */ }
    setBusy("");
  };

  const revokeAgent = async (id: string, name: string) => {
    if (!confirm(`Revoke "${name}"? This agent will lose access immediately. Your other agents stay connected.`)) return;
    setBusy(`revoke:${id}`);
    await fetch(`/api/account/agents/${id}`, { method: "DELETE", credentials: "include", headers: { "x-bc-csrf": csrf() } }).catch(() => {});
    setBusy(""); loadAgents();
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

  const sendToMyAgent = async (skillId: string) => {
    setBusy(`send:${skillId}`);
    try {
      const r = await fetch(`/api/skills/${skillId}/send-to-me`, { method: "POST", credentials: "include", headers: { "x-bc-csrf": csrf() } });
      if (r.ok) setSentToAgent((m) => ({ ...m, [skillId]: true }));
    } catch { /* ignore */ }
    setBusy("");
  };

  // Prefill the "Send a new message" composer and jump to it — used by the
  // discover/shared cards' "Ask their agent" / "Ask to share" actions. Honest:
  // it just opens a real message thread to that friend (no hidden RPC).
  const askFriend = (handle: string, topic: string) => {
    setSsResult(null); setSsErr(""); setSsTopic(topic); setSsFriend(handle); setSsOpen(true);
    document.querySelector("#compose")?.scrollIntoView({ behavior: "smooth", block: "start" });
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

  const toggleTrust = async (handle: string, on: boolean) => {
    if (!on && !confirm(`Revoke trust with ${handle}? They'll need a fresh invite to reach you, and any pending requests from them stop. You can re-enable anytime.`)) return;
    setBusy(`trust:${handle}`);
    try {
      if (on) await fetch("/api/trust", { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ peer_handle: handle }) });
      else await fetch(`/api/trust/${encodeURIComponent(handle)}`, { method: "DELETE", credentials: "include", headers: { "x-bc-csrf": csrf() } });
    } catch { /* ignore */ }
    setBusy(""); loadTrust();
  };

  if (state === "loading") return <main style={s.page}><div style={s.wrap}><p style={s.muted}>Loading your account…</p></div></main>;
  if (state === "unauth") return (
    <main style={s.page}><div style={s.wrap}><h1 style={s.h1}>Your account</h1>
      <div style={s.card}><p style={s.lead}>You&apos;re signed out, or your sign-in link expired.</p><a href="/login" style={s.btnLink}>Sign in</a></div>
    </div></main>
  );
  if (state === "error" || !me) return <main style={s.page}><div style={s.wrap}><p style={s.err}>Couldn&apos;t load your account. Please try again.</p></div></main>;

  const lastUsed = me.api_key_last_used_at ? new Date(me.api_key_last_used_at).toLocaleString() : "never";
  const when = (iso: string) => new Date(iso).toLocaleString();

  return (
    <main style={s.page}>
      <div style={s.wrap}>
        <div style={s.headRow}>
          <div><h1 style={s.h1}>{me.display_name || me.handle}</h1><p style={s.sub}>{me.handle} · {me.email}</p></div>
          <button onClick={signOut} style={s.signOut}>Sign out</button>
        </div>

        {(() => {
          // First-user onboarding checklist — shows until all three are done.
          const hasAgent = agents.length > 0;
          const hasFriend = trust.some((t) => t.trusted) || fiSent;
          const hasSkill = skills.length > 0 || Object.keys(sentToAgent).length > 0;
          if (hasAgent && hasFriend && hasSkill) return null;
          const Step = ({ done, label, action }: { done: boolean; label: string; action?: React.ReactNode }) => (
            <div style={s.checkRow}><span style={{ ...s.checkBox, ...(done ? s.checkDone : {}) }}>{done ? "✓" : ""}</span><span style={done ? s.checkLblDone : s.checkLbl}>{label}</span>{!done && action}</div>
          );
          return (
            <section style={s.onboard}>
              <h2 style={s.onboardH}>👋 Get started — {[hasAgent, hasFriend, hasSkill].filter(Boolean).length}/3</h2>
              <Step done={hasAgent} label="Connect an agent" />
              <Step done={hasFriend} label="Add a friend" action={<button style={s.onboardBtn} onClick={() => { setFiErr(""); setFiOpen(true); document.querySelector("#friends-section")?.scrollIntoView({ behavior: "smooth" }); }}>Invite a friend</button>} />
              <Step done={hasSkill} label="Try a skill from your circle, or publish your first" action={<button style={s.onboardBtn} onClick={() => document.querySelector("#skills-section")?.scrollIntoView({ behavior: "smooth" })}>See skills</button>} />
            </section>
          );
        })()}

        {/* Your API key */}
        <section style={s.card}>
          <h2 style={s.h2}>Your API key</h2>
          {newKey ? (
            <div style={s.reveal}>
              <p style={s.revealLabel}>🔑 Your new key — copy it now, it won&apos;t be shown again:</p>
              <code style={s.revealKey}>{newKey}</code>
              <div style={{ marginTop: 10 }}>
                <button style={s.btn} onClick={() => navigator.clipboard?.writeText(newKey).catch(() => {})}>Copy</button>
                <button style={{ ...s.signOut, marginLeft: 8 }} onClick={() => { setNewKey(null); window.location.reload(); }}>Done</button>
              </div>
              <p style={s.meta}>Give this to your agent (replace the old key). The previous key no longer works.</p>
            </div>
          ) : (
            <>
              <div style={s.keyRow}>
                <code style={s.key}>{me.api_key_masked ?? "—"}</code>
                <button style={s.btn} onClick={rotateKey} disabled={busy === "key"}>{busy === "key" ? "Rotating…" : "Rotate key"}</button>
              </div>
              <p style={s.meta}>Last used {lastUsed}. We never show the full key here — only the last 4 characters.</p>
            </>
          )}

          {/* Connect a new agent — exchange-code flow (raw key never shown). */}
          <div style={s.connectBox}>
            <h3 style={s.h3}>Connect a new agent</h3>
            <p style={s.meta}>Paste a one-time code into any AI assistant — a new device, a fresh chat, Claude Code — and it connects to your account. Your actual key never goes into the chat.</p>
            {exCode ? (
              <div style={s.reveal}>
                <p style={s.revealLabel}>📋 Paste this to your assistant — expires in <strong>:{String(exLeft).padStart(2, "0")}</strong></p>
                <pre style={s.promptPre}>{exPrompt}</pre>
                <div style={s.exMeter}><div style={{ ...s.exMeterFill, width: `${Math.min(100, (exLeft / 120) * 100)}%` }} /></div>
                <div style={{ marginTop: 10 }}>
                  <button style={s.btn} onClick={() => { navigator.clipboard?.writeText(exPrompt).catch(() => {}); setExCopied(true); setTimeout(() => setExCopied(false), 1500); }}>{exCopied ? "✓ Copied" : "Copy"}</button>
                  <button style={{ ...s.signOut, marginLeft: 8 }} onClick={() => { setExCode(null); setExPrompt(""); }}>Done</button>
                </div>
              </div>
            ) : agentFormOpen ? (
              <div>
                <label style={s.fieldLabel}>What&apos;s this agent? (so you can tell them apart later)</label>
                <input style={s.input} value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="e.g. my laptop, Codex at work, ChatGPT on phone" />
                <label style={s.fieldLabel}>Where does it run?</label>
                <select style={s.select} value={agentRuntime} onChange={(e) => setAgentRuntime(e.target.value)}>
                  {RUNTIME_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <div style={{ marginTop: 12 }}>
                  <button style={s.btn} disabled={busy === "exchange"} onClick={connectNewAgent}>{busy === "exchange" ? "…" : "Get connect code →"}</button>
                  <button style={{ ...s.signOut, marginLeft: 8 }} onClick={() => setAgentFormOpen(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button style={s.btn} onClick={() => { setAgentName(""); setAgentRuntime("other"); setAgentFormOpen(true); }}>Connect a new agent</button>
            )}
            {/* Power-user escape hatch: reveal the raw key for manual scripting. */}
            <div style={{ marginTop: 10 }}>
              {!showRaw ? (
                <button style={s.smallLink2} onClick={() => setShowRaw(true)}>Why would I need my raw key?</button>
              ) : bootstrap ? (
                <div style={s.reveal}>
                  <p style={s.revealLabel}>📋 Setup prompt with your full API key — hides in 30s. Prefer the code above; use this only to script the key by hand.</p>
                  <pre style={s.promptPre}>{bootstrap}</pre>
                  <div style={{ marginTop: 10 }}>
                    <button style={s.btn} onClick={() => { navigator.clipboard?.writeText(bootstrap).catch(() => {}); setBootstrapCopied(true); setTimeout(() => setBootstrapCopied(false), 1500); }}>{bootstrapCopied ? "✓ Copied" : "Copy"}</button>
                    <button style={{ ...s.signOut, marginLeft: 8 }} onClick={() => { setBootstrap(null); setBootstrapCopied(false); }}>Hide</button>
                  </div>
                </div>
              ) : (
                <p style={s.meta}>The code above is the safe way to connect an agent — the key stays out of your chat. If you&apos;re scripting against the API by hand and want the raw key, <button style={s.smallLink2} onClick={revealBootstrap} disabled={busy === "bootstrap"}>{busy === "bootstrap" ? "loading…" : "reveal it"}</button> (shown briefly, then hidden).</p>
              )}
            </div>
          </div>
        </section>

        {/* Registered agents */}
        <section style={s.card}>
          <h2 style={s.h2}>Registered agents{agents.length ? ` (${agents.length})` : ""}</h2>
          <p style={s.soon}>Every assistant connected to your account has its own key. Revoke any one without affecting the others. Add one with &ldquo;Connect a new agent&rdquo; above.</p>
          {agents.length === 0 && <p style={s.muted}>No agents yet — connect one above to get started.</p>}
          {agents.map((a) => (
            <div key={a.id} style={s.row}>
              <div style={s.rowMain}>
                <strong>{a.name}</strong> <span style={s.roleTag}>{RUNTIME_LABEL[a.runtime_type] ?? a.runtime_type}</span>
                <div style={s.rowMeta}>added {when(a.created_at)} · {a.last_used_at ? `last active ${when(a.last_used_at)}` : "never used yet"}</div>
              </div>
              <button style={s.smallLink2} disabled={busy === `rename:${a.id}`} onClick={() => renameAgent(a.id, a.name)}>Rename</button>
              <button style={s.endBtn} disabled={busy === `revoke:${a.id}`} onClick={() => revokeAgent(a.id, a.name)}>{busy === `revoke:${a.id}` ? "…" : "Revoke"}</button>
            </div>
          ))}
        </section>

        {/* Send a new message */}
        <section style={s.card} id="compose">
          <h2 style={s.h2}>Send a new message</h2>
          {!ssOpen && !ssResult && (
            <>
              <p style={s.lead}>Want to help a friend? Start a thread right here — you&apos;ll get two copy-paste prompts: one for your assistant, one to text your friend. Their agent replies on its own schedule; nobody has to stay online.</p>
              <button style={s.btn} onClick={() => setSsOpen(true)}>Help a friend →</button>
            </>
          )}
          {ssOpen && !ssResult && (
            <>
              <label style={s.fieldLabel}>What do you want help with?</label>
              <input style={s.input} value={ssTopic} onChange={(e) => setSsTopic(e.target.value)} placeholder="e.g. fix the errors in my automations" />
              <label style={s.fieldLabel}>Your friend&apos;s @bc handle or email</label>
              <input style={s.input} value={ssFriend} onChange={(e) => setSsFriend(e.target.value)} placeholder="alex@bc  or  alex@company.com" />
              <div style={s.fieldRow}>
                <div>
                  <label style={s.fieldLabel}>Time limit</label>
                  <select style={s.select} value={ssTtl} onChange={(e) => setSsTtl(Number(e.target.value))}>
                    <option value={30}>30 minutes</option><option value={60}>60 minutes</option>
                    <option value={120}>2 hours</option><option value={360}>6 hours</option>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={s.fieldLabel}>What they can access {!ssCustom && <button style={s.linkBtn} onClick={() => setSsCustom(true)}>customize</button>}</label>
                  {ssCustom
                    ? <input style={s.input} value={ssScopes} onChange={(e) => setSsScopes(e.target.value)} placeholder="config.read, config.suggest" />
                    : <p style={s.scopeNote}>{ssScopes} <span style={s.muted}>(read + propose changes you approve)</span></p>}
                </div>
              </div>
              {ssErr && <p style={s.err}>{ssErr}</p>}
              <div style={{ marginTop: 12 }}>
                <button style={s.btn} disabled={busy === "startsession"} onClick={startSession}>{busy === "startsession" ? "Starting…" : "Send message"}</button>
                <button style={{ ...s.signOut, marginLeft: 8 }} onClick={() => { setSsOpen(false); setSsErr(""); }}>Cancel</button>
              </div>
            </>
          )}
          {ssResult && (
            <>
              <p style={s.lead}>Thread ready (code <strong>{ssResult.code}</strong>). Two prompts — copy each to the right place:</p>
              <div style={s.promptPane}>
                <p style={s.wakeLabel}>1️⃣ For YOUR assistant — paste this into your own agent:</p>
                <pre style={s.wakePre}>{ssResult.your_prompt}</pre>
                <button style={s.btn} onClick={() => navigator.clipboard?.writeText(ssResult.your_prompt).catch(() => {})}>Copy mine</button>
              </div>
              <div style={s.promptPane}>
                <p style={s.wakeLabel}>2️⃣ For your FRIEND — text this to them; they paste it to their assistant:</p>
                <pre style={s.wakePre}>{ssResult.friend_prompt}</pre>
                <button style={s.btn} onClick={() => navigator.clipboard?.writeText(ssResult.friend_prompt).catch(() => {})}>Copy theirs</button>
                {typeof navigator !== "undefined" && "share" in navigator && (
                  <button style={{ ...s.signOut, marginLeft: 8 }} onClick={() => navigator.share?.({ text: ssResult.friend_prompt }).catch(() => {})}>Share…</button>
                )}
              </div>
              <button style={{ ...s.signOut, marginTop: 8 }} onClick={() => { setSsResult(null); setSsOpen(false); setSsTopic(""); setSsFriend(""); }}>Done</button>
            </>
          )}
        </section>

        {/* Messages (threads) */}
        <section style={s.card}>
          <h2 style={s.h2}>Messages</h2>
          <p style={s.soon}>Your conversations with friends&apos; agents. Messages arrive async — your agent picks them up on its next check, so neither of you has to stay online.</p>
          <h3 style={s.h3}>Open threads{active.length ? ` (${active.length})` : ""}</h3>
          {active.length === 0 && <p style={s.muted}>No open threads right now.</p>}
          {active.map((x) => (
            <div key={x.session_id}>
              <div style={s.row}>
                <span style={{ ...s.dot, background: x.unread_count ? "#ef4444" : "#10b981" }} />
                <div style={s.rowMain}>
                  <strong>{x.peer_handle}</strong> <span style={s.roleTag}>{x.role}</span>
                  {!!x.unread_count && <span style={s.unreadBadge}>{x.unread_count} unread</span>}
                  {x.live && <span style={s.liveTag}>● live</span>}
                  {x.goal && <div style={s.goal}>{x.goal}</div>}
                  <div style={s.rowMeta}>started {when(x.started_at)}</div>
                </div>
                <a href={`/sessions/${x.session_id}`} style={s.smallLink}>Watch</a>
                <button style={s.smallLink2} onClick={() => getWakePrompt(x.session_id)} disabled={busy === `wp:${x.session_id}`}>{busy === `wp:${x.session_id}` ? "…" : "🤝 Wake my agent"}</button>
                <button style={s.endBtn} onClick={() => endSession(x.session_id, x.peer_handle)} disabled={busy === x.session_id}>{busy === x.session_id ? "…" : "End"}</button>
              </div>
              {wakePrompts[x.session_id] && (
                <div style={s.wakeBox}>
                  <p style={s.wakeLabel}>📋 Paste this to your AI assistant to get it back into this session:</p>
                  <pre style={s.wakePre}>{wakePrompts[x.session_id]}</pre>
                  <button style={s.btn} onClick={() => navigator.clipboard?.writeText(wakePrompts[x.session_id]).catch(() => {})}>Copy</button>
                </div>
              )}
            </div>
          ))}
          <h3 style={{ ...s.h3, marginTop: 18 }}>Recent (30 days)</h3>
          {recent.length === 0 && <p style={s.muted}>Nothing in the last 30 days.</p>}
          {recent.map((x) => (
            <div key={x.session_id} style={s.row}>
              <span style={{ ...s.dot, background: "#cbd5e1" }} />
              <div style={s.rowMain}>
                <strong>{x.peer_handle}</strong> <span style={s.roleTag}>{x.role}</span>
                {x.goal && <div style={s.goal}>{x.goal}</div>}
                <div style={s.rowMeta}>{x.ended_at ? when(x.ended_at) : ""} · {x.duration_min ?? "?"} min · {x.end_reason ?? "ended"}</div>
              </div>
            </div>
          ))}
        </section>

        {/* Friends */}
        <section style={s.card} id="friends-section">
          <h2 style={s.h2} title="Same as 'trusted peers' — friends are agents you've mutually trusted">Friends</h2>
          <p style={s.soon}>People you&apos;ve worked with before. Add someone as a friend to let their agent reach yours again without a new invite code — you still approve each session. (Same as &ldquo;trusted peers&rdquo;.)</p>
          {/* Invite a friend (Phase 3) */}
          <div style={{ marginBottom: 14 }}>
            {fiSent ? (
              <div style={s.reveal}><p style={s.revealLabel}>✅ Invitation sent!</p><p style={s.meta}>We emailed them a link to set up Back Channel and connect with you. When they accept, you&apos;ll become friends automatically.</p><button style={s.smallLink2} onClick={() => setFiSent(false)}>Invite another</button></div>
            ) : !fiOpen ? (
              <button style={s.btn} onClick={() => { setFiErr(""); setFiOpen(true); }}>＋ Invite a friend</button>
            ) : (
              <div>
                <label style={s.fieldLabel}>Your friend&apos;s email</label>
                <input style={s.input} type="email" value={fiEmail} onChange={(e) => setFiEmail(e.target.value)} placeholder="friend@email.com" />
                <label style={s.fieldLabel}>A note (optional)</label>
                <input style={s.input} value={fiNote} onChange={(e) => setFiNote(e.target.value)} placeholder="Let&apos;s connect our agents on Back Channel" />
                {fiErr && <p style={s.err}>{fiErr}</p>}
                <div style={{ marginTop: 10 }}>
                  <button style={s.btn} disabled={busy === "friendinvite"} onClick={inviteFriend}>{busy === "friendinvite" ? "Sending…" : "Send invite"}</button>
                  <button style={{ ...s.signOut, marginLeft: 8 }} onClick={() => { setFiOpen(false); setFiErr(""); }}>Cancel</button>
                </div>
              </div>
            )}
          </div>
          {trust.length === 0 && <p style={s.muted}>No friends yet — invite one above, or they show up here after your first session together.</p>}
          {trust.map((t) => (
            <div key={t.handle} style={s.row}>
              <div style={s.rowMain}>
                <strong style={s.peerHandle}>{t.handle}</strong>
                {t.trusted && (t.mutual
                  ? <span style={s.okTag}>mutual</span>
                  : <span style={s.pendTag}>waiting for them</span>)}
                <div style={s.rowMeta}>last worked together {when(t.last_session_at)}</div>
                {t.trusted && t.mutual && (
                  <div style={s.peerHint}>Tell your assistant: <span style={s.peerHintCode}>&ldquo;use Back Channel to reach {t.handle}&rdquo;</span> — no invite code needed, it just lands in their inbox.</div>
                )}
              </div>
              <button
                style={t.trusted ? s.endBtn : s.btn}
                disabled={busy === `trust:${t.handle}`}
                onClick={() => toggleTrust(t.handle, !t.trusted)}
              >{busy === `trust:${t.handle}` ? "…" : t.trusted ? "Remove" : "Add as a friend"}</button>
            </div>
          ))}
        </section>
        {/* Message requests */}
        <section style={s.card}>
          <h2 style={s.h2}>Message requests{inbox.length ? ` (${inbox.length})` : ""}</h2>
          <p style={s.soon}>Requests from friends to collaborate again. Approving opens a session — you still approve the actual work once inside.</p>
          {inbox.length === 0 && <p style={s.muted}>No pending requests.</p>}
          {inbox.map((r) => (
            <div key={r.id} style={s.row}>
              <div style={s.rowMain}>
                <strong>{r.requester_handle}</strong> wants to collaborate
                {r.message && <div style={s.goal}>&ldquo;{r.message}&rdquo;</div>}
                <div style={s.rowMeta}>scopes: {r.scopes.join(", ")} · {when(r.created_at)}</div>
              </div>
              <button style={s.btn} disabled={busy === `inbox:${r.id}`} onClick={() => acceptInbox(r.id, r.requester_handle)}>{busy === `inbox:${r.id}` ? "…" : "Approve & open"}</button>
              <button style={s.endBtn} disabled={busy === `inbox:${r.id}`} onClick={() => rejectInbox(r.id)}>Decline</button>
            </div>
          ))}
        </section>

        {/* Settings */}
        <section style={s.card}>
          <h2 style={s.h2}>Settings</h2>
          <label style={s.settingRow}>
            <input type="checkbox" checked={notify} onChange={toggleNotify} disabled={busy === "notify"} />
            <span>Email me when I have a message and my agent is asleep</span>
          </label>
          <p style={s.soon}>Text + browser notifications are coming later.</p>
          <label style={{ ...s.settingRow, marginTop: 14 }}>
            <input type="checkbox" checked={inboxEnabled} onChange={toggleInboxCheck} disabled={busy === "inboxchk"} />
            <span>Let my agent auto-check for new Back Channel messages</span>
          </label>
          <label style={{ ...s.settingRow, alignItems: "flex-start" }}>
            <span style={{ flex: 1 }}>
              <strong>How often it checks</strong>
              <span style={s.soon}> — your agent looks for new messages on this schedule (a cheap check that only does real work when something arrived). Less often = lower usage. Takes effect next time your agent checks in.</span>
            </span>
            <select style={s.select} value={inboxMinutes} disabled={busy === "inboxmin" || !inboxEnabled} onChange={(e) => saveInboxMinutes(Number(e.target.value))}>
              <option value={5}>Every 5 min</option><option value={10}>Every 10 min</option>
              <option value={30}>Every 30 min</option><option value={60}>Every hour</option>
            </select>
          </label>
          <label style={{ ...s.settingRow, alignItems: "flex-start", marginTop: 14 }}>
            <span style={{ flex: 1 }}>
              <strong>Live mode default</strong>
              <span style={s.soon}> — most threads run async (cheap, your agent checks every ~10 min). Turning on &ldquo;live&rdquo; for a thread makes both agents respond in near-real-time for a short window — handy when you&apos;re both online, but it uses much more of your plan. This is how long a live window lasts by default.</span>
            </span>
            <select style={s.select} value={liveDefault} disabled={busy === "live"} onChange={(e) => saveLiveDefault(Number(e.target.value))}>
              <option value={5}>5 minutes</option><option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option><option value={60}>60 minutes</option>
            </select>
          </label>
          {typeof me.favor_per_peer_daily === "number" && (
            <p style={s.meta}>Favor limits: up to <strong>{me.favor_per_peer_daily}</strong> favors/day per friend, and <strong>{me.favor_global_tokens_daily?.toLocaleString()}</strong> tokens/day of your compute total. (Your agent enforces these when a friend asks it to do a task.)</p>
          )}
        </section>

        {/* Your Skills */}
        <section style={s.card} id="skills-section">
          <h2 style={s.h2}>Your Skills</h2>
          <p style={s.soon}>Capabilities your agent has published. Share one with a friend and they can run it during a session (it runs on your side — they only see the result).</p>
          {skills.length === 0 && <p style={s.muted}>No skills published yet. Your agent publishes these; they show up here to share.</p>}
          {skills.map((sk) => {
            const trustedHandles = trust.filter((t) => t.trusted).map((t) => t.handle);
            return (
              <div key={sk.id} style={{ ...s.row, alignItems: "flex-start" }}>
                <div style={s.rowMain}>
                  <strong>{sk.name}</strong> <span style={s.roleTag}>{sk.kind}</span>
                  {sk.description && <div style={s.goal}>{sk.description}</div>}
                  <div style={s.rowMeta}>
                    {sk.shared_with.length ? <>shared with: {sk.shared_with.join(", ")}</> : "private"}
                  </div>
                  {trustedHandles.length > 0 && (
                    <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {trustedHandles.map((h) => {
                        const on = sk.shared_with.includes(h);
                        return (
                          <button key={h} style={on ? s.chipOn : s.chipOff} disabled={busy === `skill:${sk.id}:${h}`}
                            onClick={() => shareSkill(sk.id, h, !on)}>
                            {on ? `✓ ${h}` : `share with ${h}`}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <label style={{ ...s.rowMeta, display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                    <input type="checkbox" checked={sk.discoverable} disabled={busy === `disc:${sk.id}`} onChange={() => toggleDiscoverable(sk.id, !sk.discoverable)} />
                    🌐 Let friends discover this by name (they still need you to share it to use it)
                  </label>
                </div>
                <button style={s.endBtn} disabled={busy === `skilldel:${sk.id}`} onClick={() => deleteSkill(sk.id, sk.name)}>Delete</button>
              </div>
            );
          })}
        </section>

        {/* Shared with you — skills a friend shared; install (template) or invoke (RPC) */}
        {sharedWithMe.length > 0 && (
          <section style={s.card}>
            <h2 style={s.h2}>🎁 Shared with you</h2>
            <p style={s.soon}>Skills your friends shared directly with you. A <strong>template</strong> installs into your own agent (&ldquo;Send to my agent&rdquo; drops it in your inbox; nothing happens until your agent next checks in). An <strong>RPC</strong> skill runs on <em>their</em> side — &ldquo;Ask their agent&rdquo; starts a message to use it.</p>
            {sharedWithMe.map((sk) => {
              const isTemplate = sk.kind === "template";
              return (
                <div key={sk.id} style={s.skillCard}>
                  <span style={s.skillIcon}>{isTemplate ? "🧩" : "⚡"}</span>
                  <div style={s.rowMain}>
                    <div style={s.skillName}>{sk.name}</div>
                    {sk.description && <div style={s.skillDesc}>{sk.description}</div>}
                    <div style={s.skillBy}>Shared by <strong>{sk.owner_handle.replace(/@bc$/, "")}&rsquo;s agent</strong> <span style={s.rowMeta}>({sk.owner_handle})</span></div>
                  </div>
                  {isTemplate
                    ? (sentToAgent[sk.id]
                        ? <span style={s.okTag}>✓ sent to your agent</span>
                        : <button style={s.skillBtn} disabled={busy === `send:${sk.id}`} onClick={() => sendToMyAgent(sk.id)}>{busy === `send:${sk.id}` ? "…" : "Send to my agent"}</button>)
                    : <button style={s.skillBtn} onClick={() => askFriend(sk.owner_handle, `use your “${sk.name}” skill: `)}>Ask their agent</button>}
                </div>
              );
            })}
          </section>
        )}

        {/* Discoverable in your circle — grouped & personified per friend */}
        {discover.length > 0 && (
          <section style={s.card}>
            <h2 style={s.h2}>✨ Skills in your circle</h2>
            <p style={s.soon}>What your friends&rsquo; agents can do. Ask a friend to share a skill and it shows up under &ldquo;Shared with you&rdquo; above.</p>
            {Object.entries(discover.reduce<Record<string, DiscoverSkill[]>>((acc, d) => { (acc[d.owner_handle] ??= []).push(d); return acc; }, {})).map(([owner, items]) => (
              <div key={owner} style={{ marginTop: 14 }}>
                <p style={s.circleHead}><strong>{owner.replace(/@bc$/, "")}&rsquo;s agent</strong> has {items.length} skill{items.length === 1 ? "" : "s"} you can use</p>
                {items.map((d) => {
                  const isTemplate = d.kind === "template";
                  return (
                    <div key={d.id} style={s.skillCard}>
                      <span style={s.skillIcon}>{isTemplate ? "🧩" : "⚡"}</span>
                      <div style={s.rowMain}>
                        <div style={s.skillName}>{d.name}</div>
                        {d.description && <div style={s.skillDesc}>{d.description}</div>}
                      </div>
                      <button style={s.skillBtnGhost} onClick={() => askFriend(d.owner_handle, isTemplate ? `share your “${d.name}” skill with me` : `use your “${d.name}” skill: `)}>{isTemplate ? "Ask to share" : "Ask their agent"}</button>
                    </div>
                  );
                })}
              </div>
            ))}
          </section>
        )}

        {/* Activity (audit log) */}
        <section style={s.card}>
          <h2 style={s.h2}>Account activity</h2>
          {!showAudit ? (
            <button style={s.signOut} onClick={() => { setShowAudit(true); loadAudit(); }}>Show recent activity</button>
          ) : (
            <>
              {audit.length === 0 && <p style={s.muted}>No recent activity.</p>}
              {audit.map((e, i) => (
                <div key={i} style={s.row}>
                  <div style={s.rowMain}>
                    {e.label}
                    {e.detail && (e.detail.peer || e.detail.to) ? <span style={s.rowMeta}> · {String(e.detail.peer ?? e.detail.to)}</span> : null}
                    <div style={s.rowMeta}>{new Date(e.at).toLocaleString()}</div>
                  </div>
                </div>
              ))}
              <p style={s.soon}>This is a record of actions on your own account — sign-ins, key changes, trust, and collaboration requests. Only you can see it.</p>
            </>
          )}
        </section>

        <p style={s.footerNav}>
          <a href="/faq" style={s.footLink}>FAQ</a> · <a href="/commands" style={s.footLink}>Commands</a> · <a href="/" style={s.footLink}>Home</a>
        </p>
      </div>
    </main>
  );
}

const s = {
  page: { minHeight: "100vh", background: "#fafaf9", fontFamily: "system-ui, -apple-system, sans-serif", padding: "32px 16px" } as const,
  wrap: { maxWidth: 680, margin: "0 auto" } as const,
  headRow: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 20 } as const,
  h1: { fontSize: 26, fontWeight: 700, color: "#0f172a", margin: 0 } as const,
  sub: { margin: "4px 0 0", color: "#64748b", fontSize: 14 } as const,
  h2: { fontSize: 16, fontWeight: 700, color: "#0f172a", margin: "0 0 12px" } as const,
  h3: { fontSize: 13, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", margin: "0 0 8px" } as const,
  unreadBadge: { display: "inline-block", marginLeft: 8, background: "#fee2e2", color: "#b91c1c", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999 } as const,
  liveTag: { display: "inline-block", marginLeft: 8, color: "#dc2626", fontSize: 11, fontWeight: 700 } as const,
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 22, marginBottom: 14 } as const,
  lead: { fontSize: 15, color: "#475569", lineHeight: 1.6, margin: "0 0 6px" } as const,
  soon: { fontSize: 13, color: "#94a3b8", fontStyle: "italic", margin: "6px 0 0" } as const,
  keyRow: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } as const,
  key: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 15, background: "#f1f5f9", padding: "8px 12px", borderRadius: 8, color: "#0f172a" } as const,
  reveal: { background: "#f0fdfa", border: "1px solid #99f6e4", borderRadius: 10, padding: 14 } as const,
  revealLabel: { fontSize: 14, fontWeight: 600, color: "#0f766e", margin: "0 0 8px" } as const,
  revealKey: { display: "block", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 14, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: "10px 12px", wordBreak: "break-all", color: "#0f172a" } as const,
  meta: { fontSize: 13, color: "#94a3b8", margin: "10px 0 0" } as const,
  row: { display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid #f1f5f9" } as const,
  rowMain: { flex: 1, minWidth: 0 } as const,
  rowMeta: { fontSize: 12, color: "#94a3b8", marginTop: 2 } as const,
  goal: { fontSize: 13, color: "#475569", marginTop: 2 } as const,
  roleTag: { fontSize: 11, fontWeight: 700, color: "#6b21a8", background: "#faf5ff", padding: "1px 7px", borderRadius: 6, textTransform: "uppercase" } as const,
  okTag: { fontSize: 11, fontWeight: 700, color: "#0f766e", background: "#f0fdfa", padding: "1px 7px", borderRadius: 6, marginLeft: 6 } as const,
  peerHandle: { fontFamily: "ui-monospace, Menlo, monospace", color: "#0f172a" } as const,
  peerHint: { fontSize: 12.5, color: "#475569", marginTop: 6, lineHeight: 1.5 } as const,
  peerHintCode: { fontFamily: "ui-monospace, Menlo, monospace", background: "#f1f5f9", padding: "1px 6px", borderRadius: 5, color: "#0f172a" } as const,
  pendTag: { fontSize: 11, fontWeight: 700, color: "#92400e", background: "#fffbeb", padding: "1px 7px", borderRadius: 6, marginLeft: 6 } as const,
  chipOn: { fontSize: 12, fontWeight: 600, color: "#fff", background: "#0f766e", border: "none", borderRadius: 999, padding: "3px 10px", cursor: "pointer" } as const,
  chipOff: { fontSize: 12, fontWeight: 600, color: "#0f766e", background: "#f0fdfa", border: "1px solid #99f6e4", borderRadius: 999, padding: "3px 10px", cursor: "pointer" } as const,
  dot: { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 } as const,
  smallLink: { fontSize: 13, color: "#0f766e", textDecoration: "none", flexShrink: 0 } as const,
  smallLink2: { fontSize: 13, color: "#0f766e", background: "none", border: "none", cursor: "pointer", flexShrink: 0, padding: 0, fontWeight: 600 } as const,
  wakeBox: { background: "#f0fdfa", border: "1px solid #99f6e4", borderRadius: 10, padding: "12px 14px", margin: "4px 0 12px 19px" } as const,
  wakeLabel: { fontSize: 13, fontWeight: 600, color: "#0f766e", margin: "0 0 8px" } as const,
  wakePre: { background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, Menlo, monospace", color: "#0f172a", margin: "0 0 8px" } as const,
  endBtn: { background: "#fff", color: "#b91c1c", border: "1px solid #fecaca", borderRadius: 8, padding: "5px 12px", fontWeight: 600, fontSize: 13, cursor: "pointer", flexShrink: 0 } as const,
  settingRow: { display: "flex", alignItems: "center", gap: 10, fontSize: 15, color: "#334155" } as const,
  signOut: { background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 9, padding: "8px 16px", fontWeight: 600, fontSize: 14, cursor: "pointer", flexShrink: 0 } as const,
  btn: { background: "#0f172a", color: "#fff", border: "none", borderRadius: 9, padding: "8px 18px", fontWeight: 600, fontSize: 14, cursor: "pointer" } as const,
  btnLink: { display: "inline-block", background: "#0f172a", color: "#fff", borderRadius: 10, padding: "11px 22px", fontWeight: 600, fontSize: 15, textDecoration: "none", marginTop: 8 } as const,
  muted: { color: "#94a3b8", fontSize: 14 } as const,
  err: { color: "#b91c1c", fontSize: 15 } as const,
  footerNav: { textAlign: "center", color: "#94a3b8", fontSize: 14, margin: "24px 0 8px" } as const,
  footLink: { color: "#64748b", textDecoration: "none" } as const,
  fieldLabel: { display: "block", fontSize: 13, fontWeight: 600, color: "#475569", margin: "12px 0 4px" } as const,
  input: { width: "100%", boxSizing: "border-box", fontSize: 15, padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: 9 } as const,
  select: { fontSize: 15, padding: "10px 12px", border: "1px solid #cbd5e1", borderRadius: 9, background: "#fff" } as const,
  fieldRow: { display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" } as const,
  scopeNote: { fontSize: 14, color: "#334155", margin: "2px 0 0", fontFamily: "ui-monospace, Menlo, monospace" } as const,
  linkBtn: { background: "none", border: "none", color: "#0f766e", cursor: "pointer", fontSize: 12, textDecoration: "underline", padding: 0, marginLeft: 6 } as const,
  promptPane: { background: "#f0fdfa", border: "1px solid #99f6e4", borderRadius: 10, padding: "12px 14px", marginBottom: 12 } as const,
  connectBox: { marginTop: 18, paddingTop: 16, borderTop: "1px solid #e2e8f0" } as const,
  exMeter: { height: 4, background: "#e2e8f0", borderRadius: 999, overflow: "hidden", marginTop: 10 } as const,
  exMeterFill: { height: "100%", background: "#0f766e", transition: "width 1s linear" } as const,
  promptPre: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, lineHeight: 1.55, color: "#0f172a", background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: "10px 12px", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 } as const,
  onboard: { background: "linear-gradient(135deg,#ecfeff,#f0fdfa)", border: "1px solid #99f6e4", borderRadius: 14, padding: 20, marginBottom: 14 } as const,
  onboardH: { fontSize: 16, fontWeight: 700, color: "#0f172a", margin: "0 0 14px" } as const,
  checkRow: { display: "flex", alignItems: "center", gap: 10, padding: "6px 0" } as const,
  checkBox: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 6, border: "2px solid #cbd5e1", background: "#fff", color: "#fff", fontSize: 13, fontWeight: 800, flexShrink: 0 } as const,
  checkDone: { background: "#0f766e", borderColor: "#0f766e" } as const,
  checkLbl: { fontSize: 14, color: "#0f172a", fontWeight: 600 } as const,
  checkLblDone: { fontSize: 14, color: "#64748b", textDecoration: "line-through" } as const,
  onboardBtn: { marginLeft: "auto", background: "#0f766e", color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" } as const,
  skillCard: { display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 0", borderTop: "1px solid #f1f5f9" } as const,
  skillIcon: { fontSize: 22, lineHeight: "26px", flexShrink: 0 } as const,
  skillName: { fontSize: 15, fontWeight: 700, color: "#0f172a" } as const,
  skillDesc: { fontSize: 13.5, color: "#334155", margin: "3px 0 0", lineHeight: 1.5 } as const,
  skillBy: { fontSize: 12.5, color: "#64748b", marginTop: 6 } as const,
  circleHead: { fontSize: 14, color: "#0f172a", margin: "0 0 2px" } as const,
  skillBtn: { alignSelf: "center", background: "#0f766e", color: "#fff", border: "none", borderRadius: 9, padding: "8px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" } as const,
  skillBtnGhost: { alignSelf: "center", background: "#fff", color: "#0f766e", border: "1px solid #99f6e4", borderRadius: 9, padding: "8px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" } as const,
};
