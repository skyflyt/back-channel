"use client";

import { useState } from "react";

/** "I didn't ask for this": cancels the code and files a report the issuer sees (POST /api/support/report). */
export function ReportButton({ code }: { code: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [message, setMessage] = useState("");
  async function report() {
    setState("busy");
    try {
      const r = await fetch("/api/support/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
      const j = await r.json().catch(() => ({}));
      setMessage(typeof j.message === "string" ? j.message : "Couldn't reach Back Channel. Try again.");
      setState(r.ok || r.status === 410 ? "done" : "idle");
    } catch {
      setMessage("Couldn't reach Back Channel. Try again.");
      setState("idle");
    }
  }
  return (
    <div>
      {state !== "done" && <button className="ds-btn danger" disabled={state === "busy"} onClick={report}>I didn&apos;t ask for this</button>}
      {message && <p style={{ margin: state === "done" ? 0 : "10px 0 0", lineHeight: 1.6, fontSize: 14 }} aria-live="polite">{message}</p>}
    </div>
  );
}
