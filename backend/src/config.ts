import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

// ── Env schema ────────────────────────────────────────────────────────────────
// Muat .env dulu (tanpa banner), baru validasi.
loadDotenv({ quiet: true });
// SEMUA akses process.env hidup di file ini. Setiap nilai divalidasi saat boot:
// env yang salah (typo angka → NaN, URL rusak, dll) bikin proses gagal start
// dengan pesan jelas, BUKAN diam-dimenonaktifkan saat runtime.
const boolEnv = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined) return defaultValue;
      if (typeof v === "boolean") return v;
      return !["false", "0", "no", "off"].includes(v.trim().toLowerCase());
    });

const intEnv = (defaultValue: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

const numEnv = (defaultValue: number, min: number, max: number) =>
  z.coerce.number().min(min).max(max).default(defaultValue);

const csvEnv = () =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    );

const envSchema = z
  .object({
    // ── Core ──────────────────────────────────────────────────────────────
    RPC_URL: z.url({ protocol: /^https?$/ }),
    CONTRACT_ADDRESS: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "harus address EVM 0x + 40 hex"),
    ORACLE_PRIVATE_KEY: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, "harus private key 0x + 64 hex"),
    PORT: intEnv(3001, 1, 65535),
    DB_PATH: z.string().min(1).default("aegis.db"),

    // ── Logging ───────────────────────────────────────────────────────────
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    LOG_FORMAT: z.enum(["pretty", "json"]).default("pretty"),

    // ── HTTP surface ──────────────────────────────────────────────────────
    /** Allowlist origin (pisahkan koma). Kosong = hanya localhost. */
    CORS_ORIGINS: csvEnv(),
    /** Daftar address reviewer yang boleh vote (pisahkan koma). */
    REVIEWER_ADDRESSES: csvEnv(),
    /** Token admin untuk POST /api/random yang mahal (redteam). */
    ADMIN_TOKEN: z.string().min(16).optional(),
    /** Rentang waktu sah sebuah signature vote (ms). */
    VOTE_MAX_AGE_MS: intEnv(300_000, 10_000, 3_600_000),

    // ── Ollama / LLM ──────────────────────────────────────────────────────
    OLLAMA_URL: z.url({ protocol: /^https?$/ }).default("http://localhost:11434"),
    OLLAMA_MODEL: z.string().min(1).default("qwen3:8b"),
    OLLAMA_TIMEOUT_MS: intEnv(30_000, 1_000, 600_000),
    LLM_CONFIDENCE_THRESHOLD: numEnv(0.8, 0, 1),
    HUMAN_CONF_MIN: numEnv(0.55, 0, 1),
    HUMAN_ESCALATION_ENABLED: boolEnv(true),

    // ── GoPlus ────────────────────────────────────────────────────────────
    GOPLUS_API_URL: z
      .url({ protocol: /^https?$/ })
      .default("https://api.gopluslabs.io/api/v1"),
    GOPLUS_API_KEY: z.string().default(""),
    GOPLUS_TIMEOUT_MS: intEnv(5_000, 500, 60_000),
    /**
     * DEMO ONLY — flag malicious palsu untuk address tertentu.
     * Default FALSE: GoPlus dipanggil apa adanya. Set true hanya untuk demo.
     */
    GOPLUS_SIMULATE: boolEnv(false),
    GOPLUS_SIMULATED_ADDRESSES: csvEnv(),

    // ── BscScan ───────────────────────────────────────────────────────────
    BSCSCAN_API_URL: z
      .url({ protocol: /^https?$/ })
      .default("https://api-testnet.bscscan.com/api"),
    BSCSCAN_API_KEY: z.string().default(""),
    BSCSCAN_TIMEOUT_MS: intEnv(8_000, 500, 60_000),

    // ── Rule engine parameters ────────────────────────────────────────────
    NEW_WALLET_DAYS: numEnv(1, 0, 36_500),
    LOW_TX_COUNT_THRESHOLD: intEnv(2, 0, 1_000_000),
    SIGNIFICANT_TRANSFER_BNB: numEnv(0.01, 0, 1_000_000),
    VERY_LARGE_TRANSFER_BNB: numEnv(1.0, 0, 1_000_000),
    MEDIUM_WALLET_DAYS: numEnv(30, 0, 36_500),
    MEDIUM_TX_THRESHOLD: intEnv(10, 0, 1_000_000),

    // ── Oracle polling / retry ────────────────────────────────────────────
    POLLING_INTERVAL_MS: intEnv(8_000, 1_000, 3_600_000),
    /** Berapa kali escrow yang gagal boleh diulang sebelum ditahan permanen. */
    RETRY_MAX_ATTEMPTS: intEnv(3, 0, 10),
    /** Jeda antar percobaan ulang escrow yang gagal (ms). */
    RETRY_DELAY_MS: intEnv(30_000, 1_000, 3_600_000),
  })
  .superRefine((val, ctx) => {
    if (val.HUMAN_ESCALATION_ENABLED && val.HUMAN_CONF_MIN > val.LLM_CONFIDENCE_THRESHOLD) {
      ctx.addIssue({
        code: "custom",
        path: ["HUMAN_CONF_MIN"],
        message:
          `HUMAN_CONF_MIN (${val.HUMAN_CONF_MIN}) harus <= ` +
          `LLM_CONFIDENCE_THRESHOLD (${val.LLM_CONFIDENCE_THRESHOLD})`,
      });
    }
    if (val.REVIEWER_ADDRESSES.length > 0) {
      for (const addr of val.REVIEWER_ADDRESSES) {
        if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
          ctx.addIssue({
            code: "custom",
            path: ["REVIEWER_ADDRESSES"],
            message: `address tidak valid: ${addr}`,
          });
        }
      }
    }
  });

/** Buang string kosong supaya `.default()` menang (env = "" dianggap tidak di-set). */
function cleanEnv(raw: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

function loadEnv(): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(cleanEnv(process.env));
  if (result.success) return result.data;

  const lines = result.error.issues.map(
    (issue) => `  • ${issue.path.join(".") || "(root)"}: ${issue.message}`
  );
  throw new Error(
    `Konfigurasi .env tidak valid:\n${lines.join("\n")}\n` +
      `Lihat backend/.env.example untuk format yang benar.`
  );
}

const env = loadEnv();

// ── Derived values ────────────────────────────────────────────────────────────
const CONTRACT_ADDRESS = env.CONTRACT_ADDRESS as `0x${string}`;
const ORACLE_PRIVATE_KEY = env.ORACLE_PRIVATE_KEY as `0x${string}`;

/** Allowlist origin; selalu menyertakan origin lokal frontend. */
const CORS_ORIGINS =
  env.CORS_ORIGINS.length > 0
    ? env.CORS_ORIGINS
    : ["http://localhost:3000", "http://127.0.0.1:3000"];

/** Address reviewer yang diizinkan vote (lowercase). */
const REVIEWER_ADDRESSES = env.REVIEWER_ADDRESSES.map((a) => a.toLowerCase());

// ── Viem clients ──────────────────────────────────────────────────────────────
export const account = privateKeyToAccount(ORACLE_PRIVATE_KEY);

// Explicit `any` cast to avoid non-portable deep type inference error from viem.
// This is safe: usage is fully typed at the call sites via the ABI.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const publicClient: PublicClient<any, any> = createPublicClient({
  chain: bscTestnet,
  transport: http(env.RPC_URL),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const walletClient: WalletClient<any, any, any> = createWalletClient({
  account,
  chain: bscTestnet,
  transport: http(env.RPC_URL),
});

// ── Exported Config ───────────────────────────────────────────────────────────
export const config = {
  PORT: env.PORT,
  DB_PATH: env.DB_PATH,
  LOG_LEVEL: env.LOG_LEVEL,
  LOG_FORMAT: env.LOG_FORMAT,
  CORS_ORIGINS,
  REVIEWER_ADDRESSES,
  ADMIN_TOKEN: env.ADMIN_TOKEN,
  VOTE_MAX_AGE_MS: env.VOTE_MAX_AGE_MS,
  CONTRACT_ADDRESS,
  OLLAMA_URL: env.OLLAMA_URL,
  OLLAMA_MODEL: env.OLLAMA_MODEL,
  OLLAMA_TIMEOUT_MS: env.OLLAMA_TIMEOUT_MS,
  LLM_CONFIDENCE_THRESHOLD: env.LLM_CONFIDENCE_THRESHOLD,
  HUMAN_CONF_MIN: env.HUMAN_CONF_MIN,
  HUMAN_ESCALATION_ENABLED: env.HUMAN_ESCALATION_ENABLED,
  GOPLUS_API_URL: env.GOPLUS_API_URL,
  GOPLUS_API_KEY: env.GOPLUS_API_KEY,
  GOPLUS_TIMEOUT_MS: env.GOPLUS_TIMEOUT_MS,
  GOPLUS_SIMULATE: env.GOPLUS_SIMULATE,
  GOPLUS_SIMULATED_ADDRESSES: env.GOPLUS_SIMULATED_ADDRESSES,
  BSCSCAN_API_URL: env.BSCSCAN_API_URL,
  BSCSCAN_API_KEY: env.BSCSCAN_API_KEY,
  BSCSCAN_TIMEOUT_MS: env.BSCSCAN_TIMEOUT_MS,
  NEW_WALLET_DAYS: env.NEW_WALLET_DAYS,
  LOW_TX_COUNT_THRESHOLD: env.LOW_TX_COUNT_THRESHOLD,
  SIGNIFICANT_TRANSFER_BNB: env.SIGNIFICANT_TRANSFER_BNB,
  VERY_LARGE_TRANSFER_BNB: env.VERY_LARGE_TRANSFER_BNB,
  MEDIUM_WALLET_DAYS: env.MEDIUM_WALLET_DAYS,
  MEDIUM_TX_THRESHOLD: env.MEDIUM_TX_THRESHOLD,
  POLLING_INTERVAL_MS: env.POLLING_INTERVAL_MS,
  RETRY_MAX_ATTEMPTS: env.RETRY_MAX_ATTEMPTS,
  RETRY_DELAY_MS: env.RETRY_DELAY_MS,
} as const;
