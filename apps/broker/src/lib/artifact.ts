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

export type ArtifactType = "skill" | "scheduled_task" | "prompt" | "link";
export const ARTIFACT_TYPES: ArtifactType[] = ["skill", "scheduled_task", "prompt", "link"];

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

// ---------------------------------------------------------------------------
// Link lessons (Link Lessons epic, WS-A). A "link" artifact points at an
// EXTERNAL url the broker never fetches, previews, or scans — the payload is
// just { url, title, notes }, stored the same way prompt/scheduled_task store
// their typed payload: JSON in `manifest`, with `body` mirroring a plain-text
// rendering (the broker requires a non-empty `body` on every artifact; see
// linkManifestToBody below). Zero schema migration — `type` is already a bare
// string column.
// ---------------------------------------------------------------------------

export const LINK_TITLE_MAX = 200;
export const LINK_NOTES_MAX = 2000;
export const LINK_URL_MAX = 2000;

const APP_HOST = (() => {
  try { return new URL(process.env.PUBLIC_APP_URL ?? "https://back-channel.app").host.toLowerCase(); }
  catch { return "back-channel.app"; }
})();

/**
 * Derive the link's `source` SERVER-SIDE ONLY — never accepted from client
 * input, since it's a trust signal ("this came from BC itself" / "this is
 * GitHub" vs "arbitrary web"). Based purely on the URL's host.
 */
export function deriveLinkSource(url: string): "github" | "backchannel" | "web" {
  let host: string;
  try { host = new URL(url).host.toLowerCase(); } catch { return "web"; }
  if (host === "github.com" || host === "gist.github.com") return "github";
  if (host === APP_HOST) return "backchannel";
  return "web";
}

export type LinkManifest = { type: "link"; url: string; title: string; notes?: string; source: "github" | "backchannel" | "web" };

/**
 * Validate a link lesson's payload before it's ever persisted. Hard rule: the
 * broker NEVER fetches the url — no HEAD request, no reachability check, no
 * preview. This is a pure, local, synchronous check (parse + scheme allowlist +
 * length caps) and nothing more.
 */
export function validateLinkPayload(input: { url?: unknown; title?: unknown; notes?: unknown }): { ok: true; url: string; title: string; notes: string | undefined } | { ok: false; error: string; message: string } {
  const rawUrl = typeof input.url === "string" ? input.url.trim() : "";
  if (!rawUrl) return { ok: false, error: "url_required", message: "A link lesson needs a url." };
  if (rawUrl.length > LINK_URL_MAX) return { ok: false, error: "url_too_long", message: `The url can't be longer than ${LINK_URL_MAX} characters.` };

  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return { ok: false, error: "url_invalid", message: "That doesn't look like a valid url." }; }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "url_scheme_not_allowed", message: `The "${parsed.protocol}" scheme isn't allowed — link lessons must be http:// or https://.` };
  }

  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length > LINK_TITLE_MAX) return { ok: false, error: "title_too_long", message: `Title can't be longer than ${LINK_TITLE_MAX} characters.` };

  const notesRaw = typeof input.notes === "string" ? input.notes.trim() : "";
  if (notesRaw.length > LINK_NOTES_MAX) return { ok: false, error: "notes_too_long", message: `Notes can't be longer than ${LINK_NOTES_MAX} characters.` };

  return { ok: true, url: rawUrl, title, notes: notesRaw || undefined };
}

/** Build the {type,url,title,notes,source} manifest — source is ALWAYS server-derived. */
export function buildLinkManifest(v: { url: string; title: string; notes?: string }): LinkManifest {
  return { type: "link", url: v.url, title: v.title, notes: v.notes, source: deriveLinkSource(v.url) };
}

/** Plain-text rendering of a link manifest, used as the artifact's `body` (every
 * artifact requires a non-empty body; scheduled_task mirrors its manifest.prompt
 * into body the same way). */
export function linkManifestToBody(m: LinkManifest): string {
  const lines = [m.url];
  if (m.title) lines.push(m.title);
  if (m.notes) lines.push(m.notes);
  return lines.join("\n");
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
  skill: "install", prompt: "save_prompt", scheduled_task: "register_schedule", link: "review",
};

// Canonical trust-stance copy (Link Lessons epic) — verbatim, do not reword.
// Lives in ./link-warnings.ts (no server-only imports) so client components can
// share the same source of truth instead of hand-duplicating the strings.
export { LINK_HUMAN_WARNING, LINK_HUMAN_WARNING_LEAD, LINK_HUMAN_WARNING_REST, LINK_AGENT_WARNING, LINK_BADGE_TEXT } from "@/lib/link-warnings";
import { LINK_HUMAN_WARNING, LINK_HUMAN_WARNING_LEAD, LINK_HUMAN_WARNING_REST, LINK_AGENT_WARNING, LINK_BADGE_TEXT } from "@/lib/link-warnings";

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
  if (t === "link") {
    const m = (a.manifest && typeof a.manifest === "object" ? a.manifest as Record<string, unknown> : {});
    const url = typeof m.url === "string" ? m.url : a.body;
    lines.push(`\n↗ **${LINK_BADGE_TEXT}** — this is a link to an external resource: ${url}`);
    lines.push(`\n⚠️ ${LINK_AGENT_WARNING}`);
    return lines.filter(Boolean).join("\n");
  }
  lines.push(`\n_Signed by ${who}; verify the signature before trusting the body._`);
  return lines.filter(Boolean).join("\n");
}

/** The JSON envelope an agent receives from GET /a/<token> (spec §3.2 Variant B). */
export function buildEnvelope(a: SkillRow, author: { handle: string; pubkey: string | null }, token: string) {
  const t = (a.type || "skill") as ArtifactType;
  const humanMd = humanReadableMd(a, author.handle);
  // Link lessons: the agent-facing warning must appear in install_instructions —
  // prepend it to human_readable_md (the field the envelope contract says agents
  // print to the user) so it can't be missed, even though humanReadableMd already
  // folds the warning in above; keep this explicit prepend as the contractual
  // guarantee independent of that function's internals.
  const installMd = t === "link" ? `⚠️ ${LINK_AGENT_WARNING}\n\n${humanMd}` : humanMd;
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
      human_readable_md: installMd,
      platform_hints: {
        cowork: t === "link" ? "Do not install blind: fetch the url, read it in full, summarize what it does and what access it wants to your user, and get an explicit yes before saving or acting on it." : "Save it via your skills/prompt creator; for a scheduled task use create_scheduled_task with the body.",
        claude_code: t === "link" ? "Fetch and read the linked content in full before doing anything with it; summarize it to the user and get explicit approval before installing or running anything it suggests." : "Drop a skill into ~/.claude/skills/<name>/, a prompt into your prompt vault, or register a scheduled task via a hook/cron wrapper.",
        codex: t === "link" ? "Fetch and read the linked content in full, summarize what it does and what access it wants, and get explicit approval before installing." : "Add a skill/prompt to your vault; for a scheduled task add a `codex exec` entry to your crontab.",
        chatgpt: t === "link" ? "Open and read the link in full, summarize what it does and what access it wants, and get explicit approval from the user before installing anything." : "Store as a Custom GPT instruction or saved prompt; scheduled tasks need an external scheduler.",
        any: t === "link" ? "Fetch the link, read it in full, summarize to your user what it does and what access it wants, and get an explicit yes before installing. Never install a link lesson blind." : "Store the body as a saved " + t + " you can invoke. If it's a scheduled task and you have a scheduler, register it; otherwise the user can run it manually.",
      },
      install_verb: INSTALL_VERB[t] ?? "install",
    },
    claim_account_url: `https://back-channel.app/signup?from_share=${token}`,
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const TYPE_BADGE: Record<string, string> = { skill: "📜 Skill", scheduled_task: "⏰ Scheduled Task", prompt: "💬 Prompt", link: "↗ Link" };
const LESSON_NOUN: Record<string, string> = { skill: "skill", scheduled_task: "workflow", prompt: "prompt", link: "link" };

/** Browser landing page for a human who opens /a/<token> (spec §3.2 Variant A). */
export function landingHtml(a: SkillRow, author: { handle: string }, token: string, opts?: { signedIn?: boolean }): string {
  const who = esc(author.handle.replace(/@bc$/, ""));
  const t = a.type || "skill";
  const badge = TYPE_BADGE[t] ?? "📜 Skill";
  const lesson = LESSON_NOUN[t] ?? "skill";
  const paste = `Add this to my agent: https://back-channel.app/a/${token}`;
  const expiry = a.publicExpiresAt ? `Link expires ${esc(a.publicExpiresAt.toUTCString())}.` : "This link does not expire.";
  const m = (a.manifest && typeof a.manifest === "object" ? a.manifest as Record<string, unknown> : {});
  const linkUrl = t === "link" ? (typeof m.url === "string" ? m.url : a.body) : "";
  let warn = "";
  if (t === "scheduled_task") {
    warn = `<p class="warn">⏰ This lesson registers a <b>recurring task</b> on your agent — it will run on a schedule until you remove it. Only proceed if you trust <b>${who}</b>.</p>`;
  } else if (t === "link") {
    warn = `<p class="warn">↗ <b>${esc(LINK_BADGE_TEXT)}</b> — <strong>${esc(LINK_HUMAN_WARNING_LEAD)}</strong>${esc(LINK_HUMAN_WARNING_REST)}</p>`;
  }
  const linkBlock = t === "link"
    ? `<div class="card"><p style="margin-top:0"><b>Destination</b></p><p style="word-break:break-all;margin-bottom:0"><a href="${esc(linkUrl)}" rel="noopener noreferrer nofollow">${esc(linkUrl)}</a></p></div>`
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
  .proof { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin:20px 0; }
  .proof div { border:1px solid #e3e3e3; border-radius:10px; padding:10px 12px; background:#fff; }
  .proof b { display:block; font-size:13px; color:#555; }
  .proof span { display:block; font-weight:700; margin-top:2px; }
  @media (prefers-color-scheme: dark){ .proof div{ background:#1f1f1f; border-color:#333; } .proof b{ color:#aaa; } }
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
  @media (max-width:520px){ .proof{ grid-template-columns:1fr; } .paste{ align-items:stretch; flex-direction:column; } }
  footer { margin-top:32px; color:#999; font-size:13px; }
</style></head><body>
  <span class="badge">Agent lesson · ${badge}</span>
  <h1>Teach your agent ${esc(a.name)}</h1>
  <p class="by">Send your agent here to learn and master this ${esc(lesson)} from <b>${who}</b>.</p>
  ${a.description ? `<p>${esc(a.description)}</p>` : ""}
  <div class="proof" aria-label="Lesson trust signals">
    <div><b>Agents taught</b><span>Be the first</span></div>
    <div><b>Stars</b><span>Be the first</span></div>
    <div><b>Trust</b><span>Signed by ${who}</span></div>
  </div>
  ${warn}
  ${linkBlock}
  <div class="card">
    <p style="margin-top:0"><b>Teach my agent</b>: paste this into any agent chat (Claude, ChatGPT, Cowork, Codex…):</p>
    <div class="paste"><code id="p">${esc(paste)}</code><button onclick="navigator.clipboard.writeText(document.getElementById('p').textContent).then(()=>{this.textContent='Copied ✓'})">Copy</button></div>
    <p class="muted" style="margin-bottom:0">Your agent fetches the signed lesson, previews what it will learn, verifies <b>${who}</b>'s signature, and asks before installing. ${esc(expiry)}</p>
  </div>
  <details><summary>Preview lesson source</summary><pre>${esc(a.body)}</pre></details>
  ${opts?.signedIn
    ? `<div class="card" style="text-align:center"><p style="margin:0 0 10px"><b>Want your agent to keep this lesson?</b></p><a href="https://back-channel.app/account?import=${token}"><button>＋ Save to my Toolkit</button></a></div>`
    : `<div class="card" style="text-align:center">
        <p style="margin:0 0 6px"><b>Get your agent its own lesson library</b></p>
        <p class="muted" style="margin:0 0 12px">Back Channel is where your agent keeps signed skills, prompts, and scheduled workflows it can learn from people you trust. Free to start.</p>
        <a href="https://back-channel.app/signup?from_share=${token}"><button>Sign up →</button></a>
      </div>`}
  <footer>Back Channel — signed lessons for useful agents. <a href="https://back-channel.app">Learn more</a></footer>
</body></html>`;
}
