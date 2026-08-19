'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

/**
 * Local HTTP + WebSocket server.
 *  - serves the OBS browser source at /overlay
 *  - pushes live state to every connected overlay/preview over /ws
 *  - handles the optional Twitch OAuth redirect
 */
function createServer({ store, onAuth, onLog }) {
  const app = express();
  app.use(express.json());

  const overlayDir = path.join(__dirname, '..', 'overlay');
  app.use('/overlay', express.static(overlayDir));

  app.get('/', (_req, res) => res.redirect('/overlay/'));

  app.get('/api/state', (_req, res) => {
    res.json(publicState(store));
  });

  app.get('/auth/callback', (_req, res) => {
    // Twitch implicit-grant tokens arrive in the URL fragment, which never
    // reaches the server - so bounce it back up through a POST.
    res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>QueueUp - Twitch</title>
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e8eaf2;
       font:600 15px/1.5 system-ui,Segoe UI,sans-serif;text-align:center}
  .card{padding:32px 40px;border:1px solid #22263180;border-radius:16px;background:#12151c}
  .ok{color:#00e5c0;font-size:22px;margin-bottom:8px}
  .sub{color:#8b90a3;font-weight:500}
</style>
<div class="card"><div class="ok" id="t">Finishing sign in...</div>
<div class="sub" id="s">You can close this window.</div></div>
<script>
  var h = new URLSearchParams(location.hash.slice(1));
  var token = h.get('access_token');
  var err = h.get('error_description') || h.get('error');
  if (token) {
    fetch('/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    }).then(function () {
      document.getElementById('t').textContent = 'Connected to Twitch';
      setTimeout(function(){ window.close(); }, 1200);
    });
  } else {
    document.getElementById('t').textContent = 'Sign in failed';
    document.getElementById('t').style.color = '#ff5c7a';
    document.getElementById('s').textContent = err || 'No token returned.';
  }
</script>`);
  });

  app.post('/auth/token', (req, res) => {
    const token = req.body && req.body.token;
    if (!token) return res.status(400).json({ ok: false });
    res.json({ ok: true });
    if (typeof onAuth === 'function') onAuth(token);
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set();

  wss.on('connection', ws => {
    clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    safeSend(ws, { type: 'state', ...publicState(store) });
  });

  // Drop overlay sockets that OBS abandoned without closing cleanly.
  const sweep = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) {
        clients.delete(ws);
        try { ws.terminate(); } catch (_) {}
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, 30000);

  function broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const ws of clients) {
      if (ws.readyState === 1) {
        try { ws.send(data); } catch (_) {}
      }
    }
  }

  function pushState() {
    broadcast({ type: 'state', ...publicState(store) });
  }

  let current = null;

  function listen(port) {
    return new Promise((resolve, reject) => {
      const done = () => {
        current = server.address();
        resolve(current.port);
      };
      server.once('error', err => {
        if (err.code === 'EADDRINUSE') {
          if (onLog) onLog({ type: 'warn', text: `Port ${port} is busy - using a free port instead.` });
          server.listen(0, '127.0.0.1', done);
        } else {
          reject(err);
        }
      });
      server.listen(port, '127.0.0.1', done);
    });
  }

  function close() {
    clearInterval(sweep);
    for (const ws of clients) { try { ws.terminate(); } catch (_) {} }
    clients.clear();
    try { wss.close(); } catch (_) {}
    try { server.close(); } catch (_) {}
  }

  return {
    listen,
    close,
    pushState,
    broadcast,
    get port() { return current ? current.port : null; },
    get clientCount() { return clients.size; }
  };
}

function safeSend(ws, payload) {
  try { ws.send(JSON.stringify(payload)); } catch (_) {}
}

function publicState(store) {
  return {
    party: store.data.party,
    queue: store.data.queue,
    overlay: store.data.overlay,
    partySize: store.data.settings.partySize,
    hostName: store.data.settings.hostName,
    joinCommand: store.data.settings.joinCommand,
    serverTime: Date.now()
  };
}

module.exports = { createServer };
