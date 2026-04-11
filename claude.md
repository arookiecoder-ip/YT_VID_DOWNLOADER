# Claude Project Guide

This file provides repository-wide guidance for AI assistants and contributors working in this workspace.

## Repository Scope

This workspace contains two independent Node.js applications that share similar core logic:

1. `tubegrab` (public variant)
2. `tubegrab-web-auth` (protected variant with authentication and rate limiting)

Each app is self-contained and has its own runtime assets:

- `server.js`
- `public/index.html`
- `package.json`
- `Dockerfile`
- `docker-compose.yml`

There is also a nested folder at `tubegrab-web-auth/tubegrab-web-auth` with package artifacts. Treat it as non-canonical unless explicitly requested.

## High-Level Architecture

- Backend: Express 5 app in a single `server.js` file.
- Frontend: static `public/index.html` with inline CSS/JS (no build step).
- Media processing: external `yt-dlp` + `ffmpeg`.
- Primary usage: fetch metadata, select formats, stream downloads to browser.

Core API pattern used in both apps:

- `GET /api/info` for metadata and formats (supports playlist metadata)
- `GET /api/download-meta` for size estimation/probing
- `GET /api/download` for download streaming
- `POST /api/download` backward-compatible alias
- `GET /api/formats` for format list
- `GET /api/health` for health check

Download behavior:

- Direct stream to response for most cases.
- Temporary file path is used only when a merged output is required by format selection.

## Differences Between Apps

### `tubegrab`

- Public-facing variant.
- Uses CORS, JSON body parsing, static files.

### `tubegrab-web-auth`

- Adds security middleware and auth firewall.
- Uses `.env` via `dotenv`.
- Adds:
  - HTTP Basic Auth
  - failed-login IP blocking
  - global request rate limiting
  - download endpoint rate limiting
  - security headers via Helmet

Auth app middleware order is meaningful and should be preserved:

1. `helmet`
2. global limiter
3. `cors`
4. `express.json`
5. auth middleware
6. static file serving

## Local Development

Prerequisites (non-Docker):

- Node.js 18+
- `yt-dlp` available in `PATH`
- `ffmpeg` available in `PATH`

Run public app:

```bash
cd tubegrab
npm install
npm start
```

Run auth app:

```bash
cd tubegrab-web-auth
npm install
npm start
```

Default port is `3000` in both apps. Run one at a time or override `PORT`.

## Docker

Public app:

```bash
cd tubegrab
docker compose up -d
```

Auth app:

```bash
cd tubegrab-web-auth
docker compose up -d
```

Both Dockerfiles install `python3`, `ffmpeg`, and latest `yt-dlp` binary.

## Environment Variables

Common:

- `PORT` (default `3000`)
- `YT_DLP_PATH` (default `yt-dlp`)
- `NODE_ENV` (typically `production` in containers)

Auth variant (`tubegrab-web-auth`) adds:

- `AUTH_USERNAME`
- `AUTH_PASSWORD`
- `AUTH_REALM`
- `AUTH_MAX_FAILURES`
- `AUTH_BLOCK_MINUTES`
- `TRUST_PROXY`
- `GLOBAL_RATE_LIMIT_WINDOW_MS`
- `GLOBAL_RATE_LIMIT_MAX`
- `DOWNLOAD_RATE_LIMIT_MAX`

Use `tubegrab-web-auth/.env.example` as the source template.

## Editing Guidelines For This Workspace

- Keep the two apps aligned for shared download logic unless a change is intentionally variant-specific.
- If a shared behavior changes in one `server.js`, mirror it in the other when appropriate.
- Keep API backward compatibility, especially `POST /api/download` alias behavior.
- Keep error responses JSON-shaped with an `error` field.
- Do not introduce a frontend build toolchain unless explicitly requested.
- Prefer minimal, targeted edits over broad rewrites.

## Validation Checklist

After backend changes, validate at least:

1. `GET /api/health` returns status OK.
2. `GET /api/info?url=<youtube-url>` returns metadata.
3. `GET /api/download-meta` returns size metadata.
4. `GET /api/download` starts browser download.

For auth variant, also validate:

1. Unauthorized requests get auth challenge.
2. Valid credentials allow UI and API access.
3. Rate limits and failure blocking still behave correctly.

## Known Project Notes

- `npm test` is a placeholder and currently exits with error by design.
- Resource usage can spike during concurrent downloads (CPU and I/O heavy).
- Keep `yt-dlp` updated because upstream site changes can break extraction.

## Legal Note

This project should only be used to download content users are legally permitted to access. Respect platform terms and applicable copyright laws.
