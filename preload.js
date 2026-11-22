'use strict';
// The narrow API the renderer gets. ipcRenderer itself is never exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  get: () => ipcRenderer.invoke('desk:get'),
  refresh: () => ipcRenderer.invoke('desk:refresh'),
  openWindow: () => ipcRenderer.invoke('desk:open-window'),
  newTab: () => ipcRenderer.invoke('desk:new-tab'),
  copyDemo: () => ipcRenderer.invoke('desk:copy-demo'),
  newSession: (accountId) => ipcRenderer.invoke('desk:new-session', String(accountId)),
  attach: (pid) => ipcRenderer.invoke('desk:attach', Number(pid)),
  limitReset: (pid) => ipcRenderer.invoke('desk:limit-reset', Number(pid)),
  onView: (fn) => {
    const listener = (_e, view) => fn(view);
    ipcRenderer.on('desk:view', listener);
    return () => ipcRenderer.removeListener('desk:view', listener);
  },
});
