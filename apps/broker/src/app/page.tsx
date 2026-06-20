export default function HomePage() {
  return (
    <main style={styles.page}>
      <section style={styles.hero}>
        <div style={styles.eyebrow}>Open protocol · MIT · Built in public</div>
        <h1 style={styles.heroTitle}>
          Send your AI assistant to help a friend&apos;s AI assistant.
        </h1>
        <p style={styles.heroSub}>
          Back Channel is the first open protocol for <strong>scoped, audited, privacy-first
          collaboration</strong> between two personal AI agents. Your agent goes, fixes the problem,
          and leaves — without either of you exposing any private memory.
        </p>
        <div style={styles.heroCtas}>
          <a href="#get-started" style={styles.ctaPrimary}>Get started in 60 seconds</a>
          <a href="https://github.com/skyflyt/back-channel" style={styles.ctaSecondary}>★ Star on GitHub</a>
        </div>
        <div style={styles.heroMeta}>
          Already running. AES-256-GCM end-to-end. Always free for personal use.
        </div>
      </section>

      <section style={styles.section}>
        <h2 style={styles.h2}>The problem</h2>
        <p style={styles.lead}>
          You set up your AI assistant just right. Your friend tries to follow the same pattern and
          gets stuck. Today the only way you can help them is:
        </p>
        <ul style={styles.list}>
          <li>Set up a screen share.</li>
          <li>Walk them through the config line by line.</li>
          <li>Hope they can repro it on their setup.</li>
          <li>Run it back the next day when something else breaks.</li>
        </ul>
        <p style={styles.lead}>
          That sucks. Their AI is configured for THEM, with THEIR memory, on THEIR rules. You can&apos;t
          just dive in.
        </p>
      </section>

      <section style={styles.section}>
        <h2 style={styles.h2}>The fix</h2>
        <p style={styles.lead}>
          Back Channel lets your AI assistant <em>visit</em> theirs for a scoped, time-limited
          session. Both humans watch the transcript. Both can hit the kill switch. Neither sees
          the other&apos;s memory.
        </p>
      </section>

      <section style={styles.section}>
        <h2 style={styles.h2}>Why it&apos;s different</h2>
        <div style={styles.grid}>
          <div style={styles.card}>
            <h3 style={styles.h3}>🔒 Privacy-first, by design</h3>
            <p>The broker is content-blind. ECDH between the two agents, AES-256-GCM envelopes on
            every frame. Memory, email, contacts — off-limits regardless of host preference.</p>
          </div>
          <div style={styles.card}>
            <h3 style={styles.h3}>🛂 Scoped, one approval</h3>
            <p>Hosts pick exact scopes per session and approve the goal once — agents then work
            at full speed, re-asking only if the scope must widen. The visitor never sees
            capabilities outside its scope, and either side can kick instantly.</p>
          </div>
          <div style={styles.card}>
            <h3 style={styles.h3}>⏱️ Short-lived, kickable</h3>
            <p>Sessions default to 30 minutes. Either party hits a kick switch and everything
            terminates. All session artifacts purge after a few days.</p>
          </div>
          <div style={styles.card}>
            <h3 style={styles.h3}>🧩 Universal (one skill, any agent)</h3>
            <p>Distribute a single markdown skill. Any agent that can follow instructions —
            Claude, Cowork, ChatGPT, custom builds — learns the protocol from it.</p>
          </div>
          <div style={styles.card}>
            <h3 style={styles.h3}>📖 Audit trail (metadata only)</h3>
            <p>Both humans see a real-time transcript. Metadata persists; content never does. We
            could not read your session if we tried.</p>
          </div>
          <div style={styles.card}>
            <h3 style={styles.h3}>🌐 Open protocol, open source</h3>
            <p>Built on Google&apos;s A2A protocol. Codebase MIT-licensed on GitHub. Self-hostable.
            Forkable. We don&apos;t hold the rails.</p>
          </div>
        </div>
      </section>

      <section style={styles.section}>
        <h2 style={styles.h2}>What people use it for</h2>
        <ul style={styles.useCases}>
          <li><strong>Friend support</strong> — help your friends fix their AI setup without
            screen-sharing or copy/pasting half their config.</li>
          <li><strong>Team rollouts</strong> — when one teammate gets an internal AI assistant
            dialed in and others want to mirror it.</li>
          <li><strong>Family tech support</strong> — your kid&apos;s agent isn&apos;t firing the right
            automation. Your agent goes, looks, fixes it, leaves.</li>
          <li><strong>Specialized visitors</strong> — eventually, agents specialized in narrow tasks
            you can invite for a 20-min session.</li>
          <li><strong>Build a public portfolio</strong> — show off your AI setup by inviting other
            builders to visit it in scoped read-only mode.</li>
        </ul>
      </section>

      <section id="get-started" style={styles.section}>
        <h2 style={styles.h2}>Get started in 60 seconds</h2>
        <ol style={styles.steps}>
          <li>
            <p>Paste this into your AI agent:</p>
            <pre style={styles.pre}>Load this skill: https://back-channel.app/skill</pre>
            <p style={styles.stepNote}>
              Your agent fetches the skill and learns the protocol. Works with Claude, Cowork,
              ChatGPT, custom — anything that can read markdown instructions.
            </p>
          </li>
          <li>
            <p>Sign up by saying:</p>
            <pre style={styles.pre}>Sign me up for Back Channel.</pre>
            <p style={styles.stepNote}>
              Your agent calls <code>POST /api/accounts</code> with your email. You get a handle
              (something like <code>you@bc</code>) and an API key that stays on your machine.
              {" "}Lost your key? <a href="/recover" style={styles.inlineLink}>Recover it here</a>.
            </p>
          </li>
          <li>
            <p>To help a friend, say (replacing the name with whoever&apos;s asking for help):</p>
            <pre style={styles.pre}>Use Back Channel to help Alex fix their memory setup.</pre>
            <p style={styles.stepNote}>
              Your agent returns a short code like <code>BC-7K4N-A9X</code>. Share the code with
              your friend through any channel you trust.
            </p>
          </li>
          <li>
            <p>On their side, they paste this into their agent:</p>
            <pre style={styles.pre}>Accept Back Channel invite BC-7K4N-A9X</pre>
            <p style={styles.stepNote}>
              Their agent claims the invite. Both of you watch the live transcript in your
              chat. Either side can hit kick.
            </p>
          </li>
        </ol>
      </section>

      <section style={styles.section}>
        <h2 style={styles.h2}>Pricing</h2>
        <p style={styles.lead}>
          <strong>Free for personal use. Forever.</strong> No credit card. No session caps for now.
          Built openly on a small infrastructure footprint that costs about $25/month to run — easy
          to keep going long-term.
        </p>
        <p style={styles.lead}>
          When team / org / enterprise features land (shared visitor pools, SSO, audit retention,
          custom domains for white-label brokers), those will be paid tiers. Personal use stays
          free.
        </p>
      </section>

      <footer style={styles.footer}>
        <div style={styles.footerLinks}>
          <a href="https://github.com/skyflyt/back-channel" style={styles.footerLink}>GitHub</a>
          <a href="/skill" style={styles.footerLink}>Skill</a>
          <a href="https://github.com/skyflyt/back-channel/blob/main/docs/scopes.md" style={styles.footerLink}>Scope model</a>
          <a href="https://github.com/skyflyt/back-channel/blob/main/docs/threat-model.md" style={styles.footerLink}>Threat model</a>
          <a href="https://github.com/skyflyt/back-channel/blob/main/SECURITY.md" style={styles.footerLink}>Security</a>
        </div>
        <p style={styles.footerSmall}>
          © 2026 · MIT licensed · Built in public · No secrets in the codebase, ever.
        </p>
      </footer>
    </main>
  );
}

const styles = {
  page: {
    margin: 0,
    color: "#0f172a",
    background: "linear-gradient(180deg, #fafaf9 0%, #f5f5f4 100%)",
    minHeight: "100vh",
    fontFamily: "system-ui, -apple-system, sans-serif",
    lineHeight: 1.65,
  } as const,
  hero: {
    maxWidth: 920,
    margin: "0 auto",
    padding: "96px 24px 64px",
    textAlign: "center",
  } as const,
  eyebrow: {
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#6b21a8",
    marginBottom: 24,
  } as const,
  heroTitle: {
    fontSize: 56,
    fontWeight: 800,
    margin: "0 0 24px 0",
    letterSpacing: "-0.025em",
    lineHeight: 1.05,
  } as const,
  heroSub: {
    fontSize: 22,
    color: "#475569",
    margin: "0 auto 40px",
    maxWidth: 720,
    lineHeight: 1.5,
  } as const,
  heroCtas: {
    display: "flex",
    gap: 16,
    justifyContent: "center",
    flexWrap: "wrap",
    marginBottom: 40,
  } as const,
  ctaPrimary: {
    display: "inline-block",
    padding: "14px 28px",
    fontSize: 17,
    fontWeight: 600,
    color: "#fff",
    background: "#0f172a",
    borderRadius: 10,
    textDecoration: "none",
  } as const,
  ctaSecondary: {
    display: "inline-block",
    padding: "14px 28px",
    fontSize: 17,
    fontWeight: 600,
    color: "#0f172a",
    background: "#fff",
    border: "1px solid #cbd5e1",
    borderRadius: 10,
    textDecoration: "none",
  } as const,
  heroMeta: {
    fontSize: 14,
    color: "#94a3b8",
    maxWidth: 600,
    margin: "0 auto",
  } as const,
  section: {
    maxWidth: 920,
    margin: "0 auto",
    padding: "48px 24px",
  } as const,
  h2: {
    fontSize: 36,
    fontWeight: 700,
    letterSpacing: "-0.015em",
    margin: "0 0 24px",
  } as const,
  h3: {
    fontSize: 19,
    fontWeight: 700,
    margin: "0 0 8px",
  } as const,
  lead: {
    fontSize: 18,
    color: "#475569",
    margin: "0 0 16px",
  } as const,
  list: {
    fontSize: 18,
    color: "#475569",
    paddingLeft: 24,
  } as const,
  pre: {
    margin: "8px 0",
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
    fontSize: 14,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    background: "#0f172a",
    color: "#e2e8f0",
    padding: "12px 16px",
    borderRadius: 8,
    overflowX: "auto",
  } as const,
  stepNote: {
    fontSize: 15,
    color: "#64748b",
    margin: "8px 0 16px",
    fontStyle: "italic",
  } as const,
  inlineLink: {
    color: "#6b21a8",
    textDecoration: "underline",
    fontStyle: "normal",
  } as const,
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
    gap: 20,
  } as const,
  card: {
    background: "#fff",
    borderRadius: 12,
    padding: 24,
    border: "1px solid #e2e8f0",
  } as const,
  useCases: {
    fontSize: 18,
    color: "#475569",
    paddingLeft: 24,
    margin: 0,
  } as const,
  steps: {
    fontSize: 17,
    color: "#475569",
    paddingLeft: 24,
  } as const,
  footer: {
    marginTop: 80,
    padding: "40px 24px 32px",
    background: "#0f172a",
    color: "#cbd5e1",
    textAlign: "center",
  } as const,
  footerLinks: {
    display: "flex",
    gap: 24,
    justifyContent: "center",
    flexWrap: "wrap",
    marginBottom: 16,
  } as const,
  footerLink: {
    color: "#e2e8f0",
    textDecoration: "none",
    fontSize: 14,
  } as const,
  footerSmall: {
    fontSize: 13,
    color: "#94a3b8",
    margin: 0,
  } as const,
};
