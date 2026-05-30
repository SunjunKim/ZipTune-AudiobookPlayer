'use strict';

const { app, BrowserWindow, globalShortcut, nativeImage, ipcMain, systemPreferences, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const yauzl = require('yauzl');

let mainWindow = null;

function resolveIcon() {
  // Prefer a platform-rendered raster icon if it has been generated,
  // otherwise fall back to the SVG (used by the renderer/dock where possible).
  const png = path.join(__dirname, 'assets', 'icon.png');
  if (fs.existsSync(png)) {
    const img = nativeImage.createFromPath(png);
    if (!img.isEmpty()) return img;
  }
  return undefined;
}

function createWindow() {
  const icon = resolveIcon();

  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#0a0a0a',
    title: 'ZipTune',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow loading local audio files directly via file:// URLs.
      webSecurity: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  if (process.platform === 'darwin' && icon) {
    app.dock && app.dock.setIcon(icon);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel);
  }
}

// Transport keys — reliably supported across platforms.
const TRANSPORT_KEYS = {
  MediaPlayPause: 'media-playpause',
  MediaNextTrack: 'media-next',
  MediaPreviousTrack: 'media-prev',
  MediaStop: 'media-stop'
};
// Volume keys — best effort; on most OSes these are owned by the system.
const VOLUME_KEYS = {
  VolumeUp: 'media-volup',
  VolumeDown: 'media-voldown',
  VolumeMute: 'media-volmute'
};

// Register a map of accelerators; returns true if at least one is now active.
// These are GLOBAL — they fire even when the app is unfocused / in the
// background, which is the whole point of using globalShortcut.
function registerKeys(map) {
  let any = false;
  for (const [accel, channel] of Object.entries(map)) {
    if (globalShortcut.isRegistered(accel)) { any = true; continue; }
    try { if (globalShortcut.register(accel, () => send(channel))) any = true; } catch (_) {}
  }
  return any;
}

let accessibilityPrompted = false;
function registerMediaKeys() {
  const transportOk = registerKeys(TRANSPORT_KEYS);
  registerKeys(VOLUME_KEYS);

  // macOS gates hardware media keys behind Accessibility permission; until it's
  // granted, registration silently fails. Guide the user there once.
  if (!transportOk && process.platform === 'darwin' && !accessibilityPrompted) {
    accessibilityPrompted = true;
    if (!systemPreferences.isTrustedAccessibilityClient(false)) promptAccessibility();
  }
  return transportOk;
}

function promptAccessibility() {
  dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    title: 'Enable background media keys',
    message: 'Let ZipTune respond to the keyboard media keys',
    detail: 'macOS requires Accessibility permission for an app to receive the ▶︎ / ⏭ / ⏮ media keys while it is in the background.\n\nOpen System Settings → Privacy & Security → Accessibility, enable ZipTune, then return to the app — the keys will start working automatically.',
    buttons: ['Open Settings', 'Later'],
    defaultId: 0,
    cancelId: 1
  }).then(({ response }) => {
    if (response === 0) {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    }
  }).catch(() => {});
}

// --- IPC: file system access for the renderer ---
ipcMain.handle('stat-file', async (_evt, filePath) => {
  const s = await fs.promises.stat(filePath);
  return { size: s.size, isDirectory: s.isDirectory() };
});

// --- IPC: zip access via yauzl (reads only the central directory + the one
//     requested entry; never inflates the whole archive, never blocks the
//     renderer since it runs here in the main process). ---
function openZipFile(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) reject(err); else resolve(zip);
    });
  });
}

// List entry names without decompressing anything.
ipcMain.handle('zip-list', async (_evt, filePath) => {
  const zip = await openZipFile(filePath);
  return await new Promise((resolve, reject) => {
    const out = [];
    zip.on('entry', (entry) => {
      if (!/\/$/.test(entry.fileName)) out.push({ internalPath: entry.fileName });
      zip.readEntry();
    });
    zip.on('end', () => { zip.close(); resolve(out); });
    zip.on('error', (e) => { try { zip.close(); } catch (_) {} reject(e); });
    zip.readEntry();
  });
});

// Inflate and return the bytes of a single entry only.
ipcMain.handle('zip-entry', async (_evt, filePath, internalPath) => {
  const zip = await openZipFile(filePath);
  return await new Promise((resolve, reject) => {
    let found = false;
    const fail = (e) => { try { zip.close(); } catch (_) {} reject(e); };
    zip.on('entry', (entry) => {
      if (entry.fileName !== internalPath) { zip.readEntry(); return; }
      found = true;
      zip.openReadStream(entry, (err, stream) => {
        if (err) return fail(err);
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('error', fail);
        stream.on('end', () => {
          zip.close();
          const b = Buffer.concat(chunks);
          resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        });
      });
    });
    zip.on('end', () => { if (!found) fail(new Error('entry not found: ' + internalPath)); });
    zip.on('error', fail);
    zip.readEntry();
  });
});

// music-metadata is ESM-only; load it lazily via dynamic import.
let mmPromise = null;
const getMM = () => (mmPromise || (mmPromise = import('music-metadata')));

ipcMain.handle('get-artwork', async (_evt, filePath) => {
  try {
    const mm = await getMM();
    const meta = await mm.parseFile(filePath, { duration: false, skipCovers: false });
    const pics = meta.common && meta.common.picture;
    if (pics && pics.length) {
      const pic = pics[0];
      const u8 = pic.data;
      return {
        mime: pic.format || 'image/jpeg',
        data: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
      };
    }
  } catch (_) { /* no/unreadable tags */ }
  return null;
});

ipcMain.handle('list-dir', async (_evt, dirPath) => {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  return entries.map((e) => ({
    name: e.name,
    path: path.join(dirPath, e.name),
    isDirectory: e.isDirectory()
  }));
});

// Resize the window when toggling the compact mini-player.
let savedBounds = null;
ipcMain.on('set-compact', (_evt, compact) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (compact) {
    savedBounds = mainWindow.getBounds();
    mainWindow.setMinimumSize(300, 130);
    mainWindow.setSize(400, 150, true);
    mainWindow.setAlwaysOnTop(true);
  } else {
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setMinimumSize(760, 520);
    if (savedBounds) mainWindow.setBounds(savedBounds, true);
    else mainWindow.setSize(1040, 720, true);
  }
});

app.whenReady().then(() => {
  createWindow();
  registerMediaKeys();

  // If media keys weren't available at launch (e.g. macOS Accessibility was
  // just granted), retry whenever the app regains focus. isRegistered guards
  // make this a no-op once they're active.
  app.on('browser-window-focus', () => {
    if (!globalShortcut.isRegistered('MediaPlayPause')) {
      registerKeys(TRANSPORT_KEYS);
      registerKeys(VOLUME_KEYS);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // Quit on every platform when the window is closed (including macOS).
  app.quit();
});
