#!/bin/bash
# Install (or remove) the Style Custom AI bridge as a per-user LaunchAgent.
#
#   bridge/install.sh              install or update, start now and at every login
#   bridge/install.sh --uninstall  stop it and remove the agent, the copy and the token
#
# The bridge listens on 127.0.0.1 only and answers with the claude / codex
# command-line tools you are already logged in to. Nothing needs sudo.
set -euo pipefail

LABEL="dev.sungjaeyoon.stylecustom-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SUPPORT="$HOME/Library/Application Support/StyleCustomBridge"
LOG="$HOME/Library/Logs/StyleCustomBridge.log"
DOMAIN="gui/$(id -u)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

unload() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
  # bootout returns before the service is gone; bootstrapping too early fails with error 5.
  for _ in $(seq 1 50); do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
}

if [[ "${1:-}" == "--uninstall" ]]; then
  unload
  rm -f "$PLIST"
  rm -rf "$SUPPORT"
  echo "Removed the Style Custom AI bridge ($LABEL)."
  echo "The log is kept at $LOG; delete it if you like."
  exit 0
fi

NODE="${NODE:-$(command -v node || true)}"
[[ -z "$NODE" && -x /opt/homebrew/bin/node ]] && NODE=/opt/homebrew/bin/node
[[ -z "$NODE" && -x /usr/local/bin/node ]] && NODE=/usr/local/bin/node
if [[ -z "$NODE" ]]; then echo "node was not found. Install Node 18 or newer first." >&2; exit 1; fi

PATH_VALUE="$HOME/bin:$HOME/.local/bin:$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
found=""
for tool in claude codex; do
  if PATH="$PATH_VALUE" command -v "$tool" >/dev/null 2>&1; then found="$found $tool"; fi
done
if [[ -z "$found" ]]; then echo "Neither claude nor codex was found on $PATH_VALUE." >&2; exit 1; fi

# Run a copy, so moving or deleting this checkout does not break the agent.
mkdir -p "$SUPPORT" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
chmod 700 "$SUPPORT"
install -m 600 "$HERE/ai-bridge.mjs" "$SUPPORT/ai-bridge.mjs"
touch "$LOG"; chmod 600 "$LOG"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$SUPPORT/ai-bridge.mjs")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$PATH_VALUE")</string>
    <key>HOME</key><string>$(xml "$HOME")</string>
  </dict>
  <key>WorkingDirectory</key><string>$(xml "$SUPPORT")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Standard</string>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
EOF
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null

unload
launchctl bootstrap "$DOMAIN" "$PLIST"

# Wait for the first start to write the token and answer /health.
for _ in $(seq 1 50); do
  if [[ -f "$SUPPORT/bridge.json" ]]; then
    PORT="$("$NODE" -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port))' "$SUPPORT/bridge.json" 2>/dev/null || true)"
    if [[ -n "$PORT" ]] && curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      echo "Style Custom AI bridge is running on 127.0.0.1:$PORT with:$found"
      echo "Zotero finds it by itself while 'AI 서버 주소' is left empty."
      echo "Remove it with: $HERE/install.sh --uninstall"
      exit 0
    fi
  fi
  sleep 0.2
done
echo "The agent was loaded but did not answer yet; see $LOG" >&2
exit 1
