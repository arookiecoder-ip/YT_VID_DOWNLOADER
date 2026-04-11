# TubeGrab — YouTube Video Downloader

A full-stack YouTube video downloader with a Node.js/Express backend powered by yt-dlp and a sleek dark-themed frontend.

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
cd tubegrab

# 2. Install Node.js dependencies
npm install

# 3. Start the server
node server.js
```

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

## Environment Variables

| Variable      | Default  | Description                        |
| ------------- | -------- | ---------------------------------- |
| `PORT`        | `3000`   | HTTP server port                   |
| `YT_DLP_PATH` | `yt-dlp` | Path to the yt-dlp binary          |
| `NODE_ENV`    | —        | Set to `production` for deployment |

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
tubegrab/
├── server.js           # Express backend with yt-dlp integration
├── public/
│   └── index.html      # Frontend UI (single-file, no build step required)
├── Dockerfile          # Production Docker image
├── docker-compose.yml  # Docker Compose orchestration
├── package.json
└── README.md
```

## Production Notes

- **Rate limiting**: Add `express-rate-limit` before exposing publicly to prevent abuse
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
