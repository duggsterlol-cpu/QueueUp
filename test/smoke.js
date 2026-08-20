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
let helixCalls = 0;

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
  if (u.includes('helix/users')) {
    helixCalls++;
    const logins = [...new URL(u).searchParams.getAll('login')];
    // 'ghostuser' deliberately does not exist, so Twitch omits it.
    return json({
      data: logins.filter(l => l !== 'ghostuser').map(l => ({
        login: l, display_name: l,
        profile_image_url: `https://static-cdn.jtvnw.net/jtv_user_pictures/${l}-profile_image-300x300.png`
      }))
    });
  }
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

  console.log('\n[profile pictures]');
  tokenClaimed = false;                  // let the stub mint a fresh session
  await call('twitch:login');            // avatars need an authenticated session
  await call('queue:add', 'alpha');
  await call('queue:add', 'bravo');
  await call('queue:add', 'ghostuser');  // no such Twitch account
  await new Promise(r => setTimeout(r, 500));

  st = await call('app:state');
  const byName = Object.fromEntries(st.queue.map(e => [e.login, e]));
  ok('real users get a profile picture',
    !!byName.alpha && /jtv_user_pictures/.test(byName.alpha.avatar || ''),
    byName.alpha ? String(byName.alpha.avatar) : 'alpha missing');
  ok('every real user is filled in', !!(byName.bravo && byName.bravo.avatar));
  ok('a nonexistent account stays on the fallback', !!byName.ghostuser && !byName.ghostuser.avatar);

  const callsAfterFirst = helixCalls;
  await call('queue:add', 'alpha2');
  await new Promise(r => setTimeout(r, 500));
  ok('lookups are batched, not one per player',
    helixCalls - callsAfterFirst <= 1, `${helixCalls - callsAfterFirst} calls`);

  const beforeCached = helixCalls;
  await call('queue:remove', byName.bravo.id);
  await call('queue:add', 'bravo');
  await new Promise(r => setTimeout(r, 500));
  ok('a returning viewer is served from cache',
    helixCalls === beforeCached, `${helixCalls - beforeCached} extra calls`);

  ok('the cache is written to disk', fs.existsSync(path.join(USER_DATA, 'avatars.json')));

  // Pictures used to be stripped whenever state was loaded from disk.
  const { Store } = require(path.join(ROOT, 'electron', 'state.js'));
  const reloaded = new Store(path.join(USER_DATA, 'queueup-state.json'));
  const persisted = reloaded.data.queue.find(e => e.login === 'alpha');
  ok('pictures survive a restart', !!(persisted && persisted.avatar),
    persisted ? String(persisted.avatar) : 'entry missing after reload');

  console.log('\n[persistence]');
  const stateFile = path.join(USER_DATA, 'queueup-state.json');
  const { Store: StoreCls } = require(path.join(ROOT, 'electron', 'state.js'));

  // The exact case that lost players: change something, then quit inside the
  // 250ms debounce window.
  const quick = new StoreCls(path.join(USER_DATA, 'quit-race.json'));
  quick.addUser({ login: 'lastsecond', display: 'lastsecond' });
  quick.flush();
  const afterQuit = new StoreCls(path.join(USER_DATA, 'quit-race.json'));
  ok('a player added right before quitting is kept',
    afterQuit.data.queue.some(e => e.login === 'lastsecond'));

  st = await call('app:state');
  const liveCount = st.queue.length + st.party.length;
  ok('there are players to preserve', liveCount > 0, String(liveCount));

  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  ok('the live queue is on disk', (onDisk.queue.length + onDisk.party.length) === liveCount,
    `disk ${onDisk.queue.length + onDisk.party.length} vs live ${liveCount}`);

  const restarted = new StoreCls(stateFile);
  ok('a restart restores every player',
    restarted.data.queue.length + restarted.data.party.length === liveCount);
  ok('wait timers resume rather than reset',
    restarted.data.queue.every(e => typeof e.joinedAt === 'number' && e.joinedAt > 0));

  // A torn write must not look like an empty queue.
  const corrupt = path.join(USER_DATA, 'corrupt.json');
  fs.writeFileSync(corrupt, '{ "queue": [ {"login":"hal');
  const recovered = new StoreCls(corrupt);
  ok('a damaged file is set aside, not overwritten', fs.existsSync(corrupt + '.corrupt'));
  ok('the app still starts after a damaged file', Array.isArray(recovered.data.queue));

  // Only an explicit clear empties it.
  await call('queue:clear', 'all');
  await new Promise(r => setTimeout(r, 350));
  const cleared = new StoreCls(stateFile);
  ok('clearing on purpose does empty it',
    cleared.data.queue.length === 0 && cleared.data.party.length === 0);

  console.log('\n[overlay http]');
  await call('queue:add', 'alpha');   // repopulate so the payload has something to carry
  await new Promise(r => setTimeout(r, 400));
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
  const apiJson = JSON.parse(api.body);
  ok('overlay state api serves json', api.status === 200 && apiJson.overlay.title === 'UP NEXT');
  ok('overlay payload carries the pictures',
    apiJson.queue.some(e => /jtv_user_pictures/.test(e.avatar || '')));
  const done = await get('/auth/done');
  ok('auth return page serves', done.status === 200 && done.body.includes('connected'));

  console.log(`\n${failures ? 'FAILED' : 'OK'} — ${checks - failures}/${checks} checks passed\n`);
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) {}
  process.exit(failures ? 1 : 0);
})().catch(err => {
  console.error('\nSMOKE TEST CRASHED:\n', err);
  process.exit(1);
});
