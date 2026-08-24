// ---------- Config ----------
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_CANVAS_DIMENSION = 6000; // safety cap so a huge image can't hang the tab
const DEFAULT_QUALITY = 0.75;
const SLIDER_DEBOUNCE_MS = 300;

// ---------- State ----------
// Each entry: { id, file, url, name, size, type, status, compressedBlob,
//               compressedSize, errorMessage, originalWidth, originalHeight,
//               processedWidth, processedHeight, wasDownscaled, resizeRequested }
// status: 'pending' | 'compressing' | 'done' | 'no-improvement' | 'error'
let images = [];
let quality = DEFAULT_QUALITY;
let maxDimension = 0; // 0 = "Original" - no user-requested resize, only the safety cap applies
let sliderDebounceTimer = null;
let isZipping = false;

// ---------- DOM refs ----------
const dropzoneEl = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const browseBtn = document.getElementById('browse-btn');
const addMoreBtn = document.getElementById('add-more-btn');
const clearAllBtn = document.getElementById('clear-all-btn');
const downloadAllBtn = document.getElementById('download-all-btn');
const workspaceEl = document.getElementById('workspace');
const imageGridEl = document.getElementById('image-grid');
const imageCountEl = document.getElementById('image-count');
const toastContainer = document.getElementById('toast-container');
const qualitySlider = document.getElementById('quality-slider');
const qualityValueEl = document.getElementById('quality-value');
const resizeSelect = document.getElementById('resize-select');
const summaryEl = document.getElementById('summary');

// ---------- Utilities ----------
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function generateId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';

  const text = document.createElement('span');
  text.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => toast.remove());

  toast.append(text, closeBtn);
  toastContainer.appendChild(toast);

  setTimeout(() => toast.remove(), 6000);
}

// ---------- File handling ----------
function validateFile(file) {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return `"${file.name}" isn't a supported image type. Use JPG, PNG, or WebP.`;
  }
  if (file.size > MAX_FILE_SIZE) {
    return `"${file.name}" is too large (${formatBytes(file.size)}). Max size is ${formatBytes(MAX_FILE_SIZE)}.`;
  }
  if (file.size === 0) {
    return `"${file.name}" appears to be empty.`;
  }
  return null;
}

function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;

  const newEntries = [];

  files.forEach((file) => {
    const error = validateFile(file);
    if (error) {
      showToast(error);
      return;
    }

    const entry = {
      id: generateId(),
      file,
      url: URL.createObjectURL(file),
      name: file.name,
      size: file.size,
      type: file.type,
      status: 'pending',
      compressedBlob: null,
      compressedSize: null,
      compressedUrl: null,
      errorMessage: null,
      originalWidth: null,
      originalHeight: null,
      processedWidth: null,
      processedHeight: null,
      wasDownscaled: false,
      resizeRequested: false,
    };
    images.push(entry);
    newEntries.push(entry);
  });

  render();
  if (newEntries.length) compressEntries(newEntries);
}

function revokeEntryUrls(entry) {
  URL.revokeObjectURL(entry.url);
  if (entry.compressedUrl) URL.revokeObjectURL(entry.compressedUrl);
}

function removeImage(id) {
  const entry = images.find((img) => img.id === id);
  if (entry) revokeEntryUrls(entry);
  images = images.filter((img) => img.id !== id);
  render();
}

function clearAll() {
  images.forEach(revokeEntryUrls);
  images = [];
  render();
}

// ---------- Compression ----------
// Draws the image onto an off-screen canvas and re-encodes it with the
// browser's built-in encoder via canvas.toBlob(). This performs genuine
// lossy re-encoding for JPEG/WebP (the quality argument controls it); PNG
// encoding is always lossless per the Canvas spec, so quality has no effect
// there — the caller compares sizes and handles that case explicitly.
function compressImage(entry, targetQuality, targetMaxDimension) {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      const originalWidth = img.naturalWidth;
      const originalHeight = img.naturalHeight;
      let width = originalWidth;
      let height = originalHeight;
      let downscaled = false;
      const resizeRequested = targetMaxDimension > 0;

      // The user's chosen max size and the hard safety cap both limit the
      // canvas; whichever is smaller wins. This keeps aspect ratio intact
      // since both dimensions are scaled by the same factor.
      const effectiveCap = resizeRequested
        ? Math.min(MAX_CANVAS_DIMENSION, targetMaxDimension)
        : MAX_CANVAS_DIMENSION;

      if (width > effectiveCap || height > effectiveCap) {
        const scale = Math.min(effectiveCap / width, effectiveCap / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        downscaled = true;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas is not supported in this browser.'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('The browser could not encode this image.'));
            return;
          }
          resolve({ blob, originalWidth, originalHeight, width, height, downscaled, resizeRequested });
        },
        entry.type,
        targetQuality
      );
    };

    img.onerror = () => reject(new Error('Could not read this image file.'));
    img.src = entry.url;
  });
}

async function compressOne(entry) {
  if (entry.status === 'compressing') return; // already in flight, avoid duplicate work
  entry.status = 'compressing';
  entry.errorMessage = null;
  render();

  try {
    const result = await compressImage(entry, quality, maxDimension);
    entry.originalWidth = result.originalWidth;
    entry.originalHeight = result.originalHeight;
    entry.processedWidth = result.width;
    entry.processedHeight = result.height;
    entry.wasDownscaled = result.downscaled;
    entry.resizeRequested = result.resizeRequested;

    if (entry.compressedUrl) {
      URL.revokeObjectURL(entry.compressedUrl); // drop the previous run's preview URL, if any
      entry.compressedUrl = null;
    }

    if (result.blob.size >= entry.size) {
      // Never hand back something bigger than the original.
      entry.compressedBlob = null;
      entry.compressedSize = null;
      entry.status = 'no-improvement';
    } else {
      entry.compressedBlob = result.blob;
      entry.compressedSize = result.blob.size;
      entry.compressedUrl = URL.createObjectURL(result.blob);
      entry.status = 'done';
    }
  } catch (err) {
    entry.status = 'error';
    entry.errorMessage = err.message || 'Compression failed.';
  }

  render();
}

async function compressEntries(entries) {
  for (const entry of entries) {
    await compressOne(entry);
  }
}

// ---------- Rendering ----------
function buildStatsContent(entry) {
  const wrap = document.createElement('div');
  wrap.className = 'image-stats';

  if (entry.status === 'pending' || entry.status === 'compressing') {
    const line = document.createElement('p');
    line.className = 'stat-line stat-pulse';
    line.textContent = entry.status === 'pending' ? 'Queued…' : 'Compressing…';
    wrap.appendChild(line);
    return wrap;
  }

  if (entry.status === 'error') {
    const line = document.createElement('p');
    line.className = 'stat-line stat-error';
    line.textContent = entry.errorMessage || 'Compression failed.';
    wrap.appendChild(line);

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'retry-btn';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', () => compressOne(entry));
    wrap.appendChild(retryBtn);
    return wrap;
  }

  if (entry.status === 'no-improvement') {
    const line = document.createElement('p');
    line.className = 'stat-line';
    line.textContent =
      entry.type === 'image/png' && !entry.resizeRequested
        ? `${formatBytes(entry.size)} · PNG is lossless — try Max size for bigger savings`
        : `${formatBytes(entry.size)} · already at its smallest`;
    wrap.appendChild(line);
    appendDownscaleNote(wrap, entry);
    return wrap;
  }

  // status === 'done'
  const line = document.createElement('p');
  line.className = 'stat-line';
  line.textContent = `${formatBytes(entry.size)} → ${formatBytes(entry.compressedSize)}`;
  wrap.appendChild(line);

  const percent = Math.round((1 - entry.compressedSize / entry.size) * 100);
  const badge = document.createElement('span');
  badge.className = 'stat-badge';
  badge.textContent = `-${percent}%`;
  wrap.appendChild(badge);

  appendDownscaleNote(wrap, entry);
  return wrap;
}

function appendDownscaleNote(wrap, entry) {
  if (!entry.wasDownscaled) return;
  const note = document.createElement('p');
  note.className = 'stat-line stat-note';
  note.textContent = entry.resizeRequested
    ? `Resized to ${entry.processedWidth}×${entry.processedHeight}`
    : `Downscaled from ${entry.originalWidth}×${entry.originalHeight} to ${entry.processedWidth}×${entry.processedHeight} to keep things fast`;
  wrap.appendChild(note);
}

// ---------- Download ----------
function buildDownloadName(entry) {
  const dotIndex = entry.name.lastIndexOf('.');
  if (dotIndex <= 0) return `${entry.name}-compressed`;
  const base = entry.name.slice(0, dotIndex);
  const ext = entry.name.slice(dotIndex);
  return `${base}-compressed${ext}`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Delay revoking so the browser has time to actually start reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadEntry(entry) {
  if (entry.status === 'done' && entry.compressedBlob) {
    triggerDownload(entry.compressedBlob, buildDownloadName(entry));
  } else if (entry.status === 'no-improvement') {
    // Nothing we produced beat the original, so hand back the original bytes.
    triggerDownload(entry.file, entry.name);
  }
}

function isDownloadable(entry) {
  return entry.status === 'done' || entry.status === 'no-improvement';
}

// Avoids silently dropping files inside the zip when two uploads share a name.
function uniqueZipName(name, usedNames) {
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  const dotIndex = name.lastIndexOf('.');
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const ext = dotIndex > 0 ? name.slice(dotIndex) : '';
  let counter = 1;
  let candidate;
  do {
    candidate = `${base} (${counter})${ext}`;
    counter++;
  } while (usedNames.has(candidate));
  usedNames.add(candidate);
  return candidate;
}

async function downloadAllAsZip() {
  if (isZipping) return;
  const eligible = images.filter(isDownloadable);
  if (!eligible.length) return;

  const skipped = images.length - eligible.length;
  isZipping = true;
  downloadAllBtn.disabled = true;
  downloadAllBtn.textContent = 'Zipping…';

  try {
    const zip = new JSZip();
    const usedNames = new Set();

    eligible.forEach((entry) => {
      const blob = entry.status === 'done' ? entry.compressedBlob : entry.file;
      const name = entry.status === 'done' ? buildDownloadName(entry) : entry.name;
      zip.file(uniqueZipName(name, usedNames), blob);
    });

    // STORE, not DEFLATE: the images inside are already compressed, so
    // re-compressing the zip itself would just burn CPU for no size benefit.
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    triggerDownload(zipBlob, 'compressed-images.zip');

    if (skipped > 0) {
      showToast(`${skipped} image${skipped === 1 ? "" : "s"} left out of the zip (still processing or failed to compress).`);
    }
  } catch (err) {
    showToast('Could not build the zip file. Please try again.');
  } finally {
    isZipping = false;
    downloadAllBtn.textContent = 'Download all (.zip)';
    downloadAllBtn.disabled = !images.some(isDownloadable);
  }
}

// ---------- Before/after compare slider ----------
// Drag anywhere in the thumbnail to reveal more/less of the original image,
// which sits clipped on top of the compressed one. Pointer Events cover
// mouse, touch, and pen with one code path.
function setupCompareSlider(container, dividerEl, beforeWrapEl) {
  function setPercent(percent) {
    const clamped = Math.min(100, Math.max(0, percent));
    beforeWrapEl.style.clipPath = `inset(0 ${100 - clamped}% 0 0)`;
    dividerEl.style.left = `${clamped}%`;
  }

  function percentFromEvent(e) {
    const rect = container.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * 100;
  }

  let dragging = false;

  container.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.remove-btn')) return;
    dragging = true;
    try {
      container.setPointerCapture(e.pointerId);
    } catch {
      // Capture is best-effort - dragging still works via pointermove as long as
      // the pointer stays over the container.
    }
    setPercent(percentFromEvent(e));
  });
  container.addEventListener('pointermove', (e) => {
    if (dragging) setPercent(percentFromEvent(e));
  });
  container.addEventListener('pointerup', () => {
    dragging = false;
  });
  container.addEventListener('pointercancel', () => {
    dragging = false;
  });

  setPercent(50);
}

function buildThumb(entry) {
  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'image-thumb';

  if (entry.status === 'done' && entry.compressedUrl) {
    thumbWrap.classList.add('image-thumb--compare');

    const afterImg = document.createElement('img');
    afterImg.className = 'thumb-after';
    afterImg.src = entry.compressedUrl;
    afterImg.alt = `${entry.name} (compressed)`;
    thumbWrap.appendChild(afterImg);

    const beforeWrap = document.createElement('div');
    beforeWrap.className = 'compare-before-wrap';
    const beforeImg = document.createElement('img');
    beforeImg.className = 'thumb-before';
    beforeImg.src = entry.url;
    beforeImg.alt = `${entry.name} (original)`;
    beforeWrap.appendChild(beforeImg);
    thumbWrap.appendChild(beforeWrap);

    const labelBefore = document.createElement('span');
    labelBefore.className = 'compare-label compare-label--before';
    labelBefore.textContent = 'Original';
    thumbWrap.appendChild(labelBefore);

    const labelAfter = document.createElement('span');
    labelAfter.className = 'compare-label compare-label--after';
    labelAfter.textContent = 'Compressed';
    thumbWrap.appendChild(labelAfter);

    const divider = document.createElement('div');
    divider.className = 'compare-divider';
    const handle = document.createElement('span');
    handle.className = 'compare-handle';
    handle.textContent = '↔';
    divider.appendChild(handle);
    thumbWrap.appendChild(divider);

    setupCompareSlider(thumbWrap, divider, beforeWrap);
  } else {
    const img = document.createElement('img');
    img.src = entry.url;
    img.alt = entry.name;
    thumbWrap.appendChild(img);
  }

  return thumbWrap;
}

function createImageCard(entry) {
  const card = document.createElement('article');
  card.className = 'image-card';
  card.dataset.id = entry.id;

  const thumbWrap = buildThumb(entry);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn';
  removeBtn.setAttribute('aria-label', `Remove ${entry.name}`);
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => removeImage(entry.id));
  thumbWrap.appendChild(removeBtn);

  const info = document.createElement('div');
  info.className = 'image-info';

  const name = document.createElement('p');
  name.className = 'image-name';
  name.textContent = entry.name;
  name.title = entry.name;

  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'download-btn';
  downloadBtn.textContent = 'Download';
  downloadBtn.setAttribute('aria-label', `Download ${entry.name}`);
  downloadBtn.disabled = !isDownloadable(entry);
  downloadBtn.addEventListener('click', () => downloadEntry(entry));

  info.append(name, buildStatsContent(entry), downloadBtn);
  card.append(thumbWrap, info);
  return card;
}

function updateSummary() {
  if (!images.length) {
    summaryEl.textContent = '';
    return;
  }

  const totalOriginal = images.reduce((sum, e) => sum + e.size, 0);
  const totalCompressed = images.reduce((sum, e) => sum + (e.compressedSize ?? e.size), 0);
  const saved = totalOriginal > 0 ? Math.round((1 - totalCompressed / totalOriginal) * 100) : 0;

  summaryEl.innerHTML = '';
  summaryEl.append(`${formatBytes(totalOriginal)} → ${formatBytes(totalCompressed)} · `);
  const strong = document.createElement('strong');
  strong.textContent = `${saved}% smaller`;
  summaryEl.append(strong);
}

function render() {
  const hasImages = images.length > 0;
  dropzoneEl.hidden = hasImages;
  workspaceEl.hidden = !hasImages;
  imageCountEl.textContent = `${images.length} image${images.length === 1 ? '' : 's'}`;

  if (!isZipping) {
    downloadAllBtn.disabled = !images.some(isDownloadable);
  }

  imageGridEl.innerHTML = '';
  const fragment = document.createDocumentFragment();
  images.forEach((entry) => fragment.appendChild(createImageCard(entry)));
  imageGridEl.appendChild(fragment);

  updateSummary();
}

// ---------- Event wiring ----------
browseBtn.addEventListener('click', () => fileInput.click());
addMoreBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  handleFiles(fileInput.files);
  fileInput.value = '';
});

// Prevent the browser from navigating away when a file is dropped anywhere on the page
['dragover', 'drop'].forEach((evt) => {
  document.addEventListener(evt, (e) => e.preventDefault());
});

dropzoneEl.addEventListener('dragenter', () => dropzoneEl.classList.add('dropzone--active'));
dropzoneEl.addEventListener('dragleave', () => dropzoneEl.classList.remove('dropzone--active'));
dropzoneEl.addEventListener('drop', (e) => {
  dropzoneEl.classList.remove('dropzone--active');
  handleFiles(e.dataTransfer.files);
});

// Once the dropzone is hidden (images already added), dropping anywhere on the page still works
document.addEventListener('drop', (e) => {
  if (dropzoneEl.hidden) handleFiles(e.dataTransfer.files);
});

clearAllBtn.addEventListener('click', clearAll);
downloadAllBtn.addEventListener('click', downloadAllAsZip);

qualitySlider.addEventListener('input', () => {
  const val = Number(qualitySlider.value);
  quality = val / 100;
  qualityValueEl.textContent = `${val}%`;

  clearTimeout(sliderDebounceTimer);
  sliderDebounceTimer = setTimeout(() => {
    if (images.length) compressEntries(images);
  }, SLIDER_DEBOUNCE_MS);
});

resizeSelect.addEventListener('change', () => {
  maxDimension = Number(resizeSelect.value);
  if (images.length) compressEntries(images);
});
