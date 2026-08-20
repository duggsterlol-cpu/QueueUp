'use strict';
const fs = require('fs');
const path = require('path');

const HELIX_USERS = 'https://api.twitch.tv/helix/users';
const BATCH = 100;                          // Helix caps logins per request
const TTL_MS = 7 * 24 * 60 * 60 * 1000;     // re-check a picture weekly
const MISS_TTL_MS = 6 * 60 * 60 * 1000;     // don't hammer for names that don't resolve

/**
 * Looks up Twitch profile pictures and remembers them.
 *
 * The cache is written to disk so avatars are on screen the instant the app
 * opens, rather than after a round trip. Names that don't resolve (typos in a
 * manual add, deleted accounts) are remembered too, so they aren't retried on
 * every single queue change.
 */
function createAvatarService({ cacheFile, getAuth, onLog }) {
  /** login -> { url: string|null, at: number } */
  const cache = new Map();
  let saveTimer = null;
  let inFlight = null;

  load();

  function load() {
    try {
      if (!cacheFile || !fs.existsSync(cacheFile)) return;
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      for (const [login, entry] of Object.entries(raw || {})) {
        if (entry && typeof entry.at === 'number') cache.set(login, entry);
      }
    } catch (_) { /* a corrupt cache is not worth failing over */ }
  }

  function save() {
    if (!cacheFile) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(cache)));
      } catch (_) { /* cosmetic data - never break the queue over it */ }
    }, 500);
  }

  function fresh(login) {
    const hit = cache.get(login);
    if (!hit) return false;
    const ttl = hit.url ? TTL_MS : MISS_TTL_MS;
    return Date.now() - hit.at < ttl;
  }

  function get(login) {
    const hit = cache.get(String(login || '').toLowerCase());
    return hit && hit.url ? hit.url : null;
  }

  async function fetchBatch(logins) {
    const auth = getAuth();
    if (!auth || !auth.token || !auth.clientId) return { ok: false, reason: 'no_auth' };

    const qs = logins.map(l => 'login=' + encodeURIComponent(l)).join('&');
    let res;
    try {
      res = await fetch(`${HELIX_USERS}?${qs}`, {
        headers: { 'Client-Id': auth.clientId, Authorization: 'Bearer ' + auth.token }
      });
    } catch (err) {
      return { ok: false, reason: 'network', message: err.message };
    }

    if (res.status === 401) return { ok: false, reason: 'unauthorized' };
    if (!res.ok) return { ok: false, reason: 'http_' + res.status };

    let json;
    try {
      json = await res.json();
    } catch (_) {
      return { ok: false, reason: 'bad_json' };
    }

    const now = Date.now();
    const found = new Set();
    for (const user of json.data || []) {
      const login = String(user.login || '').toLowerCase();
      if (!login) continue;
      found.add(login);
      cache.set(login, { url: user.profile_image_url || null, at: now });
    }
    // Anything Twitch didn't return simply doesn't exist - remember that too.
    for (const login of logins) {
      if (!found.has(login)) cache.set(login, { url: null, at: now });
    }
    save();
    return { ok: true, count: found.size };
  }

  /**
   * Fills in avatars for the given logins.
   * Returns the number of newly resolved pictures.
   */
  async function resolve(logins) {
    const wanted = [...new Set(
      (logins || []).map(l => String(l || '').toLowerCase()).filter(Boolean)
    )].filter(l => !fresh(l));

    if (!wanted.length) return 0;

    // One lookup pass at a time; queue changes fire in bursts.
    if (inFlight) { try { await inFlight; } catch (_) {} }

    const run = (async () => {
      let resolved = 0;
      for (let i = 0; i < wanted.length; i += BATCH) {
        const slice = wanted.slice(i, i + BATCH);
        const out = await fetchBatch(slice);
        if (!out.ok) {
          if (out.reason === 'no_auth') return resolved;
          if (onLog) onLog({ type: 'warn', text: `Could not load profile pictures (${out.reason}).` });
          return resolved;
        }
        resolved += out.count;
      }
      return resolved;
    })();

    inFlight = run;
    try {
      return await run;
    } finally {
      if (inFlight === run) inFlight = null;
    }
  }

  /**
   * Resolves every login in the given lists and writes the results onto the
   * entries. Returns true if anything changed, so the caller knows to redraw.
   */
  async function apply(lists) {
    const entries = [].concat(...lists.filter(Boolean));
    if (!entries.length) return false;

    await resolve(entries.map(e => e.login));

    let changed = false;
    for (const entry of entries) {
      const url = get(entry.login);
      if (url && entry.avatar !== url) {
        entry.avatar = url;
        changed = true;
      }
    }
    return changed;
  }

  function clear() {
    cache.clear();
    save();
  }

  return { resolve, apply, get, clear, get size() { return cache.size; } };
}

module.exports = { createAvatarService };
