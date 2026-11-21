// Roost MX — Electron main process.
// Serves the game from a private app:// protocol (works offline, inside the asar archive),
// opens a dedicated game window and exposes a tiny API (fullscreen, quit) to the page.
const { app, BrowserWindow, Menu, ipcMain, protocol, net, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const APP_TITLE = 'Roost MX';
const ROOT = __dirname;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Keep the game smooth when the window is in the background briefly
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    title: APP_TITLE,
    icon: path.join(ROOT, 'assets', 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#0b0b0d',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'electron-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  // never navigate away from the game or open popups inside the app
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (event, input) => {
    // F11 / Alt+Enter toggle fullscreen even before the page handles keys
    if (input.type === 'keyDown' && (input.key === 'F11' || (input.key === 'Enter' && input.alt))) {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
    // allow opening devtools for troubleshooting: Ctrl+Shift+I
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  win.on('enter-full-screen', () => win.webContents.send('fullscreen-changed', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen-changed', false));
  win.loadURL('app://game/index.html');
  win.on('closed', () => {
    win = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    protocol.handle('app', (request) => {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const filePath = path.normalize(path.join(ROOT, rel));
      if (!filePath.startsWith(ROOT)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(filePath).toString());
    });

    ipcMain.on('app:quit', () => app.quit());
    ipcMain.on('app:set-fullscreen', (_e, on) => {
      if (win) win.setFullScreen(!!on);
    });
    ipcMain.on('app:toggle-fullscreen', () => {
      if (win) win.setFullScreen(!win.isFullScreen());
    });
    ipcMain.on('app:is-fullscreen', (e) => {
      e.returnValue = win ? win.isFullScreen() : false;
    });

    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
