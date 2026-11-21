'use strict';
// Lane Desk: see Tally usage in the menu bar, a window, or tabs, and start a session on any account.

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell, dialog, Notification } = require('electron');
const model = require('./lib/model');
const sources = require('./lib/sources');
const i18n = require('./lib/i18n');
const { t } = i18n;
// LANE_DESK_DEMO=1 draws made-up accounts instead of reading Tally (for screenshots).
const demo = process.env.LANE_DESK_DEMO === '1' ? require('./lib/demo') : null;

const RENDERER = path.join(__dirname, 'renderer', 'index.html');
const RENDERER_URL = pathToFileURL(RENDERER).href;
const REFRESH_MS = 30_000;
const POPOVER = { width: 420, height: 660 };

let tray = null; // kept global so garbage collection does not remove the menu bar item (Electron FAQ)
let popover = null;
let view = { providers: [], sessions: [], loading: true };
let lastFetch = 0;
let inflight = null;
const windows = new Set();
const resetScanner = new sources.ResetScanner();
let resetting = false; // one /limit-reset at a time
let lanes = {}; // real account folder → lane, from the last refresh
let homes = []; // Claude account folders, from the last refresh

const webPreferences = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  spellcheck: false,
};

async function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    const now = Date.now();
    const status = demo ? demo.status(now) : await sources.readStatus();
    homes = model.claudeHomes(status, sources.norm);
    lanes = model.laneTable(status, demo ? demo.config : sources.readConfig(), sources.norm);
    let sessions = [];
    try {
      sessions = demo ? demo.sessions(now) : await sources.readSessions(homes);
    } catch {
      sessions = []; // a broken session file must not stop the usage view
    }
    const resets = {};
    if (!demo) {
      // Scanning transcripts runs in the background. When it finds something new, draw once more.
      resetScanner.kick(homes).then((changed) => changed && setTimeout(refresh, 0), () => {});
      const records = resetScanner.snapshot();
      for (const h of homes) resets[h] = { flag: sources.readResetFlag(h), record: records[h] || null };
    }
    view = model.buildView({
      resets,
      status,
      lanes,
      sessions,
      norm: sources.norm,
      home: sources.HOME,
      now,
      history: demo ? demo.history(now) : sources.readHistory(),
    });
    view.fetchedAt = Date.now();
    view.strings = i18n.table();
    view.lang = i18n.getLang();
    lastFetch = Date.now();
    if (tray) tray.setTitle(model.trayTitle(view), { fontType: 'monospacedDigit' });
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('desk:view', view);
    return view;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function freshen() {
  if (Date.now() - lastFetch > 10_000) refresh();
}

function lockDown(win) {
  // Block navigation away from the app and new windows. https links go to the default browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== RENDERER_URL && !url.startsWith(`${RENDERER_URL}?`)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createPopover() {
  popover = new BrowserWindow({
    ...POPOVER,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    vibrancy: 'popover',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences,
  });
  lockDown(popover);
  popover.loadFile(RENDERER, { query: { mode: 'popover' } });
  popover.on('blur', () => {
    if (!popover.webContents.isDevToolsOpened()) popover.hide();
  });
}

function placePopover() {
  const b = tray.getBounds();
  const area = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const x = Math.round(Math.min(Math.max(b.x + b.width / 2 - POPOVER.width / 2, area.x + 8), area.x + area.width - POPOVER.width - 8));
  const y = Math.round(b.y + b.height + 4);
  popover.setPosition(x, y, false);
}

function togglePopover() {
  if (popover.isVisible()) {
    popover.hide();
    return;
  }
  placePopover();
  popover.show();
  popover.focus();
  freshen();
}

function createWindow({ tabOf = null, tab = 'usage' } = {}) {
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 560,
    minHeight: 420,
    title: 'Lane Desk',
    titleBarStyle: 'hiddenInset',
    tabbingIdentifier: 'lane-desk',
    show: false,
    webPreferences,
  });
  lockDown(win);
  win.loadFile(RENDERER, { query: { mode: 'window', tab } });
  win.once('ready-to-show', () => win.show());
  windows.add(win);
  win.on('closed', () => {
    windows.delete(win);
    if (windows.size === 0 && app.dock) app.dock.hide();
  });
  if (app.dock) app.dock.show();
  if (tabOf && !tabOf.isDestroyed()) tabOf.addTabbedWindow(win);
  freshen();
  return win;
}

function showWindow() {
  const first = [...windows].find((w) => !w.isDestroyed());
  if (first) {
    first.show();
    first.focus();
  } else {
    createWindow();
  }
  if (popover && popover.isVisible()) popover.hide();
}

function newTab() {
  const focused = BrowserWindow.getFocusedWindow();
  const host = focused && windows.has(focused) ? focused : [...windows][0] || null;
  createWindow({ tabOf: host, tab: 'sessions' });
}

function buildAppMenu() {
  const template = [
    {
      label: 'Lane Desk',
      submenu: [
        { label: t('menu.refresh'), accelerator: 'Cmd+R', click: () => refresh() },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hide') },
        { role: 'quit', label: t('menu.quit') },
      ],
    },
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.newWindow'), accelerator: 'Cmd+N', click: () => createWindow() },
        { label: t('menu.newTab'), accelerator: 'Cmd+T', click: () => newTab() },
        { role: 'close', label: t('menu.close') },
      ],
    },
    { role: 'editMenu', label: t('menu.edit') },
    { role: 'windowMenu', label: t('menu.window') },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: t('menu.openWindow'), click: () => showWindow() },
    { label: t('menu.refresh'), click: () => refresh() },
    { type: 'separator' },
    { label: t('menu.quit'), role: 'quit' },
  ]);
}

/** Accept IPC only from our own renderer file (Electron security checklist). */
function fromUs(event) {
  const url = event.senderFrame && event.senderFrame.url;
  return typeof url === 'string' && (url === RENDERER_URL || url.startsWith(`${RENDERER_URL}?`));
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromUs(event)) throw new Error(t('ipc.denied'));
    return fn(...args);
  });
}

function findAccount(id) {
  for (const p of view.providers || []) for (const a of p.accounts) if (a.id === id) return a;
  return null;
}

function registerIpc() {
  handle('desk:get', async () => (view.loading ? refresh() : view));
  handle('desk:refresh', () => refresh());
  handle('desk:open-window', async () => {
    showWindow();
    return true;
  });
  handle('desk:new-tab', async () => {
    newTab();
    return true;
  });
  handle('desk:new-session', async (id) => {
    const acc = findAccount(String(id));
    const lane = acc && acc.home ? lanes[acc.home] : null;
    if (!lane) return { ok: false, message: t('main.noLane') };
    const r = await sources.openLane(lane);
    setTimeout(refresh, 3000);
    return r;
  });
  handle('desk:attach', async (pid) => {
    const s = (view.sessions || []).find((x) => x.pid === Number(pid));
    if (!s || !s.tmux) return { ok: false, message: t('main.notTmux') };
    return sources.attachInIterm(s.tmux);
  });
  ipcMain.handle('desk:limit-reset', async (event, pid) => {
    if (!fromUs(event)) throw new Error(t('ipc.denied'));
    if (resetting) return { ok: false, message: t('main.resetBusy') };
    resetting = true;
    try {
      const r = await limitReset(Number(pid), BrowserWindow.fromWebContents(event.sender));
      setTimeout(refresh, 500);
      return r;
    } finally {
      resetting = false;
    }
  });
}

function when(ms) {
  return new Date(ms).toLocaleString(i18n.getLang() === 'ko' ? 'ko-KR' : 'en-US');
}
const next = (s) => (s.nextAt ? t('main.nextReset', { when: when(s.nextAt) }) : '');
const RESET_ANSWER = {
  reset: (s) => ({ ok: true, message: t('answer.reset', { next: next(s) }) }),
  alreadyUsed: (s) => ({ ok: false, message: t('answer.alreadyUsed', { next: next(s) }) }),
  unavailable: () => ({ ok: false, message: t('answer.unavailable') }),
  loginRequired: () => ({ ok: false, message: t('answer.loginRequired') }),
  transient: () => ({ ok: false, message: t('answer.transient') }),
  inProgress: () => ({ ok: true, message: t('answer.inProgress') }),
  notEnabled: () => ({ ok: false, message: t('answer.notEnabled') }),
};

/**
 * Type /limit-reset into one session. The conditions are checked against session files and transcripts
 * read again now (not the drawn view), the user confirms, and the answer left in that transcript decides the result.
 */
async function limitReset(pid, parent) {
  if (demo) return { ok: false, message: t('main.demoNoReset') };
  await refresh(); // the view can be 30 seconds old; decide on fresh values
  const fresh = (await sources.readSessions(homes)).find((x) => x.pid === pid);
  if (!fresh) return { ok: false, message: t('main.resetGone') };
  if (!fresh.transcript) return { ok: false, message: t('main.resetNoTranscript') };
  const row = (view.sessions || []).find((x) => x.pid === pid);
  const acc = findAccountByHome(fresh.home);
  const gate = row && row.reset;
  if (fresh.wall !== 'session') return { ok: false, message: t('main.resetNoWall') };
  if (fresh.status !== 'idle') return { ok: false, message: t('main.resetNotIdle') };
  if (!gate || !gate.can) return { ok: false, message: (gate && gate.why) || t('main.resetUnchecked') };

  const opts = {
    type: 'warning',
    buttons: [t('main.resetButton'), t('main.cancel')],
    defaultId: 1,
    cancelId: 1,
    message: t('main.resetConfirm', { account: acc ? acc.label : t('main.thisAccount'), session: fresh.name || pid }),
    detail: t('main.resetDetail'),
  };
  const isWindow = parent && windows.has(parent);
  const { response } = isWindow ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  if (response !== 0) return { ok: true, message: t('main.resetCanceled') };

  // The session may have changed while the dialog was open. Look once more right before typing.
  const now = (await sources.readSessions(homes)).find((x) => x.pid === pid);
  if (!now || now.wall !== 'session' || now.status !== 'idle' || now.tmux !== fresh.tmux) {
    return { ok: false, message: t('main.resetChanged') };
  }
  const since = Date.now();
  const typed = await sources.typeLimitReset(fresh.tmux);
  if (!typed.ok) return typed;
  const answer = await sources.waitResetAnswer(fresh.transcript, since);
  const r = answer && RESET_ANSWER[answer.kind]
    ? RESET_ANSWER[answer.kind](answer)
    : { ok: false, message: t('main.resetTimeout') };
  if (!isWindow && Notification.isSupported()) new Notification({ title: t('main.resetNotifyTitle'), body: r.message }).show();
  return r;
}

function findAccountByHome(home) {
  for (const p of view.providers || []) for (const a of p.accounts) if (a.home === home) return a;
  return null;
}

/** LANE_DESK_CAPTURE=<folder>: render the popover, the window, and the sessions tab to PNG without showing them, then quit. */
async function capture(dir) {
  const fs = require('node:fs');
  fs.mkdirSync(dir, { recursive: true });
  await refresh();
  const shots = [
    { file: 'popover.png', mode: 'popover', tab: 'usage', ...POPOVER },
    { file: 'window-usage.png', mode: 'window', tab: 'usage', width: 980, height: 720 },
    { file: 'window-sessions.png', mode: 'window', tab: 'sessions', width: 980, height: 720 },
  ];
  for (const s of shots) {
    const w = new BrowserWindow({ width: s.width, height: s.height, show: false, webPreferences });
    await w.loadFile(RENDERER, { query: { mode: s.mode, tab: s.tab } });
    await new Promise((r) => setTimeout(r, 800));
    fs.writeFileSync(path.join(dir, s.file), (await w.webContents.capturePage()).toPNG());
    w.destroy();
  }
  app.quit();
}

// Stay in the menu bar when every window is closed. Without this, Electron quits with the last window.
app.on('window-all-closed', () => {});

function pickLanguage() {
  const env = process.env.LANE_DESK_LANG;
  const sys = (app.getPreferredSystemLanguages && app.getPreferredSystemLanguages()[0]) || app.getLocale();
  i18n.setLang(env === 'en' || env === 'ko' ? env : i18n.pick(sys));
}

if (process.env.LANE_DESK_CAPTURE) {
  app.whenReady().then(() => {
    pickLanguage();
    if (app.dock) app.dock.hide();
    registerIpc();
    capture(process.env.LANE_DESK_CAPTURE);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    pickLanguage();
    if (app.dock) app.dock.hide();
    buildAppMenu();
    registerIpc();
    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle('C… X…', { fontType: 'monospacedDigit' });
    tray.setToolTip('Lane Desk');
    tray.on('click', togglePopover);
    tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
    createPopover();
    refresh();
    setInterval(refresh, REFRESH_MS);
    if (process.argv.includes('--window')) createWindow();
  });
  app.on('activate', () => showWindow());
}
