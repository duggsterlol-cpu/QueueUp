'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

/**
 * Local HTTP + WebSocket server.
 *  - serves the OBS browser source at /overlay
 *  - pushes live state to every connected overlay/preview over /ws
 *  - catches the browser coming back from the Twitch login
 */
function createServer({ store, onLog, onAuthReturn }) {
  const app = express();
  app.use(express.json());

  const overlayDir = path.join(__dirname, '..', 'overlay');
  app.use('/overlay', express.static(overlayDir));

  app.get('/', (_req, res) => res.redirect('/overlay/'));

  app.get('/api/state', (_req, res) => {
    res.json(publicState(store));
  });

  // Where the token service sends the browser once the user has authorized.
  app.get('/auth/done', (_req, res) => {
    if (typeof onAuthReturn === 'function') onAuthReturn();
    res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>QueueUp — connected</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; height:100vh; display:grid; place-items:center; background:#080a0f; color:#e9ebf3;
         font:600 15px/1.6 "Segoe UI",system-ui,sans-serif; text-align:center }
  .card { padding:38px 46px; border:1px solid rgba(255,255,255,.07); border-radius:18px;
          background:#10131b; box-shadow:0 18px 40px -18px rgba(0,0,0,.9) }
  .mark { width:52px; height:52px; margin:0 auto 18px; border-radius:16px; display:grid; place-items:center;
          font-size:19px; font-weight:800; color:#fff;
          background:linear-gradient(140deg,#a970ff,#6b3bd6); box-shadow:0 14px 34px -12px rgba(169,112,255,.9) }
  h1 { margin:0 0 6px; font-size:19px }
  p { margin:0; color:#9aa1b5; font-weight:500; font-size:13.5px }
</style>
<div class="card">
  <div class="mark">QU</div>
  <h1>You're connected</h1>
  <p>QueueUp is linking your account — you can close this tab.</p>
</div>
<script>setTimeout(function(){ window.close(); }, 2500);</script>`);
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

  /**
   * Try each candidate port in turn, then fall back to any free one.
   *
   * Order matters: the caller passes its preferred port first so the browser
   * source URL stays stable between launches.
   */
  function listen(ports) {
    const queue = (Array.isArray(ports) ? ports : [ports]).map(Number).filter(Boolean);

    return new Promise((resolve, reject) => {
      const done = () => {
        current = server.address();
        resolve(current.port);
      };

      const tryNext = () => {
        const port = queue.shift();

        if (port === undefined) {
          server.once('error', reject);
          if (onLog) onLog({ type: 'warn', text: 'All preferred ports were busy - using a random one.' });
          server.listen(0, '127.0.0.1', done);
          return;
        }

        server.once('error', err => {
          if (err.code === 'EADDRINUSE') tryNext();
          else reject(err);
        });
        server.listen(port, '127.0.0.1', done);
      };

      tryNext();
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
