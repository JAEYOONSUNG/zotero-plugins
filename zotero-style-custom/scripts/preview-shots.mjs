// Screenshots of the offline design preview, one PNG per panel tab, from a
// headless Chrome that never shows a window. For reviewing layout changes
// without the user's Zotero.
//
//   node scripts/preview-shots.mjs <outdir> <prefix> [light|dark] [W] [H] [tab,tab|all]
//   PREVIEW_PAGE=file:///…/design-preview.html overrides the page.
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const [outdir, prefix, scheme = 'light', W = '1180', H = '900', tabsArg = 'explore'] = process.argv.slice(2);
if (!outdir || !prefix) { console.error('usage: node scripts/preview-shots.mjs <outdir> <prefix> [light|dark] [W] [H] [tabs|all]'); process.exit(2); }
const page = process.env.PREVIEW_PAGE || new URL('../docs/design-preview.html', import.meta.url).href;
const chromePath = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(outdir, {recursive: true});
const profile = mkdtempSync(join(tmpdir(), 'preview-shots-'));
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--window-size=${W},${H}`, 'about:blank'], {stdio: 'ignore'});
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('headless Chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, {once: true}));
  let seq = 0; const waiting = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({id, method, params})); });
  await send('Emulation.setDeviceMetricsOverride', {width: Number(W), height: Number(H), deviceScaleFactor: 1, mobile: false});
  await send('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: scheme}]});
  await send('Page.enable');
  await send('Page.navigate', {url: page});
  await sleep(1500);
  const tabs = tabsArg === 'all'
    ? JSON.parse((await send('Runtime.evaluate', {expression: 'JSON.stringify([...document.querySelectorAll("[data-tab]")].map(b=>b.dataset.tab))', returnByValue: true})).result.result.value)
    : tabsArg.split(',');
  for (const tab of tabs) {
    await send('Runtime.evaluate', {expression: `document.querySelector('[data-tab="${tab}"]')?.click()`});
    await sleep(700);
    const shot = await send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(outdir, `${prefix}-${tab}.png`), Buffer.from(shot.result.data, 'base64'));
    console.log(tab);
  }
  ws.close();
} finally { chrome.kill(); }
