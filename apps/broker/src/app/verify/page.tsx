"use client";

import { useEffect, useState } from "react";

interface VerifyResult {
  status: string;
  handle: string;
  email: string;
  api_key: string;
  account_id: string;
}

export default function VerifyPage() {
  const [state, setState] = useState<"probing" | "ready" | "verifying" | "ok" | "error">("probing");
  const [token, setToken] = useState<string | null>(null);
  const [handle, setHandle] = useState<string>("");
  const [data, setData] = useState<VerifyResult | null>(null);
  const [errMsg, setErrMsg] = useState<string>("");
  const [copied, setCopied] = useState(false);

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
    if (!data) return;
    navigator.clipboard.writeText(data.api_key);
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
              Paste this API key into your AI agent to finish setup. <strong>This is shown once —
              don&apos;t close this tab without copying it.</strong>
            </p>
            <div style={styles.keyBox}>
              <code style={styles.keyText}>{data.api_key}</code>
              <button onClick={copy} style={styles.copyBtn}>
                {copied ? "✓ Copied" : "Copy"}
              </button>
            </div>
            <p style={styles.lead}>
              Tell your agent: <em>&quot;My Back Channel API key is {data.api_key}&quot;</em>. The
              agent stores it locally and uses it for all future Back Channel calls.
            </p>
            <p style={styles.smallLead}>
              Lost the key? Sign up again with the same email — we&apos;ll re-issue.
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
};
