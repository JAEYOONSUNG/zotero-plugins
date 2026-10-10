#!/bin/bash
# Install (or remove) the Style Custom AI bridge as a per-user LaunchAgent.
#
#   bridge/install.sh              install or update, start now and at every login
#   bridge/install.sh --uninstall  stop it and remove the agent, the copy and the token
#   bridge/install.sh --no-voices  skip the read-aloud voices (Supertonic 3, about 420 MB)
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

VOICES=1
[[ "${1:-}" == "--no-voices" ]] && VOICES=0

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

# Read-aloud voices: Supertonic 3 (Supertone) with onnxruntime-node, in $SUPPORT/tts. The model is pinned to
# one revision and downloaded once; a rerun only refreshes the two scripts.
if [[ "$VOICES" == 1 ]]; then
  TTS="$SUPPORT/tts"
  REV=aafc6e32416a594460b32413efc49d7fe4ce6d46
  BASE="https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/$REV"
  mkdir -p "$TTS/assets/onnx" "$TTS/assets/voice_styles"
  install -m 644 "$HERE/tts/speech.mjs" "$HERE/tts/supertonic.mjs" "$HERE/tts/kokoro.mjs" \
                 "$HERE/tts/supertonic-helper.mjs" "$HERE/tts/LICENSE-supertonic" "$TTS/"
  printf '%s\n' '{"name":"style-custom-voices","private":true,"type":"module","dependencies":{"onnxruntime-node":"1.30.0","kokoro-js":"1.2.1"}}' > "$TTS/package.json"
  NPM="$(dirname "$NODE")/npm"; [[ -x "$NPM" ]] || NPM="$(command -v npm || true)"
  if [[ ! -d "$TTS/node_modules/onnxruntime-node" || ! -d "$TTS/node_modules/kokoro-js" ]]; then
    if [[ -n "$NPM" ]]; then (cd "$TTS" && PATH="$(dirname "$NODE"):$PATH" "$NPM" install --omit=dev --no-audit --no-fund --silent) || echo "npm install failed; read-aloud keeps the system voices." >&2
    else echo "npm was not found; read-aloud keeps the system voices." >&2; fi
  fi
  for f in onnx/duration_predictor.onnx onnx/text_encoder.onnx onnx/vector_estimator.onnx onnx/vocoder.onnx onnx/tts.json onnx/unicode_indexer.json \
           voice_styles/F1.json voice_styles/F2.json voice_styles/F3.json voice_styles/F4.json voice_styles/F5.json \
           voice_styles/M1.json voice_styles/M2.json voice_styles/M3.json voice_styles/M4.json voice_styles/M5.json; do
    [[ -s "$TTS/assets/$f" ]] && continue
    echo "Downloading voices: $f"
    curl -fsSL --retry 3 -o "$TTS/assets/$f.part" "$BASE/$f" && mv "$TTS/assets/$f.part" "$TTS/assets/$f" || { rm -f "$TTS/assets/$f.part"; echo "Could not download $f; read-aloud keeps the system voices." >&2; break; }
  done
fi

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
      [[ "$VOICES" == 1 && -s "$SUPPORT/tts/assets/onnx/vocoder.onnx" ]] && echo "Read-aloud voices: Supertonic 3 (local)."
      echo "Zotero finds it by itself while 'AI 서버 주소' is left empty."
      echo "Remove it with: $HERE/install.sh --uninstall"
      exit 0
    fi
  fi
  sleep 0.2
done
echo "The agent was loaded but did not answer yet; see $LOG" >&2
exit 1
