'use strict';

/**
 * Twitch login without a developer console.
 *
 * Twitch won't mint a chat token without an OAuth client ID identifying the
 * requesting app, and registering one means a trip through dev.twitch.tv. To
 * keep that out of QueueUp we hand the handshake to a public token service:
 *
 *   1. ask it to open a session for the scopes we need
 *   2. send the user to its URL, where they log in on Twitch's own consent screen
 *   3. poll until they've approved, and the token comes back to us
 *
 * The user just logs in - nothing to copy, nothing to register. The token then
 * lives only in the local state file on this machine.
 */

const API = 'https://twitchtokengenerator.com/api';
const APP_TITLE = 'QueueUp';
const SCOPES = ['chat:read', 'chat:edit'];

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

/** Their "not yet" sentinel; anything else that fails is a real error. */
const ERR_PENDING = 3;
const ERR_CONSUMED = 4;

async function getJson(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error(`Unexpected response from the login service (HTTP ${res.status})`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Field names have shifted across versions of this service, so read every
 * spelling we've seen rather than trusting one.
 */
function readCredentials(payload) {
  const token = payload.token || payload.access_token || payload.oauth_token || '';
  if (!token) return null;
  return {
    token: String(token).replace(/^oauth:/i, ''),
    refresh: payload.refresh || payload.refresh_token || '',
    clientId: payload.client_id || payload.clientId || '',
    login: payload.username || payload.login || ''
  };
}

/**
 * Starts a login session. Returns { id, url } - open `url` in the user's
 * browser, then call pollForToken(id).
 */
async function begin() {
  // The service wants raw base64 in the path - percent-encoding its "=" padding
  // makes it reject the title.
  const title = Buffer.from(APP_TITLE, 'utf8').toString('base64');
  const url = `${API}/create/${title}/${SCOPES.join('+')}`;
  const json = await getJson(url);
  if (!json || !json.success || !json.id || !json.message) {
    throw new Error((json && json.message) || 'The login service did not start a session.');
  }
  return { id: json.id, url: json.message };
}

/**
 * Waits for the user to finish approving in the browser.
 *
 * `shouldStop()` lets the caller cancel (window closed, user hit Cancel).
 * Resolves with credentials, or throws with a reason the UI can show.
 */
async function pollForToken(id, { shouldStop, onTick } = {}) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempt = 0;

  while (Date.now() < deadline) {
    if (shouldStop && shouldStop()) {
      const err = new Error('Login cancelled.');
      err.code = 'cancelled';
      throw err;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    attempt++;
    if (onTick) onTick(attempt);

    let json;
    try {
      json = await getJson(`${API}/status/${encodeURIComponent(id)}`);
    } catch (_) {
      continue; // transient network blip - keep waiting
    }
    if (!json) continue;

    if (json.success) {
      const creds = readCredentials(json);
      if (creds) return creds;
      continue;
    }

    if (json.error === ERR_PENDING) continue;

    if (json.error === ERR_CONSUMED) {
      const err = new Error('That login link was already used. Try again.');
      err.code = 'consumed';
      throw err;
    }

    const err = new Error(json.message || 'Login failed.');
    err.code = 'failed';
    throw err;
  }

  const err = new Error('Login timed out - the browser window was never approved.');
  err.code = 'timeout';
  throw err;
}

/** Trades a refresh token for a fresh access token. */
async function refresh(refreshToken) {
  if (!refreshToken) return null;
  let json;
  try {
    json = await getJson(`${API}/refresh/${encodeURIComponent(refreshToken)}`);
  } catch (_) {
    return null;
  }
  if (!json || !json.success) return null;
  return readCredentials(json);
}

module.exports = { begin, pollForToken, refresh, SCOPES, APP_TITLE };
