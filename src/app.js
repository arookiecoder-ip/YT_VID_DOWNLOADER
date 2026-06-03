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
const { createSystemRoutes } = require("./routes/systemRoutes");
const { createViewRoutes } = require("./routes/viewRoutes");
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
// Set YTDLP_USE_NODE_RUNTIME=1 only if yt-dlp >= 2023.11 is installed.
// Older versions don't recognise --js-runtimes and abort before fetching anything.
const YTDLP_USE_NODE_RUNTIME =
  String(process.env.YTDLP_USE_NODE_RUNTIME || "").trim() === "1" ||
  String(process.env.YTDLP_USE_NODE_RUNTIME || "").trim().toLowerCase() === "true";
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
const MAX_PLAYLIST_ENTRIES = parsePositiveEnvInt(process.env.MAX_PLAYLIST_ENTRIES, 500);
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
const YTDLP_CONCURRENT_FRAGMENTS = parsePositiveEnvInt(process.env.YTDLP_CONCURRENT_FRAGMENTS, 8);
const FILE_STREAM_HIGH_WATER_MARK = 1024 * 1024;
const IFRAME_LIFETIME_MS = 120000;
const JOB_TTL_MS = 30 * 60 * 1000;
const JOB_SWEEP_INTERVAL_MS = 2 * 60 * 1000;  // sweep every 2 min instead of 10
const JOB_DOWNLOAD_CLEANUP_MS = 30 * 60 * 1000;
const PROGRESS_RANGE = 80;
const JOB_MAP_CAP = parsePositiveEnvInt(process.env.JOB_MAP_CAP, 500);
const MAX_DURATION_SECONDS = parsePositiveEnvInt(process.env.MAX_DURATION_SECONDS, 0) || null;
const MAX_FILESIZE_BYTES = parsePositiveEnvInt(process.env.MAX_FILESIZE_BYTES, 0) || null;
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || "";
const BIND_HOST = process.env.BIND_HOST || "0.0.0.0";
const authFailuresByIp = new Map();
const activeDownloadArtifacts = new Set();

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
  // Fix 6: warn loudly in all non-production environments so accidental deploys
  // with NODE_ENV unset are visible in logs. The server still starts — operators
  // may intentionally run with defaults in a local/dev context.
  console.warn(
    "[auth] WARNING: Using default credentials (admin/change-me-now). " +
    "Set AUTH_USERNAME and AUTH_PASSWORD before exposing this server to a network.",
  );
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  // Pad both buffers to the same length before comparing so the early-return
  // on length mismatch doesn't leak credential length via timing side-channel.
  const maxLen = Math.max(left.length, right.length);
  const paddedLeft = Buffer.concat([left, Buffer.alloc(maxLen - left.length)]);
  const paddedRight = Buffer.concat([right, Buffer.alloc(maxLen - right.length)]);
  return crypto.timingSafeEqual(paddedLeft, paddedRight) && left.length === right.length;
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
app.use(express.static(path.join(__dirname, "..", "public")));

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
  // Fix 4: watch?v=X&list=Y URLs are intentionally treated as single-video downloads.
  // Only a bare playlist URL (no videoId) is routed through the playlist path.
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
        if (err) {
          // Log the raw stderr so operators can see the real yt-dlp error in docker logs
          const stderrTrimmed = String(stderr || "").trim();
          if (stderrTrimmed) console.error("[yt-dlp stderr]", stderrTrimmed.slice(0, 800));
          return reject(new Error(extractUsefulError(stderr, err.message)));
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function runYtDlp(args) {
  // Always include a socket timeout so yt-dlp doesn't hang on flaky connections.
  // --js-runtimes node is only added when YTDLP_USE_NODE_RUNTIME=1 — older yt-dlp
  // versions don't recognise this flag and abort immediately with an error.
  const runtimeFlag = YTDLP_USE_NODE_RUNTIME ? ["--js-runtimes", "node"] : [];
  const baseArgs = [...runtimeFlag, "--socket-timeout", "30", ...withCookies(args)];
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
      ...runtimeFlag,
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
  // Fix 10: treat null/undefined as unknown size; 0 is a valid (if unusual) value
  if (bytes == null) return "varies";
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  return (bytes / 1e3).toFixed(0) + " KB";
}

function parseYtDlpProgress(text) {
  const lines = String(text || "").split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const percentMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (!percentMatch) continue;

    const totalMatch = line.match(/\bof\s+([^\s]+(?:\s*[KMGT]i?B)?)/i);
    const speedMatch = line.match(/\bat\s+([^\s]+(?:\s*[KMGT]i?B\/s|B\/s))/i);
    const etaMatch = line.match(/\bETA\s+([0-9:]+)/i);

    return {
      sourcePercent: Number.parseFloat(percentMatch[1]),
      totalText: totalMatch ? totalMatch[1].replace(/\s+/g, "") : null,
      speedText: speedMatch ? speedMatch[1].replace(/\s+/g, "") : null,
      etaText: etaMatch ? etaMatch[1] : null,
    };
  }
  return null;
}

function toPositiveInt(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isH264(vcodec) {
  return typeof vcodec === "string" && vcodec.startsWith("avc1");
}

function isSafeProgressiveFormat(format) {
  return !!(
    format &&
    format.format_id &&
    format.ext === "mp4" &&
    format.vcodec &&
    format.vcodec !== "none" &&
    format.acodec &&
    format.acodec !== "none"
  );
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
      const streamable = isSafeProgressiveFormat(format);
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
        streamable,
        streamFormatId: streamable ? String(format.format_id) : null,
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
        streamable: false,
        streamFormatId: null,
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
      streamable: false,
      streamFormatId: null,
      badge: "Audio",
    },
  ];
}

function getFallbackFormats(forPlaylist = false) {
  if (forPlaylist) {
    return [
      {
        id: "bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]",
        label: "Best",
        detail: "Best available per video",
        type: "video",
        ext: "mp4",
        badge: "HD",
      },
      {
        id: "bestvideo[vcodec^=avc1][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]",
        label: "1080p",
        detail: "Up to 1080p per video",
        type: "video",
        ext: "mp4",
        badge: "FHD",
      },
      {
        id: "bestvideo[vcodec^=avc1][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]",
        label: "720p",
        detail: "Up to 720p per video",
        type: "video",
        ext: "mp4",
        badge: "HD",
      },
      {
        id: "bestvideo[vcodec^=avc1][height<=480]+bestaudio[ext=m4a]/best[ext=mp4][height<=480]",
        label: "480p",
        detail: "Up to 480p per video",
        type: "video",
        ext: "mp4",
        badge: "SD",
      },
      {
        id: "bestvideo[vcodec^=avc1][height<=360]+bestaudio[ext=m4a]/best[ext=mp4][height<=360]",
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
      id: "bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]",
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
      // Fix 9: strip leading dots to prevent hidden files on Linux/macOS
      .replace(/^\.+/, "")
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

function removeDownloadArtifacts(filePath) {
  if (!filePath) return;
  activeDownloadArtifacts.delete(filePath);
  removeFileQuietly(filePath);
  removeFileQuietly(filePath + ".part");

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry === base || entry === base + ".part" || entry.startsWith(base + ".")) {
        removeFileQuietly(path.join(dir, entry));
      }
    }
  } catch {
    // Ignore best-effort artifact cleanup failures.
  }
}

function isActiveDownloadArtifact(filePath) {
  for (const activePath of activeDownloadArtifacts) {
    if (filePath === activePath || filePath.startsWith(activePath + ".")) return true;
  }
  return false;
}

function sweepOrphanedTempDownloads(maxAgeMs = JOB_DOWNLOAD_CLEANUP_MS) {
  const tmpDir = os.tmpdir();
  const now = Date.now();
  try {
    for (const entry of fs.readdirSync(tmpDir)) {
      if (!entry.startsWith("tubegrab-") && !entry.startsWith("plzip-")) continue;
      const filePath = path.join(tmpDir, entry);
      if (isActiveDownloadArtifact(filePath)) continue;
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile() || now - stat.mtimeMs < maxAgeMs) continue;
      removeFileQuietly(filePath);
    }
  } catch (err) {
    console.warn("[cleanup] Could not sweep temp downloads:", err.message);
  }
}

function markDownloadArtifact(filePath) {
  if (filePath) activeDownloadArtifacts.add(filePath);
}

function unmarkDownloadArtifact(filePath) {
  if (filePath) activeDownloadArtifacts.delete(filePath);
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
  const selector = formatId && formatId !== "best"
    ? formatId
    : "bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]";
  return preferM4aForMergedSelector(selector);
}

function isDirectStreamSafe(url, formatId, isAudio, ext) {
  if (!url || !isValidYouTubeURL(url) || isPlaylistURL(url)) return false;
  if (isAudio || ext !== "mp4") return false;

  const selector = String(formatId || "").trim();
  if (!selector || selector === "best" || selector === "bestaudio") return false;
  if (/[+/\[\]()]/.test(selector)) return false;
  return /^[A-Za-z0-9_.-]+$/.test(selector);
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
  const runtimeFlag = YTDLP_USE_NODE_RUNTIME ? ["--js-runtimes", "node"] : [];
  const args = [
    ...runtimeFlag,
    "--no-warnings",
    "--no-playlist",
    "--no-check-certificates",
    "--concurrent-fragments",
    String(YTDLP_CONCURRENT_FRAGMENTS),
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
      // Use a tighter execFile timeout for flat-playlist fetches — they should be fast.
      // runYtDlpRaw uses 120 s by default; for large playlists that can still hang.
      // We wrap in a race so the HTTP request fails cleanly after 90 s.
      const playlistFetchPromise = runYtDlp([
        "--dump-single-json",
        "--flat-playlist",
        "--no-warnings",
        "--yes-playlist",
        "--playlist-end",
        String(MAX_PLAYLIST_ENTRIES),
        url,
      ]);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Playlist info fetch timed out after 90 seconds.")), 90000)
      );
      const rawPlaylist = await Promise.race([playlistFetchPromise, timeoutPromise]);
      const playlist = JSON.parse(rawPlaylist);
      const allEntries = normalizePlaylistEntries(playlist.entries || []);
      const truncated = allEntries.length >= MAX_PLAYLIST_ENTRIES;
      const entries = allEntries.slice(0, MAX_PLAYLIST_ENTRIES);

      if (!entries.length) {
        // Distinguish between private/empty and truly not found
        const errMsg = /private|unavailable|sign in/i.test(rawPlaylist)
          ? "This playlist is private or unavailable. Sign in with cookies to access it."
          : "Playlist found, but no downloadable entries were detected. It may be empty or region-locked.";
        return res.status(400).json({ error: errMsg });
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
        truncated,          // true when playlist has more videos than MAX_PLAYLIST_ENTRIES
        totalCount: playlist.playlist_count || null,
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

  try {
    const sizeMeta = await probeDownloadSize(url, formatId, isAudio);
    res.json({
      sizeBytes: sizeMeta.bytes,
      sizeExact: sizeMeta.exact,
      ext: outputExt,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// ── Job store ────────────────────────────────────────────────────────────────
// Keyed by token (random hex). States: pending → done | error.
// Files are cleaned up 30 minutes after a job reaches done/error.
const jobs = new Map();
const jobCleanupTimers = new Map();

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
    sourcePercent: null,
    speedText: null,
    etaText: null,
    totalText: null,
    error: null,
    createdAt: Date.now(),
    completedAt: null,
    cleanupAt: null,
    ...meta,
  });
}

function updateJob(token, patch) {
  const job = jobs.get(token);
  if (job) jobs.set(token, { ...job, ...patch });
}

function cleanupJob(token) {
  const timer = jobCleanupTimers.get(token);
  if (timer) clearTimeout(timer);
  jobCleanupTimers.delete(token);

  const job = jobs.get(token);
  if (!job) return;
  removeDownloadArtifacts(job.filePath);
  jobs.delete(token);
}

function scheduleJobCleanup(token, delayMs = JOB_DOWNLOAD_CLEANUP_MS) {
  if (!jobs.has(token)) return;
  const existing = jobCleanupTimers.get(token);
  if (existing) clearTimeout(existing);

  const cleanupAt = Date.now() + delayMs;
  updateJob(token, { cleanupAt });
  const timer = setTimeout(() => cleanupJob(token), delayMs);
  if (typeof timer.unref === "function") timer.unref();
  jobCleanupTimers.set(token, timer);
}

// Sweep expired completed/error jobs every 2 min. Pending jobs are not swept
// by creation time because long videos can legitimately run past 30 minutes.
const jobSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, job] of jobs.entries()) {
    if (
      job.state !== "pending" &&
      (job.cleanupAt || ((job.completedAt || job.createdAt) + JOB_TTL_MS)) <= now
    ) {
      cleanupJob(token);
    }
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

sweepOrphanedTempDownloads();
const orphanSweepTimer = setInterval(sweepOrphanedTempDownloads, JOB_SWEEP_INTERVAL_MS);
if (typeof orphanSweepTimer.unref === "function") {
  orphanSweepTimer.unref();
}

function performDownload(url, formatId, isAudio, { onProgress, onStage, onProc } = {}) {
  const outputExt = isAudio ? "mp3" : "mp4";
  const selector = getFormatSelector(formatId, isAudio);
  const needsMerge = !isAudio && selector.includes("+");
  let tempPath = createTempDownloadPath(outputExt);
  activeDownloadArtifacts.add(tempPath);

  return new Promise((resolve, reject) => {
    const ytdlpArgs = withCookies(
      buildDownloadArgs(formatId, isAudio, tempPath),
    );
    ytdlpArgs.push(url);

    const proc = spawn(YT_DLP, ytdlpArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (onProc) onProc(proc);
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
        const metrics = parseYtDlpProgress(text);
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
            85,
            Math.round(base + (latest / 100) * perStream),
          );
          onProgress(pct, metrics);
        } else if (metrics) {
          onProgress(null, metrics);
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
        removeDownloadArtifacts(tempPath);
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
          removeDownloadArtifacts(tempPath);
          tempPath = remuxed;
        } catch (err) {
          removeDownloadArtifacts(tempPath);
          return reject(err);
        }
      }

      resolve({ path: tempPath, ext: outputExt });
    });

    proc.on("error", (err) => {
      clearInterval(watchdog);
      removeDownloadArtifacts(tempPath);
      reject(err);
    });
  });
}

function remuxMp4(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = createTempDownloadPath("mp4");
    activeDownloadArtifacts.add(outputPath);
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
      removeDownloadArtifacts(outputPath);
      reject(new Error("ffmpeg remux failed: " + stderr.slice(-300)));
    });
    proc.on("error", (err) => {
      removeDownloadArtifacts(outputPath);
      reject(err);
    });
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
      onProgress: (pct, metrics = {}) => {
        if (pct > lastProgress) {
          lastProgress = pct;
        }
        updateJob(token, {
          progress: Math.max(lastProgress, pct || 0),
          stage: "Downloading…",
          ...metrics,
        });
      },
      onStage: (stage) => {
        updateJob(token, {
          stage,
          progress: Math.max(lastProgress, 88),
        });
      },
      onProc: (proc) => {
        // Store kill handle so /cancel endpoint can terminate the process
        updateJob(token, { killProc: () => { try { proc.kill("SIGKILL"); } catch {} } });
      },
    });
    producedPath = result.path;
    if (!jobs.has(token)) {
      removeDownloadArtifacts(producedPath);
      return;
    }

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
      completedAt: Date.now(),
      killProc: null,
    });
    scheduleJobCleanup(token);
    console.log("[job:" + token.slice(0, 6) + "] done →", filename);
  } catch (err) {
    const job = jobs.get(token);
    if (job && job.state === "cancelled") return; // already handled by cancel endpoint
    console.error("[job:" + token.slice(0, 6) + "] error:", err.message);
    // Fix 7: guard is explicit — producedPath is null when error occurs before performDownload
    // resolves (e.g. during probeDownloadSize). removeFileQuietly already handles null safely.
    if (producedPath) removeDownloadArtifacts(producedPath);
    updateJob(token, {
      state: "error",
      stage: "Failed",
      error: err.message.slice(0, 300),
      completedAt: Date.now(),
      killProc: null,
    });
    scheduleJobCleanup(token);
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
    sourcePercent: job.sourcePercent,
    speedText: job.speedText,
    etaText: job.etaText,
    totalText: job.totalText,
    error: job.error,
  });
});

// GET /api/download/file/:token — stream the finished file.
// Supports Range requests (bytes=N-M or bytes=N-) for chunked/resumable downloads.
// File is deleted 10 min after first serve to allow large chunked downloads to complete.
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

  const totalSize = job.fileSize || fs.statSync(job.filePath).size;

  // Parse Range header: "bytes=N-" or "bytes=N-M"
  const rangeHeader = req.headers["range"];
  let start = 0;
  let end = totalSize - 1;
  let isPartial = false;

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      start = parseInt(match[1], 10);
      end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
      if (start >= totalSize || end >= totalSize || start > end) {
        res.set("Content-Range", `bytes */${totalSize}`);
        return res.status(416).end();
      }
      isPartial = true;
    }
  }

  const chunkSize = end - start + 1;

  const headers = {
    "Content-Type": job.contentType,
    "Content-Disposition": buildContentDisposition(job.filename),
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
    "Content-Length": String(chunkSize),
  };
  if (isPartial) headers["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;

  res.set(headers);
  if (isPartial) res.status(206);

  // Schedule cleanup 10 min after first serve — large chunked downloads need the window
  if (!job.servedAt) {
    updateJob(token, { servedAt: Date.now() });
    if (!job.cleanupAt) scheduleJobCleanup(token);
  }

  const fileStream = fs.createReadStream(job.filePath, {
    start,
    end,
    highWaterMark: FILE_STREAM_HIGH_WATER_MARK,
  });
  fileStream.on("error", (err) => {
    if (!res.headersSent) res.status(500).json({ error: "File read failed: " + err.message });
    else res.destroy(err);
  });
  fileStream.pipe(res);
});

// GET /api/download/stream — fast path for progressive MP4 formats.
// Adaptive video+audio and MP3 still use the background job path because they
// need ffmpeg/post-processing before the final file is valid.
app.get("/api/download/stream", directDownloadLimiter, async (req, res) => {
  const url = normalizeRequestUrl(req.query.url);
  const formatId = String(req.query.formatId || "").trim();
  const ext = String(req.query.ext || "mp4").trim().toLowerCase();
  const isAudio = ext === "mp3" || formatId === "bestaudio";

  if (!url || !isValidYouTubeURL(url)) {
    return res.status(400).json({ error: "Invalid or missing YouTube URL" });
  }
  if (!isDirectStreamSafe(url, formatId, isAudio, ext)) {
    return res.status(409).json({
      error: "This format needs the background downloader.",
      fallback: "job",
    });
  }
  if (MAX_DURATION_SECONDS || MAX_FILESIZE_BYTES) {
    try {
      await probeDownloadSize(url, formatId, false);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  const args = withCookies(buildDownloadArgs(formatId, false, "-"));
  args.push(url);

  const proc = spawn(YT_DLP, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let sentBytes = 0;
  let procClosed = false;

  res.set({
    "Content-Type": "video/mp4",
    "Content-Disposition": buildContentDisposition("video.mp4"),
    "Cache-Control": "no-store",
  });

  proc.stdout.on("data", (chunk) => {
    sentBytes += chunk.length;
  });
  proc.stdout.pipe(res);

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    const line = text.trim();
    if (line) console.log("[yt-dlp:stream]", line);
  });

  proc.on("error", (err) => {
    procClosed = true;
    if (!res.headersSent && sentBytes === 0) {
      return res.status(500).json({ error: "Stream failed: " + err.message.slice(0, 200) });
    }
    res.destroy(err);
  });

  proc.on("close", (code) => {
    procClosed = true;
    if (code === 0) return;
    const msg = extractUsefulError(stderr, "yt-dlp exited with code " + code);
    if (!res.headersSent && sentBytes === 0) {
      return res.status(500).json({ error: "Stream failed: " + msg.slice(0, 200) });
    }
    if (!res.writableEnded) res.destroy(new Error(msg));
  });

  res.on("close", () => {
    if (!procClosed && !res.writableEnded) {
      try { proc.kill("SIGKILL"); } catch {}
    }
  });
});

// POST /api/download/cancel/:token — cancel an in-progress single-video job
app.post("/api/download/cancel/:token", (req, res) => {
  const token = String(req.params.token || "").trim();
  const job = jobs.get(token);
  if (!job) return res.status(404).json({ error: "Job not found or already finished" });
  if (job.state !== "pending") return res.status(409).json({ error: "Job already finished" });

  // Kill the yt-dlp process immediately
  if (typeof job.killProc === "function") job.killProc();

  console.log("[job:" + token.slice(0, 6) + "] cancelled by client");
  cleanupJob(token);   // removes temp file + deletes job entry immediately
  res.status(204).end();
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

  // Fix 5: enforce duration/size limits on the legacy direct-download path,
  // matching the same guard applied in /api/download/start.
  if (MAX_DURATION_SECONDS || MAX_FILESIZE_BYTES) {
    try {
      await probeDownloadSize(url, formatId, isAudio);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

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
      removeDownloadArtifacts(producedPath);
    };
    const fileStream = fs.createReadStream(producedPath, {
      highWaterMark: FILE_STREAM_HIGH_WATER_MARK,
    });
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
    removeDownloadArtifacts(producedPath);
    if (!res.headersSent)
      res
        .status(500)
        .json({ error: "Download failed: " + err.message.slice(0, 200) });
  }
}

// In-memory SSE progress channels for playlist ZIP jobs.
// Key: progressId (random hex), Value: { send(event, data), close() }
const zipProgressChannels = new Map();
// Fix 8: separate Map for abort handles to avoid namespace collision with progress channels.
// Key: progressId (random hex), Value: { abort(reason) }
const zipAbortChannels = new Map();
// Stores finished ZIP temp paths keyed by progressId for re-download after reconnect.
// Entry: { path, filename, size, createdAt }
const zipFileStore = new Map();

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
  // Optional: pre-selected entries from the client (skips re-fetching the full playlist)
  const selectedEntries = Array.isArray(source.selectedEntries) ? source.selectedEntries : null;
  const clientPlaylistTitle = String(source.playlistTitle || "").trim().slice(0, 200);

  if (!url || !isPlaylistURL(url)) {
    return res.status(400).json({ error: "Invalid or missing playlist URL" });
  }

  const isAudio = ext === "mp3" || formatId === "bestaudio";

  // Abort controller — triggered when client disconnects or hits /cancel
  let aborted = false;
  const activeProcs = new Set(); // all running yt-dlp processes for this job
  const abort = (reason = "cancelled") => {
    if (aborted) return;
    aborted = true;
    console.log("[playlist-zip] aborting:", reason);
    for (const p of activeProcs) { try { p.kill("SIGKILL"); } catch {} }
    activeProcs.clear();
  };

  // Register this job so /cancel can reach it
  if (progressId) zipAbortChannels.set(progressId, { abort });

  // Detect client disconnect (tab closed, network drop, mobile backgrounding etc.)
  // 5 min grace period — mobile browsers can background for several minutes.
  let disconnectTimer = null;
  res.on("close", () => {
    // Only abort on unexpected disconnect — not on normal response completion.
    if (!res.writableEnded) {
      disconnectTimer = setTimeout(() => abort("client disconnected"), 5 * 60 * 1000);
    }
  });

  // Helper: send SSE event if a progress channel is registered
  const emit = (event, data) => {
    const ch = zipProgressChannels.get(progressId);
    if (ch && ch.send) ch.send(event, data);
  };
  const closeProgress = () => {
    const ch = zipProgressChannels.get(progressId);
    if (ch && ch.close) { ch.close(); }
    zipProgressChannels.delete(progressId);
    zipAbortChannels.delete(progressId);
  };

  // Temp file tracker — cleaned up on abort or completion
  const tempFiles = new Set();
  const cleanupTempFiles = () => {
    for (const f of tempFiles) {
      unmarkDownloadArtifact(f);
      try { fs.unlinkSync(f); } catch {}
    }
    tempFiles.clear();
  };

  let entries;
  let playlistTitle;
  try {
    if (selectedEntries && selectedEntries.length > 0) {
      // Client sent a pre-filtered selection — skip re-fetching the full playlist.
      entries = selectedEntries
        .filter(e => e && typeof e.url === "string" && isValidYouTubeURL(e.url))
        .slice(0, MAX_PLAYLIST_ENTRIES)
        .map(e => ({ url: e.url, title: String(e.title || "").trim() || null }));
      if (!entries.length) {
        closeProgress();
        return res.status(400).json({ error: "No valid video URLs in the selection." });
      }
      playlistTitle = sanitizeFilename(clientPlaylistTitle || "Playlist Selection");
    } else {
      emit("status", { stage: "Fetching playlist info…", current: 0, total: 0 });
      const playlistInfoPromise = runYtDlp([
        "--dump-single-json",
        "--flat-playlist",
        "--no-warnings",
        "--yes-playlist",
        "--playlist-end",
        String(MAX_PLAYLIST_ENTRIES),
        url,
      ]);
      const playlistInfoTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Playlist info fetch timed out after 90 seconds.")), 90000)
      );
      const rawPlaylist = await Promise.race([playlistInfoPromise, playlistInfoTimeout]);
      const playlist = JSON.parse(rawPlaylist);
      entries = normalizePlaylistEntries(playlist.entries || []).slice(0, MAX_PLAYLIST_ENTRIES);
      if (!entries.length) {
        closeProgress();
        return res.status(400).json({ error: "Playlist has no downloadable entries." });
      }
      playlistTitle = sanitizeFilename(playlist.title || clientPlaylistTitle || "Playlist");
    }

    if (aborted) { closeProgress(); return res.destroy(); }

    const outputExt = isAudio ? "mp3" : "mp4";
    const total = entries.length;

    emit("status", { stage: "Starting download…", current: 0, total });

    // Write ZIP to a temp file first so the client can reconnect and resume
    // downloading even if the connection drops mid-transfer (mobile backgrounding etc.)
    const zipTempPath = path.join(os.tmpdir(), "plzip-archive-" + crypto.randomUUID() + ".zip");
    markDownloadArtifact(zipTempPath);
    tempFiles.add(zipTempPath);
    const zipWriteStream = fs.createWriteStream(zipTempPath);

    const archive = archiver("zip", { zlib: { level: 0 } });
    archive.on("warning", (err) => console.warn("[playlist-zip] archiver warning:", err.message));
    archive.on("error", (err) => {
      if (aborted) return;
      console.error("[playlist-zip] archiver error:", err.message);
      zipWriteStream.destroy(err);
    });
    archive.pipe(zipWriteStream);

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

    // Download a single entry to a temp file.
    // Returns { downloadDone, mergeDone }
    //   downloadDone — resolves (void) when the yt-dlp download phase ends.
    //                  For merge formats: resolves when [Merger] appears in stderr.
    //                  For non-merge:    resolves at proc close (same tick as mergeDone).
    //   mergeDone    — resolves with { tempPath, filename, entry, index } at proc close.
    const downloadEntry = (entry, i) => {
      let downloadDoneResolve, downloadDoneReject;
      const downloadDone = new Promise((res, rej) => {
        downloadDoneResolve = res;
        downloadDoneReject = rej;
      });

      let mergeDoneResolve, mergeDoneReject;
      const mergeDone = new Promise((res, rej) => {
        mergeDoneResolve = res;
        mergeDoneReject = rej;
      });
      // Suppress unhandled-rejection warnings — the caller awaits mergeDone explicitly
      mergeDone.catch(() => {});

      if (aborted) {
        const err = new Error("cancelled");
        downloadDoneReject(err);
        mergeDoneReject(err);
        return { downloadDone, mergeDone };
      }

      const title = sanitizeFilename(entry.title) || "video-" + (i + 1);
      const filename = title + "." + outputExt;
      const tempPath = path.join(os.tmpdir(), "plzip-" + crypto.randomUUID() + "." + outputExt);
      markDownloadArtifact(tempPath);
      tempFiles.add(tempPath);

      emit("downloading", { current: i + 1, total, title: entry.title || title });
      console.log("[playlist-zip] downloading", (i + 1) + "/" + total, title);

      const args = withCookies(buildDownloadArgs(formatId, isAudio, needsMerge ? tempPath : "-"));
      args.push(entry.url);
      const proc = spawn(YT_DLP, args, { stdio: ["ignore", needsMerge ? "ignore" : "pipe", "pipe"] });
      activeProcs.add(proc);

      let stderrBuf = "";
      let mergeStarted = false;
      // Per-video watchdog: kill yt-dlp if it produces no output for DOWNLOAD_WATCHDOG_MS
      let lastActivityAt = Date.now();
      const entryWatchdog = setInterval(() => {
        if (Date.now() - lastActivityAt > DOWNLOAD_WATCHDOG_MS) {
          console.warn("[playlist-zip] watchdog: killing stalled yt-dlp for", entry.url);
          try { proc.kill("SIGKILL"); } catch {}
        }
      }, DOWNLOAD_WATCHDOG_TICK_MS);

      proc.stderr.on("data", (d) => {
        lastActivityAt = Date.now();
        const line = d.toString().trim();
        if (line) {
          stderrBuf += line + "\n";
          if (needsMerge && !mergeStarted && /\[Merger\]|\[ffmpeg\]|Merging/i.test(line)) {
            mergeStarted = true;
            emit("merging", { current: i + 1, total, title: entry.title || title });
            downloadDoneResolve(); // network done — release semaphore slot now
          }
        }
      });

      if (!needsMerge) {
        // For single-stream, collect stdout into a temp file so parallel downloads
        // don't interleave — each finishes independently then gets appended in order
        const writeStream = fs.createWriteStream(tempPath);
        proc.stdout.on("data", () => { lastActivityAt = Date.now(); });
        proc.stdout.pipe(writeStream);
        writeStream.on("error", (err) => {
          clearInterval(entryWatchdog);
          // Fix 1: clean up the partial temp file on write error to prevent leaks
          removeDownloadArtifacts(tempPath);
          unmarkDownloadArtifact(tempPath);
          tempFiles.delete(tempPath);
          downloadDoneReject(err);
          mergeDoneReject(err);
        });
      }

      proc.on("error", (err) => {
        clearInterval(entryWatchdog);
        activeProcs.delete(proc);
        // Fix 2: clean up the temp file when yt-dlp fails to spawn to prevent leaks
        removeDownloadArtifacts(tempPath);
        unmarkDownloadArtifact(tempPath);
        tempFiles.delete(tempPath);
        downloadDoneReject(err);
        mergeDoneReject(err);
      });

      proc.on("close", (code) => {
        clearInterval(entryWatchdog);
        activeProcs.delete(proc);
        if (aborted) {
          const err = new Error("cancelled");
          downloadDoneReject(err); // no-op if already resolved
          mergeDoneReject(err);
          return;
        }
        if (code !== 0) {
          const msg = extractUsefulError(stderrBuf, "yt-dlp exited with code " + code);
          const err = new Error(msg);
          downloadDoneReject(err); // no-op if already resolved (merge format)
          mergeDoneReject(err);
          return;
        }
        // Non-merge: downloadDone fires here (same tick as mergeDone)
        // Merge: downloadDone already resolved via stderr — this call is a no-op
        downloadDoneResolve();
        mergeDoneResolve({ tempPath, filename, entry, index: i });
      });

      return { downloadDone, mergeDone };
    };

    // Add a completed temp file into the archive (serialised via archiveLock)
    const appendToArchive = ({ tempPath, filename, entry, index }) => {
      archiveLock = archiveLock.then(() => new Promise((resolve, reject) => {
        if (aborted || !fs.existsSync(tempPath)) {
          unmarkDownloadArtifact(tempPath);
          try { fs.unlinkSync(tempPath); } catch {}
          tempFiles.delete(tempPath);
          return resolve();
        }
        // Fix 3: pair a one-time error handler with the entry listener so that
        // if archiver emits "error" instead of "entry" (e.g. the file disappears
        // between existsSync and archive.file), archiveLock resolves rather than
        // hanging forever and deadlocking the entire ZIP job.
        const onEntry = () => {
          archive.removeListener("error", onError);
          unmarkDownloadArtifact(tempPath);
          try { fs.unlinkSync(tempPath); } catch {}
          tempFiles.delete(tempPath);
          resolve();
        };
        const onError = (err) => {
          archive.removeListener("entry", onEntry);
          unmarkDownloadArtifact(tempPath);
          try { fs.unlinkSync(tempPath); } catch {}
          tempFiles.delete(tempPath);
          // Resolve (not reject) so the outer Promise.all continues and the
          // archiver "error" event propagates to its own top-level handler.
          resolve();
        };
        archive.once("entry", onEntry);
        archive.once("error", onError);
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

      // Guard against double-releasing the semaphore slot.
      // On the happy path: released after downloadDone (network done, ffmpeg still running).
      // On error path:     released in catch (download failed before merge started).
      let slotReleased = false;
      const releaseOnce = () => {
        if (!slotReleased) { slotReleased = true; releaseSemaphore(); }
      };

      try {
        const { downloadDone, mergeDone } = downloadEntry(entry, i);

        // Release the semaphore as soon as the download phase finishes so the
        // next video can start downloading while ffmpeg runs in the background.
        await downloadDone;
        releaseOnce();

        if (!aborted) {
          const result = await mergeDone;
          await appendToArchive(result);
          completed++;
          finishedCount++;
          emit("done", { current: finishedCount, total, title: entry.title || result.filename, completed, failed });
        }
      } catch (err) {
        releaseOnce(); // no-op if already released (e.g. ffmpeg failed after download succeeded)
        finishedCount++;
        if (aborted) return;
        failed++;
        const title = sanitizeFilename(entry.title) || "video-" + (i + 1);
        console.error("[playlist-zip] failed:", entry.url, err.message);
        archive.append("Download failed: " + err.message.slice(0, 300), {
          name: "FAILED - " + title + ".txt",
        });
        emit("failed", { current: finishedCount, total, title: entry.title || title, completed, failed, error: err.message.slice(0, 200) });
      }
    })());

    await Promise.all(entryPromises);
    // Wait for all archive appends to finish
    await archiveLock;
    // Preserve the output ZIP — remove it from the cleanup set so cleanupTempFiles()
    // only wipes individual video temp files. The ZIP is deleted after being served.
    tempFiles.delete(zipTempPath);
    unmarkDownloadArtifact(zipTempPath);
    cleanupTempFiles();

    if (aborted) {
      archive.abort();
      closeProgress();
      unmarkDownloadArtifact(zipTempPath);
      try { fs.unlinkSync(zipTempPath); } catch {}
      return;
    }

    // Finalise ZIP — waits until all bytes are flushed to zipTempPath
    await new Promise((resolve, reject) => {
      zipWriteStream.on("finish", resolve);
      zipWriteStream.on("error", reject);
      archive.finalize();
    });

    emit("complete", { total, completed, failed });
    closeProgress();
    clearTimeout(disconnectTimer); // normal completion — cancel any pending abort

    if (aborted) {
      unmarkDownloadArtifact(zipTempPath);
      try { fs.unlinkSync(zipTempPath); } catch {}
      return;
    }

    // Serve the finished ZIP with Range support so clients can resume on reconnect
    const zipFilename = playlistTitle + ".zip";

    // Stat the file first — zipTotalSize must be known before registering in the store
    const zipStat = fs.statSync(zipTempPath);
    const zipTotalSize = zipStat.size;

    // Register in store so the client can re-fetch via GET /api/download/playlist-zip/file/:id
    if (progressId) {
      zipFileStore.set(progressId, {
        path: zipTempPath,
        filename: zipFilename,
        size: zipTotalSize,
        createdAt: Date.now(),
      });
      // Store-aware timer: cleans up store entry and file together
      setTimeout(() => {
        const entry = zipFileStore.get(progressId);
        if (entry) { try { fs.unlinkSync(entry.path); } catch {} zipFileStore.delete(progressId); }
      }, 30 * 60 * 1000).unref();
    } else {
      // No progressId — no store entry, but still need to schedule file deletion
      setTimeout(() => { removeFileQuietly(zipTempPath); }, 30 * 60 * 1000).unref();
    }

    const rangeHeader = req.headers["range"];
    let start = 0;
    let end = zipTotalSize - 1;
    let isPartial = false;
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        start = parseInt(match[1], 10);
        end = match[2] ? parseInt(match[2], 10) : zipTotalSize - 1;
        if (start < zipTotalSize && end < zipTotalSize && start <= end) isPartial = true;
      }
    }
    const chunkSize = end - start + 1;

    const zipHeaders = {
      "Content-Type": "application/zip",
      "Content-Disposition": buildContentDisposition(zipFilename),
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
      "Content-Length": String(chunkSize),
    };
    if (isPartial) zipHeaders["Content-Range"] = `bytes ${start}-${end}/${zipTotalSize}`;
    res.set(zipHeaders);
    if (isPartial) res.status(206);

    // Stream ZIP to client; delete after transfer
    const zipFileStream = fs.createReadStream(zipTempPath, {
      start,
      end,
      highWaterMark: FILE_STREAM_HIGH_WATER_MARK,
    });
    zipFileStream.on("error", (err) => {
      if (!res.headersSent) res.status(500).json({ error: "ZIP read failed: " + err.message });
      else res.destroy(err);
    });
    zipFileStream.on("close", () => {
      // Only delete after full transfer (non-partial) to allow retries
      if (!isPartial) {
        try { fs.unlinkSync(zipTempPath); } catch {}
        tempFiles.delete(zipTempPath);
      }
    });
    res.on("close", () => {
      // If client disconnects mid-transfer, keep the file for 10 min to allow resume
      if (!res.writableEnded) {
        setTimeout(() => {
          try { fs.unlinkSync(zipTempPath); } catch {}
          tempFiles.delete(zipTempPath);
        }, 10 * 60 * 1000).unref();
      }
    });
    zipFileStream.pipe(res);

  } catch (err) {
    cleanupTempFiles();
    if (!aborted) console.error("[playlist-zip]", err.message);
    emit("zip-error", { error: err.message.slice(0, 300) });
    closeProgress();
    if (aborted) return;
    if (!res.headersSent) {
      return res.status(500).json({ error: "Playlist ZIP failed: " + err.message.slice(0, 300) });
    }
    if (!res.destroyed) res.destroy(err);
  }
});

// POST /api/download/playlist-zip/cancel/:id — cancel an in-progress playlist ZIP
// Called via sendBeacon on page unload so the server stops yt-dlp and deletes temp files.
app.post("/api/download/playlist-zip/cancel/:id", (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id || !/^[0-9a-f]{32}$/.test(id)) return res.status(400).end();
  const abortHandle = zipAbortChannels.get(id);
  if (abortHandle) abortHandle.abort("cancel endpoint");
  res.status(204).end();
});

// GET /api/download/playlist-zip/file/:id — re-download a finished playlist ZIP.
// Used when the client reconnects after a drop (mobile backgrounding, network change etc.)
// Supports Range requests for resumable download.
app.get("/api/download/playlist-zip/file/:id", (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id || !/^[0-9a-f]{32}$/.test(id)) return res.status(400).json({ error: "Invalid id" });
  const entry = zipFileStore.get(id);
  if (!entry) return res.status(404).json({ error: "ZIP not found or expired" });
  if (!fs.existsSync(entry.path)) {
    zipFileStore.delete(id);
    return res.status(410).json({ error: "ZIP file already deleted" });
  }

  const totalSize = entry.size;
  const rangeHeader = req.headers["range"];
  let start = 0;
  let end = totalSize - 1;
  let isPartial = false;
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      start = parseInt(match[1], 10);
      end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
      if (start >= totalSize || end >= totalSize || start > end) {
        res.set("Content-Range", `bytes */${totalSize}`);
        return res.status(416).end();
      }
      isPartial = true;
    }
  }

  const headers = {
    "Content-Type": "application/zip",
    "Content-Disposition": buildContentDisposition(entry.filename),
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
  };
  if (isPartial) headers["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;
  res.set(headers);
  if (isPartial) res.status(206);

  const stream = fs.createReadStream(entry.path, {
    start,
    end,
    highWaterMark: FILE_STREAM_HIGH_WATER_MARK,
  });
  stream.on("error", (err) => {
    if (!res.headersSent) res.status(500).json({ error: "Read failed: " + err.message });
    else res.destroy(err);
  });
  stream.pipe(res);
  if (!isPartial) {
    res.on("finish", () => {
      removeFileQuietly(entry.path);
      zipFileStore.delete(id);
    });
  }
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

app.use(
  "/api",
  createSystemRoutes({
    checkBinary,
    ytDlpPath: YT_DLP,
    getResolvedCookies: () => RESOLVED_COOKIES,
    configuredCookiesPath: YTDLP_COOKIES,
    jobs,
    countActiveJobs,
    jobMapCap: JOB_MAP_CAP,
    rootDir: path.join(__dirname, ".."),
  }),
);

app.use(createViewRoutes({ publicDir: path.join(__dirname, "..", "public") }));

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

