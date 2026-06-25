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
  echo "d33d1b34f4ba65ebb03a66b83763f2219cfcfbe521007d13c4b9016224d9d5d7  $f" | sha256sum -c -
  sh "$f"
  # on macOS, swap the check line for:  shasum -a 256 -c -
(or the quick way: curl -fsSL https://back-channel.app/install.sh | sh)

The script only writes the skill to ~/.claude/skills/back-channel/ and contacts
exactly one host, back-channel.app. It uses no sudo and changes no system
settings. Source: github.com/skyflyt/back-channel (MIT, by Skylar Pearce).

Once it's installed, I'll give you a connect code that looks like BCX-XXXX-XXXX.
Re-run with that code to finish — e.g.  npx -y backchannel-cli --pair BCX-XXXX-XXXX
(or:  sh "$f" --pair BCX-XXXX-XXXX)
```

---

## Notes for maintainers

- **The SHA256 above is the integrity anchor (M4).** It is pinned here and in
  the GitHub repo so it travels **out-of-band** from the served script. The
  verify step in the prompt checks against *this* hash. The
  `https://back-channel.app/install.sh.sha256` route exists for convenience only
  — never have the verify command download the hash from the same origin that
  served the script (a compromised origin would serve a matching bad hash, which
  proves nothing).
- **Regenerate after any edit to `install.sh`.** The hash changes whenever the
  script does. From the repo root:
  ```sh
  HASH=$(sha256sum apps/broker/public/install.sh | cut -d' ' -f1)
  printf '%s  install.sh\n' "$HASH" > apps/broker/public/install.sh.sha256
  # then update the hash in the prompt above and anywhere else it's pinned
  ```
  The CI workflow `.github/workflows/install-cli.yml` asserts the committed
  `.sha256` matches the script, so a stale hash fails the build.
- **`mktemp` (S6), not a fixed `/tmp/bc-install.sh`.** A predictable name in a
  world-writable `/tmp` is a (low-probability) TOCTOU between the verify and the
  run on a shared box. `mktemp` gives a user-owned, unguessable path.
- **npm name.** Published as the unscoped **`backchannel-cli`** (the scoped
  `@backchannel/install` would require registering the `@backchannel` npm org;
  the unscoped name is available today and reads the same via `npx -y`). If the
  scoped name is ever adopted, update every command string here, in `SKILL.md`,
  and in the README together.
