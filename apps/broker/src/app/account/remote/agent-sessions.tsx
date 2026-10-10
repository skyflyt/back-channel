"use client";

/**
 * "Live agent sessions": the Remote page's card for remote app sessions (docs/remote-app-sessions.md).
 *
 * When one of the person's agents asks to use an app on one of their PCs, the request lands here, and only
 * here: nothing happens on the PC until the person taps Approve. Running sessions can be stopped one by one or
 * all at once; a paused one (it stopped to ask) can be let go on. Recent sessions show every step the agent
 * reported, as the broker's fixed phrases, never anything copied from the screen.
 *
 * Everything goes through the cookie-authenticated /api/remote-app routes; every change echoes the bc_csrf
 * cookie. An agent's one-tap approval link (?vt=...&approve=<id>) signs the person in through
 * consumeApprovalLink() and scrolls to that request's card.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Chip } from "@/components/ui/primitives";

interface Who { agentId: string; name: string }
interface Step { at: string; action: string; target: string | null; outcome: string; text: string; evidenceRef?: string }
interface AgentSession {
  id: string; status: string; statusText: string; pc: { hostDeviceId: string; label: string }; apps: string[]; goal: string; minutes: number;
  startedBy: Who; drivenBy: Who; task: { id: string; title: string | null } | null; requestedAt: string; approvalExpiresAt: string | null;
  startedAt: string | null; expiresAt: string | null; endedAt: string | null; endReason: string | null; pausedBecause?: string; summary?: string;
  evidenceRef?: string; actions?: Step[];
}
interface Reply { pending: AgentSession[]; live: AgentSession[]; recent: AgentSession[] }

const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");
const post = (path: string) => fetch(path, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() } });

/**
 * Sign in from an agent's approval link. The single-use token is spent by this POST, never by loading the
 * page (so a link scanner can't burn it), and dropped from the address bar. The approve=<id> part stays,
 * so the card knows which request to show first.
 */
export async function consumeApprovalLink(): Promise<void> {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const vt = url.searchParams.get("vt");
  if (!vt) return;
  url.searchParams.delete("vt");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  try {
    await fetch("/api/auth/view-token-consume", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: vt }) });
  } catch { /* the page shows the signed-out card */ }
}

const appList = (apps: string[]) => (apps.length <= 1 ? apps.join("") : `${apps.slice(0, -1).join(", ")} and ${apps[apps.length - 1]}`);
function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function when(iso: string | null): string {
  if (!iso) return "";
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return new Date(iso).toLocaleString();
}

// Non-production only, like the page's own fixture: a signed-out visit shows a sample so the card can be reviewed.
function demo(): Reply {
  const t = Date.now();
  const iso = (ms: number) => new Date(t + ms).toISOString();
  const base = { pc: { hostDeviceId: "demo-pc-1", label: "Office PC" }, startedBy: { agentId: "demo-a", name: "Claude Code" }, drivenBy: { agentId: "demo-a", name: "Claude Code" }, endReason: null, endedAt: null };
  return {
    pending: [{ ...base, id: "demo-s1", status: "awaiting_consent", statusText: "waiting for approval", apps: ["QuickBooks"], goal: "Enter this week's three supplier invoices.", minutes: 20,
      task: { id: "demo-t1", title: "Enter supplier invoices" }, requestedAt: iso(-60_000), approvalExpiresAt: iso(9 * 60_000), startedAt: null, expiresAt: null }],
    live: [],
    recent: [{ ...base, id: "demo-s0", status: "ended", statusText: "finished", apps: ["Excel"], goal: "Update the inventory sheet.", minutes: 15, task: null,
      requestedAt: iso(-3 * 3600_000), approvalExpiresAt: null, startedAt: iso(-3 * 3600_000), expiresAt: iso(-3 * 3600_000 + 15 * 60_000), endedAt: iso(-3 * 3600_000 + 9 * 60_000),
      endReason: "done", summary: "Updated 12 rows and saved the sheet.", actions: [
        { at: iso(-3 * 3600_000 + 60_000), action: "open", target: "Excel", outcome: "ok", text: "Opened Excel." },
        { at: iso(-3 * 3600_000 + 120_000), action: "invoke", target: "Save", outcome: "ok", text: "Clicked 'Save'." },
      ] }],
  };
}

function Steps({ steps }: { steps: Step[] }) {
  if (!steps.length) return <p className="ds-fine" style={{ margin: "8px 0 0" }}>No steps recorded.</p>;
  return (
    <ol style={{ margin: "8px 0 0", paddingLeft: 20, display: "grid", gap: 4 }}>
      {steps.map((s, i) => (
        <li key={`${s.at}-${i}`} className="ds-igoal">
          {s.outcome !== "ok" && <Chip tone="warn">Stopped</Chip>} {s.text} <span className="ds-fine">{when(s.at)}</span>
          {s.evidenceRef && <span className="ds-fine"> · kept on the PC as <span className="ds-mono">{s.evidenceRef}</span></span>}
        </li>
      ))}
    </ol>
  );
}

const DONE: Record<string, string> = {
  approve: "Approved. The agent can start now.",
  deny: "Denied. Nothing happened on the PC.",
  resume: "It can go on now.",
  stop: "Stopped. It ends on the PC within about a minute and can't restart without asking you again.",
};

export default function AgentSessions() {
  const [data, setData] = useState<Reply | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const [focus, setFocus] = useState<string | null>(null);
  const scrolled = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/remote-app/sessions", { credentials: "include" });
      if (r.status === 401) {
        if (process.env.NODE_ENV !== "production") { setData(demo()); setState("ready"); } else setState("hidden");
        return;
      }
      if (!r.ok) { setState("error"); return; }
      setData(await r.json()); setState("ready");
    } catch { setState("error"); }
  }, []);

  useEffect(() => { setFocus(new URLSearchParams(window.location.search).get("approve")); load(); }, [load]);

  // While anything waits or runs, refresh often and keep the countdowns moving; otherwise now and then.
  const active = !!data && (data.pending.length > 0 || data.live.length > 0);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const refresh = setInterval(() => { if (document.visibilityState === "visible") load(); }, active ? 10_000 : 60_000);
    return () => { clearInterval(tick); clearInterval(refresh); };
  }, [active, load]);

  // From an agent's approval link: bring that request into view, once.
  useEffect(() => {
    if (state !== "ready" || !focus || scrolled.current) return;
    scrolled.current = true;
    document.getElementById(`agent-session-${focus}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [state, focus]);

  async function act(s: AgentSession, what: "approve" | "deny" | "resume" | "stop") {
    setBusy(`${what}:${s.id}`); setMessage("");
    try {
      const r = await post(`/api/remote-app/sessions/${encodeURIComponent(s.id)}/${what}`);
      const j = await r.json().catch(() => ({}));
      setMessage(r.ok ? DONE[what] : typeof j.message === "string" ? j.message : "That didn't work. Try again.");
      if (r.ok && focus === s.id) {
        setFocus(null);
        const url = new URL(window.location.href); url.searchParams.delete("approve");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }
    } catch { setMessage("Couldn't reach Back Channel. Try again."); }
    setBusy("");
    load();
  }

  async function stopAll() {
    setBusy("stop-all"); setMessage("");
    try {
      const r = await post("/api/remote-app/stop-all");
      const j = await r.json().catch(() => ({}));
      setMessage(r.ok ? (j.stopped ? `Stopped ${j.stopped} session${j.stopped === 1 ? "" : "s"}. Nothing restarts without asking you again.` : "Nothing was running.")
        : typeof j.message === "string" ? j.message : "That didn't work. Try again.");
    } catch { setMessage("Couldn't reach Back Channel. Try again."); }
    setBusy("");
    load();
  }

  if (state === "loading" || state === "hidden") return null;
  if (state === "error" || !data) {
    return <div className="ds-card"><div className="ds-cardh">Live agent sessions</div><p className="ds-fine" style={{ margin: 0 }}>Couldn&apos;t load agent sessions. Refresh to try again.</p></div>;
  }
  const toggle = (id: string) => setOpen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const drivenBy = (s: AgentSession) => (s.drivenBy.agentId !== s.startedBy.agentId ? `, driven by ${s.drivenBy.name}` : "");
  const goalAndTask = (s: AgentSession) => (
    <div className="ds-igoal">
      Goal: {s.goal}
      {s.task && <><br />Task: {s.task.title ?? "a task you can no longer see"}</>}
    </div>
  );

  return (
    <div className="ds-card" id="agent-sessions">
      <div className="ds-cardh" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ flex: 1 }}>Live agent sessions</span>
        {active && <button className="ds-btn danger" disabled={busy === "stop-all"} onClick={stopAll}>Stop all</button>}
      </div>
      <p className="ds-cardsub">
        When one of your agents asks to use an app on one of your PCs, the request shows up here. Nothing happens on the PC until you approve it.
        The agent can use only the apps you see, on that PC, for that long, and never types a password. Stop ends a session within about a minute, and it can&apos;t restart without asking you again.
      </p>

      {data.pending.map((s) => {
        const left = s.approvalExpiresAt ? new Date(s.approvalExpiresAt).getTime() - now : 0;
        return (
          <div key={s.id} id={`agent-session-${s.id}`} className="ds-item" style={{ display: "block", ...(focus === s.id ? { background: "var(--ds-acc-soft)", borderRadius: 10, padding: 12 } : {}) }}>
            <div className="ds-iname"><Chip tone="acc">Needs your OK</Chip> {s.startedBy.name} wants to use {appList(s.apps)} on {s.pc.label}</div>
            <div className="ds-imeta">For up to {s.minutes} minutes{drivenBy(s)}. Asked {when(s.requestedAt)}. {left > 0 ? `If you don't answer in ${clock(left)}, the request expires.` : "This request has expired."}</div>
            {goalAndTask(s)}
            <p className="ds-fine" style={{ margin: "8px 0" }}>Approve only if you asked for this. Every step the agent takes is listed here{s.task ? " and on the task" : ""}.</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="ds-btn" disabled={!!busy || left <= 0} onClick={() => act(s, "approve")}>Approve</button>
              <button className="ds-btn ghost" disabled={!!busy} onClick={() => act(s, "deny")}>Deny</button>
            </div>
          </div>
        );
      })}

      {data.live.map((s) => {
        const left = s.expiresAt ? new Date(s.expiresAt).getTime() - now : 0;
        const paused = s.status === "blocked";
        return (
          <div key={s.id} id={`agent-session-${s.id}`} className="ds-item" style={{ display: "block" }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div className="ds-iname">{paused ? <Chip tone="warn">Paused</Chip> : <Chip tone="ok">Running</Chip>} {s.startedBy.name} is using {appList(s.apps)} on {s.pc.label}</div>
                <div className="ds-imeta">{clock(left)} left of {s.minutes} minutes{drivenBy(s)}</div>
                {goalAndTask(s)}
                {paused && <p className="ds-fine" style={{ margin: "8px 0 0" }}>It stopped to ask: {s.pausedBecause ?? "something unexpected came up"}. Sort it out at the PC, then let it go on, or stop it.</p>}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {paused && <button className="ds-btn ghost" disabled={!!busy} onClick={() => act(s, "resume")}>Let it go on</button>}
                <button className="ds-btn danger" disabled={busy === `stop:${s.id}`} onClick={() => act(s, "stop")}>Stop</button>
              </div>
            </div>
            <Steps steps={s.actions ?? []} />
          </div>
        );
      })}

      {!active && <p className="ds-fine" style={{ margin: 0 }}>No agent is using your PCs right now.</p>}

      {data.recent.length > 0 && (
        <>
          <div className="ds-lsec" style={{ paddingLeft: 0 }}>Recent</div>
          {data.recent.map((s) => {
            const ran = !!s.startedAt;
            const steps = s.actions ?? [];
            return (
              <div key={s.id} className="ds-item" style={{ display: "block" }}>
                <div className="ds-iname">{s.startedBy.name} {ran ? "used" : "asked to use"} {appList(s.apps)} on {s.pc.label}</div>
                <div className="ds-imeta">{s.statusText[0].toUpperCase() + s.statusText.slice(1)} · {when(s.endedAt ?? s.requestedAt)}{drivenBy(s)}</div>
                {goalAndTask(s)}
                {s.summary && <div className="ds-igoal">The agent&apos;s summary: {s.summary}</div>}
                {s.evidenceRef && <div className="ds-fine">Evidence kept on the PC as <span className="ds-mono">{s.evidenceRef}</span></div>}
                {ran && (
                  <>
                    <button className="ds-link" style={{ marginTop: 6 }} onClick={() => toggle(s.id)}>
                      {open.has(s.id) ? "Hide steps" : `Show steps (${steps.length})`}
                    </button>
                    {open.has(s.id) && <Steps steps={steps} />}
                  </>
                )}
              </div>
            );
          })}
        </>
      )}

      {message && <p className="ds-fine" style={{ marginTop: 12 }} aria-live="polite">{message}</p>}
    </div>
  );
}
