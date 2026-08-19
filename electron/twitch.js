'use strict';
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

/**
 * Minimal Twitch IRC client.
 *
 * Reading chat needs no credentials at all - Twitch allows an anonymous
 * "justinfan" login that can join any public channel. A token is only
 * required if we want to talk back in chat.
 */
class TwitchChat extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.channel = '';
    this.status = 'disconnected'; // disconnected | connecting | connected | error
    this.detail = '';
    this.token = '';
    this.username = '';
    this.anonymous = true;
    this.retries = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.manualClose = false;
    this.lastPong = 0;
  }

  get state() {
    return {
      status: this.status,
      channel: this.channel,
      detail: this.detail,
      anonymous: this.anonymous,
      username: this.username
    };
  }

  setStatus(status, detail) {
    this.status = status;
    this.detail = detail || '';
    this.emit('status', this.state);
  }

  connect({ channel, token, username }) {
    this.disconnect(true);
    const chan = String(channel || '').trim().toLowerCase().replace(/^#/, '').replace(/^.*twitch\.tv\//, '');
    if (!chan) {
      this.setStatus('error', 'No channel set');
      return;
    }
    this.channel = chan;
    this.token = (token || '').replace(/^oauth:/i, '');
    this.username = (username || '').toLowerCase();
    this.anonymous = !this.token;
    this.manualClose = false;
    this.open();
  }

  open() {
    this.setStatus('connecting', `Joining #${this.channel}`);
    let ws;
    try {
      ws = new WebSocket(IRC_URL);
    } catch (err) {
      this.setStatus('error', err.message);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      const nick = this.anonymous
        ? 'justinfan' + Math.floor(Math.random() * 80000 + 1000)
        : (this.username || 'queueup');
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS oauth:' + (this.anonymous ? 'SCHMOOPIIE' : this.token));
      ws.send('NICK ' + nick);
      ws.send('JOIN #' + this.channel);
      this.lastPong = Date.now();
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.heartbeat(), 30000);
    });

    ws.on('message', data => {
      const text = data.toString();
      for (const line of text.split('\r\n')) {
        if (line) this.handleLine(line);
      }
    });

    ws.on('close', () => {
      clearInterval(this.pingTimer);
      if (this.manualClose) {
        this.setStatus('disconnected', '');
        return;
      }
      this.setStatus('connecting', 'Reconnecting...');
      this.scheduleReconnect();
    });

    ws.on('error', err => {
      this.emit('log', { type: 'error', text: 'IRC error: ' + err.message });
    });
  }

  heartbeat() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Twitch answers PING with PONG; if it stops answering, force a reconnect.
    if (Date.now() - this.lastPong > 90000) {
      try { this.ws.terminate(); } catch (_) {}
      return;
    }
    try { this.ws.send('PING :tmi.twitch.tv'); } catch (_) {}
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    if (this.manualClose) return;
    this.retries = Math.min(this.retries + 1, 6);
    const delay = Math.min(1000 * Math.pow(2, this.retries - 1), 30000);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  disconnect(silent) {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    if (!silent) this.setStatus('disconnected', '');
  }

  say(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.anonymous) return false;
    try {
      this.ws.send(`PRIVMSG #${this.channel} :${message}`);
      return true;
    } catch (_) {
      return false;
    }
  }

  handleLine(line) {
    if (line.startsWith('PING')) {
      try { this.ws.send('PONG :tmi.twitch.tv'); } catch (_) {}
      return;
    }

    const msg = parseIrc(line);
    if (!msg) return;

    switch (msg.command) {
      case 'PONG':
        this.lastPong = Date.now();
        break;
      case '001':
        this.retries = 0;
        break;
      case 'JOIN':
        this.retries = 0;
        this.setStatus('connected', `#${this.channel}`);
        break;
      case 'NOTICE': {
        const text = msg.params[1] || '';
        if (/login authentication failed|improperly formatted auth/i.test(text)) {
          this.manualClose = true;
          this.setStatus('error', 'Login failed - token invalid or expired');
        }
        this.emit('log', { type: 'notice', text });
        break;
      }
      case 'RECONNECT':
        try { this.ws.close(); } catch (_) {}
        break;
      case 'PRIVMSG': {
        const login = (msg.prefix || '').split('!')[0].toLowerCase();
        const text = msg.params[1] || '';
        const tags = msg.tags || {};
        const badges = tags.badges || '';
        this.emit('message', {
          login,
          display: tags['display-name'] || login,
          text: text.trim(),
          color: tags.color || null,
          isSub: tags.subscriber === '1' || /subscriber|founder/.test(badges),
          isMod: tags.mod === '1' || /moderator/.test(badges),
          isVip: /vip/.test(badges),
          isBroadcaster: /broadcaster/.test(badges)
        });
        break;
      }
      default:
        break;
    }
  }
}

function parseIrc(line) {
  let rest = line;
  let tags = null;

  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    const rawTags = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
    tags = {};
    for (const pair of rawTags.split(';')) {
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      const val = eq === -1 ? '' : pair.slice(eq + 1);
      tags[key] = val
        .replace(/\\s/g, ' ')
        .replace(/\\:/g, ';')
        .replace(/\\r/g, '')
        .replace(/\\n/g, '')
        .replace(/\\\\/g, '\\');
    }
  }

  let prefix = null;
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }

  const params = [];
  while (rest.length) {
    if (rest.startsWith(':')) {
      params.push(rest.slice(1));
      break;
    }
    const sp = rest.indexOf(' ');
    if (sp === -1) {
      params.push(rest);
      break;
    }
    params.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1);
  }

  const command = params.shift();
  if (!command) return null;
  return { tags, prefix, command: command.toUpperCase(), params };
}

module.exports = { TwitchChat };
