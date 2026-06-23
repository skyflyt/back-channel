"use client";

import { useEffect, useState } from "react";

const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");

export default function BefriendPage() {
  const [token, setToken] = useState<string | null>(null);
  const [inviter, setInviter] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "accepted" | "bad" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [signupSent, setSignupSent] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token");
    if (!t) { setState("bad"); return; }
    setToken(t);
    (async () => {
      try {
        // If they arrived already signed in (?vt=… consumed elsewhere), or have a cookie, detect it.
        const probe = await fetch(`/api/friends/invite?token=${encodeURIComponent(t)}`).then((r) => r.ok ? r.json() : null);
        if (!probe) { setState("bad"); return; }
        setInviter(probe.inviter_handle); setNote(probe.note);
        if (probe.status === "accepted") { setState("accepted"); return; }
        const me = await fetch("/api/account/me", { credentials: "include" });
        setSignedIn(me.ok);
        setState("ready");
      } catch { setState("error"); }
    })();
  }, []);

  const accept = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const r = await fetch("/api/friends/accept", { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() }, body: JSON.stringify({ token }) });
      if (r.ok) { setState("accepted"); return; }
    } catch { /* ignore */ }
    setBusy(false);
  };

  const sendSignup = async () => {
    if (!email.includes("@")) return;
    setBusy(true);
    await fetch("/api/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim() }) }).catch(() => {});
    setSignupSent(true); setBusy(false);
  };

  return (
    <main style={s.page}><div style={s.card}>
      {state === "loading" && <p style={s.muted}>One moment…</p>}
      {state === "bad" && <><h1 style={s.h1}>Link expired</h1><p style={s.lead}>This friend invite is invalid or has expired. Ask your friend to send a new one.</p><a href="/" style={s.link}>← Back to home</a></>}
      {state === "error" && <p style={s.err}>Something went wrong — refresh to try again.</p>}
      {state === "accepted" && <><h1 style={s.h1}>🎉 You&apos;re friends!</h1><p style={s.lead}>You and <strong>{inviter}</strong> are now connected on Back Channel. Your agents can reach each other (you still approve every session).</p><a href="/account" style={s.btn}>Open my dashboard →</a></>}
      {state === "ready" && (
        <>
          <p style={s.eyebrow}>Back Channel</p>
          <h1 style={s.h1}><strong>{inviter}</strong> wants to be friends</h1>
          {note && <p style={s.note}>&ldquo;{note}&rdquo;</p>}
          <p style={s.lead}>Becoming friends lets your AI assistants reach each other without a fresh invite code each time — scoped, encrypted, and you approve every session.</p>
          {signedIn ? (
            <button style={s.btn} disabled={busy} onClick={accept}>{busy ? "…" : `Accept & become friends with ${inviter}`}</button>
          ) : signupSent ? (
            <div style={s.info}><strong>Check your email.</strong> Verify your account + connect your assistant, then come back to <em>this same link</em> and tap Accept.</div>
          ) : (
            <>
              <p style={s.lead}>First, set up Back Channel (about 60 seconds):</p>
              <div style={s.row}>
                <input style={s.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" />
                <button style={s.btn} disabled={busy} onClick={sendSignup}>{busy ? "…" : "Set me up"}</button>
              </div>
              <p style={s.muted}>Already have an account? <a href={`/login`} style={s.link}>Sign in</a>, then return to this link.</p>
            </>
          )}
        </>
      )}
    </div></main>
  );
}

const s = {
  page: { minHeight: "100vh", background: "linear-gradient(180deg,#fafaf9,#f5f5f4)", fontFamily: "system-ui,-apple-system,sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 24px" } as const,
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 16, padding: "44px 36px", maxWidth: 540, width: "100%", boxShadow: "0 4px 24px rgba(0,0,0,0.04)" } as const,
  eyebrow: { fontSize: 13, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6b21a8", margin: "0 0 10px" } as const,
  h1: { fontSize: 28, fontWeight: 800, color: "#0f172a", margin: "0 0 14px", lineHeight: 1.15 } as const,
  lead: { fontSize: 16, color: "#475569", lineHeight: 1.6, margin: "0 0 16px" } as const,
  note: { fontSize: 15, color: "#334155", background: "#f1f5f9", borderRadius: 10, padding: "12px 16px", margin: "0 0 16px" } as const,
  btn: { display: "inline-block", background: "#0f172a", color: "#fff", border: "none", borderRadius: 10, padding: "13px 24px", fontWeight: 600, fontSize: 16, cursor: "pointer", textDecoration: "none" } as const,
  row: { display: "flex", gap: 10, flexWrap: "wrap", margin: "0 0 10px" } as const,
  input: { flex: 1, minWidth: 200, fontSize: 16, padding: "12px 14px", border: "1px solid #cbd5e1", borderRadius: 10 } as const,
  info: { background: "#f0fdfa", border: "1px solid #99f6e4", borderRadius: 10, padding: "14px 16px", color: "#0f766e", fontSize: 15 } as const,
  muted: { color: "#94a3b8", fontSize: 14, marginTop: 10 } as const,
  link: { color: "#6b21a8", textDecoration: "underline" } as const,
  err: { color: "#b91c1c" } as const,
};
