import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { config } from "./config.js";
import { logger } from "./logger.js";
import {
  getAllDecisions,
  getAllDecisionsForAddress,
  getDecisionsCount,
  getDecisionsCountForAddress,
  getDecisionByEscrowId,
  getEscrowIdsInvolving,
  getPendingHumanDecisions,
} from "./db.js";
import { getRecentEvents, subscribe, getDebateSessions } from "./streamBus.js";
import { runRedTeam, getLastRedTeamReport, type RedTeamMode } from "./redTeam.js";
import { applyHumanVote } from "./poller.js";
import { verifyVote } from "./voteAuth.js";

const app = express();

// ── Security middleware ───────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: false, // API murni JSON, tidak menyajikan HTML
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

/** Allowlist origin — default localhost:3000, override via CORS_ORIGINS. */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // request non-browser / same-origin
  return config.CORS_ORIGINS.includes(origin);
}

app.use(
  cors({
    origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Token"],
  })
);

app.use(express.json({ limit: "32kb" }));

// Rate limiting umum untuk seluruh permintaan API.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Terlalu banyak permintaan — coba lagi nanti" },
});
app.use("/api", apiLimiter);

// Vote memicu transaksi on-chain — dibatasi jauh lebih ketat.
const voteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Terlalu banyak percobaan vote" },
});

// Red-team LLM mode memakan GPU — dibatasi ketat.
const redTeamLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Terlalu banyak permintaan red-team" },
});

// ── Admin token (POST /api/redteam) ──────────────────────────────────────────
// Token dibaca dari ADMIN_TOKEN; bila tidak di-set, diacak saat startup dan
// dicatat ke log — endpoint tetap terpakai lokal tapi tidak terbuka untuk publik.
const adminToken = config.ADMIN_TOKEN ?? randomBytes(24).toString("hex");

function secureEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const header = req.get("authorization") ?? "";
  const bearer = header.replace(/^bearer\s+/i, "").trim();
  const provided = bearer || req.get("x-admin-token")?.trim() || "";
  if (!secureEqual(provided, adminToken)) {
    res.status(401).json({
      success: false,
      error: "Token admin diperlukan (Authorization: Bearer <ADMIN_TOKEN>)",
    });
    return;
  }
  next();
}

// ── Schemas (validasi input runtime) ─────────────────────────────────────────
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ESCROW_ID_RE = /^0x[a-fA-F0-9]{64}$/;

const voteSchema = z.object({
  escrowId: z.string().regex(ESCROW_ID_RE, "escrowId harus bytes32 0x…"),
  approve: z.boolean(),
  voter: z.string().regex(EVM_ADDRESS_RE, "voter harus address EVM"),
  signature: z
    .string()
    .regex(/^0x[a-fA-F0-9]+$/, "signature harus hex 0x…")
    .max(2 + 130 * 2),
  timestamp: z.number().int().positive(),
});

const redTeamSchema = z.object({
  mode: z.enum(["fast", "llm"]).optional(),
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "AEGIS Oracle API" });
});

function intQuery(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Query ?address=0x… — null bila tidak ada/kosong (arti: semua data). */
function addressQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const addr = raw.trim();
  return addr.length > 0 ? addr : null;
}

app.get("/api/escrows", (req, res) => {
  try {
    const limit = intQuery(req.query.limit, 50, 1, 200);
    const address = addressQuery(req.query.address);
    if (address) {
      return res.json({
        success: true,
        data: getAllDecisionsForAddress(address, limit),
        total: getDecisionsCountForAddress(address),
      });
    }
    res.json({ success: true, data: getAllDecisions(limit), total: getDecisionsCount() });
  } catch (err) {
    logger.error("Error fetching escrows:", err);
    res.status(500).json({ success: false, error: "Gagal mengambil data" });
  }
});

app.get("/api/escrow/:id", (req, res) => {
  try {
    const decision = getDecisionByEscrowId(req.params.id);
    if (!decision) {
      return res.status(404).json({ success: false, error: "Escrow tidak ditemukan" });
    }
    res.json({ success: true, data: decision });
  } catch (err) {
    logger.error("Error fetching escrow:", err);
    res.status(500).json({ success: false, error: "Gagal mengambil data" });
  }
});

// ── Human-in-the-loop ─────────────────────────────────────────────────────────
app.get("/api/human/pending", (_req, res) => {
  try {
    res.json({ success: true, data: getPendingHumanDecisions() });
  } catch (err) {
    logger.error("Error pending human:", err);
    res.status(500).json({ success: false, error: "Gagal mengambil antrean human review" });
  }
});

const VOTE_FAILURE_STATUS: Record<string, { status: number; message: string }> = {
  bad_payload: { status: 400, message: "Payload vote tidak valid" },
  expired_timestamp: { status: 401, message: "Signature kadaluarsa — coba lagi" },
  bad_signature: { status: 401, message: "Signature tidak valid" },
  not_reviewer: { status: 403, message: "Address ini bukan reviewer yang ditunjuk" },
};

// Body: { escrowId, approve, voter, signature, timestamp }.
// Wajib ditandatangani wallet voter (EIP-191) — lihat src/voteAuth.ts.
app.post("/api/human/vote", voteLimiter, async (req, res) => {
  const parsed = voteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: "Payload tidak valid",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }

  const auth = await verifyVote(parsed.data);
  if (!auth.ok) {
    const failure = VOTE_FAILURE_STATUS[auth.failure ?? "bad_payload"]!;
    return res.status(failure.status).json({ success: false, error: failure.message });
  }

  try {
    const { txHash } = await applyHumanVote(parsed.data.escrowId, parsed.data.approve);
    res.json({
      success: true,
      data: { txHash, approve: parsed.data.approve, voter: auth.voter },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Human vote error:", msg);
    if (msg.includes("pending human")) {
      return res.status(404).json({ success: false, error: "Escrow tidak dalam antrean human review" });
    }
    if (msg.includes("kedaluwarsa") || msg.includes("EscrowTimeout")) {
      return res.status(409).json({ success: false, error: msg });
    }
    if (msg.includes("Gagal update DB")) {
      return res.status(409).json({ success: false, error: "Escrow sudah difinalisasi" });
    }
    res.status(500).json({ success: false, error: "Gagal mengeksekusi vote" });
  }
});

// ── Red-team self-test ─────────────────────────────────────────────────────────
app.get("/api/redteam", (_req, res) => {
  const report = getLastRedTeamReport();
  if (!report) {
    return res.json({ success: true, data: null });
  }
  res.json({ success: true, data: report });
});

// Jalankan suite. Mode: ?mode=fast|llm (default fast).
// Butuh token admin; LLM mode lambat (Ollama) — response JSON setelah selesai.
app.post("/api/redteam", redTeamLimiter, requireAdmin, async (req, res) => {
  const q = typeof req.query.mode === "string" ? req.query.mode : undefined;
  const parsedBody = redTeamSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    return res.status(400).json({ success: false, error: "Mode harus fast atau llm" });
  }
  const raw = parsedBody.data.mode ?? q ?? "fast";
  const mode: RedTeamMode = raw === "llm" ? "llm" : "fast";
  try {
    const report = await runRedTeam(mode);
    res.json({ success: true, data: report });
  } catch (err) {
    logger.error("Red-team error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── Arsip sidang (riwayat sesi live per escrow) ───────────────────────────────
app.get("/api/debates", (req, res) => {
  try {
    const limit = intQuery(req.query.limit, 20, 1, 100);
    let all = getDebateSessions();

    const address = addressQuery(req.query.address);
    if (address) {
      const knownIds = getEscrowIdsInvolving(address);
      const addr = address.toLowerCase();
      all = all.filter((s) => {
        if (knownIds.has(s.escrowId)) return true;
        // Sesi yang belum/saja diproses: cocokkan sender/recipient di event escrow.
        return s.events.some((ev) => {
          const d = ev.data;
          if (!d) return false;
          if (typeof d.sender === "string" && d.sender.toLowerCase() === addr) return true;
          if (typeof d.recipient === "string" && d.recipient.toLowerCase() === addr) return true;
          return false;
        });
      });
    }

    res.json({ success: true, data: all.slice(0, limit), total: all.length });
  } catch (err) {
    logger.error("Error fetching debates:", err);
    res.status(500).json({ success: false, error: "Gagal mengambil arsip sidang" });
  }
});

// ── SSE: live pipeline / debate stream ───────────────────────────────────────
app.get("/api/stream", (req, res) => {
  const origin = req.get("origin");
  if (!isAllowedOrigin(origin)) {
    return res.status(403).json({ success: false, error: "Origin tidak diizinkan" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  // Replay buffer agar client yang baru connect tidak kehilangan sesi berjalan.
  for (const ev of getRecentEvents()) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  const unsubscribe = subscribe((ev) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  });

  const ping = setInterval(() => {
    res.write(": ping\n\n");
  }, 15_000);

  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

// ── 404 + error boundary ──────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, error: "Endpoint tidak ditemukan" });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ success: false, error: "JSON tidak valid" });
  }
  logger.error("Unhandled route error:", err);
  res.status(500).json({ success: false, error: "Kesalahan server internal" });
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────
let server: Server | undefined;

export function startServer(port: number = config.PORT): Server {
  server = app.listen(port, () => {
    logger.log(`🌐 Express API jalan di http://localhost:${port}`);
    logger.log(`📡 SSE stream: http://localhost:${port}/api/stream`);
    if (!config.ADMIN_TOKEN) {
      logger.warn(
        `🔑 ADMIN_TOKEN tidak di-set — token acak dibuat untuk sesi ini:\n` +
          `   ${adminToken}\n` +
          `   (set ADMIN_TOKEN di .env untuk token yang stabil)`
      );
    }
    if (config.REVIEWER_ADDRESSES.length === 0) {
      logger.warn(
        `⚠️  REVIEWER_ADDRESSES kosong — vote sah untuk SEMUA address yang ` +
          `menandatangani pesan. Set allowlist di .env untuk produksi.`
      );
    }
  });
  return server;
}

export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const active = server;
    server = undefined;
    active.close(() => resolve());
    // Koneksi SSE/polling menahan close() — putuskan secara paksa setelah grace.
    active.closeIdleConnections?.();
    setTimeout(() => active.closeAllConnections?.(), 2_000).unref();
  });
}
