"use client";
/**
 * The app's own error page for anything that escapes every other boundary.
 *
 * Next's built-in one renders `<style dangerouslySetInnerHTML>`, a raw-string HTML sink that this site's Trusted
 * Types policy (src/middleware.ts) blocks in production. So a client error used to fail twice and leave a blank white
 * page with nothing on it and nothing useful in the console (2026-10-10: /account for every signed-in user). This one
 * uses inline styles and plain text only, so it can always render.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", background: "#f6f7fb", color: "#111827" }}>
        <main style={{ maxWidth: 520, margin: "15vh auto 0", padding: "0 20px" }}>
          <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Something went wrong on this page</h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: "#4b5563", margin: "0 0 20px" }}>
            Back Channel hit an error showing it. Reloading usually fixes it. Your lists, messages and agents are safe: nothing was lost.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ font: "inherit", fontSize: 14, fontWeight: 600, color: "#fff", background: "#6d4aff", border: "none", borderRadius: 8, padding: "9px 16px", cursor: "pointer" }}
          >
            Reload
          </button>
          {error?.digest ? (
            <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 24 }}>Error reference: {error.digest}</p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
