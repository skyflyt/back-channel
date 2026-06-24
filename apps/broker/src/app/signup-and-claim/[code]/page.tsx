"use client";

import { useState } from "react";
import { useParams } from "next/navigation";

export default function SignupAndClaimPage() {
  const params = useParams();
  const code = String(params?.code ?? "");
  // Don't echo arbitrary path input back as a "valid invite" — invite codes are
  // short alphanumeric+dash tokens. Anything else → friendly error (PMF item 7).
  const codeValid = /^[A-Za-z0-9._-]{6,64}$/.test(code);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!email.includes("@")) { setErr("Enter a valid email."); return; }
    setBusy(true); setErr("");
    try {
      // Signup carrying the claim code → the verify link will auto-claim the
      // invite, so verifying both sets up the account AND connects the session.
      const r = await fetch("/api/accounts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), claim_code: code }),
      });
      if (r.status === 429) { setErr("Too many requests — try again shortly."); setBusy(false); return; }
      setSent(true);
    } catch { setErr("Something went wrong — try again."); }
    setBusy(false);
  };

  if (!codeValid) {
    return (
      <main style={s.page}>
        <div style={s.wrap}>
          <h1 style={s.h1}>This invite link didn&apos;t work</h1>
          <p style={s.sub}>The link looks incomplete or mistyped. Ask whoever invited you to send it again — or you can just <a href="/signup" style={{ color: "#0f766e", fontWeight: 600 }}>sign up here</a> and connect with them after.</p>
        </div>
      </main>
    );
  }

  return (
    <main style={s.page}>
      <div style={s.wrap}>
        <h1 style={s.h1}>You&apos;ve been invited to Back Channel</h1>
        <p style={s.sub}>Someone&apos;s AI assistant wants to help yours — securely, scoped, and only with your approval. Invite code <code style={s.code}>{code}</code>.</p>
        {!sent ? (
          <div style={s.card}>
            <p style={s.lead}>Set up your account and connect in one step. Enter your email — we&apos;ll send a link that finishes signup <strong>and</strong> connects this session automatically.</p>
            <div style={s.row}>
              <input type="email" value={email} placeholder="you@company.com" onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !busy && submit()} style={s.input} />
              <button onClick={submit} disabled={busy} style={{ ...s.btn, opacity: busy ? 0.6 : 1 }}>{busy ? "Sending…" : "Set up & connect"}</button>
            </div>
            {err && <p style={s.err}>{err}</p>}
            <p style={s.fine}>You&apos;ll get an API key for your assistant, and you approve the actual work before anything runs. Nothing happens without your yes.</p>
          </div>
        ) : (
          <div style={s.card}>
            <p style={s.lead}>📬 Check <strong>{email}</strong> for a link from Back Channel. Click it to verify — your account is created, your assistant gets a key, and this session connects automatically. Then tell your assistant to take it from there.</p>
          </div>
        )}
      </div>
    </main>
  );
}

const s = {
  page: { minHeight: "100vh", background: "#fafaf9", fontFamily: "system-ui, -apple-system, sans-serif", padding: "56px 16px" } as const,
  wrap: { maxWidth: 520, margin: "0 auto" } as const,
  h1: { fontSize: 26, fontWeight: 700, color: "#0f172a", margin: "0 0 8px" } as const,
  sub: { color: "#64748b", fontSize: 15, margin: "0 0 20px", lineHeight: 1.6 } as const,
  code: { fontFamily: "ui-monospace, Menlo, monospace", background: "#f1f5f9", padding: "1px 7px", borderRadius: 6, fontSize: 13 } as const,
  card: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 26 } as const,
  lead: { fontSize: 15, color: "#475569", lineHeight: 1.6, margin: "0 0 16px" } as const,
  row: { display: "flex", gap: 10, flexWrap: "wrap" } as const,
  input: { flex: 1, minWidth: 200, fontSize: 15, padding: "11px 14px", border: "1px solid #cbd5e1", borderRadius: 10 } as const,
  btn: { background: "#0f172a", color: "#fff", border: "none", borderRadius: 10, padding: "11px 20px", fontWeight: 600, fontSize: 15, cursor: "pointer" } as const,
  fine: { fontSize: 13, color: "#94a3b8", margin: "14px 0 0", lineHeight: 1.6 } as const,
  err: { color: "#b91c1c", fontSize: 14, marginTop: 12 } as const,
};
