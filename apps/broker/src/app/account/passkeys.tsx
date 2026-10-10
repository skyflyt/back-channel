"use client";

/**
 * Passkeys in the dashboard: the Settings tab's "Passkeys" card, the in-place "Add a passkey" call-out the approve and
 * connect buttons show when the account has none, and a hook that tells those buttons whether the passkey prompt comes
 * first. Why passkeys: src/lib/step-up.ts. The calls: ./passkey-client.ts.
 *
 * Plain text only: the page's Trusted Types CSP blanks it on any raw HTML, so every string here is a React text node.
 */

import { useCallback, useEffect, useState } from "react";
import { Chip } from "@/components/ui/primitives";
import { addPasskey, hintFor, loadPasskeys, removePasskey, type PasskeyState, type StepUpHint } from "./passkey-client";

function when(iso: string | null): string {
  if (!iso) return "";
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** The account's passkeys and the step-up hint for the buttons that need one. */
export function usePasskeys(enabled = true): { state: PasskeyState | null; hint: StepUpHint; reload: () => Promise<void> } {
  const [state, setState] = useState<PasskeyState | null>(null);
  const reload = useCallback(async () => { setState(await loadPasskeys()); }, []);
  useEffect(() => { if (enabled) void reload(); }, [enabled, reload]);
  return { state, hint: hintFor(state), reload };
}

/**
 * Shown in place when an action needs a passkey and the account has none: add one now, then the action carries on
 * (onAdded runs it again, which asks for the new passkey once more to confirm).
 */
export function AddPasskeyInline({ action, onAdded, onCancel }: { action: string; onAdded: () => void; onCancel?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function add() {
    setBusy(true); setError("");
    try { await addPasskey(""); setBusy(false); onAdded(); }
    catch (e) { setError(e instanceof Error ? e.message : "The passkey couldn't be added. Try again."); setBusy(false); }
  }
  return (
    <div className="ds-call acc" style={{ marginTop: 10 }} role="status">
      <p style={{ margin: "0 0 8px", fontWeight: 600 }}>{action} needs a passkey on your account first.</p>
      <p className="ds-fine" style={{ margin: "0 0 10px" }}>
        Use Windows Hello on this PC, or your phone. Agents can&apos;t use a passkey, so an agent working on one of your PCs can&apos;t do this for itself.
        You&apos;ll be asked twice: once to add it, once to confirm.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="ds-btn" disabled={busy} onClick={add}>{busy ? "Waiting for your passkey…" : "Add a passkey"}</button>
        {onCancel && <button className="ds-btn ghost" disabled={busy} onClick={onCancel}>Not now</button>}
      </div>
      {error && <p className="ds-fine" style={{ margin: "8px 0 0" }} aria-live="polite">{error}</p>}
    </div>
  );
}

/** Settings → Passkeys: what they're for, the list, add and remove. */
export function PasskeysCard({ demoMode }: { demoMode: boolean }) {
  const { state, hint, reload } = usePasskeys(!demoMode);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  async function add() {
    setBusy("add"); setMessage("");
    try {
      const p = await addPasskey(label, hint);
      setLabel(""); setMessage(`Added "${p.label}". Approvals and new agent connections will ask for it.`);
    } catch (e) { setMessage(e instanceof Error ? e.message : "The passkey couldn't be added. Try again."); }
    setBusy(""); await reload();
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(`Remove the passkey "${name}"? You'll confirm with a passkey first.`)) return;
    setBusy(`remove:${id}`); setMessage("");
    const r = await removePasskey(id, hint);
    setMessage(r.ok ? `Removed "${name}".` : r.message ?? "That didn't work. Try again.");
    setBusy(""); await reload();
  }

  const list = state?.passkeys ?? [];
  return (
    <div className="ds-card" style={{ marginBottom: 14 }} id="passkeys">
      <h2 className="ds-cardh">Passkeys</h2>
      <p className="ds-cardsub">
        Approving an agent&apos;s request to use one of your PCs, approving a support code, and connecting a new agent each ask for a passkey: Windows Hello on this PC,
        or your phone. Agents can&apos;t use a passkey, so an agent working on one of your PCs can&apos;t approve itself, even in a browser that&apos;s signed in here.
        Denying and stopping never need one.
      </p>
      {demoMode ? <p className="ds-fine">Sign in to manage passkeys.</p> : !state ? <p className="ds-fine">Couldn&apos;t load your passkeys. Refresh to try again.</p> : (
        <>
          {state.stepUp === "off" && (
            <p className="ds-call warn" style={{ marginBottom: 12 }}>Passkey confirmation is switched off on Back Channel for now (an emergency setting), so approvals don&apos;t ask for one. Your passkeys are kept.</p>
          )}
          {list.length === 0 && (
            <p className="ds-call warn" style={{ marginBottom: 12 }}>You have no passkey yet, so approvals and new agent connections are refused until you add one.</p>
          )}
          {list.map((p) => (
            <div className="ds-item" key={p.id}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="ds-iname">{p.label} {p.transports.includes("hybrid") && <Chip>phone</Chip>}</div>
                <div className="ds-imeta">added {when(p.createdAt)} · {p.lastUsedAt ? `last used ${when(p.lastUsedAt)}` : "not used yet"}</div>
              </div>
              <div className="ds-iright">
                <button className="ds-btn ghost" style={{ fontSize: 12, padding: "5px 10px" }} disabled={!!busy} onClick={() => remove(p.id, p.label)}>{busy === `remove:${p.id}` ? "…" : "Remove"}</button>
              </div>
            </div>
          ))}
          <label className="ds-label" htmlFor="passkey-label">Name the new one (optional)</label>
          <input id="passkey-label" className="ds-input" value={label} maxLength={60} placeholder="e.g. Office PC (Windows Hello) or My phone" onChange={(e) => setLabel(e.target.value)} style={{ maxWidth: 320, display: "block", marginBottom: 10 }} />
          <button className="ds-btn" disabled={!!busy} onClick={add}>{busy === "add" ? "Waiting for your passkey…" : "Add a passkey"}</button>
          <p className="ds-fine" style={{ marginTop: 8 }}>
            {list.length > 0 ? "Adding or removing one asks you to confirm with a passkey you already have. " : ""}
            Back Channel keeps only each passkey&apos;s public key and a counter, never anything that could sign in as you. Browser access below uses its own passkey, separately.
          </p>
          {message && <p className="ds-fine" style={{ marginTop: 8 }} aria-live="polite">{message}</p>}
        </>
      )}
    </div>
  );
}
