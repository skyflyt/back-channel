#!/bin/bash
# Back Channel worker on macOS: the counterpart of install-dispatch-worker.ps1, for a Mac that runs the worker from
# a clone of this repository (there is no macOS bundle yet).
#
#   bash scripts/install-dispatch-worker-macos.sh [--name NAME] [--broker URL] [--no-start] [--check]
#
# What it does, in order:
#   1. Checks Node 22+ and that the state path crosses no symlink (the worker refuses one).
#   2. First run: asks for the dashboard connect code at a masked prompt (type it HERE, never in an agent chat),
#      exchanges it for the worker's agent credential, runs `init` with the credential in this process's environment
#      only, then `enroll`. Later runs skip all of that: the state already holds the credential and the agent id.
#   3. Writes a LaunchAgent (label app.back-channel.worker) that runs `run` as the signed-in user with KeepAlive,
#      and starts it (unless --no-start). Running the script again replaces the LaunchAgent (an update).
# The code and the credential never reach a file outside the worker's 0700 state directory, and nothing is echoed.
set -euo pipefail

NAME="$(scutil --get ComputerName 2>/dev/null || hostname -s)"
BROKER="https://back-channel.app"
START=1
CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --broker) BROKER="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    --check) CHECK=1; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done
case "$BROKER" in https://*) ;; *) echo "An HTTPS broker URL is required" >&2; exit 1 ;; esac

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
CLI="$REPO/packages/worker/bin/cli.mjs"
STATE="$HOME/.config/back-channel-worker"
LABEL="app.back-channel.worker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/back-channel-worker"
NODE="$(command -v node || true)"

[ -n "$NODE" ] || { echo "Install Node.js 22 or newer (brew install node), then rerun." >&2; exit 1; }
"$NODE" --version | grep -Eq '^v(2[2-9]|[3-9][0-9])\.' || { echo "Node.js 22 or newer is required; found $("$NODE" --version)." >&2; exit 1; }
[ -f "$CLI" ] || { echo "worker CLI not found at $CLI: run this script from a clone of back-channel" >&2; exit 1; }
# The worker refuses a state path that crosses a symlink (store.mjs safeDirectory); say so before anything is created.
p="$STATE"; while [ "$p" != "/" ]; do if [ -L "$p" ]; then echo "The state path must not cross a link: $p" >&2; exit 1; fi; p="$(dirname "$p")"; done
if [ "$CHECK" = 1 ]; then echo "Prerequisites passed: $("$NODE" --version) at $NODE; CLI $CLI; state $STATE"; exit 0; fi

mkdir -p "$LOGS"
if [ -f "$STATE/config.json" ]; then
  echo "Existing worker state at $STATE: keeping its credential and enrollment."
else
  echo "Create a connect code for this agent in the Back Channel dashboard (Agents tab). Enter it here, not in an agent chat."
  read -r -s -p "Connect code (BCX-...): " CODE; echo
  [ -n "$CODE" ] || { echo "no code entered" >&2; exit 1; }
  BODY=$(printf '{"code":"%s"}' "$CODE"); unset CODE
  RESP=$(curl -sS --fail-with-body --max-time 20 -H 'Content-Type: application/json' -X POST "$BROKER/api/auth/exchange" --data "$BODY") || { echo "exchange refused: $RESP" >&2; exit 1; }
  unset BODY
  TOKEN=$("$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.api_key)process.exit(2);process.stdout.write(j.api_key)})' <<<"$RESP") || { echo "the broker did not return an agent credential" >&2; exit 1; }
  unset RESP
  BC_AGENT_TOKEN="$TOKEN" "$NODE" "$CLI" --state "$STATE" init --broker "$BROKER" --name "$NAME"
  unset TOKEN
  "$NODE" "$CLI" --state "$STATE" enroll
fi

# A running worker holds the state lock: stop it with the CLI before replacing the LaunchAgent.
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then launchctl bootout "gui/$(id -u)/$LABEL" || true; fi
"$NODE" "$CLI" --state "$STATE" stop >/dev/null 2>&1 || true

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>$CLI</string>
    <string>--state</string><string>$STATE</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$LOGS/worker.out.log</string>
  <key>StandardErrorPath</key><string>$LOGS/worker.err.log</string>
</dict></plist>
PLIST
plutil -lint "$PLIST" >/dev/null
if [ "$START" = 1 ]; then
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  sleep 2
  launchctl print "gui/$(id -u)/$LABEL" | grep -E '^\s*(state|pid) = ' || true
fi
echo "LaunchAgent: $PLIST (label $LABEL)"
echo "State: $STATE (mode 0700). Logs: $LOGS"
echo "Stop: launchctl bootout gui/\$(id -u)/$LABEL   Start: launchctl bootstrap gui/\$(id -u) $PLIST"
echo "Update: git pull in this clone, then run this script again."
