import { app, BrowserWindow, dialog, shell } from 'electron';
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const PORT = Number(process.env.AIOS_PORT ?? 4747);
const hubUrl = `http://127.0.0.1:${PORT}`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let hub = null; // child process, only set when this app started the hub itself
let hubOutput = '';
let win = null;
let quitting = false;

const hubReachable = () => new Promise(res => {
  const req = http.get(hubUrl, r => { r.resume(); res(r.statusCode === 200); });
  req.on('error', () => res(false));
  req.setTimeout(1000, () => { req.destroy(); res(false); });
});

function startHub() {
  // Same command as `npm start`, plus an IPC channel so the hub can be shut down cleanly (stops running agents).
  hub = spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  const collect = d => { hubOutput = (hubOutput + d).slice(-4000); };
  hub.stdout.on('data', collect);
  hub.stderr.on('data', collect);
  return new Promise((resolve, reject) => {
    hub.once('error', e => reject(new Error(`could not start "node": ${e.message}`)));
    hub.once('exit', code => { hub = null; reject(new Error(`hub exited with code ${code}\n\n${hubOutput}`)); });
    const deadline = Date.now() + 30000;
    const poll = async () => {
      if (await hubReachable()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`hub did not answer on ${hubUrl} within 30 s\n\n${hubOutput}`));
      setTimeout(poll, 250);
    };
    poll();
  });
}

function stopHub() {
  const child = hub;
  if (!child) return Promise.resolve();
  return new Promise(resolve => {
    const kill = () => execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolve()); // last resort, also takes agent processes down
    const timer = setTimeout(kill, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send('shutdown'); else kill();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#070d16', autoHideMenuBar: true, title: 'macii', icon: join(root, 'web', 'logo.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  // Only the hub itself may load in this window; everything else opens in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== hubUrl) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  win.on('closed', () => { win = null; });
  win.loadURL(hubUrl);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(async () => {
    try {
      if (!(await hubReachable())) await startHub(); // otherwise attach to an already running hub (start.cmd / npm start)
      createWindow();
    } catch (e) {
      dialog.showErrorBox('macii hub could not start', e.message);
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', e => {
    if (quitting || !hub) return;
    e.preventDefault();
    quitting = true;
    stopHub().then(() => app.quit());
  });
}
