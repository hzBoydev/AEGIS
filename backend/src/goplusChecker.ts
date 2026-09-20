import { config } from "./config.js";

// ── DEMO/TESTING SIMULATION ────────────────────────────────────────────────────
/**
 * FOR HACKATHON DEMO PURPOSES ONLY.
 *
 * GoPlus builds its threat intelligence from real-world mainnet activity.
 * Freshly generated testnet addresses (e.g. from `cast wallet new`) will
 * NEVER appear in GoPlus's database - there's no malicious history to detect.
 *
 * This simulation set lets us DEMONSTRATE the GoPlus security layer working
 * end-to-end during a live demo, without needing to find/use a real
 * known-malicious mainnet address (which would be risky and unreliable).
 *
 * In production, this block would be removed entirely - GoPlus would query
 * its real database exclusively.
 *
 * Usage: run `cast wallet new`, copy the address (lowercase), add it below,
 * then submit a transfer to that address from the frontend.
 */
const SIMULATED_MALICIOUS_ADDRESSES = new Set<string>([
  "0x101206f123f724438f5ae6009790217d38528328",
]);

function checkSimulatedMalicious(address: string): SecurityCheckResult | null {
  if (SIMULATED_MALICIOUS_ADDRESSES.has(address.toLowerCase())) {
    return {
      status: "malicious",
      riskFlags: ["phishing_activities", "blacklist_doubt"],
      source: "goplus",
      rawData: { _simulated: true, _note: "Demo simulation - not a real GoPlus response" },
    };
  }
  return null;
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface SecurityCheckResult {
  /**
   * "clean"       – GoPlus returned no malicious signals
   * "malicious"   – GoPlus flagged this address
   * "unavailable" – API timeout / error / invalid response
   *
   * IMPORTANT: "unavailable" !== "clean". Never treat API failure as safe.
   */
  status: "clean" | "malicious" | "unavailable";
  riskFlags: string[];
  source: "goplus" | "unavailable";
  rawData?: Record<string, unknown>;
}

// ── GoPlus response shape (partial) ──────────────────────────────────────────
interface GoPlusAddressResult {
  is_blacklisted?: string | number;
  malicious_address?: string | number;
  phishing_activities?: string | number;
  blacklist_doubt?: string | number;
  honeypot_related_address?: string | number;
  fake_token?: string | number;
  stealing_attack?: string | number;
  mixer?: string | number;
  darkweb_transactions?: string | number;
  sanctioned?: string | number;
  gas_abuse?: string | number;
  // Additional flags returned by GoPlus /address_security/ endpoint
  blackmail_activities?: string | number;
  cybercrime?: string | number;
  financial_crime?: string | number;
  money_laundering?: string | number;
  fake_kyc?: string | number;
  malicious_mining_activities?: string | number;
  data_source?: string;
  [key: string]: unknown;
}

interface GoPlusResponse {
  code: number;
  message: string;
  result?: Record<string, GoPlusAddressResult>;
}

/**
 * Flags yang jika bernilai "1" / 1 dianggap malicious signal yang jelas.
 */
const MALICIOUS_FLAGS: (keyof GoPlusAddressResult)[] = [
  "is_blacklisted",
  "malicious_address",
  "phishing_activities",
  "blacklist_doubt",
  "honeypot_related_address",
  "fake_token",
  "stealing_attack",
  "mixer",
  "darkweb_transactions",
  "sanctioned",
  "gas_abuse",
  // Additional flags from GoPlus /address_security/ endpoint
  "blackmail_activities",
  "cybercrime",
  "financial_crime",
  "money_laundering",
  "fake_kyc",
  "malicious_mining_activities",
];

/**
 * Known flag keys returned by GoPlus /address_security/ endpoint.
 * Used to detect flat format: flags are directly in result, no address key.
 */
const KNOWN_FLAG_KEYS = new Set(MALICIOUS_FLAGS as string[]);

function isFlagSet(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function extractRiskFlags(result: GoPlusAddressResult): string[] {
  const flags: string[] = [];
  for (const flag of MALICIOUS_FLAGS) {
    if (isFlagSet(result[flag as string])) {
      flags.push(flag as string);
    }
  }
  return flags;
}

// ── Main function ─────────────────────────────────────────────────────────────
/**
 * Query GoPlus security intelligence for a given EVM address.
 *
 * Chain ID 56 = BSC Mainnet.
 * GoPlus address security uses mainnet data for address reputation.
 * Testnet-only addresses may return empty results (treated as "clean").
 *
 * @param address  EVM address (0x...)
 * @param chainId  GoPlus chain ID. Default "56" (BSC Mainnet).
 */
export async function checkAddressSecurity(
  address: string,
  chainId: string = "56"
): Promise<SecurityCheckResult> {
  // ── Check demo simulation first (see note above) ──────────────────────────
  const simulated = checkSimulatedMalicious(address);
  if (simulated) {
    console.log(`[GoPlus] ⚠️  DEMO SIMULATION triggered for ${address} (not a real GoPlus lookup)`);
    return simulated;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort("GoPlus request timeout"),
    config.GOPLUS_TIMEOUT_MS
  );

  const url = new URL(
    `${config.GOPLUS_API_URL}/address_security/${address.toLowerCase()}`
  );
  url.searchParams.set("chain_id", chainId);

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (config.GOPLUS_API_KEY) {
    headers["Authorization"] = config.GOPLUS_API_KEY;
  }

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    clearTimeout(timer);

    // ── HTTP error ────────────────────────────────────────────────────────────
    if (!response.ok) {
      console.warn(
        `[GoPlus] HTTP ${response.status} ${response.statusText} for ${address}`
      );
      return unavailable();
    }

    // ── Parse JSON ────────────────────────────────────────────────────────────
    let data: GoPlusResponse;
    try {
      data = (await response.json()) as GoPlusResponse;
    } catch {
      console.warn(`[GoPlus] Malformed JSON response for ${address}`);
      return unavailable();
    }

    // ── API-level error ───────────────────────────────────────────────────────
    if (data.code !== 1) {
      console.warn(
        `[GoPlus] API error code=${data.code} message="${data.message}" for ${address}`
      );
      return unavailable();
    }

    // ── Missing result ────────────────────────────────────────────────────────
    if (!data.result) {
      console.warn(`[GoPlus] Missing result field for ${address}`);
      return unavailable();
    }

    const addrKey = address.toLowerCase();
    const resultKeys = Object.keys(data.result);

    // ── Detect response format ────────────────────────────────────────────────
    // GoPlus /address_security/ returns flags FLAT directly in `result`:
    //   result = { blacklist_doubt: 1, stealing_attack: 1, ... }
    //
    // Some older/token APIs nest flags under the address key:
    //   result = { 0xabc...: { blacklist_doubt: 1, ... } }
    //
    // Detect flat format: if the first key is a known flag name, result IS the addrResult.
    const isFlat =
      resultKeys.length > 0 && KNOWN_FLAG_KEYS.has(resultKeys[0]!);

    const addrResult: GoPlusAddressResult = isFlat
      ? (data.result as unknown as GoPlusAddressResult)    // flat format ✓
      : (data.result[addrKey] ??                            // nested by address
        (resultKeys.length > 0 ? data.result[resultKeys[0]!]! : {}));

    // ── Extract flags ─────────────────────────────────────────────────────────
    const riskFlags = extractRiskFlags(addrResult);
    const isMalicious = riskFlags.length > 0;

    return {
      status: isMalicious ? "malicious" : "clean",
      riskFlags,
      source: "goplus",
      rawData: addrResult as Record<string, unknown>,
    };
  } catch (err: unknown) {
    clearTimeout(timer);

    const isAbort =
      err instanceof Error && err.name === "AbortError";
    const isTimeout = typeof err === "string" && err.includes("timeout");

    if (isAbort || isTimeout) {
      console.warn(`[GoPlus] Timeout after ${config.GOPLUS_TIMEOUT_MS}ms for ${address}`);
    } else {
      console.warn(`[GoPlus] Network error for ${address}:`, err);
    }

    return unavailable();
  }
}

function unavailable(): SecurityCheckResult {
  return { status: "unavailable", riskFlags: [], source: "unavailable" };
}
