"use client";

import { useState } from "react";

/**
 * Client-only copy affordance for one lesson's agent-facing review prompt.
 * Split out from page.tsx (a server component) so the page itself can stay
 * server-rendered — this needs client interactivity for the clipboard write.
 */
export default function CopyPromptButton({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);

  function handleClick() {
    navigator.clipboard?.writeText(prompt).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button className="lp-btn lp-btn-primary" onClick={handleClick}>
      {copied ? "Copied ✓" : "📋 Copy review prompt for your agent"}
    </button>
  );
}