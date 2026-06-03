"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
const clientSource = fs.readFileSync(
  path.join(__dirname, "..", "public", "assets", "js", "app.js"),
  "utf8",
);

test("default yt-dlp concurrent fragments is 8 when env is unset", () => {
  assert.match(
    appSource,
    /YTDLP_CONCURRENT_FRAGMENTS\s*=\s*parsePositiveEnvInt\(process\.env\.YTDLP_CONCURRENT_FRAGMENTS,\s*8\)/,
  );
});

test("file-serving streams use a larger highWaterMark while preserving ranges", () => {
  assert.match(appSource, /FILE_STREAM_HIGH_WATER_MARK\s*=\s*1024\s*\*\s*1024/);
  assert.match(appSource, /fs\.createReadStream\(job\.filePath,\s*{[\s\S]*start,[\s\S]*end,[\s\S]*highWaterMark:\s*FILE_STREAM_HIGH_WATER_MARK/);
  assert.match(appSource, /fs\.createReadStream\(entry\.path,\s*{[\s\S]*start,[\s\S]*end,[\s\S]*highWaterMark:\s*FILE_STREAM_HIGH_WATER_MARK/);
  assert.match(appSource, /if \(isPartial\) headers\["Content-Range"\]/);
});

test("fast stream route rejects unsafe formats and playlists", () => {
  assert.match(appSource, /function isDirectStreamSafe\(url, formatId, isAudio, ext\)/);
  assert.match(appSource, /isPlaylistURL\(url\)/);
  assert.match(appSource, /isAudio \|\| ext !== "mp4"/);
  assert.match(appSource, /selector === "best" \|\| selector === "bestaudio"/);
  assert.match(appSource, /\/\[\+\/\\\[\\\]\(\)\]\//);
  assert.match(appSource, /status\(409\)\.json\(\{[\s\S]*fallback: "job"/);
});

test("fast stream cancellation kills yt-dlp", () => {
  assert.match(appSource, /app\.get\("\/api\/download\/stream"/);
  assert.match(appSource, /res\.on\("close", \(\) => \{[\s\S]*proc\.kill\("SIGKILL"\)/);
});

test("client tries fast stream for streamable formats and falls back to jobs", () => {
  assert.match(clientSource, /selectedFmt\.streamable && selectedFmt\.streamFormatId/);
  assert.match(clientSource, /\/api\/download\/stream\?/);
  assert.match(clientSource, /err\.canFallback/);
  assert.match(clientSource, /\/api\/download\/start/);
});
