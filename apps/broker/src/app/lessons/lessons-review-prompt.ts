// Split out of page.tsx (Server Component, .tsx) so route tests can import
// reviewPromptFor directly -- the shared alias resolver used by
// route-tests/*.routetest.mts (see route-tests/alias-hooks.mjs) resolves
// bare `.ts`/`.mjs`/`.js`, not `.tsx` (Next's JSX convention), the same
// constraint that put link-warnings.ts in its own module instead of inside
// artifact.ts. Zero behavior change: page.tsx re-exports these unchanged.

import { fenceUntrusted, LINK_AGENT_WARNING } from "@/lib/link-warnings";

export type LessonSource = "github" | "backchannel" | "web";

export type Lesson = {
  title: string;
  url: string;
  source: LessonSource;
  description: string;
  submitted_by: string;
  added: string;
};

// Agent-facing safe-handling contract for an external URL — same phrasing
// family as the WS-A /a/<token> envelope ("review then ask", never "install
// this"). This is what gets copied to the clipboard per entry.
//
// L3 (security-pass-2026-07-03.md): lesson.title/url are PR-submitted, so
// technically author-controlled text (this list is community-curated but
// unreviewed content-wise — see the buyer-beware banner). Fence them
// explicitly and re-assert the real warning AFTER the fence, so a crafted
// title can't spoof a fake "verified"/"safe" trailer to the reading agent —
// the last thing it reads in this prompt is always the genuine warning.
export function reviewPromptFor(lesson: Lesson): string {
  const untrustedBlock = fenceUntrusted(`title: ${lesson.title}`, `url: ${lesson.url}`);
  return `Lesson (community-submitted, unreviewed):

${untrustedBlock}

${LINK_AGENT_WARNING}`;
}