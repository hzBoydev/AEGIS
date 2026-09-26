import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_ADDRESS_0, TEST_KEY_0 } from "./constants.js";

// Config dievaluasi saat module load — setiap test me-load ulang modulnya
// dengan env yang berbeda (vi.resetModules + dynamic import).
const TOUCHED_KEYS = [
  "RPC_URL",
  "CONTRACT_ADDRESS",
  "ORACLE_PRIVATE_KEY",
  "SIGNIFICANT_TRANSFER_BNB",
  "HUMAN_CONF_MIN",
  "LLM_CONFIDENCE_THRESHOLD",
  "GOPLUS_SIMULATE",
  "PORT",
] as const;

let snapshot: Record<string, string | undefined>;

beforeEach(() => {
  snapshot = {};
  for (const key of TOUCHED_KEYS) snapshot[key] = process.env[key];
});

afterEach(() => {
  for (const key of TOUCHED_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
  vi.resetModules();
});

async function loadConfig(): Promise<any> {
  vi.resetModules();
  const mod = await import("../src/config.js");
  return mod;
}

describe("config — validasi fail-fast", () => {
  it("menerima konfigurasi default yang valid", async () => {
    process.env.SIGNIFICANT_TRANSFER_BNB = "0.01";
    const { config } = await loadConfig();
    expect(config.PORT).toBe(3001);
    expect(config.GOPLUS_SIMULATE).toBe(false);
    expect(config.SIGNIFICANT_TRANSFER_BNB).toBeCloseTo(0.01);
    expect(config.RETRY_MAX_ATTEMPTS).toBe(3);
  });

  it("env numerik non-angka DITOLAK (bukan jadi NaN diam-diam)", async () => {
    process.env.SIGNIFICANT_TRANSFER_BNB = "abc";
    await expect(loadConfig()).rejects.toThrow(/SIGNIFICANT_TRANSFER_BNB/);
  });

  it("POLLING_INTERVAL_MS=abc ditolak (mencegah hot-loop)", async () => {
    process.env.POLLING_INTERVAL_MS = "abc";
    await expect(loadConfig()).rejects.toThrow(/POLLING_INTERVAL_MS/);
    delete process.env.POLLING_INTERVAL_MS;
  });

  it("private key tidak valid ditolak", async () => {
    process.env.ORACLE_PRIVATE_KEY = "0x1234";
    await expect(loadConfig()).rejects.toThrow(/ORACLE_PRIVATE_KEY/);
    process.env.ORACLE_PRIVATE_KEY = TEST_KEY_0;
  });

  it("alamat kontrak tidak valid ditolak", async () => {
    process.env.CONTRACT_ADDRESS = "0xnotanaddress";
    await expect(loadConfig()).rejects.toThrow(/CONTRACT_ADDRESS/);
    process.env.CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  });

  it("RPC_URL wajib dan harus http(s)", async () => {
    // "" = dianggap tidak di-set (dotenv juga tidak menimpa key yang sudah ada)
    process.env.RPC_URL = "";
    await expect(loadConfig()).rejects.toThrow(/RPC_URL/);
    process.env.RPC_URL = "ftp://example.com";
    await expect(loadConfig()).rejects.toThrow(/RPC_URL/);
    process.env.RPC_URL = "http://127.0.0.1:8545";
  });

  it("HUMAN_CONF_MIN > LLM_CONFIDENCE_THRESHOLD ditolak", async () => {
    process.env.HUMAN_CONF_MIN = "0.95";
    process.env.LLM_CONFIDENCE_THRESHOLD = "0.8";
    await expect(loadConfig()).rejects.toThrow(/HUMAN_CONF_MIN/);
    process.env.HUMAN_CONF_MIN = "0.55";
    process.env.LLM_CONFIDENCE_THRESHOLD = "0.8";
  });

  it("REVIEWER_ADDRESSES berisi address rusak → ditolak", async () => {
    process.env.REVIEWER_ADDRESSES = `${TEST_ADDRESS_0},bukan-address`;
    await expect(loadConfig()).rejects.toThrow(/REVIEWER_ADDRESSES/);
    process.env.REVIEWER_ADDRESSES = TEST_ADDRESS_0;
  });
});

describe("config — parsing boolean", () => {
  it.each([
    ["true", true],
    ["false", false],
    ["1", true],
    ["0", false],
    ["no", false],
    ["off", false],
  ])("GOPLUS_SIMULATE=%s → %s", async (raw, expected) => {
    process.env.GOPLUS_SIMULATE = raw;
    const { config } = await loadConfig();
    expect(config.GOPLUS_SIMULATE).toBe(expected);
  });
});
