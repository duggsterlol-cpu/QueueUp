'use strict';

/**
 * Twitch login without a developer console.
 *
 * Twitch won't mint a chat token without an OAuth client ID identifying the
 * requesting app, and registering one means a trip through dev.twitch.tv. To
 * keep that out of QueueUp we hand the handshake to a public token service:
 *
 *   1. ask it to open a session for the scopes we need, giving it a local
 *      redirect URL so the browser lands back on us when the user is done
 *   2. send the user to its URL, where they authorize on Twitch's own screen
 *   3. collect the token from the session
 *
 * The service hands the credentials over exactly once and expires the session
 * on that first read, so the code below is deliberately careful never to
 * request the token twice, and never to discard a response that carried one.
 */

const API = 'https://twitchtokengenerator.com/api';
const APP_TITLE = 'QueueUp';
const SCOPES = ['chat:read', 'chat:edit'];

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

const ERR_PENDING = 3;    // user hasn't finished authorizing
const ERR_CONSUMED = 4;   // session already handed its token over
const ERR_STALE = 6;      // session sat unused too long

let log = () => {};
function setLogger(fn) { log = typeof fn === 'function' ? fn : () => {}; }

async function getJson(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      log('WARN', `non-JSON reply (HTTP ${res.status}): ${text.slice(0, 160)}`);
      throw new Error(`Unexpected reply from the login service (HTTP ${res.status})`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Describes a payload without ever writing the token itself to disk. */
function describe(payload) {
  if (!payload || typeof payload !== 'object') return String(payload);
  const secret = /token|refresh|secret|code/i;
  return Object.keys(payload)
    .map(k => `${k}=${secret.test(k) ? (payload[k] ? '<set>' : '<empty>') : JSON.stringify(payload[k])}`)
    .join(' ');
}

/**
 * Pulls credentials out of a success payload.
 *
 * The service has been rewritten at least once, so rather than trusting one
 * spelling this walks the payload (one level deep) for anything token-shaped.
 */
function readCredentials(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const pick = (obj, names) => {
    for (const n of names) {
      const v = obj[n];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  const TOKEN_KEYS = ['token', 'access_token', 'accessToken', 'oauth_token', 'oauth'];
  const REFRESH_KEYS = ['refresh', 'refresh_token', 'refreshToken'];
  const CLIENT_KEYS = ['client_id', 'clientId', 'clientID'];
  const NAME_KEYS = ['username', 'login', 'user_name', 'display_name'];

  const scopes = [payload, ...Object.values(payload).filter(v => v && typeof v === 'object')];

  for (const obj of scopes) {
    const token = pick(obj, TOKEN_KEYS);
    if (!token) continue;
    return {
      token: token.replace(/^oauth:/i, ''),
      refresh: pick(obj, REFRESH_KEYS),
      clientId: pick(obj, CLIENT_KEYS) || pick(payload, CLIENT_KEYS),
      login: pick(obj, NAME_KEYS) || pick(payload, NAME_KEYS)
    };
  }
  return null;
}

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Opens a login session.
 *
 * `redirectUrl` (optional) is where the browser is sent once the user has
 * authorized, which lets the app react immediately instead of waiting for the
 * next poll.
 */
async function begin(redirectUrl) {
  const title = Buffer.from(APP_TITLE, 'utf8').toString('base64');
  // Raw base64 in the path - percent-encoding its "=" padding gets rejected.
  let url = `${API}/create/${title}/${SCOPES.join('+')}`;
  if (redirectUrl) url += '/' + Buffer.from(redirectUrl, 'utf8').toString('base64');

  log('INFO', `create -> ${url}`);
  const json = await getJson(url);
  log('INFO', `create reply: ${describe(json)}`);

  if (!json || !json.success || !json.id || !json.message) {
    throw fail((json && json.message) || 'The login service would not start a session.', 'create_failed');
  }
  return { id: json.id, url: json.message };
}

/**
 * One status read.
 *
 * Returns credentials, or null while the user hasn't finished. A success
 * payload we can't read is a hard error, never a retry: the service has
 * already expired the session by then, so retrying would only ever return
 * "already used" and the real reason would be lost.
 */
async function claim(id) {
  const json = await getJson(`${API}/status/${encodeURIComponent(id)}`);
  if (!json) return null;

  if (json.success) {
    const creds = readCredentials(json);
    if (creds) {
      log('INFO', `claimed credentials for ${creds.login || 'unknown user'}`);
      return creds;
    }
    log('ERROR', `success payload had no token: ${describe(json)}`);
    throw fail('The login service returned no token. Please try again.', 'no_token');
  }

  if (json.error === ERR_PENDING) return null;
  if (json.error === ERR_CONSUMED) throw fail('That login link was already used. Try again.', 'consumed');
  if (json.error === ERR_STALE) throw fail('That login link expired. Try again.', 'stale');

  log('ERROR', `status error: ${describe(json)}`);
  throw fail(json.message || 'Login failed.', 'failed');
}

/**
 * Waits for the user to finish in the browser.
 *
 * `wake` is an optional function returning a promise that resolves when the
 * local redirect is hit, so we check immediately instead of sitting out the
 * rest of the poll interval.
 */
async function waitForToken(id, { shouldStop, onTick, wake } = {}) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempt = 0;

  // The wake promise stays resolved once the browser has come back, so it may
  // only short-circuit the wait once - otherwise the loop would spin as fast
  // as the network allows.
  let waker = typeof wake === 'function' ? wake() : null;

  while (Date.now() < deadline) {
    if (shouldStop && shouldStop()) throw fail('Login cancelled.', 'cancelled');

    const sleep = new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    if (waker) {
      const WOKE = Symbol('woke');
      const outcome = await Promise.race([sleep.then(() => null), waker.then(() => WOKE)]);
      if (outcome === WOKE) {
        log('INFO', 'redirect seen - claiming immediately');
        waker = null;
      }
    } else {
      await sleep;
    }

    if (shouldStop && shouldStop()) throw fail('Login cancelled.', 'cancelled');

    attempt++;
    if (onTick) onTick(attempt);

    let creds;
    try {
      creds = await claim(id);
    } catch (err) {
      if (err.code === 'no_token' || err.code === 'consumed' || err.code === 'stale' || err.code === 'failed') throw err;
      log('WARN', `status attempt ${attempt} failed: ${err.message}`);
      continue; // transient network blip - keep waiting
    }
    if (creds) return creds;
  }

  throw fail('Login timed out - the browser was never approved.', 'timeout');
}

/** Trades a refresh token for a fresh access token. */
async function refresh(refreshToken) {
  if (!refreshToken) return null;
  let json;
  try {
    json = await getJson(`${API}/refresh/${encodeURIComponent(refreshToken)}`);
  } catch (err) {
    log('WARN', `refresh failed: ${err.message}`);
    return null;
  }
  if (!json || !json.success) {
    log('WARN', `refresh rejected: ${describe(json)}`);
    return null;
  }
  return readCredentials(json);
}

module.exports = { begin, waitForToken, claim, refresh, setLogger, SCOPES, APP_TITLE };
