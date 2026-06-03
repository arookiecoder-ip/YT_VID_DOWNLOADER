# TubeGrab

TubeGrab is a protected YouTube downloader with a Node.js/Express backend, yt-dlp/ffmpeg processing, background jobs, playlist ZIP downloads, and a browser UI that streams large files directly to disk when supported.

All pages and API routes are protected by HTTP Basic Auth.

## Features

- Paste YouTube watch, shorts, live, embed, youtu.be, and playlist URLs.
- Fetches metadata including title, channel, views, duration, thumbnail, playlist entries, and format choices.
- Downloads MP4 video or MP3 audio.
- Prefers playable MP4 output with H.264 video and M4A audio.
- Uses background jobs for large single-video downloads.
- Shows live progress metrics from yt-dlp: source percent, speed, ETA, elapsed time, and local save progress.
- Streams completed files to the browser with Range support.
- Cleans single-video temp files 30 minutes after job completion or error.
- Sweeps old orphaned temp files from previous runs.
- Supports playlist ZIP downloads with parallel yt-dlp workers.
- Cancels active single-video and playlist jobs from the UI.
- Docker-ready.

## Requirements

- Node.js 18+
- yt-dlp installed and available in `PATH`, or configured with `YT_DLP_PATH`
- ffmpeg installed and available in `PATH`

Install examples:

```bash
pip install -U yt-dlp
```

```bash
# Ubuntu/Debian
sudo apt install ffmpeg
```

```powershell
# Windows: install ffmpeg, then ensure ffmpeg.exe is on PATH
ffmpeg -version
yt-dlp --version
```

## Quick Start

```bash
npm install
npm start
```

For local development, default credentials are:

```text
admin / change-me-now
```

For production, set real credentials:

```bash
export NODE_ENV=production
export AUTH_USERNAME="your-username"
export AUTH_PASSWORD="your-password"
npm start
```

PowerShell:

```powershell
$env:NODE_ENV="production"
$env:AUTH_USERNAME="your-username"
$env:AUTH_PASSWORD="your-password"
npm start
```

Open `http://localhost:3000`.

## Docker

```bash
docker compose up -d
```

Or manually:

```bash
docker build -t tubegrab .
docker run -d -p 127.0.0.1:3000:3000 `
  -e NODE_ENV=production `
  -e AUTH_USERNAME=your-username `
  -e AUTH_PASSWORD=your-password `
  --name tubegrab tubegrab
```

The Docker image includes Python, yt-dlp, and ffmpeg.

## Project Structure

```text
YT_VID_DOWNLOADER/
|-- server.js                  # Thin server bootstrap
|-- src/
|   |-- app.js                 # Express app, API routes, download services
|   |-- config/env.js          # Shared startup config
|   |-- controllers/           # Extracted controllers
|   |-- routes/                # Extracted route modules
|   |-- middleware/            # Middleware home for future extraction
|   |-- models/                # Model/state home for future persistence
|   |-- services/              # Service home for future extraction
|   `-- utils/                 # Utility home for future extraction
|-- public/
|   |-- index.html             # View shell
|   `-- assets/
|       |-- css/styles.css     # Frontend styles
|       `-- js/app.js          # Frontend controller logic
|-- tests/
|   `-- *.test.js
|-- Dockerfile
|-- docker-compose.yml
|-- package.json
`-- README.md
```

## Environment Variables

| Variable | Default | Description |
|---|---:|---|
| `PORT` | `3000` | HTTP listen port. |
| `BIND_HOST` | `0.0.0.0` | Interface to bind. |
| `NODE_ENV` | `development` | Use `production` for deploys. |
| `AUTH_USERNAME` | `admin` | Basic Auth username. Required in production. |
| `AUTH_PASSWORD` | `change-me-now` | Basic Auth password. Required in production. |
| `AUTH_REALM` | `TubeGrab Protected` | Browser auth realm. |
| `AUTH_MAX_FAILURES` | `10` | Failed login attempts before temporary block. |
| `AUTH_BLOCK_MINUTES` | `15` | Auth block duration. |
| `TRUST_PROXY` | unset | Set to `1` behind nginx/Caddy/reverse proxy. |
| `YT_DLP_PATH` | auto | Full path to yt-dlp. |
| `YTDLP_COOKIES` | unset | Netscape cookies file for yt-dlp. |
| `YTDLP_USE_NODE_RUNTIME` | `0` | Set `1` only if your yt-dlp supports `--js-runtimes node`. |
| `YTDLP_CONCURRENT_FRAGMENTS` | `4` | yt-dlp concurrent fragment downloads. |
| `GLOBAL_RATE_LIMIT_WINDOW_MS` | `60000` | Global rate-limit window. |
| `GLOBAL_RATE_LIMIT_MAX` | `120` | Max requests per IP per global window. |
| `DOWNLOAD_RATE_LIMIT_MAX` | `8` | Direct download requests per minute. |
| `DOWNLOAD_START_RATE_LIMIT_MAX` | `60` | Background job starts per minute. |
| `MAX_CONCURRENT_JOBS` | `25` | Active background jobs across all clients. |
| `MAX_JOBS_PER_IP` | `5` | Active background jobs per IP. |
| `JOB_MAP_CAP` | `500` | Max job records in memory. |
| `MAX_PLAYLIST_ENTRIES` | `500` | Max playlist entries loaded. |
| `PLAYLIST_CONCURRENCY` | `3` | Parallel playlist video downloads. |
| `MAX_DURATION_SECONDS` | unset | Reject videos longer than this. `0` disables. |
| `MAX_FILESIZE_BYTES` | unset | Reject estimated downloads larger than this. `0` disables. |
| `DEBUG_API_ERRORS` | `0` | Include extra yt-dlp error detail in API responses. |
| `INTERNAL_TOKEN` | unset | Optional internal token gate. |

## API

### `GET /api/info?url=<youtube_url>`

Returns video or playlist metadata and available formats.

### `GET /api/download-meta?url=<url>&formatId=<id>&ext=<ext>`

Returns estimated size metadata before download.

```json
{
  "sizeBytes": 45223866,
  "sizeExact": true,
  "ext": "mp4"
}
```

### `POST /api/download/start`

Starts a background single-video job.

```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "formatId": "bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]",
  "ext": "mp4"
}
```

Response:

```json
{
  "token": "<job_token>"
}
```

### `GET /api/download/status/:token`

Returns job status and progress metrics.

```json
{
  "state": "pending",
  "progress": 63,
  "stage": "Downloading...",
  "filename": null,
  "fileSize": null,
  "sourcePercent": 72.4,
  "speedText": "4.2MiB/s",
  "etaText": "00:38",
  "totalText": "312.5MiB",
  "error": null
}
```

States are `pending`, `done`, or `error`.

### `GET /api/download/file/:token`

Streams the completed file. Supports Range requests. Completed files are scheduled for cleanup 30 minutes after the job reaches `done`.

### `POST /api/download/cancel/:token`

Cancels an active single-video job, kills the yt-dlp process, and removes temp artifacts.

### `GET /api/download` / `POST /api/download`

Legacy direct stream path used as a fallback.

### `POST /api/download/playlist-zip`

Downloads selected playlist entries, packs them into a ZIP, and streams the archive.

### `GET /api/download/playlist-zip/progress/:id`

Server-Sent Events stream for playlist ZIP progress.

### `GET /api/download/playlist-zip/file/:id`

Re-downloads a finished playlist ZIP while it is still available.

### `POST /api/download/playlist-zip/cancel/:id`

Cancels an active playlist ZIP job.

### `GET /api/formats?url=<youtube_url>`

Returns only the format list for a URL.

### `GET /api/health`

Checks yt-dlp, ffmpeg, disk space, cookies, and job queue health.

### `GET /api/version`

Returns deploy/version timestamps used by the frontend footer.

## Cleanup Behavior

- Single-video job output is deleted 30 minutes after the job reaches `done`.
- Error-state job artifacts are deleted immediately and the job record is cleaned later.
- Cancelled single-video jobs remove temp artifacts immediately.
- Playlist per-video temp files are deleted after being added to the ZIP.
- Playlist ZIP archives are deleted after successful full transfer or by the 30-minute store timer.
- A periodic orphan sweeper removes old `tubegrab-*` and `plzip-*` temp files that are not currently active.

## Progress UI

Single-video downloads are shown as a pipeline:

1. Starting job
2. Downloading from YouTube, with source percent, speed, ETA, and elapsed time
3. Processing/remuxing
4. Saving to the user's device, with bytes written, local write speed, and save ETA

If yt-dlp does not emit speed or ETA for a source, the UI falls back to elapsed time.

## Testing

```bash
npm test
```

The test suite uses Node's built-in test runner and focuses on cleanup and preservation behavior around downloads, playlist ZIPs, and remuxing.

## Production Notes

- Set `NODE_ENV=production`, `AUTH_USERNAME`, and `AUTH_PASSWORD`.
- Put nginx or Caddy in front for TLS.
- Set `TRUST_PROXY=1` behind a trusted reverse proxy.
- Keep yt-dlp current because YouTube changes frequently.
- Increase `PLAYLIST_CONCURRENCY` only if the host has enough CPU, bandwidth, and disk I/O.
- Monitor the OS temp directory if users download very large videos or playlists.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Failed to fetch video info | yt-dlp missing or outdated | Run `yt-dlp --version`; update yt-dlp or set `YT_DLP_PATH`. |
| Video has no audio or fails to play | ffmpeg missing/outdated or incompatible source format | Run `ffmpeg -version`; update ffmpeg and yt-dlp. |
| Long video times out | Reverse proxy timeout or old frontend cache | Hard refresh the app; check proxy timeout settings. |
| Progress lacks speed/ETA | yt-dlp did not emit those metrics | The UI falls back to elapsed time. |
| Too many downloads in progress | Per-IP or global job cap reached | Wait or raise `MAX_JOBS_PER_IP` / `MAX_CONCURRENT_JOBS`. |
| Storage grows unexpectedly | Existing old temp files or interrupted jobs | Restart the app so the orphan sweeper runs; check OS temp dir for `tubegrab-*` / `plzip-*`. |
| Playlist ZIP fails midway | yt-dlp/ffmpeg issue or network failure | Update yt-dlp/ffmpeg and retry at lower playlist concurrency. |

## Legal

Use this tool only for content you have the right to download. Respect copyright law and YouTube's Terms of Service.
