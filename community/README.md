# Community lessons

`lessons.json` in this folder feeds the [`/lessons`](https://back-channel.app/lessons) page — a
PR-curated list of external "lessons" (skills, MCP servers, agent recipes, and similar) that
someone in the community found useful and wanted to share.

**Back Channel does not scan, review, or vouch for anything in this list.** Being included here
means it met the plain criteria below and a maintainer merged the PR — nothing more. See the
warning banner on the `/lessons` page itself for the full trust stance.

## How to submit a lesson

1. Fork this repo.
2. Add one entry to the end of the array in [`lessons.json`](./lessons.json):

   ```json
   {
     "title": "Human-readable name",
     "url": "https://github.com/owner/repo",
     "source": "github",
     "description": "One plain sentence: what it is and what it does.",
     "submitted_by": "your-github-handle",
     "added": "YYYY-MM-DD"
   }
   ```

   `source` is one of `github`, `backchannel`, or `web` — pick whichever matches where the URL
   lives. Use today's date for `added`.
3. Open a pull request. CI runs a schema check on `lessons.json` — a malformed entry (missing
   field, wrong type, bad URL scheme) fails the build.
4. A maintainer reviews the PR against the listing criteria below and merges or asks for changes.

## Listing criteria

- **Publicly readable source.** Anyone should be able to open the URL and read what it does
  without signing up, paying, or requesting access.
- **No credential harvesting.** Nothing that asks a visitor or their agent to hand over API keys,
  passwords, or account credentials as part of using it.
- **Plain description.** One honest sentence — no marketing copy, no hype, no "revolutionary."
- **Working URL.** Verify it resolves before you open the PR. Dead links get pulled without
  notice.

## Inclusion is not endorsement

Getting merged into this list means it met the criteria above and someone thought it might be
useful to someone else — **it is not a review, an endorsement, or a safety guarantee.** Content
at these URLs can change after the PR merges, and Back Channel has no way to know if it does.
Read anything before you point an agent at it. See the buyer-beware note at the top of
[`/lessons`](https://back-channel.app/lessons) for the full copy.

## What's next (not built yet)

An in-app submission flow (so you don't need a GitHub account to propose a lesson) is a planned
follow-up. For now, a PR against this file is the only way to add one.