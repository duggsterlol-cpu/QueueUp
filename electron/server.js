'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

/**
 * Local HTTP + WebSocket server.
 *  - serves the OBS browser source at /overlay
 *  - pushes live state to every connected overlay/preview over /ws
 */
function createServer({ store, onLog }) {
  const app = express();
  app.use(express.json());

  const overlayDir = path.join(__dirname, '..', 'overlay');
  app.use('/overlay', express.static(overlayDir));

  app.get('/', (_req, res) => res.redirect('/overlay/'));

  app.get('/api/state', (_req, res) => {
    res.json(publicState(store));
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
