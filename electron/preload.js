'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('hq', {
  getState: () => ipcRenderer.invoke('app:state'),
  getLogs: () => ipcRenderer.invoke('app:logs'),

  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),

  addUser: name => ipcRenderer.invoke('queue:add', name),
  remove: id => ipcRenderer.invoke('queue:remove', id),
  move: (id, list, index) => ipcRenderer.invoke('queue:move', { id, list, index }),
  promote: id => ipcRenderer.invoke('queue:promote', id),
  toTop: id => ipcRenderer.invoke('queue:toTop', id),
  clear: which => ipcRenderer.invoke('queue:clear', which),
  fillParty: () => ipcRenderer.invoke('queue:fill'),
  nextGame: () => ipcRenderer.invoke('queue:next'),

  updateSettings: patch => ipcRenderer.invoke('settings:update', patch),
  updateOverlay: patch => ipcRenderer.invoke('overlay:update', patch),
  resetOverlay: () => ipcRenderer.invoke('overlay:reset'),

  connect: () => ipcRenderer.invoke('twitch:connect'),
  disconnect: () => ipcRenderer.invoke('twitch:disconnect'),
  login: () => ipcRenderer.invoke('twitch:login'),
  logout: () => ipcRenderer.invoke('twitch:logout'),

  copy: text => ipcRenderer.invoke('util:copy', text),
  openExternal: url => ipcRenderer.invoke('util:openExternal', url),
  confirm: opts => ipcRenderer.invoke('util:confirm', opts),

  onState: listen('state'),
  onTwitch: listen('twitch'),
  onLog: listen('log'),
  onAuth: listen('auth'),
  onUpdate: listen('update'),
  onWindowState: listen('window:state'),

  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close')
});
