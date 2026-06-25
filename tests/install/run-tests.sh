#!/usr/bin/env bash
# Integration test harness for apps/broker/public/install.sh.
# CI-runnable on Linux; also runs under macOS/git-bash. Spins up the Node mock
# broker (tests/install/mock-server.mjs), points install.sh at it via
# BC_HOST + --allow-host, and asserts on the resulting filesystem.
#
# Usage: bash tests/install/run-tests.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
INSTALL_SH="$REPO/apps/broker/public/install.sh"
MOCK="$HERE/mock-server.mjs"

PASS=0
FAIL=0
SKIP=0
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; PASS=$((PASS+1)); }
skip() { printf '  \033[33mskip\033[0m %s\n' "$*"; SKIP=$((SKIP+1)); }

# POSIX file modes (umask/chmod) aren't honored on the MSYS/Windows filesystem;
# the 0600 assertion is meaningful only on real Unix (where CI runs).
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) IS_UNIX=0 ;; *) IS_UNIX=1 ;; esac

# Start a fresh mock with the given env assignments; sets MOCK_PID + BASE.
start_mock() {
  MOCK_OUT="$(mktemp)"
  env "$@" BC_MOCK_PORT=0 node "$MOCK" >"$MOCK_OUT" 2>/dev/null &
  MOCK_PID=$!
  # wait for LISTENING line
  for _ in $(seq 1 50); do
    PORT="$(sed -n 's/^LISTENING \([0-9]*\)$/\1/p' "$MOCK_OUT" 2>/dev/null | head -n1)"
    [ -n "$PORT" ] && break
    sleep 0.1
  done
  BASE="http://127.0.0.1:$PORT"
}
# Note: no `wait` here — under MSYS waiting on a killed node child can hang.
stop_mock() { kill "$MOCK_PID" 2>/dev/null; rm -f "$MOCK_OUT"; }

# Fresh sandbox HOME for each scenario so installs don't bleed together.
new_home() { SBX="$(mktemp -d)"; }
run_install() { HOME="$SBX" CLAUDE_CONFIG_DIR="" BC_HOST="$BASE" sh "$INSTALL_SH" --allow-host "$@"; }

echo "install.sh integration tests"
echo "============================"

# ── 1. clean install (no prior ~/.claude) ──────────────────────────────────
new_home; start_mock
out="$(run_install --quiet 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "clean install exits 0" || fail "clean install rc=$rc ($out)"
[ -f "$SBX/.claude/skills/back-channel/SKILL.md" ] && ok "SKILL.md written" || fail "SKILL.md missing"
[ -f "$SBX/.claude/skills/back-channel/REFERENCE.md" ] && ok "REFERENCE.md written" || fail "REFERENCE.md missing"
[ -f "$SBX/.claude/skills/back-channel/install.json" ] && ok "install.json written" || fail "install.json missing"
grep -q '"revision": "2026-06-25-4"' "$SBX/.claude/skills/back-channel/install.json" && ok "install.json has revision" || fail "install.json revision missing"
[ ! -e "$SBX/.bc/token" ] && ok "no token written without --pair" || fail "token written without --pair"
stop_mock

# ── 2. idempotent re-run (same revision) ───────────────────────────────────
# (no --quiet: the "up to date" line is informational and suppressed under --quiet)
start_mock
out="$(run_install 2>&1)"; rc=$?
echo "$out" | grep -qi "already installed and up to date" && ok "re-run reports up to date" || fail "re-run not idempotent ($out)"
[ "$rc" -eq 0 ] && ok "re-run exits 0" || fail "re-run rc=$rc"
stop_mock

# ── 3. upgrade when revision differs (M3: any mismatch -> server wins) ──────
# Local says ...-10 (sorts 'lower' lexically); remote says ...-9. Must upgrade.
printf '{ "revision": "2026-06-25-10", "version": "0.5.99" }' > "$SBX/.claude/skills/back-channel/install.json"
start_mock BC_MOCK_REVISION=2026-06-25-9 BC_MOCK_VERSION=0.5.20
out="$(run_install --quiet 2>&1)"; rc=$?
grep -q '"revision": "2026-06-25-9"' "$SBX/.claude/skills/back-channel/install.json" && ok "mismatched revision upgrades to server copy" || fail "did not upgrade to server revision ($out)"
stop_mock

# ── 4. --force reinstall ───────────────────────────────────────────────────
start_mock
out="$(run_install --quiet --force 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && echo "$out" | grep -qvi "already installed" && ok "--force reinstalls" || fail "--force did not reinstall ($out)"
stop_mock

# ── 5. M1: 404 skill (mid-deploy) writes nothing on a clean box ────────────
new_home; start_mock BC_MOCK_SKILL_STATUS=404
out="$(run_install --quiet 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "404 skill -> non-zero exit" || fail "404 skill exited 0"
[ ! -d "$SBX/.claude/skills/back-channel" ] && ok "404 skill -> no back-channel dir left behind" || fail "404 left a back-channel dir"
stop_mock

# ── 6. M1: 200 but error page body is rejected ─────────────────────────────
new_home; start_mock BC_MOCK_SKILL_BODY=errorpage
out="$(run_install --quiet 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "error-page body -> non-zero exit" || fail "error-page body exited 0"
[ ! -f "$SBX/.claude/skills/back-channel/SKILL.md" ] && ok "error-page body -> SKILL.md not written" || fail "error-page body wrote SKILL.md"
stop_mock

# ── 7. REFERENCE.md best-effort: skill still installs if reference 500s ─────
new_home; start_mock BC_MOCK_REF_STATUS=500
out="$(run_install --quiet 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && [ -f "$SBX/.claude/skills/back-channel/SKILL.md" ] && ok "reference failure non-fatal (SKILL.md installs)" || fail "reference failure blocked install ($out)"
[ ! -f "$SBX/.claude/skills/back-channel/REFERENCE.md" ] && ok "no REFERENCE.md written on reference failure" || fail "REFERENCE.md written despite 500"
stop_mock

# ── 8. --pair success: token mode 0600, key value, key never printed ───────
new_home; start_mock
out="$(run_install --pair bcx-aaaa-bbbb 2>&1)"; rc=$?   # lowercase -> normalized
[ "$rc" -eq 0 ] && ok "--pair success exits 0" || fail "--pair rc=$rc ($out)"
[ -f "$SBX/.bc/token" ] && ok "token written" || fail "token missing"
tok="$(cat "$SBX/.bc/token" 2>/dev/null)"
[ "$tok" = "bc_TESTKEYabcdefghijklmnopqrstuvwxyz012345" ] && ok "token has exact bc_ key (no trailing newline issues)" || fail "token value wrong: '$tok'"
if [ "$IS_UNIX" -eq 1 ]; then
  mode="$(stat -c '%a' "$SBX/.bc/token" 2>/dev/null || stat -f '%Lp' "$SBX/.bc/token" 2>/dev/null)"
  [ "$mode" = "600" ] && ok "token mode 0600" || fail "token mode is $mode"
else
  skip "token mode 0600 (not enforceable on MSYS/Windows filesystem)"
fi
echo "$out" | grep -q "bc_TESTKEY" && fail "API KEY LEAKED to stdout" || ok "api_key never printed"
echo "$out" | grep -q "tester@bc" && ok "handle printed" || fail "handle not printed"
grep -q '"handle": "tester@bc"' "$SBX/.bc/../.claude/skills/back-channel/install.json" 2>/dev/null && ok "handle recorded in install.json" || fail "handle not in install.json"
stop_mock

# ── 9. M2: garbage --pair codes are rejected before any network call ───────
new_home; start_mock
for bad in "foo" "BCX-AAAA-BBBB; rm -rf ~" "" "BCX-AA-BB" "BCX-AAAA-BBB"; do
  out="$(run_install --quiet --pair "$bad" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ] && [ ! -e "$SBX/.bc/token" ]; then ok "rejected bad code: '$bad'"; else fail "accepted bad code: '$bad' (rc=$rc)"; fi
done
stop_mock

# ── 10. --pair 410: plain message, non-zero, NO token, skill still installed ─
new_home; start_mock BC_MOCK_EXCHANGE=410
out="$(run_install --pair BCX-AAAA-BBBB 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "410 -> non-zero exit" || fail "410 exited 0"
[ ! -e "$SBX/.bc/token" ] && ok "410 -> no token written" || fail "410 wrote a token"
[ -f "$SBX/.claude/skills/back-channel/SKILL.md" ] && ok "410 -> skill still installed" || fail "410 lost the skill"
echo "$out" | grep -qi "expired or already used" && ok "410 -> plain-language message" || fail "410 message unclear ($out)"
stop_mock

# ── 11. --pair 429 rate limit ──────────────────────────────────────────────
new_home; start_mock BC_MOCK_EXCHANGE=429
out="$(run_install --pair BCX-AAAA-BBBB 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && echo "$out" | grep -qi "too many" && ok "429 -> rate-limit message, non-zero" || fail "429 handling wrong ($out)"
[ ! -e "$SBX/.bc/token" ] && ok "429 -> no token" || fail "429 wrote a token"
stop_mock

# ── 12. --pair 500: skill stays, token not written, honest failure ─────────
new_home; start_mock BC_MOCK_EXCHANGE=500
out="$(run_install --pair BCX-AAAA-BBBB 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "500 -> non-zero exit" || fail "500 exited 0"
[ ! -e "$SBX/.bc/token" ] && ok "500 -> no token" || fail "500 wrote a token"
[ -f "$SBX/.claude/skills/back-channel/SKILL.md" ] && ok "500 -> skill still installed" || fail "500 lost the skill"
stop_mock

# ── 13. token not clobbered by a plain re-run ──────────────────────────────
new_home; start_mock
run_install --quiet --pair BCX-AAAA-BBBB >/dev/null 2>&1
before="$(cat "$SBX/.bc/token")"
run_install --quiet >/dev/null 2>&1   # no --pair
after="$(cat "$SBX/.bc/token" 2>/dev/null)"
[ "$before" = "$after" ] && [ -n "$after" ] && ok "plain re-run leaves token intact" || fail "token changed on plain re-run"
stop_mock

# ── 14. host pinning: non-canonical host without --allow-host is refused ────
new_home; start_mock
out="$(HOME="$SBX" BC_HOST="$BASE" sh "$INSTALL_SH" --quiet 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && echo "$out" | grep -qi "refusing to use host" && ok "non-canonical host refused without --allow-host" || fail "host pinning not enforced ($out)"
stop_mock

# ── 15. --skills-dir override ───────────────────────────────────────────────
new_home; start_mock
CUSTOM="$SBX/custom-skills"
out="$(HOME="$SBX" BC_HOST="$BASE" sh "$INSTALL_SH" --allow-host --quiet --skills-dir "$CUSTOM" 2>&1)"; rc=$?
[ -f "$CUSTOM/back-channel/SKILL.md" ] && ok "--skills-dir honored" || fail "--skills-dir ignored ($out)"
stop_mock

echo "============================"
echo "PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
[ "$FAIL" -eq 0 ]
