// Roost MX — preload bridge. Exposes a minimal, safe API to the game page.
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
ipcRenderer.on('fullscreen-changed', (_e, on) => {
  for (const fn of listeners) fn(on);
});

contextBridge.exposeInMainWorld('roostNative', {
  isElectron: true,
  platform: process.platform,
  quit: () => ipcRenderer.send('app:quit'),
  setFullscreen: (on) => ipcRenderer.send('app:set-fullscreen', !!on),
  toggleFullscreen: () => ipcRenderer.send('app:toggle-fullscreen'),
  isFullscreenSync: () => ipcRenderer.sendSync('app:is-fullscreen'),
  onFullscreenChange: (fn) => {
    if (typeof fn === 'function') listeners.add(fn);
  },
});
