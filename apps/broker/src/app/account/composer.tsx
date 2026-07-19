"use client";
/**
 * Composer — "Send a new message" (Phase 4, composer-sends-friend-page).
 * Sibling extraction from page.tsx (same precedent as keymirror-panel.tsx /
 * library-editor.tsx), so page.tsx doesn't grow past its current size.
 *
 * JOB-1 CONSTRAINT (investigated, documented honestly — see PR body):
 * A real first message CANNOT be posted at session-creation time, with or
 * without browser-access (key-mirror) enrollment. Two independent blockers:
 *   1. POST /api/sessions/:id/frames only accepts a sealed `{type:"enc",
 *      iv, ct, tag}` frame (route.ts rejects anything else as
 *      `malformed_frame`) — there is no plaintext human-origin post path,
 *      by design (broker stays content-blind).
 *   2. Even an enrolled browser can't seal a frame without the session
 *      content key `K`. `K` only becomes fetchable via GET
 *      /api/sessions/:id/wrapped once an AGENT has POSTed it to
 *      /api/sessions/:id/user-wrap (bearer-only). A session minted straight
 *      from this composer has no agent involvement yet, so `userWrap` is
 *      empty and `wrapped` 404s regardless of enrollment.
 * So this ships the brief's honest-degrade path: create the session, show
 * the thread with the topic clearly labeled as a PENDING first message, and
 * a one-line affordance to finish sending (paste-prompt fallback, demoted
 * into a collapsed disclosure — never a fake delivered bubble).
 */
import { useState } from "react";

const csrf = () => (typeof document !== "undefined" ? (document.cookie.match(/(?:^|; )bc_csrf=([^;]+)/)?.[1] ?? "") : "");

export interface ComposerResult { your_prompt: string; friend_prompt: string; code: string }

export interface ComposerPrefill { topic?: string; friend?: string; lockFriend?: boolean; framing?: "message" | "request" }

interface Props {
  prefill?: ComposerPrefill | null;
  onSent?: (friend: string) => void;
  /** Render inline in a card without its own <section>/<h2> chrome (friend page CTA). */
  embedded?: boolean;
}

export function Composer({ prefill, onSent, embedded }: Props) {
  const [open, setOpen] = useState(!!prefill);
  const [topic, setTopic] = useState(prefill?.topic ?? "");
  const [friend, setFriend] = useState(prefill?.friend ?? "");
  const lockFriend = !!prefill?.lockFriend && !!prefill?.friend;
  const [scopes, setScopes] = useState("config.read, config.suggest");
  const [ttl, setTtl] = useState(60);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ComposerResult | null>(null);
  const [sentTo, setSentTo] = useState("");
  // Friction-moment invite (scope item 3): when the recipient handle doesn't
  // resolve to an existing account, offer a one-tap invite instead of a dead end.
  const [needsInvite, setNeedsInvite] = useState<{ handle: string } | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteErr, setInviteErr] = useState("");

  const reset = () => {
    setResult(null); setOpen(!!prefill); setTopic(prefill?.topic ?? ""); setFriend(prefill?.friend ?? "");
    setNeedsInvite(null); setInviteEmail(""); setInviteErr(""); setErr("");
  };

  const createInvite = async (target: { host_handle?: string; host_email?: string }, message: string) => {
    const r = await fetch("/api/invites", {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json", "x-bc-csrf": csrf() },
      body: JSON.stringify({ ...target, scopes: scopes.split(",").map((x) => x.trim()).filter(Boolean), ttl_minutes: ttl, message }),
    });
    const j = await r.json();
    return { ok: r.ok, j };
  };

  const send = async () => {
    setErr(""); setNeedsInvite(null);
    if (!topic.trim()) { setErr("Tell us what you want help with."); return; }
    const target = friend.trim();
    if (!target) { setErr("Enter your friend's @bc handle or their email."); return; }
    const routed = target.endsWith("@bc") ? { host_handle: target } : target.includes("@") ? { host_email: target } : null;
    if (!routed) { setErr("That doesn't look like a @bc handle or an email."); return; }
    setBusy(true);
    try {
      const { ok, j } = await createInvite(routed, topic.trim());
      if (!ok) {
        // Friction-moment invite (item 3): a @bc handle that doesn't exist yet.
        // Email targets never 404 here — the invites route auto-creates a
        // pending account and emails them, so there's no dead end on that path.
        if (j.error === "host_not_found" && routed.host_handle) {
          setNeedsInvite({ handle: routed.host_handle });
          setBusy(false);
          return;
        }
        setErr(j.detail || j.error || "Couldn't start the session — check the handle/email and scopes.");
        setBusy(false);
        return;
      }
      const p = await fetch(`/api/sessions/${j.session_id}/prompts`, { credentials: "include" });
      if (p.ok) { const pj = await p.json(); setResult({ your_prompt: pj.your_prompt, friend_prompt: pj.friend_prompt, code: pj.code }); }
      setSentTo(target);
      onSent?.(target);
    } catch { setErr("Something went wrong — try again."); }
    setBusy(false);
  };

  // Friction-moment invite: the user's typed handle doesn't exist. Offer to
  // invite by email instead — same /api/invites plumbing, host_email branch,
  // and the composed topic rides along as invite.message so it's waiting
  // when they claim (existing behavior, no protocol change).
  const sendInvite = async () => {
    setInviteErr("");
    const email = inviteEmail.trim().toLowerCase();
    if (!email.includes("@") || email.endsWith("@bc")) { setInviteErr("Enter their real email address."); return; }
    setInviteBusy(true);
    try {
      const { ok, j } = await createInvite({ host_email: email }, topic.trim());
      if (!ok) { setInviteErr(j.detail || j.error || "Couldn't send the invite — try again."); setInviteBusy(false); return; }
      const p = await fetch(`/api/sessions/${j.session_id}/prompts`, { credentials: "include" });
      if (p.ok) { const pj = await p.json(); setResult({ your_prompt: pj.your_prompt, friend_prompt: pj.friend_prompt, code: pj.code }); }
      setSentTo(email);
      setNeedsInvite(null);
      onSent?.(email);
    } catch { setInviteErr("Something went wrong — try again."); }
    setInviteBusy(false);
  };

  const framing = prefill?.framing === "request" ? "request" : "message";
  const heading = framing === "request" ? "Request a lesson" : "Send a new message";
  const topicLabel = framing === "request" ? "What do you want to ask for?" : "What do you want help with?";
  const topicPlaceholder = framing === "request" ? "e.g. could I get your grocery-list automation?" : "e.g. fix the errors in my automations";

  const body = (
    <>
      {!open && !result && (
        <>
          <p style={s.lead}>Send a request to a friend through your agents — like texting them, but your agent does the follow-up with theirs. They don&apos;t have to be online; their agent picks it up from their Inbox.</p>
          <button style={s.btn} onClick={() => setOpen(true)}>Send to a friend →</button>
        </>
      )}
      {open && !result && !needsInvite && (
        <>
          <label style={s.fieldLabel}>{topicLabel}</label>
          <input style={s.input} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={topicPlaceholder} />
          <label style={s.fieldLabel}>Your friend&apos;s @bc handle or email</label>
          <input style={s.input} value={friend} onChange={(e) => setFriend(e.target.value)} placeholder="alex@bc  or  alex@company.com" disabled={lockFriend} />
          {/* Defaults check (scope item 4): TTL + scopes default to 60min / config.read,
              config.suggest, and stay behind a collapsed Advanced disclosure — no visible
              dropdown/text-input by default. */}
          <details style={s.advanced} open={advancedOpen} onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}>
            <summary style={s.advancedSummary}>Advanced (time limit &amp; access)</summary>
            <div style={s.fieldRow}>
              <div>
                <label style={s.fieldLabel}>Time limit</label>
                <select style={s.select} value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
                  <option value={30}>30 minutes</option><option value={60}>60 minutes</option>
                  <option value={120}>2 hours</option><option value={360}>6 hours</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={s.fieldLabel}>What they can access</label>
                <input style={s.input} value={scopes} onChange={(e) => setScopes(e.target.value)} placeholder="config.read, config.suggest" />
              </div>
            </div>
          </details>
          {!advancedOpen && <p style={s.scopeNote}>60 minutes · read relevant settings and suggest changes <span style={s.muted}>(you approve anything before it happens)</span></p>}
          {err && <p style={s.err}>{err}</p>}
          <div style={{ marginTop: 12 }}>
            <button style={s.btn} disabled={busy} onClick={send}>{busy ? "Starting…" : framing === "request" ? "Send request" : "Send message"}</button>
            {!prefill && <button style={{ ...s.ghostBtn, marginLeft: 8 }} onClick={() => { setOpen(false); setErr(""); }}>Cancel</button>}
          </div>
        </>
      )}
      {needsInvite && (
        <div style={s.reveal}>
          <p style={s.revealLabel}>👋 {needsInvite.handle.replace(/@bc$/, "")} isn&apos;t on Back Channel yet — invite them?</p>
          <p style={s.meta}>We&apos;ll email them an invite. Your message (&ldquo;{topic.trim()}&rdquo;) will be waiting for them the moment they join — no need to resend it.</p>
          <label style={s.fieldLabel}>Their email</label>
          <input style={s.input} type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="friend@email.com" />
          {inviteErr && <p style={s.err}>{inviteErr}</p>}
          <div style={{ marginTop: 10 }}>
            <button style={s.btn} disabled={inviteBusy} onClick={sendInvite}>{inviteBusy ? "Sending…" : "Invite them"}</button>
            <button style={{ ...s.ghostBtn, marginLeft: 8 }} onClick={() => setNeedsInvite(null)}>Back</button>
          </div>
        </div>
      )}
      {result && (
        <>
          {/* Honest degrade (JOB-1): no fake delivered bubble. The topic is a
              pending first message until an agent (yours or theirs) actually
              posts a sealed frame — which is exactly what the paste-prompt
              below (or either agent's normal inbox check) triggers. */}
          <div style={s.reveal}>
            <p style={s.revealLabel}>✅ Thread started with {sentTo.replace(/@bc$/, "")} — your message is pending delivery.</p>
            <p style={s.meta}>
              <strong>&ldquo;{topic.trim() || "(your message)"}&rdquo;</strong> is queued as the opening topic — it goes out as soon as your agent (or theirs) checks in, typically within ~10 minutes. Nobody has to stay online. Find this thread under <strong>Inbox</strong> below once it&apos;s moving.
            </p>
          </div>
          {/* Paste-prompts demoted, not deleted (scope item 2): collapsed by default. */}
          <details style={s.speedUp}>
            <summary style={s.speedUpSummary}>⚡ Speed it up — wake your agent now</summary>
            <div style={s.promptPane}>
              <p style={s.wakeLabel}>For YOUR assistant — paste this to start it immediately:</p>
              <pre style={s.wakePre}>{result.your_prompt}</pre>
              <button style={s.btn} onClick={() => navigator.clipboard?.writeText(result.your_prompt).catch(() => {})}>Copy mine</button>
            </div>
            <div style={s.promptPane}>
              <p style={s.wakeLabel}>For your FRIEND — text this so their agent jumps in now:</p>
              <pre style={s.wakePre}>{result.friend_prompt}</pre>
              <button style={s.btn} onClick={() => navigator.clipboard?.writeText(result.friend_prompt).catch(() => {})}>Copy theirs</button>
              {typeof navigator !== "undefined" && "share" in navigator && (
                <button style={{ ...s.ghostBtn, marginLeft: 8 }} onClick={() => navigator.share?.({ text: result.friend_prompt }).catch(() => {})}>Share…</button>
              )}
            </div>
          </details>
          <div style={{ marginTop: 12 }}>
            <button style={s.btn} onClick={reset}>Done</button>
          </div>
        </>
      )}
    </>
  );

  if (embedded) return <div>{body}</div>;
  return (
    <section style={s.card} id="compose">
      <h2 style={s.h2}>{heading}</h2>
      {body}
    </section>
  );
}

const s = {
  card: { background: "#fff", border: "1px solid #e3e8ee", borderRadius: 12, padding: "18px 20px", marginBottom: 14, boxShadow: "0 1px 2px rgba(16,24,40,0.04)" } as const,
  h2: { fontSize: 15, fontWeight: 600, color: "#30313d", margin: "0 0 12px" } as const,
  lead: { fontSize: 14, color: "#687385", lineHeight: 1.6, margin: "0 0 6px" } as const,
  fieldLabel: { display: "block", fontSize: 12.5, fontWeight: 600, color: "#687385", margin: "12px 0 5px" } as const,
  input: { width: "100%", boxSizing: "border-box", fontSize: 14, padding: "8px 12px", border: "1px solid #e3e8ee", borderRadius: 8, color: "#30313d", background: "#fff" } as const,
  select: { fontSize: 14, padding: "8px 12px", border: "1px solid #e3e8ee", borderRadius: 8, background: "#fff", color: "#30313d" } as const,
  fieldRow: { display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start", marginTop: 8 } as const,
  scopeNote: { fontSize: 13, color: "#8792a2", margin: "8px 0 0" } as const,
  muted: { color: "#8792a2" } as const,
  advanced: { marginTop: 12, border: "1px solid #e3e8ee", borderRadius: 8, padding: "8px 12px", background: "#f6f8fa" } as const,
  advancedSummary: { cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#687385" } as const,
  err: { color: "#b91c1c", fontSize: 14, margin: "8px 0 0" } as const,
  btn: { background: "#635bff", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 600, fontSize: 13.5, cursor: "pointer", boxShadow: "0 1px 2px rgba(16,24,40,0.06)" } as const,
  ghostBtn: { background: "#fff", color: "#30313d", border: "1px solid #e3e8ee", borderRadius: 8, padding: "8px 16px", fontWeight: 500, fontSize: 13.5, cursor: "pointer" } as const,
  reveal: { background: "#f0efff", border: "1px solid #c7c2ff", borderRadius: 10, padding: 14 } as const,
  revealLabel: { fontSize: 14, fontWeight: 600, color: "#635bff", margin: "0 0 8px" } as const,
  meta: { fontSize: 13, color: "#687385", margin: "10px 0 0", lineHeight: 1.5 } as const,
  speedUp: { marginTop: 12 } as const,
  speedUpSummary: { cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#635bff" } as const,
  promptPane: { background: "#f0efff", border: "1px solid #c7c2ff", borderRadius: 10, padding: "12px 14px", marginTop: 12 } as const,
  wakeLabel: { fontSize: 13, fontWeight: 600, color: "#635bff", margin: "0 0 8px" } as const,
  wakePre: { background: "#fff", border: "1px solid #e3e8ee", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, 'Cascadia Code', Consolas, Menlo, monospace", color: "#30313d", margin: "0 0 8px" } as const,
};
