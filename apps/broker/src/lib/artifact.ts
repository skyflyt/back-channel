import { randomBytes, createHash } from "node:crypto";

/**
 * Stable identity hash for library dedup (spec: "first check it's not already in
 * the library"). Identity = type + name + body; manifest tweaks/tags don't make a
 * "different" artifact. Used server-side so the agent doesn't need to match a
 * canonicalization.
 */
export function contentHash(type: string, name: string, body: string): string {
  return "ch_" + createHash("sha256").update(`${type || "skill"}\n${(name || "").trim()}\n${(body || "").trim()}`).digest("hex");
}

/**
 * Artifact platform helpers (spec §1.3, §3.2). The broker treats `body` as opaque
 * and `manifest` as inspectable-but-never-executed metadata.
 */

export type ArtifactType = "skill" | "scheduled_task" | "prompt";
export const ARTIFACT_TYPES: ArtifactType[] = ["skill", "scheduled_task", "prompt"];

// Crockford base32 (no I/L/O/U) — unguessable public-share token: "bcA" + 32 chars
// over 20 random bytes (160 bits). Capability URL, like a Google Doc share link.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function genPublicToken(): string {
  const buf = randomBytes(20);
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += CROCKFORD[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return "bcA" + out;
}
export const isPublicToken = (t: string) => /^bcA[0-9A-HJKMNP-TV-Z]{30,40}$/.test(t);

export const TTL_HUMAN: Record<string, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days", never: "never" };

/** TTL options for a public share (spec §3.1). */
export function ttlToExpiry(ttl: string): Date | null {
  const now = Date.now();
  switch (ttl) {
    case "24h": return new Date(now + 24 * 3600_000);
    case "30d": return new Date(now + 30 * 24 * 3600_000);
    case "never": return null;
    case "7d": default: return new Date(now + 7 * 24 * 3600_000); // default
  }
}

type SkillRow = {
  id: string; type: string; name: string; description: string | null; kind: string;
  body: string; signature: string | null; paramSchema: unknown; manifest: unknown; version: number;
  revision: string | null; publicToken: string | null; publicExpiresAt: Date | null;
};

/** Legacy skill rows have no manifest; synthesize one on read (spec §1.3). */
export function effectiveManifest(a: SkillRow, authorHandle: string): Record<string, unknown> {
  if (a.manifest && typeof a.manifest === "object") return a.manifest as Record<string, unknown>;
  return {
    type: a.type || "skill",
    kind: a.kind,
    version: `${a.version}.0.0`,
    revision: a.revision ?? undefined,
    param_schema: a.paramSchema ?? undefined,
    author_handle: authorHandle,
  };
}

const INSTALL_VERB: Record<string, string> = {
  skill: "install", prompt: "save_prompt", scheduled_task: "register_schedule",
};

/** Markdown the recipient agent prints to the user before installing (spec §3.2). */
export function humanReadableMd(a: SkillRow, authorHandle: string): string {
  const who = authorHandle.replace(/@bc$/, "");
  const t = a.type || "skill";
  const label = t === "scheduled_task" ? "scheduled task" : t;
  const lines = [
    `**${a.name}** — a ${label} shared by **${who}** via Back Channel.`,
    a.description ? `\n${a.description}` : "",
  ];
  if (t === "scheduled_task") lines.push(`\n⏰ This sets up a **recurring task** on your agent. It will run on a schedule until you remove it.`);
  if (t === "prompt") lines.push(`\n💬 This is a **saved prompt** — nothing runs automatically; you invoke it when you want.`);
  if (t === "skill") lines.push(`\n📜 This is a **skill** your agent can run.`);
  lines.push(`\n_Signed by ${who}; verify the signature before trusting the body._`);
  return lines.filter(Boolean).join("\n");
}

/** The JSON envelope an agent receives from GET /a/<token> (spec §3.2 Variant B). */
export function buildEnvelope(a: SkillRow, author: { handle: string; pubkey: string | null }, token: string) {
  const t = (a.type || "skill") as ArtifactType;
  return {
    sdk_version: "0.1",
    artifact: {
      id: a.id,
      type: t,
      name: a.name,
      description: a.description,
      manifest: effectiveManifest(a, author.handle),
      body: a.body,
      signature: a.signature,
      author: { handle: author.handle, pubkey: author.pubkey, verified_by_bc: true },
      share: { token, expires_at: a.publicExpiresAt?.toISOString() ?? null },
    },
    install_instructions: {
      human_readable_md: humanReadableMd(a, author.handle),
      platform_hints: {
        cowork: "Save it via your skills/prompt creator; for a scheduled task use create_scheduled_task with the body.",
        claude_code: "Drop a skill into ~/.claude/skills/<name>/, a prompt into your prompt vault, or register a scheduled task via a hook/cron wrapper.",
        codex: "Add a skill/prompt to your vault; for a scheduled task add a `codex exec` entry to your crontab.",
        chatgpt: "Store as a Custom GPT instruction or saved prompt; scheduled tasks need an external scheduler.",
        any: "Store the body as a saved " + t + " you can invoke. If it's a scheduled task and you have a scheduler, register it; otherwise the user can run it manually.",
      },
      install_verb: INSTALL_VERB[t] ?? "install",
    },
    claim_account_url: `https://back-channel.app/signup?from_share=${token}`,
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const TYPE_BADGE: Record<string, string> = { skill: "📜 Skill", scheduled_task: "⏰ Scheduled Task", prompt: "💬 Prompt" };

/** Browser landing page for a human who opens /a/<token> (spec §3.2 Variant A). */
export function landingHtml(a: SkillRow, author: { handle: string }, token: string, opts?: { signedIn?: boolean }): string {
  const who = esc(author.handle.replace(/@bc$/, ""));
  const t = a.type || "skill";
  const badge = TYPE_BADGE[t] ?? "📜 Skill";
  const paste = `Add this to my agent: https://back-channel.app/a/${token}`;
  const expiry = a.publicExpiresAt ? `Link expires ${esc(a.publicExpiresAt.toUTCString())}.` : "This link does not expire.";
  const warn = t === "scheduled_task"
    ? `<p class="warn">⏰ This installs a <b>recurring task</b> on your agent — it will run on a schedule until you remove it. Only proceed if you trust <b>${who}</b>.</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(a.name)} · Back Channel</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; max-width: 640px; margin: 0 auto; padding: 32px 20px; color: #1a1a1a; background: #fafafa; }
  @media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #161616; } }
  .badge { display:inline-block; font-size:13px; padding:3px 10px; border-radius:999px; background:#eef; color:#334; font-weight:600; }
  @media (prefers-color-scheme: dark){ .badge{ background:#243; color:#cde; } }
  h1 { font-size: 26px; margin: 14px 0 4px; }
  .by { color:#777; margin:0 0 20px; }
  @media (prefers-color-scheme: dark){ .by{ color:#aaa; } }
  .card { border:1px solid #e3e3e3; border-radius:12px; padding:18px 20px; background:#fff; margin:18px 0; }
  .paste { border:1px dashed #bbb; border-radius:10px; padding:14px 16px; background:#fff; display:flex; gap:10px; align-items:center; }
  .paste code { flex:1; font-size:14px; word-break:break-all; background:none; }
  /* MUST come after the .card/.paste base rules above — an equal-specificity
     override declared earlier in the cascade loses to a later base rule
     regardless of whether its media query matches. That's the bug this fixes:
     .card/.paste stayed white in dark mode because their dark override used to
     sit right after body's, before these base rules were even declared, so the
     light-mode background always won the cascade. */
  @media (prefers-color-scheme: dark){ .card,.paste{ background:#1f1f1f; border-color:#333; color:#e8e8e8; } .paste code{ color:#e8e8e8; } }
  button { font:inherit; font-weight:600; padding:9px 16px; border-radius:8px; border:0; background:#4351e8; color:#fff; cursor:pointer; }
  button:active { transform: translateY(1px); }
  .warn { background:#fff7e6; border:1px solid #ffe1a3; border-radius:10px; padding:12px 14px; color:#7a4d00; }
  @media (prefers-color-scheme: dark){ .warn{ background:#2e2510; border-color:#5a4a1a; color:#f0d9a0; } }
  .muted { color:#888; font-size:13px; }
  details { margin-top:14px; } summary { cursor:pointer; color:#4351e8; font-weight:600; }
  pre { overflow:auto; background:#f4f4f4; padding:12px; border-radius:8px; font-size:13px; }
  @media (prefers-color-scheme: dark){ pre{ background:#222; } }
  footer { margin-top:32px; color:#999; font-size:13px; }
</style></head><body>
  <span class="badge">${badge}</span>
  <h1>${esc(a.name)}</h1>
  <p class="by">Shared by <b>${who}</b> via Back Channel · signed &amp; verified</p>
  ${a.description ? `<p>${esc(a.description)}</p>` : ""}
  ${warn}
  <div class="card">
    <p style="margin-top:0"><b>To add this to your AI agent</b>, paste this into any agent chat (Claude, ChatGPT, Cowork, Codex…):</p>
    <div class="paste"><code id="p">${esc(paste)}</code><button onclick="navigator.clipboard.writeText(document.getElementById('p').textContent).then(()=>{this.textContent='Copied ✓'})">Copy</button></div>
    <p class="muted" style="margin-bottom:0">Your agent fetches it, shows you what it does, and asks before installing. ${esc(expiry)}</p>
  </div>
  <details><summary>View source</summary><pre>${esc(a.body)}</pre></details>
  ${opts?.signedIn
    ? `<div class="card" style="text-align:center"><p style="margin:0 0 10px"><b>Want to keep this?</b></p><a href="https://back-channel.app/account?import=${token}"><button>＋ Save to my library</button></a></div>`
    : `<div class="card" style="text-align:center">
        <p style="margin:0 0 6px"><b>Get your own Back Channel</b></p>
        <p class="muted" style="margin:0 0 12px">It's where your AI agent's useful things live — skills, scheduled tasks, prompts. Share them, manage them, get them from friends. Free to start.</p>
        <a href="https://back-channel.app/signup?from_share=${token}"><button>Sign up →</button></a>
      </div>`}
  <footer>Back Channel — where your agent's useful things live. <a href="https://back-channel.app">Learn more</a></footer>
</body></html>`;
}
