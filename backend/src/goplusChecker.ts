import { config } from "./config.js";

// ── Optional demo simulation (OFF by default, no built-in fake addresses) ─────
/**
 * FOR HACKATHON DEMO PURPOSES ONLY — and OFF by default.
 *
 * GoPlus builds its threat intelligence from real-world activity. A freshly
 * generated testnet address has no history to detect, so a demo may want to
 * show the rejection path without hunting for a real malicious address.
 *
 * This module therefore NEVER invents a "malicious" verdict on its own:
 *   - there is no built-in list of fake addresses;
 *   - the list must be supplied explicitly via GOPLUS_SIMULATED_ADDRESSES;
 *   - every hit is tagged `simulated: true` and logged with a loud warning.
 *
 * With simulation OFF (the default, and the only sane production setting) the
 * verdict comes exclusively from GoPlus' own response.
 */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Chains queried for address reputation. Configurable via GOPLUS_CHAIN_IDS,
 * default "56,97": the escrow lives on BSC Testnet (97) while GoPlus' threat
 * intelligence is built on BSC Mainnet (56). Querying only one of them leaves
 * the signal almost empty; querying both and merging is strictly better.
 */
const GOPLUS_CHAIN_IDS = config.GOPLUS_CHAIN_IDS;

function buildSimulatedMaliciousSet(): Set<string> {
  const set = new Set<string>();

  const fromEnv = config.GOPLUS_SIMULATED_ADDRESSES.split(",");
  for (const raw of fromEnv) {
    const addr = raw.trim();
    if (!addr) continue;
    if (!ADDRESS_RE.test(addr)) {
      console.warn(
        `[GoPlus] ⚠️  GOPLUS_SIMULATED_ADDRESSES ignored (not a valid address): ${addr}`
      );
      continue;
    }
    set.add(addr.toLowerCase());
  }

  return set;
}

const SIMULATED_MALICIOUS_ADDRESSES = buildSimulatedMaliciousSet();

// Fail fast on a contradictory configuration: simulation ON with an empty list
// means the author expects simulated hits that can never fire.
if (config.GOPLUS_SIMULATE && SIMULATED_MALICIOUS_ADDRESSES.size === 0) {
  console.warn(
    "[GoPlus] ⚠️  GOPLUS_SIMULATE=true but GOPLUS_SIMULATED_ADDRESSES is empty — " +
      "no simulation will occur. Set the addresses explicitly or set GOPLUS_SIMULATE=false."
  );
}

function checkSimulatedMalicious(address: string): SecurityCheckResult | null {
  if (!config.GOPLUS_SIMULATE) return null;
  if (!SIMULATED_MALICIOUS_ADDRESSES.has(address.toLowerCase())) return null;
  console.warn(
    `[GoPlus] ⚠️ SIMULATED malicious verdict for ${address} — this is NOT a real GoPlus detection.`
  );
  return {
    status: "malicious",
    riskFlags: ["simulated_demo_flag"],
    hardFlags: ["simulated_demo_flag"],
    softFlags: [],
    source: "goplus",
    simulated: true,
    rawData: {
      _simulated: true,
      _note:
        "Demo simulation - not a real GoPlus response. Set GOPLUS_SIMULATE=false to disable.",
    },
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface SecurityCheckResult {
  /**
   * "clean"       – GoPlus returned no HARD malicious signals
   * "malicious"   – GoPlus flagged this address with at least one hard flag
   * "unavailable" – API timeout / error / invalid response
   *
   * IMPORTANT: "unavailable" !== "clean". Never treat API failure as safe.
   *
   * IMPORTANT 2: "clean" !== "no flags". A SOFT-only result (see `softFlags`)
   * is reported as "clean" + `softFlags`, never as "malicious": `blacklist_doubt`
   * means *suspected but unconfirmed*, and hard-REJECTing on it was one of the
   * false-positive sources this engine is being hardened against.
   */
  status: "clean" | "malicious" | "unavailable";
  /** Union of hard + soft flags. Kept as one list so memory/UI stay compatible. */
  riskFlags: string[];
  /**
   * Flags that mean "this address is malicious". Present ⟺ `status === "malicious"`
   * (the demo simulation included). Only these can drive a hard REJECT.
   */
  hardFlags: string[];
  /**
   * Flags that mean "worth a second look, not a verdict": suspected-but-unconfirmed
   * (`blacklist_doubt`), gas-token spam (`gas_abuse`), mining abuse. They inform
   * the LLM (rule 17) and never reject on their own.
   */
  softFlags: string[];
  source: "goplus" | "unavailable";
  rawData?: Record<string, unknown>;
  /**
   * True when the verdict came from the demo simulation, NOT from GoPlus.
   * Propagated so the transcript/DB can label simulated data as simulated.
   */
  simulated?: boolean;
  /** Chain(s) that reported the flags (e.g. ["56"]). */
  flaggedChains?: string[] | undefined;
  /** Chain(s) that answered successfully, regardless of the verdict. */
  queriedChains?: string[] | undefined;
  /** Chain(s) that could not be reached. Non-empty ⇒ partial coverage. */
  failedChains?: string[] | undefined;
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
  // Observed in live BSC responses — genuine threat indicators.
  number_of_malicious_contracts_created?: string | number;
  reinit?: string | number;
  fake_standard_interface?: string | number;
  data_source?: string;
  [key: string]: unknown;
}

interface GoPlusResponse {
  code: number;
  message: string;
  result?: Record<string, GoPlusAddressResult>;
}

/**
 * Flags that ARE a malicious verdict when set to "1" / 1.
 *
 * The split from SOFT_FLAGS is the single most important change in this file: a
 * hard REJECT must rest on a positively observed fact, and "suspected" / "spam"
 * are not facts about theft. Every entry below is an assertion that the address
 * itself is a thief, a drainer, a sanctioned party or an illegal finance
 * facilitator — including "number_of_malicious_contracts_created" and "reinit",
 * which are only returned for an address with a real malicious track record.
 */
export const HARD_FLAGS: (keyof GoPlusAddressResult)[] = [
  "is_blacklisted",
  "malicious_address",
  "phishing_activities",
  "honeypot_related_address",
  "fake_token",
  "stealing_attack",
  "sanctioned",
  "darkweb_transactions",
  "blackmail_activities",
  "cybercrime",
  "financial_crime",
  "money_laundering",
  "fake_kyc",
  // Live-verified fields: an address credited with deploying malicious
  // contracts, or with a reinit/clone of a known interface, is not clean.
  "number_of_malicious_contracts_created",
  "reinit",
  "fake_standard_interface",
  "mixer",
];

/**
 * Flags that are NOT a verdict: they escalate attention, they do not convict.
 *
 *  - `blacklist_doubt`          GoPlus itself says "suspected, unconfirmed".
 *  - `gas_abuse`                gas-token / spam spammer behaviour, no theft.
 *  - `malicious_mining_activities`  mining abuse, unrelated to escrow theft.
 *
 * These produce rule 17 (NEEDS_LLM) instead of a hard REJECT. Folding them into
 * the hard set is what made a wallet that merely received spam get blocked.
 */
export const SOFT_FLAGS: (keyof GoPlusAddressResult)[] = [
  "blacklist_doubt",
  "gas_abuse",
  "malicious_mining_activities",
];

/**
 * Every flag this checker extracts, hard and soft together.
 *
 * Kept for two reasons: `riskFlags` stays a single list so the DB, the memory
 * block and the UI do not need to change, and `KNOWN_FLAG_KEYS` needs the union
 * to recognise a flat GoPlus response.
 */
const MALICIOUS_FLAGS: (keyof GoPlusAddressResult)[] = [
  ...HARD_FLAGS,
  ...SOFT_FLAGS,
];

/**
 * Known flag keys returned by GoPlus /address_security/ endpoint.
 * Used to detect flat format: flags are directly in result, no address key.
 */
const KNOWN_FLAG_KEYS = new Set(MALICIOUS_FLAGS as string[]);

function isFlagSet(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

/**
 * Split the extracted flags into the two verdicts.
 *
 * A flag GoPlus returns that this build does not know about lands in
 * `riskFlags` (so it is still shown to the LLM) but in NEITHER list — an unknown
 * key must not be silently promoted into a hard REJECT, and must not be
 * silently dropped either.
 */
function classifyFlags(flags: string[]): { hardFlags: string[]; softFlags: string[] } {
  const hardSet = new Set<string>(HARD_FLAGS as string[]);
  const softSet = new Set<string>(SOFT_FLAGS as string[]);
  return {
    hardFlags: flags.filter((f) => hardSet.has(f)),
    softFlags: flags.filter((f) => softSet.has(f)),
  };
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

// ── Per-chain query ───────────────────────────────────────────────────────────
/**
 * Query GoPlus for ONE chain.
 * Resolves to { flags, raw } on success, or null when the chain is unreachable
 * (timeout / HTTP error / malformed body / API error). Never throws.
 */
async function queryChain(
  address: string,
  chainId: string
): Promise<{ flags: string[]; raw: GoPlusAddressResult } | null> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort("GoPlus request timeout"),
    config.GOPLUS_TIMEOUT_MS
  );

  const url = new URL(
    `${config.GOPLUS_API_URL}/address_security/${address.toLowerCase()}`
  );
  url.searchParams.set("chain_id", chainId);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.GOPLUS_API_KEY) {
    headers["Authorization"] = config.GOPLUS_API_KEY;
  }

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(
        `[GoPlus] chain=${chainId} HTTP ${response.status} ${response.statusText} for ${address}`
      );
      return null;
    }

    let data: GoPlusResponse;
    try {
      data = (await response.json()) as GoPlusResponse;
    } catch {
      console.warn(`[GoPlus] chain=${chainId} malformed JSON for ${address}`);
      return null;
    }

    if (data.code !== 1) {
      console.warn(
        `[GoPlus] chain=${chainId} API error code=${data.code} message="${data.message}" for ${address}`
      );
      return null;
    }

    if (!data.result) {
      console.warn(`[GoPlus] chain=${chainId} missing result for ${address}`);
      return null;
    }

    // ── Detect response format ────────────────────────────────────────────────
    // GoPlus /address_security/ returns flags FLAT directly in `result`:
    //   result = { blacklist_doubt: 1, stealing_attack: 1, ... }
    //
    // Some older/token APIs nest flags under the address key:
    //   result = { 0xabc...: { blacklist_doubt: 1, ... } }
    //
    // Detect flat format: if the first key is a known flag name, result IS the addrResult.
    const addrKey = address.toLowerCase();
    const resultKeys = Object.keys(data.result);
    const isFlat = resultKeys.length > 0 && KNOWN_FLAG_KEYS.has(resultKeys[0]!);

    const addrResult: GoPlusAddressResult = isFlat
      ? (data.result as unknown as GoPlusAddressResult)    // flat format ✓
      : ((data.result[addrKey] ??
          (resultKeys.length > 0 ? data.result[resultKeys[0]!]! : {})) as GoPlusAddressResult);

    return { flags: extractRiskFlags(addrResult), raw: addrResult };
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const isTimeout = typeof err === "string" && err.includes("timeout");
    if (isAbort || isTimeout) {
      console.warn(
        `[GoPlus] chain=${chainId} timeout after ${config.GOPLUS_TIMEOUT_MS}ms for ${address}`
      );
    } else {
      console.warn(`[GoPlus] chain=${chainId} network error for ${address}:`, err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Main function ─────────────────────────────────────────────────────────────
/**
 * Query GoPlus security intelligence for a given EVM address.
 *
 * Every chain in GOPLUS_CHAIN_IDS is queried in parallel and the verdicts are
 * MERGED: the address is malicious when at least one chain reports a flag.
 *
 * Coverage semantics — the crucial distinction:
 *   - every chain answered CLEAN  → "clean"        (GoPlus knows this address, no flags)
 *   - some chain failed           → "clean" + failedChains (PARTIAL coverage; the
 *     pipeline and the LLM are told which chains are missing, so a partial answer
 *     is never presented as a full clean bill of health)
 *   - every chain failed          → "unavailable"  (NOT clean)
 *
 * The verdict itself is HARD-flag based: `status === "malicious"` requires at
 * least one HARD_FLAGS entry. Soft-only results stay "clean" with `softFlags`
 * populated, so they reach rule 17 (LLM context) instead of a hard REJECT.
 *
 * @param address  EVM address (0x...)
 */
export async function checkAddressSecurity(
  address: string
): Promise<SecurityCheckResult> {
  // ── Check demo simulation first (see note above) ──────────────────────────
  const simulated = checkSimulatedMalicious(address);
  if (simulated) {
    return simulated;
  }

  const chains = GOPLUS_CHAIN_IDS.length > 0 ? GOPLUS_CHAIN_IDS : ["56"];

  const perChain = await Promise.all(
    chains.map(async (chainId) => ({
      chainId,
      res: await queryChain(address, chainId),
    }))
  );

  const queriedChains: string[] = [];
  const failedChains: string[] = [];
  const flaggedChains: string[] = [];
  const merged = new Set<string>();
  /**
   * Flat merge of every flag field seen on any chain, so downstream rawData
   * inspection (rule engine Rule 8) keeps working across a multi-chain lookup.
   * `_byChain` keeps the per-chain breakdown for auditing.
   */
  const mergedRaw: Record<string, unknown> = {};
  const rawByChain: Record<string, Record<string, unknown>> = {};

  for (const { chainId, res } of perChain) {
    if (res === null) {
      failedChains.push(chainId);
      continue;
    }
    queriedChains.push(chainId);
    rawByChain[chainId] = res.raw as Record<string, unknown>;
    for (const [k, v] of Object.entries(res.raw)) {
      if (isFlagSet(v)) mergedRaw[k] = v;
    }
    if (res.flags.length > 0) {
      flaggedChains.push(chainId);
      res.flags.forEach((f) => merged.add(f));
    }
  }

  if (queriedChains.length === 0) {
    console.warn(
      `[GoPlus] All chains failed (${failedChains.join(", ")}) for ${address} — unavailable.`
    );
    return { ...unavailable(), failedChains };
  }

  const riskFlags = Array.from(merged);
  const { hardFlags, softFlags } = classifyFlags(riskFlags);
  mergedRaw._byChain = rawByChain;

  if (failedChains.length > 0) {
    console.warn(
      `[GoPlus] PARTIAL coverage for ${address}: chain(s) ${failedChains.join(", ")} unreachable, ` +
        `${queriedChains.join(", ")} answered. Treating as ${hardFlags.length > 0 ? "malicious" : "clean (partial)"}.`
    );
  }

  return {
    // Hard flags only. A soft-only result is NOT malicious — see SOFT_FLAGS.
    status: hardFlags.length > 0 ? "malicious" : "clean",
    riskFlags,
    hardFlags,
    softFlags,
    source: "goplus",
    rawData: mergedRaw,
    flaggedChains: flaggedChains.length > 0 ? flaggedChains : undefined,
    queriedChains,
    failedChains: failedChains.length > 0 ? failedChains : undefined,
  };
}

function unavailable(): SecurityCheckResult {
  return {
    status: "unavailable",
    riskFlags: [],
    hardFlags: [],
    softFlags: [],
    source: "unavailable",
  };
}

/**
 * The canonical "GoPlus did not answer" result, for callers that have to synthesise one.
 *
 * Exported so the pipeline's error path cannot drift from the one inside this module: a
 * hand-written literal that forgot `hardFlags` would be a `SecurityCheckResult` with
 * `status: "unavailable"` and no hard flags — which is what the rules require, but only
 * by accident, and only until the next field is added.
 */
export function unavailableSecurity(): SecurityCheckResult {
  return unavailable();
}
