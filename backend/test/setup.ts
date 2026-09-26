// Dijalankan SEBELUM test file mana pun di-import.
// Menyuntikkan env yang dibutuhkan config.ts supaya test deterministic
// dan tidak bergantung pada .env milik developer / secrets CI.
import { TEST_ADDRESS_0, TEST_KEY_0 } from "./constants.js";

process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.CONTRACT_ADDRESS ??= "0x5FbDB2315678afecb367f032d93F642f64180aa3";
process.env.ORACLE_PRIVATE_KEY ??= TEST_KEY_0;

// Parameter rule engine dipaksa ke default terdokumentasi agar ekspektasi test stabil.
process.env.SIGNIFICANT_TRANSFER_BNB = "0.01";
process.env.VERY_LARGE_TRANSFER_BNB = "1.0";
process.env.NEW_WALLET_DAYS = "1";
process.env.LOW_TX_COUNT_THRESHOLD = "2";
process.env.MEDIUM_WALLET_DAYS = "30";
process.env.MEDIUM_TX_THRESHOLD = "10";

// Jangan menyentuh database asli developer.
process.env.DB_PATH = ":memory:";

// Allowlist reviewer untuk test voteAuth.
process.env.REVIEWER_ADDRESSES = TEST_ADDRESS_0;
