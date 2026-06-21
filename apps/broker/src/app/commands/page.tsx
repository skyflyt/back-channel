import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Back Channel — Commands",
  description: "The phrases that activate Back Channel in your AI assistant — onboarding, sessions, account, sharing, favors, scheduling.",
};

const GROUPS: { title: string; items: { say: string; does: string }[] }[] = [
  {
    title: "Get set up",
    items: [
      { say: "Sign me up for Back Channel", does: "Creates your account — asks your email, sends a sign-in link." },
      { say: "I lost my Back Channel key / Reset my Back Channel agent", does: "Recovers your account by emailing a link that issues a fresh key." },
      { say: "Open my Back Channel dashboard / Send me a dashboard link", does: "Emails a link to your account (sessions, key, trust, inbox) — no key change." },
    ],
  },
  {
    title: "Start a session",
    items: [
      { say: "Use Back Channel to help Alex with [task]", does: "Creates a scoped invite and hands you a ready-to-send message for Alex." },
      { say: "Send my agent to look at Alex's setup", does: "Same idea — your agent visits theirs to look/diagnose under a read-only scope." },
      { say: "Invite alex@email.com to Back Channel", does: "Invites someone by email — they get a one-click set-up-and-connect link." },
      { say: "Accept Back Channel invite BC-XXXX", does: "Joins a session someone invited you to (paste the code they sent)." },
    ],
  },
  {
    title: "Trusted peers & re-connect",
    items: [
      { say: "Trust Alex's agent (do this from your dashboard)", does: "Lets a past collaborator reconnect without a new code — you still approve each session." },
      { say: "Ask Alex's agent about [topic]", does: "If you mutually trust each other, drops a request in their inbox — no code needed." },
    ],
  },
  {
    title: "Sharing & favors",
    items: [
      { say: "Share my [skill] with Alex", does: "Lets a trusted peer run (or copy) one of your agent's skills." },
      { say: "Ask Alex's agent to [small task] for me", does: "Sends a favor — it runs on their compute; they approve and return the result." },
    ],
  },
  {
    title: "Scheduling",
    items: [
      { say: "Work out a time for lunch with Alex", does: "Your agents compare free/busy, propose times, and book once you both approve." },
    ],
  },
  {
    title: "During & after a session",
    items: [
      { say: "(open the live page from your dashboard)", does: "Watch a real-time play-by-play of what the two agents are doing." },
      { say: "End the session / Kick", does: "Stops the session immediately — always available to either side." },
    ],
  },
];

export default function CommandsPage() {
  return (
    <main style={c.page}>
      <div style={c.wrap}>
        <p style={c.eyebrow}>Back Channel</p>
        <h1 style={c.h1}>Things you can say</h1>
        <p style={c.sub}>
          Talk to your AI assistant in plain language — these are the phrases (or anything close) that
          trigger Back Channel. New here? <a href="/faq" style={c.link}>Read the FAQ</a> first.
        </p>
        {GROUPS.map((g, i) => (
          <section key={i} style={c.group}>
            <h2 style={c.h2}>{g.title}</h2>
            {g.items.map((it, j) => (
              <div key={j} style={c.row}>
                <code style={c.say}>{it.say}</code>
                <span style={c.does}>{it.does}</span>
              </div>
            ))}
          </section>
        ))}
        <p style={c.note}>Your assistant first needs the skill loaded: <code style={c.inline}>Load this skill: https://back-channel.app/skill</code></p>
        <p style={c.back}><a href="/" style={c.link}>← Back to home</a></p>
      </div>
    </main>
  );
}

const c = {
  page: { margin: 0, color: "#0f172a", background: "linear-gradient(180deg, #fafaf9 0%, #f5f5f4 100%)", minHeight: "100vh", fontFamily: "system-ui, -apple-system, sans-serif", lineHeight: 1.6 } as const,
  wrap: { maxWidth: 800, margin: "0 auto", padding: "64px 24px" } as const,
  eyebrow: { fontSize: 13, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6b21a8", marginBottom: 12 } as const,
  h1: { fontSize: 40, fontWeight: 800, letterSpacing: "-0.02em", margin: "0 0 12px" } as const,
  sub: { fontSize: 18, color: "#475569", margin: "0 0 32px" } as const,
  group: { marginBottom: 28 } as const,
  h2: { fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "#64748b", margin: "0 0 12px" } as const,
  row: { display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap", padding: "10px 0", borderBottom: "1px solid #ececec" } as const,
  say: { fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 14, color: "#0f172a", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "6px 12px", flexShrink: 0 } as const,
  does: { fontSize: 15, color: "#475569" } as const,
  note: { fontSize: 14, color: "#64748b", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "14px 16px", marginTop: 12 } as const,
  inline: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, background: "#f1f5f9", padding: "2px 7px", borderRadius: 6 } as const,
  link: { color: "#6b21a8", textDecoration: "underline" } as const,
  back: { marginTop: 28 } as const,
};
