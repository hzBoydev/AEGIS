import { inspect } from "node:util";
import { config } from "./config.js";

// ── Structured logger ─────────────────────────────────────────────────────────
// Pengganti pemanggilan langsung ke konsol di seluruh backend. Dua mode:
//   LOG_FORMAT=pretty → "2026-09-26T10:00:00.000Z INFO  pesan" (manusia)
//   LOG_FORMAT=json   → {"ts":"…","level":"info","msg":"…"} (mesin)
// Filtering lewat LOG_LEVEL (debug|info|warn|error).

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_TAG: Record<Level, string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  if (arg instanceof BigInt) return arg.toString();
  return inspect(arg, { depth: 4, breakLength: 120, colors: false });
}

function emit(level: Level, args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[config.LOG_LEVEL]) return;

  const message = args.map(formatArg).join(" ");
  const ts = new Date().toISOString();

  if (config.LOG_FORMAT === "json") {
    const line = JSON.stringify({ ts, level: level.trim(), msg: message });
    (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
    return;
  }

  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${ts} ${LEVEL_TAG[level]} ${message}\n`);
}

export const logger = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  log: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};
