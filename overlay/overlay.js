/* ============================================================
   QueueUp — overlay client
   Connects back to the app over a websocket and stays live.
   ============================================================ */
'use strict';

const rowsEl = document.getElementById('rows');
const titleEl = document.getElementById('otitle');
const countEl = document.getElementById('ocount');
const emptyTextEl = document.getElementById('oemptytext');

let queue = [];
let cfg = null;
const nodes = new Map();

/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || ''));
  if (!m) return '16, 18, 24';
  return `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}`;
}

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

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ */
/* config                                                             */
/* ------------------------------------------------------------------ */

function applyConfig(ov) {
  cfg = ov;
  const r = document.documentElement.style;
  r.setProperty('--accent', ov.accent);
  r.setProperty('--accent2', ov.accent2);
  r.setProperty('--text', ov.textColor);
  r.setProperty('--row-bg', hexToRgb(ov.rowBg));
  r.setProperty('--row-opacity', ov.rowOpacity);
  r.setProperty('--radius', ov.radius + 'px');
  r.setProperty('--gap', ov.gap + 'px');
  r.setProperty('--width', ov.width + 'px');
  r.setProperty('--scale', ov.scale);
  r.setProperty('--weight', ov.fontWeight);
  r.setProperty('--speed', ov.animSpeed || 1);
  r.setProperty('--font', `"${ov.fontFamily}", Inter, "Segoe UI", system-ui, sans-serif`);

  const b = document.body;
  b.classList.toggle('no-header', !ov.showTitle);
  b.classList.toggle('no-count', !ov.showHeaderCount);
  b.classList.toggle('no-rank', !ov.showRank);
  b.classList.toggle('no-avatar', !ov.showAvatar);
  b.classList.toggle('no-timer', !ov.showTimer);
  b.classList.toggle('no-shimmer', !ov.shimmer);
  b.classList.toggle('glow', !!ov.glow);
  b.classList.toggle('highlight', !!ov.highlightFirst);
  b.classList.toggle('dir-up', ov.direction === 'up');
  b.classList.toggle('align-right', ov.align === 'right');

  b.classList.remove('style-cards', 'style-bars', 'style-minimal');
  b.classList.add('style-' + (ov.style || 'cards'));

  titleEl.textContent = ov.title || '';
  emptyTextEl.textContent = ov.emptyText || '';
  render();
}

/* ------------------------------------------------------------------ */
/* rendering                                                          */
/* ------------------------------------------------------------------ */

function buildRow(entry) {
  const el = document.createElement('div');
  el.className = 'orow enter';
  el.dataset.id = entry.id;

  const hue = hashHue(entry.login || 'x');
  const avatar = entry.avatar
    ? `<span class="oav"><img src="${escapeHtml(entry.avatar)}" alt="" /></span>`
    : `<span class="oav" style="background:linear-gradient(140deg,hsl(${hue} 72% 58%),hsl(${(hue + 42) % 360} 68% 44%))">${escapeHtml((entry.display || '?').charAt(0).toUpperCase())}</span>`;

  el.innerHTML = `
    <span class="rank"></span>
    ${avatar}
    <span class="oname">${escapeHtml(entry.display)}${entry.isSub ? '<span class="osub">SUB</span>' : ''}</span>
    <span class="otime"></span>
  `;
  el.querySelector('.otime').dataset.since = entry.joinedAt;
  return el;
}

function render() {
  if (!cfg) return;

  const max = Math.max(1, Number(cfg.maxRows) || 5);
  const visible = queue.slice(0, max);
  const visibleIds = new Set(visible.map(e => e.id));

  document.body.classList.toggle('is-empty', queue.length === 0);
  const hidden = queue.length - visible.length;
  countEl.textContent = queue.length === 0
    ? '0 waiting'
    : (hidden > 0 ? `${queue.length} waiting · +${hidden} more` : `${queue.length} waiting`);

  // FLIP: snapshot before mutating.
  const first = new Map();
  for (const [id, el] of nodes) {
    if (el.isConnected && !el.classList.contains('leave')) {
      first.set(id, el.getBoundingClientRect());
    }
  }

  // Remove rows that dropped out of view.
  for (const [id, el] of [...nodes]) {
    if (visibleIds.has(id)) continue;
    nodes.delete(id);
    if (!el.isConnected) continue;
    el.classList.remove('enter');
    el.classList.add('leave');
    const h = el.offsetHeight;
    el.style.position = 'absolute';
    el.style.width = el.offsetWidth + 'px';
    el.style.height = h + 'px';
    el.style.pointerEvents = 'none';
    setTimeout(() => el.remove(), 420 / (cfg.animSpeed || 1));
  }

  const ordered = [];
  visible.forEach((entry, i) => {
    let el = nodes.get(entry.id);
    if (!el) {
      el = buildRow(entry);
      nodes.set(entry.id, el);
      setTimeout(() => el.classList.remove('enter'), 700);
    }
    el.style.setProperty('--i', i);
    el.classList.toggle('first', i === 0);
    el.querySelector('.rank').textContent = i + 1;
    const time = el.querySelector('.otime');
    if (time.dataset.since !== String(entry.joinedAt)) time.dataset.since = entry.joinedAt;
    ordered.push(el);
  });

  // Order the live rows at the front; rows on their way out are taken out of
  // flow, so they can safely trail behind.
  let anchor = null;
  for (const el of ordered) {
    const target = anchor ? anchor.nextSibling : rowsEl.firstChild;
    if (el !== target) rowsEl.insertBefore(el, target);
    anchor = el;
  }

  for (const el of ordered) {
    const before = first.get(el.dataset.id);
    if (!before) continue;
    const after = el.getBoundingClientRect();
    const dy = before.top - after.top;
    const dx = before.left - after.left;
    if (Math.abs(dy) < 1 && Math.abs(dx) < 1) continue;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 420 / (cfg.animSpeed || 1), easing: 'cubic-bezier(.2,.85,.25,1)' }
    );
  }

  tick();
}

function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll('.otime')) {
    const since = Number(el.dataset.since);
    if (!since) continue;
    const text = fmtWait(now - since);
    if (el.textContent !== text) el.textContent = text;
  }
}
setInterval(tick, 250);

/* ------------------------------------------------------------------ */
/* live connection                                                    */
/* ------------------------------------------------------------------ */

let ws = null;
let retry = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => { retry = 0; };

  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type !== 'state') return;
    queue = Array.isArray(msg.queue) ? msg.queue : [];
    if (msg.overlay) applyConfig(msg.overlay);
    else render();
  };

  ws.onclose = () => {
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, Math.min(500 * Math.pow(2, retry - 1), 8000));
  };

  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

// Fall back to a plain fetch so the very first paint is instant.
fetch('/api/state')
  .then(r => r.json())
  .then(s => { queue = s.queue || []; applyConfig(s.overlay); })
  .catch(() => {});

connect();
