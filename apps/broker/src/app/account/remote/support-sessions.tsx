"use client";

/**
 * "Help someone": the Remote page's card for one-time remote support (docs/remote-support.md).
 *
 * When one of the person's agents asks for a support code, the request lands here, and only here: approving mints
 * the code and shows it ONCE, to the person, to copy and send themselves. The agent never sees it, and neither
 * does this card again (only its hash is stored). Unused codes can be cancelled, running sessions stopped, and
 * finished ones show their plain transcript, including whether the helper removed itself. Reports ("I didn't ask
 * for this") are listed at the top.
 *
 * Owner-only in v1: for anyone else the API answers { available: false } and the card stays hidden. Everything goes
 * through the cookie-authenticated /api/support routes; every change echoes the bc_csrf cookie. An agent's one-tap
 * approval link (?vt=...&support=<id>) signs the person in through the page's consumeApprovalLink() and brings that
 * request into view.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Chip } from "@/components/ui/primitives";

interface Step { at: string; text: string; outcome: string }
interface Session {
  id: string; status: string; statusText: string; allowBy: string | null; startedAt: string | null; expiresAt: string | null; endedAt: string | null;
  endReason: string | null; removal: { kind: string; at: string } | null; removalText: string | null;
}
interface Support {
  id: string; status: string; statusText: string; for: string; task: string; minutes: number; requestedBy: { agentId: string; name: string };
  listTask: { id: string; title: string | null } | null; requestedAt: string; approvalExpiresAt: string | null; codeExpiresAt: string | null;
  redeemedAt: string | null; closedAt: string | null; reported: boolean; session: Session | null; steps?: Step[]; transcript?: { lines: string[]; text: string };
}
interface Report { id: string; at: string; via: "page" | "helper"; inviteId: string; for: string | null; task: string | null }
interface Reply {
  available: boolean; remoteAccess?: string;
  limits?: { outstanding: number; maxOutstanding: number; mintedToday: number; mintsPerDay: number; maxMinutes: number };
  pending: Support[]; codes: Support[]; live: Support[]; recent: Support[]; reports: Report[];
}
interface Minted { id: string; code: string; url: string; expiresAt: string; for: string }

const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");
const post = (path: string) => fetch(path, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() } });
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
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Non-production only, like the page's own fixture: a signed-out visit shows a sample so the card can be reviewed.
function demo(): Reply {
  const t = Date.now();
  const iso = (ms: number) => new Date(t + ms).toISOString();
  const base = { requestedBy: { agentId: "demo-a", name: "Claude Code" }, listTask: null, redeemedAt: null, closedAt: null, reported: false, session: null, minutes: 30 };
  return {
    available: true, remoteAccess: "available", limits: { outstanding: 1, maxOutstanding: 3, mintedToday: 1, mintsPerDay: 5, maxMinutes: 45 },
    pending: [{ ...base, id: "demo-p1", status: "requested", statusText: "waiting for your OK", for: "Mom", task: "Get the printer working again.", requestedAt: iso(-60_000),
      approvalExpiresAt: iso(59 * 60_000), codeExpiresAt: null }],
    codes: [], live: [],
    recent: [{ ...base, id: "demo-r1", status: "redeemed", statusText: "used", for: "Dad", task: "Set up the new scanner.", requestedAt: iso(-26 * 3600_000), approvalExpiresAt: null,
      codeExpiresAt: null, redeemedAt: iso(-26 * 3600_000), session: { id: "demo-s1", status: "ended", statusText: "Finished.", allowBy: null, startedAt: iso(-26 * 3600_000),
        expiresAt: iso(-25.5 * 3600_000), endedAt: iso(-25.8 * 3600_000), endReason: "done", removal: { kind: "removed", at: iso(-25.8 * 3600_000) }, removalText: "The helper removed itself." },
      transcript: { lines: ["Support for Dad, through Back Channel.", "Task: Set up the new scanner.", "Connected on 2026-10-09, 14:02 to 14:14 UTC (12 minutes).",
        "Opened Printers & scanners (they allowed it).", "Clicked 'Add device' (they allowed it).", "Finished.", "The helper removed itself."], text: "" } }],
    reports: [],
  };
}

function Steps({ steps }: { steps: Step[] }) {
  if (!steps.length) return <p className="ds-fine" style={{ margin: "8px 0 0" }}>Nothing done yet.</p>;
  return (
    <ol style={{ margin: "8px 0 0", paddingLeft: 20, display: "grid", gap: 4 }}>
      {steps.map((s, i) => (
        <li key={`${s.at}-${i}`} className="ds-igoal">
          {s.outcome === "declined" ? <Chip tone="warn">Said no</Chip> : s.outcome !== "ok" ? <Chip tone="warn">Stopped</Chip> : null} {s.text} <span className="ds-fine">{when(s.at)}</span>
        </li>
      ))}
    </ol>
  );
}

const DONE: Record<string, string> = {
  deny: "Said no. No code was made.",
  void: "Cancelled. That code no longer works.",
  stop: "Stopped. The helper is disconnected within about a minute, and it can't restart without a new code.",
};

export default function SupportSessions() {
  const [data, setData] = useState<Reply | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [minted, setMinted] = useState<Minted | null>(null);
  const [copied, setCopied] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const [focus, setFocus] = useState<string | null>(null);
  const scrolled = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/support/invites", { credentials: "include" });
      if (r.status === 401) {
        if (process.env.NODE_ENV !== "production") { setData(demo()); setState("ready"); } else setState("hidden");
        return;
      }
      if (!r.ok) { setState("error"); return; }
      const j: Reply = await r.json();
      if (!j.available) { setState("hidden"); return; }
      setData(j); setState("ready");
    } catch { setState("error"); }
  }, []);

  useEffect(() => { setFocus(new URLSearchParams(window.location.search).get("support")); load(); }, [load]);

  const active = !!data && (data.pending.length > 0 || data.codes.length > 0 || data.live.length > 0);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const refresh = setInterval(() => { if (document.visibilityState === "visible") load(); }, active ? 10_000 : 60_000);
    return () => { clearInterval(tick); clearInterval(refresh); };
  }, [active, load]);

  useEffect(() => {
    if (state !== "ready" || !focus || scrolled.current) return;
    scrolled.current = true;
    document.getElementById(`support-${focus}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [state, focus]);

  const clearFocus = (id: string) => {
    if (focus !== id) return;
    setFocus(null);
    const url = new URL(window.location.href); url.searchParams.delete("support");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };

  async function approve(s: Support) {
    setBusy(`approve:${s.id}`); setMessage(""); setCopied("");
    try {
      const r = await post(`/api/support/invites/${encodeURIComponent(s.id)}/approve`);
      const j = await r.json().catch(() => ({}));
      if (r.ok && typeof j.code === "string") { setMinted({ id: s.id, code: j.code, url: j.url, expiresAt: j.codeExpiresAt, for: s.for }); clearFocus(s.id); }
      else setMessage(typeof j.message === "string" ? j.message : "That didn't work. Try again.");
    } catch { setMessage("Couldn't reach Back Channel. Try again."); }
    setBusy("");
    load();
  }

  async function act(s: Support, what: "deny" | "void" | "stop") {
    setBusy(`${what}:${s.id}`); setMessage("");
    try {
      const r = await post(`/api/support/invites/${encodeURIComponent(s.id)}/${what}`);
      const j = await r.json().catch(() => ({}));
      setMessage(r.ok ? DONE[what] : typeof j.message === "string" ? j.message : "That didn't work. Try again.");
      if (r.ok) clearFocus(s.id);
      if (r.ok && minted?.id === s.id) setMinted(null);
    } catch { setMessage("Couldn't reach Back Channel. Try again."); }
    setBusy("");
    load();
  }

  async function copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); setCopied(what); } catch { setCopied(""); }
  }

  if (state === "loading" || state === "hidden") return null;
  if (state === "error" || !data) {
    return <div className="ds-card"><div className="ds-cardh">Help someone</div><p className="ds-fine" style={{ margin: 0 }}>Couldn&apos;t load support requests. Refresh to try again.</p></div>;
  }
  const toggle = (id: string) => setOpen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const mintedLeft = minted ? new Date(minted.expiresAt).getTime() - now : 0;
  const quiet = !active && !minted && !data.reports.length;

  return (
    <div className="ds-card" id="support-sessions">
      <div className="ds-cardh">Help someone</div>
      <p className="ds-cardsub">
        When one of your agents asks for a one-time support code to help someone else (a family member&apos;s printer, say), the request shows up here.
        Approving shows you the code once: send it to them yourself. Your agent never sees it. They see your name and the task, press Allow on their own screen,
        and confirm every action. A session lasts at most {data.limits?.maxMinutes ?? 45} minutes, and either of you can stop it.
      </p>
      {data.remoteAccess && data.remoteAccess !== "available" && (
        <p className="ds-fine" style={{ margin: "0 0 12px" }}>{data.remoteAccess === "rollout_off" ? "Back Channel Remote is switched off for now, so no code can be made." : "Support codes are part of Back Channel Remote, which isn't on for this account."}</p>
      )}

      {data.reports.map((r) => (
        <div key={r.id} className="ds-item" style={{ display: "block" }}>
          <div className="ds-iname"><Chip tone="warn">Reported</Chip> {r.for ?? "Someone"} said they didn&apos;t ask for this</div>
          <div className="ds-imeta">{r.via === "page" ? "From the code's web page, so the code was cancelled" : "From the helper, so the session was ended"} · {when(r.at)}</div>
          {r.task && <div className="ds-igoal">Task: {r.task}</div>}
        </div>
      ))}

      {minted && (
        <div style={{ border: "1px solid var(--ds-acc-line)", background: "var(--ds-acc-soft)", borderRadius: 10, padding: 14, margin: "4px 0 8px" }} aria-live="polite">
          <div className="ds-iname">Code for {minted.for}: send it yourself</div>
          {mintedLeft > 0 ? (
            <>
              <div className="ds-mono" style={{ fontSize: 26, letterSpacing: 2, margin: "8px 0", userSelect: "all" }}>{minted.code}</div>
              <div className="ds-fine" style={{ overflowWrap: "anywhere", marginBottom: 10 }}>{minted.url}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="ds-btn" onClick={() => copy(minted.url, "link")}>{copied === "link" ? "Link copied" : "Copy link"}</button>
                <button className="ds-btn ghost" onClick={() => copy(minted.code, "code")}>{copied === "code" ? "Code copied" : "Copy code"}</button>
                <button className="ds-btn ghost" onClick={() => setMinted(null)}>Done</button>
              </div>
              <p className="ds-fine" style={{ margin: "10px 0 0" }}>
                Shown once: Back Channel can&apos;t show it again. It works once, for {clock(mintedLeft)} more. Send it only to {minted.for}, and tell them it&apos;s from you.
              </p>
            </>
          ) : <p className="ds-fine" style={{ margin: "6px 0 0" }}>This code expired unused. Your agent can ask again.</p>}
        </div>
      )}

      {data.pending.map((s) => {
        const left = s.approvalExpiresAt ? new Date(s.approvalExpiresAt).getTime() - now : 0;
        return (
          <div key={s.id} id={`support-${s.id}`} className="ds-item" style={{ display: "block", ...(focus === s.id ? { background: "var(--ds-acc-soft)", borderRadius: 10, padding: 12 } : {}) }}>
            <div className="ds-iname"><Chip tone="acc">Needs your OK</Chip> {s.requestedBy.name} wants a support code to help {s.for}</div>
            <div className="ds-imeta">For up to {s.minutes} minutes once they allow it. Asked {when(s.requestedAt)}. {left > 0 ? `If you don't answer in ${clock(left)}, the request expires.` : "This request has expired."}</div>
            <div className="ds-igoal">They will read: &ldquo;{s.task}&rdquo;{s.listTask && <><br />Task: {s.listTask.title ?? "a task you can no longer see"}</>}</div>
            <p className="ds-fine" style={{ margin: "8px 0" }}>Approve only if {s.for} asked you for help. You&apos;ll see the code once, here, and send it yourself.</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="ds-btn" disabled={!!busy || left <= 0} onClick={() => approve(s)}>Approve and show the code</button>
              <button className="ds-btn ghost" disabled={!!busy} onClick={() => act(s, "deny")}>Deny</button>
            </div>
          </div>
        );
      })}

      {data.codes.map((s) => {
        const left = s.codeExpiresAt ? new Date(s.codeExpiresAt).getTime() - now : 0;
        return (
          <div key={s.id} id={`support-${s.id}`} className="ds-item" style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className="ds-iname"><Chip>Code sent</Chip> Waiting for {s.for} to use their code</div>
              <div className="ds-imeta">{left > 0 ? `It stops working in ${clock(left)} if unused.` : "Expired unused."}</div>
              <div className="ds-igoal">&ldquo;{s.task}&rdquo;</div>
            </div>
            <button className="ds-btn danger" disabled={busy === `void:${s.id}`} onClick={() => act(s, "void")}>Cancel code</button>
          </div>
        );
      })}

      {data.live.map((s) => {
        const left = s.session?.expiresAt ? new Date(s.session.expiresAt).getTime() - now : 0;
        const waiting = s.session?.status === "awaiting_consent";
        return (
          <div key={s.id} id={`support-${s.id}`} className="ds-item" style={{ display: "block" }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div className="ds-iname">{waiting ? <Chip tone="acc">Waiting</Chip> : <Chip tone="ok">Running</Chip>} {waiting ? `${s.for} opened the code and hasn't pressed Allow yet` : `Helping ${s.for}`}</div>
                <div className="ds-imeta">{waiting ? "Nothing happens on their computer until they press Allow." : `${clock(left)} left of ${s.minutes} minutes`}</div>
                <div className="ds-igoal">&ldquo;{s.task}&rdquo;</div>
              </div>
              <button className="ds-btn danger" disabled={busy === `stop:${s.id}`} onClick={() => act(s, "stop")}>Stop</button>
            </div>
            {!waiting && <Steps steps={s.steps ?? []} />}
          </div>
        );
      })}

      {quiet && <p className="ds-fine" style={{ margin: 0 }}>No support requests right now.</p>}

      {data.recent.length > 0 && (
        <>
          <div className="ds-lsec" style={{ paddingLeft: 0 }}>Recent</div>
          {data.recent.map((s) => {
            const t = s.transcript;
            const text = t ? (t.text || t.lines.join("\n")) : "";
            return (
              <div key={s.id} className="ds-item" style={{ display: "block" }}>
                <div className="ds-iname">{s.reported && <Chip tone="warn">Reported</Chip>} {s.session ? `Support for ${s.for}` : `Support code for ${s.for}`}</div>
                <div className="ds-imeta">{cap(s.session ? s.session.statusText.replace(/\.$/, "") : s.statusText)} · {when(s.session?.endedAt ?? s.closedAt ?? s.requestedAt)}</div>
                <div className="ds-igoal">&ldquo;{s.task}&rdquo;</div>
                {s.session?.removalText && <div className="ds-fine">{s.session.removalText}</div>}
                {t && (
                  <>
                    <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
                      <button className="ds-link" onClick={() => toggle(s.id)}>{open.has(s.id) ? "Hide transcript" : "Show transcript"}</button>
                      <button className="ds-link" onClick={() => copy(text, `t:${s.id}`)}>{copied === `t:${s.id}` ? "Copied" : "Copy transcript"}</button>
                    </div>
                    {open.has(s.id) && <pre className="ds-igoal" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", margin: "8px 0 0" }}>{text}</pre>}
                  </>
                )}
              </div>
            );
          })}
        </>
      )}

      {data.limits && (
        <p className="ds-fine" style={{ margin: "12px 0 0" }}>
          {data.limits.outstanding} of {data.limits.maxOutstanding} codes waiting · {data.limits.mintedToday} of {data.limits.mintsPerDay} codes made in the last 24 hours.
        </p>
      )}
      {message && <p className="ds-fine" style={{ marginTop: 12 }} aria-live="polite">{message}</p>}
    </div>
  );
}
