'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Build a file:// URL from an absolute path. Self-contained because a sandboxed
// preload's require('url') does NOT provide pathToFileURL. Handles POSIX and
// Windows paths and percent-encodes each segment (spaces, brackets, #, ?, …).
function toFileURL(p) {
  const resolved = String(p).replace(/\\/g, '/');
  const drive = /^([a-zA-Z]):\/(.*)$/.exec(resolved);
  if (drive) {
    const rest = drive[2].split('/').map(encodeURIComponent).join('/');
    return `file:///${drive[1]}:/${rest}`;
  }
  const encoded = resolved.split('/').map(encodeURIComponent).join('/');
  return 'file://' + (encoded.startsWith('/') ? encoded : '/' + encoded);
}

contextBridge.exposeInMainWorld('api', {
  // Resolve the absolute path of a dropped File (Electron 32+ removed File.path).
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (_) {
      return file && file.path ? file.path : '';
    }
  },

  pathToFileURL: (p) => toFileURL(p),

  statFile: (p) => ipcRenderer.invoke('stat-file', p),
  listDir: (p) => ipcRenderer.invoke('list-dir', p),
  getArtwork: (p) => ipcRenderer.invoke('get-artwork', p),

  // Zip access — listing reads only the directory; entry reads inflate just
  // that one file. Returns ArrayBuffers.
  listZip: (p) => ipcRenderer.invoke('zip-list', p),
  readZipEntry: (p, internalPath) => ipcRenderer.invoke('zip-entry', p, internalPath),

  setCompact: (compact) => ipcRenderer.send('set-compact', compact),

  // Media-key bridge from the main process.
  onMediaKey: (handler) => {
    const channels = [
      'media-playpause', 'media-next', 'media-prev', 'media-stop',
      'media-volup', 'media-voldown', 'media-volmute'
    ];
    for (const ch of channels) {
      ipcRenderer.on(ch, () => handler(ch));
    }
  }
});
