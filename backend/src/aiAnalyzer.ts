import { config } from "./config.js";
import type { SecurityCheckResult } from "./goplusChecker.js";
import type { OnChainIntel } from "./bscscanChecker.js";
import { TOOL_CATALOG } from "./tools.js";
import { logger } from "./logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface LLMDecision {
  eligible: boolean;
  /** 0.0 – 1.0 */
  confidence: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  reason: string;
  /**
   * Tool tambahan yang diminta LLM (field tool calling).
   * [] = bukti dinilai cukup → keputusan final dalam 1 call.
   * Berisi nama tool → orkestrator mengeksekusi tool, lalu putaran ke-2.
   */
  needsData: string[];
}

export interface LLMInput {
  sender: string;
  recipient: string;
  amountBNB: number;
  security: SecurityCheckResult;
  intel: OnChainIntel;
  /** Teks memori historis dari agentMemory — siap inject ke prompt */
  memoryContext?: string;
  /** Hasil eksekusi tool (hanya putaran ke-2 / followUp). */
  toolResults?: string;
  /** True untuk putaran ke-2: keputusan final, needsData wajib []. */
  followUp?: boolean;
}

/** Argumen pembela (Advocate) — posisi berkebalikan dari Investigator. */
export interface AdvocateResult {
  position: "RELEASE" | "REJECT";
  /** Argumen dalam Bahasa Indonesia, bersandar pada bukti spesifik. */
  argument: string;
}

/** Transkrip multi-agent debate untuk audit / penyimpanan. */
export interface DebateTranscript {
  investigator: {
    eligible: boolean;
    confidence: number;
    riskLevel: LLMDecision["riskLevel"];
    reason: string;
  };
  advocate: AdvocateResult | null;
  /** Keputusan final Judge (sudah dinilai ulang; needsData dipaksa []). */
  judge: {
    eligible: boolean;
    confidence: number;
    riskLevel: LLMDecision["riskLevel"];
    reason: string;
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────
const VALID_RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

// ── Ollama serialization lock ─────────────────────────────────────────────────
/**
 * Serialisasi SEMUA request Ollama ke satu antrian.
 *
 * Model Qwen3:8b berjalan lokal di satu GPU (VRAM 6GB). Jika beberapa escrow
 * diproses konkuren (poller memakai `void processEscrow`), request akan
 * saling mengantre di dalam Ollama dan memicu timeout — pelajaran dari
 * kegagalan CoT sebelumnya. Dengan lock ini, antrean dikelola di sisi kita:
 * timeout hanya dihitung setelah giliran tiba, bukan selama menunggu.
 */
let ollamaChain: Promise<void> = Promise.resolve();

function withOllamaLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = ollamaChain.then(fn, fn);
  ollamaChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Panggil saat startup: load model ke VRAM SEBELUM escrow pertama tiba.
 * Cold-load qwen3:8b terukur ±20 detik — tanpa warmup, escrow pertama di
 * sesi demo bisa mendekati timeout OLLAMA_TIMEOUT_MS (30 detik).
 * Gagal warmup bukan fatal: escrow tetap diproses (timeout dihitung
 * setelah giliran tiba di antrean lock).
 */
export async function warmupOllama(): Promise<void> {
  try {
    await withOllamaLock(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.OLLAMA_TIMEOUT_MS);
      try {
        const response = await fetch(`${config.OLLAMA_URL}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: config.OLLAMA_MODEL,
            prompt: "OK",
            stream: false,
            keep_alive: "30m",
            options: { num_predict: 1 },
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
    });
    logger.log(`[LLM]     Model ${config.OLLAMA_MODEL} siap (warmup selesai).`);
  } catch (err) {
    logger.warn(
      `[LLM]     Warmup gagal (${err instanceof Error ? err.message : err}) — akan dicoba ulang otomatis pada call pertama.`
    );
  }
}

// ── Prompt Builder ────────────────────────────────────────────────────────────
function buildPrompt(input: LLMInput): string {
  const { sender, recipient, amountBNB, security, intel } = input;

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
        `  Umur wallet      : ${intel.walletAgeInDays !== null ? `${intel.walletAgeInDays.toFixed(1)} hari` : "tidak diketahui (explorer tidak menyediakan data usia)"}`,
        `  Wallet baru      : ${intel.isNewWallet ? "ya" : "tidak"}`,
        `  Smart contract   : ${intel.isContract ? "ya" : "tidak"}`,
        `  Saldo BNB        : ${intel.balanceBNB !== null ? `${intel.balanceBNB.toFixed(6)} BNB` : "tidak diketahui"}`,
      ].join("\n");

  return `Kamu adalah AEGIS INVESTIGATOR — agen penyelidik keamanan transfer crypto di BNB Smart Chain Testnet (Chain ID 97).

Tugasmu: menyelidiki bukti di bawah dan memberikan penilaian risiko terstruktur (penilaian preliminer — hakim AI akan memutuskan akhir setelah sidang adversarial).

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
10. Jika kamu mengisi needsData, gunakan HANYA nama tool dari daftar yang diberikan. Jangan mengarang nama tool.

BUKTI:
Alamat pengirim : ${sender} (profil on-chain pengirim TIDAK TERMASUK dalam bukti)
Alamat penerima : ${recipient}
Jumlah transfer : ${amountBNB} BNB

${goplusSection}

${bscscanSection}

${input.memoryContext ?? "MEMORI HISTORIS AEGIS:\n  Alamat ini BELUM PERNAH dilihat sebelumnya. Ini adalah evaluasi pertama."}

${
  input.followUp
    ? `DATA TAMBAHAN (hasil tool yang kamu minta):
${input.toolResults ?? "(tidak ada)"}

INSTRUKSI PUTARAN INI (PUTARAN KEDUA & TERAKHIR INVESTIGATOR):
- Ini adalah putaran TERAKHIR untuk tool calling. needsData WAJIB: [].
- Keputusanmu adalah penilaian INVESTIGATOR (preliminer) — akan diverbang oleh Advocate & Judge sebelum eksekusi on-chain.
- Perbarui penilaianmu berdasarkan data tambahan di atas — nilai ulang confidence dengan bukti baru.`
    : `DATA TAMBAHAN YANG BISA KAMU MINTA (tool calling):
Jika bukti di atas BELUM cukup untuk penilaian yang meyakinkan, kamu BOLEH meminta data tambahan dengan mengisi needsData. Jika bukti sudah cukup, isi needsData: [].
Daftar tool yang tersedia:
${TOOL_CATALOG.map((t) => `- ${t.name}: ${t.description}`).join("\n")}
Aturan tool:
- Pada mayoritas kasus yang wajar (GoPlus bersih, jumlah kecil, riwayat jelas), cukup isi needsData: [].
- Minta HANYA data yang benar-benar mengubah penilaian — bukan sekadar "memastikan".
- Panduan kapan SEHARUSNYA kamu minta data:
  * Jumlah transfer >= 1 BNB → minta get_sender_profile. Profil pengirim BELUM ada di bukti di atas, dan transfer besar wajib menilai pengirimnya.
  * Kamu ragu terhadap pola aktivitas penerima → get_recipient_recent_txs.
  * Memori historis menunjukkan riwayat negatif yang ingin kamu konfirmasi → tool riwayat database yang sesuai.
- Ini SATU-SATUNYA kesempatan meminta data. Setelah data tambahan diberikan, penilaian Investigatormu final (sidang Advocate/Judge menyusul).`
}

TUGAS:
Berdasarkan bukti di atas, nilai risiko pelepasan dana kepada penerima ini.

Pertimbangkan needsData lebih DULU sebelum menetapkan keputusan: apakah ada celah bukti yang harus ditutup dengan tool?

Kembalikan HANYA objek JSON dengan skema berikut:
{
  "needsData": [],
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
- needsData adalah array NAMA TOOL yang kamu minta (contoh: ["get_sender_profile"]), atau [] jika bukti sudah cukup${
    input.followUp ? " — pada putaran ini WAJIB []" : ""
  }${
    input.followUp
      ? ""
      : `
 - ATURAN IMPERATIF: jika jumlah transfer >= 1 BNB, needsData WAJIB ["get_sender_profile"] — profil pengirim belum ada di bukti dan transfer besar tidak boleh dinilai tanpa profil pengirim.`
  }
- reason HARUS menyebut fakta spesifik: jumlah transaksi, jumlah BNB, status GoPlus
- Contoh reason BAIK: "Alamat penerima memiliki riwayat transaksi normal dan wajar. Jumlah transfer (0.001 BNB) tidak termasuk kategori besar, risiko sangat rendah."
- Contoh reason BAIK: "Alamat penerima memiliki riwayat transaksi 0 yang mencurigakan. Jumlah transfer besar untuk address baru ini memicu risiko tinggi."
- Contoh reason BURUK: "Tidak ada sinyal berbahaya ditemukan." (terlalu generik)
- JANGAN bungkus JSON dalam markdown code fence
- JANGAN tambahkan teks apapun di luar objek JSON`;
}

// ── Shared Ollama generate (dipakai Investigator / Advocate / Judge) ──────────
async function ollamaGenerate(opts: {
  prompt: string;
  temperature?: number;
  numPredict?: number;
  timeoutMs?: number;
}): Promise<string> {
  const temperature = opts.temperature ?? 0.1;
  const numPredict = opts.numPredict ?? 512;
  const timeoutMs = opts.timeoutMs ?? config.OLLAMA_TIMEOUT_MS;

  return withOllamaLock(async () => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort("Ollama request timeout"),
      timeoutMs
    );

    let response: Response;
    try {
      response = await fetch(`${config.OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.OLLAMA_MODEL,
          prompt: opts.prompt,
          stream: false,
          format: "json",
          // Model tetap tinggal di memori selama sesi demo/judging
          // (default Ollama unload setelah 5 menit idle → cold-load ~20 detik).
          keep_alive: "30m",
          options: { temperature, num_predict: numPredict },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort) {
        throw new Error(`Ollama timeout after ${timeoutMs}ms`);
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

    return body.response;
  });
}

/** Extract JSON object pertama dari output LLM (toleran terhadap fence/teks). */
function extractJsonObject(raw: string): Record<string, unknown> {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  cleaned = cleaned.trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON object found in LLM output: ${raw.slice(0, 200)}`);
  }

  try {
    return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Failed to parse LLM JSON: ${e}. Raw: ${raw.slice(0, 200)}`);
  }
}

// ── Main function (Investigator — penilaian + tool calling) ──────────────────
/**
 * Call Qwen3:8b via Ollama for contextual risk reasoning (Investigator phase).
 *
 * LLM receives structured evidence from GoPlus + BscScan.
 * LLM is NOT a source of blockchain facts.
 * Output is validated and sanitized before returning.
 *
 * Throws on: Ollama unavailable, timeout, malformed output, missing fields.
 * Callers should treat thrown errors as fail-safe REJECT.
 */
export async function callLLM(input: LLMInput): Promise<LLMDecision> {
  const prompt = buildPrompt(input);
  const raw = await ollamaGenerate({ prompt });
  return parseLLMOutput(raw);
}

// ── Advocate phase — argumen berkebalikan dari Investigator ──────────────────
/**
 * Advokat menimbang POSISI YANG DIPILIH (berkebalikan dari Investigator)
 * dengan cara: jika Investigator cenderung REJECT → Advocate membela RELEASE,
 * dan sebaliknya. Tugasnya menghasilkan argumen terkuat (steelman) berbasis
 * bukti yang sama — BUKAN memutuskan eligible/confidence.
 */
export async function callAdvocate(
  input: LLMInput,
  investigator: LLMDecision,
  toolResults?: string
): Promise<AdvocateResult> {
  // Posisi Advocat = kebalikan lean Investigator (untuk memaksa adversarial view).
  const position: AdvocateResult["position"] =
    investigator.eligible ? "REJECT" : "RELEASE";

  const prompt = buildAdvocatePrompt(input, investigator, position, toolResults);
  const raw = await ollamaGenerate({ prompt, temperature: 0.3, numPredict: 384 });
  return parseAdvocateOutput(raw, position);
}

function buildAdvocatePrompt(
  input: LLMInput,
  investigator: LLMDecision,
  position: AdvocateResult["position"],
  toolResults?: string
): string {
  const evidence = buildEvidenceBlock(input);
  const stanceLabel =
    position === "RELEASE"
      ? "MENDUKUNG pelepasan dana ke penerima (eligible=true)"
      : "MENDUKUNG pengembalian dana ke pengirim (eligible=false)";

  const investigatorBrief = [
    `Investigator (penilai awal) cenderung: ${investigator.eligible ? "RELEASE" : "REJECT"}`,
    `confidence=${investigator.confidence.toFixed(2)}, riskLevel=${investigator.riskLevel}`,
    `reason: ${investigator.reason}`,
  ].join("\n");

  return `Kamu adalah AEGIS ADVOCATE — pengacara adversarial dalam sidang multi-agent AEGIS.

SIDANG INI:
- Investigator sudah menilai kasus (lihat ringkasan di bawah).
- TUGASMU: buat argumen TERKUAT (steelman) untuk posisi yang BERKEBALIKAN dari lean Investigator, yaitu: ${stanceLabel}.
- Kamu BUKAN hakim. Kamu TIDAK menghasilkan eligible/confidence final. Kamu hanya membangun argumen.

POSISI YANG HARUS KAMU BANGUN:
${stanceLabel}

RINGKASAN INVESTIGATOR:
${investigatorBrief}

${evidence}
${toolResults ? `\nDATA TAMBAHAN (hasil tool Investigator):\n${toolResults}\n` : ""}
ATURAN:
1. Hanya gunakan bukti yang diberikan — jangan mengarang fakta on-chain.
2. Argumen harus konkret: sebut jumlah BNB, status GoPlus, umur/tx wallet, memori historis.
3. Jika posisi yang kamu bela lemah, tetap bangun argumen terbaik yang jujur (tanpa fabrikasi) — inilah gunanya sidang adversarial.
4. Maksimal 4 poin argumen, Bahasa Indonesia, ringkas.

Kembalikan HANYA JSON:
{
  "position": "${position}",
  "argument": "<argumen utama dalam Bahasa Indonesia, 2-4 kalimat>",
  "points": ["<poin 1>", "<poin 2>"]
}
- JANGAN bungkus dalam markdown code fence.
- JANGAN tambahkan teks di luar objek JSON.`;
}

function parseAdvocateOutput(
  raw: string,
  expectedPosition: AdvocateResult["position"]
): AdvocateResult {
  const parsed = extractJsonObject(raw);

  let argument = typeof parsed.argument === "string" ? parsed.argument.trim() : "";
  if (!argument && Array.isArray(parsed.points)) {
    argument = parsed.points
      .filter((p): p is string => typeof p === "string")
      .join(" ");
  }
  if (argument.length < 10) {
    throw new Error(`Advocate argument too short/missing: ${raw.slice(0, 160)}`);
  }

  // Position di-paksa sesuai lean (parser tidak mengikuti LLM yang mungkin membalik).
  return { position: expectedPosition, argument };
}

// ── Judge phase — keputusan final setelah adversarial debate ─────────────────
/**
 * Hakim menimbang bukti + ringkasan Investigator + argumen Advocate,
 * lalu menghasilkan keputusan final (JSON skema sama dengan LLMDecision).
 * needsData dipaksa [] — tool loop sudah selesai sebelum debate.
 */
export async function callJudge(
  input: LLMInput,
  investigator: LLMDecision,
  advocate: AdvocateResult | null,
  toolResults?: string
): Promise<LLMDecision> {
  const prompt = buildJudgePrompt(input, investigator, advocate, toolResults);
  const raw = await ollamaGenerate({ prompt, temperature: 0.1, numPredict: 448 });
  const decision = parseLLMOutput(raw);
  return { ...decision, needsData: [] };
}

function buildJudgePrompt(
  input: LLMInput,
  investigator: LLMDecision,
  advocate: AdvocateResult | null,
  toolResults?: string
): string {
  const evidence = buildEvidenceBlock(input);

  const advocateSection = advocate
    ? `ARGUMEN ADVOCATE (posisi: ${advocate.position}):
${advocate.argument}`
    : "ARGUMEN ADVOCATE: (tidak tersedia — Advocate gagal dijalankan; Anda harus menilai berdasarkan bukti + Investigator saja, dan condong lebih hati-hati.)";

  return `Kamu adalah AEGIS JUDGE — hakim final dalam sidang multi-agent AEGIS.

KONTEKS SIDANG:
1. Investigator sudah menilai kasus berdasarkan bukti.
2. Advocate membangun argumen adversarial (posisi berkebalikan lean Investigator).
3. TUGASMU: timbang secara seimbang bukti asli, ringkasan Investigator, dan argumen Advocate. Keputusanmu FINAL dan akan dieksekusi di blockchain.

RINGKASAN INVESTIGATOR:
- lean: ${investigator.eligible ? "RELEASE" : "REJECT"}
- confidence=${investigator.confidence.toFixed(2)}, riskLevel=${investigator.riskLevel}
- reason: ${investigator.reason}

${advocateSection}

${evidence}
${toolResults ? `\nDATA TAMBAHAN (hasil tool):\n${toolResults}\n` : ""}
ATURAN PENILAIAN:
1. Bukti asli (GoPlus/BscScan/memori) MENGALAHKAN opini Investigator atau Advocate mana pun.
2. Jangan otomatis mengikuti Investigator — argumen Advocate yang berbobot boleh mengubah hasil.
3. Testnet: wallet baru/tx rendah itu normal; jangan turunkan confidence hanya karena itu.
4. GoPlus unavailable ≠ aman; confidence harus turun jika bukti hilang.
5. Output divalidasi — kembalikan HANYA JSON valid.

Kembalikan HANYA objek JSON:
{
  "needsData": [],
  "eligible": true | false,
  "confidence": <0.0-1.0>,
  "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "reason": "<penjelasan Bahasa Indonesia, maksimal 2 kalimat, menyebut fakta spesifik>"
}
Aturan respons:
- eligible=true → dana diteruskan; false → dikembalikan ke pengirim.
- needsData WAJIB [] (tool loop sudah selesai sebelum sidang).
- reason HARUS menyebut fakta spesifik: jumlah transaksi, jumlah BNB, status GoPlus.
- JANGAN bungkus JSON dalam markdown code fence.
- JANGAN tambahkan teks apapun di luar objek JSON.`;
}

// ── Shared evidence block (dipakai prompt Investigator/Advocate/Judge) ───────
function buildEvidenceBlock(input: LLMInput): string {
  const { sender, recipient, amountBNB, security, intel } = input;

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
        `  Umur wallet      : ${intel.walletAgeInDays !== null ? `${intel.walletAgeInDays.toFixed(1)} hari` : "tidak diketahui (explorer tidak menyediakan data usia)"}`,
        `  Wallet baru      : ${intel.isNewWallet ? "ya" : "tidak"}`,
        `  Smart contract   : ${intel.isContract ? "ya" : "tidak"}`,
        `  Saldo BNB        : ${intel.balanceBNB !== null ? `${intel.balanceBNB.toFixed(6)} BNB` : "tidak diketahui"}`,
      ].join("\n");

  return `KONTEKS PENTING:
- Ini adalah lingkungan TESTNET. Wallet baru dengan riwayat transaksi nol atau rendah adalah hal NORMAL dan WAJAR.
- Wallet baru di testnet TIDAK otomatis menandakan niat jahat.
- Data GoPlus berdasarkan reputasi mainnet. Status BERSIH dari GoPlus adalah sinyal positif yang kuat.
- Data BscScan mencerminkan aktivitas testnet saja — sebagian besar wallet testnet yang sah memang memiliki txCount rendah.

BUKTI:
Alamat pengirim : ${sender}
Alamat penerima : ${recipient}
Jumlah transfer : ${amountBNB} BNB

${goplusSection}

${bscscanSection}

${input.memoryContext ?? "MEMORI HISTORIS AEGIS:\n  Alamat ini BELUM PERNAH dilihat sebelumnya. Ini adalah evaluasi pertama."}`;
}

// ── JSON Parser (robust) ──────────────────────────────────────────────────────
/**
 * Parse + validasi output Investigator/Judge.
 * Throw pada JSON rusak / field tidak valid — caller wajib fail-safe REJECT.
 * Diekspor untuk suite red-team (parser abuse).
 */
export function parseLLMOutput(raw: string): LLMDecision {
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

  // ── needsData (tool calling) — field aditif, parsing longgar ───────────────
  // Jika hilang / bukan array → anggap [] (kasus normal: 1 call, tanpa tool).
  // Validasi nama tool terhadap katalog dilakukan di orkestrator (pipeline),
  // bukan di parser — parser sengaja tidak bergantung pada daftar tool.
  let needsData: string[] = [];
  const rawNeeds = parsed.needsData;
  if (typeof rawNeeds === "string" && rawNeeds.trim() !== "") {
    needsData = [rawNeeds.trim()];
  } else if (Array.isArray(rawNeeds)) {
    needsData = rawNeeds
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  needsData = Array.from(new Set(needsData));

  return {
    eligible: parsed.eligible as boolean,
    confidence,
    riskLevel: riskLevel as LLMDecision["riskLevel"],
    reason: (parsed.reason as string).trim(),
    needsData,
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

  try {
    // Serialisasi juga — explanation tidak boleh menabrak call keputusan
    // di antrian Ollama yang sama (satu model, satu GPU).
    const result = await withOllamaLock(async () => {
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
        : `BscScan: txCount=${intel.txCount ?? "?"}, umur=${intel.walletAgeInDays !== null ? `${intel.walletAgeInDays.toFixed(1)} hari` : "?"}, saldo=${intel.balanceBNB !== null ? `${intel.balanceBNB.toFixed(4)} BNB` : "?"}`;

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
            keep_alive: "30m",
            options: { temperature: 0.3, num_predict: 200 },
          }),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const body = (await response.json()) as { response?: string };
        if (!body.response) throw new Error("Empty response");

        // Parse the reason from LLM output
        const cleaned = body.response
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();

        const match = cleaned.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("No JSON in response");

        const parsed = JSON.parse(match[0]) as Record<string, unknown>;
        const reason = parsed.reason;

        if (typeof reason === "string" && reason.trim().length > 10) {
          return reason.trim();
        }
        throw new Error("Invalid reason field");
      } finally {
        clearTimeout(timer);
      }
    });

    logger.log(`[LLM]     Explanation generated: ${result.slice(0, 80)}...`);
    return result;
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (isAbort) {
      logger.warn(`[LLM]     Explanation timeout — using rule context`);
    } else {
      logger.warn(`[LLM]     Explanation failed (${err}) — using rule context`);
    }
    // Fallback: return the structured rule context as-is
    return ruleContext;
  }
}
