/* ============================================================
   QueueUp — renderer
   ============================================================ */
'use strict';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const state = {
  party: [],
  queue: [],
  settings: {},
  overlay: {},
  twitch: { status: 'disconnected', channel: '' },
  port: null
};

const nodes = new Map();   // entry id -> row element
let dragging = null;
let previewLoaded = false;

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtWait(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

function avatarStyle(login) {
  const h = hashHue(login || 'x');
  return `linear-gradient(140deg, hsl(${h} 72% 58%), hsl(${(h + 42) % 360} 68% 44%))`;
}

function toast(text, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 240);
  }, 2600);
}

function svgIcon(paths) {
  return `<svg viewBox="0 0 24 24">${paths}</svg>`;
}

const ICON_UP = svgIcon('<path d="M12 19V5M5 12l7-7 7 7"/>');
const ICON_DOWN = svgIcon('<path d="M12 5v14M19 12l-7 7-7-7"/>');
const ICON_X = svgIcon('<path d="M18 6L6 18M6 6l12 12"/>');

/* ------------------------------------------------------------------ */
/* row rendering                                                      */
/* ------------------------------------------------------------------ */

function buildRow(entry, list) {
  const row = document.createElement('div');
  row.className = 'prow enter';
  row.dataset.id = entry.id;
  row.dataset.list = list;

  row.innerHTML = `
    <span class="rank"></span>
    <span class="avatar"></span>
    <span class="p-main">
      <span class="p-name"></span>
      <span class="p-meta"></span>
    </span>
    <span class="timer"></span>
    <span class="row-actions"></span>
  `;

  const actions = row.querySelector('.row-actions');

  const move = document.createElement('button');
  move.className = 'iconbtn up';
  move.title = list === 'queue' ? 'Move into party' : 'Send back to queue';
  move.innerHTML = list === 'queue' ? ICON_UP : ICON_DOWN;
  move.addEventListener('click', e => {
    e.stopPropagation();
    if (list === 'queue') window.hq.promote(entry.id);
    else window.hq.move(entry.id, 'queue', 0);
  });

  const rm = document.createElement('button');
  rm.className = 'iconbtn rm';
  rm.title = 'Remove';
  rm.innerHTML = ICON_X;
  rm.addEventListener('click', e => {
    e.stopPropagation();
    const el = nodes.get(entry.id);
    if (el) el.classList.add('leaving');
    window.hq.remove(entry.id);
  });

  actions.append(move, rm);
  row.addEventListener('pointerdown', onRowPointerDown);
  setTimeout(() => row.classList.remove('enter'), 400);
  return row;
}

function updateRow(row, entry, index, list) {
  row.dataset.list = list;
  row.querySelector('.rank').textContent = list === 'queue' ? index + 1 : index + 2;

  const av = row.querySelector('.avatar');
  if (entry.avatar) {
    if (av.dataset.src !== entry.avatar) {
      av.dataset.src = entry.avatar;
      av.style.background = 'none';
      av.innerHTML = `<img src="${entry.avatar}" alt="" />`;
    }
  } else if (!av.dataset.gen) {
    av.dataset.gen = '1';
    av.style.background = avatarStyle(entry.login);
    av.textContent = (entry.display || entry.login || '?').charAt(0).toUpperCase();
  }

  const name = row.querySelector('.p-name');
  const badges = [];
  if (entry.isSub) badges.push('<span class="badge badge-sub">SUB</span>');
  if (entry.isMod) badges.push('<span class="badge badge-mod">MOD</span>');
  if (entry.isVip) badges.push('<span class="badge badge-vip">VIP</span>');
  const wanted = escapeHtml(entry.display) + badges.join('');
  if (name.dataset.sig !== wanted) {
    name.dataset.sig = wanted;
    name.innerHTML = wanted;
  }

  const meta = row.querySelector('.p-meta');
  const metaText = list === 'party'
    ? 'In party'
    : (entry.source === 'manual' ? 'added by you' : 'joined from chat');
  if (meta.textContent !== metaText) meta.textContent = metaText;

  const timer = row.querySelector('.timer');
  timer.dataset.since = list === 'party' ? (entry.partySince || entry.joinedAt) : entry.joinedAt;
  timer.dataset.mode = list;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Keyed reconcile + FLIP so reordering animates instead of snapping. */
function renderList(container, entries, list, prevRects, aliveIds) {
  const seen = new Set();
  const ordered = [];

  entries.forEach((entry, i) => {
    let row = nodes.get(entry.id);
    if (!row || row.dataset.list !== list) {
      // A row that switched lists needs its action button re-pointed.
      if (row) row.remove();
      row = buildRow(entry, list);
      if (prevRects.has(entry.id)) row.classList.remove('enter');
      nodes.set(entry.id, row);
    }
    updateRow(row, entry, i, list);
    ordered.push(row);
    seen.add(entry.id);
  });

  // Rows that left this list: animate out if gone for good, otherwise let the
  // other list adopt them.
  for (const child of [...container.querySelectorAll('.prow')]) {
    const id = child.dataset.id;
    if (seen.has(id)) continue;
    if (aliveIds.has(id)) { child.remove(); continue; }
    if (nodes.get(id) === child) nodes.delete(id);
    child.style.position = 'absolute';
    child.style.width = child.offsetWidth + 'px';
    child.style.left = child.offsetLeft + 'px';
    child.style.top = child.offsetTop + 'px';
    child.classList.add('leaving');
    setTimeout(() => child.remove(), 220);
  }

  // Put the live rows in order at the front of the container.
  let anchor = null;
  for (const row of ordered) {
    const target = anchor ? anchor.nextSibling : container.firstChild;
    if (row !== target) container.insertBefore(row, target);
    anchor = row;
  }

  // Party slots that are still open.
  if (list === 'party') {
    container.querySelectorAll('.slot').forEach(s => s.remove());
    const cap = Math.max(1, Number(state.settings.partySize) || 3);
    for (let i = entries.length; i < cap; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.innerHTML = `<span class="slot-num">${i + 2}</span><span>Open slot — drag a player here</span>`;
      container.appendChild(slot);
    }
  }

  // FLIP
  for (const row of ordered) {
    const before = prevRects.get(row.dataset.id);
    if (!before) continue;
    const after = row.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    row.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 260, easing: 'cubic-bezier(.2,.8,.3,1)' }
    );
  }
}

function render() {
  // One snapshot up front so rows dragged between the two lists still FLIP.
  const prevRects = new Map();
  for (const el of document.querySelectorAll('.prow:not(.leaving)')) {
    prevRects.set(el.dataset.id, el.getBoundingClientRect());
  }
  const aliveIds = new Set([...state.party, ...state.queue].map(e => e.id));

  renderList($('#partyList'), state.party, 'party', prevRects, aliveIds);
  renderList($('#queueList'), state.queue, 'queue', prevRects, aliveIds);

  const cap = Math.max(1, Number(state.settings.partySize) || 3);
  $('#partyCount').textContent = `${state.party.length + 1}/${cap + 1}`;
  $('#queueCount').textContent =
    state.queue.length === 1 ? '1 waiting' : `${state.queue.length} waiting`;
  $('#queueEmpty').classList.toggle('show', state.queue.length === 0);
  $('#hostName').textContent = state.settings.hostName || 'You';
  $('#emptyCmd').textContent = state.settings.joinCommand || '!join';

  const join = state.settings.joinCommand || '!join';
  const leave = state.settings.leaveCommand || '!dequeue';
  $('#queueSubtitle').innerHTML =
    `Viewers join with <code>${escapeHtml(join)}</code> and leave with <code>${escapeHtml(leave)}</code>` +
    (state.settings.subsPriority ? ' · <code>subs skip the line</code>' : '');

  tickTimers();
}

/* ------------------------------------------------------------------ */
/* timers                                                             */
/* ------------------------------------------------------------------ */

function tickTimers() {
  const now = Date.now();
  for (const el of document.querySelectorAll('.timer')) {
    const since = Number(el.dataset.since);
    if (!since) continue;
    const ms = now - since;
    const text = fmtWait(ms);
    if (el.textContent !== text) el.textContent = text;
    if (el.dataset.mode === 'queue') {
      el.classList.toggle('warm', ms > 10 * 60000 && ms <= 25 * 60000);
      el.classList.toggle('hot', ms > 25 * 60000);
    }
  }
}
setInterval(tickTimers, 250);

/* ------------------------------------------------------------------ */
/* drag & drop                                                        */
/* ------------------------------------------------------------------ */

function onRowPointerDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest('.iconbtn')) return;
  const row = e.currentTarget;

  dragging = {
    id: row.dataset.id,
    row,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
    ghost: null,
    line: null,
    target: null,
    pointerId: e.pointerId
  };

  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
}

function onDragMove(e) {
  if (!dragging) return;
  const dx = e.clientX - dragging.startX;
  const dy = e.clientY - dragging.startY;

  if (!dragging.active) {
    if (Math.hypot(dx, dy) < 5) return;
    beginDrag(e);
  }

  const g = dragging.ghost;
  g.style.left = dragging.grabX + e.clientX + 'px';
  g.style.top = dragging.grabY + e.clientY + 'px';

  updateDropTarget(e.clientX, e.clientY);
}

function beginDrag(e) {
  dragging.active = true;
  const row = dragging.row;
  const rect = row.getBoundingClientRect();

  const ghost = row.cloneNode(true);
  ghost.className = 'prow drag-ghost';
  ghost.style.width = rect.width + 'px';
  ghost.style.left = rect.left + 'px';
  ghost.style.top = rect.top + 'px';
  document.body.appendChild(ghost);

  dragging.ghost = ghost;
  dragging.grabX = rect.left - e.clientX;
  dragging.grabY = rect.top - e.clientY;

  row.classList.add('ghost-src');

  const line = document.createElement('div');
  line.className = 'drop-line';
  dragging.line = line;
}

function listUnderPoint(x, y) {
  for (const id of ['#partyList', '#queueList']) {
    const el = $(id);
    const panel = el.closest('.panel');
    const r = panel.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
  }
  return null;
}

function updateDropTarget(x, y) {
  const container = listUnderPoint(x, y);

  $$('.droplist').forEach(l => l.classList.toggle('drop-active', l === container));

  if (!container) {
    if (dragging.line.parentNode) dragging.line.remove();
    dragging.target = null;
    return;
  }

  const rows = [...container.querySelectorAll('.prow')].filter(r => r !== dragging.row);
  let index = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) { index = i; break; }
  }

  dragging.target = { list: container.dataset.list, index };

  const ref = rows[index] || container.querySelector('.slot') || null;
  if (ref) container.insertBefore(dragging.line, ref);
  else container.appendChild(dragging.line);
}

function onDragEnd() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  if (!dragging) return;

  const d = dragging;
  dragging = null;

  $$('.droplist').forEach(l => l.classList.remove('drop-active'));
  if (d.line && d.line.parentNode) d.line.remove();
  if (d.ghost) d.ghost.remove();
  if (d.row) d.row.classList.remove('ghost-src');

  if (d.active && d.target) {
    const cap = Math.max(1, Number(state.settings.partySize) || 3);
    const fromList = d.row.dataset.list;
    if (d.target.list === 'party' && fromList !== 'party' && state.party.length >= cap) {
      toast('Party is full — the last member went back to the queue', 'info');
    }
    window.hq.move(d.id, d.target.list, d.target.index);
    d.row.classList.add('bump');
    setTimeout(() => d.row && d.row.classList.remove('bump'), 420);
  }
}

/* ------------------------------------------------------------------ */
/* activity log                                                       */
/* ------------------------------------------------------------------ */

function addLog(item) {
  const list = $('#logList');
  const empty = list.querySelector('.log-empty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = 'log-item ' + (item.type || 'info');
  const t = new Date(item.ts || Date.now());
  el.innerHTML = `<span class="log-time">${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}</span>
                  <span class="log-text"></span>`;
  el.querySelector('.log-text').textContent = item.text;
  list.prepend(el);

  while (list.children.length > 80) list.lastChild.remove();
}

function clearLog() {
  $('#logList').innerHTML = '<div class="log-empty">Nothing yet.</div>';
}

/* ------------------------------------------------------------------ */
/* connection status                                                  */
/* ------------------------------------------------------------------ */

function renderTwitch(t) {
  state.twitch = t || state.twitch;
  const { status, channel, detail, anonymous, username } = state.twitch;

  const map = {
    connected: { cls: 'on', text: `Live in #${channel}` },
    connecting: { cls: 'warn', text: detail || 'Connecting…' },
    error: { cls: 'err', text: detail || 'Connection error' },
    disconnected: { cls: '', text: 'Not connected' }
  };
  const s = map[status] || map.disconnected;

  for (const id of ['#dot', '#dot2', '#dot3']) {
    const d = $(id);
    d.className = 'dot' + (s.cls ? ' ' + s.cls : '');
  }
  $('#statusText').textContent = s.text;
  $('#sbTitle').textContent = s.text;
  $('#sbSub').textContent = status === 'connected'
    ? (anonymous ? 'Reading chat anonymously — no login needed.' : `Signed in as ${username}.`)
    : (status === 'error' ? detail : 'Sign in, or just enter a channel below to read chat.');

  $('#connChannel').textContent = channel ? '#' + channel : 'no channel';
  $('#connSub').textContent = status === 'connected'
    ? `Watching chat for ${state.settings.joinCommand || '!join'}`
    : 'Connect to start taking !join';

  const connected = status === 'connected' || status === 'connecting';
  $('#btnConnectSide').textContent = connected ? 'Disconnect' : 'Connect';
  $('#btnConnectSide').classList.toggle('btn-primary', !connected);
  $('#btnConnectSide').classList.toggle('btn-ghost', connected);
  $('#btnConnect').disabled = connected;
  $('#btnDisconnect').disabled = !connected;
}


/* ------------------------------------------------------------------ */
/* updates                                                            */
/* ------------------------------------------------------------------ */

function renderUpdate(u) {
  if (!u) return;
  state.update = u;

  const block = $('#updateBlock');
  const dot = $('#updDot');
  const text = $('#updText');
  const fill = $('#updFill');
  const notes = $('#updNotes');

  const map = {
    idle:        { cls: '',     t: 'Ready to check for updates.' },
    checking:    { cls: 'warn', t: 'Checking for updates…' },
    current:     { cls: 'on',   t: `You're on the latest version.` },
    downloading: { cls: 'warn', t: `Downloading ${u.newVersion || ''}… ${u.percent || 0}%` },
    ready:       { cls: 'on',   t: `Version ${u.newVersion} is ready to install.` },
    error:       { cls: 'err',  t: u.error || 'Update check failed.' },
    dev:         { cls: '',     t: 'Running from source — updates apply to the installed app.' }
  };
  const m = map[u.status] || map.idle;

  dot.className = 'dot' + (m.cls ? ' ' + m.cls : '');
  text.textContent = m.t;
  block.classList.toggle('busy', u.status === 'downloading');
  fill.style.width = (u.percent || 0) + '%';
  notes.textContent = u.status === 'ready' || u.status === 'downloading' ? (u.notes || '') : '';

  $('#btnInstallUpdate').style.display = u.status === 'ready' ? '' : 'none';
  $('#btnCheckUpdate').disabled = u.status === 'checking' || u.status === 'downloading';

  if (u.status === 'ready' && !renderUpdate._toasted) {
    renderUpdate._toasted = true;
    toast(`Update ${u.newVersion} ready — restart to install`, 'info');
  }
}

/* ------------------------------------------------------------------ */
/* settings binding                                                   */
/* ------------------------------------------------------------------ */

const SETTING_FIELDS = [
  ['#setChannel', 'channel', 'text'],
  ['#setAutoConnect', 'autoConnect', 'bool'],
  ['#setPartySize', 'partySize', 'int'],
  ['#setHostName', 'hostName', 'text'],
  ['#setJoinCmd', 'joinCommand', 'text'],
  ['#setLeaveCmd', 'leaveCommand', 'text'],
  ['#setListCmd', 'listCommand', 'text'],
  ['#setQueueOpen', 'queueOpen', 'bool'],
  ['#setSubsPriority', 'subsPriority', 'bool'],
  ['#setPort', 'port', 'int'],
  ['#setAutoUpdate', 'autoUpdate', 'bool'],
  ['#setBotReplies', 'botReplies', 'bool']
];

function fillSettings() {
  for (const [sel, key, type] of SETTING_FIELDS) {
    const el = $(sel);
    if (!el || el === document.activeElement) continue;
    if (type === 'bool') el.checked = !!state.settings[key];
    else el.value = state.settings[key] ?? '';
  }

  const signedIn = !!state.settings.accessToken;
  const login = state.settings.botUsername || '';

  $('#signedIn').hidden = !signedIn;
  $('#signedOut').hidden = signedIn;

  if (signedIn) {
    $('#acctName').textContent = login;
    const av = $('#acctAvatar');
    av.textContent = login.charAt(0).toUpperCase();
    av.style.background = avatarStyle(login);
  }

}

function wireSettings() {
  for (const [sel, key, type] of SETTING_FIELDS) {
    const el = $(sel);
    if (!el) continue;
    const evt = type === 'bool' ? 'change' : 'input';
    el.addEventListener(evt, debounce(() => {
      let value;
      if (type === 'bool') value = el.checked;
      else if (type === 'int') value = Math.max(1, parseInt(el.value, 10) || 1);
      else value = el.value.trim();
      if (key === 'channel') value = value.toLowerCase().replace(/^#/, '').replace(/^.*twitch\.tv\//, '');
      window.hq.updateSettings({ [key]: value });
    }, type === 'bool' ? 0 : 350));
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    if (!ms) return fn(...args);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------------------------------------------ */
/* overlay controls                                                   */
/* ------------------------------------------------------------------ */

const pushOverlay = debounce(patch => window.hq.updateOverlay(patch), 90);

function fillOverlayControls() {
  const ov = state.overlay;
  for (const el of $$('[data-ov]')) {
    const key = el.dataset.ov;
    if (el === document.activeElement && el.type === 'text') continue;
    if (el.type === 'checkbox') el.checked = !!ov[key];
    else el.value = ov[key];
  }
  for (const el of $$('[data-out]')) {
    const key = el.dataset.out;
    const v = ov[key];
    el.textContent = typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : v;
  }
  for (const seg of $$('.segmented')) {
    const key = seg.dataset.seg;
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.val === ov[key]));
  }

  $('#obsW').textContent = Math.round((ov.width + 40) * ov.scale);
  $('#obsH').textContent = Math.round(((ov.maxRows * (64 + ov.gap)) + (ov.showTitle ? 60 : 0) + 40) * ov.scale);
}

function wireOverlayControls() {
  for (const el of $$('[data-ov]')) {
    const key = el.dataset.ov;
    const evt = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      let value;
      if (el.type === 'checkbox') value = el.checked;
      else if (el.type === 'range') value = parseFloat(el.value);
      else value = el.value;
      state.overlay[key] = value;
      fillOverlayControls();
      pushOverlay({ [key]: value });
    });
  }

  for (const seg of $$('.segmented')) {
    const key = seg.dataset.seg;
    seg.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        state.overlay[key] = btn.dataset.val;
        fillOverlayControls();
        pushOverlay({ [key]: btn.dataset.val });
      });
    });
  }

  for (const btn of $$('.bgbtn')) {
    btn.addEventListener('click', () => {
      $$('.bgbtn').forEach(b => b.classList.toggle('active', b === btn));
      const stage = $('#previewStage');
      stage.className = 'preview-stage bg-' + btn.dataset.bg;
    });
  }
}

function overlayUrl() {
  return state.port ? `http://localhost:${state.port}/overlay/` : '';
}

function syncUrls() {
  const url = overlayUrl();
  $('#overlayUrl').textContent = url || 'starting server…';
  $('#setOverlayUrl').textContent = url || '—';
  if (url && !previewLoaded) {
    previewLoaded = true;
    $('#previewFrame').src = url + '?preview=1';
  }
}

/* ------------------------------------------------------------------ */
/* wiring                                                             */
/* ------------------------------------------------------------------ */

function switchView(name) {
  $$('.navitem').forEach(n => n.classList.toggle('active', n.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
}

function wire() {
  $$('.navitem').forEach(n => n.addEventListener('click', () => switchView(n.dataset.view)));

  $('#btnMin').addEventListener('click', () => window.hq.minimize());
  $('#btnMax').addEventListener('click', () => window.hq.maximize());
  $('#btnClose').addEventListener('click', () => window.hq.close());

  const addPlayer = async () => {
    const input = $('#addInput');
    const name = input.value.trim();
    if (!name) return;
    const res = await window.hq.addUser(name);
    if (res && res.ok) { input.value = ''; toast(`${name} added to the queue`); }
    else if (res && res.reason === 'already') toast(`${name} is already #${res.position}`, 'err');
    else if (res && res.reason === 'in_party') toast(`${name} is already in the party`, 'err');
    input.focus();
  };
  $('#btnAdd').addEventListener('click', addPlayer);
  $('#addInput').addEventListener('keydown', e => { if (e.key === 'Enter') addPlayer(); });

  $('#btnFill').addEventListener('click', async () => {
    const n = await window.hq.fillParty();
    toast(n ? `Pulled ${n} player${n > 1 ? 's' : ''} into the party` : 'Party is already full', n ? '' : 'info');
  });

  $('#btnNext').addEventListener('click', async () => {
    const n = await window.hq.nextGame();
    toast(n ? `New party — ${n} player${n > 1 ? 's' : ''} in` : 'Party cleared, queue is empty', 'info');
  });

  $('#btnClearQueue').addEventListener('click', async () => {
    if (!state.queue.length) return;
    const ok = await window.hq.confirm({
      title: 'Clear the whole queue?',
      message: `${state.queue.length} waiting player${state.queue.length > 1 ? 's' : ''} will be removed.`,
      confirmLabel: 'Clear queue'
    });
    if (ok) window.hq.clear('queue');
  });

  $('#btnClearLog').addEventListener('click', clearLog);

  // Settings buttons
  $('#btnConnect').addEventListener('click', () => window.hq.connect());
  $('#btnDisconnect').addEventListener('click', () => window.hq.disconnect());
  $('#btnConnectSide').addEventListener('click', () => {
    const connected = state.twitch.status === 'connected' || state.twitch.status === 'connecting';
    if (connected) return window.hq.disconnect();
    if (!state.settings.channel) {
      switchView('settings');
      toast('Add your channel name first', 'err');
      $('#setChannel').focus();
      return;
    }
    window.hq.connect();
  });

  $('#btnGetToken').addEventListener('click', () => {
    window.hq.openTokenPage();
    toast('Approve it in your browser, then paste the token below', 'info');
    setTimeout(() => $('#tokenInput').focus(), 600);
  });

  const saveToken = async () => {
    const input = $('#tokenInput');
    const raw = input.value.trim();
    if (!raw) { input.focus(); return; }

    const btn = $('#btnSaveToken');
    btn.disabled = true;
    btn.textContent = 'Checking…';

    const res = await window.hq.setToken(raw);

    btn.disabled = false;
    btn.textContent = 'Save';

    if (res.ok) {
      input.value = '';
      toast(`Signed in as ${res.login}`);
    } else {
      const why = {
        malformed: "That doesn't look like a token — copy the whole thing",
        rejected: 'Twitch rejected that token — try generating a new one',
        scopes: "That token can't send chat messages — generate a new one",
        offline: "Couldn't reach Twitch — check your connection"
      };
      toast(why[res.reason] || 'That token did not work', 'err');
      input.select();
    }
  };
  $('#btnSaveToken').addEventListener('click', saveToken);
  $('#tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') saveToken(); });
  $('#btnLogout').addEventListener('click', async () => {
    await window.hq.logout();
    toast('Signed out of Twitch', 'info');
  });

  const copyUrl = () => {
    const url = overlayUrl();
    if (!url) return toast('Server still starting…', 'err');
    window.hq.copy(url);
    toast('Browser source URL copied');
  };
  $('#btnCopyUrl').addEventListener('click', copyUrl);
  $('#btnCopyUrl2').addEventListener('click', copyUrl);
  $('#btnOpenOverlay').addEventListener('click', () => window.hq.openExternal(overlayUrl()));

  $('#btnResetOverlay').addEventListener('click', async () => {
    state.overlay = await window.hq.resetOverlay();
    fillOverlayControls();
    toast('Overlay style reset', 'info');
  });

  $('#btnCheckUpdate').addEventListener('click', async () => {
    renderUpdate({ ...(state.update || {}), status: 'checking' });
    const u = await window.hq.checkForUpdates();
    renderUpdate(u);
  });
  $('#btnInstallUpdate').addEventListener('click', () => window.hq.installUpdate());

  $('#btnClearParty').addEventListener('click', () => window.hq.clear('party'));
  $('#btnClearQueue2').addEventListener('click', () => window.hq.clear('queue'));
  $('#btnClearAll').addEventListener('click', async () => {
    const ok = await window.hq.confirm({
      title: 'Clear everything?',
      message: 'Both the party and the queue will be emptied.',
      confirmLabel: 'Clear everything'
    });
    if (ok) window.hq.clear('all');
  });

  $$('.ext, .ext-link').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    window.hq.openExternal(a.dataset.url);
  }));

  wireSettings();
  wireOverlayControls();

  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'k') { e.preventDefault(); switchView('queue'); $('#addInput').focus(); }
  });
}

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

function applyState(s) {
  Object.assign(state, s);
  render();
  fillSettings();
  fillOverlayControls();
  syncUrls();
  if (s.twitch) renderTwitch(s.twitch);
  if (s.version) $('#appVersion').textContent = 'v' + s.version;
  if (s.update) renderUpdate(s.update);
  if (typeof s.overlayClients === 'number') $('#setClients').textContent = s.overlayClients;
}

async function boot() {
  wire();
  clearLog();

  const initial = await window.hq.getState();
  applyState(initial);

  const logs = await window.hq.getLogs();
  logs.slice(-40).forEach(addLog);

  window.hq.onState(s => applyState(s));
  window.hq.onTwitch(t => renderTwitch(t));
  window.hq.onLog(item => addLog(item));
  window.hq.onAuth(a => {
    if (a.ok) toast(`Signed in as ${a.login}`);
    else if (a.reason === 'expired') toast('Twitch sign-in expired — sign in again', 'err');
  });
  window.hq.onUpdate(u => renderUpdate(u));
}

boot();
