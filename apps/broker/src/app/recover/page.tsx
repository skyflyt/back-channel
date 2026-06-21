"use client";

import { useEffect, useState } from "react";

interface RecoverResult {
  status: string;
  handle: string;
  email: string;
  api_key: string;
  account_id: string;
  bootstrap_prompt: string | null;
  note?: string;
}

export default function RecoverPage() {
  // Two modes:
  //  - no token in URL  -> ask for email, POST /api/accounts/recover
  //  - token in URL     -> scanner-tolerant: GET probe, button click POSTs
  //                        /api/auth/recover-key which rotates the key.
  const [state, setState] = useState<
    "init" | "form" | "sending" | "sent" | "probing" | "ready" | "rotating" | "ok" | "error"
  >("init");
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [handle, setHandle] = useState("");
  const [data, setData] = useState<RecoverResult | null>(null);
  const [errMsg, setErrMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [exCode, setExCode] = useState<{ prompt: string; expiry: number } | null>(null);
  const [exLeft, setExLeft] = useState(0);
  const [showRaw, setShowRaw] = useState(false);

  const mintExchange = () => {
    fetch("/api/auth/exchange-code", { method: "POST", credentials: "include", headers: { "x-bc-csrf": (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") } })
      .then((r) => r.json())
      .then((j) => { if (j.code) setExCode({ prompt: j.paste_prompt, expiry: new Date(j.expires_at).getTime() }); })
      .catch(() => {});
  };
  useEffect(() => { if (state === "ok") mintExchange(); }, [state]);
  useEffect(() => {
    if (!exCode) return;
    const tick = () => { const left = Math.max(0, Math.round((exCode.expiry - Date.now()) / 1000)); setExLeft(left); if (left <= 0) setExCode(null); };
    tick(); const iv = setInterval(tick, 1000); return () => clearInterval(iv);
  }, [exCode]);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token");
    if (!t) {
      setState("form");
      return;
    }
    setToken(t);
    setState("probing");
    fetch(`/api/auth/verify?token=${encodeURIComponent(t)}`) // non-consuming probe (shared)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) {
          setErrMsg(j.error ?? "recovery_failed");
          setState("error");
          return;
        }
        setHandle(j.handle ?? "");
        setState("ready");
      })
      .catch((e) => {
        setErrMsg(e instanceof Error ? e.message : String(e));
        setState("error");
      });
  }, []);

  const requestLink = () => {
    if (!email.includes("@")) {
      setErrMsg("Enter a valid email.");
      setState("error");
      return;
    }
    setState("sending");
    fetch("/api/accounts/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    })
      .then(async (r) => {
        if (!r.ok && r.status !== 200) {
          const j = await r.json().catch(() => ({}));
          setErrMsg(j.message ?? j.error ?? "request_failed");
          setState("error");
          return;
        }
        setState("sent");
      })
      .catch((e) => {
        setErrMsg(e instanceof Error ? e.message : String(e));
        setState("error");
      });
  };

  const rotate = () => {
    if (!token) return;
    setState("rotating");
    fetch("/api/auth/recover-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) {
          setErrMsg(j.error ?? "recovery_failed");
          setState("error");
          return;
        }
        setData(j as RecoverResult);
        setState("ok");
      })
      .catch((e) => {
        setErrMsg(e instanceof Error ? e.message : String(e));
        setState("error");
      });
  };

  const copy = () => {
    const text = exCode?.prompt ?? data?.bootstrap_prompt ?? data?.api_key;
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        {(state === "init" || state === "probing") && (
          <>
            <h1 style={styles.h1}>Recover your API key</h1>
            <p style={styles.lead}>One moment.</p>
          </>
        )}

        {(state === "form" || state === "sending") && (
          <>
            <h1 style={styles.h1}>Recover your API key</h1>
            <p style={styles.lead}>
              Lost your Back Channel key? Enter your email and we&apos;ll send a recovery link.
              Clicking it issues a fresh key and invalidates the old one.
            </p>
            <div style={styles.row}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                style={styles.input}
                onKeyDown={(e) => e.key === "Enter" && requestLink()}
              />
              <button onClick={requestLink} disabled={state === "sending"} style={styles.verifyBtn}>
                {state === "sending" ? "Sending..." : "Send recovery link"}
              </button>
            </div>
            <p style={styles.smallLead}>
              For your privacy we always say &quot;check your email&quot; — we never reveal whether an
              account exists.
            </p>
          </>
        )}

        {state === "sent" && (
          <>
            <h1 style={styles.h1}>Check your email</h1>
            <p style={styles.lead}>
              If an account exists for that email, a recovery link is on its way. The link expires
              in 24 hours.
            </p>
            <p><a href="/" style={styles.link}>← Back to home</a></p>
          </>
        )}

        {(state === "ready" || state === "rotating") && (
          <>
            <h1 style={styles.h1}>Recover your API key</h1>
            <p style={styles.lead}>
              You&apos;re about to issue a fresh key for{" "}
              <strong style={{ color: "#0f172a" }}>{handle}</strong>.{" "}
              <strong>Your current key will stop working immediately.</strong>
            </p>
            <p style={{ margin: "32px 0" }}>
              <button onClick={rotate} disabled={state === "rotating"} style={styles.verifyBtn}>
                {state === "rotating" ? "Rotating..." : "Recover my API key"}
              </button>
            </p>
            <p style={styles.smallLead}>
              We don&apos;t rotate automatically so that automated email scanners can&apos;t consume
              your link before you do.
            </p>
          </>
        )}

        {state === "ok" && data && (
          <>
            <h1 style={styles.h1}>🔑 New key issued</h1>
            <p style={styles.lead}>
              Your handle is <strong style={{ color: "#0f172a" }}>{data.handle}</strong>. Your old
              key is now <strong>invalid</strong>. Paste this one-time code into your assistant to
              reconnect it — your new key never goes into the chat.
            </p>
            {exCode ? (
              <div style={styles.promptBox}>
                <p style={styles.codeNote}>Expires in :{String(exLeft).padStart(2, "0")}</p>
                <pre style={styles.promptText}>{exCode.prompt}</pre>
                <button onClick={copy} style={styles.copyBtnWide}>{copied ? "✓ Copied" : "Copy connect code"}</button>
              </div>
            ) : (
              <div style={styles.promptBox}>
                <p style={styles.promptText}>Your connect code expired.</p>
                <button onClick={() => { setShowRaw(false); mintExchange(); }} style={styles.copyBtnWide}>Generate a new code</button>
              </div>
            )}
            <p style={styles.smallLead}>
              Or, to script your key manually,{" "}
              <button onClick={() => setShowRaw((v) => !v)} style={styles.linkBtn}>{showRaw ? "hide it" : "reveal your raw key"}</button>.
              {showRaw && <span><br /><code style={styles.rawKey}>{data.api_key}</code></span>}
            </p>
            <div style={styles.dashCallout}>
              <strong>Saved your new key?</strong> Head to your dashboard to see your sessions, trusted agents, and settings — you&apos;re already signed in.
              <div style={{ marginTop: 12 }}><a href="/account" style={styles.dashBtn}>Open my dashboard →</a></div>
            </div>
            <p><a href="/" style={styles.link}>← Back to home</a></p>
          </>
        )}

        {state === "error" && (
          <>
            <h1 style={styles.h1}>❌ Recovery failed</h1>
            <p style={styles.lead}><code style={styles.code}>{errMsg}</code></p>
            <p style={styles.lead}>
              The link may be used, expired (24h limit), or invalid. Start over from{" "}
              <a href="/recover" style={styles.link}>the recovery page</a>.
            </p>
            <p><a href="/" style={styles.link}>← Back to home</a></p>
          </>
        )}
      </div>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #fafaf9 0%, #f5f5f4 100%)",
    fontFamily: "system-ui, -apple-system, sans-serif",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 24px",
  } as const,
  card: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 16,
    padding: "48px 40px",
    maxWidth: 600,
    width: "100%",
    boxShadow: "0 4px 24px rgba(0,0,0,0.04)",
  } as const,
  h1: { fontSize: 32, fontWeight: 700, margin: "0 0 16px", color: "#0f172a" } as const,
  lead: { fontSize: 17, color: "#475569", lineHeight: 1.6, margin: "0 0 16px" } as const,
  smallLead: { fontSize: 14, color: "#94a3b8", margin: "16px 0" } as const,
  code: { fontFamily: "ui-monospace, monospace", fontSize: 14, background: "#fef2f2", color: "#b91c1c", padding: "2px 8px", borderRadius: 6 } as const,
  link: { color: "#0f172a", textDecoration: "underline" } as const,
  dashCallout: { background: "#f0fdfa", border: "1px solid #99f6e4", borderRadius: 12, padding: "16px 18px", margin: "20px 0", fontSize: 15, color: "#0f766e", lineHeight: 1.6 } as const,
  dashBtn: { display: "inline-block", background: "#0f766e", color: "#fff", borderRadius: 9, padding: "9px 18px", fontWeight: 600, fontSize: 14, textDecoration: "none" } as const,
  row: { display: "flex", gap: 12, flexWrap: "wrap", margin: "24px 0 8px" } as const,
  input: {
    flex: 1,
    minWidth: 220,
    fontSize: 16,
    padding: "12px 16px",
    border: "1px solid #cbd5e1",
    borderRadius: 10,
    fontFamily: "inherit",
  } as const,
  keyBox: {
    background: "#0f172a",
    color: "#e2e8f0",
    padding: "16px 20px",
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    margin: "16px 0",
    flexWrap: "wrap",
  } as const,
  keyText: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 15, wordBreak: "break-all", flex: 1 } as const,
  copyBtn: { background: "#fff", color: "#0f172a", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 600, cursor: "pointer", fontSize: 14 } as const,
  verifyBtn: { background: "#0f172a", color: "#fff", border: "none", borderRadius: 10, padding: "14px 28px", fontWeight: 600, fontSize: 16, cursor: "pointer" } as const,
  promptBox: { background: "#0f172a", borderRadius: 10, padding: 16, margin: "16px 0" } as const,
  codeNote: { color: "#fbbf24", fontSize: 13, fontWeight: 600, margin: "0 0 8px", fontFamily: "ui-monospace, Menlo, monospace" } as const,
  linkBtn: { background: "none", border: "none", color: "#0f766e", cursor: "pointer", fontSize: 14, textDecoration: "underline", padding: 0 } as const,
  rawKey: { display: "inline-block", marginTop: 6, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, background: "#f1f5f9", padding: "4px 8px", borderRadius: 6, wordBreak: "break-all", color: "#0f172a" } as const,
  promptText: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13.5, lineHeight: 1.55, color: "#e2e8f0", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 } as const,
  copyBtnWide: { marginTop: 12, width: "100%", background: "#fff", color: "#0f172a", border: "none", borderRadius: 8, padding: "10px 16px", fontWeight: 600, cursor: "pointer", fontSize: 14 } as const,
};
