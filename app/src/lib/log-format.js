/**
 * Sortie console lisible en développement : colonnes alignées et couleurs.
 * En production, le logger reste en JSON (voir logger.js).
 */

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GRAY = "\x1b[90m";
const BLUE = "\x1b[94m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const ORANGE = "\x1b[38;5;208m";
const RED = "\x1b[31m";

const LEVEL = {
  10: { label: "TRACE", tone: GRAY, icon: "○" },
  20: { label: "DEBUG", tone: CYAN, icon: "○" },
  30: { label: "INFO ", tone: GREEN, icon: "●" },
  40: { label: "WARN ", tone: YELLOW, icon: "⚠" },
  50: { label: "ERROR", tone: RED, icon: "✖" },
  60: { label: "FATAL", tone: RED, icon: "✖" },
};

const SKIP_KEYS = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "v",
  "msg",
  "req",
  "res",
  "responseTime",
  "reqId",
  "err",
]);

function useColor() {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

function c(code, text, enabled) {
  return enabled ? `${code}${text}${RESET}` : text;
}

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function formatTime(epochMs) {
  const d = new Date(epochMs);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `[${h}:${m}:${s}.${ms}]`;
}

function statusTone(code) {
  if (code >= 500) return RED;
  if (code >= 400) return ORANGE;
  if (code >= 300) return CYAN;
  return GREEN;
}

function formatIp(raw) {
  if (!raw) return "—";
  return String(raw).replace(/^::ffff:/, "");
}

function formatFields(record, color) {
  const parts = [];
  for (const [key, value] of Object.entries(record)) {
    if (SKIP_KEYS.has(key) || value == null) continue;
    if (typeof value === "object") continue;
    parts.push(`${key}=${value}`);
  }
  if (!parts.length) return "";
  return c(YELLOW, pad(parts.join("  "), 28), color);
}

function formatHttp(record, color) {
  const req = record.req;
  const res = record.res;
  if (!req || !res) return null;

  const method = pad(req.method || "?", 7);
  const status = res.statusCode ?? "?";
  const ms = record.responseTime != null ? `${Math.round(record.responseTime)}ms` : "—";
  const ip = formatIp(req.remoteAddress);
  const path = req.url || "/";

  const tone = statusTone(Number(status));
  const head = [
    c(tone, pad(String(status), 3), color),
    c(CYAN, pad(ms, 7), color),
    c(BLUE, pad(`IP=${ip}`, 22), color),
  ].join("  ");

  const tail = c(GRAY, path, color);
  return `${c(tone, method, color)}  ${head}  ${tail}`;
}

function formatMessage(record, color) {
  const http = formatHttp(record, color);
  if (http) return http;

  const fields = formatFields(record, color);
  const msg = record.msg ? c(GRAY, record.msg, color) : "";
  const err =
    record.err && (record.err.message || record.err.msg)
      ? c(RED, String(record.err.message || record.err.msg), color)
      : "";

  const chunks = [fields, msg, err].filter(Boolean);
  return chunks.join("  ");
}

export function formatLogLine(record) {
  const color = useColor();
  const meta = LEVEL[record.level] || LEVEL[30];
  const stamp = c(DIM, formatTime(record.time), color);
  const badge = c(meta.tone, `${meta.icon} ${meta.label}`, color);
  const body = formatMessage(record, color);
  return `${stamp}  ${badge}  ${body}`.replace(/\s+$/, "");
}

/** Destination Pino : une ligne JSON entrante → une ligne formatée. */
export function createPrettyDestination() {
  return {
    write(chunk) {
      const raw = chunk.toString().trim();
      if (!raw) return;
      try {
        process.stdout.write(`${formatLogLine(JSON.parse(raw))}\n`);
      } catch {
        process.stdout.write(chunk);
      }
    },
  };
}

/** Utilitaire pour scripts CLI (seed, etc.). */
export function logLine(level, message, fields = {}) {
  const levelNum =
    level === "error"
      ? 50
      : level === "warn"
        ? 40
        : level === "debug"
          ? 20
          : 30;
  process.stdout.write(
    `${formatLogLine({ level: levelNum, time: Date.now(), msg: message, ...fields })}\n`
  );
}
