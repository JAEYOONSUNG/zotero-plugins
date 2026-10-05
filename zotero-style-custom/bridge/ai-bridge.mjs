#!/usr/bin/env node
/* Style Custom AI bridge.

   A tiny OpenAI-compatible server on 127.0.0.1 that answers with the user's own
   logged-in command-line accounts instead of an API key:

     1. `claude -p`   (Claude Code, the Claude account)      -- primary, streamed
     2. `codex exec`  (Codex CLI, the ChatGPT account)       -- fallback, one piece

   Nothing leaves the machine except through those two CLIs. Prompts and answers
   are never written anywhere: the log holds one line per request with sizes,
   times and status only. Each CLI runs with no tools, no MCP servers, no hooks,
   no user instructions and no saved session, in an empty working directory.

   No dependencies. Node 18+. */
import http from 'node:http';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const VERSION = '1.0.0';
const HOME = os.homedir();
const SUPPORT = process.env.STYLE_CUSTOM_BRIDGE_DIR || path.join(HOME, 'Library', 'Application Support', 'StyleCustomBridge');
const CONFIG = path.join(SUPPORT, 'bridge.json');
const WORK = path.join(SUPPORT, 'work');             // the CLIs' cwd: always empty
const LOG = process.env.STYLE_CUSTOM_BRIDGE_LOG || path.join(HOME, 'Library', 'Logs', 'StyleCustomBridge.log');
const DEFAULT_PORT = 47823;
const MAX_CONCURRENT = 2;
const MAX_QUEUE = 16;
const QUIET_MS = Number(process.env.STYLE_CUSTOM_BRIDGE_QUIET_MS) || 300000;   // inactivity, not total
const MAX_BODY = 2 * 1024 * 1024;
const MAX_PROMPT_CHARS = 400000;

/* ---------- binaries ---------- */
function which(name, envName) {
  const explicit = process.env[envName];
  if (explicit) return explicit;
  const dirs = [...String(process.env.PATH || '').split(':'), path.join(HOME, 'bin'), path.join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try { fs.accessSync(full, fs.constants.X_OK); return full; } catch (_) {}
  }
  return null;
}
const BIN = {claude: which('claude', 'CLAUDE_BIN'), codex: which('codex', 'CODEX_BIN')};
const providers = () => ['claude', 'codex'].filter(p => BIN[p]);

/* ---------- config: port + token, mode 600 ---------- */
function loadConfig() {
  fs.mkdirSync(SUPPORT, {recursive: true, mode: 0o700});
  fs.mkdirSync(WORK, {recursive: true, mode: 0o700});
  let config = {};
  try { config = JSON.parse(fs.readFileSync(CONFIG, 'utf8')) || {}; } catch (_) {}
  const envPort = Number(process.env.STYLE_CUSTOM_BRIDGE_PORT);
  const port = Number.isInteger(envPort) && envPort > 1023 && envPort < 65536 ? envPort
    : Number.isInteger(config.port) && config.port > 1023 && config.port < 65536 ? config.port : DEFAULT_PORT;
  const token = typeof config.token === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(config.token) ? config.token : crypto.randomBytes(32).toString('base64url');
  const out = {port, token, version: VERSION, providers: providers()};
  const tmp = CONFIG + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, CONFIG);
  fs.chmodSync(CONFIG, 0o600);
  return out;
}

/* ---------- log: one line per request, never content ---------- */
function rotateLog() {
  try { if (fs.statSync(LOG).size > 5 * 1024 * 1024) fs.renameSync(LOG, LOG + '.1'); } catch (_) {}
}
function log(fields) {
  const line = [new Date().toISOString(), ...Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${String(v).replace(/\s+/g, '_').slice(0, 80)}`)].join(' ');
  try { fs.appendFileSync(LOG, line + '\n', {mode: 0o600}); } catch (_) {}
}

/* ---------- prompt rendering ---------- */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part && part.type === 'text' ? String(part.text || '') : '').join('');
  return content == null ? '' : String(content);
}
export function render(messages) {
  const system = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => textOf(m.content)).filter(Boolean).join('\n\n');
  const turns = messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({role: m.role, text: textOf(m.content)}));
  let transcript;
  if (turns.length === 1 && turns[0].role === 'user') transcript = turns[0].text;
  else {
    transcript = turns.map(t => `[${t.role === 'user' ? 'User' : 'Assistant'}]\n${t.text}`).join('\n\n')
      + '\n\n[Reply as the Assistant to the last User turn above. Write only the reply.]';
  }
  return {system, transcript};
}
export function route(model) {
  const m = String(model || '').trim().toLowerCase();
  if (/^(chatgpt|codex|gpt|o\d)/.test(m)) return {provider: 'codex', claudeModel: null};
  if (/^(sonnet|opus|haiku|fable)$/.test(m) || /^claude-[a-z0-9.-]+$/.test(m)) return {provider: 'claude', claudeModel: m};
  return {provider: 'claude', claudeModel: 'sonnet'};                           // 'claude', '', anything else
}

/* ---------- queue: at most MAX_CONCURRENT CLI processes ---------- */
let running = 0;
const waiting = [];
function acquire(ticket) {
  return new Promise((resolve, reject) => {
    if (running < MAX_CONCURRENT) { running++; resolve(); return; }
    if (waiting.length >= MAX_QUEUE) { reject(Object.assign(new Error('busy'), {status: 503})); return; }
    const entry = {resolve, reject, ticket};
    waiting.push(entry);
    ticket.onAbort(() => { const i = waiting.indexOf(entry); if (i >= 0) { waiting.splice(i, 1); reject(Object.assign(new Error('aborted'), {status: 499})); } });
  });
}
function release() {
  const next = waiting.shift();
  if (next) next.resolve(); else running--;
}

/* ---------- child process with an inactivity timer ---------- */
/* The account, not a key or a parent session: drop anything that would make the
   CLI use an API key, think it runs inside another agent, or load its plugins. */
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PLUGIN|CLAUDE_AGENT|ANTHROPIC_|OPENAI_API_KEY|CODEX_COMPANION|MCP_)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}
function runChild(bin, args, {stdin, ticket, onStdout, env}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(bin, args, {cwd: WORK, stdio: ['pipe', 'pipe', 'pipe'], env: {...cleanEnv(), ...env}});
    } catch (error) { resolve({code: -1, spawnError: String(error && error.code || error), stderr: ''}); return; }
    let stderr = '', done = false, quiet = null, killedFor = null;
    const kill = reason => {
      if (done) return; killedFor = killedFor || reason;
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { if (!done) child.kill('SIGKILL'); } catch (_) {} }, 3000).unref();
    };
    const arm = () => { clearTimeout(quiet); quiet = setTimeout(() => kill('timeout'), QUIET_MS); };
    arm();
    const off = ticket.onAbort(() => kill('client'));
    child.stdout.on('data', chunk => { arm(); onStdout && onStdout(chunk); });
    child.stderr.on('data', chunk => { arm(); if (stderr.length < 20000) stderr += chunk; });   // kept in memory for classification only
    child.on('error', error => { if (!done) { done = true; clearTimeout(quiet); off(); resolve({code: -1, spawnError: String(error && error.code || error), stderr}); } });
    child.on('close', (code, signal) => { if (done) return; done = true; clearTimeout(quiet); off(); resolve({code, signal, killedFor, stderr}); });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

const LIMIT_RE = /usage limit|rate[ _-]?limit|limit reached|too many requests|\b429\b|quota|overloaded|out of (?:credits|extra usage)/i;
const AUTH_RE = /not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|oauth|log ?in again|\b401\b/i;
function classify(text) {
  if (LIMIT_RE.test(text)) return 'limit';
  if (AUTH_RE.test(text)) return 'auth';
  return 'error';
}

/* Claude: streamed text deltas. Resolves {ok, text, reason}. onText(piece) for each delta. */
async function runClaude({system, transcript, claudeModel, ticket, onText}) {
  if (!BIN.claude) return {ok: false, reason: 'missing', text: ''};
  let sysFile = null;
  const args = ['-p', '--model', claudeModel || 'sonnet',
    '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--tools', '', '--setting-sources', '', '--settings', '{"autoMemoryEnabled":false}',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--no-session-persistence',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
  if (system) {
    sysFile = path.join(os.tmpdir(), `scb-sys-${process.pid}-${crypto.randomBytes(6).toString('hex')}.txt`);
    fs.writeFileSync(sysFile, system, {mode: 0o600});
    args.push('--system-prompt-file', sysFile);
  }
  let text = '', buffer = '', failure = null, finalText = '';
  const handle = line => {
    if (!line.trim()) return;
    let event; try { event = JSON.parse(line); } catch (_) { return; }
    if (event.type === 'stream_event') {
      const e = event.event;
      if (e && e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && e.delta.text) { text += e.delta.text; onText(e.delta.text); }
    } else if (event.type === 'assistant' && event.error) {
      failure = failure || classify(String(event.error));
    } else if (event.type === 'rate_limit_event' && event.rate_limit_info && event.rate_limit_info.status === 'rejected') {
      failure = failure || 'limit';
    } else if (event.type === 'result') {
      if (event.is_error || (event.subtype && event.subtype !== 'success')) failure = failure || classify(String(event.result || '') + ' ' + String(event.api_error_status || '') + ' ' + String(event.subtype || ''));
      else if (typeof event.result === 'string') finalText = event.result;
    }
  };
  try {
    const result = await runChild(BIN.claude, args, {stdin: transcript, ticket, onStdout: chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) handle(line);
    }});
    if (buffer) handle(buffer);
    // Partial messages were off or lost: the whole answer is in the result line.
    if (!text && finalText && !failure) { text = finalText; onText(finalText); }
    if (result.killedFor) return {ok: false, reason: result.killedFor, text};
    if (result.spawnError) return {ok: false, reason: 'missing', text};
    if (failure) return {ok: false, reason: failure, text};
    if (result.code !== 0) return {ok: false, reason: classify(result.stderr) === 'error' ? 'exit' + result.code : classify(result.stderr), text};
    if (!text.trim()) return {ok: false, reason: 'empty', text};
    return {ok: true, text};
  } finally {
    if (sysFile) fs.rm(sysFile, {force: true}, () => {});
  }
}

/* Codex: one piece, read from the -o file. Tools are off and fail closed. */
const CODEX_OFF = ['shell_tool', 'unified_exec', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation',
  'multi_agent', 'plugins', 'view_image', 'hooks', 'in_app_browser', 'skill_mcp_dependency_install', 'tool_suggest', 'code_mode_host', 'goals', 'sleep_tool',
  'skill_search'];
async function runCodex({system, transcript, ticket}) {
  if (!BIN.codex) return {ok: false, reason: 'missing', text: ''};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scb-codex-'));
  const out = path.join(dir, 'answer.txt');
  const effort = /^(minimal|low|medium|high)$/.test(process.env.STYLE_CUSTOM_BRIDGE_CODEX_EFFORT || '') ? process.env.STYLE_CUSTOM_BRIDGE_CODEX_EFFORT : 'low';
  const args = ['exec', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--ephemeral',
    '-s', 'read-only', '--color', 'never', ...CODEX_OFF.flatMap(f => ['--disable', f]),
    '-c', 'skills.include_instructions=false', '-c', 'skills.bundled.enabled=false', '-c', 'web_search="disabled"', '-c', `model_reasoning_effort="${effort}"`, '-o', out, '-'];
  const prompt = (system ? `Follow these instructions:\n${system}\n\n---\n\n` : '')
    + transcript + '\n\n(Answer directly in plain text. Do not use any tools.)';
  try {
    const result = await runChild(BIN.codex, args, {stdin: prompt, ticket});
    let text = '';
    try { text = fs.readFileSync(out, 'utf8'); } catch (_) {}
    if (result.killedFor) return {ok: false, reason: result.killedFor, text: ''};
    if (result.spawnError) return {ok: false, reason: 'missing', text: ''};
    if (result.code !== 0) return {ok: false, reason: classify(result.stderr) === 'error' ? 'exit' + result.code : classify(result.stderr), text: ''};
    if (!text.trim()) return {ok: false, reason: 'empty', text: ''};
    return {ok: true, text: text.trim()};
  } finally {
    fs.rm(dir, {recursive: true, force: true}, () => {});
  }
}

/* ---------- HTTP ---------- */
function sendJSON(res, status, body, headers = {}) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  const data = JSON.stringify(body);
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data), ...headers});
  res.end(data);
}
const fail = (res, status, message, type = 'invalid_request_error') => sendJSON(res, status, {error: {message, type}});

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
/* A web page always sends an http(s) Origin with a POST; Zotero's privileged
   requests send none (or "null"). Any web origin is refused outright, before the
   token is even looked at, and OPTIONS (CORS preflight) is never answered. */
function originKind(origin) {
  if (origin === undefined) return 'none';
  const o = String(origin).trim().toLowerCase();
  if (o === 'null') return 'null';
  if (/^(chrome|resource|moz-extension|zotero):/.test(o)) return 'app';
  return 'web';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), {status: 413})); req.destroy(); } else parts.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function ticketFor(res) {
  const handlers = new Set(); let aborted = false;
  res.on('close', () => { if (!res.writableFinished) { aborted = true; for (const h of [...handlers]) h(); } });
  return {
    get aborted() { return aborted; },
    onAbort(fn) { if (aborted) { fn(); return () => {}; } handlers.add(fn); return () => handlers.delete(fn); }
  };
}

const label = provider => provider === 'codex' ? 'chatgpt' : 'claude';

async function completions(req, res, config, started, meta) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (error) { meta.status = error.status || 400; return fail(res, meta.status, error.status === 413 ? 'Request body too large' : 'Body must be JSON'); }
  const messages = Array.isArray(body && body.messages) ? body.messages.filter(m => m && typeof m === 'object') : [];
  if (!messages.some(m => m.role === 'user')) { meta.status = 400; return fail(res, 400, 'messages must include a user message'); }
  const {system, transcript} = render(messages);
  meta.inChars = system.length + transcript.length;
  if (meta.inChars > MAX_PROMPT_CHARS) { meta.status = 413; return fail(res, 413, 'Prompt too long'); }
  const stream = body.stream === true;
  const {provider: first, claudeModel} = route(body.model);
  meta.stream = stream; meta.model = first === 'codex' ? 'chatgpt' : claudeModel;

  const ticket = ticketFor(res);
  const id = 'chatcmpl-' + crypto.randomBytes(9).toString('base64url');
  const created = Math.floor(Date.now() / 1000);
  let headersOut = false, outChars = 0;
  const chunk = (provider, delta, finish = null) => `data: ${JSON.stringify({id, object: 'chat.completion.chunk', created, model: label(provider), choices: [{index: 0, delta, finish_reason: finish}]})}\n\n`;
  const openStream = provider => {
    if (headersOut) return; headersOut = true;
    res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'x-bridge-provider': provider, 'X-Accel-Buffering': 'no'});
    res.write(chunk(provider, {role: 'assistant'}));
  };

  try {
    try { await acquire(ticket); } catch (error) { meta.status = error.status; if (error.status === 503) fail(res, 503, 'Bridge is busy; try again shortly', 'server_busy'); return; }
    meta.queuedMs = Date.now() - started;
    try {
      let provider = first, result;
      const attempts = [];
      if (provider === 'claude') {
        result = await runClaude({system, transcript, claudeModel, ticket, onText: piece => {
          if (!meta.firstMs) meta.firstMs = Date.now() - started;
          outChars += piece.length;
          if (stream) { openStream('claude'); res.write(chunk('claude', {content: piece})); }
        }});
        attempts.push('claude:' + (result.ok ? 'ok' : result.reason));
        // Fall back only when nothing has reached the client yet and the client is still there.
        if (!result.ok && !headersOut && !ticket.aborted && BIN.codex && result.reason !== 'client') provider = 'codex';
      }
      if (provider === 'codex') {
        // Not opened before the answer exists, so a failure can still be a real HTTP error.
        result = await runCodex({system, transcript, ticket});
        attempts.push('codex:' + (result.ok ? 'ok' : result.reason));
        if (result.ok) {
          meta.firstMs = Date.now() - started; outChars = result.text.length;
          if (stream && !ticket.aborted) { openStream('codex'); res.write(chunk('codex', {content: result.text})); }
        }
      }
      meta.provider = provider; meta.attempts = attempts.join(',');
      if (ticket.aborted) { meta.status = 499; return; }
      if (stream) {
        if (!headersOut) {
          // Nothing was ever sent: a real HTTP error is still possible.
          meta.status = attempts.every(a => /limit/.test(a)) ? 429 : 502;
          return fail(res, meta.status, meta.status === 429 ? 'Usage limit reached on every account' : 'No account could answer', meta.status === 429 ? 'rate_limit' : 'upstream_error');
        }
        if (result.ok) { res.write(chunk(provider, {}, 'stop')); res.write('data: [DONE]\n\n'); meta.status = 200; }
        else { res.write(`data: ${JSON.stringify({error: {message: 'The answer stopped early', type: 'upstream_error'}})}\n\n`); meta.status = 206; }
        res.end();
        return;
      }
      if (!result.ok) {
        meta.status = attempts.every(a => /limit/.test(a)) ? 429 : 502;
        return fail(res, meta.status, meta.status === 429 ? 'Usage limit reached on every account' : 'No account could answer', meta.status === 429 ? 'rate_limit' : 'upstream_error');
      }
      meta.status = 200;
      sendJSON(res, 200, {id, object: 'chat.completion', created, model: label(provider),
        choices: [{index: 0, message: {role: 'assistant', content: result.text}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}}, {'x-bridge-provider': provider});
    } finally { release(); }
  } finally {
    meta.outChars = outChars;
  }
}

async function handle(req, res, config, started, meta) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || (/:\d+$/.test(host) && Number(host.split(':').pop()) !== config.port)) { meta.status = 403; return fail(res, 403, 'Host not allowed', 'forbidden'); }
  if (meta.origin === 'web') { meta.status = 403; return fail(res, 403, 'Browser requests are not allowed', 'forbidden'); }
  if (req.method === 'GET' && meta.path === '/health') { meta.status = 200; return sendJSON(res, 200, {ok: true, providers: providers()}); }
  const auth = String(req.headers.authorization || '');
  const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!given || !safeEqual(given, config.token)) { meta.status = 401; return fail(res, 401, 'Missing or wrong bearer token', 'authentication_error'); }
  if (req.method === 'GET' && meta.path === '/v1/models') {
    meta.status = 200;
    const data = [];
    if (BIN.claude) data.push(...['claude', 'sonnet', 'opus', 'haiku'].map(id => ({id, object: 'model', owned_by: 'claude-account'})));
    if (BIN.codex) data.push({id: 'chatgpt', object: 'model', owned_by: 'chatgpt-account'});
    return sendJSON(res, 200, {object: 'list', data});
  }
  if (req.method === 'POST' && meta.path === '/v1/chat/completions') return completions(req, res, config, started, meta);
  meta.status = 404; fail(res, 404, 'Not found', 'not_found');
}

function createServer(config) {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const meta = {method: req.method, path: (req.url || '').split('?')[0].slice(0, 40), origin: originKind(req.headers.origin)};
    try { await handle(req, res, config, started, meta); }
    catch (_) { meta.status = 500; fail(res, 500, 'Bridge error', 'server_error'); }
    finally {
      if (meta.status === undefined) meta.status = res.headersSent ? res.statusCode : 499;
      if (!(meta.path === '/health' && meta.status === 200)) log({...meta, ms: Date.now() - started});   // probes stay out of the log
    }
  });
}

function main() {
  rotateLog();
  const config = loadConfig();
  const server = createServer(config);
  server.requestTimeout = 0;          // long answers; the per-child inactivity timer is the limit
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.on('error', error => { log({event: 'listen-error', code: error.code, port: config.port}); process.exitCode = 1; setTimeout(() => process.exit(1), 2000); });
  server.listen(config.port, '127.0.0.1', () => log({event: 'start', version: VERSION, port: config.port, providers: providers().join('+') || 'none', node: process.version}));
  const stop = () => { server.close(); setTimeout(() => process.exit(0), 500).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch (_) { return false; } })();
if (isMain) main();
