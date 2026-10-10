"use client";

/**
 * The one-time connect code shown after verifying an account (/verify) or recovering a key (/recover).
 *
 * Minting a code needs the person's passkey step-up (src/lib/step-up.ts), so an agent driving a PC whose browser is
 * signed in can't connect itself. An account with no passkey adds one here first (Windows Hello or a phone), then
 * confirms with it. Every passkey prompt runs on a click, never on page load. With the step-up switched off
 * (APPROVAL_STEP_UP=off), the code is made straight away, as before.
 *
 * Plain text only: the site's Trusted Types CSP blanks the page on raw HTML. Inline styles, like the pages it sits in.
 */

import { useCallback, useEffect, useState } from "react";
import { addPasskey, loadPasskeys, sendWithStepUp, type StepUpHint } from "./account/passkey-client";

const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");
/** What minting needs right now: still checking, nothing (the step-up is off), a confirmation, or a passkey first. */
type Gate = "checking" | "none" | "confirm" | "add";

export function ConnectCodeBox() {
  const [gate, setGate] = useState<Gate>("checking");
  const [code, setCode] = useState<{ prompt: string; expiry: number } | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const mint = useCallback(async (hint?: StepUpHint) => {
    setBusy(true); setError("");
    const r = await sendWithStepUp("connect_agent", null, (h) => fetch("/api/auth/exchange-code", {
      method: "POST", credentials: "include", headers: { "x-bc-csrf": csrf(), ...h },
    }), hint);
    const j = r.body as { code?: string; paste_prompt?: string; expires_at?: string };
    if (r.ok && j.code) setCode({ prompt: j.paste_prompt ?? j.code, expiry: new Date(j.expires_at ?? 0).getTime() });
    else if (r.needsPasskey) setGate("add");
    else setError(r.message ?? "Couldn't make a connect code. Try again.");
    setBusy(false);
  }, []);

  useEffect(() => {
    let stop = false;
    void loadPasskeys().then((p) => {
      if (stop) return;
      const g: Gate = !p ? "confirm" : p.stepUp === "off" ? "none" : p.passkeys.length ? "confirm" : "add";
      setGate(g);
      if (g === "none") void mint();
    });
    return () => { stop = true; };
  }, [mint]);

  useEffect(() => {
    if (!code) return;
    const tick = () => { const s = Math.max(0, Math.round((code.expiry - Date.now()) / 1000)); setLeft(s); if (s <= 0) setCode(null); };
    tick(); const iv = setInterval(tick, 1000); return () => clearInterval(iv);
  }, [code]);

  async function addThenMint() {
    setBusy(true); setError("");
    try { await addPasskey(""); }
    catch (e) { setError(e instanceof Error ? e.message : "The passkey couldn't be added. Try again."); setBusy(false); return; }
    setGate("confirm");
    await mint("needed");
  }

  function copy() {
    if (!code) return;
    navigator.clipboard.writeText(code.prompt).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <>
      {code ? (
        <div style={st.promptBox}>
          <p style={st.codeNote}>Expires in :{String(left).padStart(2, "0")}</p>
          <pre style={st.promptText}>{code.prompt}</pre>
          <button onClick={copy} style={st.copyBtnWide}>{copied ? "✓ Copied" : "Copy connect code"}</button>
        </div>
      ) : gate === "add" ? (
        <div style={st.passkeyBox}>
          <p style={{ margin: "0 0 10px" }}>
            <strong>One more step: add a passkey.</strong> Connecting an agent asks for your passkey (Windows Hello on this PC, or your phone), and so
            does approving anything an agent asks to do on your PCs. Agents can&apos;t use a passkey, so they can never do those things by themselves.
            You&apos;ll be asked twice: once to add it, once to confirm.
          </p>
          <button onClick={addThenMint} disabled={busy} style={st.passkeyBtn}>{busy ? "Waiting for your passkey…" : "Add a passkey, then get my code"}</button>
        </div>
      ) : gate === "none" ? (
        <div style={st.promptBox}>
          <p style={st.promptText}>{busy ? "Making your connect code…" : "Your connect code expired."}</p>
          {!busy && <button onClick={() => mint()} style={st.copyBtnWide}>Generate a new code</button>}
        </div>
      ) : (
        <div style={st.promptBox}>
          <p style={st.promptText}>Confirm it&apos;s you with your passkey (Windows Hello or your phone) to get a one-time connect code.</p>
          <button onClick={() => mint("needed")} disabled={busy || gate === "checking"} style={st.copyBtnWide}>{busy ? "Waiting for your passkey…" : "Get my connect code"}</button>
        </div>
      )}
      {error && <p style={st.error} aria-live="polite">{error}</p>}
    </>
  );
}

const st = {
  promptBox: { background: "#0f172a", borderRadius: 10, padding: 16, margin: "16px 0" } as const,
  codeNote: { color: "#fbbf24", fontSize: 13, fontWeight: 600, margin: "0 0 8px", fontFamily: "ui-monospace, Menlo, monospace" } as const,
  promptText: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13.5, lineHeight: 1.55, color: "#e2e8f0", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 } as const,
  copyBtnWide: { marginTop: 12, width: "100%", background: "#fff", color: "#0f172a", border: "none", borderRadius: 8, padding: "10px 16px", fontWeight: 600, cursor: "pointer", fontSize: 14 } as const,
  passkeyBox: { background: "#f0fdfa", border: "1px solid #99f6e4", borderRadius: 12, padding: "16px 18px", margin: "16px 0", fontSize: 15, color: "#0f766e", lineHeight: 1.6 } as const,
  passkeyBtn: { background: "#0f766e", color: "#fff", border: "none", borderRadius: 9, padding: "9px 18px", fontWeight: 600, fontSize: 14, cursor: "pointer" } as const,
  error: { fontSize: 14, color: "#b91c1c", margin: "8px 0 16px" } as const,
};
