import { config } from "./src/config.js";
import { logger } from "./src/logger.js";
import { startPolling, stopOracle } from "./src/poller.js";
import { startServer, stopServer } from "./src/server.js";
import { closeDb } from "./src/db.js";

startServer(config.PORT);
startPolling();

// ── Process-level safety net ──────────────────────────────────────────────────
// Tanpa ini, satu promise yang gagal diam-diam membunuh (atau menggantung)
// proses yang sedang memegang transaksi on-chain.
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn(`${signal} diterima — memulai graceful shutdown...`);

  // Jangan tunggu selamanya kalau ada koneksi yang bandel.
  const hardExit = setTimeout(() => {
    logger.error("Shutdown melebihi batas waktu — memaksa keluar.");
    process.exit(1);
  }, 10_000);
  hardExit.unref();

  try {
    stopOracle();
  } catch (err) {
    logger.error("Gagal menghentikan poller:", err);
  }
  try {
    await stopServer();
  } catch (err) {
    logger.error("Gagal menutup HTTP server:", err);
  }
  try {
    closeDb();
  } catch (err) {
    logger.error("Gagal menutup database:", err);
  }

  logger.log("Shutdown selesai.");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection:", reason instanceof Error ? reason : String(reason));
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception:", err);
  void shutdown("uncaughtException");
});
