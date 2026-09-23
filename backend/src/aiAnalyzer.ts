import { config } from "./config.js";
import type { SecurityCheckResult } from "./goplusChecker.js";
import type { OnChainIntel } from "./bscscanChecker.js";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface LLMDecision {
  eligible: boolean;
  /** 0.0 – 1.0 */
  confidence: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  reason: string;
}

export interface LLMInput {
  recipient: string;
  amountBNB: number;
  security: SecurityCheckResult;
  intel: OnChainIntel;
  /** Teks memori historis dari agentMemory — siap inject ke prompt */
  memoryContext?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const VALID_RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

// ── Prompt Builder ────────────────────────────────────────────────────────────
function buildPrompt(input: LLMInput): string {
  const { recipient, amountBNB, security, intel } = input;

  const goplusSection =
    security.status === "unavailable"
      ? `GoPlus Security: TIDAK TERSEDIA (API tidak dapat dijangkau; anggap sebagai tidak diketahui, BUKAN aman)`
      : security.status === "malicious"
      ? `GoPlus Security: BERBAHAYA (MALICIOUS)\nFlag terdeteksi: ${security.riskFlags.join(", ")}`
      : `GoPlus Security: BERSIH (CLEAN, tidak ada flag berbahaya)\nFlag yang diperiksa: ${security.riskFlags.length === 0 ? "tidak ada" : security.riskFlags.join(", ")}`;

  const bscscanSection = intel.unavailable
    ? `BscScan On-chain: TIDAK TERSEDIA (anggap sebagai tidak diketahui, BUKAN aman)`
    : [
        `BscScan On-chain (BSC Testnet):`,
        `  Jumlah transaksi : ${intel.txCount ?? "tidak diketahui"}`,
        `  Umur wallet      : ${intel.walletAgeInDays !== null ? `${intel.walletAgeInDays.toFixed(1)} hari` : "tidak diketahui (belum pernah transaksi)"}`,
        `  Wallet baru      : ${intel.isNewWallet ? "ya" : "tidak"}`,
        `  Smart contract   : ${intel.isContract ? "ya" : "tidak"}`,
        `  Saldo BNB        : ${intel.balanceBNB !== null ? `${intel.balanceBNB.toFixed(6)} BNB` : "tidak diketahui"}`,
      ].join("\n");

  return `Kamu adalah AEGIS AI Oracle — mesin analisis keamanan transfer crypto di BNB Smart Chain Testnet (Chain ID 97).

Tugasmu: menganalisis bukti di bawah dan memberikan penilaian risiko terstruktur.

KONTEKS PENTING:
- Ini adalah lingkungan TESTNET. Wallet baru dengan riwayat transaksi nol atau rendah adalah hal NORMAL dan WAJAR.
- Wallet baru di testnet TIDAK otomatis menandakan niat jahat.
- Data GoPlus berdasarkan reputasi mainnet. Status BERSIH dari GoPlus adalah sinyal positif yang kuat.
- Data BscScan mencerminkan aktivitas testnet saja — sebagian besar wallet testnet yang sah memang memiliki txCount rendah.
- Kepercayaan (confidence) harus mencerminkan sinyal risiko NYATA, bukan sekadar umur wallet.

ATURAN WAJIB:
1. Kamu adalah mesin PENALARAN, bukan sumber fakta blockchain. Gunakan hanya bukti yang diberikan.
2. Jika data GoPlus atau BscScan TIDAK TERSEDIA, jangan anggap itu berarti aman. Anggap sebagai informasi yang hilang.
3. JANGAN simpulkan wallet aman hanya karena sudah lama atau banyak transaksi.
4. Di TESTNET: JANGAN turunkan confidence hanya karena wallet baru. Wallet baru adalah hal biasa di sini.
5. Jika GoPlus BERSIH dan tidak ada flag berbahaya, ini sinyal positif yang signifikan.
6. Naikkan confidence untuk GoPlus BERSIH + jumlah kecil. Turunkan confidence hanya jika ada sinyal risiko NYATA.
7. Confidence TINGGI (>=0.75) jika: GoPlus=BERSIH, tidak ada flag, jumlah kecil hingga sedang.
8. Confidence RENDAH jika: GoPlus tidak tersedia, ada sinyal yang bertentangan, atau pola mencurigakan.
9. Outputmu akan divalidasi. Kembalikan HANYA JSON valid sesuai skema di bawah.

BUKTI:
Alamat penerima : ${recipient}
Jumlah transfer : ${amountBNB} BNB

${goplusSection}

${bscscanSection}

${input.memoryContext ?? "MEMORI HISTORIS AEGIS:\n  Alamat ini BELUM PERNAH dilihat sebelumnya. Ini adalah evaluasi pertama."}

TUGAS:
Berdasarkan bukti di atas, nilai risiko pelepasan dana kepada penerima ini.

Kembalikan HANYA objek JSON dengan skema berikut:
{
  "eligible": true | false,
  "confidence": <angka desimal 0.0 sampai 1.0>,
  "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "reason": "<penjelasan dalam Bahasa Indonesia, maksimal 2 kalimat>"
}

Aturan respons:
- eligible=true berarti dana boleh diteruskan ke penerima
- eligible=false berarti dana dikembalikan ke pengirim
- confidence adalah keyakinan KAMU terhadap keputusan ini (0.0=tidak yakin, 1.0=sangat yakin)
- riskLevel mencerminkan tingkat risiko transaksi, tidak tergantung arah keputusan
- reason HARUS menyebut fakta spesifik: jumlah transaksi, jumlah BNB, status GoPlus
- Contoh reason BAIK: "Alamat penerima memiliki riwayat transaksi normal dan wajar. Jumlah transfer (0.001 BNB) tidak termasuk kategori besar, risiko sangat rendah."
- Contoh reason BAIK: "Alamat penerima memiliki riwayat transaksi 0 yang mencurigakan. Jumlah transfer besar untuk address baru ini memicu risiko tinggi."
- Contoh reason BURUK: "Tidak ada sinyal berbahaya ditemukan." (terlalu generik)
- JANGAN bungkus JSON dalam markdown code fence
- JANGAN tambahkan teks apapun di luar objek JSON`;
}

// ── Main function ─────────────────────────────────────────────────────────────
/**
 * Call Qwen3:8b via Ollama for contextual risk reasoning.
 *
 * LLM receives structured evidence from GoPlus + BscScan.
 * LLM is NOT a source of blockchain facts.
 * Output is validated and sanitized before returning.
 *
 * Throws on: Ollama unavailable, timeout, malformed output, missing fields.
 * Callers should treat thrown errors as fail-safe REJECT.
 */
export async function callLLM(input: LLMInput): Promise<LLMDecision> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort("Ollama request timeout"),
    config.OLLAMA_TIMEOUT_MS
  );

  const prompt = buildPrompt(input);

  let response: Response;
  try {
    response = await fetch(`${config.OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.OLLAMA_MODEL,
        prompt,
        stream: false,
        format: "json",
        options: {
          temperature: 0.1, // low temperature for consistent, deterministic output
          num_predict: 512,
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (isAbort) {
      throw new Error(`Ollama timeout after ${config.OLLAMA_TIMEOUT_MS}ms`);
    }
    throw new Error(`Ollama network error: ${err}`);
  }

  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`Ollama HTTP ${response.status}: ${response.statusText}`);
  }

  let body: { response?: string };
  try {
    body = (await response.json()) as { response?: string };
  } catch {
    throw new Error("Ollama returned malformed JSON body");
  }

  if (!body.response || typeof body.response !== "string") {
    throw new Error("Ollama response missing 'response' field");
  }

  // Parse and validate the LLM's JSON output
  return parseLLMOutput(body.response);
}

// ── JSON Parser (robust) ──────────────────────────────────────────────────────
function parseLLMOutput(raw: string): LLMDecision {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  cleaned = cleaned.trim();

  // Extract first JSON object if there's surrounding text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON object found in LLM output: ${raw.slice(0, 200)}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Failed to parse LLM JSON: ${e}. Raw: ${raw.slice(0, 200)}`);
  }

  // ── Field validation ──────────────────────────────────────────────────────
  if (typeof parsed.eligible !== "boolean") {
    // Coerce "true"/"false" strings
    if (parsed.eligible === "true") parsed.eligible = true;
    else if (parsed.eligible === "false") parsed.eligible = false;
    else throw new Error(`Invalid 'eligible' field: ${parsed.eligible}`);
  }

  let confidence = Number(parsed.confidence);
  if (isNaN(confidence)) {
    throw new Error(`Invalid 'confidence' field: ${parsed.confidence}`);
  }
  // Normalize: LLM sometimes returns 0-100 scale
  if (confidence > 1.0) {
    confidence = confidence / 100;
  }
  if (confidence < 0 || confidence > 1) {
    throw new Error(`Confidence out of range [0,1]: ${confidence}`);
  }

  const riskLevel = String(parsed.riskLevel ?? "").toUpperCase();
  if (!VALID_RISK_LEVELS.includes(riskLevel as typeof VALID_RISK_LEVELS[number])) {
    throw new Error(`Invalid 'riskLevel': ${parsed.riskLevel}`);
  }

  if (typeof parsed.reason !== "string" || parsed.reason.trim() === "") {
    throw new Error(`Missing or empty 'reason' field`);
  }

  return {
    eligible: parsed.eligible as boolean,
    confidence,
    riskLevel: riskLevel as LLMDecision["riskLevel"],
    reason: (parsed.reason as string).trim(),
  };
}

// ── Hard Rule Explanation (AI-generated, short timeout) ──────────────────────

export interface ExplanationContext {
  recipient: string;
  amountBNB: number;
  security: SecurityCheckResult;
  intel: OnChainIntel;
  /** The deterministic rule that triggered REJECT */
  triggeredRule: string;
  /** Short hardcoded context for LLM (what was detected) */
  ruleContext: string;
}

/**
 * Generate a natural, user-facing explanation for a hard rule REJECT.
 *
 * IMPORTANT: This function does NOT decide eligible/confidence.
 * The decision is ALREADY made by the rule engine (always REJECT).
 * This only generates the human-readable reason string.
 *
 * Uses a short 10s timeout. Falls back to ruleContext if LLM is slow.
 */
export async function generateHardRuleExplanation(
  ctx: ExplanationContext
): Promise<string> {
  const { recipient, amountBNB, security, intel, ruleContext } = ctx;

  const controller = new AbortController();
  // Short timeout for explanation — don't block pipeline
  const EXPLAIN_TIMEOUT = Math.min(config.OLLAMA_TIMEOUT_MS, 15_000);
  const timer = setTimeout(() => controller.abort(), EXPLAIN_TIMEOUT);

  const goplusSection =
    security.status === "unavailable"
      ? `GoPlus: TIDAK TERSEDIA`
      : security.status === "malicious"
      ? `GoPlus: BERBAHAYA — Flag: ${security.riskFlags.join(", ")}`
      : `GoPlus: BERSIH`;

  const bscscanSection = intel.unavailable
    ? `BscScan: TIDAK TERSEDIA`
    : [
        `BscScan: txCount=${intel.txCount ?? "?"}, umur=${intel.walletAgeInDays !== null ? `${intel.walletAgeInDays.toFixed(1)} hari` : "?"}, saldo=${intel.balanceBNB !== null ? `${intel.balanceBNB.toFixed(4)} BNB` : "?"}`,
      ].join("");

  const prompt = `Kamu adalah AEGIS AI Oracle. Sistem keamanan kami telah MEMUTUSKAN untuk MENOLAK transfer ini berdasarkan aturan deterministik.

KEPUTUSAN SUDAH FINAL: TOLAK (kamu tidak bisa mengubah ini)
Alasan teknis: ${ruleContext}

Data transaksi:
- Alamat penerima: ${recipient}
- Jumlah: ${amountBNB} BNB
- ${goplusSection}
- ${bscscanSection}

TUGASMU: Tulis penjelasan dalam Bahasa Indonesia yang jelas, mudah dipahami, dan MENYEBUT FAKTA SPESIFIK (jumlah transaksi, jumlah BNB, status keamanan). Maksimal 2 kalimat.

Contoh yang BAIK:
- "Alamat penerima memiliki riwayat transaksi 0 dan menerima transfer 0.05 BNB yang cukup besar, sehingga dana dikembalikan untuk melindungi pengirim."
- "GoPlus mendeteksi alamat ini sebagai phishing. Dana dikembalikan ke pengirim demi keamanan."

Kembalikan HANYA string JSON dengan format:
{"reason": "penjelasan spesifik di sini"}`;

  try {
    const response = await fetch(`${config.OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.OLLAMA_MODEL,
        prompt,
        stream: false,
        format: "json",
        options: { temperature: 0.3, num_predict: 200 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const body = (await response.json()) as { response?: string };
    if (!body.response) throw new Error("Empty response");

    // Parse the reason from LLM output
    const cleaned = body.response.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in response");

    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const reason = parsed.reason;

    if (typeof reason === "string" && reason.trim().length > 10) {
      console.log(`[LLM]     Explanation generated: ${reason.slice(0, 80)}...`);
      return reason.trim();
    }

    throw new Error("Invalid reason field");
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (isAbort) {
      console.warn(`[LLM]     Explanation timeout — using rule context`);
    } else {
      console.warn(`[LLM]     Explanation failed (${err}) — using rule context`);
    }
    // Fallback: return the structured rule context as-is
    return ruleContext;
  }
}
