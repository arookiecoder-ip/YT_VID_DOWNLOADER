const express = require("express");
const cors = require("cors");
const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const YT_DLP = process.env.YT_DLP_PATH || "yt-dlp";

app.use(cors());
app.use(express.json());
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

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    execFile(
      YT_DLP,
      args,
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

// ── Job store ────────────────────────────────────────────────────────────────
const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes
const jobs = new Map();

function createJob(token, meta) {
  jobs.set(token, {
    token,
    state: "pending",
    progress: 0,
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

setInterval(() => {
  const now = Date.now();
  for (const [token, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) cleanupJob(token);
  }
}, 10 * 60 * 1000);

async function runDownloadJob(token, url, formatId, isAudio) {
  const outputExt = isAudio ? "mp3" : "mp4";
  let tempPath = null;

  try {
    updateJob(token, { stage: "Downloading…", progress: 5 });

    tempPath = createTempDownloadPath(outputExt);
    const args = buildDownloadArgs(formatId, isAudio, tempPath);
    args.push(url);

    const [titleRaw] = await Promise.all([
      runYtDlp(["--get-title", "--no-warnings", "--no-playlist", url]).catch(() => "video"),
      new Promise((resolve, reject) => {
        const proc = spawn(YT_DLP, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        let lastProgress = 5;

        proc.stderr.on("data", (chunk) => {
          const text = chunk.toString();
          stderr += text;
          const m = text.match(/(\d+(?:\.\d+)?)%/);
          if (m) {
            const pct = Math.min(80, Math.round(5 + (parseFloat(m[1]) / 100) * 70));
            if (pct > lastProgress) {
              lastProgress = pct;
              updateJob(token, { progress: pct });
            }
          }
        });
        proc.on("close", (code) => {
          if (code === 0) { resolve(); return; }
          removeFileQuietly(tempPath);
          reject(new Error(stderr.trim().slice(-300) || "yt-dlp exited with code " + code));
        });
        proc.on("error", (err) => { removeFileQuietly(tempPath); reject(err); });
      }),
    ]);

    if (!fs.existsSync(tempPath)) throw new Error("Downloaded file was not generated.");

    if (!isAudio) {
      updateJob(token, { stage: "Processing…", progress: 83 });
      const remuxedPath = createTempDownloadPath("mp4");
      await new Promise((resolve, reject) => {
        const proc = spawn("ffmpeg", [
          "-i", tempPath, "-c", "copy", "-movflags", "+faststart", "-y", remuxedPath,
        ], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        proc.on("close", (code) => {
          removeFileQuietly(tempPath);
          tempPath = null;
          if (code === 0) { resolve(); return; }
          removeFileQuietly(remuxedPath);
          reject(new Error("ffmpeg remux failed: " + stderr.slice(-300)));
        });
        proc.on("error", reject);
      });
      tempPath = remuxedPath;
    }

    if (!fs.existsSync(tempPath)) throw new Error("Output file was not generated.");

    const safeTitle = sanitizeFilename(titleRaw);
    const filename = safeTitle + "." + outputExt;
    const stat = fs.statSync(tempPath);

    updateJob(token, {
      state: "done",
      progress: 100,
      stage: "Ready",
      filename,
      filePath: tempPath,
      contentType: isAudio ? "audio/mpeg" : "video/mp4",
      fileSize: stat.size,
    });
  } catch (err) {
    console.error("[job:" + token.slice(0, 6) + "] error:", err.message);
    removeFileQuietly(tempPath);
    updateJob(token, { state: "error", stage: "Failed", error: err.message.slice(0, 300) });
  }
}

// POST /api/download/start
app.post("/api/download/start", (req, res) => {
  const source = req.body || {};
  const url = String(source.url || "").trim();
  const formatId = String(source.formatId || "best").trim();
  const ext = String(source.ext || "mp4").trim().toLowerCase();

  if (!url || !isValidYouTubeURL(url)) {
    return res.status(400).json({ error: "Invalid or missing YouTube URL" });
  }

  const isAudio = ext === "mp3" || formatId === "bestaudio";
  const token = crypto.randomBytes(16).toString("hex");

  createJob(token, { url, formatId, isAudio });
  runDownloadJob(token, url, formatId, isAudio);

  res.json({ token });
});

// GET /api/download/status/:token
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

// GET /api/download/file/:token
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

  const encodedFilename = encodeURIComponent(job.filename);
  res.set({
    "Content-Type": job.contentType,
    "Content-Disposition":
      'attachment; filename="' + job.filename + "\"; filename*=UTF-8''" + encodedFilename,
    "Cache-Control": "no-store",
    "Content-Length": String(job.fileSize),
  });

  const fileStream = fs.createReadStream(job.filePath);
  fileStream.on("error", (err) => {
    cleanupJob(token);
    if (!res.headersSent) res.status(500).json({ error: "File read failed: " + err.message });
    else res.destroy(err);
  });
  fileStream.on("close", () => cleanupJob(token));
  fileStream.pipe(res);
});

// Legacy direct-download — kept for playlist iframe fallback
async function streamDownload(req, res) {
  const source =
    req.method === "GET" || req.method === "HEAD" ? req.query : req.body || {};
  const url = String(source.url || "").trim();
  const formatId = String(source.formatId || "best").trim();
  const ext = String(source.ext || "mp4").trim().toLowerCase();

  if (!url || !isValidYouTubeURL(url)) {
    return res.status(400).json({ error: "Invalid or missing YouTube URL" });
  }

  const isAudio = ext === "mp3" || formatId === "bestaudio";
  const outputExt = isAudio ? "mp3" : "mp4";
  const contentType = isAudio ? "audio/mpeg" : "video/mp4";
  let tempPath = null;

  try {
    tempPath = createTempDownloadPath(outputExt);
    const args = buildDownloadArgs(formatId, isAudio, tempPath);
    args.push(url);

    const [titleRaw] = await Promise.all([
      runYtDlp(["--get-title", "--no-warnings", "--no-playlist", url]).catch(() => "video"),
      new Promise((resolve, reject) => {
        const proc = spawn(YT_DLP, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        proc.on("close", (code) => {
          if (code === 0) { resolve(); return; }
          removeFileQuietly(tempPath);
          reject(new Error(stderr.trim().slice(-300) || "yt-dlp exited with code " + code));
        });
        proc.on("error", (err) => { removeFileQuietly(tempPath); reject(err); });
      }),
    ]);

    if (!fs.existsSync(tempPath)) throw new Error("Downloaded file was not generated.");

    if (!isAudio) {
      const remuxedPath = createTempDownloadPath("mp4");
      await new Promise((resolve, reject) => {
        const proc = spawn("ffmpeg", [
          "-i", tempPath, "-c", "copy", "-movflags", "+faststart", "-y", remuxedPath,
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
    }

    if (!fs.existsSync(tempPath)) throw new Error("Output file was not generated.");

    const safeTitle = sanitizeFilename(titleRaw);
    const filename = safeTitle + "." + outputExt;
    const encodedFilename = encodeURIComponent(filename);
    const stat = fs.statSync(tempPath);

    res.set({
      "Content-Type": contentType,
      "Content-Disposition":
        'attachment; filename="' + filename + "\"; filename*=UTF-8''" + encodedFilename,
      "Cache-Control": "no-store",
      "Content-Length": String(stat.size),
    });

    let cleaned = false;
    const cleanup = () => { if (cleaned) return; cleaned = true; removeFileQuietly(tempPath); };
    const fileStream = fs.createReadStream(tempPath);
    fileStream.on("error", (err) => {
      cleanup();
      if (!res.headersSent) res.status(500).json({ error: "Download failed: " + err.message.slice(0, 200) });
      else res.destroy(err);
    });
    fileStream.on("close", cleanup);
    res.on("close", cleanup);
    fileStream.pipe(res);
  } catch (err) {
    console.error("[/api/download]", err.message);
    removeFileQuietly(tempPath);
    if (!res.headersSent) res.status(500).json({ error: "Download failed: " + err.message.slice(0, 200) });
  }
}

// GET /api/download — legacy direct stream (used by playlist iframe fallback)
app.get("/api/download", streamDownload);
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
