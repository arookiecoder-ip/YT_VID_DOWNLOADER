const express = require("express");
const cors = require("cors");
const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const os = require("os");
const fs = require("fs");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const YT_DLP = process.env.YT_DLP_PATH || "yt-dlp";
const YTDLP_COOKIES = process.env.YTDLP_COOKIES || "";
const AUTH_USERNAME = process.env.AUTH_USERNAME || "admin";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "change-me-now";
const AUTH_REALM = process.env.AUTH_REALM || "TubeGrab Protected";
const TRUST_PROXY = process.env.TRUST_PROXY || "";
const AUTH_MAX_FAILURES = Number.parseInt(
  process.env.AUTH_MAX_FAILURES || "10",
  10,
);
const AUTH_BLOCK_MINUTES = Number.parseInt(
  process.env.AUTH_BLOCK_MINUTES || "15",
  10,
);
const GLOBAL_RATE_LIMIT_WINDOW_MS = Number.parseInt(
  process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || "60000",
  10,
);
const GLOBAL_RATE_LIMIT_MAX = Number.parseInt(
  process.env.GLOBAL_RATE_LIMIT_MAX || "120",
  10,
);
const DOWNLOAD_RATE_LIMIT_MAX = Number.parseInt(
  process.env.DOWNLOAD_RATE_LIMIT_MAX || "8",
  10,
);
const authFailuresByIp = new Map();

if (TRUST_PROXY) {
  app.set("trust proxy", TRUST_PROXY === "true" ? 1 : TRUST_PROXY);
}

if (AUTH_USERNAME === "admin" && AUTH_PASSWORD === "change-me-now") {
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
  const xff = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((part) => part.trim())
    .find(Boolean);
  return xff || req.ip || req.socket.remoteAddress || "unknown";
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

setInterval(
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

const globalLimiter = rateLimit({
  windowMs: GLOBAL_RATE_LIMIT_WINDOW_MS,
  max: GLOBAL_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again shortly." },
});

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: DOWNLOAD_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many download requests. Wait and retry." },
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
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.use(globalLimiter);
app.use(cors());
app.use(express.json({ limit: "32kb" }));
app.use(basicAuthMiddleware);
app.use(express.static(path.join(__dirname, "public")));

function isValidYouTubeURL(url) {
  return [
    /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?.*v=[\w-]{11}/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/shorts\/[\w-]{11}/,
    /^(https?:\/\/)?youtu\.be\/[\w-]{11}/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/embed\/[\w-]{11}/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/playlist\?.*list=[\w-]+/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?.*list=[\w-]+/,
  ].some((pattern) => pattern.test(url));
}

function isPlaylistURL(url) {
  return /[?&]list=[\w-]+/.test(String(url || ""));
}

function withCookies(args) {
  const base = ["--js-runtimes", "node", ...args];
  if (YTDLP_COOKIES && fs.existsSync(YTDLP_COOKIES)) {
    return ["--cookies", YTDLP_COOKIES, ...base];
  }
  return base;
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    execFile(
      YT_DLP,
      withCookies(args),
      { timeout: 90000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(
            new Error((stderr || err.message || "yt-dlp failed").trim()),
          );
        }
        resolve(stdout.trim());
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
      // Prefer MP4 progressive where possible for better compatibility.
      if (
        !slot.progressive ||
        (slot.progressive.ext !== "mp4" && format.ext === "mp4")
      ) {
        slot.progressive = format;
      }
    } else {
      if (
        !slot.adaptive ||
        (slot.adaptive.ext !== "mp4" && format.ext === "mp4")
      ) {
        slot.adaptive = format;
      }
    }

    byHeight.set(height, slot);
  }

  const videoFormats = [];
  for (const [height, slot] of byHeight.entries()) {
    if (slot.progressive) {
      const format = slot.progressive;
      videoFormats.push({
        id: format.format_id,
        label: height + "p",
        height,
        detail:
          (format.ext || "mp4").toUpperCase() +
          " • " +
          fmtBytes(format.filesize || format.filesize_approx),
        type: "video",
        ext: format.ext || "mp4",
        filesize: format.filesize || null,
        filesizeApprox: format.filesize_approx || null,
        sizeExact: Boolean(format.filesize),
        badge: height >= 1080 ? "HD" : "",
      });
      continue;
    }

    if (slot.adaptive) {
      const format = slot.adaptive;
      videoFormats.push({
        id:
          "bestvideo[height=" +
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
    ...videoFormats.slice(0, 5),
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
      // Strip non-ASCII characters (emojis, fancy Unicode) — they break HTTP headers
      // The filename*= RFC 5987 encoded version handles Unicode for modern browsers
      // eslint-disable-next-line no-control-regex
      .replace(/[^\x00-\x7F]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "video"
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
  } catch {
    return { bytes: null, exact: false };
  }
}

function buildDownloadArgs(formatId, isAudio, outputTarget = "-") {
  const selector = getFormatSelector(formatId, isAudio);
  const args = [
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

// GET /api/info
app.get("/api/info", async (req, res) => {
  const url = String(req.query.url || "").trim();
  if (!url || !isValidYouTubeURL(url)) {
    return res.status(400).json({ error: "Invalid or missing YouTube URL" });
  }

  try {
    if (isPlaylistURL(url)) {
      const rawPlaylist = await runYtDlp([
        "--dump-single-json",
        "--flat-playlist",
        "--no-warnings",
        "--yes-playlist",
        url,
      ]);
      const playlist = JSON.parse(rawPlaylist);
      const entries = normalizePlaylistEntries(playlist.entries || []);

      if (!entries.length) {
        return res.status(400).json({
          error: "Playlist found, but no downloadable entries were detected.",
        });
      }

      const playlistFormats = getFallbackFormats(true);
      const firstThumb =
        entries.find((entry) => entry.thumbnail)?.thumbnail || null;

      return res.json({
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

    res.json({
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
    res.status(500).json({
      error: "Failed to fetch video info. It may be restricted or unavailable.",
    });
  }
});

// GET /api/download-meta
app.get("/api/download-meta", async (req, res) => {
  const url = String(req.query.url || "").trim();
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

async function streamDownload(req, res) {
  const source =
    req.method === "GET" || req.method === "HEAD" ? req.query : req.body || {};
  const url = String(source.url || "").trim();
  const formatId = String(source.formatId || "best").trim();
  const ext = String(source.ext || "mp4")
    .trim()
    .toLowerCase();

  if (!url || !isValidYouTubeURL(url)) {
    return res.status(400).json({ error: "Invalid or missing YouTube URL" });
  }

  const isAudio = ext === "mp3" || formatId === "bestaudio";
  const selector = getFormatSelector(formatId, isAudio);
  const needsTempMergedFile = !isAudio && selector.includes("+");
  const outputExt = isAudio ? "mp3" : "mp4";
  const contentType = "video/mp4";
  let tempPath = null;

  try {
    // Fetch title and size in parallel to reduce startup delay
    const [titleRaw, sizeMeta] = await Promise.all([
      runYtDlp(["--get-title", "--no-warnings", "--no-playlist", url]),
      probeDownloadSize(url, formatId, isAudio),
    ]);
    const safeTitle = sanitizeFilename(titleRaw);
    const filename = safeTitle + "." + outputExt;
    const encodedFilename = encodeURIComponent(filename);

    if (needsTempMergedFile) {
      tempPath = createTempDownloadPath(outputExt);
      const ytdlpArgs = withCookies(buildDownloadArgs(formatId, isAudio, tempPath));
      ytdlpArgs.push(url);

      await new Promise((resolve, reject) => {
        const proc = spawn(YT_DLP, ytdlpArgs, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";

        proc.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
          const line = chunk.toString().trim();
          if (line) console.error("[/api/download]", line);
        });

        // Do NOT kill yt-dlp on req close during merge — the client connection
        // may drop briefly while the file picker is open. We must let the merge
        // finish before we can stream the result.

        proc.on("close", (code) => {
          if (code === 0) {
            resolve();
            return;
          }

          const msg =
            stderr.trim().slice(-300) || "yt-dlp exited with code " + code;
          reject(new Error(msg));
        });

        proc.on("error", reject);
      });

      if (!fs.existsSync(tempPath)) {
        throw new Error("Merged output was not generated.");
      }

      // Remux to MP4 with faststart using stream copy (no re-encode — fast, no quality loss)
      const remuxedPath = createTempDownloadPath(outputExt);
      await new Promise((resolve, reject) => {
        const proc = spawn("ffmpeg", [
          "-i", tempPath,
          "-c", "copy",
          "-movflags", "+faststart",
          "-y",
          remuxedPath,
        ], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        proc.on("close", (code) => {
          removeFileQuietly(tempPath);
          if (code === 0) { resolve(); return; }
          removeFileQuietly(remuxedPath);
          reject(new Error("ffmpeg remux failed: " + stderr.slice(-300)));
        });
        proc.on("error", reject);
      });
      tempPath = remuxedPath;

      if (!fs.existsSync(tempPath)) {
        throw new Error("Re-encoded output was not generated.");
      }

      const stat = fs.statSync(tempPath);
      res.set({
        "Content-Type": contentType,
        "Content-Disposition":
          'attachment; filename="' +
          filename +
          "\"; filename*=UTF-8''" +
          encodedFilename,
        "Cache-Control": "no-store",
        "X-Download-Size-Bytes": String(stat.size),
        "X-Download-Size-Exact": "1",
        "Content-Length": String(stat.size),
      });

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        removeFileQuietly(tempPath);
      };

      const fileStream = fs.createReadStream(tempPath);
      fileStream.on("error", (err) => {
        cleanup();
        if (!res.headersSent) {
          res
            .status(500)
            .json({ error: "Download failed: " + err.message.slice(0, 200) });
        } else {
          res.destroy(err);
        }
      });

      fileStream.on("close", cleanup);
      res.on("close", cleanup);
      fileStream.pipe(res);
      return;
    }

    const args = withCookies(buildDownloadArgs(formatId, isAudio, "-"));
    args.push(url);

    res.set({
      "Content-Type": isAudio ? "audio/mpeg" : contentType,
      "Content-Disposition":
        'attachment; filename="' +
        filename +
        "\"; filename*=UTF-8''" +
        encodedFilename,
      "Cache-Control": "no-store",
      "X-Download-Size-Bytes": String(sizeMeta.bytes || ""),
      "X-Download-Size-Exact": sizeMeta.exact ? "1" : "0",
    });

    if (sizeMeta.exact && sizeMeta.bytes && !isAudio) {
      res.set("Content-Length", String(sizeMeta.bytes));
    }

    const proc = spawn(YT_DLP, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      console.error("[/api/download] spawn error:", err.message);
      if (!res.headersSent) {
        res
          .status(500)
          .json({ error: "Download failed: " + err.message.slice(0, 200) });
      } else {
        res.destroy(err);
      }
    });

    req.on("close", () => {
      if (!proc.killed) {
        proc.kill("SIGTERM");
      }
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        const msg =
          stderr.trim().slice(-300) || "yt-dlp exited with code " + code;
        console.error("[/api/download]", msg);
        if (!res.headersSent) {
          res.status(500).json({ error: "Download failed: " + msg });
          return;
        }
      }

      if (!res.writableEnded) {
        res.end();
      }
    });

    proc.stdout.pipe(res);
  } catch (err) {
    console.error("[/api/download]", err.message);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ error: "Download failed: " + err.message.slice(0, 200) });
    }
  }
}

// GET /api/download
app.use("/api/download", downloadLimiter);
app.get("/api/download", streamDownload);

// Backward-compatible POST /api/download
app.post("/api/download", streamDownload);

// GET /api/formats
app.get("/api/formats", async (req, res) => {
  const { url } = req.query;
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
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    ytdlp: YT_DLP,
    timestamp: new Date().toISOString(),
  });
});

// Fallback to frontend
app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("\n  TubeGrab running at http://localhost:" + PORT + "\n");
});
