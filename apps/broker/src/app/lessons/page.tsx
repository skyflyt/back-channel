import type { Metadata } from "next";
import lessonsData from "../../../../../community/lessons.json";
import CopyPromptButton from "./copy-prompt-button";

/**
 * Community lessons page (WS-B, Link Lessons epic).
 *
 * Renders community/lessons.json — imported at BUILD TIME (no runtime fetch,
 * no server-side fetching of external URLs; deploys are manual so this list
 * only changes when someone ships a new build after a merged PR). This keeps
 * the broker content-blind and honest: we show what shipped, not a live feed.
 * Server component (no DB, no request-time data) — the only client-side bit
 * is the copy-to-clipboard button, split into copy-prompt-button.tsx.
 *
 * The trust-stance banner copy below is CANONICAL (Link Lessons epic,
 * "the trust stance" section) — reused verbatim, tense adapted for third
 * person since this is a page about the whole list, not a single lesson.
 */

export const metadata: Metadata = {
  title: "Community lessons — Back Channel",
  description:
    "Skills, MCP servers, and agent recipes the community has pointed out — curated by pull request. Back Channel doesn't scan or review any of it: buyer beware.",
};

type LessonSource = "github" | "backchannel" | "web";

type Lesson = {
  title: string;
  url: string;
  source: LessonSource;
  description: string;
  submitted_by: string;
  added: string;
};

const lessons = lessonsData as Lesson[];

const SOURCE_BADGE: Record<LessonSource, { icon: string; label: string }> = {
  github: { icon: "🐙", label: "GitHub" },
  backchannel: { icon: "◇", label: "Back Channel" },
  web: { icon: "🌐", label: "Web" },
};

// Agent-facing safe-handling contract for an external URL — same phrasing
// family as the WS-A /a/<token> envelope ("review then ask", never "install
// this"). This is what gets copied to the clipboard per entry.
function reviewPromptFor(lesson: Lesson): string {
  return `This is an EXTERNAL lesson from the Back Channel community list — Back Channel has not scanned or reviewed it, and its content can change at any time.

Title: ${lesson.title}
URL: ${lesson.url}

Please: fetch it, read it in full, summarize to me what it does and what access it wants, and get my explicit yes before installing anything. If it asks for credentials, network access, or scheduled tasks, tell me plainly. Never install it blind.`;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default function CommunityLessonsPage() {
  return (
    <main className="lp-page">
      <style>{`
        .lp-page {
          margin: 0;
          min-height: 100vh;
          font-family: system-ui, -apple-system, sans-serif;
          line-height: 1.6;
          color: #0f172a;
          background: linear-gradient(180deg, #fafaf9 0%, #f5f5f4 100%);
        }
        @media (prefers-color-scheme: dark) {
          .lp-page { color: #e5e7eb; background: linear-gradient(180deg, #0b0b0d 0%, #131316 100%); }
        }
        .lp-wrap { max-width: 780px; margin: 0 auto; padding: 56px 24px; }
        .lp-nav { display: flex; gap: 20px; flex-wrap: wrap; font-size: 14px; margin-bottom: 36px; }
        .lp-nav a { color: #6b21a8; text-decoration: none; font-weight: 600; }
        @media (prefers-color-scheme: dark) { .lp-nav a { color: #c084fc; } }
        .lp-eyebrow { font-size: 13px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b21a8; margin-bottom: 12px; }
        @media (prefers-color-scheme: dark) { .lp-eyebrow { color: #c084fc; } }
        .lp-h1 { font-size: 36px; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 12px; }
        .lp-sub { font-size: 17px; color: #475569; margin: 0 0 28px; }
        @media (prefers-color-scheme: dark) { .lp-sub { color: #a1a1aa; } }

        .lp-banner {
          border: 1px solid rgba(180, 83, 9, 0.35);
          background: rgba(251, 191, 36, 0.12);
          border-radius: 10px;
          padding: 16px 18px;
          margin-bottom: 32px;
          font-size: 15px;
          color: #78350f;
        }
        @media (prefers-color-scheme: dark) {
          .lp-banner { background: rgba(251, 191, 36, 0.08); border-color: rgba(251, 191, 36, 0.3); color: #fcd34d; }
        }
        .lp-banner strong { font-weight: 700; }

        .lp-submit-row { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 24px; }
        .lp-submit-link {
          font-size: 14px; font-weight: 700; color: #0f766e; text-decoration: none;
          padding: 8px 14px; border-radius: 999px; background: rgba(15, 118, 110, 0.1);
          white-space: nowrap;
        }
        @media (prefers-color-scheme: dark) { .lp-submit-link { color: #5eead4; background: rgba(94, 234, 212, 0.12); } }

        .lp-list { display: flex; flex-direction: column; gap: 14px; }
        .lp-card {
          border: 1px solid rgba(15, 23, 42, 0.08);
          border-radius: 12px;
          padding: 18px 20px;
          background: rgba(255,255,255,0.6);
        }
        @media (prefers-color-scheme: dark) {
          .lp-card { border-color: rgba(255,255,255,0.1); background: rgba(255,255,255,0.03); }
        }
        .lp-card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
        .lp-card-title { font-size: 17px; font-weight: 700; margin: 0 0 4px; }
        .lp-card-title a { color: inherit; text-decoration: none; }
        .lp-card-title a:hover { text-decoration: underline; }
        .lp-badge {
          font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px;
          background: #ede9fe; color: #5b21b6; white-space: nowrap; flex-shrink: 0;
        }
        @media (prefers-color-scheme: dark) { .lp-badge { background: rgba(196, 181, 253, 0.15); color: #d8b4fe; } }
        .lp-ext-badge {
          font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 999px;
          background: rgba(180, 83, 9, 0.12); color: #92400e; white-space: nowrap;
        }
        @media (prefers-color-scheme: dark) { .lp-ext-badge { background: rgba(251, 191, 36, 0.1); color: #fcd34d; } }
        .lp-card-desc { font-size: 14px; color: #334155; margin: 8px 0 10px; }
        @media (prefers-color-scheme: dark) { .lp-card-desc { color: #cbd5e1; } }
        .lp-card-meta { font-size: 12px; color: #64748b; margin: 0 0 12px; }
        @media (prefers-color-scheme: dark) { .lp-card-meta { color: #71717a; } }
        .lp-card-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .lp-btn {
          font-size: 13px; font-weight: 600; padding: 6px 12px; border-radius: 8px;
          border: 1px solid rgba(15, 23, 42, 0.15); background: transparent; color: inherit; cursor: pointer;
        }
        @media (prefers-color-scheme: dark) { .lp-btn { border-color: rgba(255,255,255,0.18); } }
        .lp-btn-primary { background: #0f766e; color: white; border-color: #0f766e; }
        @media (prefers-color-scheme: dark) { .lp-btn-primary { background: #14b8a6; border-color: #14b8a6; color: #042f2e; } }

        .lp-empty { font-size: 15px; color: #64748b; padding: 24px 0; }
        .lp-back { margin-top: 40px; font-size: 15px; }
        .lp-back a { color: #6b21a8; text-decoration: underline; }
        @media (prefers-color-scheme: dark) { .lp-back a { color: #c084fc; } }
      `}</style>

      <div className="lp-wrap">
        <nav className="lp-nav">
          <a href="/">Home</a>
          <a href="/account">Dashboard</a>
          <a href="/how-it-works">How it works</a>
          <a href="https://github.com/skyflyt/back-channel">GitHub ↗</a>
        </nav>

        <p className="lp-eyebrow">Community</p>
        <h1 className="lp-h1">Community lessons</h1>
        <p className="lp-sub">
          Skills, MCP servers, and agent recipes the community has pointed out — curated by pull
          request, not by us.
        </p>

        <div className="lp-banner">
          <strong>We don&apos;t scan or review external lessons.</strong> A link lesson is
          whatever its author published — it can change after you save it. Anything you install
          runs with your agent&apos;s access. Read it before you install it, and only take
          lessons from sources you trust.
        </div>

        <div className="lp-submit-row">
          <p style={{ margin: 0, fontSize: 14, color: "inherit" }}>
            {lessons.length} {lessons.length === 1 ? "entry" : "entries"}, added by pull request.
          </p>
          <a
            className="lp-submit-link"
            href="https://github.com/skyflyt/back-channel/blob/main/community/README.md"
          >
            ＋ Submit yours ↗
          </a>
        </div>

        {lessons.length === 0 ? (
          <p className="lp-empty">Nothing here yet — be the first to submit one.</p>
        ) : (
          <div className="lp-list">
            {lessons.map((lesson) => {
              const badge = SOURCE_BADGE[lesson.source] ?? SOURCE_BADGE.web;
              return (
                <div className="lp-card" key={lesson.url}>
                  <div className="lp-card-top">
                    <h2 className="lp-card-title">
                      <a href={lesson.url} target="_blank" rel="noopener noreferrer">
                        {lesson.title}
                      </a>
                    </h2>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <span className="lp-badge">{badge.icon} {badge.label}</span>
                      <span className="lp-ext-badge">↗ external · unreviewed</span>
                    </div>
                  </div>
                  <p className="lp-card-desc">{lesson.description}</p>
                  <p className="lp-card-meta">
                    {domainOf(lesson.url)} · submitted by @{lesson.submitted_by} · added {lesson.added}
                  </p>
                  <div className="lp-card-actions">
                    <CopyPromptButton prompt={reviewPromptFor(lesson)} />
                    <a className="lp-btn" href={lesson.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none", display: "inline-block" }}>
                      Open ↗
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="lp-back"><a href="/">← Back to home</a></p>
      </div>
    </main>
  );
}