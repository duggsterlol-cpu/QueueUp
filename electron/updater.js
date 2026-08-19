'use strict';
const fs = require('fs');
const path = require('path');
const { autoUpdater } = require('electron-updater');

/**
 * Checks GitHub Releases for a newer build.
 *
 * The release channel is whatever `build.publish` in package.json points at,
 * which electron-builder bakes into app-update.yml at package time. In an
 * unpackaged dev run that file doesn't exist, so every call here no-ops
 * instead of throwing.
 */
function createUpdater({ isPackaged, onStatus, onLog, currentVersion, logDir }) {
  // A tiny rolling log so a failed update can be diagnosed after the fact.
  const logFile = logDir ? path.join(logDir, 'update.log') : null;
  const writeLog = (level, ...args) => {
    if (!logFile) return;
    const line = `[${new Date().toISOString()}] ${level} ${args.map(String).join(' ')}
`;
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 256 * 1024) {
        fs.writeFileSync(logFile, '');
      }
      fs.appendFileSync(logFile, line);
    } catch (_) { /* logging must never break the app */ }
  };

  let state = {
    status: isPackaged ? 'idle' : 'dev',
    version: currentVersion,
    newVersion: null,
    percent: 0,
    notes: '',
    error: ''
  };

  const push = patch => {
    state = { ...state, ...patch };
    if (onStatus) onStatus(state);
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (...a) => writeLog('INFO', ...a),
    warn: (...a) => writeLog('WARN', ...a),
    error: (...a) => writeLog('ERROR', ...a),
    debug: () => {}
  };

  autoUpdater.on('checking-for-update', () => push({ status: 'checking', error: '' }));

  autoUpdater.on('update-available', info => {
    push({ status: 'downloading', newVersion: info.version, percent: 0, notes: releaseNotes(info) });
    if (onLog) onLog({ type: 'info', text: `Update ${info.version} found — downloading…` });
  });

  autoUpdater.on('update-not-available', () => push({ status: 'current', newVersion: null, percent: 0 }));

  autoUpdater.on('download-progress', p => push({ status: 'downloading', percent: Math.round(p.percent) }));

  autoUpdater.on('update-downloaded', info => {
    push({ status: 'ready', newVersion: info.version, percent: 100, notes: releaseNotes(info) });
    if (onLog) onLog({ type: 'info', text: `Update ${info.version} ready — restart to install.` });
  });

  autoUpdater.on('error', err => {
    const msg = (err && err.message) ? err.message : String(err);
    push({ status: 'error', error: friendlyError(msg) });
    if (onLog) onLog({ type: 'warn', text: 'Update check failed: ' + friendlyError(msg) });
  });

  async function check(manual) {
    if (!isPackaged) {
      push({ status: 'dev' });
      if (manual && onLog) {
        onLog({ type: 'info', text: 'Update checks only run in the installed app, not from source.' });
      }
      return state;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      push({ status: 'error', error: friendlyError(err.message || String(err)) });
    }
    return state;
  }

  function install() {
    if (state.status !== 'ready') return false;
    // isSilent = false so the installer UI shows; isForceRunAfter = true reopens the app.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  }

  return { check, install, get state() { return state; } };
}

function releaseNotes(info) {
  const n = info && info.releaseNotes;
  if (!n) return '';
  const text = Array.isArray(n) ? n.map(x => x.note || '').join('\n') : String(n);
  return text.replace(/<[^>]+>/g, '').trim().slice(0, 600);
}

function friendlyError(msg) {
  if (/ENOTFOUND|ENETUNREACH|EAI_AGAIN|ETIMEDOUT/i.test(msg)) return 'No internet connection.';
  if (/404/.test(msg)) return 'No releases published yet.';
  if (/rate limit/i.test(msg)) return 'GitHub rate limit hit — try again later.';
  return msg;
}

module.exports = { createUpdater };
