import { config } from "./config.js";

export interface RiskAnalysisResult {
  eligible: boolean;
  confidence: number;
  reasoning: string;
}

interface AnalyzeParams {
  recipient: string;
  amountBNB: string;
  recipientTxCount: number;
  recipientAgeInfo: string;
}

export async function analyzeRisk(params: AnalyzeParams): Promise<RiskAnalysisResult> {
  const prompt = `Kamu adalah AI Oracle yang bertugas menilai keamanan transfer crypto sebelum dana dilepas ke penerima.

ATURAN PENILAIAN RISIKO:
- Address penerima BARU (dibuat dalam hitungan menit/jam) + jumlah transfer BESAR = RISIKO TINGGI, harus ditolak (eligible: false)
- Address dengan 0 riwayat transaksi + jumlah besar = mencurigakan, kemungkinan alamat salah ketik atau scam
- Address dengan riwayat transaksi normal dan wajar = aman (eligible: true)

Analisis data berikut dan jawab HANYA dalam format JSON tanpa teks tambahan lain:

Data transaksi:
- Alamat penerima: ${params.recipient}
- Jumlah: ${params.amountBNB} BNB
- Riwayat transaksi penerima: ${params.recipientTxCount} transaksi (${params.recipientAgeInfo})

Format jawaban:
{"eligible": true/false, "confidence": 0-100, "reasoning": "penjelasan singkat dalam Bahasa Indonesia"}`;

  const response = await fetch(`${config.OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen3:8b",
      prompt,
      stream: false,
      format: "json",
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request gagal: ${response.statusText}`);
  }

  const data = await response.json();
  const result = JSON.parse(data.response) as RiskAnalysisResult;

  return result;
}
