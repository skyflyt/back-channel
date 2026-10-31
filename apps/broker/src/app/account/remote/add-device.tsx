"use client";

/**
 * "Add": the Devices page's one entry point for connecting anything (docs/web-ia.md, plan §4.2).
 *
 * One button asks "What are you adding?" with three choices. An agent opens the Agents section's connect form
 * (its client picker). A PC and a phone or laptop both mint the same kind of code, one without a role
 * (POST /api/appbridge/v1/account/device-codes with no `role`, docs/appbridge-remote-access.md § Two roles):
 * the app the person types it into decides whether the device is reached or reaches, so a laptop added as
 * "A PC" but typed into the client still works. The choice only picks which where-to-type line to show.
 */

import { useEffect, useState } from "react";
import { ADD_CHOICE, ADD_DEVICE_HINT, ANY_CODE_NOTE, CODE_BUTTON, CODE_FOR, WHERE_TO_ENTER, type RemoteRole } from "./remote-copy";

export type AddChoice = "agent" | "host" | "remote";
interface MintedCode { code: string; expiresAt: string; role: RemoteRole }

const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");

export default function AddDevice({ demo, open, choice, onOpen, onChoice }: {
  demo: boolean;
  /** The chooser is showing. */
  open: boolean;
  /** The path chosen, if any; `agent` hands off to the Agents section. */
  choice: AddChoice | null;
  onOpen: (open: boolean) => void;
  onChoice: (choice: AddChoice | null) => void;
}) {
  const [label, setLabel] = useState("");
  const [minted, setMinted] = useState<MintedCode | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { if (!minted) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [minted]);

  // `role` is the path the person chose (it picks the where-to-type line); the code itself is minted without one.
  async function mint(role: RemoteRole) {
    setBusy(true); setMessage(""); setMinted(null);
    const r = await fetch("/api/appbridge/v1/account/device-codes", {
      method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-bc-csrf": csrf() },
      body: JSON.stringify(label.trim() ? { label: label.trim() } : {}),
    });
    setBusy(false);
    if (r.ok) { const j = await r.json(); setMinted({ code: j.code, expiresAt: j.expiresAt, role }); setLabel(""); return; }
    const j = await r.json().catch(() => ({}));
    setMessage(j.error === "rate_limited" ? "Too many codes this hour. Try again later." : j.error === "email_unverified" ? "Verify your email first." : "Couldn't create a code. Try again.");
  }

  const close = () => { onOpen(false); onChoice(null); setMinted(null); setMessage(""); };
  const secondsLeft = minted ? Math.max(0, Math.round((new Date(minted.expiresAt).getTime() - now) / 1000)) : 0;
  const deviceRole: RemoteRole | null = choice === "host" ? "host" : choice === "remote" ? "remote" : null;

  return (
    <div className="ds-card" id="add">
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="ds-cardh">Add</div>
          <p className="ds-cardsub" style={{ margin: 0 }}>Connect an agent, a PC your agents and your phone can reach, or a phone or laptop you reach from.</p>
        </div>
        {!open ? (
          <button className="ds-btn" onClick={() => { onOpen(true); onChoice(null); }}>＋ Add</button>
        ) : (
          <button className="ds-btn ghost" onClick={close}>Close</button>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 14 }}>
          <label className="ds-label" style={{ marginTop: 0 }}>What are you adding?</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label="What are you adding?">
            {(["agent", "host", "remote"] as const).map((c) => (
              <button key={c} className={choice === c ? "ds-btn" : "ds-btn ghost"} onClick={() => { onChoice(c); setMinted(null); setMessage(""); }}>{ADD_CHOICE[c]}</button>
            ))}
          </div>

          {choice === null && <p className="ds-fine" style={{ margin: "10px 0 0" }}>An agent gets its own key or a one-time agent code. {ADD_DEVICE_HINT}</p>}

          {choice === "agent" && (
            <p className="ds-fine" style={{ margin: "10px 0 0" }}>Pick your AI client in the connect form below: it gets its own key or a one-time agent code.</p>
          )}

          {deviceRole && (
            <div style={{ marginTop: 12 }}>
              <p className="ds-cardsub">{deviceRole === "host"
                ? "A PC running Back Channel on your PC. Your phone can reach it, and your agents can use it, once you've typed the code there."
                : "A phone or laptop you reach your PCs from. Install Back Channel on your phone (or the client on a laptop), then type the code there."}</p>
              <label className="ds-label" htmlFor="remote-label">Name (optional)</label>
              <input id="remote-label" className="ds-input" value={label} maxLength={80} placeholder={deviceRole === "host" ? "e.g. Office PC" : "e.g. My phone"} onChange={(e) => setLabel(e.target.value)} style={{ maxWidth: 280, display: "block", marginBottom: 12 }} />
              <button className="ds-btn" disabled={busy || demo} onClick={() => mint(deviceRole)}>{busy ? "…" : CODE_BUTTON[deviceRole]}</button>
              {minted && (
                <div style={{ marginTop: 16 }} aria-live="polite">
                  <div className="ds-mono" style={{ fontSize: 28, letterSpacing: 2, userSelect: "all" }}>{minted.code}</div>
                  <p className="ds-fine" style={{ margin: "6px 0 0" }}>
                    {secondsLeft > 0
                      ? `For a ${CODE_FOR[minted.role]}. Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}.`
                      : "This code has expired. Get a new one."}
                  </p>
                  <p className="ds-fine" style={{ margin: "6px 0 0" }}>{WHERE_TO_ENTER[minted.role]} It works once and expires after 10 minutes. {ANY_CODE_NOTE}</p>
                </div>
              )}
              {!minted && <p className="ds-fine" style={{ margin: "10px 0 0" }}>{WHERE_TO_ENTER[deviceRole]} The code works once and expires after 10 minutes. {ANY_CODE_NOTE}</p>}
              {message && <p className="ds-fine" style={{ marginTop: 12 }} aria-live="polite">{message}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
