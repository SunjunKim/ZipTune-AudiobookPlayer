'use strict';

/* global naturalCompare */

// ---------------------------------------------------------------------------
// Constants & state
// ---------------------------------------------------------------------------
const AUDIO_EXT = new Set([
  'mp3', 'm4a', 'm4b', 'aac', 'wav', 'wave', 'flac', 'ogg', 'oga',
  'opus', 'weba', 'webm', 'aiff', 'aif', 'aifc', 'wma', 'mp4'
]);
const ZIP_EXT = new Set(['zip']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif']);

let uid = 0;
const state = {
  playlist: [],        // { id, name, kind: 'audio'|'zip', path }
  currentIndex: -1,    // index into playlist of the active main item
  zip: null            // { name, path, mainIndex, entries:[{name,internalPath,blobUrl}], index, coverUrl }
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const audio = $('audio');

const el = {
  npTitle: $('npTitle'), npSub: $('npSub'),
  npArt: $('npArt'), npArtImg: $('npArtImg'),
  compactBtn: $('compactBtn'), compactIcon: $('compactIcon'), expandIcon: $('expandIcon'),
  mainList: $('mainList'), mainCount: $('mainCount'),
  subPanel: $('subPanel'), subList: $('subList'), subZipName: $('subZipName'),
  subCover: $('subCover'), subCoverImg: $('subCoverImg'),
  closeSubBtn: $('closeSubBtn'),
  playBtn: $('playBtn'), playIcon: $('playIcon'), pauseIcon: $('pauseIcon'),
  prevBtn: $('prevBtn'), nextBtn: $('nextBtn'),
  sortBtn: $('sortBtn'), shuffleBtn: $('shuffleBtn'),
  muteBtn: $('muteBtn'), volIcon: $('volIcon'), volume: $('volume'),
  speedSelect: $('speedSelect'),
  seek: $('seek'), curTime: $('curTime'), durTime: $('durTime'),
  dropOverlay: $('dropOverlay'), dropAppend: $('dropAppend'), dropReplace: $('dropReplace')
};

// ---------------------------------------------------------------------------
// File-type helpers
// ---------------------------------------------------------------------------
function extOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}
const isAudio = (name) => AUDIO_EXT.has(extOf(name));
const isZip = (name) => ZIP_EXT.has(extOf(name));
const isImage = (name) => IMAGE_EXT.has(extOf(name));
const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();

const IMAGE_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif'
};
const AUDIO_MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
  wav: 'audio/wav', wave: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/ogg', weba: 'audio/webm', webm: 'audio/webm',
  aiff: 'audio/aiff', aif: 'audio/aiff', aifc: 'audio/aiff', wma: 'audio/x-ms-wma',
  mp4: 'audio/mp4'
};
const mimeFor = (table, name) => table[extOf(name)] || '';

// Wrap an ArrayBuffer from a zip entry in a typed Blob URL.
const blobUrl = (data, type) => URL.createObjectURL(new Blob([data], type ? { type } : undefined));

// ---------------------------------------------------------------------------
// Adding files / directories to the playlist
// ---------------------------------------------------------------------------
async function expandPaths(paths) {
  const out = [];
  for (const p of paths) {
    if (!p) continue;
    let st;
    try { st = await window.api.statFile(p); } catch (_) { continue; }
    if (st.isDirectory) {
      let entries = [];
      try { entries = await window.api.listDir(p); } catch (_) {}
      const childPaths = entries.map((e) => e.path);
      out.push(...await expandPaths(childPaths));
    } else if (isAudio(p) || isZip(p)) {
      out.push(p);
    }
  }
  return out;
}

function makeItem(path) {
  return {
    id: ++uid,
    name: baseName(path),
    kind: isZip(path) ? 'zip' : 'audio',
    path
  };
}

async function addFiles(paths, mode) {
  const files = await expandPaths(paths);
  if (!files.length) return;

  // Requirement 6: when several files arrive at once, order them naturally
  // (aaa1, aaa2 … aaa11, aaa12) before inserting.
  const items = files.map(makeItem);
  items.sort((a, b) => naturalCompare(a.name, b.name));

  if (mode === 'replace') {
    exitZip(false);
    revokeThumbs(state.playlist);
    state.playlist = items;
    renderMainList();
    playIndex(0, false); // select & load, but don't auto-play
  } else {
    const wasEmpty = state.playlist.length === 0;
    state.playlist.push(...items);
    renderMainList();
    if (wasEmpty) playIndex(0, false);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const EQ_SVG = '<svg class="eq" viewBox="0 0 24 24" width="14" height="14"><path d="M6 10v4M11 6v12M16 8v8M21 11v2" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

function renderMainList() {
  el.mainCount.textContent = `${state.playlist.length} track${state.playlist.length === 1 ? '' : 's'}`;
  el.mainList.innerHTML = '';

  if (!state.playlist.length) {
    const li = document.createElement('li');
    li.className = 'empty-hint';
    li.innerHTML = 'Drop audio files, folders, or a <b>.zip</b> here.<br>Drag tracks to reorder.';
    el.mainList.appendChild(li);
    return;
  }

  state.playlist.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = 'track' + (i === state.currentIndex ? ' active' : '');
    li.draggable = true;
    li.dataset.index = String(i);

    const playing = i === state.currentIndex && !audio.paused;
    li.innerHTML =
      `<span class="art">${artInner(item, i, playing)}</span>` +
      `<span class="name">${escapeHtml(item.name)}</span>` +
      (item.kind === 'zip' ? '<span class="badge">ZIP</span>' : '') +
      '<span class="remove" title="Remove">✕</span>';

    li.addEventListener('click', (e) => {
      if (e.target.classList.contains('remove')) { removeItem(i); return; }
      playIndex(i);
    });

    attachReorderHandlers(li);
    el.mainList.appendChild(li);
    scheduleThumb(item);
  });
}

// Inner HTML for a main-list item's left thumbnail box: artwork if we have it,
// otherwise the track number (or a 📦 for archives), with a playing overlay.
function artInner(item, i, playing) {
  if (item.thumbUrl) {
    return `<img src="${item.thumbUrl}" alt="">` +
      (playing ? `<span class="eqover">${EQ_SVG}</span>` : '');
  }
  if (playing) return EQ_SVG;
  return item.kind === 'zip' ? '📦' : String(i + 1);
}

// ---------------------------------------------------------------------------
// Embedded artwork thumbnails (requirement: per-item cover icon)
//   audio -> embedded tag picture (parsed in main via music-metadata)
//   zip   -> first/preferred image inside the archive (extracted in main via yauzl)
// Extraction is lazy, cached on the item, and throttled.
// ---------------------------------------------------------------------------
const THUMB_CONCURRENCY = 3;
let thumbActive = 0;
const thumbQueue = [];

function scheduleThumb(item) {
  if (item.thumbTried) return;
  item.thumbTried = true;
  thumbQueue.push(item);
  pumpThumbs();
}

function pumpThumbs() {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
    const item = thumbQueue.shift();
    thumbActive++;
    extractThumb(item)
      .catch(() => {})
      .finally(() => { thumbActive--; pumpThumbs(); });
  }
}

async function extractThumb(item) {
  let url = null;
  if (item.kind === 'zip') {
    const list = await window.api.listZip(item.path);
    const pick = pickCover(list.map((e) => e.internalPath).filter(isImage));
    if (pick) {
      const data = await window.api.readZipEntry(item.path, pick);
      url = blobUrl(data, mimeFor(IMAGE_MIME, pick));
    }
  } else {
    const art = await window.api.getArtwork(item.path);
    if (art && art.data) url = blobUrl(art.data, art.mime);
  }
  if (url) {
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    item.thumbUrl = url;
    applyThumb(item);
  }
}

// Patch the already-rendered list node in place (avoids a full re-render).
function applyThumb(item) {
  const i = state.playlist.indexOf(item);
  if (i < 0) return;
  const li = el.mainList.querySelector(`.track[data-index="${i}"]`);
  const art = li && li.querySelector('.art');
  if (art) {
    const playing = i === state.currentIndex && !audio.paused;
    art.innerHTML = artInner(item, i, playing);
  }
  if (i === state.currentIndex && !state.zip) refreshNowArt();
}

function revokeThumbs(items) {
  for (const it of items) {
    if (it.thumbUrl) { URL.revokeObjectURL(it.thumbUrl); it.thumbUrl = null; }
  }
}

function renderSubList() {
  if (!state.zip) return;
  el.subZipName.textContent = state.zip.name;
  el.subList.innerHTML = '';
  state.zip.entries.forEach((entry, i) => {
    const li = document.createElement('li');
    li.className = 'track' + (i === state.zip.index ? ' active' : '');
    const playing = i === state.zip.index && !audio.paused;
    li.innerHTML =
      `<span class="idx">${playing ? EQ_SVG : i + 1}</span>` +
      `<span class="name">${escapeHtml(entry.name)}</span>`;
    li.addEventListener('click', () => playSub(i));
    el.subList.appendChild(li);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function removeItem(i) {
  const wasCurrent = i === state.currentIndex;
  revokeThumbs([state.playlist[i]]);
  state.playlist.splice(i, 1);
  if (i < state.currentIndex) state.currentIndex--;
  else if (wasCurrent) {
    exitZip(false);
    state.currentIndex = -1;
    audio.removeAttribute('src');
    audio.load();
    updateNowPlaying();
  }
  renderMainList();
}

// ---------------------------------------------------------------------------
// Playback — main playlist
// ---------------------------------------------------------------------------
function playIndex(i, autoplay = true) {
  if (i < 0 || i >= state.playlist.length) return;
  // Selecting any main item closes an open archive (requirement 5).
  exitZip(false);
  state.currentIndex = i;
  const item = state.playlist[i];

  if (item.kind === 'zip') {
    // A zip is only opened (and its sub-playlist built) when actually played.
    if (autoplay) openZip(item, i);
    else { audio.removeAttribute('src'); audio.load(); }
  } else {
    audio.src = window.api.pathToFileURL(item.path);
    if (autoplay) audio.play().catch(() => {});
  }
  updateNowPlaying();
  renderMainList();
}

function nextMain() {
  if (state.currentIndex + 1 < state.playlist.length) {
    playIndex(state.currentIndex + 1);
  } else {
    stopPlayback();
  }
}

function prevMain() {
  if (state.currentIndex > 0) playIndex(state.currentIndex - 1);
  else if (state.playlist.length) playIndex(0);
}

function stopPlayback() {
  exitZip(false);
  audio.pause();
  audio.currentTime = 0;
  state.currentIndex = -1;
  updateNowPlaying();
  renderMainList();
}

// ---------------------------------------------------------------------------
// Playback — zip archives (secondary playlist, requirement 5)
// ---------------------------------------------------------------------------
async function openZip(item, mainIndex) {
  let list;
  try {
    // Only the directory is read here — no archive-wide decompression.
    list = await window.api.listZip(item.path);
  } catch (e) {
    console.error('Failed to read zip', e);
    nextMain();
    return;
  }

  const entries = [];
  const images = [];
  for (const { internalPath } of list) {
    if (isAudio(internalPath)) {
      entries.push({ name: baseName(internalPath), internalPath, blobUrl: null });
    } else if (isImage(internalPath)) {
      images.push(internalPath);
    }
  }
  entries.sort((a, b) => naturalCompare(a.name, b.name));

  if (!entries.length) {
    nextMain();
    return;
  }

  state.zip = { name: item.name, path: item.path, mainIndex, entries, index: -1, coverUrl: null };
  el.subPanel.classList.remove('hidden');
  renderSubList();
  loadCover(pickCover(images));
  playSub(0);
}

// Prefer common artwork names (cover/folder/front/album/art), otherwise the
// first image in natural order.
function pickCover(images) {
  if (!images.length) return null;
  const PREF = /(cover|folder|front|album|art(work)?)/i;
  const sorted = images.slice().sort((a, b) => naturalCompare(baseName(a), baseName(b)));
  return sorted.find((p) => PREF.test(baseName(p))) || sorted[0];
}

async function loadCover(internalPath) {
  el.subCover.classList.add('hidden');
  el.subCoverImg.removeAttribute('src');
  if (!internalPath || !state.zip) return;
  const zipPath = state.zip.path;
  try {
    const data = await window.api.readZipEntry(zipPath, internalPath);
    if (!state.zip || state.zip.path !== zipPath) return; // archive changed/closed
    state.zip.coverUrl = blobUrl(data, mimeFor(IMAGE_MIME, internalPath));
    el.subCoverImg.src = state.zip.coverUrl;
    el.subCover.classList.remove('hidden');
    refreshNowArt();
  } catch (e) {
    console.error('Failed to load cover', internalPath, e);
  }
}

async function playSub(i) {
  if (!state.zip || i < 0 || i >= state.zip.entries.length) return;
  state.zip.index = i;
  const entry = state.zip.entries[i];
  const zipPath = state.zip.path;

  if (!entry.blobUrl) {
    try {
      // Inflate only this one track, off the renderer thread.
      const data = await window.api.readZipEntry(zipPath, entry.internalPath);
      entry.blobUrl = blobUrl(data, mimeFor(AUDIO_MIME, entry.name));
    } catch (e) {
      console.error('Failed to extract entry', entry.internalPath, e);
      if (!state.zip || state.zip.path !== zipPath) return;
      // Skip to the next entry in the archive.
      if (i + 1 < state.zip.entries.length) return playSub(i + 1);
      exitZip(true);
      return;
    }
  }
  // The archive may have been closed or switched while we were inflating.
  if (!state.zip || state.zip.path !== zipPath || state.zip.index !== i) return;
  audio.src = entry.blobUrl;
  audio.play().catch(() => {});
  updateNowPlaying();
  renderSubList();
  renderMainList();
}

function nextSub() {
  if (!state.zip) return;
  if (state.zip.index + 1 < state.zip.entries.length) {
    playSub(state.zip.index + 1);
  } else {
    // End of archive → close it and advance the main playlist.
    exitZip(true);
  }
}

function prevSub() {
  if (!state.zip) return;
  if (state.zip.index > 0) playSub(state.zip.index - 1);
  else prevMain();
}

// advance=true → after closing, continue to the next main track.
function exitZip(advance) {
  if (!state.zip) return;
  const fromIndex = state.zip.mainIndex;
  // Release extracted blobs.
  for (const e of state.zip.entries) {
    if (e.blobUrl) URL.revokeObjectURL(e.blobUrl);
  }
  if (state.zip.coverUrl) URL.revokeObjectURL(state.zip.coverUrl);
  state.zip = null;
  el.subPanel.classList.add('hidden');
  el.subList.innerHTML = '';
  el.subCover.classList.add('hidden');
  el.subCoverImg.removeAttribute('src');

  if (advance) {
    if (fromIndex + 1 < state.playlist.length) {
      playIndex(fromIndex + 1);
    } else {
      stopPlayback();
    }
  }
}

// ---------------------------------------------------------------------------
// Unified transport actions
// ---------------------------------------------------------------------------
function togglePlay() {
  if (state.currentIndex < 0) {
    if (state.playlist.length) playIndex(0, true);
    return;
  }
  // Selected but nothing loaded yet (just dropped, or a zip not yet opened):
  // start it now.
  if (!state.zip && !audio.src) { playIndex(state.currentIndex, true); return; }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

// Jump within the current track.
function seekBy(seconds) {
  if (!audio.src || !isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
}

function next() {
  if (state.zip) nextSub();
  else nextMain();
}

function prev() {
  // Restart current track if we're more than 3s in.
  if (audio.src && audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (state.zip) prevSub();
  else prevMain();
}

function onEnded() {
  if (state.zip) nextSub();
  else nextMain();
}

// ---------------------------------------------------------------------------
// Now-playing display & control sync
// ---------------------------------------------------------------------------
function updateNowPlaying() {
  if (state.zip) {
    const e = state.zip.entries[state.zip.index];
    // In the mini window the sub-line is hidden, so show "zip / track.ext".
    el.npTitle.textContent = (compactMode && e)
      ? `${state.zip.name} / ${e.name}`
      : (e ? e.name : state.zip.name);
    el.npSub.textContent = `📦 ${state.zip.name} — ${state.zip.index + 1}/${state.zip.entries.length}`;
  } else if (state.currentIndex >= 0) {
    const item = state.playlist[state.currentIndex];
    el.npTitle.textContent = item.name;
    el.npSub.textContent = `Track ${state.currentIndex + 1} of ${state.playlist.length}`;
  } else {
    el.npTitle.textContent = 'Nothing playing';
    el.npSub.textContent = 'Drop audio files or a .zip to begin';
  }
  refreshNowArt();
}

// Show the current item's cover (zip cover or embedded thumbnail) in the header;
// falls back to the headphone placeholder.
function refreshNowArt() {
  const url = state.zip
    ? state.zip.coverUrl
    : (state.currentIndex >= 0 ? state.playlist[state.currentIndex].thumbUrl : null);
  if (url) {
    el.npArtImg.src = url;
    el.npArtImg.classList.remove('hidden');
    el.npArt.classList.add('has-art');
  } else {
    el.npArtImg.removeAttribute('src');
    el.npArtImg.classList.add('hidden');
    el.npArt.classList.remove('has-art');
  }
}

function syncPlayButton() {
  const playing = !audio.paused && !!audio.src;
  el.playIcon.classList.toggle('hidden', playing);
  el.pauseIcon.classList.toggle('hidden', !playing);
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------
let lastVolume = 0.8;
function setVolume(v) {
  v = Math.max(0, Math.min(1, v));
  audio.volume = v;
  audio.muted = v === 0;
  el.volume.value = String(Math.round(v * 100));
  el.muteBtn.classList.toggle('toggle-on', audio.muted);
}
function toggleMute() {
  if (audio.volume > 0 && !audio.muted) {
    lastVolume = audio.volume;
    setVolume(0);
  } else {
    setVolume(lastVolume || 0.8);
  }
}

// ---------------------------------------------------------------------------
// Playback speed (0.5×–3× in 0.5 steps)
// ---------------------------------------------------------------------------
// Loading new media resets playbackRate to defaultPlaybackRate, so we set both
// and re-apply on loadedmetadata to keep the chosen speed across tracks.
function applySpeed() {
  const rate = Number(el.speedSelect.value) || 1;
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;
}

// Set the speed programmatically (e.g. from the 1/2/3 keys) and keep the
// dropdown in sync. Only applies values the selector actually offers.
function setSpeed(rate) {
  const opt = [...el.speedSelect.options].find((o) => Number(o.value) === rate);
  if (!opt) return;
  el.speedSelect.value = opt.value;
  applySpeed();
}

// ---------------------------------------------------------------------------
// Sort & shuffle (requirement 9)
// ---------------------------------------------------------------------------
function rememberCurrentId() {
  return state.currentIndex >= 0 ? state.playlist[state.currentIndex].id : null;
}
function restoreCurrentById(id) {
  if (id == null) return;
  const i = state.playlist.findIndex((it) => it.id === id);
  if (i >= 0) state.currentIndex = i;
}

function sortList() {
  const id = rememberCurrentId();
  state.playlist.sort((a, b) => naturalCompare(a.name, b.name));
  restoreCurrentById(id);
  if (state.zip) state.zip.mainIndex = state.currentIndex;
  renderMainList();
}

function shuffleList() {
  const id = rememberCurrentId();
  const a = state.playlist;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  restoreCurrentById(id);
  if (state.zip) state.zip.mainIndex = state.currentIndex;
  renderMainList();
}

// ---------------------------------------------------------------------------
// Drag-to-reorder within the main playlist (requirement 8)
// ---------------------------------------------------------------------------
let dragFromIndex = -1;
function attachReorderHandlers(li) {
  li.addEventListener('dragstart', (e) => {
    dragFromIndex = Number(li.dataset.index);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Mark as an internal reorder so the file-drop overlay stays hidden.
    e.dataTransfer.setData('application/x-ziptune-reorder', '1');
  });
  li.addEventListener('dragend', () => {
    dragFromIndex = -1;
    li.classList.remove('dragging');
    clearDropMarkers();
  });
  li.addEventListener('dragover', (e) => {
    if (dragFromIndex < 0) return; // external file drag handled elsewhere
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const before = isBeforeHalf(e, li);
    clearDropMarkers();
    li.classList.add(before ? 'drop-before' : 'drop-after');
  });
  li.addEventListener('drop', (e) => {
    if (dragFromIndex < 0) return;
    e.preventDefault();
    e.stopPropagation();
    let to = Number(li.dataset.index);
    const before = isBeforeHalf(e, li);
    reorder(dragFromIndex, to, before);
    clearDropMarkers();
  });
}

function isBeforeHalf(e, li) {
  const r = li.getBoundingClientRect();
  return (e.clientY - r.top) < r.height / 2;
}
function clearDropMarkers() {
  el.mainList.querySelectorAll('.drop-before, .drop-after')
    .forEach((n) => n.classList.remove('drop-before', 'drop-after'));
}

function reorder(from, to, before) {
  if (from === to) return;
  const id = rememberCurrentId();
  const [moved] = state.playlist.splice(from, 1);
  // Recompute target index after removal.
  let insertAt = to;
  if (from < to) insertAt = before ? to - 1 : to;
  else insertAt = before ? to : to + 1;
  insertAt = Math.max(0, Math.min(state.playlist.length, insertAt));
  state.playlist.splice(insertAt, 0, moved);
  restoreCurrentById(id);
  if (state.zip) state.zip.mainIndex = state.currentIndex;
  renderMainList();
}

// ---------------------------------------------------------------------------
// External file drag & drop with split drop zone (requirement 4)
// ---------------------------------------------------------------------------
let dragDepth = 0;

function isFileDrag(e) {
  // True only for OS file drags, not internal reorder drags.
  if (dragFromIndex >= 0) return false;
  const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
  return types.includes('Files');
}

window.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  el.dropOverlay.classList.remove('hidden');
});

window.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (e) => {
  if (dragFromIndex >= 0) return;
  dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    hideOverlay();
  }
});

window.addEventListener('drop', (e) => {
  // Catch-all so files dropped anywhere don't navigate the window.
  if (dragFromIndex >= 0) return;
  e.preventDefault();
  hideOverlay();
});

function hideOverlay() {
  dragDepth = 0;
  el.dropOverlay.classList.add('hidden');
  el.dropAppend.classList.remove('hot');
  el.dropReplace.classList.remove('hot');
}

function pathsFromDrop(e) {
  const files = e.dataTransfer.files;
  const paths = [];
  for (const f of files) {
    const p = window.api.getPathForFile(f);
    if (p) paths.push(p);
  }
  return paths;
}

[['dropAppend', 'append'], ['dropReplace', 'replace']].forEach(([id, mode]) => {
  const zone = el[id];
  zone.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    zone.classList.add('hot');
  });
  zone.addEventListener('dragleave', (e) => {
    e.stopPropagation();
    zone.classList.remove('hot');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const paths = pathsFromDrop(e);
    hideOverlay();
    if (paths.length) addFiles(paths, mode);
  });
});

// ---------------------------------------------------------------------------
// Wiring: buttons, audio events, media keys
// ---------------------------------------------------------------------------
el.playBtn.addEventListener('click', togglePlay);
el.prevBtn.addEventListener('click', prev);
el.nextBtn.addEventListener('click', next);
el.sortBtn.addEventListener('click', sortList);
el.shuffleBtn.addEventListener('click', shuffleList);
el.muteBtn.addEventListener('click', toggleMute);
el.closeSubBtn.addEventListener('click', () => exitZip(false));

// Full / compact (mini-player) mode toggle.
let compactMode = false;
function setCompactMode(on) {
  compactMode = on;
  document.body.classList.toggle('compact', on);
  el.compactIcon.classList.toggle('hidden', on);
  el.expandIcon.classList.toggle('hidden', !on);
  el.compactBtn.title = on ? 'Exit compact mode' : 'Compact mode';
  window.api.setCompact(on);
  updateNowPlaying(); // title format differs between full/compact for zips
}
el.compactBtn.addEventListener('click', () => setCompactMode(!compactMode));

el.volume.addEventListener('input', () => setVolume(Number(el.volume.value) / 100));
el.speedSelect.addEventListener('change', applySpeed);

el.seek.addEventListener('input', () => {
  if (audio.duration) {
    audio.currentTime = (Number(el.seek.value) / 1000) * audio.duration;
  }
});

audio.addEventListener('play', () => { syncPlayButton(); renderMainList(); renderSubList(); });
audio.addEventListener('pause', () => { syncPlayButton(); renderMainList(); renderSubList(); });
audio.addEventListener('ended', onEnded);
audio.addEventListener('timeupdate', () => {
  el.curTime.textContent = fmtTime(audio.currentTime);
  if (audio.duration) {
    el.seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
  }
});
audio.addEventListener('loadedmetadata', () => {
  el.durTime.textContent = fmtTime(audio.duration);
  applySpeed(); // new media resets the rate; restore the selected speed
});
audio.addEventListener('error', () => {
  // Skip unplayable tracks automatically.
  if (state.currentIndex >= 0 || state.zip) setTimeout(next, 250);
});

// Keyboard shortcuts (within the window) in addition to OS media keys.
//   Space            play / pause
//   ← / →            seek -5s / +5s
//   Ctrl+← / Ctrl+→  seek -30s / +30s
//   ↑ / ↓            volume up / down
//   PageUp/PageDown  previous / next track
//   Cmd+← / Cmd+→    previous / next track
const VOL_STEP = 0.05;
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  switch (e.code) {
    case 'Space': e.preventDefault(); togglePlay(); break;
    case 'ArrowRight':
      e.preventDefault();
      if (e.metaKey) next();
      else if (e.ctrlKey) seekBy(30);
      else seekBy(5);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (e.metaKey) prev();
      else if (e.ctrlKey) seekBy(-30);
      else seekBy(-5);
      break;
    case 'ArrowUp': e.preventDefault(); setVolume(audio.volume + VOL_STEP); break;
    case 'ArrowDown': e.preventDefault(); setVolume(audio.volume - VOL_STEP); break;
    case 'PageUp': e.preventDefault(); prev(); break;
    case 'PageDown': e.preventDefault(); next(); break;
    // 1 / 2 / 3 → playback speed 1× / 2× / 3× (top-row and numpad).
    case 'Digit1': case 'Numpad1': e.preventDefault(); setSpeed(1); break;
    case 'Digit2': case 'Numpad2': e.preventDefault(); setSpeed(2); break;
    case 'Digit3': case 'Numpad3': e.preventDefault(); setSpeed(3); break;
  }
});

// OS media keys (requirement 7).
window.api.onMediaKey((key) => {
  switch (key) {
    case 'media-playpause': togglePlay(); break;
    case 'media-next': next(); break;
    case 'media-prev': prev(); break;
    case 'media-stop': stopPlayback(); break;
    case 'media-volup': setVolume(audio.volume + 0.05); break;
    case 'media-voldown': setVolume(audio.volume - 0.05); break;
    case 'media-volmute': toggleMute(); break;
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
setVolume(0.8);
applySpeed();
renderMainList();
updateNowPlaying();
syncPlayButton();
