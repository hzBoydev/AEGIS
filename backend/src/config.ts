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
/** Timeout in ms for Ollama. Default 30 s. */
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 30_000);

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
 * DEMO/TESTING ONLY — simulates malicious flags for specific addresses.
 * GoPlus has no history for freshly created testnet addresses, so for the demo
 * we need a fake list of "bad" addresses.
 * Set GOPLUS_SIMULATE=false in production → GoPlus is queried as-is.
 */
const GOPLUS_SIMULATE =
  (process.env.GOPLUS_SIMULATE ?? "true").toLowerCase() !== "false";

/**
 * Additional addresses (comma-separated) treated as malicious while simulation is on.
 * Added to the built-in demo list in goplusChecker.ts — no code edits needed.
 * Example: GOPLUS_SIMULATED_ADDRESSES=0xabc...,0xdef...
 */
const GOPLUS_SIMULATED_ADDRESSES = process.env.GOPLUS_SIMULATED_ADDRESSES ?? "";

// ── BscScan ───────────────────────────────────────────────────────────────────
/** BNB Smart Chain TESTNET (Chain ID 97) */
const BSCSCAN_API_URL =
  process.env.BSCSCAN_API_URL ?? "https://api-testnet.bscscan.com/api";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY ?? "";
const BSCSCAN_TIMEOUT_MS = Number(process.env.BSCSCAN_TIMEOUT_MS ?? 8_000);

// ── Rule Engine Security Parameters ──────────────────────────────────────────
/**
 * Wallet age threshold (in days) for the "new wallet" classification.
 * MVP/hackathon parameter – tune for production.
 */
const NEW_WALLET_DAYS = Number(process.env.NEW_WALLET_DAYS ?? 1);

/**
 * Wallets with txCount <= this value are classified as low-activity.
 */
const LOW_TX_COUNT_THRESHOLD = Number(process.env.LOW_TX_COUNT_THRESHOLD ?? 2);

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
 * Upper bound of wallet age (in days) for the "medium" category — Rule 10.
 * Wallets aged between NEW_WALLET_DAYS and this value still count as semi-new.
 * Default: 30 days.
 */
const MEDIUM_WALLET_DAYS = Number(process.env.MEDIUM_WALLET_DAYS ?? 30);

/**
 * tx threshold for medium-age wallets — Rule 10.
 * Medium-age wallets with txCount <= this value are considered low-activity.
 * Default: 10 transactions.
 */
const MEDIUM_TX_THRESHOLD = Number(process.env.MEDIUM_TX_THRESHOLD ?? 10);

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
  LLM_CONFIDENCE_THRESHOLD,
  HUMAN_CONF_MIN,
  HUMAN_ESCALATION_ENABLED,
  GOPLUS_API_URL,
  GOPLUS_API_KEY,
  GOPLUS_TIMEOUT_MS,
  GOPLUS_SIMULATE,
  GOPLUS_SIMULATED_ADDRESSES,
  BSCSCAN_API_URL,
  BSCSCAN_API_KEY,
  BSCSCAN_TIMEOUT_MS,
  NEW_WALLET_DAYS,
  LOW_TX_COUNT_THRESHOLD,
  SIGNIFICANT_TRANSFER_BNB,
  VERY_LARGE_TRANSFER_BNB,
  MEDIUM_WALLET_DAYS,
  MEDIUM_TX_THRESHOLD,
  POLLING_INTERVAL_MS,
} as const;
