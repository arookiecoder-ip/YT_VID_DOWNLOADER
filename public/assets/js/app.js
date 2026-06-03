const API_BASE = '';
let currentVideo = null;
let selectedFormat = null;
let downloadFrameCounter = 0;
let activeDownloads = 0;
let activePlaylistProgressId = null;
let selectedPlaylistEntries = new Set(); // indices of selected entries
let currentPlaylistEntries = [];          // all entries from current playlist

// When the page is closed/navigated away:
// 1. Warn the user if a download is active (beforeunload — desktop only, not mobile)
// 2. Fire a cancel beacon so the server kills yt-dlp and deletes temp files (pagehide, only on true unload)
window.addEventListener('beforeunload', e => {
  if (activeDownloads > 0 || activePlaylistProgressId) {
    // returnValue must be a non-empty string — Chrome ignores empty string / e.preventDefault() alone
    e.returnValue = 'A download is in progress. If you leave, the download will be cancelled.';
    return e.returnValue;
  }
});

// pagehide fires on tab close, navigation, AND mobile backgrounding (screen lock / app switch).
// event.persisted === true means the page entered bfcache (backgrounded, NOT destroyed).
// Only send the cancel beacon when the page is truly unloading (persisted === false).
window.addEventListener('pagehide', (event) => {
  if (activePlaylistProgressId && !event.persisted) {
    navigator.sendBeacon(
      `${API_BASE}/api/download/playlist-zip/cancel/${activePlaylistProgressId}`
    );
  }
});

// When the user returns to the page from bfcache (e.g. unlocks screen, switches back),
// the SSE connection and fetch stream are dead.
// Try to re-fetch the finished ZIP from the server if it's ready, otherwise show toast.
window.addEventListener('pageshow', async (event) => {
  if (!event.persisted || !activePlaylistProgressId) return;
  const id = activePlaylistProgressId;
  try {
    const check = await fetch(`${API_BASE}/api/download/playlist-zip/file/${id}`, { method: 'HEAD' });
    if (check.ok || check.status === 206) {
      // ZIP is ready — trigger download
      showToast('ZIP ready! Starting download…', 'success');
      const a = document.createElement('a');
      a.href = `${API_BASE}/api/download/playlist-zip/file/${id}`;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 1000);
    } else {
      showToast('Download still running on server — check tray for progress.', 'success');
    }
  } catch {
    showToast('Download still running on server — check tray for progress.', 'success');
  }
});

// Notify the user immediately when network goes down or comes back up.
window.addEventListener('offline', () => {
  showToast('No internet connection — downloads will retry automatically', 'error');
});
window.addEventListener('online', () => {
  showToast('Back online', 'success');
});

(async () => {
  const el = document.getElementById('buildStamp');
  if (!el) return;
  try {
    const r = await fetch(`${API_BASE}/api/version`, { cache: 'no-store' });
    if (!r.ok) throw new Error('version fetch failed');
    const { lastPatched } = await r.json();
    if (!lastPatched) { el.textContent = 'Version info unavailable'; return; }
    const d = new Date(lastPatched);
    const fmt = d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    el.textContent = `Last patched: ${fmt}`;
    el.title = `Exact: ${d.toISOString()}`;
  } catch {
    el.textContent = 'Last patched: unknown';
  }
})();

const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com',
  'music.youtube.com', 'youtu.be',
]);
const YT_VIDEO_ID_RE = /^[\w-]{11}$/;
const YT_LIST_ID_RE = /^[\w-]{1,64}$/;

function parseYouTubeURL(raw) {
  const input = String(raw || '').trim();
  if (!input) return null;
  let u;
  try { u = new URL(input); } catch {
    try { u = new URL('https://' + input); } catch { return null; }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return null;

  const path = u.pathname;
  const videoId = u.searchParams.get('v');
  const listId = u.searchParams.get('list');
  const shortMatch = path.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
  const shortId = host === 'youtu.be' ? path.slice(1).split('/')[0] : null;

  const validVideo =
    (videoId && YT_VIDEO_ID_RE.test(videoId)) ||
    (shortMatch && YT_VIDEO_ID_RE.test(shortMatch[2])) ||
    (shortId && YT_VIDEO_ID_RE.test(shortId));
  const validList = listId && YT_LIST_ID_RE.test(listId);
  const isPlaylistPath = path.startsWith('/playlist');
  if (!validVideo && !validList) return null;

  return {
    videoId: validVideo
      ? (videoId || (shortMatch && shortMatch[2]) || shortId)
      : null,
    listId: validList ? listId : null,
    isPlaylistPath,
  };
}

function isValidYouTubeURL(url) {
  return parseYouTubeURL(url) !== null;
}

function isPlaylistURL(url) {
  const p = parseYouTubeURL(url);
  if (!p) return false;
  if (p.isPlaylistPath && p.listId) return true;
  return Boolean(p.listId) && !p.videoId;
}

function formatViews(n) {
  if (!n) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B views';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M views';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K views';
  return n + ' views';
}

function formatDuration(s) {
  if (!s) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function formatBytes(b) {
  if (!b) return '—';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return (b / 1e3).toFixed(0) + ' KB';
}

function formatTransferRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatEtaSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const rounded = Math.ceil(seconds);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function buildServerProgressDetail(status, elapsedText) {
  const parts = [];
  if (Number.isFinite(status.sourcePercent)) {
    parts.push(`${status.sourcePercent.toFixed(1)}% from YouTube`);
  }
  if (status.totalText) parts.push(status.totalText);
  if (status.speedText) parts.push(status.speedText);
  if (status.etaText) parts.push(`ETA ${status.etaText}`);
  if (elapsedText) parts.push(elapsedText);
  return parts.join(' | ');
}

function buildSaveProgressDetail(received, total, startedAt) {
  const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const speed = received / elapsedSeconds;
  const parts = [];
  if (total > 0) parts.push(`${formatBytes(received)} / ${formatBytes(total)}`);
  else parts.push(formatBytes(received));
  const speedText = formatTransferRate(speed);
  if (speedText) parts.push(speedText);
  if (total > 0 && speed > 0) {
    const eta = formatEtaSeconds((total - received) / speed);
    if (eta) parts.push(`ETA ${eta}`);
  }
  return parts.join(' | ');
}
function sanitizeClientFilename(name) {
  return String(name || 'video')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
}

function mimeForExt(ext) {
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'webm') return 'video/webm';
  return 'video/mp4';
}

function setProgressState(progressBar, progressPercent, progressSize, pct, title, detail) {
  const safePct = Math.max(0, Math.min(100, Math.round(pct)));
  progressBar.style.width = `${safePct}%`;
  progressPercent.textContent = `${title} (${safePct}%)`;
  progressSize.textContent = detail || '—';
}

async function tryDownloadWithFilePicker(params, suggestedFilename, ext, progressBar, progressPercent, progressSize) {
  if (typeof window.showSaveFilePicker !== 'function') {
    return { supported: false, completed: false, cancelled: false };
  }

  let writable = null;
  let prepTicker = null;
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: suggestedFilename,
      types: [{
        description: `${ext.toUpperCase()} file`,
        accept: { [mimeForExt(ext)]: [`.${ext}`] }
      }],
    });

    writable = await handle.createWritable();

    // Large HD selections may take time before first byte arrives while backend merges tracks.
    let prepPct = 30;
    setProgressState(
      progressBar,
      progressPercent,
      progressSize,
      prepPct,
      'Merging on server…',
      'Step 3/4: Preparing video + audio tracks'
    );
    prepTicker = setInterval(() => {
      prepPct = Math.min(prepPct + 2, 88);
      setProgressState(
        progressBar,
        progressPercent,
        progressSize,
        prepPct,
        'Merging on server…',
        'Step 3/4: Preparing video + audio tracks'
      );
    }, 900);

    const res = await fetch(`${API_BASE}/api/download?${params.toString()}`);
    if (prepTicker) {
      clearInterval(prepTicker);
      prepTicker = null;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Download failed');
    }

    const total = Number(res.headers.get('Content-Length') || 0);
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) {
      throw new Error('Streaming is not supported in this browser.');
    }

    let received = 0;
    if (total > 0) {
      setProgressState(
        progressBar,
        progressPercent,
        progressSize,
        90,
        'Downloading…',
        `Step 4/4: 0 B / ${formatBytes(total)}`
      );
    } else {
      setProgressState(
        progressBar,
        progressPercent,
        progressSize,
        90,
        'Downloading…',
        'Step 4/4: Total size unavailable'
      );
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      await writable.write(value);
      received += value.byteLength || value.length || 0;

      if (total > 0) {
        const pct = Math.min(100, Math.round((received / total) * 100));
        const uiPct = Math.min(100, Math.round(90 + (pct * 0.1)));
        setProgressState(
          progressBar,
          progressPercent,
          progressSize,
          uiPct,
          `Downloading… ${pct}%`,
          `Step 4/4: ${formatBytes(received)} / ${formatBytes(total)}`
        );
      } else {
        setProgressState(
          progressBar,
          progressPercent,
          progressSize,
          95,
          'Downloading…',
          `Step 4/4: Received ${formatBytes(received)}`
        );
      }
    }

    setProgressState(
      progressBar,
      progressPercent,
      progressSize,
      100,
      'Completed',
      `Saved to: ${suggestedFilename}`
    );
    await writable.close();
    return { supported: true, completed: true, cancelled: false };
  } catch (err) {
    if (prepTicker) {
      clearInterval(prepTicker);
      prepTicker = null;
    }

    if (writable) {
      try { await writable.abort(); } catch (_) { }
    }

    if (err && err.name === 'AbortError') {
      return { supported: true, completed: false, cancelled: true };
    }

    console.warn('File picker download failed:', err);
    return { supported: true, completed: false, cancelled: false, error: err.message || 'Unknown error' };
  }
}

function getDefaultDownloadButtonLabel() {
  if (currentVideo?.kind === 'playlist') {
    const total = currentPlaylistEntries.length || (Array.isArray(currentVideo.entries) ? currentVideo.entries.length : 0);
    const sel = selectedPlaylistEntries.size;
    if (total > 0 && sel < total) return `Download Selected (${sel})`;
    return total > 0 ? `Download Playlist (${total})` : 'Download Playlist';
  }
  return 'Download';
}

function queueIframeDownloadByUrl(url, onSettled) {
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.name = 'downloadFrame' + Date.now() + '_' + (downloadFrameCounter++);
  iframe.src = url;
  document.body.appendChild(iframe);
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    if (typeof onSettled === 'function') onSettled();
  };
  iframe.addEventListener('load', () => setTimeout(settle, 2000));
  setTimeout(() => { settle(); iframe.remove(); }, 120000);
}

function queueIframeDownload(params, onSettled) {
  queueIframeDownloadByUrl(`${API_BASE}/api/download?${params.toString()}`, onSettled);
}

function queueIframeFileDownload(token, onSettled) {
  queueIframeDownloadByUrl(`${API_BASE}/api/download/file/${encodeURIComponent(token)}`, onSettled);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForDownloadReady(token) {
  const startedAt = Date.now();
  const timeoutMs = 6 * 60 * 60 * 1000;
  let consecutiveFailures = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const statusRes = await fetch(`${API_BASE}/api/download/status/${encodeURIComponent(token)}`);
      if (!statusRes.ok) {
        const errData = await statusRes.json().catch(() => ({}));
        throw new Error(errData.error || `Status check failed (${statusRes.status})`);
      }

      const status = await statusRes.json();
      if (status.state === 'done') return status;
      if (status.state === 'error') {
        throw new Error(status.error || 'Download failed on server');
      }

      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 5) {
        throw err;
      }
    }

    await delay(3000);
  }

  throw new Error('Download timed out after 6 hours.');
}

async function startDownloadJobWithRetry(url, formatId, ext, onRetry) {
  const startedAt = Date.now();
  const timeoutMs = 6 * 60 * 60 * 1000;

  while (Date.now() - startedAt <= timeoutMs) {
    const startRes = await fetch(`${API_BASE}/api/download/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        formatId,
        ext,
      }),
    });

    if (startRes.ok) {
      return startRes.json();
    }

    const errData = await startRes.json().catch(() => ({}));
    const message = errData.error || `Server error ${startRes.status}`;
    if (startRes.status !== 429) {
      throw new Error(message);
    }

    const retryAfter = Number(startRes.headers.get('Retry-After') || 0);
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : 3000;
    if (typeof onRetry === 'function') onRetry(message, waitMs);
    await delay(Math.max(1000, Math.min(waitMs, 10000)));
  }

  throw new Error('Timed out waiting for available server capacity.');
}

// ── Downloads Tray ──
let trayCollapsed = false;

function toggleTray() {
  trayCollapsed = !trayCollapsed;
  document.getElementById('dlTrayList').classList.toggle('collapsed', trayCollapsed);
  const toggle = document.getElementById('dlTrayToggle');
  if (toggle) toggle.classList.toggle('collapsed', trayCollapsed);
}

// cancelFn: optional — called when user confirms cancel.
// Shows a red ✕ button during download; clicking it reveals inline Yes/No.
function createTrayCard(title, filename, cancelFn) {
  const id = 'dlcard-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const tray = document.getElementById('dlTray');
  const list = document.getElementById('dlTrayList');

  const card = document.createElement('div');
  card.className = 'dl-card';
  card.id = id;
  const safeTitle = title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  card.innerHTML = `
    <div class="dl-card-top">
      <div class="dl-card-title">${safeTitle}</div>
      <button class="dl-card-dismiss${cancelFn ? ' cancel' : ''}" id="${id}-btn"
        title="${cancelFn ? 'Cancel download' : 'Dismiss'}"
        style="${cancelFn ? '' : 'display:none'}">✕</button>
    </div>
    <div class="dl-card-bar-outer"><div class="dl-card-bar-inner" id="${id}-bar"></div></div>
    <div class="dl-card-status"><span id="${id}-pct">Waiting…</span><span id="${id}-size">${filename}</span></div>
    <div class="dl-card-confirm" id="${id}-confirm" style="display:none">
      Cancel this download?
      <button class="dl-card-confirm-yes" id="${id}-yes">Yes</button>
      <button class="dl-card-confirm-no" id="${id}-no">No</button>
    </div>
  `;

  if (cancelFn) {
    const btn = card.querySelector(`#${id}-btn`);
    const confirmRow = card.querySelector(`#${id}-confirm`);
    const yesBtn = card.querySelector(`#${id}-yes`);
    const noBtn = card.querySelector(`#${id}-no`);

    btn.addEventListener('click', () => {
      btn.style.display = 'none';
      confirmRow.style.display = 'flex';
    });
    yesBtn.addEventListener('click', () => {
      confirmRow.style.display = 'none';
      cancelFn();
    });
    noBtn.addEventListener('click', () => {
      confirmRow.style.display = 'none';
      btn.style.display = '';
    });
  }

  list.appendChild(card);
  tray.style.display = 'flex';
  if (trayCollapsed) {
    trayCollapsed = false;
    document.getElementById('dlTrayList').classList.remove('collapsed');
    const toggle = document.getElementById('dlTrayToggle');
    if (toggle) toggle.classList.remove('collapsed');
  }
  updateTrayBadge();
  return id;
}

function updateTrayCard(id, pct, statusText, sizeText) {
  const bar = document.getElementById(id + '-bar');
  const pctEl = document.getElementById(id + '-pct');
  const sizeEl = document.getElementById(id + '-size');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (pctEl) pctEl.textContent = statusText;
  if (sizeEl && sizeText !== undefined) sizeEl.textContent = sizeText;
}

function finishTrayCard(id, success, message) {
  const card = document.getElementById(id);
  if (!card) return;
  // Hide any pending confirmation row
  const confirmRow = document.getElementById(id + '-confirm');
  if (confirmRow) confirmRow.style.display = 'none';
  card.classList.add(success ? 'done' : 'failed');
  const bar = document.getElementById(id + '-bar');
  if (bar) bar.style.width = '100%';
  const pctEl = document.getElementById(id + '-pct');
  if (pctEl) {
    pctEl.innerHTML = success
      ? `<span class="status-ok">✓ Done</span>`
      : `<span class="status-err">✕ Failed</span>`;
  }
  const sizeEl = document.getElementById(id + '-size');
  if (sizeEl && message) sizeEl.textContent = message;
  // Switch from cancel button → dismiss button (clone removes old listeners)
  const btn = document.getElementById(id + '-btn');
  if (btn) {
    btn.className = 'dl-card-dismiss';
    btn.title = 'Dismiss';
    const fresh = btn.cloneNode(true);
    fresh.style.display = '';
    fresh.addEventListener('click', () => dismissTrayCard(id));
    btn.replaceWith(fresh);
  }
  updateTrayBadge();
}

function dismissTrayCard(id) {
  const card = document.getElementById(id);
  if (card) card.remove();
  updateTrayBadge();
  if (!document.getElementById('dlTrayList').children.length) {
    document.getElementById('dlTray').style.display = 'none';
  }
}

function updateTrayBadge() {
  const list = document.getElementById('dlTrayList');
  const badge = document.getElementById('dlTrayBadge');
  badge.textContent = list ? list.children.length : 0;
}

async function startPlaylistDownload(formatId, ext) {
  const entries = Array.isArray(currentVideo?.entries) ? currentVideo.entries : [];
  // Use selected subset; fall back to all entries if nothing selected
  const selectedEntryList = currentPlaylistEntries.length > 0
    ? currentPlaylistEntries.filter((_, i) => selectedPlaylistEntries.has(i))
    : entries;

  if (!selectedEntryList.length) {
    showToast('No videos selected', 'error');
    return;
  }

  const playlistTitle = currentVideo.title || 'Playlist';
  const total = selectedEntryList.length;
  const btn = document.getElementById('downloadBtn');

  // Pre-open the file picker NOW — must happen within the user gesture (before any await).
  // After the first await the gesture context is lost and showSaveFilePicker throws SecurityError.
  let zipFileHandle = null;
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      zipFileHandle = await window.showSaveFilePicker({
        suggestedName: sanitizeClientFilename(playlistTitle) + '.zip',
        types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user cancelled picker — nothing to undo
      zipFileHandle = null; // any other failure → fall back to blob anchor
    }
  }

  // Generate a random progress ID and open SSE channel before starting the ZIP request
  const progressId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  let sse = null;
  let zipCompleted = 0;
  let zipFailed = 0;
  let cancelled = false;
  let currentFetchAbort = new AbortController(); // replaced on each retry attempt

  // Cancel function: abort the current fetch attempt and tell the server to kill yt-dlp
  const cancelDownload = () => {
    if (cancelled) return;
    cancelled = true;
    currentFetchAbort.abort();
    navigator.sendBeacon(`${API_BASE}/api/download/playlist-zip/cancel/${progressId}`);
  };

  const cardId = createTrayCard(playlistTitle, `${total} videos`, cancelDownload);

  btn.disabled = true;
  btn.querySelector('span').textContent = 'Preparing ZIP…';
  updateTrayCard(cardId, 0, 'Fetching playlist info…', `0 / ${total}`);

  // Track this progress ID globally so pagehide can fire the cancel beacon
  activePlaylistProgressId = progressId;

  // Helper: (re-)open SSE and attach all event listeners
  const openSSE = () => {
    if (sse) { sse.close(); sse = null; }
    sse = new EventSource(`${API_BASE}/api/download/playlist-zip/progress/${progressId}`);

    sse.addEventListener('status', (e) => {
      const d = JSON.parse(e.data);
      updateTrayCard(cardId, 2, d.stage, `0 / ${total}`);
    });
    sse.addEventListener('downloading', (e) => {
      const d = JSON.parse(e.data);
      const pct = Math.round(((d.current - 1) / d.total) * 90);
      updateTrayCard(cardId, pct,
        `Downloading ${d.current} / ${d.total}`,
        `"${d.title}"`
      );
    });
    sse.addEventListener('merging', (e) => {
      const d = JSON.parse(e.data);
      const pct = Math.round(((d.current - 1) / d.total) * 90);
      updateTrayCard(cardId, pct,
        `Merging ${d.current} / ${d.total}`,
        `"${d.title}"`
      );
    });
    sse.addEventListener('done', (e) => {
      const d = JSON.parse(e.data);
      zipCompleted = d.completed;
      zipFailed = d.failed;
      const pct = Math.round((d.current / d.total) * 90);
      const status = d.failed > 0
        ? `${d.completed} done, ${d.failed} failed`
        : `${d.completed} / ${d.total} done`;
      updateTrayCard(cardId, pct, `Done ${d.current} / ${d.total}`, status);
    });
    sse.addEventListener('failed', (e) => {
      const d = JSON.parse(e.data);
      zipCompleted = d.completed;
      zipFailed = d.failed;
      const pct = Math.round((d.current / d.total) * 90);
      updateTrayCard(cardId, pct,
        `Failed ${d.current} / ${d.total}`,
        `${d.completed} done • ${d.failed} failed — "${d.title}"`
      );
    });
    sse.addEventListener('complete', () => {
      updateTrayCard(cardId, 92, 'Packing ZIP…', 'Finalising archive');
    });
    sse.addEventListener('zip-error', (e) => {
      try {
        const d = JSON.parse(e.data);
        console.warn('[SSE] server error:', d.error);
      } catch { }
    });

    return new Promise((resolve) => {
      sse.onopen = () => resolve();
      setTimeout(resolve, 1500); // resolve anyway if onopen doesn't fire
    });
  };

  const MAX_PLAYLIST_RETRIES = 3;
  try {
    for (let attempt = 1; attempt <= MAX_PLAYLIST_RETRIES; attempt++) {
      if (cancelled) break;
      try {
        if (attempt > 1) {
          updateTrayCard(cardId, 0, `Reconnecting… (attempt ${attempt}/${MAX_PLAYLIST_RETRIES})`, '');
        }

        // Open (or re-open) SSE so server can immediately send events
        await openSSE();

        // Fresh abort controller for this attempt
        currentFetchAbort = new AbortController();

        // Start the ZIP request (runs in parallel with SSE updates)
        updateTrayCard(cardId, 1, 'Starting…', `0 / ${total}`);
        const res = await fetch(`${API_BASE}/api/download/playlist-zip`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
          url: currentVideo.url,
          formatId,
          ext,
          progressId,
          selectedEntries: selectedEntryList.map(e => ({ url: e.url, title: e.title })),
          playlistTitle,
        }),
          signal: currentFetchAbort.signal,
        });

        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          throw new Error(errJson.error || `Server error ${res.status}`);
        }

        updateTrayCard(cardId, 93, 'Receiving ZIP…', 'Downloading archive to your device');

        // Extract filename from Content-Disposition header
        let filename = playlistTitle + '.zip';
        const cd = res.headers.get('Content-Disposition') || '';
        const fnMatch = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
        if (fnMatch) filename = decodeURIComponent(fnMatch[1].trim().replace(/^["']|["']$/g, ''));

        // Stream ZIP to disk. Uses the pre-obtained file handle if available (no RAM spike),
        // otherwise falls back to accumulating chunks into a Blob anchor download.
        const zipTotal = Number(res.headers.get('Content-Length') || 0);

        if (zipFileHandle) {
          let zipWritable = null;
          try {
            zipWritable = await zipFileHandle.createWritable();
            const zipReader = res.body.getReader();
            let zipReceived = 0;
            while (true) {
              if (cancelled) { zipReader.cancel(); throw new Error('cancelled'); }
              const { done, value } = await zipReader.read();
              if (done) break;
              await zipWritable.write(value);
              zipReceived += value.byteLength || 0;
              if (zipTotal > 0) {
                const pct = 93 + Math.round((zipReceived / zipTotal) * 6);
                updateTrayCard(cardId, Math.min(99, pct), 'Saving ZIP…',
                  `${formatBytes(zipReceived)} / ${formatBytes(zipTotal)}`);
              } else {
                updateTrayCard(cardId, 97, 'Saving ZIP…', formatBytes(zipReceived));
              }
            }
            await zipWritable.close();
          } catch (err) {
            if (zipWritable) { try { await zipWritable.abort(); } catch (_) {} }
            if (err && err.name === 'AbortError') throw new Error('cancelled');
            throw err;
          }
        } else {
          // Fallback: stream response body into a ReadableStream → Blob URL anchor.
          // We still avoid buffering the whole file at once by using a TransformStream
          // that pipes directly to a Blob constructed from the stream.
          // Note: on browsers without File System Access API this still buffers in RAM,
          // but it's the best we can do without the API.
          const zipReader = res.body.getReader();
          const zipChunks = [];
          let zipReceived = 0;
          while (true) {
            if (cancelled) { zipReader.cancel(); throw new Error('cancelled'); }
            const { done, value } = await zipReader.read();
            if (done) break;
            zipChunks.push(value);
            zipReceived += value.byteLength || 0;
            if (zipTotal > 0) {
              const pct = 93 + Math.round((zipReceived / zipTotal) * 6);
              updateTrayCard(cardId, Math.min(99, pct), 'Receiving ZIP…',
                `${formatBytes(zipReceived)} / ${formatBytes(zipTotal)}`);
            } else {
              updateTrayCard(cardId, 97, 'Receiving ZIP…', formatBytes(zipReceived));
            }
          }
          const blob = new Blob(zipChunks, { type: 'application/zip' });
          const objectUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = objectUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { URL.revokeObjectURL(objectUrl); a.remove(); }, 1000);
        }

        const summary = zipFailed > 0
          ? `${zipCompleted} downloaded, ${zipFailed} failed`
          : `${total} videos packed`;
        finishTrayCard(cardId, true, summary);
        showToast(`Playlist ZIP ready: ${filename}`);
        break; // success — exit retry loop

      } catch (err) {
        if (cancelled || err.name === 'AbortError') throw err;
        if (attempt === MAX_PLAYLIST_RETRIES) throw err;
        // Network error — wait then retry
        updateTrayCard(cardId, 0,
          `Connection lost. Retrying in 3s… (${attempt}/${MAX_PLAYLIST_RETRIES})`, '');
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  } catch (err) {
    if (cancelled || err.name === 'AbortError') {
      finishTrayCard(cardId, false, 'Cancelled');
    } else {
      console.error('Playlist ZIP failed:', err);
      finishTrayCard(cardId, false, err.message || 'ZIP download failed');
      showToast(err.message || 'Playlist ZIP failed', 'error');
    }
  } finally {
    if (sse) sse.close();
    activePlaylistProgressId = null; // no longer need the cancel beacon
    btn.disabled = false;
    btn.querySelector('span').textContent = getDefaultDownloadButtonLabel();
  }
}

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = (type === 'success' ? '✓ ' : '✕ ') + msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3500);
}

function showLoader(s) {
  document.getElementById('loader').classList.toggle('active', s);
  if (s) document.getElementById('featuresGrid').style.display = 'none';
}
function showError(m) { const e = document.getElementById('errorMsg'); e.textContent = m; e.classList.toggle('active', !!m); }
function showResult(s) {
  document.getElementById('resultCard').classList.toggle('active', s);
  if (s) document.getElementById('featuresGrid').style.display = 'none';
}

// ── Batch Download ──

// Wire up quality chip selection
document.getElementById('batchQualityChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.batch-chip');
  if (!chip) return;
  document.querySelectorAll('.batch-chip').forEach(c => c.classList.remove('selected'));
  chip.classList.add('selected');
});

function getBatchFormat() {
  const chip = document.querySelector('.batch-chip.selected');
  return {
    formatId: chip ? chip.dataset.format : 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    ext: chip ? chip.dataset.ext : 'mp4',
  };
}

function toggleBatch() {
  const sec = document.getElementById('batchSection');
  const btn = document.getElementById('batchToggle');
  const hidden = sec.hasAttribute('hidden');
  if (hidden) {
    sec.removeAttribute('hidden');
    btn.textContent = '− Hide batch downloader';
    document.getElementById('batchInput').focus();
  } else {
    sec.setAttribute('hidden', '');
    btn.textContent = '＋ Batch download multiple links';
  }
}

function extractYouTubeURLs(text) {
  const urlRe = /https?:\/\/[^\s"'<>]+/g;
  const seen = new Set();
  const out = [];
  let playlistCount = 0;
  for (const raw of (text.match(urlRe) || [])) {
    const clean = raw.replace(/[.,;:!?)]+$/, '');
    if (seen.has(clean)) continue;
    if (!isValidYouTubeURL(clean)) continue;
    if (isPlaylistURL(clean)) { playlistCount++; continue; } // skip playlists, count them
    seen.add(clean);
    out.push(clean);
  }
  return { urls: out, playlistCount };
}

// Wire textarea input listener after DOM is ready
(function () {
  const ta = document.getElementById('batchInput');
  if (ta) ta.addEventListener('input', updateBatchHint);
})();

function updateBatchHint() {
  const text = document.getElementById('batchInput').value;
  const { urls, playlistCount } = extractYouTubeURLs(text);
  const hint = document.getElementById('batchHint');
  if (!text.trim()) {
    hint.innerHTML = 'Paste text containing YouTube URLs';
  } else if (urls.length === 0 && playlistCount === 0) {
    hint.innerHTML = 'No YouTube video links found';
  } else if (urls.length === 0 && playlistCount > 0) {
    hint.innerHTML = `No video links found — ${playlistCount} playlist link${playlistCount > 1 ? 's' : ''} detected (use main input for playlists)`;
  } else {
    let msg = `<span>${urls.length}</span> link${urls.length > 1 ? 's' : ''} found`;
    if (playlistCount > 0) msg += ` · ${playlistCount} playlist${playlistCount > 1 ? 's' : ''} skipped (use main input)`;
    hint.innerHTML = msg;
  }
}

async function startBatchDownload() {
  const text = document.getElementById('batchInput').value;
  const { urls, playlistCount } = extractYouTubeURLs(text);

  if (urls.length === 0) {
    if (playlistCount > 0) {
      showToast(`Batch mode only supports individual videos. Paste the playlist URL in the main input instead.`, 'error');
    } else {
      showToast('No YouTube video links found in the pasted text', 'error');
    }
    return;
  }

  const btn = document.getElementById('batchBtn');
  btn.disabled = true;
  const { formatId, ext } = getBatchFormat();

  showToast(`Starting ${urls.length} download${urls.length > 1 ? 's' : ''}…`);

  // Start all concurrently — each has its own tray card + server-side yt-dlp job
  await Promise.allSettled(urls.map((url, i) => startBatchItem(url, i + 1, urls.length, formatId, ext)));

  btn.disabled = false;
}

async function startBatchItem(url, index, total, formatId, ext) {
  const shortLabel = `Video ${index}${total > 1 ? ' of ' + total : ''}`;
  const cardId = createTrayCard(shortLabel, url.slice(0, 48) + (url.length > 48 ? '…' : ''));
  activeDownloads++;

  try {
    updateTrayCard(cardId, 5, 'Fetching info…', '');

    // Fetch video info to get real title
    const infoRes = await fetch(`${API_BASE}/api/info?url=${encodeURIComponent(url)}`);
    const info = await infoRes.json();
    if (!infoRes.ok) throw new Error(info.error || 'Failed to fetch info');

    if (info.kind === 'playlist') {
      // Playlist URLs are not supported in batch mode — explain clearly
      finishTrayCard(cardId, false, 'Playlist links not supported in batch mode. Use the main input instead.');
      activeDownloads = Math.max(0, activeDownloads - 1);
      return;
    }

    const title = info.title || shortLabel;
    const suggestedFilename = `${sanitizeClientFilename(title)}.${ext}`;

    // Update card with real title
    const titleEl = document.querySelector(`#${cardId} .dl-card-title`);
    if (titleEl) titleEl.textContent = title;

    updateTrayCard(cardId, 10, 'Starting download…', suggestedFilename);

    // jobToken is set once the server accepts the job.
    // cancelDownload kills the server-side yt-dlp process via the cancel endpoint.
    let jobToken = null;
    let cancelled = false;
    const cancelDownload = () => {
      if (cancelled) return;
      cancelled = true;
      if (jobToken) {
        fetch(`${API_BASE}/api/download/cancel/${jobToken}`, { method: 'POST' }).catch(() => {});
      }
    };

    // Wire up the cancel button on the tray card now that we have cancelDownload
    const dismissBtn = document.getElementById(`${cardId}-btn`);
    const confirmRow = document.getElementById(`${cardId}-confirm`);
    const yesBtn = document.getElementById(`${cardId}-yes`);
    const noBtn = document.getElementById(`${cardId}-no`);
    if (dismissBtn) {
      dismissBtn.style.display = '';
      dismissBtn.classList.add('cancel');
      dismissBtn.title = 'Cancel download';
      dismissBtn.addEventListener('click', () => {
        dismissBtn.style.display = 'none';
        if (confirmRow) confirmRow.style.display = 'flex';
      });
    }
    if (yesBtn) yesBtn.addEventListener('click', () => { cancelDownload(); if (confirmRow) confirmRow.style.display = 'none'; });
    if (noBtn) noBtn.addEventListener('click', () => { if (dismissBtn) dismissBtn.style.display = ''; if (confirmRow) confirmRow.style.display = 'none'; });

    // Start job on server
    try {
      const startRes = await fetch(`${API_BASE}/api/download/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formatId, ext }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) throw new Error(startData.error || `Server error ${startRes.status}`);
      jobToken = startData.token;
    } catch (err) {
      throw new Error('Failed to start: ' + (err.message || 'unknown error'));
    }

    // Poll for completion
    const MAX_CONSECUTIVE_FAILURES = 20;
    let consecutiveFailures = 0;
    let lastProgress = 0;

    await new Promise((resolve, reject) => {
      function poll() {
        if (cancelled) return reject(new Error('cancelled'));
        fetch(`${API_BASE}/api/download/status/${jobToken}`)
          .then(r => r.json())
          .then(status => {
            consecutiveFailures = 0;
            if (cancelled) return reject(new Error('cancelled'));
            if (status.state === 'error') return reject(new Error(status.error || 'Download failed on server'));
            if (status.state === 'done') return resolve(status);
            lastProgress = status.progress || lastProgress;
            updateTrayCard(cardId, Math.max(10, lastProgress * 0.85), status.stage || 'Downloading…', suggestedFilename);
            setTimeout(poll, 3000);
          })
          .catch(err => {
            if (cancelled) return reject(new Error('cancelled'));
            consecutiveFailures++;
            updateTrayCard(cardId, lastProgress, `Reconnecting… (${consecutiveFailures}/20)`, '');
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return reject(new Error('Lost connection to server'));
            setTimeout(poll, 3000);
          });
      }
      poll();
    });

    if (cancelled) throw new Error('cancelled');

    updateTrayCard(cardId, 90, 'Saving to Downloads…', suggestedFilename);

    // Trigger browser download via file endpoint (iframe)
    queueIframeFileDownload(jobToken, () => {
      activeDownloads = Math.max(0, activeDownloads - 1);
    });

    finishTrayCard(cardId, true, 'Saved to Downloads bar');
    updateTrayCard(cardId, 100, 'Done', suggestedFilename);

  } catch (err) {
    activeDownloads = Math.max(0, activeDownloads - 1);
    if (err.message === 'cancelled') {
      finishTrayCard(cardId, false, 'Cancelled');
    } else {
      finishTrayCard(cardId, false, err.message || 'Failed');
    }
  }
}

document.getElementById('urlInput').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (document.getElementById('fetchBtn').disabled) return;
  fetchVideo();
});

const __urlInput = document.getElementById('urlInput');
const __clearBtn = document.getElementById('clearBtn');
const __syncClearBtn = () => { __clearBtn.hidden = __urlInput.value.length === 0; };
__urlInput.addEventListener('input', __syncClearBtn);
__syncClearBtn();

function clearSearch() {
  __urlInput.value = '';
  __urlInput.focus();
  currentVideo = null;
  selectedFormat = null;
  currentPlaylistEntries = [];
  selectedPlaylistEntries = new Set();
  showError('');
  showResult(false);
  document.getElementById('featuresGrid').style.display = '';
  const existingWarning = document.getElementById('playlistTruncatedWarning');
  if (existingWarning) existingWarning.remove();
  const existingSel = document.getElementById('playlistSelectionPanel');
  if (existingSel) existingSel.remove();
  __syncClearBtn();
}

async function fetchVideo() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) { showError('Please paste a YouTube URL.'); return; }
  if (!isValidYouTubeURL(url)) { showError("That doesn't look like a valid YouTube URL."); return; }

  showError(''); showResult(false); showLoader(true);
  document.getElementById('fetchBtn').disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/info?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch');
    currentVideo = { ...data, url };
    renderResult(data);
    showToast('Video info loaded!');
  } catch (err) {
    showError(err.message || 'Could not fetch video info.');
  } finally {
    showLoader(false);
    document.getElementById('fetchBtn').disabled = false;
  }
}

function renderPlaylistSelection(entries) {
  const existing = document.getElementById('playlistSelectionPanel');
  if (existing) existing.remove();
  currentPlaylistEntries = entries;
  selectedPlaylistEntries = new Set(entries.map((_, i) => i)); // select all by default

  const panel = document.createElement('div');
  panel.id = 'playlistSelectionPanel';
  panel.className = 'playlist-selection';

  const updateBadge = () => {
    const badge = panel.querySelector('.playlist-sel-badge');
    const sel = selectedPlaylistEntries.size;
    badge.textContent = `${sel} / ${entries.length} selected`;
    badge.classList.toggle('none', sel === 0);
    const dlBtn = document.getElementById('downloadBtn');
    if (dlBtn) {
      dlBtn.disabled = sel === 0;
      dlBtn.querySelector('span').textContent = getDefaultDownloadButtonLabel();
    }
  };

  const toggleEntry = (idx, row) => {
    if (selectedPlaylistEntries.has(idx)) {
      selectedPlaylistEntries.delete(idx);
      row.classList.remove('sel');
    } else {
      selectedPlaylistEntries.add(idx);
      row.classList.add('sel');
    }
    updateBadge();
  };

  panel.innerHTML = `
    <div class="playlist-sel-header">
      <div class="playlist-sel-title">
        Select Videos
        <span class="playlist-sel-badge">${entries.length} / ${entries.length} selected</span>
      </div>
      <div class="playlist-sel-controls">
        <button class="btn-sel" id="plSelAll">All</button>
        <button class="btn-sel" id="plSelNone">None</button>
        <div class="playlist-range-form">
          <label>Range</label>
          <input type="number" id="plRangeFrom" min="1" max="${entries.length}" value="1" title="From (1-indexed)">
          <label>–</label>
          <input type="number" id="plRangeTo" min="1" max="${entries.length}" value="${entries.length}" title="To (inclusive)">
          <button class="btn-sel" id="plRangeApply">Apply</button>
        </div>
      </div>
    </div>
    <div class="playlist-entry-list" id="plEntryList"></div>`;

  const list = panel.querySelector('#plEntryList');
  entries.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'playlist-entry sel';
    row.dataset.idx = i;
    const thumb = entry.thumbnail
      ? `<img class="pl-thumb" src="${entry.thumbnail}" alt="" loading="lazy">`
      : `<div class="pl-thumb"></div>`;
    row.innerHTML = `<div class="pl-cb"></div>${thumb}<div class="pl-entry-info"><div class="pl-entry-idx">#${i + 1}</div><div class="pl-entry-title">${entry.title.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div></div>`;
    row.addEventListener('click', () => toggleEntry(i, row));
    list.appendChild(row);
  });

  panel.querySelector('#plSelAll').addEventListener('click', () => {
    selectedPlaylistEntries = new Set(entries.map((_, i) => i));
    panel.querySelectorAll('.playlist-entry').forEach(r => r.classList.add('sel'));
    updateBadge();
  });
  panel.querySelector('#plSelNone').addEventListener('click', () => {
    selectedPlaylistEntries = new Set();
    panel.querySelectorAll('.playlist-entry').forEach(r => r.classList.remove('sel'));
    updateBadge();
  });
  panel.querySelector('#plRangeApply').addEventListener('click', () => {
    const from = Math.max(1, parseInt(panel.querySelector('#plRangeFrom').value, 10) || 1);
    const to = Math.min(entries.length, parseInt(panel.querySelector('#plRangeTo').value, 10) || entries.length);
    selectedPlaylistEntries = new Set();
    panel.querySelectorAll('.playlist-entry').forEach(r => {
      const idx = parseInt(r.dataset.idx, 10);
      const inRange = idx >= from - 1 && idx <= to - 1;
      r.classList.toggle('sel', inRange);
      if (inRange) selectedPlaylistEntries.add(idx);
    });
    updateBadge();
  });

  document.getElementById('resultCard').after(panel);
}

function renderResult(video) {
  const isPlaylist = video.kind === 'playlist' || isPlaylistURL(currentVideo?.url || '');
  const playlistCount = Array.isArray(video.entries) ? video.entries.length : (video.playlistCount || 0);

  document.getElementById('thumbnail').src = video.thumbnail;
  document.getElementById('thumbnail').classList.remove('loaded');
  document.getElementById('videoTitle').textContent = video.title;
  document.getElementById('channelName').textContent = video.channel;
  document.getElementById('viewCount').textContent = isPlaylist
    ? `${playlistCount} videos${video.truncated ? ` (first ${playlistCount} shown)` : ''}`
    : formatViews(video.views);
  document.getElementById('duration').textContent = isPlaylist
    ? `${playlistCount} items`
    : formatDuration(video.duration);
  document.getElementById('uploadDate').textContent = isPlaylist
    ? 'Playlist'
    : (video.uploadDate || '—');

  const existingWarning = document.getElementById('playlistTruncatedWarning');
  if (existingWarning) existingWarning.remove();
  if (isPlaylist && video.truncated) {
    const totalLabel = video.totalCount ? ` of ${video.totalCount}` : '';
    const warning = document.createElement('div');
    warning.id = 'playlistTruncatedWarning';
    warning.style.cssText = 'margin: 0 24px 16px; padding: 10px 14px; background: rgba(255,102,51,0.08); border: 1px solid rgba(255,102,51,0.25); border-radius: 8px; font-size: 0.78rem; color: #ff9966; line-height: 1.5;';
    warning.textContent = `⚠ Only the first ${playlistCount}${totalLabel} videos are shown. The playlist may be longer — only these ${playlistCount} will be downloaded.`;
    const formatSection = document.querySelector('.format-section');
    if (formatSection) formatSection.parentNode.insertBefore(warning, formatSection);
  }
  const dlBtn = document.getElementById('downloadBtn');
  dlBtn.querySelector('span').textContent = getDefaultDownloadButtonLabel();
  dlBtn.disabled = false;

  const grid = document.getElementById('formatGrid');
  grid.innerHTML = '';
  selectedFormat = null;

  video.formats.forEach((fmt, i) => {
    const div = document.createElement('div');
    div.className = 'format-option' + (i === 0 ? ' selected' : '');
    if (i === 0) selectedFormat = fmt.id;

    let sizeText = fmt.filesize ? ` • ~${formatBytes(fmt.filesize)}` : '';
    div.innerHTML = `
    <input type="radio" name="format" value="${fmt.id}" ${i === 0 ? 'checked' : ''}>
    <div class="format-quality">${fmt.label}</div>
    <div class="format-detail">${fmt.detail}${sizeText}</div>
    ${fmt.badge ? `<span class="format-badge ${fmt.type === 'audio' ? 'audio' : ''}">${fmt.badge}</span>` : ''}
  `;
    div.addEventListener('click', () => {
      grid.querySelectorAll('.format-option').forEach(o => o.classList.remove('selected'));
      div.classList.add('selected');
      div.querySelector('input').checked = true;
      selectedFormat = fmt.id;
    });
    grid.appendChild(div);
  });
  showResult(true);

  // Render per-video selection panel for playlists
  if (isPlaylist && Array.isArray(video.entries) && video.entries.length > 0) {
    renderPlaylistSelection(video.entries);
  }
}

async function startDownload() {
  if (!currentVideo || !selectedFormat) {
    showToast('Select a format first', 'error');
    return;
  }

  const selectedFmt = currentVideo.formats.find(f => f.id === selectedFormat) || {};
  const ext = selectedFmt.ext || (selectedFmt.type === 'audio' ? 'mp3' : 'mp4');

  if (currentVideo.kind === 'playlist') {
    await startPlaylistDownload(selectedFormat, ext);
    return;
  }

  const params = new URLSearchParams({
    url: currentVideo.url,
    formatId: selectedFormat,
    ext,
  });

  const knownBytes = selectedFmt.filesize || selectedFmt.filesizeApprox || null;
  const suggestedFilename = `${sanitizeClientFilename(currentVideo.title || 'video')}.${ext}`;
  const videoTitle = currentVideo.title || 'Untitled';

  // If File System Access API is not supported, fall back to iframe immediately
  if (typeof window.showSaveFilePicker !== 'function') {
    const cardId = createTrayCard(videoTitle, suggestedFilename);
    activeDownloads++;
    queueIframeDownload(params, () => {
      activeDownloads = Math.max(0, activeDownloads - 1);
    });
    updateTrayCard(cardId, 100, 'Started in browser', 'Check your downloads bar');
    finishTrayCard(cardId, true, 'Check your downloads bar');
    showToast('Download started — check your browser downloads bar.');
    return;
  }

  // Show the file picker IMMEDIATELY — must happen within the click gesture.
  // No awaits allowed before this point.
  let fileHandle;
  try {
    fileHandle = await window.showSaveFilePicker({
      suggestedName: suggestedFilename,
      types: [{
        description: `${ext.toUpperCase()} file`,
        accept: { [mimeForExt(ext)]: [`.${ext}`] }
      }],
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user cancelled
    // Picker failed — fallback to iframe
    const cardId = createTrayCard(videoTitle, suggestedFilename);
    activeDownloads++;
    queueIframeDownload(params, () => {
      activeDownloads = Math.max(0, activeDownloads - 1);
    });
    updateTrayCard(cardId, 100, 'Started in browser', 'Check your downloads bar');
    finishTrayCard(cardId, true, 'Check your downloads bar');
    showToast('Folder picker unavailable, using browser download instead.');
    return;
  }

  // User picked a save location — create tray card and start async work.
  // The main card is now free to be reused for a new video search.
  let token = null;
  let cancelled = false;
  let fileStreamAbort = null; // abort controller for Phase 3 file stream
  const cancelDownload = () => {
    if (cancelled) return;
    cancelled = true;
    if (token) {
      fetch(`${API_BASE}/api/download/cancel/${token}`, { method: 'POST' }).catch(() => { });
    }
    if (fileStreamAbort) fileStreamAbort.abort();
  };
  const cardId = createTrayCard(videoTitle, suggestedFilename, cancelDownload);
  activeDownloads++;

  let writable = null;
  try {
    writable = await fileHandle.createWritable();

    // Phase 1: start the background job — returns a token immediately
    // (well within Cloudflare's 100s proxy timeout).
    updateTrayCard(cardId, 2, 'Starting…', '');
    const startRes = await fetch(`${API_BASE}/api/download/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: currentVideo.url,
        formatId: selectedFormat,
        ext,
      }),
    });
    if (!startRes.ok) {
      const errData = await startRes.json().catch(() => ({}));
      throw new Error(errData.error || `Server error ${startRes.status}`);
    }
    ({ token } = await startRes.json());

    // Phase 2: poll status until done, error, or cancelled
    const completedStatus = await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const MAX_ELAPSED_MS = 6 * 60 * 60 * 1000;
      const MAX_CONSECUTIVE_FAILURES = 20;
      let consecutiveFailures = 0;
      let lastProgress = 0;
      let lastStage = 'Working…';
      let lastDetail = '';
      const fmtElapsed = (sec) => sec >= 60
        ? `${Math.floor(sec / 60)}m ${sec % 60}s`
        : `${sec}s`;
      const ticker = setInterval(() => {
        if (cancelled) { clearInterval(ticker); return reject(new Error('cancelled')); }
        const sec = Math.round((Date.now() - startedAt) / 1000);
        updateTrayCard(cardId, lastProgress, lastStage, lastDetail || fmtElapsed(sec));
      }, 1000);
      const stop = () => clearInterval(ticker);

      const poll = async () => {
        if (cancelled) { stop(); return reject(new Error('cancelled')); }
        if (Date.now() - startedAt > MAX_ELAPSED_MS) {
          stop();
          return reject(new Error('Download timed out after 6 hours.'));
        }
        try {
          const statusRes = await fetch(`${API_BASE}/api/download/status/${token}`);
          if (!statusRes.ok) {
            const e = await statusRes.json().catch(() => ({}));
            stop();
            return reject(new Error(e.error || `Status check failed (${statusRes.status})`));
          }
          consecutiveFailures = 0;
          const status = await statusRes.json();
          if (status.state === 'cancelled') { stop(); return reject(new Error('cancelled')); }
          lastProgress = status.progress || 0;
          lastStage = status.stage || 'Working…';
          const sec = Math.round((Date.now() - startedAt) / 1000);
          lastDetail = buildServerProgressDetail(status, fmtElapsed(sec));
          updateTrayCard(cardId, lastProgress, lastStage, lastDetail);
          if (status.state === 'done') { stop(); return resolve(status); }
          if (status.state === 'error') { stop(); return reject(new Error(status.error || 'Download failed on server')); }
          setTimeout(poll, 3000);
        } catch (err) {
          if (cancelled) { stop(); return reject(new Error('cancelled')); }
          consecutiveFailures += 1;
          updateTrayCard(cardId, lastProgress, `Reconnecting… (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`, '');
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            stop();
            return reject(new Error('Lost connection to server after 20 retries.'));
          }
          setTimeout(poll, 3000);
        }
      };
      poll();
    });

    // Use one continuous response instead of many range requests. This is faster
    // and avoids truncating remuxed files when the initial size estimate is wrong.
    let received = 0;
    const total = completedStatus.fileSize || knownBytes || 0;

    updateTrayCard(cardId, 90, 'Saving...', total > 0 ? `0 / ${formatBytes(total)}` : '');

    fileStreamAbort = new AbortController();
    const fileRes = await fetch(`${API_BASE}/api/download/file/${token}`, {
      signal: fileStreamAbort.signal,
    });
    if (!fileRes.ok) {
      const errData = await fileRes.json().catch(() => ({}));
      throw new Error(errData.error || `File fetch failed (${fileRes.status})`);
    }

    const reader = fileRes.body && fileRes.body.getReader
      ? fileRes.body.getReader()
      : null;
    if (!reader) throw new Error('Streaming not supported in this browser.');
    const saveStartedAt = Date.now();

    while (true) {
      if (cancelled) { reader.cancel(); throw new Error('cancelled'); }
      const { done, value } = await reader.read();
      if (done) break;
      const byteLen = value.byteLength || value.length || 0;
      await writable.write(value);
      received += byteLen;
      if (total > 0) {
        const pct = Math.min(99, Math.round(90 + (received / total) * 9));
        updateTrayCard(cardId, pct, `Saving... ${pct}%`,
          buildSaveProgressDetail(received, total, saveStartedAt));
      } else {
        updateTrayCard(cardId, 99, 'Saving...', buildSaveProgressDetail(received, total, saveStartedAt));
      }
    }
    await writable.close();
    finishTrayCard(cardId, true, suggestedFilename);
    showToast(`Done: ${videoTitle.slice(0, 40)}`);
  } catch (err) {
    if (writable) { try { await writable.abort(); } catch (_) { } }
    if (cancelled || err.message === 'cancelled') {
      finishTrayCard(cardId, false, 'Cancelled');
    } else {
      finishTrayCard(cardId, false, (err.message || 'Unknown error').slice(0, 60));
      showToast('Download failed: ' + (err.message || 'Unknown error').slice(0, 60), 'error');
    }
  } finally {
    activeDownloads = Math.max(0, activeDownloads - 1);
  }
}
