import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

// ── Core ──────────────────────────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL!;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS! as `0x${string}`;
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY! as `0x${string}`;

if (!RPC_URL || !CONTRACT_ADDRESS || !ORACLE_PRIVATE_KEY) {
  throw new Error("Environment variables are incomplete. Check the .env file");
}

// ── Ollama / LLM ──────────────────────────────────────────────────────────────
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";
/**
 * Timeout in ms for a single Ollama generate call. Default: 120 s.
 *
 * Budget, not a wish: qwen3:8b on a 6 GB card is PARTIALLY offloaded to CPU
 * (~4.2 GB of 5.97 GB in VRAM), which measures at roughly 5-11 tok/s. The
 * Investigator prompt alone is ~2.3k tokens and a valid JSON verdict is
 * 100-250 tokens, i.e. 20-50 s per call — a 30 s budget aborted the Investigator
 * mid-generation and the pipeline fail-safe REJECTed the escrow with a message
 * that blamed the network. The escrows themselves live for 2 h
 * (AegisVault.ESCROW_TIMEOUT), so minutes of LLM time are affordable.
 */
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 120_000);

/**
 * Timeout in ms for the hard-rule explanation call (short, user-facing text).
 * Its own budget rather than a slice of OLLAMA_TIMEOUT_MS: the old
 * `min(OLLAMA_TIMEOUT_MS, 15s)` cap was below the time the model needs to emit
 * even 200 tokens, so the explanation silently always fell back to ruleContext.
 */
const OLLAMA_EXPLAIN_TIMEOUT_MS = Number(
  process.env.OLLAMA_EXPLAIN_TIMEOUT_MS ?? 60_000
);

/**
 * Context window handed to Ollama on EVERY call (`/api/chat` AND `/api/generate`).
 *
 * It must be IDENTICAL across both endpoints on purpose: Ollama reallocates the
 * KV cache whenever `num_ctx` changes, so an agent loop that alternates between
 * a 4k and an 8k context pays a full cache reallocation per step and roughly
 * doubles the generation time on a partially-offloaded card.
 *
 * Sizing for a 6 GB card (measured on the deployment box):
 *   weights   ≈ 4.2 GB in VRAM (qwen3:8b Q4_K_M, ~5.2 GB on disk, partial CPU offload)
 *   KV cache  ≈ 147 KB/token → 8192 ctx ≈ 1.2 GB
 *   total     ≈ 5.4 GB of 5.97 GB usable
 * 8192 is the ceiling that still fits; going to 16k would push the cache to
 * ~2.4 GB and start swapping layers to CPU. The agent loop additionally caps the
 * accumulated prompt (AGENT_CONTEXT_CHAR_LIMIT) and logs a warning when
 * `prompt_eval_count` approaches this number, so a prompt that would silently
 * truncate the tool history is caught instead.
 */
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 8192);

// ── Bounded agent loop ─────────────────────────────────────────────────────────
/**
 * Use Ollama's NATIVE tool calling (`/api/chat` + `tools`) instead of the
 * legacy `needsData` JSON field.
 *
 * Default true. Set to false to fall back to the old single-round `needsData`
 * contract — the escape hatch for a model build whose tool calling is
 * unreliable. Combined with AGENT_MAX_STEPS=1 / ADVOCATE_MAX_STEPS=0 /
 * AGENT_MAX_FOLLOWUP_STEPS=0 it reproduces the pre-agent pipeline exactly
 * (4 LLM calls, one tool round, no Judge re-entry).
 */
const AGENT_NATIVE_TOOLS =
  (process.env.AGENT_NATIVE_TOOLS ?? "true").toLowerCase() !== "false";

/**
 * Tool rounds per agent run. `maxSteps = 0` means "no tools at all, exactly one
 * LLM call" — the definition the Advocate uses in regression mode.
 *
 * Total LLM calls for an agent are `maxSteps + 1`: the forced "decide now, no
 * tools" call the loop always gets after its last tool round.
 */
const AGENT_MAX_STEPS = Math.max(0, Number(process.env.AGENT_MAX_STEPS ?? 4));

/** Hard cap on tool invocations inside a single agent run (deduped). */
const AGENT_MAX_TOOL_CALLS = Math.max(
  0,
  Number(process.env.AGENT_MAX_TOOL_CALLS ?? 8)
);

/**
 * Per-run estimated cost of ONE LLM call, used only to derive
 * AGENT_TIMEOUT_MS when that variable is not set explicitly.
 *
 * 45 s against a measured ~20 s/call on a 6 GB card is ~2x headroom: a long
 * JSON verdict measured 8-20 s, and a full evidence block 3-8 s. It is a
 * budgeting constant, not a measurement.
 */
const AGENT_LLM_CALL_ESTIMATE_MS = Math.max(
  1_000,
  Number(process.env.AGENT_LLM_CALL_ESTIMATE_MS ?? 45_000)
);

/**
 * Wall-clock budget for ONE agent run, measured as the sum of the LLM
 * GENERATION time only — time spent waiting on the Ollama serialization queue
 * is deliberately excluded.
 *
 * Why it must exclude the queue: `withOllamaLock` serialises every call in the
 * process, so with N escrows in flight the Nth agent can wait minutes for its
 * turn. Counting that wait as the agent's own time made concurrent escrows
 * cascade into fail-safe REJECTs — a liveness failure that looks like a safety
 * success. The queue is a fairness problem; the timeout is a hung-model
 * problem, and only the second one may reject an escrow.
 *
 * Default is DERIVED: AGENT_LLM_CALL_ESTIMATE_MS * (maxSteps + 1), so the budget
 * always covers the worst case of the configured step count (225 s at the
 * default maxSteps=4). Set the variable explicitly to override.
 */
const AGENT_TIMEOUT_MS = (() => {
  const explicit = process.env.AGENT_TIMEOUT_MS;
  if (explicit !== undefined && explicit.trim() !== "") {
    const parsed = Number(explicit);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : AGENT_LLM_CALL_ESTIMATE_MS * (AGENT_MAX_STEPS + 1);
  }
  return AGENT_LLM_CALL_ESTIMATE_MS * (AGENT_MAX_STEPS + 1);
})();

/**
 * Total characters of accumulated prompt (system + context + tool results) an
 * agent run may carry. Above this the oldest tool results are dropped, never the
 * evidence block: a truncated tool history is a stated lower bound, a truncated
 * evidence block would hide the facts the decision is based on.
 */
const AGENT_CONTEXT_CHAR_LIMIT = Math.max(
  2_000,
  Number(process.env.AGENT_CONTEXT_CHAR_LIMIT ?? 12_000)
);

/**
 * Global per-escrow ceiling on LLM calls, enforced by `LlmBudget` BEFORE the
 * request is issued. Exceeding it is a fail-safe, never a RELEASE.
 *
 * Worst case with the shipped defaults is exactly this number:
 *   Investigator  (maxSteps 4 + 1 forced) = 5
 *   Advocate      (maxSteps 2 + 1 forced) = 3
 *   Judge #1                                = 1
 *   focused re-pass (maxSteps 1 + 1 forced) = 2
 *   Judge #2                                = 1
 *                                        total = 12
 * The re-pass pair is reserved as ONE atomic block of `repass + Judge #2`
 * (`evidenceRequestReservation()`), not as the re-pass alone — a short reservation
 * there is exactly how the last call of an escrow ends up running for free. An
 * ordinary hearing is cheaper: the re-pass runs only when the Judge asked for it.
 *
 * Not counted here: the hard-rule explanation call (it only writes the reason for an
 * already-final REJECT and falls back to the deterministic text) and lesson
 * generation (after the decision, fire-and-forget). Neither can change an outcome,
 * so counting them would only take allowance away from the debate.
 */
const AGENT_MAX_LLM_CALLS = Math.max(
  1,
  Number(process.env.AGENT_MAX_LLM_CALLS ?? 12)
);

/**
 * Step budget for the focused Investigator pass that runs after the Judge asks for
 * evidence. 0 DISABLES the Judge's request_evidence action being granted (a request
 * is then turned into an immediate ruling without the extra round) and therefore
 * the whole re-entry path — that is what regression mode uses.
 *
 * Worst case for the path this allows: `AGENT_MAX_FOLLOWUP_STEPS + 1` re-pass calls
 * plus 1 for Judge #2, reserved together. Derived by `focusedRepassLedgerSize()` /
 * `evidenceRequestReservation()` rather than written out, so raising this moves the
 * ceiling arithmetic with it.
 */
const AGENT_MAX_FOLLOWUP_STEPS = Math.max(
  0,
  Number(process.env.AGENT_MAX_FOLLOWUP_STEPS ?? 1)
);

/** Tool rounds for the Advocate. It argues the OPPOSITE position, so it gets a
 *  deliberately smaller budget than the Investigator; 0 = one call, no tools. */
const ADVOCATE_MAX_STEPS = Math.max(
  0,
  Number(process.env.ADVOCATE_MAX_STEPS ?? 2)
);

/**
 * Maximum number of NEW addresses a single agent run may add to the queryable
 * set (from tool results).
 *
 * Bounded on purpose: an unbounded `discovered` set turns one agent run into a
 * scanning oracle — a prompt injection that names thousands of "check these
 * addresses" would otherwise turn a single escrow into thousands of GoPlus
 * queries against a free-tier API. 5 is enough to chase a dusting pattern
 * (recipient → last 10 counterparties) without that risk.
 */
const AGENT_MAX_DISCOVERED_ADDRESSES = Math.max(
  0,
  Number(process.env.AGENT_MAX_DISCOVERED_ADDRESSES ?? 5)
);

/**
 * Agent-written lessons memory. Off = the `agent_lessons` table is still read by
 * `recall_lessons` but no LLM call is made to WRITE a lesson.
 *
 * A separate switch because lesson generation is the one LLM call in the system
 * that is not on the decision path, and it still competes for the single GPU.
 */
const AGENT_LESSONS_ENABLED =
  (process.env.AGENT_LESSONS_ENABLED ?? "true").toLowerCase() !== "false";

/**
 * Confidence threshold for LLM decisions.
 * This is a SYSTEM DESIGN HEURISTIC, not a calibrated statistical probability.
 * Range: 0.0 – 1.0. Default: 0.80
 * If LLM confidence < threshold → fail-safe REJECT.
 */
const LLM_CONFIDENCE_THRESHOLD = Number(
  process.env.LLM_CONFIDENCE_THRESHOLD ?? 0.80
);

/**
 * Lower bound of the human-in-the-loop grey zone.
 * conf < HUMAN_CONF_MIN → fail-safe REJECT (too unsure to ask a human).
 * HUMAN_CONF_MIN <= conf < LLM_CONFIDENCE_THRESHOLD → hold, request 1 human vote.
 * conf >= threshold → AI may decide (unless the hearing leans the other way → still human).
 * Default: 0.55
 */
const HUMAN_CONF_MIN = Number(process.env.HUMAN_CONF_MIN ?? 0.55);

/**
 * Enable human-in-the-loop escalation. "false" → revert to the old behaviour
 * (conf < threshold goes straight to fail-safe REJECT, without a human vote).
 */
const HUMAN_ESCALATION_ENABLED =
  (process.env.HUMAN_ESCALATION_ENABLED ?? "true").toLowerCase() !== "false";

// ── GoPlus ────────────────────────────────────────────────────────────────────
const GOPLUS_API_URL =
  process.env.GOPLUS_API_URL ?? "https://api.gopluslabs.io/api/v1";
/** Optional – set GOPLUS_API_KEY in .env for authenticated requests. */
const GOPLUS_API_KEY = process.env.GOPLUS_API_KEY ?? "";
const GOPLUS_TIMEOUT_MS = Number(process.env.GOPLUS_TIMEOUT_MS ?? 5_000);

/**
 * Chains queried for address reputation.
 *
 * Why two chains: the escrow lives on BSC **Testnet** (97), but GoPlus's threat
 * intelligence is built from **mainnet** (56) activity. Querying only 56 means
 * every testnet address answers "CLEAN" and the signal carries almost no
 * information; querying only 97 means GoPlus has almost no data for chain 97.
 * Querying both and merging gives: mainnet reputation for addresses seen on
 * mainnet, plus any testnet-local flags.
 *
 * An address is reported malicious when EITHER chain reports a flag.
 */
const GOPLUS_CHAIN_IDS = (process.env.GOPLUS_CHAIN_IDS ?? "56,97")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");

/**
 * DEMO/TESTING ONLY — simulates malicious flags for a USER-SUPPLIED address list.
 *
 * SECURITY POSTURE: this is OFF by default and there is NO built-in list of fake
 * addresses. A hardcoded demo list made aegisChecker report fabricated
 * "GoPlus detections" that never came from GoPlus — unacceptable for an
 * auditable security system, because the DB/UI would present simulated output as
 * real threat intelligence.
 *
 * If you turn it on you MUST supply the addresses yourself:
 *   GOPLUS_SIMULATE=true
 *   GOPLUS_SIMULATED_ADDRESSES=0x<mainnet address with a real GoPlus hit>,...
 * Every simulated hit is tagged `simulated: true` in the result and logged with
 * a loud warning so it can never be mistaken for real intelligence.
 */
const GOPLUS_SIMULATE =
  (process.env.GOPLUS_SIMULATE ?? "false").toLowerCase() === "true";

/**
 * Addresses (comma-separated) reported as malicious while simulation is on.
 * With simulation OFF this list is ignored entirely.
 */
const GOPLUS_SIMULATED_ADDRESSES = process.env.GOPLUS_SIMULATED_ADDRESSES ?? "";

// ── BscScan ───────────────────────────────────────────────────────────────────
/** BNB Smart Chain TESTNET (Chain ID 97) */
const BSCSCAN_API_URL =
  process.env.BSCSCAN_API_URL ?? "https://api-testnet.bscscan.com/api";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY ?? "";
const BSCSCAN_TIMEOUT_MS = Number(process.env.BSCSCAN_TIMEOUT_MS ?? 8_000);

// ── Rule Engine Security Parameters ──────────────────────────────────────────
// NOTE: the age/activity thresholds that used to live here (NEW_WALLET_DAYS,
// LOW_TX_COUNT_THRESHOLD, MEDIUM_WALLET_DAYS, MEDIUM_TX_THRESHOLD) were REMOVED.
// They were inputs to rules that read `walletAgeInDays` and an explorer tx list —
// neither exists on BSC testnet, where the explorer API is deprecated, so the
// rules could never fire. Novelty is now derived from RPC facts (nonce + balance)
// and AEGIS escrow history from the on-chain vault log, so a tunable age
// threshold would be a knob that controls nothing.

/**
 * Transfer amount threshold (BNB) for the "significant transfer" classification.
 * Default: 0.1 BNB.
 *
 * RAISED from 0.01 to 0.1. Rules 2 (novel account) and 7 (zero balance) now only
 * raise a NEEDS_LLM signal instead of rejecting, so the threshold cannot block an
 * escrow by itself — but a "significant" transfer must still mean more than dust. At
 * 0.01 BNB it fired on amounts that are pure testnet noise, which flooded the
 * Investigator prompt with high-severity context for routine transfers; 0.1 BNB is
 * the smallest value that is actually worth a second look. NOT a universal
 * definition of a large transfer — it is an AEGIS review trigger.
 */
const SIGNIFICANT_TRANSFER_BNB = Number(
  process.env.SIGNIFICANT_TRANSFER_BNB ?? 0.1
);

/**
 * Threshold for a "very large" transfer (BNB) — Rule 9.
 * Transfer >= this value to any address -> escalate to the LLM even if other rules pass.
 * Default: 1 BNB.
 */
const VERY_LARGE_TRANSFER_BNB = Number(
  process.env.VERY_LARGE_TRANSFER_BNB ?? 1.0
);

/**
 * Visible hex characters, counted after `0x`, that a poisoned address copies from
 * the front of a real counterparty (rule 14).
 *
 * Block explorers and wallets show `0x1234…abcd`: a user comparing the visible head
 * and tail sees a match, while the middle 32 hex chars (128 bits) are attacker
 * controlled. 4+4 is the shape that is actually visible in a truncated address, so
 * 4/4 is the honest default; raising them makes the rule narrower.
 */
const POISONING_PREFIX_CHARS = Math.max(
  1,
  Number(process.env.POISONING_PREFIX_CHARS ?? 4)
);

/**
 * Visible hex characters copied from the END of a real counterparty (rule 14).
 * Same reasoning as POISONING_PREFIX_CHARS — see there.
 */
const POISONING_SUFFIX_CHARS = Math.max(
  1,
  Number(process.env.POISONING_SUFFIX_CHARS ?? 4)
);

/**
 * Escrows from ONE sender inside SENDER_BURST_WINDOW_MIN that look like a drain
 * (rule 18). Default: 3.
 *
 * A compromised key drains by opening many escrows in minutes; the AEGIS history of a
 * single sender is enough to see it, and it is the cheapest possible signal (one
 * indexed count).
 */
const SENDER_BURST_COUNT = Math.max(
  1,
  Number(process.env.SENDER_BURST_COUNT ?? 3)
);

/**
 * Length of the sender-burst window in minutes (rule 18). Default: 10.
 */
const SENDER_BURST_WINDOW_MIN = Math.max(
  1,
  Number(process.env.SENDER_BURST_WINDOW_MIN ?? 10)
);

/**
 * Local denylist (GoPlus-independent) — see `denylist.ts`.
 * Relative paths resolve against the process cwd, i.e. `backend/` under npm.
 */
const DENYLIST_PATH = process.env.DENYLIST_PATH ?? "./data/denylist.json";

/**
 * Total block budget for one vault-history scan, counted back from the chain
 * head. The scan starts at the vault's deploy block when that is inside the
 * budget, otherwise this many blocks back. Whatever could not be scanned is
 * reported as `windowLimited` so a truncated count is never read as complete.
 *
 * On BSC testnet the budget IS the history: no public node there serves
 * historical `eth_getCode`, so the deploy block cannot be resolved and the scan
 * is always anchored at the floor. 500 000 blocks ≈ 25 chunked round-trips per
 * direction, and the ranges are memoised across evaluations.
 */
const VAULT_SCAN_LOOKBACK_BLOCKS = Number(
  process.env.VAULT_SCAN_LOOKBACK_BLOCKS ?? 500_000
);

/**
 * Chunk size for `eth_getLogs`, in blocks.
 *
 * Public BSC testnet nodes hard-cap a single log request at 50 000 blocks
 * ("exceed maximum block range"), and they reject a wide request instead of
 * truncating it. Without chunking, any scan wider than the cap fails outright
 * and the whole vault history degrades to `unavailable` — which is exactly what
 * happened before this parameter existed. Chunks that are still refused are
 * split in half recursively down to VAULT_LOG_MIN_CHUNK_BLOCKS.
 */
const VAULT_LOG_CHUNK_BLOCKS = Number(
  process.env.VAULT_LOG_CHUNK_BLOCKS ?? 20_000
);

/**
 * How many `eth_getLogs` chunks to have in flight at once.
 *
 * The vault history has to be walked backwards chunk by chunk (public testnet
 * nodes cap a single request at ~50 000 blocks and have no historical state, so
 * there is no deploy block to anchor the scan on). Firing the chunks in parallel
 * keeps that walk to roughly one round-trip instead of one per chunk.
 */
const VAULT_LOG_CONCURRENCY = Number(process.env.VAULT_LOG_CONCURRENCY ?? 6);

/** Floor for the recursive chunk split — below this we give up on the chunk. */
const VAULT_LOG_MIN_CHUNK_BLOCKS = Number(
  process.env.VAULT_LOG_MIN_CHUNK_BLOCKS ?? 500
);

/**
 * Distinct on-chain senders that turn a recipient into a "pooling hub" — Rule 10.
 *
 * Read from the AegisVault event log via RPC (real data, free). Many-to-one
 * funding is the signature of a collection hub worth a contextual review.
 * Default: 3
 */
const POOLING_HUB_MIN_SENDERS = Number(
  process.env.POOLING_HUB_MIN_SENDERS ?? 3
);

// ── Oracle Polling ────────────────────────────────────────────────────────────
const POLLING_INTERVAL_MS = Number(process.env.POLLING_INTERVAL_MS ?? 8_000);

// ── Viem Clients ─────────────────────────────────────────────────────────────
export const account = privateKeyToAccount(ORACLE_PRIVATE_KEY);

// Explicit `any` cast to avoid non-portable deep type inference error from viem.
// This is safe: usage is fully typed at the call sites via the ABI.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const publicClient: PublicClient<any, any> = createPublicClient({
  chain: bscTestnet,
  transport: http(RPC_URL),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const walletClient: WalletClient<any, any, any> = createWalletClient({
  account,
  chain: bscTestnet,
  transport: http(RPC_URL),
});

// ── Exported Config ────────────────────────────────────────────────────────────
export const config = {
  CONTRACT_ADDRESS,
  OLLAMA_URL,
  OLLAMA_MODEL,
  OLLAMA_TIMEOUT_MS,
  OLLAMA_EXPLAIN_TIMEOUT_MS,
  OLLAMA_NUM_CTX,
  LLM_CONFIDENCE_THRESHOLD,
  HUMAN_CONF_MIN,
  HUMAN_ESCALATION_ENABLED,
  AGENT_NATIVE_TOOLS,
  AGENT_MAX_STEPS,
  AGENT_MAX_TOOL_CALLS,
  AGENT_LLM_CALL_ESTIMATE_MS,
  AGENT_TIMEOUT_MS,
  AGENT_CONTEXT_CHAR_LIMIT,
  AGENT_MAX_LLM_CALLS,
  AGENT_MAX_FOLLOWUP_STEPS,
  ADVOCATE_MAX_STEPS,
  AGENT_MAX_DISCOVERED_ADDRESSES,
  AGENT_LESSONS_ENABLED,
  GOPLUS_API_URL,
  GOPLUS_API_KEY,
  GOPLUS_TIMEOUT_MS,
  GOPLUS_SIMULATE,
  GOPLUS_SIMULATED_ADDRESSES,
  GOPLUS_CHAIN_IDS,
  BSCSCAN_API_URL,
  BSCSCAN_API_KEY,
  BSCSCAN_TIMEOUT_MS,
  VAULT_SCAN_LOOKBACK_BLOCKS,
  VAULT_LOG_CHUNK_BLOCKS,
  VAULT_LOG_MIN_CHUNK_BLOCKS,
  VAULT_LOG_CONCURRENCY,
  SIGNIFICANT_TRANSFER_BNB,
  VERY_LARGE_TRANSFER_BNB,
  POISONING_PREFIX_CHARS,
  POISONING_SUFFIX_CHARS,
  SENDER_BURST_COUNT,
  SENDER_BURST_WINDOW_MIN,
  DENYLIST_PATH,
  POOLING_HUB_MIN_SENDERS,
  POLLING_INTERVAL_MS,
} as const;
