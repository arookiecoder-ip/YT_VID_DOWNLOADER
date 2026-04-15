# TubeGrab — YouTube Video Downloader

A full-stack YouTube video downloader with a Node.js/Express backend powered by yt-dlp and a sleek dark-themed frontend.

This variant is **access-controlled**: all pages and API routes require HTTP Basic Auth credentials before use.

---

## Features

- Paste any YouTube URL (watch, shorts, playlist, embed, youtu.be)
- Fetches real video metadata: title, channel, views, duration, thumbnail
- Multiple quality options: 1080p, 720p, 480p, 360p, MP3 audio
- Background download jobs — start a download, get a token, poll progress, stream the file when ready
- **Playlist ZIP download**: fetches all playlist videos in parallel and streams a single `.zip` to the browser
  - Up to `PLAYLIST_CONCURRENCY` (default 3) videos downloaded simultaneously
  - Zero RAM buffering in Chrome/Edge via the File System Access API (`showSaveFilePicker`)
  - Blob fallback for Firefox/Safari
  - Tab-close cancels the server-side download immediately and cleans up temp files
- Probes download size before streaming (exact when available, estimate fallback)
- Multi-device support: any device can poll job status and download the file by token
- File available for 60 seconds after first download (grace window for multi-tab/device use)
- Per-IP job fairness: max `MAX_JOBS_PER_IP` (default 5) concurrent jobs per client
- Auto-retry on transient yt-dlp network errors (2 s backoff, one retry)
- Responsive design for mobile and desktop
- Docker-ready for one-command deployment

---

## Prerequisites

- **Node.js 18+**
- **yt-dlp** installed and in PATH

  ```bash
  # via pip
  pip install yt-dlp

  # or download the standalone binary from https://github.com/yt-dlp/yt-dlp/releases
  ```

- **ffmpeg** installed and in PATH (required for merging separate video+audio streams)

  ```bash
  # macOS
  brew install ffmpeg

  # Ubuntu/Debian
  sudo apt install ffmpeg

  # Windows — download from https://ffmpeg.org/download.html and add to PATH
  ```

---

## Quick Start

```bash
# 1. Enter the project directory
cd tubegrab-web-auth

# 2. Install Node.js dependencies
npm install

# 3. Set access credentials (Linux/macOS)
export AUTH_USERNAME="your-username"
export AUTH_PASSWORD="your-password"

# 4. Start the server
node server.js
```

For Windows PowerShell:

```powershell
$env:AUTH_USERNAME="your-username"
$env:AUTH_PASSWORD="your-password"
node server.js
```

Open **http://localhost:3000** in your browser, paste a YouTube URL, pick a quality, and click Download.

> In `production` mode (`NODE_ENV=production`), `AUTH_USERNAME` and `AUTH_PASSWORD` **must** be explicitly set and cannot be the default values — the server will refuse to start otherwise.

---

## Docker Deployment

### One-command start (recommended)

```bash
# Create a .env file with your credentials first (see .env.example)
docker compose up -d
```

### Manual build and run

```bash
docker build -t tubegrab .
docker run -d -p 127.0.0.1:3000:3000 \
  -e NODE_ENV=production \
  -e AUTH_USERNAME=your-username \
  -e AUTH_PASSWORD=your-password \
  --name tubegrab tubegrab
```

The image bundles Python 3, ffmpeg, and yt-dlp — no extra setup on the host.

> The default `docker-compose.yml` binds to `127.0.0.1:3000` only. Put nginx or Caddy in front for SSL/TLS.

---

## Security & Rate Limiting

| Protection | Mechanism |
|---|---|
| HTTP Basic Auth on all routes | `basicAuthMiddleware` |
| Brute-force lockout by IP | `AUTH_MAX_FAILURES` / `AUTH_BLOCK_MINUTES` |
| Global request rate limit | `GLOBAL_RATE_LIMIT_MAX` per `GLOBAL_RATE_LIMIT_WINDOW_MS` |
| Direct stream rate limit | `DOWNLOAD_RATE_LIMIT_MAX` per minute |
| Job start rate limit | `DOWNLOAD_START_RATE_LIMIT_MAX` per minute |
| Per-IP job cap | `MAX_JOBS_PER_IP` concurrent jobs per client |
| Security headers | Helmet + strict CSP |
| Job map cap | `JOB_MAP_CAP` (oldest jobs evicted when full) |

If running behind nginx/Caddy/a reverse proxy, set `TRUST_PROXY=1`.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AUTH_USERNAME` | `admin` *(dev only)* | HTTP Basic auth username. Required in production. |
| `AUTH_PASSWORD` | `change-me-now` *(dev only)* | HTTP Basic auth password. Required in production. |
| `AUTH_REALM` | `TubeGrab Protected` | Browser auth prompt realm string. |
| `AUTH_MAX_FAILURES` | `10` | Failed auth attempts per IP before temporary block. |
| `AUTH_BLOCK_MINUTES` | `15` | Block duration (minutes) after too many failed attempts. |
| `TRUST_PROXY` | unset | Proxy trust level. Use `1` behind a trusted reverse proxy. |
| `PORT` | `3000` | HTTP listen port. |
| `BIND_HOST` | `0.0.0.0` | Host/interface to bind. |
| `NODE_ENV` | unset | Set to `production` for deployment mode. |
| `YT_DLP_PATH` | auto-detected | Full path to the yt-dlp binary. |
| `YTDLP_COOKIES` | unset | Path to a Netscape cookies file passed to yt-dlp (`--cookies`). |
| `GLOBAL_RATE_LIMIT_WINDOW_MS` | `60000` | Global rate-limit window size in ms. |
| `GLOBAL_RATE_LIMIT_MAX` | `120` | Max requests per IP per global window. |
| `DOWNLOAD_RATE_LIMIT_MAX` | `8` | Max direct stream requests per IP per minute. |
| `DOWNLOAD_START_RATE_LIMIT_MAX` | `60` | Max job-start requests per IP per minute. |
| `MAX_PLAYLIST_ENTRIES` | `500` | Maximum playlist entries returned by `/api/info`. |
| `MAX_CONCURRENT_JOBS` | `25` | Maximum active background download jobs across all clients. |
| `PLAYLIST_CONCURRENCY` | `3` | Parallel yt-dlp processes per playlist ZIP download. |
| `MAX_JOBS_PER_IP` | `5` | Max concurrent pending jobs allowed per client IP. |
| `JOB_MAP_CAP` | `500` | Maximum job records held in memory before eviction. |
| `MAX_DURATION_SECONDS` | unset | Reject videos longer than this (seconds). 0 = no limit. |
| `MAX_FILESIZE_BYTES` | unset | Reject downloads larger than this (bytes). 0 = no limit. |
| `DEBUG_API_ERRORS` | `0` | Set to `1` to include raw yt-dlp error output in API responses. |
| `INTERNAL_TOKEN` | unset | Secret token for internal/admin endpoints (optional). |

---

## API Endpoints

### `GET /api/info?url=<youtube_url>`

Returns video metadata and available download formats.

For playlist URLs, returns `kind: "playlist"`, `playlistCount`, and an `entries` array (each entry has `title` and `url`).

**Example response (single video):**

```json
{
  "id": "dQw4w9WgXcQ",
  "title": "Video Title",
  "channel": "Channel Name",
  "views": 1234567,
  "duration": 212,
  "uploadDate": "2024-01-15",
  "thumbnail": "https://i.ytimg.com/...",
  "formats": [
    { "id": "137+140", "label": "1080p", "detail": "MP4 • ~42 MB", "type": "video", "ext": "mp4", "badge": "HD" },
    { "id": "bestaudio", "label": "MP3", "detail": "320kbps Audio", "type": "audio", "ext": "mp3", "badge": "Audio" }
  ]
}
```

---

### `GET /api/download-meta?url=<url>&formatId=<id>&ext=<ext>`

Returns size metadata for the selected format before download starts.

```json
{ "sizeBytes": 45223866, "sizeExact": true, "ext": "mp4" }
```

---

### `POST /api/download/start`

Starts a background download job and immediately returns a polling token.

**Request body:**
```json
{ "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "formatId": "137+140", "ext": "mp4" }
```

**Response:**
```json
{ "token": "<job_token>" }
```

---

### `GET /api/download/status/:token`

Returns the current job state. Any device that knows the token can poll.

```json
{ "state": "done", "progress": 100, "filename": "Video Title.mp4", "sizeBytes": 45223866 }
```

States: `pending` → `done` or `error`.

---

### `GET /api/download/file/:token`

Streams the completed file for a finished job. The file is available for **60 seconds** after first access, then deleted. Any device with the token can download within that window.

---

### `GET /api/download` / `POST /api/download`

Direct streaming download — no temp file, streams yt-dlp output straight to the browser. Suitable for smaller files / single-stream formats.

**Query params / body:** `url`, `formatId`, `ext`

---

### `GET /api/download/playlist-zip/progress/:id`

Server-Sent Events (SSE) stream reporting per-video progress for an in-progress playlist ZIP job.

**Events:**

| Event | Data |
|---|---|
| `start` | `{ total: N }` — total number of videos |
| `done` | `{ index, title, completed, total }` — one video finished |
| `failed` | `{ index, title, error }` — one video failed (download continues) |
| `zip-error` | `{ error }` — fatal ZIP error |
| `zip-complete` | `{}` — all videos packed, ZIP finalizing |

---

### `POST /api/download/playlist-zip`

Downloads all videos in a playlist, packs them into a ZIP, and streams the archive to the client.

**Request body:**
```json
{ "url": "https://youtube.com/playlist?list=...", "formatId": "bestvideo[height<=720]+bestaudio/best", "ext": "mp4" }
```

**Response:** `application/zip` stream with `Content-Disposition: attachment; filename="PlaylistTitle.zip"`.

Videos are downloaded in parallel (up to `PLAYLIST_CONCURRENCY`) and appended to the archive sequentially. Each temp file is deleted immediately after being written into the ZIP.

---

### `POST /api/download/playlist-zip/cancel/:id`

Cancels an in-progress playlist ZIP job. Kills all active yt-dlp processes and deletes temp files. Safe to call from `navigator.sendBeacon` on page unload.

---

### `GET /api/formats?url=<youtube_url>`

Returns only the `formats` array for a URL (lighter than `/api/info`).

---

### `GET /api/health`

Health check endpoint.

```json
{ "status": "ok", "ytdlp": "/usr/local/bin/yt-dlp", "timestamp": "2025-01-15T12:00:00.000Z" }
```

---

### `GET /api/version`

Returns server version info.

---

## Project Structure

```
tubegrab-web-auth/
├── server.js              # Express backend — yt-dlp integration, job queue, playlist ZIP
├── public/
│   └── index.html         # Frontend UI (single-file, no build step)
├── tests/
│   └── *.test.js          # Unit tests (Node built-in test runner)
├── Dockerfile             # Production Docker image
├── docker-compose.yml     # Docker Compose orchestration
├── .env.example           # Example environment variable configuration
├── package.json
└── README.md
```

---

## Testing

```bash
npm test
```

Tests cover core URL validation and auth/client-id utility behavior.

---

## CI

A GitHub Actions workflow at `.github/workflows/ci-security.yml` runs on every push:

1. Unit tests (`npm test`)
2. Dependency vulnerability audit (`npm audit --audit-level=high`)
3. Docker image build + Trivy scan for HIGH/CRITICAL findings

---

## Production Notes

- **Reverse proxy**: Put nginx or Caddy in front for SSL/TLS termination; set `TRUST_PROXY=1`
- **Rate limiting**: Tune `GLOBAL_RATE_LIMIT_MAX`, `DOWNLOAD_RATE_LIMIT_MAX`, and `DOWNLOAD_START_RATE_LIMIT_MAX` for your traffic profile
- **Playlist concurrency**: `PLAYLIST_CONCURRENCY=3` is a safe default; increase on servers with more CPU/bandwidth
- **Memory limit**: `docker-compose.yml` caps the container at 1 GB; raise if you download large playlists
- **yt-dlp updates**: Keep yt-dlp current — YouTube changes frequently break older versions

  ```bash
  pip install -U yt-dlp
  ```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Failed to fetch video info" | yt-dlp not in PATH | Run `yt-dlp --version`; set `YT_DLP_PATH` if needed |
| Download has no audio / corrupt file | ffmpeg missing | Run `ffmpeg -version` to verify |
| Port already in use | Another process on 3000 | `PORT=3001 node server.js` |
| yt-dlp errors on fresh install | Outdated yt-dlp | `pip install -U yt-dlp` |
| Playlist ZIP is corrupt | yt-dlp/ffmpeg version mismatch | Update both and retry |
| "Too many downloads in progress" | Per-IP job cap reached | Wait for current downloads to finish or raise `MAX_JOBS_PER_IP` |
| Server returns 503 on playlist ZIP | Global job queue full | Raise `MAX_CONCURRENT_JOBS` or wait for queue to drain |

---

## Legal Disclaimer

This tool is for personal use only. Only download content you have the right to access. Respect copyright laws and YouTube's Terms of Service.
