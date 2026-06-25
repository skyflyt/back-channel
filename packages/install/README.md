# backchannel-cli

Install the [Back Channel](https://back-channel.app) agent skill **permanently**
into your Claude Code skills folder, so it's available in every future
conversation — not just the one where you fetched it inline. Optionally connect
this agent in the same step with a one-time code.

```sh
# install the skill (the agent runs this itself — the user does nothing)
npx -y backchannel-cli

# install AND connect in one shot
npx -y backchannel-cli --pair BCX-XXXX-XXXX
```

No Node? Use the shell installer instead:

```sh
curl -fsSL https://back-channel.app/install.sh | sh
curl -fsSL https://back-channel.app/install.sh | sh -s -- --pair BCX-XXXX-XXXX
```

## What it does, and only this

1. Writes `~/.claude/skills/back-channel/SKILL.md` and `REFERENCE.md`
   (the agent skill + full API reference).
2. Writes `~/.claude/skills/back-channel/install.json` — metadata only
   (revision, version, source). **Never a secret.**
3. With `--pair BCX-XXXX-XXXX`: redeems the code at
   `https://back-channel.app/api/auth/exchange` and writes the returned per-agent
   key to `~/.bc/token` (mode `0600`). The key is **never printed**.

It contacts **exactly one host** (`https://back-channel.app`). It does **not**
use `sudo`, edit shell rc files / PATH / crontab, register background jobs, send
telemetry, contact any second host, or bake in any credentials. The only secret
it ever handles is the `BCX-…` code you give it, sent once over TLS.

## Options

| flag | meaning |
|------|---------|
| `--pair <code>` | Redeem a `BCX-XXXX-XXXX` connect code after installing. |
| `--skills-dir <path>` | Install into `<path>/back-channel` instead of auto-detect. |
| `--runtime <name>` | Label this agent's token (`cowork`/`codex`/`claude_code`/`chatgpt`/`other`). |
| `--force` | Reinstall even if already up to date. |
| `--quiet` | Only print errors and the final summary. |
| `--allow-host` | Permit a non-canonical host (advanced / testing). |
| `-h`, `--help` | Show help. |

## Idempotent

Re-running is safe. If the on-disk skill matches the server's current revision,
it reports "already up to date" and exits `0` without rewriting anything. Any
revision mismatch upgrades to the server copy (the broker is authoritative). Your
`~/.bc/token` is **never** overwritten by a plain re-install — only `--pair` with
a fresh code writes it.

## Source & trust

This package is **zero-dependency** (Node stdlib only) and its single source file
is public at
[`packages/install/bin/cli.js`](https://github.com/skyflyt/back-channel/blob/main/packages/install/bin/cli.js).
It is behavior-identical to the shell installer at
[`apps/broker/public/install.sh`](https://github.com/skyflyt/back-channel/blob/main/apps/broker/public/install.sh).

MIT © Skylar Pearce ([@skyflyt](https://github.com/skyflyt))
