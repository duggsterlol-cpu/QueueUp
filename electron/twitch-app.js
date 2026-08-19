'use strict';

/**
 * QueueUp's own Twitch application identity.
 *
 * A client ID is public by design - it names the app during the OAuth
 * handshake and is not a secret. The token it produces is what matters, and
 * that never leaves this machine: it's stored in the local state file and used
 * only to open an IRC connection from your PC to Twitch.
 *
 * Because this is baked in, nobody using QueueUp ever has to visit the Twitch
 * developer console. They click "Sign in with Twitch" and that's it.
 */
const TWITCH_CLIENT_ID = '';

/**
 * Twitch matches redirect URIs exactly, so every port we might listen on has to
 * be registered on the app up front. We try these in order and use whichever
 * one we actually got.
 */
const REDIRECT_PORTS = [4747, 4748, 4749, 4750];

const SCOPES = ['chat:read', 'chat:edit'];

function redirectUri(port) {
  return `http://localhost:${port}/auth/callback`;
}

function isRegisteredPort(port) {
  return REDIRECT_PORTS.includes(Number(port));
}

function authorizeUrl(port) {
  return 'https://id.twitch.tv/oauth2/authorize' +
    `?client_id=${encodeURIComponent(TWITCH_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri(port))}` +
    '&response_type=token' +
    `&scope=${encodeURIComponent(SCOPES.join(' '))}` +
    '&force_verify=true';
}

module.exports = {
  TWITCH_CLIENT_ID,
  REDIRECT_PORTS,
  SCOPES,
  redirectUri,
  isRegisteredPort,
  authorizeUrl,
  configured: () => TWITCH_CLIENT_ID.length > 0
};
