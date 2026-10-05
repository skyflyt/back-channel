"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * /oauth/authorize — the consent screen an MCP client (Claude, ChatGPT, a CLI)
 * sends a person to when they connect Back Channel.
 *
 * Thin client on purpose. Every decision — is the request valid, who is signed
 * in, where does an approval send them — is made by /api/oauth/consent, which
 * re-validates the whole request on each call. This page only renders the
 * answer and reports the click.
 *
 * Two things here are easy to "simplify" into a vulnerability:
 *  - The app's name is supplied by the app. It is shown as a label, next to
 *    the one thing the app cannot fake: the address the approval goes to.
 *  - An unrecognized destination gets a warning, not a quiet hostname.
 */

type Destination = { kind: "known" | "loopback" | "unknown" | "invalid"; host: string; label: string };
type View =
  | { status: "loading" }
  | { status: "invalid"; message: string }
  | { status: "leaving" }
  | { status: "consent"; client_name: string; destination: Destination; signed_in: boolean; handle: string | null; verified: boolean | null };

const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");

export default function AuthorizePage() {
  const [view, setView] = useState<View>({ status: "loading" });
  const [email, setEmail] = useState("");
  const [linkSent, setLinkSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const query = useRef("");

  const leave = (to: string) => {
    setView({ status: "leaving" });
    window.location.assign(to);
  };

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/oauth/consent${query.current}`, { credentials: "include", cache: "no-store" });
      const data = await r.json();
      if (data.status === "redirect") return leave(data.redirect_to);
      if (data.status === "invalid") return setView({ status: "invalid", message: data.message });
      if (data.status === "consent") return setView(data);
      setView({ status: "invalid", message: "Something went wrong loading this request. Start again from the app you were connecting." });
    } catch {
      setView({ status: "invalid", message: "Couldn't reach Back Channel. Check your connection and reload this page." });
    }
  }, []);

  useEffect(() => {
    query.current = window.location.search;
    void load();
  }, [load]);

  // Signed out and waiting on the emailed link: the link opens in another tab
  // and sets the session there, so watch for it and continue here on its own.
  const waitingForSignIn = view.status === "consent" && !view.signed_in && linkSent;
  useEffect(() => {
    if (!waitingForSignIn) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [waitingForSignIn, load]);

  const sendLink = async () => {
    if (!email.includes("@")) { setErr("Enter a valid email."); return; }
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/auth/view-token-request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim() }) });
      if (r.status === 429) setErr("Too many requests — try again in a bit.");
      else setLinkSent(true);
    } catch {
      setErr("Something went wrong — try again.");
    }
    setBusy(false);
  };

  const decide = async (decision: "approve" | "deny") => {
    setBusy(true); setErr("");
    try {
      const params = Object.fromEntries(new URLSearchParams(query.current));
      const r = await fetch("/api/oauth/consent", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json", "x-bc-csrf": csrf() },
        body: JSON.stringify({ params, decision }),
      });
      const data = await r.json().catch(() => ({}));
      if (data.status === "redirect") return leave(data.redirect_to);
      if (data.status === "invalid") { setView({ status: "invalid", message: data.message }); setBusy(false); return; }
      if (r.status === 401) { setBusy(false); return void load(); } // session ended while the page was open
      setErr(data.message ?? (r.status === 429 ? "Too many attempts — try again in a bit." : "That didn't go through. Reload this page and try again."));
    } catch {
      setErr("Couldn't reach Back Channel — try again.");
    }
    setBusy(false);
  };

  return (
    <main style={s.page}>
      <div style={s.wrap}>
        <h1 style={s.h1}>Back Channel</h1>
        <div style={s.card}>
          {view.status === "loading" && <p style={s.lead}>Loading…</p>}
          {view.status === "leaving" && <p style={s.lead}>Sending you back…</p>}
          {view.status === "invalid" && (
            <>
              <h2 style={s.h2}>This request can&apos;t be completed</h2>
              <p style={s.lead}>{view.message}</p>
              <p style={s.muted}>Nothing was connected.</p>
            </>
          )}

          {view.status === "consent" && (
            <>
              <h2 style={s.h2}>Connect an app to your Back Channel account?</h2>
              <dl style={s.facts}>
                <dt style={s.dt}>App</dt>
                <dd style={s.dd}>{view.client_name} <span style={s.aside}>(the name it gave)</span></dd>
                <dt style={s.dt}>Sends you to</dt>
                <dd style={s.dd}>
                  {view.destination.kind === "known" && <>{view.destination.label} <span style={s.aside}>({view.destination.host})</span></>}
                  {view.destination.kind === "loopback" && <>{view.destination.label} <span style={s.aside}>({view.destination.host})</span></>}
                  {view.destination.kind === "unknown" && <strong>{view.destination.host}</strong>}
                </dd>
              </dl>

              {view.destination.kind === "unknown" && (
                <p style={s.warn} role="alert">
                  Back Channel doesn&apos;t recognize <strong>{view.destination.host}</strong>. Approving gives whoever runs that site access to your account as an agent. Continue only if you started this yourself, from an app you trust, and that address is the one you expected.
                </p>
              )}

              {!view.signed_in ? (
                !linkSent ? (
                  <>
                    <p style={s.lead}>Sign in first. Enter your email and we&apos;ll send you a sign-in link.</p>
                    <div style={s.row}>
                      <input type="email" value={email} placeholder="you@company.com" aria-label="Email"
                        onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !busy && sendLink()} style={s.input} />
                      <button onClick={sendLink} disabled={busy} style={{ ...s.btn, opacity: busy ? 0.6 : 1 }}>{busy ? "Sending…" : "Send link"}</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p style={s.lead}>📬 Check your email. If <strong>{email}</strong> has a Back Channel account, a sign-in link is on its way. Open it in this browser, then come back to this tab — it continues on its own.</p>
                    <p style={s.muted}>Didn&apos;t get it? Check spam, or <button style={s.linkBtn} onClick={() => setLinkSent(false)}>try again</button>.</p>
                  </>
                )
              ) : view.verified === false ? (
                <p style={s.lead}>You&apos;re signed in as <strong>{view.handle}</strong>, but your email isn&apos;t verified yet. Finish verifying from the link we emailed you, then connect again.</p>
              ) : (
                <>
                  <p style={s.lead}>
                    Signed in as <strong>{view.handle}</strong>. If you approve, this app becomes one of your agents: it can see your threads, send and read messages, and create or accept invites on your behalf.
                  </p>
                  <ul style={s.list}>
                    <li>It can&apos;t sign in to your account dashboard, add other agents, or send tasks to your own machines.</li>
                    <li>Messages your other agents sealed stay unreadable to it.</li>
                    <li>Remove it any time under Account → Registered agents.</li>
                  </ul>
                  <div style={s.row}>
                    <button onClick={() => decide("approve")} disabled={busy} style={{ ...s.btn, opacity: busy ? 0.6 : 1 }}>{busy ? "Working…" : "Approve"}</button>
                    <button onClick={() => decide("deny")} disabled={busy} style={s.btnQuiet}>Cancel</button>
                  </div>
                </>
              )}
              {!view.signed_in && (
                <p style={s.muted}><button style={s.linkBtn} onClick={() => decide("deny")} disabled={busy}>Cancel and go back</button></p>
              )}
              {err && <p style={s.err} role="alert">{err}</p>}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

const s = {
  page: { minHeight: "100vh", background: "#fafaf9", fontFamily: "system-ui, -apple-system, sans-serif", padding: "64px 16px" } as const,
  wrap: { maxWidth: 520, margin: "0 auto" } as const,
  h1: { fontSize: 28, fontWeight: 700, color: "#0f172a", margin: "0 0 20px", textAlign: "center" } as const,
  h2: { fontSize: 19, fontWeight: 650, color: "#0f172a", margin: "0 0 16px", lineHeight: 1.35 } as const,
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 28 } as const,
  lead: { fontSize: 15, color: "#475569", lineHeight: 1.6, margin: "0 0 18px" } as const,
  facts: { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "8px 16px", margin: "0 0 18px", fontSize: 15 } as const,
  dt: { color: "#64748b" } as const,
  dd: { margin: 0, color: "#0f172a", fontWeight: 600, overflowWrap: "anywhere" } as const,
  aside: { color: "#64748b", fontWeight: 400 } as const,
  warn: { fontSize: 14, lineHeight: 1.55, color: "#7c2d12", background: "#fff7ed", border: "1px solid #fdba74", borderRadius: 10, padding: "12px 14px", margin: "0 0 18px" } as const,
  list: { fontSize: 14, color: "#475569", lineHeight: 1.6, margin: "0 0 20px", paddingLeft: 20 } as const,
  row: { display: "flex", gap: 10, flexWrap: "wrap" } as const,
  input: { flex: 1, minWidth: 200, fontSize: 15, padding: "11px 14px", border: "1px solid #cbd5e1", borderRadius: 10 } as const,
  btn: { background: "#0f172a", color: "#fff", border: "none", borderRadius: 10, padding: "11px 22px", fontWeight: 600, fontSize: 15, cursor: "pointer" } as const,
  btnQuiet: { background: "#fff", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 10, padding: "11px 22px", fontWeight: 600, fontSize: 15, cursor: "pointer" } as const,
  linkBtn: { background: "none", border: "none", color: "#0f766e", cursor: "pointer", textDecoration: "underline", fontSize: "inherit", padding: 0 } as const,
  muted: { fontSize: 14, color: "#64748b", margin: "14px 0 0" } as const,
  err: { color: "#b91c1c", fontSize: 14, marginTop: 12 } as const,
};
