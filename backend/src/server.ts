import express from "express";
import cors from "cors";
import {
  getAllDecisions,
  getAllDecisionsForAddress,
  getDecisionsCount,
  getDecisionsCountForAddress,
  getEscrowIdsInvolving,
  getPendingHumanDecisions,
} from "./db.js";
import { getRecentEvents, subscribe, getDebateSessions } from "./streamBus.js";
import { applyHumanVote } from "./poller.js";

const app = express();
app.use(cors());
app.use(express.json());

function intQuery(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Query ?address=0x… — null when absent/empty (meaning: all data). */
function addressQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const addr = raw.trim();
  return addr.length > 0 ? addr : null;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

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
    console.error("Error fetching escrows:", err);
    res.status(500).json({ success: false, error: "Failed to fetch data" });
  }
});

// ── Human-in-the-loop ─────────────────────────────────────────────────────────
app.get("/api/human/pending", (_req, res) => {
  try {
    res.json({ success: true, data: getPendingHumanDecisions() });
  } catch (err) {
    console.error("Error pending human:", err);
    res.status(500).json({ success: false, error: "Failed to fetch the human review queue" });
  }
});

// Body: { approve: boolean } — the human vote determines the final on-chain eligible value.
app.post("/api/human/vote", async (req, res) => {
  const body = req.body as { escrowId?: string; approve?: unknown };
  const escrowId = body.escrowId;
  if (!escrowId || typeof body.approve !== "boolean") {
    return res.status(400).json({
      success: false,
      error: "escrowId (string) and approve (boolean) are required",
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

// ── Hearing archive (live session history per escrow) ──────────────────────────
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
        // Sessions not yet / just processed: match sender/recipient on escrow events.
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
    console.error("Error fetching debates:", err);
    res.status(500).json({ success: false, error: "Failed to fetch the hearing archive" });
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

  // Replay the buffer so a newly connected client does not miss the running session.
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

export function startServer(port: number) {
  app.listen(port, () => {
    console.log(`🌐 Express API running on http://localhost:${port}`);
    console.log(`📡 SSE stream: http://localhost:${port}/api/stream`);
  });
}
