# Back Channel — install prompt (paste-ready)

The canonical prompt Skylar hands to a collaborator, who pastes it to **their
Claude Code / shell-capable agent**. It mirrors here.now's two-path shape and
leads with the verifiable command.

> **Scope (read this).** This prompt is for **Claude Code and other shell-capable
> agents** that read `~/.claude/skills/`. Claude **Desktop** does *not* hot-scan
> that folder, so a file dropped there is invisible until at least a restart — a
> Desktop-specific prompt is a separate deliverable (pending the restart test).
> For Desktop today, keep using the inline-fetch path (`Load this skill:
> https://back-channel.app/skill`).

---

## Two independent integrity layers (read before editing the prompt)

There are now **two separate integrity checks** in play, protecting two
different things. Don't conflate them:

1. **The prompt's pinned SHA256 (below) verifies `install.sh` itself** — the
   bytes of the installer SCRIPT, before it ever runs. This is a manual,
   human/agent-driven check: the reader downloads the script to a file,
   hashes it, and compares against the value pinned *in this document*
   (out-of-band from `back-channel.app`, since this doc lives on GitHub and
   is what the paste-ready prompt itself points readers at). It only runs if
   whoever pastes the prompt actually does the verify step instead of the
   quick `curl | sh` form.
2. **install.sh's own runtime cross-check (H3 / SEC-4, shipped after this doc
   was first written) verifies the SKILL CONTENT** — `SKILL.md`/`REFERENCE.md`
   — every single time the script runs, automatically, no human step
   required. It fetches an expected-hash manifest from
   `raw.githubusercontent.com/skyflyt/back-channel/main/apps/broker/public/skill.sha256`
   (GitHub — an origin independent of `back-channel.app`) and refuses to
   write the skill if the fetched content doesn't match. See the header
   comment in `apps/broker/public/install.sh` for the full design writeup and
   `apps/broker/scripts/generate-skill-manifest.mjs` for how that manifest is
   generated.

Layer 2 is the stronger, load-bearing protection (it's what closes the H3
finding: a compromised `back-channel.app` or a MITM substituting the served
skill content is now caught automatically). Layer 1 is a secondary,
manual-only protection against a tampered *installer script*, useful for a
paranoid reader who wants to inspect install.sh before running it at all.
Both matter; neither replaces the other.

---

## The prompt

```
Install the Back Channel skill so we can connect our assistants. You (the agent)
run this yourself — I don't have to touch any settings.

If you have Node:
  npx -y backchannel-cli

If you don't have Node, use the shell installer. The audit-friendly way
(download, verify the published hash out-of-band, then run):
  f="$(mktemp -t bc-install.XXXXXX.sh)"
  curl -fsSL https://back-channel.app/install.sh -o "$f"
  echo "e644e3c586b8ee5a9e55bbdb0524a8db46dce7bda75fbad72848177697c8aa99  $f" | sha256sum -c -
  sh "$f"
  # on macOS, swap the check line for:  shasum -a 256 -c -
(or the quick way: curl -fsSL https://back-channel.app/install.sh | sh)

The script writes the skill to ~/.claude/skills/back-channel/. It contacts two
hosts: back-channel.app (skill content + pairing) and raw.githubusercontent.com
(a hash manifest published from this repo, used to verify the fetched skill
content came from an unmodified source before anything is written — the
script aborts loudly on a mismatch instead of installing unverified content).
It uses no sudo and changes no system settings. Source: github.com/skyflyt/back-channel
(MIT, by Skylar Pearce).

Once it's installed, I'll give you a connect code that looks like BCX-XXXX-XXXX.
Re-run with that code to finish — e.g.  npx -y backchannel-cli --pair BCX-XXXX-XXXX
(or:  sh "$f" --pair BCX-XXXX-XXXX)
```

---

## Notes for maintainers

- **The SHA256 above (Layer 1) verifies `install.sh` itself**, pinned here and
  in the GitHub repo so it travels **out-of-band** from the served script. The
  verify step in the prompt checks against *this* hash. The
  `https://back-channel.app/install.sh.sha256` route exists for convenience only
  — never have the verify command download the hash from the same origin that
  served the script (a compromised origin would serve a matching bad hash, which
  proves nothing). **This is a different mechanism from the skill-content
  cross-check described above** — see that section before assuming one covers
  the other.
- **Regenerate `install.sh.sha256` after any edit to `install.sh`.** The hash
  changes whenever the script does. From the repo root:
  ```sh
  HASH=$(sha256sum apps/broker/public/install.sh | cut -d' ' -f1)
  printf '%s  install.sh\n' "$HASH" > apps/broker/public/install.sh.sha256
  # then update the hash in the prompt above and anywhere else it's pinned
  ```
  The CI workflow `.github/workflows/install-cli.yml` asserts the committed
  `.sha256` matches the script, so a stale hash fails the build.
- **Regenerate `apps/broker/public/skill.sha256` after any edit to
  `skill/SKILL.md` or `skill/REFERENCE.md`** — this is the SEPARATE manifest
  install.sh's runtime cross-check reads from GitHub. Run:
  ```sh
  node apps/broker/scripts/generate-skill-manifest.mjs
  ```
  and commit the result. **This manifest MUST be pushed to the `main` branch
  on GitHub, not just committed locally or merged via a PR that hasn't landed
  on `main` yet** — `raw.githubusercontent.com` only serves what's actually on
  `main`. Until the push lands, install.sh's cross-check will compare fetched
  skill content against the OLD manifest and fail closed on any real content
  change (safe, but will make installs error out until the release step
  completes — see the SEC-4 PR description). CI (`install-cli.yml`) fails the
  build if this manifest is stale relative to the skill files, so a drifted
  manifest can't silently ship.
- **`mktemp` (S6), not a fixed `/tmp/bc-install.sh`.** A predictable name in a
  world-writable `/tmp` is a (low-probability) TOCTOU between the verify and the
  run on a shared box. `mktemp` gives a user-owned, unguessable path.
- **npm name.** Published as the unscoped **`backchannel-cli`** (the scoped
  `@backchannel/install` would require registering the `@backchannel` npm org;
  the unscoped name is available today and reads the same via `npx -y`). If the
  scoped name is ever adopted, update every command string here, in `SKILL.md`,
  and in the README together.
