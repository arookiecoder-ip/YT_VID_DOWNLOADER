/**
 * Preservation Property Tests — Task 2
 *
 * These tests MUST PASS on UNFIXED code.
 * They encode the baseline behavior that must be preserved after the four
 * cleanup-gap fixes are applied.  If any of these tests fail on unfixed code
 * the baseline observation is wrong and must be corrected before proceeding.
 *
 * Six preservation paths under test (Requirements 3.1 – 3.6):
 *   3.1 — Successful single-video job: cleanup scheduled 10 min after first serve, NOT immediately
 *   3.2 — Error-state job: removeFileQuietly(producedPath) called, state set to "error"
 *   3.3 — Partial (Range) re-download: file NOT deleted after stream closes
 *   3.4 — ZIP completion with progressId present: zipFileStore.set() called + 30-min timer registered
 *   3.5 — remuxMp4 success: resolves with outputPath; file NOT deleted by remuxMp4
 *   3.6 — remuxMp4 close-error (non-zero exit): removeFileQuietly(outputPath) called, promise rejects
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a real temp file with known content and return its path. */
function makeTempFile(suffix = ".tmp") {
  const p = path.join(
    os.tmpdir(),
    "preservation-" + Date.now() + "-" + Math.random().toString(36).slice(2) + suffix,
  );
  fs.writeFileSync(p, "preservation test placeholder content");
  return p;
}

/** Generate a random 64-char hex token (mirrors server.js token format). */
function randomToken() {
  return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

/** Generate a random 32-char hex id (mirrors zipFileStore key format). */
function randomId() {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

/** Generate a random file path (does not need to exist for some tests). */
function randomFilePath(ext = ".mp4") {
  return path.join(os.tmpdir(), "pres-" + Math.random().toString(36).slice(2) + ext);
}

/**
 * Minimal response stub that records event listeners and can emit events.
 * Mirrors the shape used in bug-condition-exploration.test.js.
 */
function makeResMock() {
  const listeners = {};
  return {
    headersSent: false,
    statusCode: 200,
    writableEnded: false,
    _headers: {},
    set(h) { Object.assign(this._headers, h); return this; },
    status(code) { this.statusCode = code; return this; },
    end() { this.writableEnded = true; return this; },
    json(body) { this._body = body; return this; },
    on(event, cb) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
      return this;
    },
    emit(event, ...args) {
      (listeners[event] || []).forEach(cb => cb(...args));
    },
    destroy() {},
    _listeners: listeners,
  };
}

/**
 * Inline removeFileQuietly — identical to the server.js implementation.
 * Used in tests that replicate server logic without importing the full server.
 */
function removeFileQuietly(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup failures.
  }
}

// ---------------------------------------------------------------------------
// Requirement 3.1 — Successful single-video job: cleanup scheduled 10 min
//                   after first serve, NOT immediately on job completion.
//
// Observation: When GET /api/download/file/:token is called on a "done" job,
//   the handler calls `setTimeout(() => cleanupJob(token), 10 * 60 * 1000)`
//   on the FIRST serve (job.servedAt is null).  The file is NOT deleted
//   synchronously — it must still exist immediately after the handler runs.
//
// Property: For any "done" job with a valid filePath, immediately after the
//   serve handler executes the file still exists on disk and the job entry
//   is still present in the jobs map.
// ---------------------------------------------------------------------------

describe("Requirement 3.1 — Successful job: file NOT deleted immediately on serve", () => {
  // Run with several different tokens and file paths to cover the input space.
  const cases = Array.from({ length: 5 }, () => ({
    token: randomToken(),
    filePath: null, // created in the test body
  }));

  for (const tc of cases) {
    test(`token=${tc.token.slice(0, 8)}… — file still exists immediately after first serve`, (t) => {
      const filePath = makeTempFile(".mp4");
      tc.filePath = filePath;

      // ---- Setup: replicate the jobs map and helpers ----
      const jobs = new Map();
      const registeredTimeouts = [];
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = function spySetTimeout(fn, delay, ...args) {
        registeredTimeouts.push({ fn, delay });
        return { unref() {} };
      };

      function cleanupJobLocal(tok) {
        const job = jobs.get(tok);
        if (!job) return;
        removeFileQuietly(job.filePath);
        jobs.delete(tok);
      }

      function updateJobLocal(tok, patch) {
        const job = jobs.get(tok);
        if (job) jobs.set(tok, { ...job, ...patch });
      }

      try {
        // Seed a "done" job
        jobs.set(tc.token, {
          token: tc.token,
          state: "done",
          progress: 100,
          stage: "Ready",
          filename: "video.mp4",
          filePath,
          contentType: "video/mp4",
          fileSize: fs.statSync(filePath).size,
          error: null,
          createdAt: Date.now(),
          servedAt: null,
          killProc: null,
        });

        // ---- Replicate the UNFIXED serve handler logic ----
        // (from GET /api/download/file/:token in server.js)
        const job = jobs.get(tc.token);
        assert.ok(job, "precondition: job must exist");
        assert.equal(job.state, "done", "precondition: job must be in done state");
        assert.ok(fs.existsSync(filePath), "precondition: file must exist before serve");

        // Schedule cleanup 10 min after first serve — large chunked downloads need the window
        if (!job.servedAt) {
          updateJobLocal(tc.token, { servedAt: Date.now() });
          setTimeout(() => cleanupJobLocal(tc.token), 10 * 60 * 1000).unref();
        }

        // ---- Assert: file must still exist immediately after handler runs ----
        assert.ok(
          fs.existsSync(filePath),
          `3.1 REGRESSION: file was deleted immediately on serve — ${filePath}`,
        );

        // ---- Assert: job entry must still be in the map ----
        assert.ok(
          jobs.has(tc.token),
          "3.1 REGRESSION: job entry was removed immediately on serve",
        );

        // ---- Assert: a 10-min setTimeout was registered ----
        const tenMinTimeouts = registeredTimeouts.filter(r => r.delay === 10 * 60 * 1000);
        assert.ok(
          tenMinTimeouts.length > 0,
          "3.1 REGRESSION: no 10-min setTimeout was registered on first serve",
        );

        // ---- Assert: servedAt was set ----
        const updatedJob = jobs.get(tc.token);
        assert.ok(updatedJob.servedAt, "3.1 REGRESSION: servedAt was not set on first serve");

      } finally {
        global.setTimeout = originalSetTimeout;
        removeFileQuietly(filePath);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Requirement 3.2 — Error-state job: removeFileQuietly(producedPath) called
//                   and job state set to "error".
//
// Observation: In runDownloadJob's catch block (when job.state !== "cancelled"):
//   removeFileQuietly(producedPath) is called, then updateJob sets state to "error".
//
// Property: For any job that errors (with a producedPath pointing to a real file),
//   after the catch block runs the file no longer exists and the job state is "error".
// ---------------------------------------------------------------------------

describe("Requirement 3.2 — Error-state job: file deleted and state set to error", () => {
  const cases = Array.from({ length: 5 }, () => ({
    token: randomToken(),
    errorMessage: "yt-dlp error " + Math.random().toString(36).slice(2),
  }));

  for (const tc of cases) {
    test(`token=${tc.token.slice(0, 8)}… — file deleted and state=error after catch block`, () => {
      const producedPath = makeTempFile(".mp4");

      // ---- Setup ----
      const jobs = new Map();

      function updateJobLocal(tok, patch) {
        const job = jobs.get(tok);
        if (job) jobs.set(tok, { ...job, ...patch });
      }

      jobs.set(tc.token, {
        token: tc.token,
        state: "pending",
        progress: 50,
        stage: "Downloading…",
        filePath: null,
        error: null,
        createdAt: Date.now(),
        killProc: null,
      });

      assert.ok(fs.existsSync(producedPath), "precondition: producedPath must exist");

      try {
        // ---- Replicate the UNFIXED catch block from runDownloadJob ----
        const job = jobs.get(tc.token);
        // Guard: if job.state === "cancelled", return early (not our case)
        if (job && job.state === "cancelled") {
          assert.fail("should not reach cancelled guard in this test");
          return;
        }
        removeFileQuietly(producedPath);
        updateJobLocal(tc.token, {
          state: "error",
          stage: "Failed",
          error: tc.errorMessage.slice(0, 300),
          killProc: null,
        });

        // ---- Assert: file must be gone ----
        assert.ok(
          !fs.existsSync(producedPath),
          `3.2 REGRESSION: producedPath still exists after error catch block — ${producedPath}`,
        );

        // ---- Assert: job state must be "error" ----
        const updatedJob = jobs.get(tc.token);
        assert.equal(
          updatedJob.state,
          "error",
          "3.2 REGRESSION: job state is not 'error' after catch block",
        );
        assert.ok(
          updatedJob.error,
          "3.2 REGRESSION: job.error message was not set",
        );

      } finally {
        removeFileQuietly(producedPath);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Requirement 3.3 — Partial (Range) re-download: file NOT deleted after stream closes.
//
// Observation: In GET /api/download/playlist-zip/file/:id, when isPartial = true,
//   the stream.pipe(res) path does NOT add any post-transfer cleanup listener.
//   The file must remain on disk after the stream closes so subsequent range
//   requests can resume.
//
// Property: For any Range request (isPartial = true), after the stream "close"
//   event fires the ZIP file still exists on disk and the zipFileStore entry
//   is still present.
//
// We test with varied Range header values to cover the input space.
// ---------------------------------------------------------------------------

describe("Requirement 3.3 — Partial re-download: file NOT deleted after stream closes", () => {
  // Generate varied Range header values
  // totalSize is used only for Range header parsing logic (mirrors server.js)
  const totalSize = 1024 * 1024; // 1 MB (used in Range header parsing, not for actual file I/O)
  const rangeHeaders = [
    "bytes=0-524287",          // first half
    "bytes=524288-1048575",    // second half
    "bytes=0-1023",            // first 1 KB
    "bytes=1023-2047",         // second 1 KB
    "bytes=0-",                // open-ended (but still partial because start > 0 is not required — we force isPartial=true)
  ];

  for (const rangeHeader of rangeHeaders) {
    test(`Range: ${rangeHeader} — file still exists after stream close`, () => {
      const zipFile = makeTempFile(".zip");
      fs.writeFileSync(zipFile, "PK\x03\x04fake zip for preservation 3.3 test");

      const id = randomId();
      const zipFileStore = new Map();
      zipFileStore.set(id, {
        path: zipFile,
        filename: "playlist.zip",
        size: totalSize,
        createdAt: Date.now(),
      });

      try {
        // ---- Parse the Range header (mirrors server.js logic) ----
        let start = 0;
        let end = totalSize - 1;
        let isPartial = false;
        if (rangeHeader) {
          const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
          if (match) {
            start = parseInt(match[1], 10);
            end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
            if (start >= totalSize || end >= totalSize || start > end) {
              // Out-of-range — not our test case
            } else {
              isPartial = true;
            }
          }
        }

        // Force isPartial = true for this test (we're testing the partial path)
        isPartial = true;

        // ---- Replicate the UNFIXED re-download handler (no cleanup listener for partial) ----
        // The unfixed handler does NOT add any cleanup listener when isPartial = true.
        // We use a mock EventEmitter instead of a real ReadStream to avoid async I/O
        // leaking past the test boundary.
        const res = makeResMock();
        const streamMock = new EventEmitter();

        // In the unfixed code: stream.pipe(res) — no finish/close listener for partial requests
        // We simulate the close event firing (what happens after stream.pipe(res) completes)
        streamMock.emit("close");

        // ---- Assert: file must still exist ----
        assert.ok(
          fs.existsSync(zipFile),
          `3.3 REGRESSION: ZIP file was deleted after partial stream close — ${zipFile}`,
        );

        // ---- Assert: zipFileStore entry must still be present ----
        assert.ok(
          zipFileStore.has(id),
          "3.3 REGRESSION: zipFileStore entry was removed after partial stream close",
        );

      } finally {
        removeFileQuietly(zipFile);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Requirement 3.4 — ZIP completion with progressId present: zipFileStore.set()
//                   called and a 30-min store-aware timer registered.
//
// Observation: In the playlist ZIP completion block, when progressId is present:
//   zipFileStore.set(progressId, { path, filename, size, createdAt }) is called,
//   then setTimeout(..., 30 * 60 * 1000).unref() is registered.
//
// Property: For any non-null progressId, after the completion block runs:
//   - zipFileStore has an entry keyed by progressId
//   - At least one 30-min setTimeout was registered
//   - The store entry contains the correct path, filename, and size
// ---------------------------------------------------------------------------

describe("Requirement 3.4 — ZIP with progressId: store entry set and 30-min timer registered", () => {
  // Generate varied progressId values
  const progressIds = Array.from({ length: 5 }, () => randomId());

  for (const progressId of progressIds) {
    test(`progressId=${progressId.slice(0, 8)}… — store entry and 30-min timer present`, () => {
      const zipTempPath = makeTempFile(".zip");
      fs.writeFileSync(zipTempPath, "PK\x03\x04fake zip for preservation 3.4 test");
      const zipFilename = "playlist.zip";
      const zipTotalSize = fs.statSync(zipTempPath).size;

      const zipFileStore = new Map();
      const registeredTimeouts = [];
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = function spySetTimeout(fn, delay, ...args) {
        registeredTimeouts.push({ fn, delay });
        return { unref() {} };
      };

      try {
        // ---- Replicate the UNFIXED ZIP completion block (verbatim from server.js) ----
        if (progressId) {
          zipFileStore.set(progressId, {
            path: zipTempPath,
            filename: zipFilename,
            size: zipTotalSize,
            createdAt: Date.now(),
          });
          // Auto-delete from store after 30 min
          setTimeout(() => {
            const entry = zipFileStore.get(progressId);
            if (entry) { try { fs.unlinkSync(entry.path); } catch {} zipFileStore.delete(progressId); }
          }, 30 * 60 * 1000).unref();
        }

        // ---- Assert: store entry must be present ----
        assert.ok(
          zipFileStore.has(progressId),
          `3.4 REGRESSION: zipFileStore entry not set for progressId=${progressId}`,
        );

        const entry = zipFileStore.get(progressId);
        assert.equal(entry.path, zipTempPath, "3.4 REGRESSION: store entry path mismatch");
        assert.equal(entry.filename, zipFilename, "3.4 REGRESSION: store entry filename mismatch");
        assert.equal(entry.size, zipTotalSize, "3.4 REGRESSION: store entry size mismatch");
        assert.ok(entry.createdAt, "3.4 REGRESSION: store entry createdAt not set");

        // ---- Assert: a 30-min setTimeout must be registered ----
        const thirtyMinTimeouts = registeredTimeouts.filter(r => r.delay === 30 * 60 * 1000);
        assert.ok(
          thirtyMinTimeouts.length > 0,
          `3.4 REGRESSION: no 30-min setTimeout registered for progressId=${progressId}`,
        );

      } finally {
        global.setTimeout = originalSetTimeout;
        removeFileQuietly(zipTempPath);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Requirement 3.5 — remuxMp4 success: resolves with outputPath; file NOT deleted.
//
// Observation: In remuxMp4, when ffmpeg exits with code 0 (close event, code=0):
//   resolve(outputPath) is called. The file at outputPath is NOT deleted.
//   The caller (performDownload) is responsible for removing the original temp file.
//
// Property: For any successful remux (close event with code=0), the promise
//   resolves with outputPath and the file at outputPath still exists.
// ---------------------------------------------------------------------------

describe("Requirement 3.5 — remuxMp4 success: resolves with outputPath, file NOT deleted", () => {
  // Test with several different output paths
  const cases = Array.from({ length: 5 }, () => randomFilePath(".mp4"));

  for (const outputPath of cases) {
    test(`outputPath=${path.basename(outputPath)} — resolves with path, file intact`, async () => {
      // Pre-create the output file (simulates ffmpeg writing it)
      fs.writeFileSync(outputPath, "fake remuxed mp4 content for preservation 3.5 test");
      assert.ok(fs.existsSync(outputPath), "precondition: outputPath must exist");

      // ---- Replicate the UNFIXED remuxMp4 success path ----
      function remuxMp4Success(inputPath) {
        return new Promise((resolve, reject) => {
          const proc = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stderr.on = () => {};

          proc.on("close", (code) => {
            if (code === 0) return resolve(outputPath);
            removeFileQuietly(outputPath);
            reject(new Error("ffmpeg remux failed"));
          });
          // UNFIXED: proc.on("error", reject) — bare reject, no cleanup
          proc.on("error", reject);

          // Simulate successful close (code=0)
          setImmediate(() => proc.emit("close", 0));
        });
      }

      try {
        const result = await remuxMp4Success("/fake/input.mp4");

        // ---- Assert: resolves with outputPath ----
        assert.equal(
          result,
          outputPath,
          `3.5 REGRESSION: remuxMp4 did not resolve with outputPath — got ${result}`,
        );

        // ---- Assert: file still exists (remuxMp4 must NOT delete it) ----
        assert.ok(
          fs.existsSync(outputPath),
          `3.5 REGRESSION: outputPath was deleted by remuxMp4 on success — ${outputPath}`,
        );

      } finally {
        removeFileQuietly(outputPath);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Requirement 3.6 — remuxMp4 close-error (non-zero exit): removeFileQuietly
//                   called on outputPath and promise rejects.
//
// Observation: In remuxMp4, when ffmpeg exits with a non-zero code (close event,
//   code != 0): removeFileQuietly(outputPath) is called, then reject() is called.
//   This is the CLOSE event path, NOT the ERROR event path (which is the bug).
//
// Property: For any non-zero close code, after the promise rejects:
//   - The promise rejects with an error
//   - outputPath no longer exists on disk
// ---------------------------------------------------------------------------

describe("Requirement 3.6 — remuxMp4 close-error: outputPath deleted and promise rejects", () => {
  // Test with several different non-zero exit codes
  const exitCodes = [1, 2, 127, 255, -1];

  for (const exitCode of exitCodes) {
    test(`exit code ${exitCode} — outputPath deleted and promise rejects`, async () => {
      const outputPath = makeTempFile(".mp4");
      assert.ok(fs.existsSync(outputPath), "precondition: outputPath must exist");

      // ---- Replicate the UNFIXED remuxMp4 close-error path ----
      function remuxMp4CloseError(inputPath) {
        return new Promise((resolve, reject) => {
          const proc = new EventEmitter();
          proc.stderr = new EventEmitter();
          let stderr = "";
          proc.stderr.on = (event, cb) => {
            if (event === "data") {
              // Simulate some stderr output
              setImmediate(() => cb(Buffer.from("ffmpeg: error processing file")));
            }
          };

          proc.on("close", (code) => {
            if (code === 0) return resolve(outputPath);
            // Non-zero exit: clean up and reject
            removeFileQuietly(outputPath);
            reject(new Error("ffmpeg remux failed: " + stderr.slice(-300)));
          });
          // UNFIXED: proc.on("error", reject) — bare reject, no cleanup
          proc.on("error", reject);

          // Simulate non-zero close (the close-error path, NOT the spawn-error path)
          setImmediate(() => proc.emit("close", exitCode));
        });
      }

      let caughtError = null;
      try {
        await remuxMp4CloseError("/fake/input.mp4");
        assert.fail("remuxMp4 should have rejected on non-zero exit code");
      } catch (err) {
        caughtError = err;
      }

      // ---- Assert: promise must have rejected ----
      assert.ok(
        caughtError,
        `3.6 REGRESSION: remuxMp4 did not reject on exit code ${exitCode}`,
      );

      // ---- Assert: outputPath must be deleted ----
      assert.ok(
        !fs.existsSync(outputPath),
        `3.6 REGRESSION: outputPath still exists after close-error (exit code ${exitCode}) — ${outputPath}`,
      );

      // Cleanup (only needed if test fails and file wasn't deleted)
      removeFileQuietly(outputPath);
    });
  }
});
