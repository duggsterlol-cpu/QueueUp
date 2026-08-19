'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_SETTINGS = {
  channel: '',
  autoConnect: true,
  partySize: 3,
  hostName: 'You',
  joinCommand: '!join',
  leaveCommand: '!dequeue',
  listCommand: '!queue',
  allowDuplicates: false,
  subsPriority: true,
  queueOpen: true,
  port: 4747,
  autoUpdate: true,
  botReplies: false,
  clientId: '',
  accessToken: '',
  botUsername: ''
};

const DEFAULT_OVERLAY = {
  title: 'NEXT UP',
  showTitle: true,
  showHeaderCount: true,
  maxRows: 5,
  style: 'cards',
  accent: '#a970ff',
  accent2: '#00e5c0',
  textColor: '#ffffff',
  rowBg: '#101218',
  rowOpacity: 0.72,
  radius: 14,
  scale: 1,
  width: 420,
  gap: 10,
  fontFamily: 'Inter',
  fontWeight: 700,
  showRank: true,
  showAvatar: true,
  showTimer: true,
  highlightFirst: true,
  glow: true,
  shimmer: true,
  animSpeed: 1,
  direction: 'down',
  align: 'left',
  emptyText: 'Queue is empty - type !join'
};

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function normalizeEntry(e) {
  return {
    id: e.id || makeId(),
    login: String(e.login || '').toLowerCase(),
    display: e.display || e.login || 'unknown',
    joinedAt: Number(e.joinedAt) || Date.now(),
    partySince: e.partySince ? Number(e.partySince) : undefined,
    color: e.color || null,
    isSub: !!e.isSub,
    isMod: !!e.isMod,
    isVip: !!e.isVip,
    source: e.source || 'chat',
    note: e.note || ''
  };
}

class Store extends EventEmitter {
  constructor(filePath) {
    super();
    this.file = filePath;
    this.data = {
      party: [],
      queue: [],
      settings: { ...DEFAULT_SETTINGS },
      overlay: { ...DEFAULT_OVERLAY }
    };
    this._saveTimer = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data.party = Array.isArray(raw.party) ? raw.party.map(normalizeEntry) : [];
        this.data.queue = Array.isArray(raw.queue) ? raw.queue.map(normalizeEntry) : [];
        this.data.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
        this.data.overlay = { ...DEFAULT_OVERLAY, ...(raw.overlay || {}) };
      }
    } catch (err) {
      console.error('[store] failed to load state:', err.message);
    }
  }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
      } catch (err) {
        console.error('[store] failed to save state:', err.message);
      }
    }, 250);
  }

  changed(reason) {
    this.save();
    this.emit('change', reason || 'update');
  }

  snapshot(extra) {
    return {
      party: this.data.party,
      queue: this.data.queue,
      settings: this.data.settings,
      overlay: this.data.overlay,
      serverTime: Date.now(),
      ...extra
    };
  }

  /* ------------------------- lookups ------------------------- */

  findByLogin(login) {
    const l = String(login || '').toLowerCase();
    const inParty = this.data.party.find(e => e.login === l);
    if (inParty) return { entry: inParty, list: 'party' };
    const inQueue = this.data.queue.find(e => e.login === l);
    if (inQueue) return { entry: inQueue, list: 'queue' };
    return null;
  }

  findById(id) {
    let idx = this.data.party.findIndex(e => e.id === id);
    if (idx >= 0) return { entry: this.data.party[idx], list: 'party', index: idx };
    idx = this.data.queue.findIndex(e => e.id === id);
    if (idx >= 0) return { entry: this.data.queue[idx], list: 'queue', index: idx };
    return null;
  }

  /* ------------------------- mutations ------------------------- */

  addUser(user, opts = {}) {
    const login = String(user.login || user.display || '').toLowerCase().trim();
    if (!login) return { ok: false, reason: 'invalid' };

    const existing = this.findByLogin(login);
    if (existing && !this.data.settings.allowDuplicates) {
      return {
        ok: false,
        reason: existing.list === 'party' ? 'in_party' : 'already',
        position: existing.list === 'queue' ? this.data.queue.indexOf(existing.entry) + 1 : 0,
        entry: existing.entry
      };
    }

    const entry = normalizeEntry({
      id: makeId(),
      login,
      display: user.display || user.login,
      joinedAt: Date.now(),
      color: user.color || null,
      isSub: !!user.isSub,
      isMod: !!user.isMod,
      isVip: !!user.isVip,
      source: opts.source || 'chat'
    });

    if (this.data.settings.subsPriority && entry.isSub) {
      // Insert after the trailing subscriber block so FIFO still holds within a tier.
      let idx = this.data.queue.length;
      for (let i = 0; i < this.data.queue.length; i++) {
        if (!this.data.queue[i].isSub) { idx = i; break; }
      }
      this.data.queue.splice(idx, 0, entry);
    } else {
      this.data.queue.push(entry);
    }

    this.changed('add');
    return { ok: true, entry, position: this.data.queue.indexOf(entry) + 1 };
  }

  removeByLogin(login) {
    const found = this.findByLogin(login);
    if (!found) return { ok: false, reason: 'not_found' };
    this.removeById(found.entry.id);
    return { ok: true, entry: found.entry, list: found.list };
  }

  removeById(id) {
    const before = this.data.party.length + this.data.queue.length;
    this.data.party = this.data.party.filter(e => e.id !== id);
    this.data.queue = this.data.queue.filter(e => e.id !== id);
    const changed = this.data.party.length + this.data.queue.length !== before;
    if (changed) this.changed('remove');
    return changed;
  }

  // Move an entry to (list, index) - the single primitive behind drag & drop.
  move(id, targetList, targetIndex) {
    const found = this.findById(id);
    if (!found) return false;
    if (targetList !== 'party' && targetList !== 'queue') return false;

    const src = found.list === 'party' ? this.data.party : this.data.queue;
    const [entry] = src.splice(found.index, 1);
    const dst = targetList === 'party' ? this.data.party : this.data.queue;

    let idx = Math.max(0, Math.min(Number(targetIndex) || 0, dst.length));

    if (targetList === 'party') {
      const cap = Math.max(1, Number(this.data.settings.partySize) || 3);
      if (dst.length >= cap) {
        // Party full: bump the last member back to the front of the queue.
        const bumped = dst.pop();
        if (bumped) {
          bumped.joinedAt = Date.now();
          delete bumped.partySince;
          this.data.queue.unshift(bumped);
        }
        idx = Math.max(0, Math.min(idx, dst.length));
      }
      entry.partySince = entry.partySince || Date.now();
    } else if (found.list === 'party') {
      // Dropped back out of the party - restart the wait clock.
      entry.joinedAt = Date.now();
      delete entry.partySince;
    }

    dst.splice(idx, 0, entry);
    this.changed('move');
    return true;
  }

  promote(id) {
    const found = this.findById(id);
    if (!found || found.list === 'party') return false;
    return this.move(id, 'party', this.data.party.length);
  }

  toTop(id) {
    const found = this.findById(id);
    if (!found) return false;
    return this.move(id, found.list, 0);
  }

  clear(which) {
    if (which === 'party' || which === 'all') this.data.party = [];
    if (which === 'queue' || which === 'all') this.data.queue = [];
    this.changed('clear');
  }

  fillParty() {
    const cap = Math.max(1, Number(this.data.settings.partySize) || 3);
    let moved = 0;
    while (this.data.party.length < cap && this.data.queue.length > 0) {
      const entry = this.data.queue.shift();
      entry.partySince = Date.now();
      this.data.party.push(entry);
      moved++;
    }
    if (moved) this.changed('fill');
    return moved;
  }

  nextGame() {
    this.data.party = [];
    const moved = this.fillParty();
    this.changed('next');
    return moved;
  }

  updateSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.changed('settings');
    return this.data.settings;
  }

  updateOverlay(patch) {
    this.data.overlay = { ...this.data.overlay, ...patch };
    this.changed('overlay');
    return this.data.overlay;
  }

  resetOverlay() {
    this.data.overlay = { ...DEFAULT_OVERLAY };
    this.changed('overlay');
    return this.data.overlay;
  }
}

/**
 * Renders the queue for chat, e.g.
 *   Queue (10): 1. lovediddyo⭐, 2. jeffunderdog⭐, 3. fizzyzayizbetter, ...
 * Twitch drops messages over 500 characters, so the tail is folded into
 * a "+N more" marker rather than being silently cut off.
 */
function formatQueueMessage(queue, joinCommand) {
  const q = Array.isArray(queue) ? queue : [];
  if (!q.length) return `The queue is empty — type ${joinCommand || '!join'} to get in line.`;

  const head = `Queue (${q.length}): `;
  const parts = [];
  let len = head.length;

  for (let i = 0; i < q.length; i++) {
    const piece = `${i + 1}. ${q[i].display}${q[i].isSub ? '⭐' : ''}`;
    const cost = (parts.length ? 2 : 0) + piece.length;
    const remaining = q.length - i;
    // Keep room for the "+N more" marker in case the next name doesn't fit.
    if (len + cost + 12 > 480) {
      parts.push(`+${remaining} more`);
      break;
    }
    parts.push(piece);
    len += cost;
  }

  return head + parts.join(', ');
}

module.exports = { Store, DEFAULT_SETTINGS, DEFAULT_OVERLAY, makeId, formatQueueMessage };
