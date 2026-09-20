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
  throw new Error("Environment variable belum lengkap. Cek file .env");
}

// ── Ollama / LLM ──────────────────────────────────────────────────────────────
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";
/** Timeout ms untuk Ollama. Default 30 s. */
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 30_000);

/**
 * Confidence threshold untuk keputusan LLM.
 * Ini adalah SYSTEM DESIGN HEURISTIC, bukan probabilitas statistik terkalibrasi.
 * Range: 0.0 – 1.0. Default: 0.80
 * Jika confidence LLM < threshold → fail-safe REJECT.
 */
const LLM_CONFIDENCE_THRESHOLD = Number(
  process.env.LLM_CONFIDENCE_THRESHOLD ?? 0.80
);

// ── GoPlus ────────────────────────────────────────────────────────────────────
const GOPLUS_API_URL =
  process.env.GOPLUS_API_URL ?? "https://api.gopluslabs.io/api/v1";
/** Opsional – set GOPLUS_API_KEY di .env untuk authenticated requests. */
const GOPLUS_API_KEY = process.env.GOPLUS_API_KEY ?? "";
const GOPLUS_TIMEOUT_MS = Number(process.env.GOPLUS_TIMEOUT_MS ?? 5_000);

// ── BscScan ───────────────────────────────────────────────────────────────────
/** BNB Smart Chain TESTNET (Chain ID 97) */
const BSCSCAN_API_URL =
  process.env.BSCSCAN_API_URL ?? "https://api-testnet.bscscan.com/api";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY ?? "";
const BSCSCAN_TIMEOUT_MS = Number(process.env.BSCSCAN_TIMEOUT_MS ?? 8_000);

// ── Rule Engine Security Parameters ──────────────────────────────────────────
/**
 * Threshold umur wallet (hari) untuk klasifikasi "wallet baru".
 * Parameter MVP/hackathon – sesuaikan untuk produksi.
 */
const NEW_WALLET_DAYS = Number(process.env.NEW_WALLET_DAYS ?? 1);

/**
 * Wallet dengan txCount <= nilai ini diklasifikasikan sebagai low-activity.
 */
const LOW_TX_COUNT_THRESHOLD = Number(process.env.LOW_TX_COUNT_THRESHOLD ?? 2);

/**
 * Threshold jumlah transfer (BNB) untuk klasifikasi "significant transfer".
 * Parameter MVP/hackathon. BUKAN definisi universal "transfer besar".
 * Transfer >= nilai ini ke wallet baru + low-activity → trigger REJECT.
 */
const SIGNIFICANT_TRANSFER_BNB = Number(
  process.env.SIGNIFICANT_TRANSFER_BNB ?? 0.01
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
  LLM_CONFIDENCE_THRESHOLD,
  GOPLUS_API_URL,
  GOPLUS_API_KEY,
  GOPLUS_TIMEOUT_MS,
  BSCSCAN_API_URL,
  BSCSCAN_API_KEY,
  BSCSCAN_TIMEOUT_MS,
  NEW_WALLET_DAYS,
  LOW_TX_COUNT_THRESHOLD,
  SIGNIFICANT_TRANSFER_BNB,
  POLLING_INTERVAL_MS,
} as const;
