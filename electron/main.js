'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require('electron');
const { Store, formatQueueMessage } = require('./state');
const { TwitchChat } = require('./twitch');
const { createServer } = require('./server');
const { createUpdater } = require('./updater');
const twitchApp = require('./twitch-app');

const isDev = !app.isPackaged;
let win = null;
let store = null;
let chat = null;
let server = null;
let updater = null;
const logs = [];
const avatarCache = new Map();

function pushLog(entry) {
  const item = { ts: Date.now(), type: entry.type || 'info', text: String(entry.text || '') };
  logs.push(item);
  if (logs.length > 300) logs.shift();
  send('log', item);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* --------------------------------------------------------------------- */
/* Window                                                                 */
/* --------------------------------------------------------------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: '#0a0c11',
    title: 'QueueUp',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'app', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => send('window:state', { maximized: true }));
  win.on('unmaximize', () => send('window:state', { maximized: false }));
  win.on('closed', () => { win = null; });

  // Anything that tries to open a new window goes to the real browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) win.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12') win.webContents.toggleDevTools();
  });
}

/* --------------------------------------------------------------------- */
/* Twitch avatars (optional - needs a Client ID + token)                  */
/* --------------------------------------------------------------------- */

async function fetchAvatars(logins) {
  const { accessToken, clientId } = store.data.settings;
  if (!accessToken || !clientId) return;
  const wanted = [...new Set(logins.map(l => l.toLowerCase()))]
    .filter(l => l && !avatarCache.has(l))
    .slice(0, 100);
  if (!wanted.length) return;

  try {
    const qs = wanted.map(l => 'login=' + encodeURIComponent(l)).join('&');
    const res = await fetch('https://api.twitch.tv/helix/users?' + qs, {
      headers: { 'Client-Id': clientId, Authorization: 'Bearer ' + accessToken }
    });
    if (!res.ok) return;
    const json = await res.json();
    for (const u of json.data || []) {
      avatarCache.set(u.login.toLowerCase(), u.profile_image_url);
    }
    let touched = false;
    for (const list of [store.data.party, store.data.queue]) {
      for (const e of list) {
        const url = avatarCache.get(e.login);
        if (url && e.avatar !== url) { e.avatar = url; touched = true; }
      }
    }
    if (touched) store.changed('avatars');
  } catch (_) { /* avatars are cosmetic - never block the queue on them */ }
}

function applyCachedAvatar(entry) {
  const url = avatarCache.get(entry.login);
  if (url) entry.avatar = url;
}

/* --------------------------------------------------------------------- */
/* Chat commands                                                          */
/* --------------------------------------------------------------------- */

function normCmd(s) {
  return String(s || '').trim().toLowerCase();
}

let lastListAt = 0;

function handleChatMessage(msg) {
  const s = store.data.settings;
  const text = msg.text.trim();
  const first = normCmd(text.split(/\s+/)[0]);
  if (!first.startsWith('!')) return;

  const join = normCmd(s.joinCommand) || '!join';
  const leave = normCmd(s.leaveCommand) || '!dequeue';
  const list = normCmd(s.listCommand) || '!queue';

  if (first === list) {
    // One post every 8s at most, so a spammed !queue can't flood chat.
    if (Date.now() - lastListAt < 8000) return;
    lastListAt = Date.now();
    if (!s.botReplies || !s.accessToken) {
      pushLog({ type: 'warn', text: `${msg.display} used ${list} — sign in with Twitch to let QueueUp post the list in chat.` });
      return;
    }
    reply(formatQueueMessage(store.data.queue, s.joinCommand));
    return;
  }

  if (first === join) {
    if (!s.queueOpen) {
      reply(`@${msg.display} the queue is closed right now.`);
      return;
    }
    const res = store.addUser(msg, { source: 'chat' });
    if (res.ok) {
      applyCachedAvatar(res.entry);
      fetchAvatars([msg.login]);
      pushLog({ type: 'join', text: `${msg.display} joined the queue (#${res.position})` });
      reply(`@${msg.display} you've been added to the queue — you're #${res.position}.`);
    } else if (res.reason === 'already') {
      reply(`@${msg.display} you're already in the queue at #${res.position}.`);
    } else if (res.reason === 'in_party') {
      reply(`@${msg.display} you're already in the party!`);
    }
    return;
  }

  if (first === leave) {
    const res = store.removeByLogin(msg.login);
    if (res.ok) {
      pushLog({ type: 'leave', text: `${msg.display} left the queue` });
      reply(`@${msg.display} you've been removed from the queue.`);
    } else {
      reply(`@${msg.display} you're not in the queue.`);
    }
  }
}

function reply(message) {
  if (!store.data.settings.botReplies) return;
  chat.say(message);
}

/* --------------------------------------------------------------------- */
/* Boot                                                                   */
/* --------------------------------------------------------------------- */

async function boot() {
  store = new Store(path.join(app.getPath('userData'), 'queueup-state.json'));
  chat = new TwitchChat();

  server = createServer({ store, onLog: pushLog });

  // Preferred port first, then the rest of the OAuth-registered ports.
  const wanted = Number(store.data.settings.port) || twitchApp.PREFERRED_PORTS[0];
  const candidates = [wanted, ...twitchApp.PREFERRED_PORTS.filter(p => p !== wanted)];
  try {
    await server.listen(candidates);
    pushLog({ type: 'info', text: `Overlay server running on http://localhost:${server.port}` });
  } catch (err) {
    pushLog({ type: 'error', text: 'Could not start the overlay server: ' + err.message });
  }

  store.on('change', reason => {
    server.pushState();
    send('state', { ...store.snapshot(), reason, port: server.port });
  });

  chat.on('message', handleChatMessage);
  chat.on('status', state => {
    send('twitch', state);
    if (state.status === 'connected') pushLog({ type: 'info', text: `Connected to #${state.channel}` });
    if (state.status === 'error') pushLog({ type: 'error', text: state.detail });
  });
  chat.on('log', pushLog);

  updater = createUpdater({
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    logDir: app.getPath('userData'),
    onLog: pushLog,
    onStatus: st => send('update', st)
  });

  createWindow();

  if (store.data.settings.autoConnect && store.data.settings.channel) {
    setTimeout(() => connectChat(), 900);
  }

  // Give the window a moment to settle before hitting the network.
  if (store.data.settings.autoUpdate !== false) {
    setTimeout(() => updater.check(false), 4000);
  }

  if (store.data.settings.accessToken) setTimeout(() => revalidateToken(), 1500);
}

/** Twitch tokens expire (~60 days). Catch that on launch rather than mid-stream. */
async function revalidateToken() {
  const token = store.data.settings.accessToken;
  if (!token) return;
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: 'OAuth ' + token }
    });
    if (res.ok) return;
    store.updateSettings({ accessToken: '', botReplies: false });
    pushLog({ type: 'warn', text: 'Your Twitch sign-in expired - sign in again to chat from your account.' });
    send('auth', { ok: false, reason: 'expired' });
  } catch (_) {
    // Offline: keep the token and try again next launch.
  }
}

function connectChat() {
  const s = store.data.settings;
  chat.connect({
    channel: s.channel,
    token: s.botReplies ? s.accessToken : '',
    username: s.botUsername || ''
  });
}

async function validateAndStoreToken(token) {
  let info;
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: 'OAuth ' + token }
    });
    if (!res.ok) {
      pushLog({ type: 'error', text: 'Twitch rejected that token.' });
      return { ok: false, reason: 'rejected' };
    }
    info = await res.json();
  } catch (err) {
    pushLog({ type: 'error', text: 'Could not reach Twitch: ' + err.message });
    return { ok: false, reason: 'offline' };
  }

  if (!twitchApp.hasChatScopes(info.scopes)) {
    pushLog({ type: 'error', text: 'That token has no chat permission.' });
    return { ok: false, reason: 'scopes' };
  }

  // Signing in tells us who they are, so the channel no longer has to be typed.
  store.updateSettings({
    accessToken: token,
    botUsername: info.login,
    clientId: info.client_id || '',
    channel: info.login,
    botReplies: true
  });
  pushLog({ type: 'info', text: `Signed in to Twitch as ${info.login}` });
  send('auth', { ok: true, login: info.login });
  connectChat();
  return { ok: true, login: info.login };
}

/* --------------------------------------------------------------------- */
/* IPC                                                                    */
/* --------------------------------------------------------------------- */

function fullState() {
  return {
    ...store.snapshot(),
    port: server ? server.port : null,
    version: app.getVersion(),
    auth: {
      signedIn: !!store.data.settings.accessToken,
      login: store.data.settings.botUsername || ''
    },
    update: updater ? updater.state : null,
    twitch: chat.state,
    overlayClients: server ? server.clientCount : 0
  };
}

ipcMain.handle('app:state', () => fullState());
ipcMain.handle('update:check', () => updater.check(true));
ipcMain.handle('update:install', () => updater.install());
ipcMain.handle('app:logs', () => logs);

ipcMain.handle('queue:add', (_e, name) => {
  const login = String(name || '').trim().replace(/^@/, '');
  if (!login) return { ok: false };
  const res = store.addUser({ login, display: login }, { source: 'manual' });
  if (res.ok) {
    applyCachedAvatar(res.entry);
    fetchAvatars([login.toLowerCase()]);
    pushLog({ type: 'join', text: `${login} added manually (#${res.position})` });
  }
  return res;
});

ipcMain.handle('queue:remove', (_e, id) => store.removeById(id));
ipcMain.handle('queue:move', (_e, { id, list, index }) => store.move(id, list, index));
ipcMain.handle('queue:promote', (_e, id) => store.promote(id));
ipcMain.handle('queue:toTop', (_e, id) => store.toTop(id));
ipcMain.handle('queue:clear', (_e, which) => store.clear(which));
ipcMain.handle('queue:fill', () => store.fillParty());
ipcMain.handle('queue:next', () => store.nextGame());

ipcMain.handle('settings:update', async (_e, patch) => {
  const prev = { ...store.data.settings };
  const next = store.updateSettings(patch);
  if (patch.port && Number(patch.port) !== Number(prev.port)) {
    pushLog({ type: 'warn', text: 'Port change takes effect after restarting QueueUp.' });
  }
  const reconnect =
    (patch.channel !== undefined && patch.channel !== prev.channel) ||
    (patch.botReplies !== undefined && patch.botReplies !== prev.botReplies);
  if (reconnect && next.channel && chat.status !== 'disconnected') connectChat();
  return next;
});

ipcMain.handle('overlay:update', (_e, patch) => store.updateOverlay(patch));
ipcMain.handle('overlay:reset', () => store.resetOverlay());

ipcMain.handle('twitch:connect', () => { connectChat(); return chat.state; });
ipcMain.handle('twitch:disconnect', () => { chat.disconnect(); return chat.state; });

ipcMain.handle('twitch:openTokenPage', () => {
  shell.openExternal(twitchApp.TOKEN_GENERATOR_URL);
  return { ok: true };
});

ipcMain.handle('twitch:setToken', async (_e, raw) => {
  if (!twitchApp.looksLikeToken(raw)) {
    return { ok: false, reason: 'malformed' };
  }
  return validateAndStoreToken(twitchApp.normalizeToken(raw));
});

ipcMain.handle('twitch:logout', () => {
  store.updateSettings({ accessToken: '', botUsername: '', botReplies: false });
  chat.disconnect();
  return { ok: true };
});

ipcMain.handle('util:copy', (_e, text) => { clipboard.writeText(String(text || '')); return true; });
ipcMain.handle('util:openExternal', (_e, url) => { shell.openExternal(String(url)); return true; });
ipcMain.handle('util:confirm', async (_e, { title, message, confirmLabel }) => {
  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: [confirmLabel || 'Confirm', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: title || 'Are you sure?',
    message: title || 'Are you sure?',
    detail: message || ''
  });
  return res.response === 0;
});

ipcMain.on('window:minimize', () => win && win.minimize());
ipcMain.on('window:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', () => win && win.close());

/* --------------------------------------------------------------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(boot);

  app.on('window-all-closed', () => {
    if (chat) chat.disconnect(true);
    if (server) server.close();
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
