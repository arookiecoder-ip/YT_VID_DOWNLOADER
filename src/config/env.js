function parsePositiveEnvInt(value, fallback) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const PORT = process.env.PORT || 3000;
const BIND_HOST = process.env.BIND_HOST || "0.0.0.0";

module.exports = { PORT, BIND_HOST, parsePositiveEnvInt };
