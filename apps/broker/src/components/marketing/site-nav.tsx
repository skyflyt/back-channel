import { cookies } from "next/headers";

/**
 * The one header every public page shares (landing, about, how it works, FAQ, commands,
 * community tools, privacy, trust). Before this each page hand-rolled its own link row and
 * none of them knew whether the visitor was signed in. Server component: it reads the
 * session cookie's presence only (never its value) to swap "Sign up / Sign in" for
 * "Open Back Channel". A stale cookie just lands on the account page's signed-out card.
 */

// Same name as SESSION_COOKIE_NAME in lib/auth.ts; spelled out here so a public page's
// bundle does not pull the auth module in just to read a constant.
const SESSION_COOKIE = "bc_session";

export const SITE_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/faq", label: "FAQ" },
  { href: "/commands", label: "Commands" },
  { href: "/lessons", label: "Community tools" },
  { href: "/trust", label: "Trust & security" },
  { href: "https://github.com/skyflyt/back-channel", label: "GitHub ↗" },
];

export default async function SiteNav({ active }: { active?: string } = {}) {
  const signedIn = (await cookies()).has(SESSION_COOKIE);
  return (
    <header style={nav.header} className="bc-site-nav">
      {/* Below ~760px the link row drops under the brand and buttons instead of squeezing into one column beside them. */}
      <style>{`
        .bc-site-nav-links { flex: 1 1 auto; }
        @media (max-width: 760px) {
          .bc-site-nav-links { flex-basis: 100%; order: 3; row-gap: 8px; }
        }
      `}</style>
      <a href="/" style={nav.brand}>◇ Back Channel</a>
      <nav style={nav.links} className="bc-site-nav-links" aria-label="Site">
        {SITE_LINKS.map((l) => (
          <a key={l.href} href={l.href} style={{ ...nav.link, ...(active === l.href ? nav.linkActive : null) }}>{l.label}</a>
        ))}
      </nav>
      <span style={nav.ctas}>
        {signedIn ? (
          <a href="/account" style={nav.primary}>Open Back Channel</a>
        ) : (
          <>
            <a href="/login" style={nav.secondary}>Sign in</a>
            <a href="/signup" style={nav.primary}>Sign up</a>
          </>
        )}
      </span>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer style={foot.footer}>
      <div style={foot.links}>
        <a href="/about" style={foot.link}>About</a>
        <a href="/how-it-works" style={foot.link}>How it works</a>
        <a href="/faq" style={foot.link}>FAQ</a>
        <a href="/commands" style={foot.link}>Commands</a>
        <a href="/lessons" style={foot.link}>Community tools</a>
        <a href="/privacy" style={foot.link}>Privacy</a>
        <a href="/trust" style={foot.link}>Trust &amp; security</a>
        <a href="/skill" style={foot.link}>Agent skill</a>
        <a href="https://github.com/skyflyt/back-channel" style={foot.link}>GitHub</a>
        <a href="https://github.com/skyflyt/back-channel/blob/main/SECURITY.md" style={foot.link}>Security</a>
      </div>
      <p style={foot.small}>© 2026 · MIT licensed · Built in public by Skylar Pearce · End-to-end encrypted · No secrets in the codebase, ever.</p>
    </footer>
  );
}

const nav = {
  header: {
    position: "sticky", top: 0, zIndex: 50,
    display: "flex", alignItems: "center", flexWrap: "wrap", gap: "10px 18px",
    padding: "12px 24px", boxSizing: "border-box", width: "100%",
    background: "rgba(250,250,249,0.88)", backdropFilter: "saturate(180%) blur(8px)", WebkitBackdropFilter: "saturate(180%) blur(8px)",
    borderBottom: "1px solid #ececec", fontFamily: "system-ui, -apple-system, sans-serif",
  } as const,
  brand: { fontSize: 16, fontWeight: 700, color: "#0f172a", textDecoration: "none", letterSpacing: "-0.01em", marginRight: 6 } as const,
  links: { display: "flex", flexWrap: "wrap", gap: "6px 18px", fontSize: 14, minWidth: 0 } as const,
  link: { color: "#475569", textDecoration: "none", fontWeight: 600, whiteSpace: "nowrap" } as const,
  linkActive: { color: "#0f172a", textDecoration: "underline", textUnderlineOffset: 6 } as const,
  ctas: { display: "flex", gap: 10, alignItems: "center", marginLeft: "auto" } as const,
  primary: { display: "inline-block", padding: "8px 16px", fontSize: 14, fontWeight: 600, color: "#fff", background: "#0f172a", borderRadius: 9, textDecoration: "none", whiteSpace: "nowrap" } as const,
  secondary: { display: "inline-block", padding: "8px 14px", fontSize: 14, fontWeight: 600, color: "#0f172a", background: "#fff", border: "1px solid #cbd5e1", borderRadius: 9, textDecoration: "none", whiteSpace: "nowrap" } as const,
};

const foot = {
  footer: { marginTop: 80, padding: "40px 24px 32px", background: "#0f172a", color: "#cbd5e1", textAlign: "center", fontFamily: "system-ui, -apple-system, sans-serif" } as const,
  links: { display: "flex", gap: "10px 24px", justifyContent: "center", flexWrap: "wrap", marginBottom: 16 } as const,
  link: { color: "#e2e8f0", textDecoration: "none", fontSize: 14 } as const,
  small: { fontSize: 13, color: "#94a3b8", margin: 0 } as const,
};
