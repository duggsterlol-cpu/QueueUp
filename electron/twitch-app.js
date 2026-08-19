'use strict';

/**
 * Twitch will not mint a chat token without an OAuth client ID identifying the
 * requesting app, and registering one means a trip through the developer
 * console. To keep that out of QueueUp entirely, we send people to a public
 * chat-token generator instead: they approve QueueUp-style chat access on
 * Twitch's own consent screen and get a token back to paste in once.
 *
 * The token lives only in the local state file and is used for exactly one
 * thing - opening an IRC connection from this machine to Twitch chat.
 */
const TOKEN_GENERATOR_URL = 'https://twitchapps.com/tmi/';

/** A chat token is useless to us without both of these. */
const REQUIRED_SCOPES = ['chat:read', 'chat:edit'];

/** Ports to prefer for the overlay server, in order. */
const PREFERRED_PORTS = [4747, 4748, 4749, 4750];

/** Accepts `oauth:abc123`, `abc123`, or either with stray whitespace/quotes. */
function normalizeToken(raw) {
  return String(raw || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^oauth:/i, '')
    .trim();
}

function looksLikeToken(raw) {
  const t = normalizeToken(raw);
  return /^[a-z0-9]{20,60}$/i.test(t);
}

/**
 * The generator hands out a legacy `chat_login` scope on some accounts and the
 * modern pair on others; both authorize reading and sending chat.
 */
function hasChatScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes.map(s => String(s).toLowerCase()) : [];
  if (list.includes('chat_login')) return true;
  return REQUIRED_SCOPES.every(s => list.includes(s));
}

module.exports = {
  TOKEN_GENERATOR_URL,
  REQUIRED_SCOPES,
  PREFERRED_PORTS,
  normalizeToken,
  looksLikeToken,
  hasChatScopes
};
