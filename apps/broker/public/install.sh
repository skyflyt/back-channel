#!/bin/sh
# Back Channel installer — POSIX sh
# ---------------------------------------------------------------------------
# Installs the Back Channel agent skill into your Claude Code skills folder so
# it's available in every future conversation (not just this one), and can
# optionally connect this agent with a one-time code.
#
# What it does, and ONLY this:
#   1. Fetches SKILL.md/REFERENCE.md from back-channel.app and cross-checks
#      their SHA-256 against a manifest fetched from GitHub raw (a SEPARATE
#      origin/infra from back-channel.app) before writing anything to disk.
#   2. Writes <skills-dir>/back-channel/{SKILL.md,REFERENCE.md}
#   3. Writes <skills-dir>/back-channel/install.json (metadata, never a secret)
#   4. With --pair BCX-XXXX-XXXX: redeems the code and writes ~/.bc/token (0600)
#
# It contacts exactly two hosts: https://back-channel.app (the artifact — the
# skill content and the pairing API) and https://raw.githubusercontent.com
# (the integrity anchor — an expected-hash manifest published from this
# public repo, independent of the back-channel.app deploy). No sudo, no
# shell-rc edits, no PATH/crontab changes, no telemetry, no other host, no
# baked creds.
#
# WHY TWO HOSTS (integrity model): a same-origin hash — publishing the
# expected hash from back-channel.app right next to the content it hashes —
# gives little protection against a compromised host or a MITM: whoever can
# rewrite the served skill content can just as easily rewrite the served hash
# to match. GitHub (a separate origin, separate infra, separate credentials)
# is used as the integrity anchor instead: install.sh fetches the expected
# hash from raw.githubusercontent.com and the content from back-channel.app,
# then requires them to agree. Compromising EITHER origin alone is no longer
# sufficient — an attacker needs to compromise both back-channel.app AND this
# GitHub repo (or intercept both, e.g. a MITM would need to fool both TLS
# connections identically) to substitute malicious agent instructions
# undetected. This is not as strong as a signature (which would also resist a
# compromised release process on one of the two hosts, or GitHub serving a
# stale-but-internally-consistent old manifest) — see docs/install-prompt.md
# and the SEC-4 PR description for that tradeoff discussion — but it is a
# real, meaningfully independent cross-check achievable without a
# key-management story for a solo-maintained project.
#
# If GitHub is unreachable (network partition, rate limit, GitHub outage),
# the script FAILS CLOSED by default rather than silently falling back to the
# old liveness-only check — a quiet downgrade would defeat the point.
# --allow-unverified is available for a deliberate, visible opt-out (prints a
# loud warning; never the silent default).
#
# Source (audit it): https://github.com/skyflyt/back-channel
#   -> apps/broker/public/install.sh   (this file, served verbatim at /install.sh)
# License: MIT, by Skylar Pearce (@skyflyt)
#
# Usage:
#   curl -fsSL https://back-channel.app/install.sh | sh
#   curl -fsSL https://back-channel.app/install.sh | sh -s -- --pair BCX-XXXX-XXXX
#
# Flags:
#   --pair <code>        Redeem a BCX-XXXX-XXXX connect code after installing.
#   --skills-dir <path>  Install into <path>/back-channel instead of auto-detect.
#   --runtime <name>     Label this agent's token (cowork|codex|claude_code|chatgpt|other).
#   --force              Reinstall even if already up to date.
#   --quiet              Only print errors and the final summary.
#   --allow-host         Permit a non-canonical $BC_HOST (advanced / testing).
#   --allow-unverified   Proceed on a LIVENESS-ONLY check if the GitHub integrity
#                        anchor can't be reached. Loud warning; not the default.
#   -h, --help           Show this help.
# ---------------------------------------------------------------------------

set -eu

CANONICAL_HOST="https://back-channel.app"
BC_HOST="${BC_HOST:-$CANONICAL_HOST}"

# Integrity anchor: raw.githubusercontent.com, NOT back-channel.app. This is
# the independent origin the fetched skill content is cross-checked against.
# See the header comment above for why this can't be the same host as $BC_HOST.
CANONICAL_MANIFEST_HOST="https://raw.githubusercontent.com"
BC_MANIFEST_HOST="${BC_MANIFEST_HOST:-$CANONICAL_MANIFEST_HOST}"
BC_MANIFEST_REF="${BC_MANIFEST_REF:-main}"
MANIFEST_PATH="/skyflyt/back-channel/${BC_MANIFEST_REF}/apps/broker/public/skill.sha256"

PAIR_CODE=""
PAIR_REQUESTED=0
SKILLS_DIR_OPT=""
RUNTIME=""
FORCE=0
QUIET=0
ALLOW_HOST=0
ALLOW_UNVERIFIED=0

PROG="bc-install"

log()  { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }
warn() { printf '%s: %s\n' "$PROG" "$*" >&2; }
die()  { printf '%s: %s\n' "$PROG" "$*" >&2; exit 1; }

usage() {
  sed -n '2,66p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
  exit 0
}

# ── parse args ─────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --pair)        shift; [ $# -gt 0 ] || die "--pair needs a code"; PAIR_CODE="$1"; PAIR_REQUESTED=1 ;;
    --pair=*)      PAIR_CODE="${1#*=}"; PAIR_REQUESTED=1 ;;
    --skills-dir)  shift; [ $# -gt 0 ] || die "--skills-dir needs a path"; SKILLS_DIR_OPT="$1" ;;
    --skills-dir=*) SKILLS_DIR_OPT="${1#*=}" ;;
    --runtime)     shift; [ $# -gt 0 ] || die "--runtime needs a value"; RUNTIME="$1" ;;
    --runtime=*)   RUNTIME="${1#*=}" ;;
    --force)       FORCE=1 ;;
    --quiet)       QUIET=1 ;;
    --allow-host)  ALLOW_HOST=1 ;;
    --allow-unverified) ALLOW_UNVERIFIED=1 ;;
    -h|--help)     usage ;;
    *)             die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

# ── host pinning (M4 / §7) ─────────────────────────────────────────────────
# A copy-pasted prompt must not be silently repointed at another origin. Only
# the canonical host runs by default; anything else needs an explicit opt-in.
BC_HOST="${BC_HOST%/}"
if [ "$ALLOW_HOST" -ne 1 ] && [ "$BC_HOST" != "$CANONICAL_HOST" ]; then
  die "refusing to use host '$BC_HOST' — expected $CANONICAL_HOST. Pass --allow-host to override."
fi
case "$BC_HOST" in
  https://*) : ;;
  *) [ "$ALLOW_HOST" -eq 1 ] || die "refusing non-https host '$BC_HOST'. Pass --allow-host to override." ;;
esac
BC_MANIFEST_HOST="${BC_MANIFEST_HOST%/}"
if [ "$ALLOW_HOST" -ne 1 ] && [ "$BC_MANIFEST_HOST" != "$CANONICAL_MANIFEST_HOST" ]; then
  die "refusing to use manifest host '$BC_MANIFEST_HOST' — expected $CANONICAL_MANIFEST_HOST. Pass --allow-host to override."
fi

# ── downloader ─────────────────────────────────────────────────────────────
if command -v curl >/dev/null 2>&1; then
  DL=curl
elif command -v wget >/dev/null 2>&1; then
  DL=wget
else
  die "need curl or wget on PATH"
fi

# http_get URL OUTFILE -> nonzero on any HTTP/transport error.
# curl -f turns HTTP >=400 into a non-zero exit; wget defaults to non-zero on
# server error. We re-validate the body afterwards regardless (M1).
http_get() {
  if [ "$DL" = curl ]; then
    curl -fsSL "$1" -o "$2"
  else
    wget -q -O "$2" "$1"
  fi
}

# ── sha256 (portable across coreutils/BSD/busybox/openssl-only boxes) ──────
# sha256_of FILE -> prints the lowercase hex digest, nothing else.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    die "need sha256sum, shasum, or openssl on PATH to verify skill integrity (see --allow-unverified if you must skip this)"
  fi
}

# ── temp workspace (atomic install) ────────────────────────────────────────
TMPDIR_BC="$(mktemp -d 2>/dev/null || mktemp -d -t bcinstall)"
cleanup() { rm -rf "$TMPDIR_BC"; }
trap cleanup EXIT INT TERM

# ── resolve skills dir (§3) ────────────────────────────────────────────────
if [ -n "$SKILLS_DIR_OPT" ]; then
  SKILLS_DIR="$SKILLS_DIR_OPT"
elif [ -n "${BC_SKILLS_DIR:-}" ]; then
  SKILLS_DIR="$BC_SKILLS_DIR"
elif [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  SKILLS_DIR="$CLAUDE_CONFIG_DIR/skills"
elif [ -d "$HOME/.claude" ]; then
  SKILLS_DIR="$HOME/.claude/skills"
else
  SKILLS_DIR="$HOME/.claude/skills"
fi
DEST="$SKILLS_DIR/back-channel"

# WSL nicety (S3): if running under WSL with no Linux-side ~/.claude but exactly
# one Windows-side profile has .claude, mention --skills-dir. Do not auto-write
# across the mount. Cosmetic hint only; never guesses $USER.
if [ -z "$SKILLS_DIR_OPT" ] && [ ! -d "$HOME/.claude" ] && [ -r /proc/version ]; then
  if grep -qi microsoft /proc/version 2>/dev/null; then
    _winmatches=$(ls -d /mnt/c/Users/*/.claude 2>/dev/null || true)
    _wincount=$(printf '%s\n' "$_winmatches" | grep -c . || true)
    if [ "${_wincount:-0}" -eq 1 ]; then
      warn "WSL detected. To install for your Windows-side Claude instead, re-run with --skills-dir '$_winmatches'."
    elif [ "${_wincount:-0}" -gt 1 ]; then
      warn "WSL detected. To install for a Windows-side Claude instead, re-run with --skills-dir <path>."
    fi
  fi
fi

# ── helpers ────────────────────────────────────────────────────────────────
# Parse a top-level "key": "value" string from JSON (value has no escaped quote).
json_str() {
  # $1 = key, reads JSON on stdin
  sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1
}
# Parse a `key: value` line from YAML-ish frontmatter.
yaml_field() {
  # $1 = field, $2 = file
  sed -n 's/^'"$1"':[[:space:]]*\(.*\)$/\1/p' "$2" 2>/dev/null | head -n1 | tr -d '\r'
}
# Strip control chars for safe printing of free-text (S2 / agent_name).
sanitize() { printf '%s' "$1" | tr -d '\000-\037\177'; }

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ; }

# ── revision check (M3: server is authoritative; equality = skip) ──────────
local_rev=""
if [ -f "$DEST/install.json" ]; then
  local_rev="$(json_str revision < "$DEST/install.json")"
fi
if [ -z "$local_rev" ] && [ -f "$DEST/SKILL.md" ]; then
  local_rev="$(yaml_field revision "$DEST/SKILL.md")"
fi

remote_rev=""
if http_get "$BC_HOST/skill/revision" "$TMPDIR_BC/rev.json" 2>/dev/null; then
  remote_rev="$(json_str revision < "$TMPDIR_BC/rev.json")"
fi

SKIP_SKILL=0
if [ "$FORCE" -ne 1 ] && [ -n "$local_rev" ] && [ -n "$remote_rev" ] && [ "$local_rev" = "$remote_rev" ]; then
  SKIP_SKILL=1
fi

# ── integrity manifest (H3 / SEC-4): fetch the expected hashes from GitHub,
# an origin independent of $BC_HOST, BEFORE trusting anything fetched from
# $BC_HOST. Skipped entirely when SKIP_SKILL=1 (nothing new is being written).
MANIFEST_OK=0
EXPECTED_SKILL_SHA=""
EXPECTED_REFERENCE_SHA=""
if [ "$SKIP_SKILL" -ne 1 ]; then
  if http_get "${BC_MANIFEST_HOST}${MANIFEST_PATH}" "$TMPDIR_BC/skill.sha256" 2>/dev/null \
     && [ -s "$TMPDIR_BC/skill.sha256" ]; then
    EXPECTED_SKILL_SHA="$(sed -n 's/^\([0-9a-f]\{64\}\)[[:space:]]\{1,2\}SKILL\.md$/\1/p' "$TMPDIR_BC/skill.sha256" | head -n1)"
    EXPECTED_REFERENCE_SHA="$(sed -n 's/^\([0-9a-f]\{64\}\)[[:space:]]\{1,2\}REFERENCE\.md$/\1/p' "$TMPDIR_BC/skill.sha256" | head -n1)"
    if [ -n "$EXPECTED_SKILL_SHA" ]; then
      MANIFEST_OK=1
    else
      warn "the integrity manifest from ${BC_MANIFEST_HOST}${MANIFEST_PATH} didn't contain a SKILL.md entry."
    fi
  fi

  if [ "$MANIFEST_OK" -ne 1 ]; then
    if [ "$ALLOW_UNVERIFIED" -eq 1 ]; then
      warn "COULD NOT REACH the GitHub integrity anchor (${BC_MANIFEST_HOST}${MANIFEST_PATH})."
      warn "Proceeding on --allow-unverified: only the liveness check (non-empty + 'name: back-channel')"
      warn "will run, NOT a cross-origin hash check. A compromised $BC_HOST or a MITM would not be caught."
    else
      die "could not reach the GitHub integrity anchor (${BC_MANIFEST_HOST}${MANIFEST_PATH}) to verify the skill before installing it. Nothing was written. This is a fail-closed safety check, not a bug: install.sh will not write unverified content from a single origin. Retry shortly, or pass --allow-unverified to install on a liveness-only check (NOT recommended; see install.sh's header comment for what that gives up)."
    fi
  fi
fi

# ── fetch + validate + write skill (M1 liveness + H3 integrity) ────────────
INSTALLED_REV=""
INSTALLED_VER=""
if [ "$SKIP_SKILL" -eq 1 ]; then
  log "Back Channel skill is already installed and up to date (revision $local_rev)."
  INSTALLED_REV="$local_rev"
  [ -f "$DEST/SKILL.md" ] && INSTALLED_VER="$(yaml_field version "$DEST/SKILL.md")"
else
  if ! http_get "$BC_HOST/skill" "$TMPDIR_BC/SKILL.md"; then
    die "could not fetch the skill from $BC_HOST/skill (the host may be down or mid-deploy). Nothing was written."
  fi
  # M1 liveness: the fetch can succeed at the transport layer yet return an
  # error page (e.g. 404 skill_not_bundled during a redeploy).
  if [ ! -s "$TMPDIR_BC/SKILL.md" ] || ! grep -q '^name:[[:space:]]*back-channel' "$TMPDIR_BC/SKILL.md"; then
    die "the skill served by $BC_HOST/skill didn't look valid (no 'name: back-channel'). Nothing was written. Try again shortly."
  fi

  # H3 integrity: cross-check against the GitHub-anchored expected hash. This
  # is the check that actually defends against a compromised $BC_HOST or a
  # MITM substituting malicious agent instructions — the liveness check above
  # only catches a broken/empty response, not a maliciously well-formed one.
  if [ "$MANIFEST_OK" -eq 1 ]; then
    actual_skill_sha="$(sha256_of "$TMPDIR_BC/SKILL.md")"
    if [ "$actual_skill_sha" != "$EXPECTED_SKILL_SHA" ]; then
      die "INTEGRITY CHECK FAILED for SKILL.md fetched from $BC_HOST/skill.
  expected (from ${BC_MANIFEST_HOST}${MANIFEST_PATH}): $EXPECTED_SKILL_SHA
  actual   (from $BC_HOST/skill):                       $actual_skill_sha
This means the content served by $BC_HOST does NOT match the version published
in the GitHub repo (github.com/skyflyt/back-channel) — the two independent
sources disagree. This could mean $BC_HOST is compromised or mid-deploy, a
network attacker (MITM) substituted the content in transit, or the GitHub
manifest is stale relative to a very recent deploy. Nothing was written.
DO NOT re-run with --allow-unverified to work around this — that skips the
check instead of resolving the disagreement. Wait a few minutes (in case of a
deploy race) and try again; if it persists, treat it as a possible compromise
and report it at https://github.com/skyflyt/back-channel/security."
    fi
    log "Skill content verified against the GitHub integrity anchor (sha256 match)."
  fi

  INSTALLED_REV="$(yaml_field revision "$TMPDIR_BC/SKILL.md")"
  INSTALLED_VER="$(yaml_field version "$TMPDIR_BC/SKILL.md")"

  # REFERENCE.md is best-effort for AVAILABILITY (a hiccup here must not block
  # the P0 install) but NOT for integrity: if we have a manifest hash for it,
  # a mismatch drops the file (falls back to REFERENCE.md's own live
  # on-demand fetch path documented in SKILL.md) rather than silently writing
  # unverified content.
  REF_OK=0
  if http_get "$BC_HOST/skill/reference" "$TMPDIR_BC/REFERENCE.md" 2>/dev/null \
     && [ -s "$TMPDIR_BC/REFERENCE.md" ] \
     && ! head -n1 "$TMPDIR_BC/REFERENCE.md" | grep -q 'Not bundled'; then
    if [ "$MANIFEST_OK" -eq 1 ] && [ -n "$EXPECTED_REFERENCE_SHA" ]; then
      actual_ref_sha="$(sha256_of "$TMPDIR_BC/REFERENCE.md")"
      if [ "$actual_ref_sha" = "$EXPECTED_REFERENCE_SHA" ]; then
        REF_OK=1
      else
        warn "REFERENCE.md fetched from $BC_HOST did not match the GitHub-anchored hash — dropping it (non-fatal; SKILL.md still points at $BC_HOST/skill/reference for on-demand fetch). expected=$EXPECTED_REFERENCE_SHA actual=$actual_ref_sha"
      fi
    elif [ "$MANIFEST_OK" -eq 1 ]; then
      warn "no REFERENCE.md entry in the GitHub manifest — dropping the fetched copy (non-fatal; fetch-on-demand still works)."
    else
      # ALLOW_UNVERIFIED path: no manifest was available at all, so REFERENCE.md
      # gets the same liveness-only treatment SKILL.md got in that degraded mode.
      REF_OK=1
    fi
  fi

  # Commit atomically: build into temp dest, then move files into place.
  mkdir -p "$DEST"
  mv -f "$TMPDIR_BC/SKILL.md" "$DEST/SKILL.md"
  if [ "$REF_OK" -eq 1 ]; then
    mv -f "$TMPDIR_BC/REFERENCE.md" "$DEST/REFERENCE.md"
  else
    warn "could not fetch a verified REFERENCE.md (non-fatal) — the skill points at $BC_HOST/skill/reference and will fetch it on demand."
  fi

  if [ "$FORCE" -eq 1 ] && [ -n "$local_rev" ]; then
    log "Reinstalled Back Channel skill (revision $INSTALLED_REV)."
  elif [ -n "$local_rev" ]; then
    log "Upgraded Back Channel skill: $local_rev -> $INSTALLED_REV."
  else
    log "Installed Back Channel skill (revision $INSTALLED_REV)."
  fi
fi

# ── --pair: redeem connect code (M2, §5) ───────────────────────────────────
PAIRED=0
PAIR_FAILED=0
PAIR_HANDLE=""
PAIR_AGENT=""
PAIR_AGENT_ID=""

# normalize runtime to the documented enum (S1); server coerces unknowns to "other"
case "$RUNTIME" in
  cowork|codex|claude_code|chatgpt|other) : ;;
  "") RUNTIME="other" ;;
  *)  RUNTIME="other" ;;
esac

if [ "$PAIR_REQUESTED" -eq 1 ]; then
  # M2: normalize then strictly validate BEFORE the code touches any request.
  PAIR_CODE="$(printf '%s' "$PAIR_CODE" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')"
  case "$PAIR_CODE" in
    BCX-[ABCDEFGHJKMNPQRSTUVWXYZ23456789][ABCDEFGHJKMNPQRSTUVWXYZ23456789][ABCDEFGHJKMNPQRSTUVWXYZ23456789][ABCDEFGHJKMNPQRSTUVWXYZ23456789]-[ABCDEFGHJKMNPQRSTUVWXYZ23456789][ABCDEFGHJKMNPQRSTUVWXYZ23456789][ABCDEFGHJKMNPQRSTUVWXYZ23456789][ABCDEFGHJKMNPQRSTUVWXYZ23456789]) : ;;
    *) die "that connect code doesn't look right (expected BCX-XXXX-XXXX). The skill is installed; grab a fresh code from $BC_HOST/account and re-run with --pair." ;;
  esac

  body="{\"code\":\"$PAIR_CODE\",\"runtime_type\":\"$RUNTIME\"}"
  resp="$TMPDIR_BC/exchange.json"
  http_code=000
  if [ "$DL" = curl ]; then
    http_code="$(curl -sS -o "$resp" -w '%{http_code}' \
      -X POST -H 'Content-Type: application/json' \
      --data "$body" "$BC_HOST/api/auth/exchange" || echo 000)"
  else
    # wget: status code isn't easily captured; rely on body-content detection.
    wget -q -O "$resp" --header='Content-Type: application/json' \
      --post-data="$body" "$BC_HOST/api/auth/exchange" 2>/dev/null || true
    http_code=body
  fi
  rbody="$(cat "$resp" 2>/dev/null || true)"

  # The sed pattern itself enforces the bc_ prefix + base64url-safe charset.
  api_key="$(printf '%s' "$rbody" | sed -n 's/.*"api_key"[[:space:]]*:[[:space:]]*"\(bc_[A-Za-z0-9_-]*\)".*/\1/p' | head -n1)"

  if [ -n "$api_key" ]; then
    PAIR_HANDLE="$(printf '%s' "$rbody" | json_str handle)"
    PAIR_AGENT="$(sanitize "$(printf '%s' "$rbody" | json_str agent_name)")"
    PAIR_AGENT_ID="$(printf '%s' "$rbody" | json_str agent_id)"
    # write token with mode 0600 — matches the bc-inbox-check recipe (printf, no newline)
    mkdir -p "$HOME/.bc"
    ( umask 077; printf '%s' "$api_key" > "$HOME/.bc/token" )
    chmod 600 "$HOME/.bc/token" 2>/dev/null || true
    PAIRED=1
  else
    case "$rbody" in
      *invalid_or_expired_code*)
        warn "that connect code didn't work — it may be expired or already used (codes are single-use and last 15 minutes). Grab a fresh one from $BC_HOST/account and run the command again." ;;
      *rate_limited*)
        warn "too many connect attempts from this network right now — wait a bit, then re-run with a fresh code from $BC_HOST/account." ;;
      *)
        warn "the skill is installed, but connecting failed (server said: ${http_code}). Re-run with your code: --pair $PAIR_CODE" ;;
    esac
    PAIR_FAILED=1
  fi
fi

# ── write install.json (metadata only — never a secret) ────────────────────
mkdir -p "$DEST"
{
  printf '{\n'
  printf '  "revision": "%s",\n' "$INSTALLED_REV"
  printf '  "version": "%s",\n'  "$INSTALLED_VER"
  printf '  "installed_at": "%s",\n' "$(now_utc)"
  printf '  "source": "%s",\n' "$BC_HOST"
  printf '  "skills_dir": "%s"' "$SKILLS_DIR"
  if [ "$PAIRED" -eq 1 ]; then
    printf ',\n  "agent_id": "%s",\n' "$PAIR_AGENT_ID"
    printf '  "handle": "%s"\n' "$PAIR_HANDLE"
  else
    printf '\n'
  fi
  printf '}\n'
} > "$DEST/install.json"

# ── summary (failure transparency / §7) ────────────────────────────────────
log ""
log "Back Channel — done. Here is exactly what happened:"
log "  • Skill folder : $DEST/"
log "      - SKILL.md       (the agent skill)"
[ -f "$DEST/REFERENCE.md" ] && log "      - REFERENCE.md   (full API reference)"
log "      - install.json   (metadata: revision/version/source — no secrets)"
if [ "$PAIRED" -eq 1 ]; then
  if [ -n "$PAIR_AGENT" ]; then
    log "  • Connected as : $PAIR_HANDLE (this agent: $PAIR_AGENT)"
  else
    log "  • Connected as : ${PAIR_HANDLE:-your account}"
  fi
  log "  • Token file   : $HOME/.bc/token (mode 0600 — never printed)"
fi
log "  • Hosts contacted: $BC_HOST (skill content + pairing), $BC_MANIFEST_HOST (integrity anchor)"
if [ "$MANIFEST_OK" -eq 1 ]; then
  log "  • Integrity    : skill content verified against the GitHub-published hash"
elif [ "$SKIP_SKILL" -ne 1 ]; then
  log "  • Integrity    : ⚠ NOT cross-origin verified (ran with --allow-unverified, liveness check only)"
fi
if [ "$PAIRED" -ne 1 ] && [ "$PAIR_FAILED" -ne 1 ]; then
  log ""
  log "To connect this agent, ask the user for a connect code (looks like BCX-XXXX-XXXX,"
  log "from $BC_HOST/account → Connect a new agent), then run:"
  log "  npx -y backchannel-cli --pair BCX-XXXX-XXXX        # if you have Node"
  log "  curl -fsSL $BC_HOST/install.sh | sh -s -- --pair BCX-XXXX-XXXX"
fi
log ""
log "Restarting your agent will pick the skill up if it isn't visible yet."

# Non-zero exit if a requested pairing failed, so the agent reports honestly.
[ "$PAIR_FAILED" -eq 1 ] && exit 3
exit 0
