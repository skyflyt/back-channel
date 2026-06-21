"use client";

import { useEffect, useState } from "react";

interface VerifyResult {
  status: string;
  handle: string;
  email: string;
  api_key: string;
  account_id: string;
  bootstrap_prompt: string | null;
}

export default function VerifyPage() {
  const [state, setState] = useState<"probing" | "ready" | "verifying" | "ok" | "error">("probing");
  const [token, setToken] = useState<string | null>(null);
  const [handle, setHandle] = useState<string>("");
  const [data, setData] = useState<VerifyResult | null>(null);
  const [errMsg, setErrMsg] = useState<string>("");
  const [copied, setCopied] = useState(false);
  // Exchange-code connect flow (secure default; raw key stays hidden).
  const [exCode, setExCode] = useState<{ prompt: string; expiry: number } | null>(null);
  const [exLeft, setExLeft] = useState(0);
  const [showRaw, setShowRaw] = useState(false);

  const mintExchange = () => {
    fetch("/api/auth/exchange-code", { method: "POST", credentials: "include", headers: { "x-bc-csrf": (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") } })
      .then((r) => r.json())
      .then((j) => { if (j.code) setExCode({ prompt: j.paste_prompt, expiry: new Date(j.expires_at).getTime() }); })
      .catch(() => {});
  };

  // When verification succeeds, the bc_session cookie is set — mint a connect code.
  useEffect(() => { if (state === "ok") mintExchange(); }, [state]);
  useEffect(() => {
    if (!exCode) return;
    const tick = () => { const left = Math.max(0, Math.round((exCode.expiry - Date.now()) / 1000)); setExLeft(left); if (left <= 0) setExCode(null); };
    tick(); const iv = setInterval(tick, 1000); return () => clearInterval(iv);
  }, [exCode]);

  // On load we only PROBE (non-consuming GET) so that email-security scanners
  // pre-fetching this link can't burn the token. The token is consumed by the
  // POST below, which only fires on a real human button click.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token");
    if (!t) {
      setErrMsg("No token in URL — make sure you clicked the link from your verification email.");
      setState("error");
      return;
    }
    setToken(t);
    fetch(`/api/auth/verify?token=${encodeURIComponent(t)}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) {
          setErrMsg(j.error ?? "verification_failed");
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

  const verify = () => {
    if (!token) return;
    setState("verifying");
    fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) {
          setErrMsg(j.error ?? "verification_failed");
          setState("error");
          return;
        }
        setData(j as VerifyResult);
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
        {state === "probing" && (
          <>
            <h1 style={styles.h1}>Checking your link...</h1>
            <p style={styles.lead}>One moment.</p>
          </>
        )}

        {(state === "ready" || state === "verifying") && (
          <>
            <h1 style={styles.h1}>Verify your account</h1>
            <p style={styles.lead}>
              You&apos;re about to verify{" "}
              <strong style={{ color: "#0f172a" }}>{handle}</strong> and get your API key.
            </p>
            <p style={{ margin: "32px 0" }}>
              <button onClick={verify} disabled={state === "verifying"} style={styles.verifyBtn}>
                {state === "verifying" ? "Verifying..." : "Verify my account"}
              </button>
            </p>
            <p style={styles.smallLead}>
              We don&apos;t verify automatically so that automated email scanners can&apos;t use up
              your one-time link before you do.
            </p>
          </>
        )}

        {state === "error" && (
          <>
            <h1 style={styles.h1}>❌ Verification failed</h1>
            <p style={styles.lead}>
              <code style={styles.code}>{errMsg}</code>
            </p>
            <p style={styles.lead}>
              Possible causes: token already used, expired (24h limit), or never existed. You can
              ask your agent to sign you up again to get a new link.
            </p>
            <p><a href="/" style={styles.link}>← Back to home</a></p>
          </>
        )}

        {state === "ok" && data && (
          <>
            <h1 style={styles.h1}>🎉 Verified!</h1>
            <p style={styles.lead}>
              Your Back Channel handle is{" "}
              <strong style={{ color: "#0f172a" }}>{data.handle}</strong>.
            </p>
            <p style={styles.lead}>
              Paste this one-time code into your AI assistant and it connects to your account.
              Your API key never goes into the chat — the assistant trades the code for it.
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
              Or, if you need to script your key manually,{" "}
              <button onClick={() => setShowRaw((v) => !v)} style={styles.linkBtn}>{showRaw ? "hide it" : "reveal your raw key"}</button>.
              {showRaw && <span><br /><code style={styles.rawKey}>{data.api_key}</code> — store it as your Back Channel credential; don&apos;t paste it into a chat you don&apos;t control.</span>}
            </p>
            <div style={styles.dashCallout}>
              <strong>Saved your key?</strong> Now check out your dashboard — your sessions, the agents you trust, and your settings live there. You&apos;re already signed in.
              <div style={{ marginTop: 12 }}><a href="/account" style={styles.dashBtn}>Open my dashboard →</a></div>
            </div>
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
  keyText: {
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 15,
    wordBreak: "break-all",
    flex: 1,
  } as const,
  copyBtn: {
    background: "#fff",
    color: "#0f172a",
    border: "none",
    borderRadius: 8,
    padding: "8px 16px",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: 14,
  } as const,
  verifyBtn: {
    background: "#0f172a",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "14px 28px",
    fontWeight: 600,
    fontSize: 16,
    cursor: "pointer",
  } as const,
  promptBox: { background: "#0f172a", borderRadius: 10, padding: 16, margin: "16px 0" } as const,
  codeNote: { color: "#fbbf24", fontSize: 13, fontWeight: 600, margin: "0 0 8px", fontFamily: "ui-monospace, Menlo, monospace" } as const,
  linkBtn: { background: "none", border: "none", color: "#0f766e", cursor: "pointer", fontSize: 14, textDecoration: "underline", padding: 0 } as const,
  rawKey: { display: "inline-block", marginTop: 6, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, background: "#f1f5f9", padding: "4px 8px", borderRadius: 6, wordBreak: "break-all", color: "#0f172a" } as const,
  promptText: {
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 13.5,
    lineHeight: 1.55,
    color: "#e2e8f0",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    margin: 0,
  } as const,
  copyBtnWide: {
    marginTop: 12,
    width: "100%",
    background: "#fff",
    color: "#0f172a",
    border: "none",
    borderRadius: 8,
    padding: "10px 16px",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: 14,
  } as const,
};
