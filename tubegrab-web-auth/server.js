const express = require("express");
const cors = require("cors");
const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const os = require("os");
const fs = require("fs");
const archiver = require("archiver");
require("dotenv").config();

const app = express();

function parsePositiveEnvInt(value, fallback) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const NODE_ENV = process.env.NODE_ENV || "development";
const PORT = process.env.PORT || 3000;
// Resolve the absolute path to yt-dlp at startup.
// Using a bare name like "yt-dlp" with spawn() can fail in Docker because
// child processes may not inherit the same PATH as the parent. We resolve
// once via `which` (or `where` on Windows) and use the full path everywhere.
const YT_DLP = (() => {
  if (process.env.YT_DLP_PATH) return process.env.YT_DLP_PATH;
  try {
    const { execFileSync } = require("child_process");
    const whichCmd = process.platform === "win32" ? "where" : "which";
    return execFileSync(whichCmd, ["yt-dlp"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
  } catch {
    return "yt-dlp"; // fallback — will fail loudly at first use
  }
})();
const YTDLP_COOKIES = process.env.YTDLP_COOKIES || "";
const AUTH_USERNAME = process.env.AUTH_USERNAME || "admin";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "change-me-now";
const AUTH_REALM = process.env.AUTH_REALM || "TubeGrab Protected";
const TRUST_PROXY = process.env.TRUST_PROXY || "";
const AUTH_MAX_FAILURES = parsePositiveEnvInt(process.env.AUTH_MAX_FAILURES, 10);
const AUTH_BLOCK_MINUTES = parsePositiveEnvInt(process.env.AUTH_BLOCK_MINUTES, 15);
const GLOBAL_RATE_LIMIT_WINDOW_MS = parsePositiveEnvInt(
  process.env.GLOBAL_RATE_LIMIT_WINDOW_MS,
  60000,
);
const GLOBAL_RATE_LIMIT_MAX = parsePositiveEnvInt(
  process.env.GLOBAL_RATE_LIMIT_MAX,
  120,
);
const DOWNLOAD_RATE_LIMIT_MAX = parsePositiveEnvInt(
  process.env.DOWNLOAD_RATE_LIMIT_MAX,
  8,
);
const DOWNLOAD_START_RATE_LIMIT_MAX = parsePositiveEnvInt(
  process.env.DOWNLOAD_START_RATE_LIMIT_MAX,
  60,
);
const MAX_PLAYLIST_ENTRIES = parsePositiveEnvInt(process.env.MAX_PLAYLIST_ENTRIES, 50);
const MAX_CONCURRENT_JOBS = parsePositiveEnvInt(process.env.MAX_CONCURRENT_JOBS, 25);
// Max parallel yt-dlp processes per playlist ZIP (higher = faster but more RAM/CPU)
const PLAYLIST_CONCURRENCY = parsePositiveEnvInt(process.env.PLAYLIST_CONCURRENCY, 3);
// Max concurrent jobs per IP (prevents one user starving others)
const MAX_JOBS_PER_IP = parsePositiveEnvInt(process.env.MAX_JOBS_PER_IP, 5);
const MAX_INPUT_URL_LENGTH = 2048;
const DEBUG_API_ERRORS =
  String(process.env.DEBUG_API_ERRORS || "").trim().toLowerCase() === "1" ||
  String(process.env.DEBUG_API_ERRORS || "").trim().toLowerCase() === "true";
const DOWNLOAD_WATCHDOG_MS = 180000;
const DOWNLOAD_WATCHDOG_TICK_MS = 15000;
const IFRAME_LIFETIME_MS = 120000;
const JOB_TTL_MS = 30 * 60 * 1000;
const JOB_SWEEP_INTERVAL_MS = 2 * 60 * 1000;  // sweep every 2 min instead of 10
const PROGRESS_RANGE = 70;
const JOB_MAP_CAP = parsePositiveEnvInt(process.env.JOB_MAP_CAP, 500);
const MAX_DURATION_SECONDS = parsePositiveEnvInt(process.env.MAX_DURATION_SECONDS, 0) || null;
const MAX_FILESIZE_BYTES = parsePositiveEnvInt(process.env.MAX_FILESIZE_BYTES, 0) || null;
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || "";
const BIND_HOST = process.env.BIND_HOST || "0.0.0.0";
const authFailuresByIp = new Map();

if (TRUST_PROXY) {
  const normalizedTrustProxy = String(TRUST_PROXY).trim().toLowerCase();
  if (normalizedTrustProxy === "true" || normalizedTrustProxy === "1") {
    app.set("trust proxy", 1);
  } else if (normalizedTrustProxy === "false" || normalizedTrustProxy === "0") {
    app.set("trust proxy", false);
  } else {
    app.set("trust proxy", TRUST_PROXY);
  }
}

if (NODE_ENV === "production") {
  if (!process.env.AUTH_USERNAME || !process.env.AUTH_PASSWORD) {
    throw new Error(
      "[auth] AUTH_USERNAME and AUTH_PASSWORD must be explicitly set in production.",
    );
  }
  if (AUTH_USERNAME === "admin" && AUTH_PASSWORD === "change-me-now") {
    throw new Error("[auth] Default credentials are not allowed in production.");
  }
} else if (AUTH_USERNAME === "admin" && AUTH_PASSWORD === "change-me-now") {
  console.warn(
    "[auth] Using default credentials. Set AUTH_USERNAME and AUTH_PASSWORD for production.",
  );
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function sendAuthChallenge(res) {
  res.set("WWW-Authenticate", `Basic realm=\"${AUTH_REALM}\"`);
  return res.status(401).send("Authentication required");
}

function getClientId(req) {
  const candidate = req.ip || req.socket?.remoteAddress || "";
  return String(candidate).trim() || "unknown";
}

function getBlockedUntil(clientId) {
  const entry = authFailuresByIp.get(clientId);
  if (!entry) return 0;
  if (entry.blockedUntil && entry.blockedUntil > Date.now()) {
    return entry.blockedUntil;
  }
  return 0;
}

function registerAuthFailure(clientId) {
  const now = Date.now();
  const existing = authFailuresByIp.get(clientId) || {
    failures: 0,
    blockedUntil: 0,
    touchedAt: now,
  };

  if (existing.blockedUntil && existing.blockedUntil > now) {
    existing.touchedAt = now;
    authFailuresByIp.set(clientId, existing);
    return existing.blockedUntil;
  }

  existing.failures += 1;
  existing.touchedAt = now;

  if (existing.failures >= AUTH_MAX_FAILURES) {
    existing.failures = 0;
    existing.blockedUntil = now + AUTH_BLOCK_MINUTES * 60 * 1000;
  }

  authFailuresByIp.set(clientId, existing);
  return existing.blockedUntil || 0;
}

function clearAuthFailures(clientId) {
  authFailuresByIp.delete(clientId);
}

const authFailureSweepTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [ip, state] of authFailuresByIp.entries()) {
      if (state.blockedUntil && state.blockedUntil > now) continue;
      if (now - (state.touchedAt || 0) > 30 * 60 * 1000) {
        authFailuresByIp.delete(ip);
      }
    }
  },
  10 * 60 * 1000,
);
if (typeof authFailureSweepTimer.unref === "function") {
  authFailureSweepTimer.unref();
}

const globalLimiter = rateLimit({
  windowMs: GLOBAL_RATE_LIMIT_WINDOW_MS,
  max: GLOBAL_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again shortly." },
});

const directDownloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: DOWNLOAD_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many download requests. Wait and retry." },
});

const downloadStartLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: DOWNLOAD_START_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many queued jobs. Wait and retry." },
});

function basicAuthMiddleware(req, res, next) {
  const clientId = getClientId(req);
  const blockedUntil = getBlockedUntil(clientId);
  if (blockedUntil > Date.now()) {
    const retryAfter = Math.ceil((blockedUntil - Date.now()) / 1000);
    res.set("Retry-After", String(retryAfter));
    return res
      .status(429)
      .send("Too many failed login attempts. Try again later.");
  }

  const authHeader = String(req.headers.authorization || "");
  if (!authHeader.startsWith("Basic ")) {
    return sendAuthChallenge(res);
  }

  let decoded = "";
  try {
    decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
  } catch {
    return sendAuthChallenge(res);
  }

  const separatorIndex = decoded.indexOf(":");
  const username = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : "";
  const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";

  if (
    !safeEqualString(username, AUTH_USERNAME) ||
    !safeEqualString(password, AUTH_PASSWORD)
  ) {
    const newBlockedUntil = registerAuthFailure(clientId);
    if (newBlockedUntil > Date.now()) {
      const retryAfter = Math.ceil((newBlockedUntil - Date.now()) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res
        .status(429)
        .send("Too many failed login attempts. Try again later.");
    }
    return sendAuthChallenge(res);
  }

  clearAuthFailures(clientId);

  next();
}

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "img-src": [
          "'self'",
          "data:",
          "https://i.ytimg.com",
          "https://img.youtube.com",
          "https://yt3.ggpht.com",
        ],
        "script-src": ["'self'", "'unsafe-inline'"],
        "script-src-attr": ["'unsafe-inline'"],
        "style-src": [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com",
        ],
        "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
        "connect-src": ["'self'"],
        "frame-src": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.use(globalLimiter);
// Reject requests missing the shared internal secret set by Nginx.
// Prevents bypassing Nginx/Cloudflare by hitting the Node port directly.
if (INTERNAL_TOKEN) {
  app.use((req, res, next) => {
    const provided = String(req.headers["x-internal-token"] || "");
    if (!safeEqualString(provided, INTERNAL_TOKEN)) {
      return res.status(403).send("Forbidden");
    }
    next();
  });
}
app.use(cors());
app.use(express.json({ limit: "32kb" }));
app.use(basicAuthMiddleware);
app.use(express.static(path.join(__dirname, "public")));

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);
const VIDEO_ID_RE = /^[\w-]{11}$/;
const LIST_ID_RE = /^[\w-]{1,64}$/;

function parseYouTubeURL(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || "").trim());
  } catch {
    try {
      parsed = new URL("https://" + String(raw || "").trim());
    } catch {
      return null;
    }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  const videoId = parsed.searchParams.get("v");
  const listId = parsed.searchParams.get("list");
  const shortMatch = path.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
  const shortId = host === "youtu.be" ? path.slice(1).split("/")[0] : null;

  const hasValidVideo =
    (videoId && VIDEO_ID_RE.test(videoId)) ||
    (shortMatch && VIDEO_ID_RE.test(shortMatch[2])) ||
    (shortId && VIDEO_ID_RE.test(shortId));
  const hasValidList =
    (path === "/playlist" || path.startsWith("/playlist")) &&
    listId &&
    LIST_ID_RE.test(listId);
  const hasValidWatchList =
    path === "/watch" && listId && LIST_ID_RE.test(listId);

  if (!hasValidVideo && !hasValidList && !hasValidWatchList) return null;

  return {
    host,
    path,
    videoId:
      (videoId && VIDEO_ID_RE.test(videoId) && videoId) ||
      (shortMatch && shortMatch[2]) ||
      (shortId && VIDEO_ID_RE.test(shortId) && shortId) ||
      null,
    listId: listId && LIST_ID_RE.test(listId) ? listId : null,
    isPlaylistPath: path.startsWith("/playlist"),
  };
}

function isValidYouTubeURL(url) {
  return parseYouTubeURL(url) !== null;
}

function isPlaylistURL(url) {
  const info = parseYouTubeURL(url);
  if (!info) return false;
  if (info.isPlaylistPath && info.listId) return true;
  return Boolean(info.listId) && !info.videoId;
}

function normalizeRequestUrl(raw) {
  const normalized = String(raw || "").trim();
  if (!normalized || normalized.length > MAX_INPUT_URL_LENGTH) return null;
  return normalized;
}

// Copy the cookie file to a writable temp path so yt-dlp can update it.
// Also watch the source file for changes and re-copy automatically,
// so new cookies can be deployed without restarting the container.
let RESOLVED_COOKIES = "";
const TMP_COOKIES = path.join(os.tmpdir(), "tubegrab_cookies.txt");

function refreshCookies() {
  if (!YTDLP_COOKIES || !fs.existsSync(YTDLP_COOKIES)) return;
  try {
    fs.copyFileSync(YTDLP_COOKIES, TMP_COOKIES);
    fs.chmodSync(TMP_COOKIES, 0o600);
    RESOLVED_COOKIES = TMP_COOKIES;
    console.log("[cookies] Refreshed cookie file →", TMP_COOKIES);
  } catch (e) {
    console.warn("[cookies] Could not refresh cookie file:", e.message);
    if (!RESOLVED_COOKIES) RESOLVED_COOKIES = YTDLP_COOKIES;
  }
}

if (YTDLP_COOKIES) {
  refreshCookies();
  try {
    const watcher = fs.watch(YTDLP_COOKIES, { persistent: false }, (eventType) => {
      if (eventType === "change" || eventType === "rename") {
        console.log("[cookies] Source file changed, re-copying…");
        setTimeout(refreshCookies, 500); // wait for write to flush
      }
    });
    watcher.on("error", (err) => {
      console.warn("[cookies] fs.watch error (will not auto-refresh):", err.message);
    });
  } catch (e) {
    console.warn("[cookies] Cannot watch cookie file:", e.message);
  }
  // Fallback poll every 5 min in case fs.watch doesn't fire (e.g. Docker Desktop on Mac/Windows)
  setInterval(refreshCookies, 5 * 60 * 1000).unref();
}

function withCookies(args) {
  if (RESOLVED_COOKIES && fs.existsSync(RESOLVED_COOKIES)) {
    return ["--cookies", RESOLVED_COOKIES, ...args];
  }
  return args;
}

function extractUsefulError(stderr, fallback) {
  // Pull the most meaningful line from yt-dlp stderr (last non-empty ERROR: line, else last line)
  const lines = String(stderr || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find(l => /^ERROR:/i.test(l));
  const useful = (errorLine || lines[lines.length - 1] || fallback || "yt-dlp failed")
    .replace(/^ERROR:\s*/i, "").trim();
  return useful.slice(0, 400);
}

function runYtDlpRaw(args) {
  return new Promise((resolve, reject) => {
    execFile(
      YT_DLP,
      args,
      { timeout: 120000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(extractUsefulError(stderr, err.message)));
        resolve(stdout.trim());
      },
    );
  });
}

async function runYtDlp(args) {
  // Always include a socket timeout so yt-dlp doesn't hang on flaky connections
  const baseArgs = ["--js-runtimes", "node", "--socket-timeout", "30", ...withCookies(args)];
  try {
    return await runYtDlpRaw(baseArgs);
  } catch (err) {
    const msg = err.message || "";
    const isChallenge =
      /Sign in to confirm|n.challenge|nsig|challenge solving/i.test(msg) ||
      /HTTP Error 429|Too Many Requests/i.test(msg) ||
      /Only images are available/i.test(msg);
    const isTransient =
      /connection reset|connection timed out|socket timeout|network/i.test(msg);

    if (isTransient) {
      // One automatic retry for transient network errors
      console.warn("[yt-dlp] transient error, retrying once:", msg.slice(0, 120));
      await new Promise(r => setTimeout(r, 2000));
      return runYtDlpRaw(baseArgs);
    }
    if (!isChallenge) throw err;
    // Retry with tv_embedded player client as fallback for n-challenge
    console.warn("[yt-dlp] n-challenge detected, retrying with tv_embedded…");
    const fallbackArgs = [
      "--js-runtimes", "node",
      "--socket-timeout", "30",
      "--extractor-args", "youtube:player_client=tv_embedded",
      ...withCookies(args),
    ];
    return runYtDlpRaw(fallbackArgs);
  }
}

function checkBinary(binary, args = ["--version"]) {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { timeout: 15000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          return resolve({
            ok: false,
            error: (stderr || err.message || "check failed").trim().slice(0, 300),
          });
        }
        const firstLine = String(stdout || stderr || "")
          .split(/\r?\n/)
          .map((part) => part.trim())
          .find(Boolean);
        resolve({ ok: true, version: firstLine || "unknown" });
      },
    );
  });
}

function fmtBytes(bytes) {
  if (!bytes) return "varies";
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  return (bytes / 1e3).toFixed(0) + " KB";
}

function toPositiveInt(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isH264(vcodec) {
  return typeof vcodec === "string" && vcodec.startsWith("avc1");
}

function parseFormats(rawFormats) {
  const byHeight = new Map(); // height -> { progressive, adaptive }

  for (const format of rawFormats) {
    if (
      !format ||
      !format.vcodec ||
      format.vcodec === "none" ||
      !format.height
    ) {
      continue;
    }

    const height = format.height;
    const slot = byHeight.get(height) || { progressive: null, adaptive: null };
    const hasAudio = format.acodec && format.acodec !== "none";

    if (hasAudio) {
      // Prefer H.264 MP4 progressive for maximum compatibility (no AV1/VP9).
      const cur = slot.progressive;
      const betterCodec = !cur || (!isH264(cur.vcodec) && isH264(format.vcodec));
      const betterExt = cur && cur.ext !== "mp4" && format.ext === "mp4";
      if (!cur || betterCodec || betterExt) {
        slot.progressive = format;
      }
    } else {
      // Prefer H.264 adaptive video track.
      const cur = slot.adaptive;
      const betterCodec = !cur || (!isH264(cur.vcodec) && isH264(format.vcodec));
      const betterExt = cur && cur.ext !== "mp4" && format.ext === "mp4";
      if (!cur || betterCodec || betterExt) {
        slot.adaptive = format;
      }
    }

    byHeight.set(height, slot);
  }

  const videoFormats = [];
  for (const [height, slot] of byHeight.entries()) {
    if (slot.progressive) {
      const format = slot.progressive;
      // Use a resilient selector instead of the raw format_id.
      // Raw IDs (e.g. "22", "18") can disappear between /api/info and download time.
      videoFormats.push({
        id:
          "bestvideo[vcodec^=avc1][height=" +
          height +
          "]+bestaudio[ext=m4a]/bestvideo[height=" +
          height +
          "]+bestaudio/best[height<=" +
          height +
          "]",
        label: height + "p",
        height,
        detail:
          "MP4 • " +
          fmtBytes(format.filesize || format.filesize_approx),
        type: "video",
        ext: "mp4",
        filesize: format.filesize || null,
        filesizeApprox: format.filesize_approx || null,
        sizeExact: false,
        badge: height >= 1080 ? "HD" : "",
      });
      continue;
    }

    if (slot.adaptive) {
      const format = slot.adaptive;
      // Force H.264 + M4A audio — universally compatible, no AV1/VP9
      videoFormats.push({
        id:
          "bestvideo[vcodec^=avc1][height=" +
          height +
          "]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc1][height<=" +
          height +
          "]+bestaudio[ext=m4a]/bestvideo[height<=" +
          height +
          "]+bestaudio/best[height<=" +
          height +
          "]",
        label: height + "p",
        height,
        detail:
          "MP4 • " +
          fmtBytes(format.filesize || format.filesize_approx) +
          " + audio",
        type: "video",
        ext: "mp4",
        filesize: format.filesize || null,
        filesizeApprox: format.filesize_approx || null,
        sizeExact: false,
        badge: height >= 1080 ? "HD" : "",
      });
    }
  }

  videoFormats.sort((a, b) => b.height - a.height);

  return [
    ...videoFormats,
    {
      id: "bestaudio",
      label: "MP3",
      detail: "320kbps Audio",
      type: "audio",
      ext: "mp3",
      badge: "Audio",
    },
  ];
}

function getFallbackFormats(forPlaylist = false) {
  if (forPlaylist) {
    return [
      {
        id: "best",
        label: "Best",
        detail: "Best available per video",
        type: "video",
        ext: "mp4",
        badge: "HD",
      },
      {
        id: "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
        label: "1080p",
        detail: "Up to 1080p per video",
        type: "video",
        ext: "mp4",
        badge: "FHD",
      },
      {
        id: "bestvideo[height<=720]+bestaudio/best[height<=720]",
        label: "720p",
        detail: "Up to 720p per video",
        type: "video",
        ext: "mp4",
        badge: "HD",
      },
      {
        id: "bestvideo[height<=480]+bestaudio/best[height<=480]",
        label: "480p",
        detail: "Up to 480p per video",
        type: "video",
        ext: "mp4",
        badge: "SD",
      },
      {
        id: "bestvideo[height<=360]+bestaudio/best[height<=360]",
        label: "360p",
        detail: "Up to 360p per video",
        type: "video",
        ext: "mp4",
        badge: "SD",
      },
      {
        id: "bestaudio",
        label: "MP3",
        detail: "Audio only",
        type: "audio",
        ext: "mp3",
        badge: "Audio",
      },
    ];
  }

  return [
    {
      id: "best",
      label: "Best",
      detail: "Best available",
      type: "video",
      ext: "mp4",
      badge: "HD",
    },
    {
      id: "bestaudio",
      label: "MP3",
      detail: "Audio only",
      type: "audio",
      ext: "mp3",
      badge: "Audio",
    },
  ];
}

function normalizePlaylistEntries(entries) {
  const output = [];

  for (let index = 0; index < (entries || []).length; index += 1) {
    const entry = entries[index] || {};
    const fallbackTitle = "Video " + (index + 1);

    let videoId = entry.id || null;
    if (
      !videoId &&
      typeof entry.url === "string" &&
      /^[\w-]{11}$/.test(entry.url)
    ) {
      videoId = entry.url;
    }

    let watchUrl = null;
    if (videoId) {
      watchUrl = "https://www.youtube.com/watch?v=" + videoId;
    } else if (
      typeof entry.url === "string" &&
      /^https?:\/\//.test(entry.url)
    ) {
      watchUrl = entry.url;
      const match = watchUrl.match(/[?&]v=([\w-]{11})/);
      if (match) videoId = match[1];
    }

    if (!watchUrl) continue;

    output.push({
      id: videoId || "item-" + (index + 1),
      title: String(entry.title || fallbackTitle).trim() || fallbackTitle,
      url: watchUrl,
      thumbnail:
        entry.thumbnail ||
        (videoId
          ? "https://img.youtube.com/vi/" + videoId + "/hqdefault.jpg"
          : null),
    });
  }

  return output;
}

function sanitizeFilename(name) {
  return (
    String(name || "video")
      .replace(/[\\/:*?"<>|]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "video"
  );
}

function asciiFallbackFilename(name) {
  return (
    // eslint-disable-next-line no-control-regex
    String(name || "video").replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "") ||
    "video"
  );
}

function createTempDownloadPath(extension) {
  const token = Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  return path.join(os.tmpdir(), "tubegrab-" + token + "." + extension);
}

function removeFileQuietly(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup failures.
  }
}

function preferM4aForMergedSelector(selector) {
  if (!selector || !selector.includes("+")) return selector;

  let normalized = selector;
  normalized = normalized.replace(
    /\+bestaudio\/best/g,
    "+bestaudio[ext=m4a]/bestaudio/best",
  );
  normalized = normalized.replace(
    /\+bestaudio(?!\[)/g,
    "+bestaudio[ext=m4a]/bestaudio",
  );
  return normalized;
}

function getFormatSelector(formatId, isAudio) {
  if (isAudio) return "bestaudio/best";
  const selector = formatId && formatId !== "best" ? formatId : "best";
  return preferM4aForMergedSelector(selector);
}

async function probeDownloadSize(url, formatId, isAudio) {
  const selector = getFormatSelector(formatId, isAudio);

  try {
    const raw = await runYtDlp([
      "--no-warnings",
      "--no-playlist",
      "--skip-download",
      "-f",
      selector,
      "--print",
      "%(filesize)s|%(filesize_approx)s|%(duration)s",
      url,
    ]);

    const line = raw
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find(Boolean);

    if (!line) return { bytes: null, exact: false };

    const [exactRaw, approxRaw, durationRaw] = line.split("|");
    const exactBytes = toPositiveInt(exactRaw);
    const approxBytes = toPositiveInt(approxRaw);
    const durationSeconds = toPositiveInt(durationRaw);

    // Enforce duration limit
    if (MAX_DURATION_SECONDS && durationSeconds && durationSeconds > MAX_DURATION_SECONDS) {
      throw new Error(
        `Video is too long (${Math.round(durationSeconds / 60)} min). ` +
        `Maximum allowed is ${Math.round(MAX_DURATION_SECONDS / 60)} min.`
      );
    }
    // Enforce file size limit
    const estimatedBytes = exactBytes || approxBytes;
    if (MAX_FILESIZE_BYTES && estimatedBytes && estimatedBytes > MAX_FILESIZE_BYTES) {
      const mb = Math.round(estimatedBytes / 1e6);
      const limitMb = Math.round(MAX_FILESIZE_BYTES / 1e6);
      throw new Error(`File is too large (~${mb} MB). Maximum allowed is ${limitMb} MB.`);
    }

    if (isAudio) {
      // MP3 conversion changes final bytes, so this is only an estimate.
      const durationEstimate = durationSeconds
        ? Math.round((durationSeconds * 192000) / 8)
        : null;
      return {
        bytes: exactBytes || approxBytes || durationEstimate,
        exact: false,
      };
    }

    if (exactBytes) return { bytes: exactBytes, exact: true };
    if (approxBytes) return { bytes: approxBytes, exact: false };
    return { bytes: null, exact: false };
  } catch (err) {
    // Re-throw limit errors so callers can surface them to the user
    if (err.message && (err.message.includes("too long") || err.message.includes("too large"))) {
      throw err;
    }
    return { bytes: null, exact: false };
  }
}

function buildDownloadArgs(formatId, isAudio, outputTarget = "-") {
  const selector = getFormatSelector(formatId, isAudio);
  const args = [
    "--js-runtimes", "node",
    "--no-warnings",
    "--no-playlist",
    "--no-check-certificates",
    "--newline",
  ];

  if (isAudio) {
    args.push(
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "-f",
      selector,
      "-o",
      outputTarget,
    );
    return args;
  }

  args.push("-f", selector);
  if (selector.includes("+")) {
    args.push("--merge-output-format", "mp4");
  }
  args.push("-o", outputTarget);
  return args;
}

// Send a JSON response with Cache-Control and ETag headers.
// Clients (including Cloudflare) can cache for up to 5 minutes.
function sendCachedJson(req, res, body) {
  const etag = '"' + crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16) + '"';
  res.set({ "Cache-Control": "private, max-age=300", "ETag": etag });
  if (req.headers["if-none-match"] === etag) return res.status(304).end();
  return res.json(body);
}

// GET /api/info
app.get("/api/info", async (req, res) => {
  const url = normalizeRequestUrl(req.query.url);
  const parsed = parseYouTubeURL(url);
  if (!parsed) {
    return res.status(400).json({ error: "Invalid or missing YouTube URL" });
  }

  try {
    if (isPlaylistURL(url)) {
      const rawPlaylist = await runYtDlp([
        "--dump-single-json",
        "--flat-playlist",
        "--no-warnings",
        "--yes-playlist",
        "--playlist-end",
        String(MAX_PLAYLIST_ENTRIES),
        url,
      ]);
      const playlist = JSON.parse(rawPlaylist);
      const entries = normalizePlaylistEntries(playlist.entries || []).slice(
        0,
        MAX_PLAYLIST_ENTRIES,
      );

      if (!entries.length) {
        return res.status(400).json({
          error: "Playlist found, but no downloadable entries were detected.",
        });
      }

      const playlistFormats = getFallbackFormats(true);
      const firstThumb =
        entries.find((entry) => entry.thumbnail)?.thumbnail || null;

      return sendCachedJson(req, res, {
        kind: "playlist",
        id: playlist.id || "playlist",
        title: playlist.title || "Untitled Playlist",
        channel:
          playlist.uploader ||
          playlist.channel ||
          playlist.playlist_uploader ||
          "Unknown",
        views: null,
        duration: null,
        uploadDate: null,
        thumbnail: playlist.thumbnail || firstThumb,
        playlistCount: entries.length,
        entries,
        formats: playlistFormats,
      });
    }

    const raw = await runYtDlp([
      "--dump-json",
      "--no-warnings",
      "--no-playlist",
      url,
    ]);
    const info = JSON.parse(raw);
    const formats = parseFormats(info.formats || []);
    const fallback = formats.length > 1 ? formats : getFallbackFormats(false);

    sendCachedJson(req, res, {
      kind: "video",
      id: info.id,
      title: info.title || "Untitled",
      channel: info.uploader || info.channel || "Unknown",
      views: info.view_count || 0,
      duration: info.duration ? parseInt(info.duration, 10) : null,
      uploadDate: info.upload_date
        ? info.upload_date.slice(0, 4) +
          "-" +
          info.upload_date.slice(4, 6) +
          "-" +
          info.upload_date.slice(6, 8)
        : null,
      thumbnail:
        info.thumbnail ||
        "https://img.youtube.com/vi/" + info.id + "/maxresdefault.jpg",
      formats: fallback,
    });
  } catch (err) {
    console.error("[/api/info]", err.message);
    const detail = extractUsefulError(err.message, "Failed to fetch video info");
    if (DEBUG_API_ERRORS) {
      return res.status(500).json({ error: detail, debug: String(err.message || "").slice(0, 500) });
    }
    res.status(500).json({ error: detail });
  }
});

// GET /api/download-meta
app.get("/api/download-meta", async (req, res) => {
  const url = normalizeRequestUrl(req.query.url);
  const formatId = String(req.query.formatId || "best").trim();
  const ext = String(req.query.ext || "mp4")
    .trim()
    .toLowerCase();

  if (!url || !isValidYouTubeURL(url)) {
    return res.status(400).json({ error: "Invalid or missing YouTube URL" });
  }

  const isAudio = ext === "mp3" || formatId === "bestaudio";
  const outputExt = isAudio ? "mp3" : ext || "mp4";

  const sizeMeta = await probeDownloadSize(url, formatId, isAudio);
  res.json({
    sizeBytes: sizeMeta.bytes,
    sizeExact: sizeMeta.exact,
    ext: outputExt,
  });
});

// ── Job store ────────────────────────────────────────────────────────────────
// Keyed by token (random hex). States: pending → done | error.
// Files are cleaned up after JOB_TTL_MS or on first file request.
const jobs = new Map();

function countActiveJobs() {
  let active = 0;
  for (const job of jobs.values()) {
    if (job.state === "pending") active += 1;
  }
  return active;
}

function createJob(token, meta) {
  jobs.set(token, {
    token,
    state: "pending",   // pending | done | error
    progress: 0,        // 0-100
    stage: "Queued",
    filename: null,
    filePath: null,
    contentType: null,
    fileSize: null,
    error: null,
    createdAt: Date.now(),
    ...meta,
  });
}

function updateJob(token, patch) {
  const job = jobs.get(token);
  if (job) jobs.set(token, { ...job, ...patch });
}

function cleanupJob(token) {
  const job = jobs.get(token);
  if (!job) return;
  removeFileQuietly(job.filePath);
  jobs.delete(token);
}

// Sweep expired jobs every 2 min. Also enforce JOB_MAP_CAP by evicting
// the oldest completed/errored jobs if the Map grows too large.
const jobSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) cleanupJob(token);
  }
  if (jobs.size > JOB_MAP_CAP) {
    const candidates = [...jobs.entries()]
      .filter(([, j]) => j.state !== "pending")
      .sort(([, a], [, b]) => a.createdAt - b.createdAt);
    for (const [token] of candidates) {
      if (jobs.size <= JOB_MAP_CAP) break;
      cleanupJob(token);
    }
  }
}, JOB_SWEEP_INTERVAL_MS);
if (typeof jobSweepTimer.unref === "function") {
  jobSweepTimer.unref();
}

function performDownload(url, formatId, isAudio, { onProgress, onStage } = {}) {
  const outputExt = isAudio ? "mp3" : "mp4";
  const selector = getFormatSelector(formatId, isAudio);
  const needsMerge = !isAudio && selector.includes("+");
  let tempPath = createTempDownloadPath(outputExt);

  return new Promise((resolve, reject) => {
    const ytdlpArgs = withCookies(
      buildDownloadArgs(formatId, isAudio, tempPath),
    );
    ytdlpArgs.push(url);

    const proc = spawn(YT_DLP, ytdlpArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let streamIndex = 0;
    const expectedStreams = isAudio ? 1 : needsMerge ? 2 : 1;
    let lastActivityAt = Date.now();

    const handleOutput = (text, isErr) => {
      lastActivityAt = Date.now();
      if (text.match(/\[download\]\s+Destination:/g)) {
        streamIndex += text.match(/\[download\]\s+Destination:/g).length;
      }
      if (onProgress) {
        const progressMatches = [
          ...text.matchAll(/\[download\]\s+(\d+(?:\.\d+)?)%/g),
        ];
        if (progressMatches.length) {
          const latest = parseFloat(
            progressMatches[progressMatches.length - 1][1],
          );
          const streams = Math.max(expectedStreams, streamIndex);
          const currentStream = Math.max(1, streamIndex);
          const perStream = PROGRESS_RANGE / streams;
          const base = 5 + (currentStream - 1) * perStream;
          const pct = Math.min(
            75,
            Math.round(base + (latest / 100) * perStream),
          );
          onProgress(pct);
        }
      }
      if (
        onStage &&
        /\[Merger\]|\[ExtractAudio\]|Deleting original|post-process/i.test(text)
      ) {
        onStage("Merging…");
      }
      if (isErr) stderr += text;
      const line = text.trim();
      if (line) console.log("[yt-dlp]", line);
    };

    proc.stdout.on("data", (chunk) => handleOutput(chunk.toString(), false));
    proc.stderr.on("data", (chunk) => handleOutput(chunk.toString(), true));

    const watchdog = setInterval(() => {
      if (Date.now() - lastActivityAt > DOWNLOAD_WATCHDOG_MS) {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
    }, DOWNLOAD_WATCHDOG_TICK_MS);

    proc.on("close", async (code) => {
      clearInterval(watchdog);
      if (code !== 0) {
        removeFileQuietly(tempPath);
        return reject(
          new Error(
            stderr.trim().slice(-300) || "yt-dlp exited with code " + code,
          ),
        );
      }
      if (!fs.existsSync(tempPath)) {
        return reject(new Error("Downloaded file was not generated."));
      }

      // Only remux when we actually merged video + audio — saves one ffmpeg
      // pass for progressive MP4 selections.
      if (!isAudio && needsMerge) {
        if (onStage) onStage("Processing…");
        try {
          const remuxed = await remuxMp4(tempPath);
          removeFileQuietly(tempPath);
          tempPath = remuxed;
        } catch (err) {
          removeFileQuietly(tempPath);
          return reject(err);
        }
      }

      resolve({ path: tempPath, ext: outputExt });
    });

    proc.on("error", (err) => {
      clearInterval(watchdog);
      removeFileQuietly(tempPath);
      reject(err);
    });
  });
}

function remuxMp4(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = createTempDownloadPath("mp4");
    const proc = spawn(
      "ffmpeg",
      [
        "-i",
        inputPath,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-y",
        outputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) return resolve(outputPath);
      removeFileQuietly(outputPath);
      reject(new Error("ffmpeg remux failed: " + stderr.slice(-300)));
    });
    proc.on("error", reject);
  });
}

async function fetchVideoTitle(url) {
  try {
    // --print title is faster than --get-title (no extra API call inside yt-dlp)
    const result = await runYtDlp([
      "--print", "title",
      "--no-warnings",
      "--no-playlist",
      url,
    ]);
    return result.split(/\r?\n/)[0].trim() || "video";
  } catch {
    return "video";
  }
}

function buildContentDisposition(filename) {
  const ascii = asciiFallbackFilename(filename);
  const encoded = encodeURIComponent(filename);
  return 'attachment; filename="' + ascii + "\"; filename*=UTF-8''" + encoded;
}

async function runDownloadJob(token, url, formatId, isAudio) {
  let producedPath = null;
  try {
    updateJob(token, { stage: "Downloading…", progress: 5 });

    let lastProgress = 5;
    const result = await performDownload(url, formatId, isAudio, {
      onProgress: (pct) => {
        if (pct > lastProgress) {
          lastProgress = pct;
          updateJob(token, { progress: pct, stage: "Downloading…" });
        }
      },
      onStage: (stage) => {
        updateJob(token, {
          stage,
          progress: Math.max(lastProgress, 78),
        });
      },
    });
    producedPath = result.path;

    const titleRaw = await fetchVideoTitle(url);
    const filename = sanitizeFilename(titleRaw) + "." + result.ext;
    const stat = fs.statSync(producedPath);

    updateJob(token, {
      state: "done",
      progress: 100,
      stage: "Ready",
      filename,
      filePath: producedPath,
      contentType: isAudio ? "audio/mpeg" : "video/mp4",
      fileSize: stat.size,
    });
    console.log("[job:" + token.slice(0, 6) + "] done →", filename);
  } catch (err) {
    console.error("[job:" + token.slice(0, 6) + "] error:", err.message);
    removeFileQuietly(producedPath);
    updateJob(token, {
      state: "error",
      stage: "Failed",
      error: err.message.slice(0, 300),
    });
  }
}

// POST /api/download/start — kick off background job, return token immediately
app.post("/api/download/start", downloadStartLimiter, async (req, res) => {
  const source = req.body || {};
  const url = normalizeRequestUrl(source.url);
  const formatId = String(source.formatId || "best").trim();
  const ext = String(source.ext || "mp4").trim().toLowerCase();

  if (!url || !isValidYouTubeURL(url)) {
    return res.status(400).json({ error: "Invalid or missing YouTube URL" });
  }

  const isAudio = ext === "mp3" || formatId === "bestaudio";

  // Probe for duration/size limits before creating the job (only when limits are configured)
  if (MAX_DURATION_SECONDS || MAX_FILESIZE_BYTES) {
    try {
      await probeDownloadSize(url, formatId, isAudio);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  const clientId = getClientId(req);

  // Atomic check-and-create: no await between the count check and Map insertion.
  // JS is single-threaded so this is safe as long as there's no await in between.
  if (countActiveJobs() >= MAX_CONCURRENT_JOBS) {
    res.set("Retry-After", "30");
    return res.status(429).json({ error: "Server is busy. Please try again shortly." });
  }
  if (jobs.size >= JOB_MAP_CAP) {
    return res.status(503).json({ error: "Job queue is full. Please try again shortly." });
  }
  // Per-IP fairness: prevent one client from monopolising the queue
  const jobsForIp = [...jobs.values()].filter(j => j.state === "pending" && j.clientId === clientId).length;
  if (jobsForIp >= MAX_JOBS_PER_IP) {
    res.set("Retry-After", "30");
    return res.status(429).json({ error: "You have too many downloads in progress. Wait for one to finish." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  createJob(token, { url, formatId, isAudio, clientId });
  runDownloadJob(token, url, formatId, isAudio);

  res.json({ token });
});

// GET /api/download/status/:token — poll for job progress (no clientId check — share with any device)
app.get("/api/download/status/:token", (req, res) => {
  const token = String(req.params.token || "").trim();
  const job = jobs.get(token);
  if (!job) return res.status(404).json({ error: "Job not found or expired" });

  res.json({
    state: job.state,
    progress: job.progress,
    stage: job.stage,
    filename: job.filename,
    fileSize: job.fileSize,
    error: job.error,
  });
});

// GET /api/download/file/:token — stream the finished file.
// File is deleted 60s after first serve so multiple devices can re-download within that window.
app.get("/api/download/file/:token", (req, res) => {
  const token = String(req.params.token || "").trim();
  const job = jobs.get(token);

  if (!job) return res.status(404).json({ error: "Job not found or expired" });
  if (job.state === "pending") return res.status(202).json({ error: "Download not ready yet" });
  if (job.state === "error") return res.status(500).json({ error: job.error || "Download failed" });
  if (!job.filePath || !fs.existsSync(job.filePath)) {
    cleanupJob(token);
    return res.status(410).json({ error: "File has already been served or was cleaned up" });
  }

  res.set({
    "Content-Type": job.contentType,
    "Content-Disposition": buildContentDisposition(job.filename),
    "Cache-Control": "no-store",
    "Content-Length": String(job.fileSize),
  });

  // Schedule cleanup 60s after the first serve — gives other devices time to download
  if (!job.servedAt) {
    updateJob(token, { servedAt: Date.now() });
    setTimeout(() => cleanupJob(token), 60 * 1000).unref();
  }

  const fileStream = fs.createReadStream(job.filePath);
  fileStream.on("error", (err) => {
    if (!res.headersSent) res.status(500).json({ error: "File read failed: " + err.message });
    else res.destroy(err);
  });
  fileStream.pipe(res);
});

// Legacy direct-download (kept for iframe fallback path used by playlists)
async function streamDownload(req, res) {
  const source =
    req.method === "GET" || req.method === "HEAD" ? req.query : req.body || {};
  const url = normalizeRequestUrl(source.url);
  const formatId = String(source.formatId || "best").trim();
  const ext = String(source.ext || "mp4").trim().toLowerCase();

  if (!url || !isValidYouTubeURL(url)) {
    return res.status(400).json({ error: "Invalid or missing YouTube URL" });
  }

  const isAudio = ext === "mp3" || formatId === "bestaudio";
  const contentType = isAudio ? "audio/mpeg" : "video/mp4";
  let producedPath = null;

  try {
    const result = await performDownload(url, formatId, isAudio);
    producedPath = result.path;

    const titleRaw = await fetchVideoTitle(url);
    const filename = sanitizeFilename(titleRaw) + "." + result.ext;
    const stat = fs.statSync(producedPath);

    res.set({
      "Content-Type": contentType,
      "Content-Disposition": buildContentDisposition(filename),
      "Cache-Control": "no-store",
      "Content-Length": String(stat.size),
    });

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      removeFileQuietly(producedPath);
    };
    const fileStream = fs.createReadStream(producedPath);
    fileStream.on("error", (err) => {
      cleanup();
      if (!res.headersSent)
        res
          .status(500)
          .json({ error: "Download failed: " + err.message.slice(0, 200) });
      else res.destroy(err);
    });
    fileStream.on("close", cleanup);
    res.on("close", cleanup);
    fileStream.pipe(res);
  } catch (err) {
    console.error("[/api/download]", err.message);
    removeFileQuietly(producedPath);
    if (!res.headersSent)
      res
        .status(500)
        .json({ error: "Download failed: " + err.message.slice(0, 200) });
  }
}

// In-memory SSE progress channels for playlist ZIP jobs.
// Key: progressId (random hex), Value: { send(event, data), close() }
const zipProgressChannels = new Map();

// GET /api/download/playlist-zip/progress/:id — SSE stream for ZIP progress
app.get("/api/download/playlist-zip/progress/:id", (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id || !/^[0-9a-f]{32}$/.test(id)) {
    return res.status(400).end();
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable Nginx buffering
  res.flushHeaders();

  const send = (event, data) => {
    res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
    if (typeof res.flush === "function") res.flush();
  };

  zipProgressChannels.set(id, { send, close: () => res.end() });

  req.on("close", () => {
    zipProgressChannels.delete(id);
  });

  // Auto-cleanup after 30 min
  setTimeout(() => {
    if (zipProgressChannels.has(id)) {
      zipProgressChannels.delete(id);
      try { res.end(); } catch {}
    }
  }, 30 * 60 * 1000).unref();
});

// POST /api/download/playlist-zip — download all playlist videos and stream as a ZIP
const playlistZipLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many playlist ZIP requests. Wait and retry." },
});

app.post("/api/download/playlist-zip", playlistZipLimiter, async (req, res) => {
  const source = req.body || {};
  const url = normalizeRequestUrl(source.url);
  const formatId = String(source.formatId || "best").trim();
  const ext = String(source.ext || "mp4").trim().toLowerCase();
  const progressId = String(source.progressId || "").trim();

  if (!url || !isPlaylistURL(url)) {
    return res.status(400).json({ error: "Invalid or missing playlist URL" });
  }

  const isAudio = ext === "mp3" || formatId === "bestaudio";

  // Abort controller — triggered when client disconnects or hits /cancel
  let aborted = false;
  let currentProc = null; // tracks the most recently spawned yt-dlp (for abort signalling)
  const activeProcs = new Set(); // all running yt-dlp processes for this job
  const abort = (reason = "cancelled") => {
    if (aborted) return;
    aborted = true;
    console.log("[playlist-zip] aborting:", reason);
    for (const p of activeProcs) { try { p.kill("SIGKILL"); } catch {} }
    activeProcs.clear();
  };

  // Register this job so /cancel can reach it
  if (progressId) zipProgressChannels.set("abort:" + progressId, { abort });

  // Detect client disconnect (tab closed, network drop, etc.)
  res.on("close", () => abort("client disconnected"));

  // Helper: send SSE event if a progress channel is registered
  const emit = (event, data) => {
    const ch = zipProgressChannels.get(progressId);
    if (ch && ch.send) ch.send(event, data);
  };
  const closeProgress = () => {
    const ch = zipProgressChannels.get(progressId);
    if (ch && ch.close) { ch.close(); }
    zipProgressChannels.delete(progressId);
    zipProgressChannels.delete("abort:" + progressId);
  };

  // Temp file tracker — cleaned up on abort or completion
  const tempFiles = new Set();
  const cleanupTempFiles = () => {
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch {} }
    tempFiles.clear();
  };

  let entries;
  try {
    emit("status", { stage: "Fetching playlist info…", current: 0, total: 0 });

    const rawPlaylist = await runYtDlp([
      "--dump-single-json",
      "--flat-playlist",
      "--no-warnings",
      "--yes-playlist",
      "--playlist-end",
      String(MAX_PLAYLIST_ENTRIES),
      url,
    ]);
    const playlist = JSON.parse(rawPlaylist);
    entries = normalizePlaylistEntries(playlist.entries || []).slice(0, MAX_PLAYLIST_ENTRIES);
    if (!entries.length) {
      closeProgress();
      return res.status(400).json({ error: "Playlist has no downloadable entries." });
    }

    if (aborted) { closeProgress(); return res.destroy(); }

    const playlistTitle = sanitizeFilename(playlist.title || "Playlist");
    const outputExt = isAudio ? "mp3" : "mp4";
    const total = entries.length;

    emit("status", { stage: "Starting download…", current: 0, total });

    // Headers must be set before archiver starts writing
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", buildContentDisposition(playlistTitle + ".zip"));
    res.setHeader("Cache-Control", "no-store");

    const archive = archiver("zip", { zlib: { level: 0 } });
    archive.on("warning", (err) => console.warn("[playlist-zip] archiver warning:", err.message));
    archive.on("error", (err) => {
      if (!aborted) console.error("[playlist-zip] archiver error:", err.message);
      res.destroy(err);
    });
    archive.pipe(res);

    let completed = 0;
    let failed = 0;
    let finishedCount = 0; // tracks how many videos have fully resolved (done or failed)

    // Whether this format requires ffmpeg merging (video+audio streams).
    // yt-dlp cannot merge to stdout — must write to a temp file first.
    const needsMerge = !isAudio && formatId.includes("+");

    // Downloads N videos in parallel (PLAYLIST_CONCURRENCY at a time).
    // Each slot downloads to a temp file, then adds it to the archive sequentially
    // so archiver doesn't receive interleaved streams.
    // A mutex (archiveLock) ensures only one video is being appended to the archive at a time.
    let archiveLock = Promise.resolve();

    // Download a single entry to a temp file and resolve with { tempPath, filename, entry, index }
    const downloadEntry = (entry, i) => new Promise((resolve, reject) => {
      if (aborted) return reject(new Error("cancelled"));

      const title = sanitizeFilename(entry.title) || "video-" + (i + 1);
      const filename = title + "." + outputExt;
      const tempPath = path.join(os.tmpdir(), "plzip-" + crypto.randomUUID() + "." + outputExt);
      tempFiles.add(tempPath);

      emit("downloading", { current: i + 1, total, title: entry.title || title });
      console.log("[playlist-zip] downloading", (i + 1) + "/" + total, title);

      const args = withCookies(buildDownloadArgs(formatId, isAudio, needsMerge ? tempPath : "-"));
      args.push(entry.url);
      const proc = spawn(YT_DLP, args, { stdio: ["ignore", needsMerge ? "ignore" : "pipe", "pipe"] });
      currentProc = proc;
      activeProcs.add(proc);

      let stderrBuf = "";
      proc.stderr.on("data", (d) => {
        const line = d.toString().trim();
        if (line) {
          stderrBuf += line + "\n";
          if (/\[Merger\]|\[ffmpeg\]|Merging/i.test(line)) {
            emit("merging", { current: i + 1, total, title: entry.title || title });
          }
        }
      });

      if (!needsMerge) {
        // For single-stream, collect stdout into a temp file so parallel downloads
        // don't interleave — each finishes independently then gets appended in order
        const writeStream = fs.createWriteStream(tempPath);
        proc.stdout.pipe(writeStream);
        writeStream.on("error", reject);
      }

      proc.on("error", (err) => { activeProcs.delete(proc); reject(err); });
      proc.on("close", (code) => {
        activeProcs.delete(proc);
        if (aborted) return reject(new Error("cancelled"));
        if (code !== 0) {
          const msg = extractUsefulError(stderrBuf, "yt-dlp exited with code " + code);
          return reject(new Error(msg));
        }
        resolve({ tempPath, filename, entry, index: i });
      });
    });

    // Add a completed temp file into the archive (serialised via archiveLock)
    const appendToArchive = ({ tempPath, filename, entry, index }) => {
      archiveLock = archiveLock.then(() => new Promise((resolve) => {
        if (aborted || !fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch {}
          tempFiles.delete(tempPath);
          return resolve();
        }
        archive.once("entry", () => {
          try { fs.unlinkSync(tempPath); } catch {}
          tempFiles.delete(tempPath);
          resolve();
        });
        archive.file(tempPath, { name: filename });
      }));
      return archiveLock;
    };

    // Run downloads with a concurrency pool
    const semaphore = { running: 0, queue: [] };
    const acquireSemaphore = () => new Promise(resolve => {
      if (semaphore.running < PLAYLIST_CONCURRENCY) {
        semaphore.running++;
        resolve();
      } else {
        semaphore.queue.push(resolve);
      }
    });
    const releaseSemaphore = () => {
      if (semaphore.queue.length > 0) {
        const next = semaphore.queue.shift();
        next();
      } else {
        semaphore.running--;
      }
    };

    const entryPromises = entries.map((entry, i) => (async () => {
      if (aborted) return;
      await acquireSemaphore();
      try {
        const result = await downloadEntry(entry, i);
        if (!aborted) {
          await appendToArchive(result);
          completed++;
          finishedCount++;
          emit("done", { current: finishedCount, total, title: entry.title || result.filename, completed, failed });
        }
      } catch (err) {
        finishedCount++;
        if (aborted) return;
        failed++;
        const title = sanitizeFilename(entry.title) || "video-" + (i + 1);
        console.error("[playlist-zip] failed:", entry.url, err.message);
        archive.append("Download failed: " + err.message.slice(0, 300), {
          name: "FAILED - " + title + ".txt",
        });
        emit("failed", { current: finishedCount, total, title: entry.title || title, completed, failed, error: err.message.slice(0, 200) });
      } finally {
        releaseSemaphore();
      }
    })());

    await Promise.all(entryPromises);
    // Wait for all archive appends to finish
    await archiveLock;
    cleanupTempFiles();

    if (!aborted) {
      await archive.finalize();
      emit("complete", { total, completed, failed });
    } else {
      archive.abort();
      res.destroy();
    }
    closeProgress();
  } catch (err) {
    cleanupTempFiles();
    if (!aborted) console.error("[playlist-zip]", err.message);
    emit("zip-error", { error: err.message.slice(0, 300) });
    closeProgress();
    if (!res.headersSent) {
      return res.status(500).json({ error: "Playlist ZIP failed: " + err.message.slice(0, 300) });
    }
    res.destroy(err);
  }
});

// POST /api/download/playlist-zip/cancel/:id — cancel an in-progress playlist ZIP
// Called via sendBeacon on page unload so the server stops yt-dlp and deletes temp files.
app.post("/api/download/playlist-zip/cancel/:id", (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id || !/^[0-9a-f]{32}$/.test(id)) return res.status(400).end();
  const abortHandle = zipProgressChannels.get("abort:" + id);
  if (abortHandle) abortHandle.abort("cancel endpoint");
  res.status(204).end();
});

// GET /api/download — legacy direct stream (used by playlist iframe fallback)
app.use("/api/download", directDownloadLimiter);
app.get("/api/download", streamDownload);
app.post("/api/download", streamDownload);

// GET /api/formats
app.get("/api/formats", async (req, res) => {
  const url = normalizeRequestUrl(req.query.url);
  if (!url || !isValidYouTubeURL(url)) {
    return res.status(400).json({ error: "Invalid YouTube URL" });
  }

  try {
    const raw = await runYtDlp([
      "--dump-json",
      "--no-warnings",
      "--no-playlist",
      url,
    ]);
    res.json({ formats: parseFormats(JSON.parse(raw).formats || []) });
  } catch (err) {
    res.status(500).json({ error: "Failed to get formats" });
  }
});

// Health check
app.get("/api/health", async (req, res) => {
  const [ytDlpCheck, ffmpegCheck] = await Promise.all([
    checkBinary(YT_DLP, ["--version"]),
    checkBinary("ffmpeg", ["-version"]),
  ]);

  let diskFreeBytes = null;
  try {
    // fs.statfsSync available Node 19+ (we use node:20-slim so this is safe)
    const stat = fs.statfsSync(os.tmpdir());
    diskFreeBytes = stat.bfree * stat.bsize;
  } catch {}

  const cookieFileExists = RESOLVED_COOKIES
    ? fs.existsSync(RESOLVED_COOKIES)
    : YTDLP_COOKIES ? fs.existsSync(YTDLP_COOKIES) : null;

  const healthy = ytDlpCheck.ok && ffmpegCheck.ok;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    ytdlpPath: YT_DLP,
    ytdlp: ytDlpCheck,
    ffmpeg: ffmpegCheck,
    cookies: { configured: Boolean(YTDLP_COOKIES), fileExists: cookieFileExists },
    disk: { freeBytesApprox: diskFreeBytes },
    jobs: { active: countActiveJobs(), total: jobs.size, cap: JOB_MAP_CAP },
    timestamp: new Date().toISOString(),
  });
});

// Build timestamp: most recent mtime across server.js and public/index.html.
// Frontend displays this in the footer so you can confirm deploys went through.
const BUILD_STARTED_AT = new Date().toISOString();
app.get("/api/version", (req, res) => {
  let latest = 0;
  for (const rel of ["server.js", "public/index.html"]) {
    try {
      const m = fs.statSync(path.join(__dirname, rel)).mtimeMs;
      if (m > latest) latest = m;
    } catch {}
  }
  res.json({
    lastPatched: latest ? new Date(latest).toISOString() : null,
    startedAt: BUILD_STARTED_AT,
  });
});

// Fallback to frontend
app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function startServer(port = PORT) {
  return app.listen(port, BIND_HOST, () => {
    console.log("\n  TubeGrab running at http://" + BIND_HOST + ":" + port + "\n");
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  parsePositiveEnvInt,
  parseYouTubeURL,
  isPlaylistURL,
  normalizeRequestUrl,
  getClientId,
  MAX_INPUT_URL_LENGTH,
};

