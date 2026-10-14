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
| Voices | `GET /v1/audio/voices`, `POST /v1/audio/speech` (one sentence → WAV), and the baking endpoints below. |
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

## An audiobook for the car

iOS stops a web page's voice when the screen locks, but it does not stop an audio file. So the Mac can read a
whole paper ahead of time and leave one **m4b audiobook** in a sync folder: the phone plays it with the screen
off, the car's buttons work, and Books remembers where you stopped.

In Zotero this is the **운전용 오디오 만들기 / Make audio for the car** button in the panel's 듣기 (Listen) tab. It sends
the paper as chapters — one per section, whatever the 본문 / +캡션 / +촸고문헌 choice includes — and shows how far it
has got. Baking was measured at about **twice real time** on real papers while the Mac was in use — an
hour of speech takes about half an hour. (A first measurement of four times came from a toy of two
short chapters and did not hold up.)

| | |
|---|---|
| Start | `POST /v1/audio/book` `{title, chapters:[{title,text}], lang, voice, model, speed, tags:{artist,album,year,genre}}` → `202 {id, state, total, out}`. The bake runs on after the answer. |
| Follow | `GET /v1/audio/book/<id>` → `{state, done, total, seconds, file, bytes, gain, ahead, error}`; `state` is `waiting → speaking → encoding → done` (or `failed` / `cancelled`), and `ahead` is how many papers are in front of a waiting one. `GET /v1/audio/book` lists them; `?title=<paper>` also answers `have`: the file this folder already holds for that paper, with its size and when it was made. |
| Stop | `DELETE /v1/audio/book/<id>`: one still waiting is dropped, one being spoken stops at the next sentence. |
| Where it lands | `~/Dropbox/논문 음성/`, else `~/Library/Mobile Documents/com~apple~CloudDocs/논문 음성/`, else `~/Music/논문 음성/`. Set `"audioOut"` in `bridge.json` (or `STYLE_CUSTOM_BRIDGE_AUDIO_OUT`) to choose; it is kept across restarts. |
| Sound | Every piece has the silence the model leaves at its ends trimmed back (40 ms kept), so the pause after a sentence is the one the timeline asked for. Then the whole paper is multiplied by one number, taken from its own loudest moment, so it peaks just under full scale — a phone cannot play louder than its own volume, so a quiet file simply cannot be heard over an engine. The quiet sentences stay quieter than the loud ones, nothing is lifted more than 12×, and the job reports the `gain` it used. `{"trim": false}` or `{"level": false}` turn either off. |
| What lands | `<title>.m4b` (mono AAC, 64 kbps — a paper hour is about 30 MB) with its title, authors, journal and year written in as iTunes tags and `stik=2`, so Books treats it as an audiobook. It carries a chapter list (`moov/udta/chpl`), one per section, so a car's skip button and Books' chapter list move by section. Beside it, `<title>.json` holds the chapter times and every sentence's start, for following along later. A second bake of the same paper becomes `<title> (2).m4b` rather than overwriting the first. |
| Cost | One paper at a time (one ONNX session), up to eight waiting. The scratch WAV goes to `<support>/bake` and is deleted when the bake ends — an hour of speech is about 300 MB while it is being made. |
| Needs | `afconvert`, which is part of macOS. No network, and the paper's text is never written to the log (only its length). |

## Checking it

```sh
curl -s http://127.0.0.1:47823/health
launchctl print gui/$UID/dev.sungjaeyoon.stylecustom-bridge | grep -E 'state|pid'
tail ~/Library/Logs/StyleCustomBridge.log
```

If the log shows `attempts=claude:auth`, run `claude` once in Terminal and log in; `codex:auth` means `codex login`. `status=429` means both accounts are at their limits.
