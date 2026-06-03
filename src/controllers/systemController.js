const fs = require("fs");
const os = require("os");
const path = require("path");

function createSystemController({
  checkBinary,
  ytDlpPath,
  getResolvedCookies,
  configuredCookiesPath,
  jobs,
  countActiveJobs,
  jobMapCap,
  rootDir,
}) {
  const buildStartedAt = new Date().toISOString();

  async function health(req, res) {
    const [ytDlpCheck, ffmpegCheck] = await Promise.all([
      checkBinary(ytDlpPath, ["--version"]),
      checkBinary("ffmpeg", ["-version"]),
    ]);

    let diskFreeBytes = null;
    try {
      const stat = fs.statfsSync(os.tmpdir());
      diskFreeBytes = stat.bfree * stat.bsize;
    } catch {}

    const resolvedCookies = getResolvedCookies();
    const cookieFileExists = resolvedCookies
      ? fs.existsSync(resolvedCookies)
      : configuredCookiesPath ? fs.existsSync(configuredCookiesPath) : null;

    const healthy = ytDlpCheck.ok && ffmpegCheck.ok;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      ytdlpPath: ytDlpPath,
      ytdlp: ytDlpCheck,
      ffmpeg: ffmpegCheck,
      cookies: { configured: Boolean(configuredCookiesPath), fileExists: cookieFileExists },
      disk: { freeBytesApprox: diskFreeBytes },
      jobs: { active: countActiveJobs(), total: jobs.size, cap: jobMapCap },
      timestamp: new Date().toISOString(),
    });
  }

  function version(req, res) {
    let latest = 0;
    for (const rel of ["server.js", "public/index.html"]) {
      try {
        const m = fs.statSync(path.join(rootDir, rel)).mtimeMs;
        if (m > latest) latest = m;
      } catch {}
    }
    res.json({
      lastPatched: latest ? new Date(latest).toISOString() : null,
      startedAt: buildStartedAt,
    });
  }

  return { health, version };
}

module.exports = { createSystemController };
