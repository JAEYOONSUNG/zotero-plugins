# Style Custom AI bridge

A small local server that lets Style Custom's AI features (summaries, chat about a paper, translation, tags, reading papers together) answer with the **Claude and ChatGPT accounts you are already logged in to on this Mac**, without an API key.

- **Claude first.** Each request runs `claude -p` (Claude Code) with your Claude account and streams the answer back as it is written.
- **ChatGPT when Claude cannot.** If Claude is not logged in, has hit its usage limit, or fails before writing anything, the same request goes to `codex exec` (Codex CLI) with your ChatGPT account. Codex does not stream, so its answer arrives in one piece, typically after 15–25 seconds.
- Your accounts' own **usage limits apply**. A summary or a chat turn counts against your Claude plan the same way a Claude Code message does.

## Install, update, remove

```sh
bridge/install.sh              # install or update; starts now and at every login
bridge/install.sh --uninstall  # stop it and remove the agent, its copy and its token
```

The script copies `ai-bridge.mjs` to `~/Library/Application Support/StyleCustomBridge/`, writes the LaunchAgent `~/Library/LaunchAgents/dev.sungjaeyoon.stylecustom-bridge.plist` (RunAtLoad, KeepAlive) and loads it with `launchctl bootstrap gui/$UID`. No sudo. Run it again after changing `ai-bridge.mjs`.

In Zotero, leave **Settings → Translate·AI → AI server address** empty: the plugin finds the bridge by itself and the panel names the account that answered (*Claude 계정 (이 Mac)* or *ChatGPT 계정 (이 Mac)*). An address entered there always takes precedence over the bridge. The **model name** may stay empty (Claude, Sonnet); `opus`, `haiku` or `chatgpt` pick those instead.

## What it does, exactly

| | |
|---|---|
| Address | `127.0.0.1:47823` only (never the network). Change the port with `"port"` in `bridge.json` or `STYLE_CUSTOM_BRIDGE_PORT`. |
| API | OpenAI-compatible `POST /v1/chat/completions` (`messages`, `model`, `stream`; other fields ignored) and `GET /v1/models`. `GET /health` answers `{ok, providers}` without a token. |
| Token | Random, made on first start, kept in `~/Library/Application Support/StyleCustomBridge/bridge.json` (mode 600) as `{port, token, version, providers}`. Every request except `/health` needs `Authorization: Bearer <token>`. |
| Browsers | A request carrying a web `Origin` (http/https/file) is refused, CORS preflights are refused, and the `Host` must be `127.0.0.1` or `localhost` (DNS rebinding). |
| Load | At most two CLI processes at once; up to 16 more wait in line. A process is killed when the client disconnects or after 300 s without output. |
| Response header | `x-bridge-provider: claude` or `codex`, so the plugin can say which account answered. |
| Log | `~/Library/Logs/StyleCustomBridge.log`: one line per request with time, provider, durations, status and character counts. **Prompts and answers are never written to the log.** The system prompt (Claude) and Codex's answer pass through a temporary file (mode 600) in the system temp folder that is deleted when the request ends. |

The two command lines (the prompt goes on stdin, never on the command line):

```sh
claude -p --model sonnet --output-format stream-json --include-partial-messages --verbose \
  --tools "" --setting-sources "" --settings '{"autoMemoryEnabled":false}' \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands \
  --no-session-persistence --permission-mode dontAsk --permission-prompts none \
  --system-prompt-file <tmp file, mode 600, removed after>

codex exec --skip-git-repo-check --ignore-user-config --ignore-rules --ephemeral \
  -s read-only --color never --disable shell_tool --disable unified_exec ... \
  -c skills.include_instructions=false -c skills.bundled.enabled=false \
  -c web_search="disabled" -c model_reasoning_effort="low" -o <tmp file> -
```

Both run in an empty folder with no tools, no MCP servers, no hooks, no plugins or skills, no CLAUDE.md / AGENTS.md / memory, and no saved session, so a paper's text cannot make them read or change anything on this Mac, and your own coding instructions do not leak into the answers. Nothing leaves the machine except through these two CLIs, to the services you are logged in to.

Settings by environment variable (put them in the plist's `EnvironmentVariables`): `STYLE_CUSTOM_BRIDGE_PORT`, `CLAUDE_BIN`, `CODEX_BIN`, `STYLE_CUSTOM_BRIDGE_CODEX_EFFORT` (`minimal|low|medium|high`, default `low`).

## Checking it

```sh
curl -s http://127.0.0.1:47823/health
launchctl print gui/$UID/dev.sungjaeyoon.stylecustom-bridge | grep -E 'state|pid'
tail ~/Library/Logs/StyleCustomBridge.log
```

If the log shows `attempts=claude:auth`, run `claude` once in Terminal and log in; `codex:auth` means `codex login`. `status=429` means both accounts are at their limits.
