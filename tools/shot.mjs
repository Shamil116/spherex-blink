// Drive the web tool in a headless browser and save a screenshot (used for testing and for the figures/ folder).
// No npm packages: talks to Chrome or Edge over the DevTools protocol.
//   node tools/shot.mjs <url> <out.png> [--wait "<js that becomes true>"] [--do "<js to run after waiting>"] [--settle 1500] [--timeout 240]
// This file was written with the help of an AI coding assistant (see README, "Use of AI").
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2), opt = (name, def) => { const k = args.indexOf(`--${name}`); return k < 0 ? def : args[k + 1]; };
const [url, out] = args;
const waitExpr = opt('wait', "document.getElementById('status').textContent.includes('loaded')");
const doExpr = opt('do', ''), settle = +opt('settle', 1500), timeout = +opt('timeout', 240), size = opt('size', '1500,1050');
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!exe) throw new Error('no Chrome or Edge found');
const port = 9300 + Math.floor(process.pid % 500);
const browser = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'shot-'))}`,
  `--window-size=${size}`, '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let target;
  for (let k = 0; k < 60 && !target; k++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(), logs = [];
  let id = 0;
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id) pending.get(d.id)?.(d);
    else if (d.method === 'Runtime.exceptionThrown') logs.push(`EXCEPTION ${d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text}`);
    else if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) logs.push(`${d.params.type}: ${d.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    else if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') logs.push(`log: ${d.params.entry.text} ${d.params.entry.url || ''}`);
  };
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url });
  const t0 = Date.now();
  for (;;) {
    await sleep(500);
    let ok = false;
    try { ok = await evaluate(`!!(${waitExpr})`); } catch { /* page still loading */ }
    if (ok) break;
    if (Date.now() - t0 > timeout * 1000) { console.log('TIMEOUT waiting for:', waitExpr); break; }
  }
  if (doExpr) console.log('do ->', JSON.stringify(await evaluate(doExpr)));
  await sleep(settle);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`saved ${out} after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  for (const sel of ['status', 'caption', 'pxinfo']) console.log(`${sel}:`, await evaluate(`document.getElementById('${sel}')?.textContent.trim().slice(0, 400)`));
  if (logs.length) console.log('console:\n  ' + [...new Set(logs)].slice(0, 15).join('\n  '));
  ws.close();
} finally {
  // on Windows kill() ends only the main browser process and leaves its children (hundreds of MB each run):
  // end the whole tree of the browser this script started
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
  else browser.kill();
}
process.exit(0);        // the half-closed DevTools socket can otherwise keep Node alive for minutes
