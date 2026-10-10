"use client";

import { useState } from "react";

// The same normalisation as remote-support/rules.mjs normalizeCode, kept tiny for the browser.
const ALPHABET = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/;
function normalize(value: string): string | null {
  let v = value.toUpperCase().replace(/[\s-]/g, "");
  if (v.length === 11 && v.startsWith("BCS")) v = v.slice(3);
  return ALPHABET.test(v) ? `BCS-${v.slice(0, 4)}-${v.slice(4)}` : null;
}

export function CodeForm() {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  function go(e: React.FormEvent) {
    e.preventDefault();
    const code = normalize(value);
    if (!code) { setError("That doesn't look like a support code. It looks like BCS-ABCD-EFGH."); return; }
    window.location.assign(`/support/${code}`);
  }
  return (
    <form onSubmit={go}>
      <label className="ds-label" htmlFor="support-code">Code</label>
      <input id="support-code" className="ds-input ds-mono" value={value} placeholder="BCS-ABCD-EFGH" autoComplete="off" autoCapitalize="characters" spellCheck={false}
        maxLength={20} onChange={(e) => { setValue(e.target.value); setError(""); }} style={{ fontSize: 18, letterSpacing: 1, marginBottom: 12 }} />
      <button className="ds-btn" type="submit">Continue</button>
      {error && <p className="ds-fine" style={{ margin: "10px 0 0", color: "var(--ds-warn)" }} aria-live="polite">{error}</p>}
    </form>
  );
}
