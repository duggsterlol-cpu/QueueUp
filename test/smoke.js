'use strict';
/**
 * Boots the real main process against a stubbed Electron and a stubbed network,
 * then drives the flows a user actually hits.
 *
 * This exists because 1.2.0 and 1.2.1 shipped with `connectChat` and
 * `storeCredentials` referenced but not defined. Syntax checks passed and the
 * HTTP server came up fine, because the crash only happens once those code
 * paths run. So: run them.
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'queueup-smoke-'));

let failures = 0;
let checks = 0;
function ok(label, cond, detail) {
  checks++;
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

/* ------------------------------------------------------------------ */
/* stub electron                                                       */
/* ------------------------------------------------------------------ */

const ipcHandlers = new Map();
const ipcListeners = new Map();
const sent = [];
const opened = [];
let readyCb = null;

const electronStub = {
  app: {
    isPackaged: false,
    getPath: () => USER_DATA,
    getVersion: () => '0.0.0-smoke',
    getAppPath: () => ROOT,
    disableHardwareAcceleration() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: cb => { readyCb = cb; return Promise.resolve(); } }),
    on() {},
    quit() {}
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = { send: (ch, payload) => sent.push({ ch, payload }), on() {}, setWindowOpenHandler() {}, toggleDevTools() {} };
      BrowserWindowStub.instances.push(this);
    }
    loadFile() {}
    once(ev, cb) { if (ev === 'ready-to-show') setImmediate(cb); }
    on() {}
    show() {}
    isDestroyed() { return false; }
    isMinimized() { return false; }
    minimize() {} maximize() {} unmaximize() {} isMaximized() { return false; } restore() {} focus() {} close() {}
    static getAllWindows() { return BrowserWindowStub.instances; }
  },
  ipcMain: {
    handle: (ch, fn) => ipcHandlers.set(ch, fn),
    on: (ch, fn) => ipcListeners.set(ch, fn)
  },
  shell: { openExternal: url => { opened.push(url); return Promise.resolve(); } },
  clipboard: { writeText() {} },
  dialog: { showMessageBox: async () => ({ response: 0 }) }
};
const BrowserWindowStub = electronStub.BrowserWindow;
BrowserWindowStub.instances = [];
electronStub.BrowserWindow.getAllWindows = () => BrowserWindowStub.instances;

// electron-updater must never touch the network here.
const updaterStub = {
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: false, logger: null,
    on() {}, checkForUpdates: async () => null, quitAndInstall() {}
  }
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  if (request === 'electron-updater') return updaterStub;
  return realLoad.apply(this, arguments);
};

/* ------------------------------------------------------------------ */
/* stub the network                                                    */
/* ------------------------------------------------------------------ */

const FAKE_TOKEN = 'smoketoken1234567890';
let tokenClaimed = false;
const requests = [];

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  requests.push(u);
  const json = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });

  if (u.includes('/api/create/')) {
    return json({ success: true, id: 'smokeid', message: 'https://twitchtokengenerator.com/api/smokeid' });
  }
  if (u.includes('/api/status/')) {
    if (!tokenClaimed) {
      tokenClaimed = true;
      return json({
        success: true, id: 'smokeid', scopes: 'chat:read chat:edit',
        token: FAKE_TOKEN, refresh: 'smokerefresh',
        username: 'smokestreamer', user_id: '1', client_id: 'smokeclient'
      });
    }
    return json({ success: false, error: 4, message: 'expired' });
  }
  if (u.includes('id.twitch.tv/oauth2/validate')) {
    const auth = (opts.headers || {}).Authorization || '';
    if (!auth.includes(FAKE_TOKEN)) return { ok: false, status: 401, text: async () => '{}', json: async () => ({}) };
    return json({ login: 'smokestreamer', client_id: 'smokeclient', scopes: ['chat:read', 'chat:edit'] });
  }
  if (u.includes('helix/users')) return json({ data: [] });
  return json({});
};

/* ------------------------------------------------------------------ */

(async () => {
  console.log('\nQueueUp smoke test');
  console.log('  userData:', USER_DATA);

  console.log('\n[boot]');
  require(path.join(ROOT, 'electron', 'main.js'));
  ok('main.js loaded without throwing', true);
  ok('app.whenReady was hooked', typeof readyCb === 'function');

  await readyCb();
  await new Promise(r => setTimeout(r, 300));
  ok('a window was created', BrowserWindowStub.instances.length === 1);

  const required = [
    'app:state', 'queue:add', 'queue:remove', 'queue:move', 'queue:promote',
    'queue:fill', 'queue:next', 'settings:update', 'overlay:update',
    'twitch:login', 'twitch:cancelLogin', 'twitch:connect', 'twitch:disconnect',
    'twitch:logout', 'update:check', 'update:install'
  ];
  const missing = required.filter(c => !ipcHandlers.has(c));
  ok('every IPC channel is registered', missing.length === 0, 'missing: ' + missing.join(', '));

  const call = (ch, arg) => ipcHandlers.get(ch)({}, arg);

  console.log('\n[queue]');
  const state0 = await call('app:state');
  ok('app:state responds', !!state0 && Array.isArray(state0.queue));
  ok('overlay server got a port', typeof state0.port === 'number', String(state0.port));

  await call('queue:add', 'alpha');
  await call('queue:add', 'bravo');
  await call('queue:add', 'charlie');
  let st = await call('app:state');
  ok('three players queued', st.queue.length === 3, `got ${st.queue.length}`);

  await call('queue:promote', st.queue[0].id);
  st = await call('app:state');
  ok('promote moves into the party', st.party.length === 1 && st.queue.length === 2);

  await call('queue:move', { id: st.party[0].id, list: 'queue', index: 0 });
  st = await call('app:state');
  ok('move sends them back to the queue', st.party.length === 0 && st.queue.length === 3);

  const moved = await call('queue:fill');
  st = await call('app:state');
  ok('fill party pulls players up', moved === 3 && st.party.length === 3, `moved ${moved}, party ${st.party.length}`);

  await call('queue:next');
  st = await call('app:state');
  ok('next game empties the party', st.party.length === 0);

  await call('queue:clear', 'all');

  console.log('\n[twitch login]  <-- the path that crashed in 1.2.0/1.2.1');
  const res = await call('twitch:login');
  ok('login resolved without throwing', !!res);
  ok('login succeeded', res.ok === true, JSON.stringify(res));
  ok('it authenticated the right account', res.login === 'smokestreamer', String(res.login));
  ok('browser was opened at the auth url', opened.some(u => u.includes('twitchtokengenerator.com')));

  st = await call('app:state');
  ok('token was stored', st.settings.accessToken === FAKE_TOKEN);
  ok('refresh token was stored', st.settings.refreshToken === 'smokerefresh');
  ok('channel was adopted from the login', st.settings.channel === 'smokestreamer', st.settings.channel);
  ok('chat replies were enabled', st.settings.botReplies === true);
  ok('a redirect url was sent to the service', requests.some(u => u.includes('/api/create/') && u.split('/').length > 7));

  console.log('\n[chat connect]');
  const conn = await call('twitch:connect');
  ok('connectChat is defined and runs', !!conn && typeof conn.status === 'string', JSON.stringify(conn));
  await call('twitch:disconnect');

  console.log('\n[logout]');
  await call('twitch:logout');
  st = await call('app:state');
  ok('logout clears the credentials', !st.settings.accessToken && !st.settings.refreshToken);

  console.log('\n[settings + overlay]');
  await call('settings:update', { partySize: 4, hostName: 'Streamer' });
  await call('overlay:update', { title: 'UP NEXT', maxRows: 7 });
  st = await call('app:state');
  ok('settings persist', st.settings.partySize === 4 && st.settings.hostName === 'Streamer');
  ok('overlay settings persist', st.overlay.title === 'UP NEXT' && st.overlay.maxRows === 7);

  console.log('\n[overlay http]');
  const base = `http://localhost:${state0.port}`;
  const realFetchNeeded = requests.length; // keep the stub, hit the server with http directly
  const http = require('http');
  const get = p => new Promise((resolve, reject) => {
    http.get(base + p, r => {
      let body = '';
      r.on('data', c => (body += c));
      r.on('end', () => resolve({ status: r.statusCode, body }));
    }).on('error', reject);
  });
  const overlay = await get('/overlay/');
  ok('overlay page serves', overlay.status === 200);
  const api = await get('/api/state');
  ok('overlay state api serves json', api.status === 200 && JSON.parse(api.body).overlay.title === 'UP NEXT');
  const done = await get('/auth/done');
  ok('auth return page serves', done.status === 200 && done.body.includes('connected'));

  console.log(`\n${failures ? 'FAILED' : 'OK'} — ${checks - failures}/${checks} checks passed\n`);
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  process.exit(failures ? 1 : 0);
})().catch(err => {
  console.error('\nSMOKE TEST CRASHED:\n', err);
  process.exit(1);
});
