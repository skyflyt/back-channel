"use client";

import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!email.includes("@")) { setErr("Enter a valid email."); return; }
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/auth/view-token-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (r.status === 429) { setErr("Too many requests — try again in a bit."); setBusy(false); return; }
      setSent(true);
    } catch {
      setErr("Something went wrong — try again.");
    }
    setBusy(false);
  };

  return (
    <main style={s.page}>
      <div style={s.wrap}>
        <h1 style={s.h1}>Back Channel</h1>
        {!sent ? (
          <div style={s.card}>
            <p style={s.lead}>Enter your email and we&apos;ll send you a sign-in link to open your account — your sessions, the agents you&apos;ve trusted, and your API key.</p>
            <div style={s.row}>
              <input
                type="email" value={email} placeholder="you@company.com"
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !busy && submit()}
                style={s.input}
              />
              <button onClick={submit} disabled={busy} style={{ ...s.btn, opacity: busy ? 0.6 : 1 }}>
                {busy ? "Sending…" : "Send link"}
              </button>
            </div>
            {err && <p style={s.err}>{err}</p>}
          </div>
        ) : (
          <div style={s.card}>
            <p style={s.lead}>📬 Check your email. If <strong>{email}</strong> has a Back Channel account, a sign-in link is on its way. It works once and expires in 15 minutes.</p>
            <p style={s.muted}>Didn&apos;t get it? Check spam, or <button style={s.linkBtn} onClick={() => { setSent(false); }}>try again</button>.</p>
          </div>
        )}
      </div>
    </main>
  );
}

const s = {
  page: { minHeight: "100vh", background: "#fafaf9", fontFamily: "system-ui, -apple-system, sans-serif", padding: "64px 16px" } as const,
  wrap: { maxWidth: 460, margin: "0 auto" } as const,
  h1: { fontSize: 28, fontWeight: 700, color: "#0f172a", margin: "0 0 20px", textAlign: "center" } as const,
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 28 } as const,
  lead: { fontSize: 15, color: "#475569", lineHeight: 1.6, margin: "0 0 18px" } as const,
  row: { display: "flex", gap: 10, flexWrap: "wrap" } as const,
  input: { flex: 1, minWidth: 200, fontSize: 15, padding: "11px 14px", border: "1px solid #cbd5e1", borderRadius: 10 } as const,
  btn: { background: "#0f172a", color: "#fff", border: "none", borderRadius: 10, padding: "11px 22px", fontWeight: 600, fontSize: 15, cursor: "pointer" } as const,
  linkBtn: { background: "none", border: "none", color: "#0f766e", cursor: "pointer", textDecoration: "underline", fontSize: "inherit", padding: 0 } as const,
  muted: { fontSize: 14, color: "#94a3b8", margin: "10px 0 0" } as const,
  err: { color: "#b91c1c", fontSize: 14, marginTop: 12 } as const,
};
