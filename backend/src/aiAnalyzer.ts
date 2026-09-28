import { config } from "./config.js";
import type { SecurityCheckResult } from "./goplusChecker.js";
import type { OnChainIntel } from "./bscscanChecker.js";
import { TOOL_CATALOG } from "./tools.js";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface LLMDecision {
  eligible: boolean;
  /** 0.0 – 1.0 */
  confidence: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  reason: string;
  /**
   * Extra tools requested by the LLM (tool calling field).
   * [] = the evidence is deemed sufficient → final decision in 1 call.
   * Contains tool names → the orchestrator executes them, then a second round runs.
   */
  needsData: string[];
}

export interface LLMInput {
  sender: string;
  recipient: string;
  amountBNB: number;
  security: SecurityCheckResult;
  intel: OnChainIntel;
  /** Historical memory text from agentMemory — ready to inject into the prompt */
  memoryContext?: string;
  /** Tool execution results (second round / followUp only). */
  toolResults?: string;
  /** True for the second round: final decision, needsData must be []. */
  followUp?: boolean;
}

/** Advocate arguments — the position opposite to the Investigator's. */
export interface AdvocateResult {
  position: "RELEASE" | "REJECT";
  /** Argument in English, grounded in specific evidence. */
  argument: string;
}

/** Multi-agent debate transcript for auditing / storage. */
export interface DebateTranscript {
  investigator: {
    eligible: boolean;
    confidence: number;
    riskLevel: LLMDecision["riskLevel"];
    reason: string;
  };
  advocate: AdvocateResult | null;
  /** The Judge's final decision (re-assessed; needsData forced to []). */
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
 * Serialize ALL Ollama requests into a single queue.
 *
 * The Qwen3:8b model runs locally on one GPU (6GB VRAM). If several escrows are
 * processed concurrently (the poller uses `void processEscrow`), the requests
 * queue up inside Ollama and trigger timeouts — a lesson from an earlier CoT
 * failure. With this lock the queue is managed on our side: the timeout is only
 * counted once a turn arrives, not while waiting.
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
 * Call at startup: load the model into VRAM BEFORE the first escrow arrives.
 * A cold-load of qwen3:8b measures at ~20 seconds — without a warmup, the first
 * escrow in a demo session can approach the OLLAMA_TIMEOUT_MS timeout (30 seconds).
 * A failed warmup is not fatal: the escrow is still processed (the timeout is
 * counted once a turn arrives in the lock queue).
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
    console.log(`[LLM]     Model ${config.OLLAMA_MODEL} ready (warmup done).`);
  } catch (err) {
    console.warn(
      `[LLM]     Warmup failed (${err instanceof Error ? err.message : err}) — it will be retried automatically on the first call.`
    );
  }
}

// ── Prompt Builder ────────────────────────────────────────────────────────────
/**
 * The txCount evidence line, HONEST about its data source.
 *
 * The BscScan V1 explorer is dead and Etherscan V2 for chain 97 is paid, so the
 * number often comes from the RPC nonce = OUTGOING transactions ONLY.
 * Without this label the model writes "0 on-chain transactions", which is
 * misleading for receive-only accounts (whose nonce is always 0 anyway).
 */
function txCountLine(intel: OnChainIntel): string {
  if (intel.txCount === null) {
    return "  Transaction count: unknown (both the explorer and the RPC failed)";
  }
  if (intel.txCountSource === "explorer") {
    return `  Transaction count: ${intel.txCount} (source: explorer — includes incoming + outgoing transactions)`;
  }
  return (
    `  Outgoing transactions: ${intel.txCount} (source: RPC nonce — ONLY OUTGOING transactions; ` +
    `incoming transactions are NOT counted because the BscScan explorer is unavailable. ` +
    `This is NOT the on-chain transaction total — a receive-only account legitimately shows 0.)`
  );
}

/** Reason-writing rule about the txCount source — used by Investigator/Judge/explanation. */
const TX_SOURCE_RULE =
  '- If the txCount source = RPC nonce (outgoing transactions), you are FORBIDDEN to write "0 on-chain transactions" / "no on-chain transactions" / "has never transacted". ' +
  'Write exactly: "has never sent an outgoing transaction (nonce 0)". For the real activity of the account (incoming), use the numbers from the AEGIS MEMORY block.';

function buildPrompt(input: LLMInput): string {
  const { sender, recipient, amountBNB, security, intel } = input;

  const goplusSection =
    security.status === "unavailable"
      ? `GoPlus Security: UNAVAILABLE (the API cannot be reached; treat as unknown, NOT safe)`
      : security.status === "malicious"
      ? `GoPlus Security: MALICIOUS\nFlags detected: ${security.riskFlags.join(", ")}`
      : `GoPlus Security: CLEAN (no malicious flags)\nFlags checked: ${security.riskFlags.length === 0 ? "none" : security.riskFlags.join(", ")}`;

  const bscscanSection = intel.unavailable
    ? `BscScan On-chain: UNAVAILABLE (treat as unknown, NOT safe)`
    : [
        `BscScan On-chain (BSC Testnet):`,
        txCountLine(intel),
        `  Wallet age       : ${intel.walletAgeInDays !== null ? `${intel.walletAgeInDays.toFixed(1)} days` : "unknown (the explorer provides no age data)"}`,
        `  New wallet       : ${intel.isNewWallet ? "yes" : "no"}`,
        `  Smart contract   : ${intel.isContract ? "yes" : "no"}`,
        `  BNB balance      : ${intel.balanceBNB !== null ? `${intel.balanceBNB.toFixed(6)} BNB` : "unknown"}`,
      ].join("\n");

  return `You are the AEGIS INVESTIGATOR — a security investigator agent for crypto transfers on BNB Smart Chain Testnet (Chain ID 97).

Your task: investigate the evidence below and produce a structured risk assessment (a preliminary assessment — the AI judge makes the final call after an adversarial hearing).

LANGUAGE: You must write every free-text field in ENGLISH. Never answer in any other language.

IMPORTANT CONTEXT:
- This is a TESTNET environment. A new wallet with zero or low transaction history is NORMAL and EXPECTED.
- A new testnet wallet does NOT automatically indicate malicious intent.
- GoPlus data is based on mainnet reputation. A CLEAN status from GoPlus is a strong positive signal.
- BscScan data reflects testnet activity only — most legitimate testnet wallets do have a low txCount.
- The confidence must reflect REAL risk signals, not merely wallet age.

MANDATORY RULES:
1. You are a REASONING engine, not a source of blockchain facts. Use only the evidence provided.
2. If GoPlus or BscScan data is UNAVAILABLE, do not treat that as safe. Treat it as missing information.
3. NEVER conclude a wallet is safe just because it is old or has many transactions.
4. On TESTNET: NEVER lower the confidence just because the wallet is new. New wallets are common here.
5. If GoPlus is CLEAN with no malicious flags, that is a significant positive signal.
6. Raise the confidence for a CLEAN GoPlus + a small amount. Lower the confidence only when there are REAL risk signals.
7. HIGH confidence (>=0.75) when: GoPlus=CLEAN, no flags, small-to-medium amount.
8. LOW confidence when: GoPlus is unavailable, signals conflict, or the pattern is suspicious.
9. Your output will be validated. Return ONLY valid JSON matching the schema below.
10. If you fill needsData, use ONLY tool names from the given list. Do not invent tool names.
11. The HISTORICAL MEMORY block is REAL history from the AEGIS database. If the number "Transactions via AEGIS: N" is N > 0, the reason MUST mention N and it is FORBIDDEN to write "first evaluation" / "has never transacted via AEGIS".

EVIDENCE:
Sender address   : ${sender} (the sender's on-chain profile is NOT part of the evidence)
Recipient address: ${recipient}
Transfer amount  : ${amountBNB} BNB

${input.memoryContext ?? "AEGIS HISTORICAL MEMORY (INTERNAL history — NOT on-chain data):\n  This address has NEVER transacted via AEGIS before (internal history is empty). This is the first evaluation."}

${goplusSection}

${bscscanSection}

${
  input.followUp
    ? `ADDITIONAL DATA (results of the tools you requested):
${input.toolResults ?? "(none)"}

INSTRUCTIONS FOR THIS ROUND (THE INVESTIGATOR'S SECOND AND FINAL ROUND):
- This is the LAST round for tool calling. needsData MUST be: [].
- Your decision is the INVESTIGATOR's assessment (preliminary) — it will be debated by the Advocate and Judge before the on-chain execution.
- Update your assessment based on the additional data above — re-evaluate the confidence with the new evidence.`
    : `ADDITIONAL DATA YOU MAY REQUEST (tool calling):
If the evidence above is NOT yet enough for a convincing assessment, you MAY request additional data by filling needsData. If the evidence is already sufficient, set needsData: [].
Available tools:
${TOOL_CATALOG.map((t) => `- ${t.name}: ${t.description}`).join("\n")}
Tool rules:
- In the vast majority of reasonable cases (GoPlus clean, small amount, clear history), just set needsData: [].
- Request ONLY data that genuinely changes the assessment — not merely to "double check".
- Guidance on WHEN you should request data:
  * Transfer amount >= 1 BNB → request get_sender_profile. The sender profile is NOT yet in the evidence above, and a large transfer must assess the sender.
  * You are unsure about the recipient's activity pattern → get_recipient_recent_txs.
  * The historical memory shows a negative history you want to confirm → the matching database history tool.
- How to read a tool result that comes back with "status": "unavailable": the data source could not be reached. Treat the value as UNKNOWN. Never interpret unavailable as "zero", "empty", or "no history", and never lower your confidence because of it. If the recipient pattern is unknown, say so in your reason and judge on the evidence you do have.
- This is the ONE AND ONLY chance to request data. Once the additional data is given, your Investigator assessment is final (the Advocate/Judge hearing follows).`
}

TASK:
Based on the evidence above, assess the risk of releasing the funds to this recipient.

Consider needsData FIRST before settling on a decision: is there an evidence gap that must be closed with a tool?

Return ONLY a JSON object with the following schema:
{
  "needsData": [],
  "eligible": true | false,
  "confidence": <decimal number from 0.0 to 1.0>,
  "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "reason": "<explanation written in ENGLISH, at most 3 sentences>"
}

Response rules:
- eligible=true means the funds may be released to the recipient
- eligible=false means the funds are returned to the sender
- confidence is YOUR certainty about this decision (0.0=not sure, 1.0=very sure)
- riskLevel reflects the transaction's risk level, regardless of the decision direction
- needsData is an array of the TOOL NAMES you request (e.g. ["get_sender_profile"]), or [] if the evidence is already sufficient${
    input.followUp ? " — on this round it MUST be []" : ""
  }${
    input.followUp
      ? ""
      : `
 - IMPERATIVE RULE: if the transfer amount >= 1 BNB, needsData MUST be ["get_sender_profile"] — the sender profile is not in the evidence and a large transfer must not be assessed without the sender profile.`
  }
- The reason MUST state 4 specific facts: (a) the recipient account's on-chain transaction count, (b) the account's AEGIS history from the MEMORY block — how many times it has transacted/been evaluated and how many times it was rejected (say "never before" if it is the first evaluation), (c) the BNB amount, (d) the GoPlus status
- (a) and (b) are DIFFERENT numbers: (a) comes from the on-chain BscScan data, (b) from the AEGIS database MEMORY block. Never mix them, never invent them — use the numbers exactly as written in the evidence.
${TX_SOURCE_RULE}
- GOOD reason example: "The recipient address has 3 on-chain transactions, has transacted via AEGIS 2 times and all were approved. The transfer amount (0.001 BNB) is not in the large category and GoPlus is CLEAN, so the risk is very low."
- GOOD reason example: "The recipient address has 0 on-chain transactions and has never transacted via AEGIS (first evaluation). A large transfer amount for this new address triggers a high risk."
- BAD reason example: "No malicious signals were found." (too generic)
- BAD reason example (VIOLATION): "0 on-chain transactions and this is the first evaluation" — while MEMORY says "Transactions via AEGIS: 15x". That mixes the RPC nonce with the AEGIS history and ignores the evidence.
- DO NOT wrap the JSON in a markdown code fence
- DO NOT add any text outside the JSON object`;
}

// ── Shared Ollama generate (used by Investigator / Advocate / Judge) ──────────
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
          // The model stays in memory for the whole demo/judging session
          // (Ollama's default unload after 5 idle minutes → cold-load ~20 seconds).
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

/** Extract the first JSON object from the LLM output (tolerant of fences/text). */
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

// ── Main function (Investigator — assessment + tool calling) ──────────────────
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

// ── Advocate phase — argument opposite to the Investigator ───────────────────
/**
 * The Advocate argues the CHOSEN POSITION (opposite to the Investigator's)
 * as follows: if the Investigator leans REJECT → the Advocate defends RELEASE,
 * and vice versa. Its job is to produce the strongest argument (steelman) based
 * on the same evidence — NOT to decide eligible/confidence.
 */
export async function callAdvocate(
  input: LLMInput,
  investigator: LLMDecision,
  toolResults?: string
): Promise<AdvocateResult> {
  // The Advocate's position = the opposite of the Investigator's lean (to force an adversarial view).
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
      ? "SUPPORTING the release of funds to the recipient (eligible=true)"
      : "SUPPORTING the return of funds to the sender (eligible=false)";

  const investigatorBrief = [
    `Investigator (initial assessor) leans: ${investigator.eligible ? "RELEASE" : "REJECT"}`,
    `confidence=${investigator.confidence.toFixed(2)}, riskLevel=${investigator.riskLevel}`,
    `reason: ${investigator.reason}`,
  ].join("\n");

  return `You are the AEGIS ADVOCATE — the adversarial lawyer in the AEGIS multi-agent hearing.

THIS HEARING:
- The Investigator has already assessed the case (see the summary below).
- YOUR TASK: build the STRONGEST argument (steelman) for the position OPPOSITE to the Investigator's lean, namely: ${stanceLabel}.
- You are NOT the judge. You do NOT produce the final eligible/confidence. You only build the argument.

LANGUAGE: You must write the argument in ENGLISH. Never answer in any other language.

THE POSITION YOU MUST BUILD:
${stanceLabel}

INVESTIGATOR SUMMARY:
${investigatorBrief}

${evidence}
${toolResults ? `\nADDITIONAL DATA (results of the Investigator's tools):\n${toolResults}\n` : ""}
RULES:
1. Only use the evidence provided — never invent on-chain facts.
2. The argument must be concrete: state the BNB amount, the GoPlus status, the wallet age/tx count, the historical memory.
3. The HISTORICAL MEMORY block is REAL history from the AEGIS database (not on-chain data). If "Transactions via AEGIS: N" > 0, never call this address "has never transacted via AEGIS" / "first evaluation".
${TX_SOURCE_RULE}
4. If the position you defend is weak, still build the best honest argument (without fabrication) — that is the point of an adversarial hearing.
5. At most 4 argument points, in English, concise.

Return ONLY JSON:
{
  "position": "${position}",
  "argument": "<the main argument in English, 2-4 sentences>",
  "points": ["<point 1>", "<point 2>"]
}
- DO NOT wrap it in a markdown code fence.
- DO NOT add any text outside the JSON object.`;
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
    throw new Error(`Advocate argument too short or missing: ${raw.slice(0, 160)}`);
  }

  // The position is forced to match the lean (the parser does not follow an LLM that may flip it).
  return { position: expectedPosition, argument };
}

// ── Judge phase — final decision after the adversarial debate ───────────────
/**
 * The judge weighs the evidence + the Investigator's summary + the Advocate's
 * arguments, then produces the final decision (JSON with the same schema as
 * LLMDecision). needsData is forced to [] — the tool loop already finished
 * before the debate.
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
    ? `ADVOCATE'S ARGUMENT (position: ${advocate.position}):
${advocate.argument}`
    : "ADVOCATE'S ARGUMENT: (unavailable — the Advocate could not run; you must assess based on the evidence + the Investigator alone, and lean more cautiously.)";

  return `You are the AEGIS JUDGE — the final judge in the AEGIS multi-agent hearing.

HEARING CONTEXT:
1. The Investigator has already assessed the case based on the evidence.
2. The Advocate builds the adversarial argument (the position opposite to the Investigator's lean).
3. YOUR TASK: weigh the original evidence, the Investigator's summary and the Advocate's argument in balance. Your decision is FINAL and will be executed on the blockchain.

LANGUAGE: You must write the reason in ENGLISH. Never answer in any other language.

INVESTIGATOR SUMMARY:
- lean: ${investigator.eligible ? "RELEASE" : "REJECT"}
- confidence=${investigator.confidence.toFixed(2)}, riskLevel=${investigator.riskLevel}
- reason: ${investigator.reason}

${advocateSection}

${evidence}
${toolResults ? `\nADDITIONAL DATA (tool results):\n${toolResults}\n` : ""}
ASSESSMENT RULES:
1. The original evidence (GoPlus/BscScan/memory) OVERRIDES any Investigator or Advocate opinion.
2. Do not automatically follow the Investigator — a well-argued Advocate case may change the outcome.
3. Testnet: a new wallet / low tx count is normal; never lower the confidence for that alone.
4. GoPlus unavailable ≠ safe; the confidence must drop when evidence is missing.
5. The output is validated — return ONLY valid JSON.
6. The HISTORICAL MEMORY block is REAL history from the AEGIS database. If the number "Transactions via AEGIS: N" is N > 0, the reason MUST mention N and it is FORBIDDEN to write "first evaluation" / "has never transacted via AEGIS".

Return ONLY a JSON object:
{
  "needsData": [],
  "eligible": true | false,
  "confidence": <0.0-1.0>,
  "riskLevel": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "reason": "<explanation in ENGLISH, at most 3 sentences, stating specific facts>"
}
Response rules:
- eligible=true → funds are released; false → returned to the sender.
- needsData MUST be [] (the tool loop already finished before the hearing).
- The reason MUST state 4 specific facts: (a) the recipient account's on-chain transaction count, (b) the account's AEGIS history from the MEMORY block — how many times it has transacted/been evaluated and how many times it was rejected (say "never before" if it is the first evaluation), (c) the BNB amount, (d) the GoPlus status.
- (a) and (b) are DIFFERENT numbers: (a) comes from the on-chain BscScan data, (b) from the AEGIS database MEMORY block. Never mix them, never invent them — use the numbers exactly as written in the evidence.
${TX_SOURCE_RULE}
- VIOLATION example: writing "0 on-chain transactions and the first evaluation" while MEMORY says "Transactions via AEGIS: 15x".
- DO NOT wrap the JSON in a markdown code fence.
- DO NOT add any text outside the JSON object.`;
}

// ── Shared evidence block (used by the Investigator/Advocate/Judge prompts) ─
function buildEvidenceBlock(input: LLMInput): string {
  const { sender, recipient, amountBNB, security, intel } = input;

  const goplusSection =
    security.status === "unavailable"
      ? `GoPlus Security: UNAVAILABLE (the API cannot be reached; treat as unknown, NOT safe)`
      : security.status === "malicious"
      ? `GoPlus Security: MALICIOUS\nFlags detected: ${security.riskFlags.join(", ")}`
      : `GoPlus Security: CLEAN (no malicious flags)\nFlags checked: ${security.riskFlags.length === 0 ? "none" : security.riskFlags.join(", ")}`;

  const bscscanSection = intel.unavailable
    ? `BscScan On-chain: UNAVAILABLE (treat as unknown, NOT safe)`
    : [
        `BscScan On-chain (BSC Testnet):`,
        txCountLine(intel),
        `  Wallet age       : ${intel.walletAgeInDays !== null ? `${intel.walletAgeInDays.toFixed(1)} days` : "unknown (the explorer provides no age data)"}`,
        `  New wallet       : ${intel.isNewWallet ? "yes" : "no"}`,
        `  Smart contract   : ${intel.isContract ? "yes" : "no"}`,
        `  BNB balance      : ${intel.balanceBNB !== null ? `${intel.balanceBNB.toFixed(6)} BNB` : "unknown"}`,
      ].join("\n");

  return `IMPORTANT CONTEXT:
- This is a TESTNET environment. A new wallet with zero or low transaction history is NORMAL and EXPECTED.
- A new testnet wallet does NOT automatically indicate malicious intent.
- GoPlus data is based on mainnet reputation. A CLEAN status from GoPlus is a strong positive signal.
- BscScan data reflects testnet activity only — most legitimate testnet wallets do have a low txCount.

EVIDENCE:
Sender address   : ${sender}
Recipient address: ${recipient}
Transfer amount  : ${amountBNB} BNB

${input.memoryContext ?? "AEGIS HISTORICAL MEMORY (INTERNAL history — NOT on-chain data):\n  This address has NEVER transacted via AEGIS before (internal history is empty). This is the first evaluation."}

${goplusSection}

${bscscanSection}`;
}

// ── JSON Parser (robust) ──────────────────────────────────────────────────────
/**
 * Parse + validate the Investigator/Judge output.
 * Throws on broken JSON / invalid fields — the caller must fail-safe REJECT.
 * Exported for the red-team suite (parser abuse).
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

  // ── needsData (tool calling) — additive field, lenient parsing ─────────────
  // If missing / not an array → treat as [] (normal case: 1 call, no tools).
  // Validating tool names against the catalog happens in the orchestrator
  // (pipeline), not in the parser — the parser deliberately does not depend on
  // the tool list.
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
  /** AEGIS historical memory text (agentMemory) — optional, injected into the prompt. */
  memoryContext?: string;
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
    // Serialized as well — an explanation must not clash with a decision call
    // in the same Ollama queue (one model, one GPU).
    const result = await withOllamaLock(async () => {
      const controller = new AbortController();
      // Short timeout for explanation — don't block pipeline
      const EXPLAIN_TIMEOUT = Math.min(config.OLLAMA_TIMEOUT_MS, 15_000);
      const timer = setTimeout(() => controller.abort(), EXPLAIN_TIMEOUT);

      const goplusSection =
        security.status === "unavailable"
          ? `GoPlus: UNAVAILABLE`
          : security.status === "malicious"
          ? `GoPlus: MALICIOUS — Flags: ${security.riskFlags.join(", ")}`
          : `GoPlus: CLEAN`;

      const bscscanSection = intel.unavailable
        ? `BscScan: UNAVAILABLE`
        : `BscScan: ${txCountLine(intel).trim()}, age=${intel.walletAgeInDays !== null ? `${intel.walletAgeInDays.toFixed(1)} days` : "?"}, balance=${intel.balanceBNB !== null ? `${intel.balanceBNB.toFixed(4)} BNB` : "?"}`;

      const prompt = `You are the AEGIS AI Oracle. Our security system has DECIDED to REJECT this transfer based on a deterministic rule.

THE DECISION IS ALREADY FINAL: REJECT (you cannot change this)
Technical reason: ${ruleContext}

Transaction data:
- Recipient address: ${recipient}
- Amount: ${amountBNB} BNB
- ${goplusSection}
- ${bscscanSection}

${ctx.memoryContext ?? "AEGIS HISTORICAL MEMORY (INTERNAL history — NOT on-chain data):\n  This address has NEVER transacted via AEGIS before (internal history is empty). This is the first evaluation."}

YOUR TASK: Write a clear, easy-to-understand explanation IN ENGLISH that STATES SPECIFIC FACTS: (a) the recipient account's on-chain transaction count, (b) the account's AEGIS history from the MEMORY block (how many times it has transacted/been evaluated, how many times it was rejected), (c) the BNB amount, (d) the security status. At most 3 sentences.
${TX_SOURCE_RULE}
- The MEMORY block is REAL history: if "Transactions via AEGIS: N" is N > 0, state N and never write "has never transacted via AEGIS".

GOOD examples:
- "The recipient address has 0 on-chain transactions and has never transacted via AEGIS, and it is receiving a fairly large 0.05 BNB transfer, so the funds are returned to protect the sender."
- "GoPlus detected this address as phishing even though the account has transacted via AEGIS 3 times. The funds are returned to the sender for safety."

Return ONLY a JSON string with this format:
{"reason": "the specific explanation here"}`;

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

    console.log(`[LLM]     Explanation generated: ${result.slice(0, 80)}...`);
    return result;
  } catch (err) {
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
