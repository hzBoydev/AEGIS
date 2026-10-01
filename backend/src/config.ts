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
 * MVP/hackathon parameter. NOT a universal definition of a "large transfer".
 * Transfer >= this value to a new + low-activity wallet → trigger REJECT.
 */
const SIGNIFICANT_TRANSFER_BNB = Number(
  process.env.SIGNIFICANT_TRANSFER_BNB ?? 0.01
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
  LLM_CONFIDENCE_THRESHOLD,
  HUMAN_CONF_MIN,
  HUMAN_ESCALATION_ENABLED,
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
  POOLING_HUB_MIN_SENDERS,
  POLLING_INTERVAL_MS,
} as const;
