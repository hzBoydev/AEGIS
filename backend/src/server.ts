import express from "express";
import cors from "cors";
import {
  getAllDecisions,
  getDecisionByEscrowId,
  getPendingHumanDecisions,
} from "./db.js";
import { getRecentEvents, subscribe } from "./streamBus.js";
import { runRedTeam, getLastRedTeamReport, type RedTeamMode } from "./redTeam.js";
import { applyHumanVote } from "./poller.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "AEGIS Oracle API" });
});

app.get("/api/escrows", (_req, res) => {
  try {
    const decisions = getAllDecisions();
    res.json({ success: true, data: decisions });
  } catch (err) {
    console.error("Error fetching escrows:", err);
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
    console.error("Error fetching escrow:", err);
    res.status(500).json({ success: false, error: "Gagal mengambil data" });
  }
});

// ── Human-in-the-loop ─────────────────────────────────────────────────────────
app.get("/api/human/pending", (_req, res) => {
  try {
    res.json({ success: true, data: getPendingHumanDecisions() });
  } catch (err) {
    console.error("Error pending human:", err);
    res.status(500).json({ success: false, error: "Gagal mengambil antrean human review" });
  }
});

// Body: { approve: boolean } — vote manusia menentukan eligible on-chain final.
app.post("/api/human/vote", async (req, res) => {
  const body = req.body as { escrowId?: string; approve?: unknown };
  const escrowId = body.escrowId;
  if (!escrowId || typeof body.approve !== "boolean") {
    return res.status(400).json({
      success: false,
      error: "escrowId (string) dan approve (boolean) wajib",
    });
  }
  try {
    const { txHash } = await applyHumanVote(escrowId, body.approve);
    res.json({ success: true, data: { txHash, approve: body.approve } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Human vote error:", msg);
    const status = msg.includes("pending human") ? 404 : 500;
    res.status(status).json({ success: false, error: msg });
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
// LLM mode lambat (Ollama) — response JSON setelah selesai.
app.post("/api/redteam", async (req, res) => {
  const q = (req.query.mode as string | undefined) ?? undefined;
  const bodyMode = (req.body as { mode?: string } | undefined)?.mode;
  const raw = bodyMode ?? q ?? "fast";
  const mode: RedTeamMode = raw === "llm" ? "llm" : "fast";
  try {
    const report = await runRedTeam(mode);
    res.json({ success: true, data: report });
  } catch (err) {
    console.error("Red-team error:", err);
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── SSE: live pipeline / debate stream ───────────────────────────────────────
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
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

export function startServer(port: number = 3001) {
  app.listen(port, () => {
    console.log(`🌐 Express API jalan di http://localhost:${port}`);
    console.log(`📡 SSE stream: http://localhost:${port}/api/stream`);
  });
}
