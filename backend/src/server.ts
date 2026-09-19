import express from "express";
import cors from "cors";
import { getAllDecisions, getDecisionByEscrowId } from "./db.js";

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

export function startServer(port: number = 3001) {
  app.listen(port, () => {
    console.log(`🌐 Express API jalan di http://localhost:${port}`);
  });
}
