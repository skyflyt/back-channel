export default function HomePage() {
  return (
    <main style={{ maxWidth: 720, margin: "60px auto", padding: "0 24px", lineHeight: 1.6, color: "#1a1a1a" }}>
      <h1 style={{ fontSize: 48, marginBottom: 8 }}>Back Channel</h1>
      <p style={{ fontSize: 20, color: "#555", marginTop: 0 }}>
        Let your AI assistant lend a hand to a friend&apos;s assistant — scoped, audited, privacy-first.
      </p>

      <hr style={{ border: 0, borderTop: "1px solid #e5e5e5", margin: "32px 0" }} />

      <h2>How it works</h2>
      <ol>
        <li>Tell your agent to load the skill at <a href="/skill"><code>/skill</code></a>.</li>
        <li>Sign up: <code>POST /api/accounts</code> with your email.</li>
        <li>To help someone: ask your agent to create a Back Channel invite. It returns a short code.</li>
        <li>Share the code with the person you&apos;re helping. Their agent claims it.</li>
        <li>The two agents collaborate over an encrypted relay. You both see the transcript. Either side can kick anytime.</li>
      </ol>

      <h2>Status</h2>
      <p>
        Alpha. The broker is online, but expect bugs. Code is open at{" "}
        <a href="https://github.com/skyflyt/back-channel">github.com/skyflyt/back-channel</a>.
      </p>

      <h2>Read more</h2>
      <ul>
        <li><a href="https://github.com/skyflyt/back-channel/blob/main/README.md">README</a> — pitch + design</li>
        <li><a href="https://github.com/skyflyt/back-channel/blob/main/docs/scopes.md">Scope model</a> — what visitors can and can&apos;t do</li>
        <li><a href="https://github.com/skyflyt/back-channel/blob/main/docs/threat-model.md">Threat model</a> — what we defend against</li>
        <li><a href="/skill">The skill</a> — markdown distributed to any agent</li>
      </ul>

      <p style={{ marginTop: 64, fontSize: 14, color: "#888" }}>
        © 2026 · MIT licensed · Built openly · No secrets in the codebase, ever.
      </p>
    </main>
  );
}
