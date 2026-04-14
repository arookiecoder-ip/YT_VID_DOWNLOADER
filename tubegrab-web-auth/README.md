# TubeGrab — YouTube Video Downloader

A full-stack YouTube video downloader with a Node.js/Express backend powered by yt-dlp and a sleek dark-themed frontend.

This folder is a protected website variant that requires ID/password (HTTP Basic Auth) for all pages and API routes.

## Features

- Paste any YouTube URL (watch, shorts, playlist, embed, youtu.be)
- Fetches real video metadata (title, channel, views, duration, thumbnail)
- Multiple quality options (1080p, 720p, 480p, 360p, MP3 audio)
- Starts browser downloads immediately from the download button
- No server-side temporary file staging before browser download begins
- Probes download size before start (exact when available, estimate fallback)
- Playlist support: fetch playlist and queue all videos for download
- Responsive design for mobile and desktop
- Docker-ready for one-command deployment

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

## Quick Start

```bash
# 1. Enter the project directory
cd tubegrab-web-auth

# 2. Install Node.js dependencies
npm install

# 3. Set access credentials (Linux/macOS)
export AUTH_USERNAME="your-id"
export AUTH_PASSWORD="your-password"

# 4. Start the server
node server.js
```

For Windows PowerShell:

```powershell
$env:AUTH_USERNAME="your-id"
$env:AUTH_PASSWORD="your-password"
node server.js
```

In `production`, credentials must be explicitly set via environment variables.
If `AUTH_USERNAME`/`AUTH_PASSWORD` are missing in production, startup fails.

## Firewall Controls

This protected variant includes built-in hardening:

- HTTP Basic Auth for all routes
- Brute-force protection by IP (`AUTH_MAX_FAILURES`, `AUTH_BLOCK_MINUTES`)
- Global request rate limiting (`GLOBAL_RATE_LIMIT_WINDOW_MS`, `GLOBAL_RATE_LIMIT_MAX`)
- Direct download stream rate limiting (`DOWNLOAD_RATE_LIMIT_MAX`)
- Job queue start rate limiting (`DOWNLOAD_START_RATE_LIMIT_MAX`)
- Security headers via Helmet

You can configure these values via environment variables (see `.env.example`).

If running behind nginx/Caddy/reverse proxy, set `TRUST_PROXY=1`.

Open **http://localhost:3000** in your browser, paste a YouTube URL, pick a quality, and click Download.

## Docker Deployment

### One-command start (recommended)

```bash
docker compose up -d
```

### Manual build and run

```bash
# Build the image
docker build -t tubegrab .

# Run the container
docker run -d -p 3000:3000 --name tubegrab tubegrab
```

The container includes Python 3, ffmpeg, and yt-dlp — no extra setup needed.

## Testing

Run unit tests with Node's built-in test runner:

```bash
npm test
```

Current tests cover core URL validation and auth/client-id utility behavior.

## CI and Security Checks

This project now includes a GitHub Actions workflow at `.github/workflows/ci-security.yml` that runs:

- Unit tests (`npm test`)
- Dependency vulnerability audit (`npm audit --audit-level=high`)
- Docker image build + Trivy scan for HIGH/CRITICAL findings

## Environment Variables

| Variable                        | Default              | Description |
| ------------------------------- | -------------------- | ----------- |
| `AUTH_USERNAME`                 | `admin` (dev only)   | HTTP Basic auth username. Must be explicitly set for production. |
| `AUTH_PASSWORD`                 | `change-me-now` (dev only) | HTTP Basic auth password. Must be explicitly set for production. |
| `AUTH_REALM`                    | `TubeGrab Protected` | Browser auth prompt realm. |
| `AUTH_MAX_FAILURES`             | `10`                 | Failed auth attempts allowed before temporary block. |
| `AUTH_BLOCK_MINUTES`            | `15`                 | Block duration after too many failed auth attempts. |
| `TRUST_PROXY`                   | unset                | Proxy trust setting. Use `1` behind a trusted reverse proxy. |
| `GLOBAL_RATE_LIMIT_WINDOW_MS`   | `60000`              | Global rate-limit window size in ms. |
| `GLOBAL_RATE_LIMIT_MAX`         | `120`                | Max requests per global window. |
| `DOWNLOAD_RATE_LIMIT_MAX`       | `8`                  | Max legacy direct stream requests per minute (`/api/download`). |
| `DOWNLOAD_START_RATE_LIMIT_MAX` | `60`                 | Max queued job starts per minute (`/api/download/start`). |
| `MAX_PLAYLIST_ENTRIES`          | `50`                 | Maximum playlist entries returned by `/api/info`. |
| `MAX_CONCURRENT_JOBS`           | `25`                 | Maximum active background download jobs. |
| `YTDLP_COOKIES`                 | unset                | Optional cookies file path for yt-dlp. |
| `PORT`                          | `3000`               | HTTP server port. |
| `YT_DLP_PATH`                   | `yt-dlp`             | Path to the yt-dlp binary. |
| `NODE_ENV`                      | unset                | Set to `production` for deployment mode. |

## API Endpoints

### `GET /api/info?url=<youtube_url>`

Returns video metadata and available download formats.

When the URL is a playlist, this endpoint returns playlist metadata with `kind: "playlist"`, `playlistCount`, and an `entries` array (each entry includes `title` and `url`) so the frontend can queue all videos.

**Example response:**

```json
{
  "id": "dQw4w9WgXcQ",
  "title": "Video Title",
  "channel": "Channel Name",
  "views": 1234567,
  "duration": 212,
  "uploadDate": "2024-01-15",
  "thumbnail": "https://...",
  "formats": [
    {
      "id": "137",
      "label": "1080p",
      "detail": "MP4 • 42.3 MB",
      "type": "video",
      "ext": "mp4",
      "badge": "HD"
    },
    {
      "id": "bestaudio",
      "label": "MP3",
      "detail": "320kbps Audio",
      "type": "audio",
      "ext": "mp3",
      "badge": "Audio"
    }
  ]
}
```

### `GET /api/download?url=<youtube_url>&formatId=<format>&ext=<ext>`

Starts and streams a video/audio download directly to the browser.

**Query params:**

```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "formatId": "137",
  "ext": "mp4"
}
```

**Response:** Binary file stream with `Content-Disposition: attachment` header.

When the selected format has a known exact size, the response includes `Content-Length` so browser download managers can show total bytes from the start.

### `POST /api/download/start`

Starts a background download job and returns a token immediately.

**Request body:**

```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "formatId": "137",
  "ext": "mp4"
}
```

**Response:**

```json
{
  "token": "<job_token>"
}
```

### `GET /api/download/status/:token`

Returns job status (`pending`, `done`, `error`) and progress metadata.

### `GET /api/download/file/:token`

Streams the completed file for a finished job token.

### `POST /api/download`

Backward-compatible alias for the same download behavior (accepts JSON body with `url`, `formatId`, `ext`).

### `GET /api/download-meta?url=<youtube_url>&formatId=<format>&ext=<ext>`

Returns upfront size metadata for the selected format.

**Example response:**

```json
{
  "sizeBytes": 45223866,
  "sizeExact": true,
  "ext": "mp4"
}
```

### `GET /api/formats?url=<youtube_url>`

Returns only the available formats array for a given URL.

### `GET /api/health`

Health check. Returns `{ "status": "ok", "ytdlp": "yt-dlp", "timestamp": "..." }`.

## Project Structure

```
tubegrab-web-auth/
├── server.js           # Express backend with yt-dlp integration
├── public/
│   └── index.html      # Frontend UI (single-file, no build step required)
├── Dockerfile          # Production Docker image
├── docker-compose.yml  # Docker Compose orchestration
├── package.json
└── README.md
```

## Production Notes

- **Rate limiting**: Tune `GLOBAL_RATE_LIMIT_MAX`, `DOWNLOAD_RATE_LIMIT_MAX`, and `DOWNLOAD_START_RATE_LIMIT_MAX` for your traffic profile
- **Reverse proxy**: Use nginx or Caddy in front for SSL/TLS termination
- **Resources**: Each download is CPU and I/O intensive; size your server accordingly
- **yt-dlp updates**: YouTube changes frequently break older versions; keep yt-dlp up to date with `pip install -U yt-dlp`

## Troubleshooting

| Symptom                        | Likely cause            | Fix                                                                   |
| ------------------------------ | ----------------------- | --------------------------------------------------------------------- |
| "Failed to fetch video info"   | yt-dlp not in PATH      | Run `yt-dlp --version` to verify; set `YT_DLP_PATH` env var if needed |
| Download fails silently        | ffmpeg missing          | Run `ffmpeg -version` to verify installation                          |
| Port already in use            | Another process on 3000 | Set `PORT=3001 node server.js`                                        |
| yt-dlp errors on fresh install | Outdated yt-dlp         | Run `pip install -U yt-dlp`                                           |

## Legal Disclaimer

This tool is for personal use only. Only download content you have the right to access. Respect copyright laws and YouTube's Terms of Service.
